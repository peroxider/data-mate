import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// M6 验收测试(§13/§17):Agent 工具接入全链路经真实 CLI serve 进程执行。
// 覆盖:mock openai-chat 模型驱动的三轮工具调用(inspect_data 分片参数 →
// commit_results 登记 → verify_metrics 摘要)、SSE 六类事件顺序、
// GET /api/v1/artifacts/:id、serve 优雅关闭后快照中的 ExecutionRecord 与
// MetricEvidence 集合。commit_results 只能登记预先存在的文件。
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '..', '..');
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'index.js');

const PROFILE_ID = '00000000-0000-4000-8000-000000006101';
const dirs: string[] = [];
let configDir: string;
let configYaml: string;
let mockServer: Server;

let serveProc: ChildProcess | null = null;
let serveStderr = '';
let apiBase = '';
let token = '';

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
  return port;
}

/**
 * 模拟 openai-chat SSE 端点,按请求序号脚本化四轮:
 * 1. inspect_data 工具调用(参数分两段 SSE 到达,验证按 index 聚合)
 * 2. commit_results 工具调用(登记预先存在的产物文件)
 * 3. verify_metrics 工具调用(无聚合证据 → 可读摘要)
 * 4. 纯文本回答 → 正常完成
 */
function startMockModel(): Promise<number> {
  let modelRequests = 0;
  mockServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      modelRequests += 1;
      const turn = modelRequests;
      res.setHeader('content-type', 'text/event-stream');
      const write = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const toolCallTurn = (id: string, name: string, fragments: string[]): void => {
        fragments.forEach((fragment, index) => {
          const delta: Record<string, unknown> =
            index === 0
              ? { index: 0, id, function: { name, arguments: fragment } }
              : { index: 0, function: { arguments: fragment } };
          write({ choices: [{ delta: { tool_calls: [delta] } }] });
        });
        write({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        res.end('data: [DONE]\n\n');
      };
      if (turn === 1) {
        toolCallTurn('call_inspect', 'analyst.inspect_data', ['{"dataset":', '"m6渠道销售"}']);
        return;
      }
      if (turn === 2) {
        toolCallTurn('call_commit', 'analyst.commit_results', [
          '{"path":"artifacts/m6/out.csv","kind":"table"}',
        ]);
        return;
      }
      if (turn === 3) {
        toolCallTurn('call_verify', 'analyst.verify_metrics', ['{}']);
        return;
      }
      write({ choices: [{ delta: { content: 'M6 工具链 完成' } }] });
      write({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolveListen) => {
    mockServer.listen(0, '127.0.0.1', () => {
      resolveListen((mockServer.address() as { port: number }).port);
    });
  });
}

async function runCli(args: string[], timeoutMs = 60_000): Promise<string> {
  const child = spawn(process.execPath, [cliEntry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const code = await new Promise<number | null>((resolveExit) => {
    child.once('exit', (exitCode) => resolveExit(exitCode));
  });
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`CLI 退出码 ${code}: ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  return stdout;
}

function parseJson(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  return JSON.parse(stdout.slice(start));
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra };
}

async function startServe(): Promise<void> {
  serveStderr = '';
  serveProc = spawn(process.execPath, [cliEntry, 'serve', '--config', configYaml], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  serveProc.stderr?.on('data', (chunk: Buffer) => {
    serveStderr += chunk.toString('utf8');
  });
  const port = Number(readFileSync(join(configDir, 'server.port'), 'utf8').trim());
  apiBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${apiBase}/healthz`);
      if (res.ok) break;
    } catch {
      // 尚未监听
    }
    if (Date.now() > deadline) {
      throw new Error(`serve 未在 20s 内就绪;stderr: ${serveStderr}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  token = readFileSync(join(configDir, '.m0', 'state', 'credentials', 'local-token'), 'utf8').trim();
}

async function stopServe(): Promise<void> {
  const proc = serveProc;
  serveProc = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    proc.once('exit', () => resolveExit());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 10_000).unref();
  });
}

async function waitForTerminal(runId: string, maxMs = 40_000): Promise<string> {
  for (let i = 0; i < Math.ceil(maxMs / 100); i += 1) {
    const res = await fetch(`${apiBase}/api/v1/runs/${runId}`, { headers: headers() });
    const body = (await res.json()) as { status: string };
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(body.status)) return body.status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Run 未在期限内到达终态');
}

async function readSseUntil(runId: string, marker: string): Promise<string> {
  const res = await fetch(`${apiBase}/api/v1/runs/${runId}/events`, {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes(marker)) {
      void reader.cancel();
      break;
    }
  }
  return text;
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'm6-e2e-'));
  dirs.push(configDir);
  configYaml = join(configDir, 'config.yaml');
  const serverPort = await freePort();
  await writeFile(join(configDir, 'server.port'), `${serverPort}\n`, 'utf8');
  const mockUrl = `http://127.0.0.1:${await startMockModel()}/v1`;
  await writeFile(
    configYaml,
    [
      'schema_version: 1',
      `server: { host: 127.0.0.1, port: ${serverPort} }`,
      'auth: { mode: local-token }',
      'paths:',
      '  data_dir: ./.m0/data',
      '  state_dir: ./.m0/state',
      '  cache_dir: ./.m0/cache',
      'runtime:',
      '  profile: data-analysis',
      '  python: auto',
      '  compute_device: cpu',
      '  max_active_kernels: 2',
      '  idle_kernel_timeout_seconds: 1800',
      '  cell_timeout_seconds: 120',
      '  interrupt_grace_seconds: 10',
      '  max_cell_output_mib: 8',
      '  agent_max_turns: 12',
      'data:',
      '  max_upload_mib: 16',
      '  preview_rows: 100',
      '  model_sample_rows: 20',
      '  model_sample_cell_chars: 200',
      '  quality_ts_max_mib: 8',
      '  quality_ts_max_rows: 100000',
      'database:',
      '  readonly: true',
      '  statement_timeout_seconds: 60',
      '  max_result_rows: 1000',
      '  max_result_mib: 64',
      'model:',
      `  profile_id: ${PROFILE_ID}`,
      '  protocol: openai-chat',
      `  base_url: ${mockUrl}`,
      '  model: m6-e2e-mock-model',
      '  credential_ref: none:e2e',
      '  connect_timeout_ms: 5000',
      '  response_timeout_ms: 30000',
      '  stream_idle_timeout_ms: 10000',
      '  temperature: 0.2',
      '  max_output_tokens: 256',
      '  context_window_tokens: 65536',
      '  capabilities: { streaming: optional, tool_calling: optional, vision: disabled }',
      '  extra_body: {}',
      'network:',
      '  mode: intranet',
      `  allowed_model_endpoints: [${mockUrl}]`,
      '  internet_runtime_downloads: false',
      'logging: { level: info, structured: true, store_data_samples: false }',
      '',
    ].join('\n'),
    'utf8',
  );
  // fixture 数据文件
  await writeFile(
    join(configDir, 'fixture_sales.csv'),
    ['channel,visitors,conversions', 'A,100,10', 'A,300,60', 'B,200,20', ''].join('\r\n'),
    'utf8',
  );
});

afterAll(async () => {
  await stopServe();
  await new Promise<void>((resolveClose) => mockServer.close(() => resolveClose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!existsSync(cliEntry))('M6 全链路(Agent 工具 + serve)', () => {
  let workspaceId = '';
  let sessionId = '';
  let dataRefId = '';

  it('CLI 准备:workspace/导入 CSV/预置产物文件/session;serve 启动并导入 profile', { timeout: 60_000 }, async () => {
    const ws = parseJson(await runCli(['workspace', 'create', '--config', configYaml, '--name', 'M6 工具链'])) as {
      id: string;
    };
    workspaceId = ws.id;
    const imported = parseJson(
      await runCli([
        'import',
        '--config', configYaml,
        '--workspace', workspaceId,
        '--file', join(configDir, 'fixture_sales.csv'),
        '--name', 'm6渠道销售',
        '--format', 'csv',
      ]),
    ) as { data_ref_id: string; dataset_name: string; row_count: number };
    dataRefId = imported.data_ref_id;
    expect(imported.dataset_name).toBe('m6渠道销售');
    expect(imported.row_count).toBe(3);

    // 预置 commit_results 待登记的产物文件(工具只能登记已存在文件)
    const artifactDir = join(configDir, '.m0', 'data', 'workspaces', workspaceId, 'artifacts', 'm6');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, 'out.csv'), '指标,值\r\n转化率,0.175\r\n', 'utf8');

    const session = parseJson(
      await runCli(['session', 'create', '--config', configYaml, '--workspace', workspaceId]),
    ) as { id: string };
    sessionId = session.id;

    await startServe();
    const unauth = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`, { headers: headers() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revision: number }).revision).toBe(1);
  });

  it('提交 Run:三轮工具调用全链 → SSE 事件 → GET artifact → 快照含 ExecutionRecord', { timeout: 90_000 }, async () => {
    const submit = await fetch(`${apiBase}/api/v1/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        message: '分析这份数据并登记产物',
        data_refs: [dataRefId],
        model_profile_id: PROFILE_ID,
        expected_model_revision: 1,
        options: {},
      }),
    });
    expect(submit.status).toBe(202);
    const { run_id: runId } = (await submit.json()) as { run_id: string };
    expect(await waitForTerminal(runId)).toBe('completed');

    const text = await readSseUntil(runId, 'run.completed');

    // SSE 六类事件顺序:run.status → tool.started → tool.completed → artifact.ready → run.completed
    const status = text.indexOf('event: run.status');
    const started = text.indexOf('event: tool.started');
    const completed = text.indexOf('event: tool.completed');
    const ready = text.indexOf('event: artifact.ready');
    const finished = text.indexOf('event: run.completed');
    expect(status).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(status);
    expect(completed).toBeGreaterThan(started);
    expect(ready).toBeGreaterThan(completed);
    expect(finished).toBeGreaterThan(ready);
    expect([...text.matchAll(/event: tool\.started/g)]).toHaveLength(3);
    expect([...text.matchAll(/event: tool\.completed/g)]).toHaveLength(3);
    expect([...text.matchAll(/"status":"completed"/g)].length).toBeGreaterThanOrEqual(3);
    expect(text).toContain('"tool":"analyst.inspect_data"');
    expect(text).toContain('"tool":"analyst.commit_results"');
    expect(text).toContain('"tool":"analyst.verify_metrics"');
    expect(text).toContain('event: cell.output');
    expect(text).toContain('M6 工具链 完成');

    // GET artifact:commit_results 登记的产物为 ready 且可查询
    const artifactMatch = /"artifact_id":"([0-9a-f-]{36})"/.exec(text);
    expect(artifactMatch).not.toBeNull();
    const artifactRes = await fetch(`${apiBase}/api/v1/artifacts/${artifactMatch![1]}`, {
      headers: headers(),
    });
    expect(artifactRes.status).toBe(200);
    const artifact = (await artifactRes.json()) as { state: string; kind: string; relative_path: string };
    expect(artifact.state).toBe('ready');
    expect(artifact.kind).toBe('table');
    expect(artifact.relative_path).toContain('artifacts/m6/out.csv');

    // serve 优雅关闭落盘后:快照含三条已完成工具 ExecutionRecord 与 MetricEvidence 集合
    await stopServe();
    const snapshot = JSON.parse(
      await readFile(join(configDir, '.m0', 'state', 'product.sqlite'), 'utf8'),
    ) as {
      collections: {
        executions: Array<{ cell_id: string; status: string }>;
        metricEvidence: unknown[];
        artifacts: Array<{ artifact_id: string; state: string; relative_path: string }>;
      };
    };
    const toolExecutions = snapshot.collections.executions.filter((entry) =>
      entry.cell_id.startsWith('tool:'),
    );
    expect(toolExecutions.map((entry) => entry.cell_id).sort()).toEqual([
      'tool:analyst.commit_results',
      'tool:analyst.inspect_data',
      'tool:analyst.verify_metrics',
    ]);
    expect(toolExecutions.every((entry) => entry.status === 'completed')).toBe(true);
    expect(
      snapshot.collections.artifacts.some(
        (entry) => entry.state === 'ready' && entry.relative_path.includes('artifacts/m6/out.csv'),
      ),
    ).toBe(true);
    // 本链路未做聚合,MetricEvidence 为空集合(verify_metrics 走"没有已登记证据"摘要)
    expect(Array.isArray(snapshot.collections.metricEvidence)).toBe(true);
  });
});
