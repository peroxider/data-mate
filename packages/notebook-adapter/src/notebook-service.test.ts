import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalystError } from '@data-analyst/contracts';
import type { CellExecution, ExecutionEvent, ProductConfig, Workspace } from '@data-analyst/contracts';
import { InMemoryRepository, resolvePaths } from '@data-analyst/core';
import { NotebookService } from './index.js';

function testConfig(root: string): ProductConfig {
  return {
    schema_version: 1,
    server: { host: '127.0.0.1', port: 3080 },
    auth: { mode: 'local-token' },
    paths: {
      data_dir: join(root, 'data'),
      state_dir: join(root, 'state'),
      cache_dir: join(root, 'cache'),
    },
    runtime: {
      profile: 'data-analysis',
      python: 'python3',
      compute_device: 'cpu',
      max_active_kernels: 2,
      idle_kernel_timeout_seconds: 1800,
      cell_timeout_seconds: 30,
      interrupt_grace_seconds: 10,
      max_cell_output_mib: 8,
    },
    data: {
      max_upload_mib: 16,
      preview_rows: 100,
      model_sample_rows: 20,
      model_sample_cell_chars: 200,
      quality_ts_max_mib: 8,
      quality_ts_max_rows: 100_000,
    },
    database: {
      readonly: true,
      statement_timeout_seconds: 60,
      max_result_rows: 1000,
      max_result_mib: 64,
    },
    network: {
      mode: 'intranet',
      allowed_model_endpoints: [],
      internet_runtime_downloads: false,
    },
    logging: { level: 'info', structured: true, store_data_samples: false },
  };
}

const ROOT = join(tmpdir(), 'data-mate-nb-test-');
let root = '';
let repository: InMemoryRepository;
let service: NotebookService;

beforeAll(async () => {
  root = await mkdtemp(ROOT);
  const config = testConfig(root);
  const paths = resolvePaths(config, root);
  repository = new InMemoryRepository();
  service = new NotebookService({
    repository,
    paths,
    pythonBin: 'python3',
    runtimeDir: join(root, 'runtime'),
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Workspace fixture:repository 直接注入 active workspace,仅测 Notebook 逻辑。
async function seedWorkspace(workspaceId: string): Promise<void> {
  const workspace: Workspace = {
    id: workspaceId,
    name: 'fixture-workspace',
    root: workspaceId,
    created_at: '2026-01-01T00:00:00.000Z',
    state: 'active',
  };
  await repository.workspaces.put(workspace);
}

const cellRun = (notebookId: string, cellId: string, timeoutSeconds: number): CellExecution => ({
  notebook_id: notebookId,
  cell_id: cellId,
  expected_revision: null,
  timeout_seconds: timeoutSeconds,
  allow_stdin: false,
  idempotency_key: null,
});

describe('NotebookService(§12 本地最小适配)', () => {
  it('Session 绑定 Notebook 文件并持久化映射', async () => {
    const workspaceId = '00000000-0000-4000-8000-00000000cafe';
    await seedWorkspace(workspaceId);

    const binding = await service.createSession(workspaceId);
    expect(binding.workspace_id).toBe(workspaceId);
    expect(binding.notebook_id).toBeNull();

    const first = await service.ensureNotebook(binding.id);
    const second = await service.ensureNotebook(binding.id);
    expect(second.id).toBe(first.id); // 幂等

    const raw = await readFile(
      join(root, 'data', 'workspaces', workspaceId, first.relative_path),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { nbformat: number; nbformat_minor: number };
    expect(parsed.nbformat).toBe(4);
    expect(parsed.nbformat_minor).toBeGreaterThanOrEqual(5);

    const fetched = await service.getSession(binding.id);
    expect(fetched.notebook_id).toBe(first.id);
  });

  it('Cell 更新经 expected_revision 控制并发并触发 CELL_REVISION_CONFLICT', async () => {
    const workspaceId = '00000000-0000-4000-8000-00000000cafb';
    await seedWorkspace(workspaceId);
    const binding = await service.createSession(workspaceId);
    const notebook = await service.ensureNotebook(binding.id);

    const created = await service.updateCell({
      notebook_id: notebook.id,
      cell_id: 'cell-a',
      source: 'x = 1',
      expected_revision: 0,
    });
    expect(created.revision).toBe(1);

    const updated = await service.updateCell({
      notebook_id: notebook.id,
      cell_id: 'cell-a',
      source: 'x = 2',
      expected_revision: 1,
    });
    expect(updated.revision).toBe(2);

    // 版本不匹配 → CELL_REVISION_CONFLICT
    let conflict: unknown;
    try {
      await service.updateCell({
        notebook_id: notebook.id,
        cell_id: 'cell-a',
        source: 'x = 3',
        expected_revision: 0,
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(AnalystError);
    expect((conflict as AnalystError).payload.code).toBe('CELL_REVISION_CONFLICT');

    const cells = await service.getCells(notebook.id);
    expect(cells).toHaveLength(1);
    expect(cells[0]?.source).toBe('x = 2');

    // save:重存 Notebook 并递增 NotebookRef.revision(两次 updateCell 已推到 2)
    const saved = await service.save(notebook.id);
    expect(saved.revision).toBe(3);
  });

  it('内核栈缺失时执行如实返回 ENVIRONMENT_INCOMPLETE', async () => {
    const workspaceId = '00000000-0000-4000-8000-00000000cafc';
    await seedWorkspace(workspaceId);
    const config = testConfig(root);
    const broken = new NotebookService({
      repository,
      paths: resolvePaths(config, root),
      pythonBin: 'definitely-not-a-python-bin-xyz',
      runtimeDir: null,
    });
    const binding = await broken.createSession(workspaceId);
    const notebook = await broken.ensureNotebook(binding.id);
    await broken.updateCell({
      notebook_id: notebook.id,
      cell_id: 'cell-run',
      source: 'print("hi")',
      expected_revision: 0,
    });

    const collected: ExecutionEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of broken.execute(cellRun(notebook.id, 'cell-run', 10))) {
        collected.push(event);
      }
    } catch (error) {
      thrown = error;
    }
    expect(collected).toHaveLength(0);
    expect(thrown).toBeInstanceOf(AnalystError);
    expect((thrown as AnalystError).payload.code).toBe('ENVIRONMENT_INCOMPLETE');
  });

  it('真实内核栈可用时执行并回写输出(环境具备时)', async () => {
    const workspaceId = '00000000-0000-4000-8000-00000000cafd';
    await seedWorkspace(workspaceId);
    const runtimeDir = join(root, 'runtime-src');
    const binding = await service.createSession(workspaceId);
    const notebook = await service.ensureNotebook(binding.id);
    await service.updateCell({
      notebook_id: notebook.id,
      cell_id: 'cell-live',
      source: 'print("hello-m1")',
      expected_revision: 0,
    });

    const live = new NotebookService({
      repository,
      paths: resolvePaths(testConfig(root), root),
      pythonBin: 'python3',
      runtimeDir,
    });

    const events: ExecutionEvent[] = [];
    let envIncomplete = false;
    try {
      for await (const event of live.execute(cellRun(notebook.id, 'cell-live', 60))) {
        events.push(event);
      }
    } catch (error) {
      if (error instanceof AnalystError && error.payload.code === 'ENVIRONMENT_INCOMPLETE') {
        envIncomplete = true; // 环境缺 ipykernel:如实降级,不视为失败
      } else {
        throw error;
      }
    }

    if (!envIncomplete) {
      const types = events.map((event) => event.type);
      expect(types[0]).toBe('status');
      expect(types).toContain('stdout');
      expect(events.at(-1)?.type).toBe('done');
      const stdoutEvent = events.find((event) => event.type === 'stdout');
      expect((stdoutEvent?.payload as { text?: string }).text).toContain('hello-m1');
    }
  });
});
