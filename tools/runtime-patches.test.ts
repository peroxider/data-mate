import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { patchGenuiBrowser, patchGenuiHost, patchGenuiSource, patchHtmlPreview, patchNotebook, runtimePatches } from './runtime-patches.js';

const profile = resolve('.m0/profile/node_modules');
const installed = runtimePatches.every(patch => existsSync(resolve(profile, patch.packageName, patch.file)));
const read = (pkg: string, file: string) => readFileSync(resolve(profile, pkg, file), 'utf8');
const notebook = installed ? patchNotebook(read('@beihaizb/dsh-notebook', 'lib/index.js')) : '';
const html = installed ? patchHtmlPreview(read('@deepseek-ai/dsh-client-ui-sidebar-documentpreview', 'lib/client.js')) : '';

function declaration(source: string, start: string, end: string) {
  const offset = source.indexOf(start);
  expect(offset).toBeGreaterThanOrEqual(0);
  return source.slice(offset, source.indexOf(end, offset));
}

describe.skipIf(!installed)('pinned runtime compatibility patches', () => {
  for (const patch of runtimePatches) {
    it(`is guarded and idempotent: ${patch.packageName}/${patch.file}`, () => {
      const original = read(patch.packageName, patch.file);
      const fixed = patch.transform(original);
      expect(patch.transform(fixed)).toBe(fixed);
      expect(() => patch.transform('an incompatible future release')).toThrow('anchor changed');
    });
  }

  it('renders HTML through srcDoc while retaining opaque script sandbox and revision identity', () => {
    const data = new Uint8Array([1]);
    const readRelated = () => {};
    const document = '<!doctype html><h1>销售分析</h1><script>window.example = 1</script>';
    const frame = { data, readRelated, url: 'blob:revision-1', html: document };
    const component = runInNewContext(`(${declaration(html, 'function HtmlFrame(', '\n\t\t/**')})`, {
      react: { useState: () => [frame, () => {}], useEffect: () => {} },
      react_jsx_runtime: { jsx: (type: string, props: object, key: string) => ({ type, props, key }) },
      HtmlBody_module_css_default: { frame: 'frame' },
    });
    const rendered = component({ data, readRelated, frameName: 'preview', t: (text: string) => text });
    expect(rendered.type).toBe('iframe');
    expect(rendered.props.srcDoc).toBe(document);
    expect(rendered.props.src).toBeUndefined();
    expect(rendered.props.sandbox).toBe('allow-scripts');
    expect(rendered.key).toBe('blob:revision-1');
  });

  it('excludes a pending execution Promise from public snapshots without changing the queue', () => {
    const job = Promise.resolve();
    const cell = { id: 'one', source: 'print(1)', status: 'queued', outputs: [], _runJob: job };
    const state = { notebook: { path: null, metadata: {}, cells: [cell] }, kernel: { id: 'py', interpreter: 'python', alive: true }, cwd: '/test', workspaceRoot: '/test' };
    const snapshot = runInNewContext(`(${declaration(notebook, 'function snapshotPublic(', '\n    function snapshotFast(')})`, { state, initialWorkspaceRoot: '/test' });
    const value = snapshot({ includeKernels: false });
    expect(value.cells[0]).not.toHaveProperty('_runJob');
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    expect(value.kernel.busy).toBe(true);
    expect(cell._runJob).toBe(job);
  });

  it('makes the Agent restart-and-run-all handler wait for completion', async () => {
    let received: Record<string, unknown> | undefined;
    const handlerText = '(args, sid) => createSessionMethods(sid).kernelRestartAndRunAll(Object.assign({}, args || {}, { wait: true }))';
    expect(notebook).toContain(handlerText);
    const handler = runInNewContext(`(${handlerText})`, {
      createSessionMethods: (sid: string) => ({ kernelRestartAndRunAll: async (args: Record<string, unknown>) => { received = { ...args, sid }; return { results: [] }; } }),
    });
    expect(await handler({ timeout: 90 }, 'session')).toEqual({ results: [] });
    expect(received).toEqual({ timeout: 90, wait: true, sid: 'session' });
  });

  it('returns all cell results only after the jobs finish, skipping Markdown', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const cells = [{ id: 'a', cell_type: 'code' }, { id: 'doc', cell_type: 'markdown' }, { id: 'b', cell_type: 'code' }];
    const runAll = runInNewContext(`(${declaration(notebook, 'async function runAll(', '\n    async function recordSuggestion(')})`, {
      state: { notebook: { cells } },
      enqueueRun: () => new Promise(resolveJob => resolvers.push(resolveJob)),
      snapshotFast: () => ({ kernel: { busy: false } }),
      cancelQueuedCells: () => {}, bumpRunGen: () => {},
    });
    let settled = false;
    const result = runAll({ wait: true }).then((value: unknown) => { settled = true; return value; });
    expect(resolvers).toHaveLength(2);
    resolvers[0]({ cell_id: 'a', status: 'ok' });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolvers[1]({ cell_id: 'b', status: 'ok' });
    expect((await result).results.map((row: { cell_id: string }) => row.cell_id)).toEqual(['a', 'b']);
  });
});

describe.skipIf(!installed)('GenUI compatibility normalization', () => {
  const guardModule = '../.m0/profile/node_modules/@changfenhuang/dsh-genui/src/client/guard.ts';
  const loadGuard = () => import(/* @vite-ignore */ guardModule);

  for (const flag of [true, false]) {
    it(`renders an otherwise valid table with details:${flag} without changing the input`, async () => {
      const { processGenuiSpec } = await loadGuard();
      const table = { type: 'table', columns: ['Model', 'RMSE'], rows: [['Linear', 6.596]], details: flag };
      const result = processGenuiSpec({ items: [{ type: 'card', items: [table] }] });
      expect(result.errors).toEqual([]);
      expect(JSON.stringify(result.repaired)).toContain('Linear');
      expect(JSON.stringify(result.repaired)).not.toContain('details');
      expect(table.details).toBe(flag);
    });
  }

  it('preserves valid row details and rejects malformed non-boolean detail data', async () => {
    const { processGenuiSpec } = await loadGuard();
    const table = { type: 'table', columns: ['Model'], rows: [['Linear']] };
    const valid = processGenuiSpec({ items: [{ ...table, details: [[{ type: 'note', content: 'Audit' }]] }] });
    expect(valid.errors).toEqual([]);
    expect(JSON.stringify(valid.repaired)).toContain('Audit');
    const invalid = processGenuiSpec({ items: [{ ...table, details: { invalid: true } }] });
    expect(invalid.errors.join(' ')).toContain('details must be an array');
  });

  it('patches the normalizer only, leaving strict schema diagnostics intact', () => {
    const host = patchGenuiHost(read('@changfenhuang/dsh-genui', 'lib/index.js'));
    expect(host).toContain('details must be an array aligned with rows');
    const browser = patchGenuiBrowser(read('@changfenhuang/dsh-genui', 'lib/client.js'));
    expect(browser.match(/data-mate:table-details-flag/g)).toHaveLength(1);
    const source = patchGenuiSource(read('@changfenhuang/dsh-genui', 'src/client/genui-runtime/normalize.ts'));
    expect(source).toContain("typeof out.details === 'boolean'");
  });
});
