import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalystError, AnalysisRunSchema, SessionBindingSchema, newId, nowIso } from '@data-analyst/contracts';
import type { AnalysisRun, ProductConfig, RunStreamEventType } from '@data-analyst/contracts';
import {
  AggregationService,
  InMemoryRepository,
  RunGovernor,
  WorkspaceService,
  createDefaultToolRegistry,
  createToolContext,
  resolvePaths,
} from './index.js';
import type { AgentToolLimits, ToolContext } from './agent-tools.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SALES_CSV = [
  'channel,visitors,conversions',
  'A,100,10',
  'A,300,60',
  'B,200,20',
  'B,100,5',
  '',
].join('\r\n');

interface TestEnv {
  root: string;
  repository: InMemoryRepository;
  workspace: WorkspaceService;
  aggregation: AggregationService;
  governor: RunGovernor;
  run: AnalysisRun;
  ctx: ToolContext;
  events: Array<{ type: RunStreamEventType; payload: Record<string, unknown> }>;
}

const LIMITS: AgentToolLimits = {
  max_bytes: 16 * 1024 * 1024,
  max_rows: 100_000,
  preview_rows: 100,
  model_sample_rows: 20,
  model_sample_cell_chars: 200,
};

async function makeEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'agent-tools-'));
  dirs.push(root);
  const configFile = join(root, 'config.yaml');
  await writeFile(configFile, '# test config\n', 'utf8');
  const config: ProductConfig = {
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
      cell_timeout_seconds: 600,
      interrupt_grace_seconds: 10,
      max_cell_output_mib: 8,
      agent_max_turns: 12,
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
  const paths = resolvePaths(config, root);
  const repository = new InMemoryRepository();
  const workspace = new WorkspaceService({
    repository,
    paths,
    pythonBin: 'python3',
    runtimeDir: null,
    limits: { maxUploadBytes: 16 * 1024 * 1024, maxRows: 100_000 },
  });
  const aggregation = new AggregationService({
    repository,
    paths,
    maxBytes: 16 * 1024 * 1024,
    maxRows: 100_000,
  });
  const governor = new RunGovernor({ repository, maxActiveKernels: 2 });

  const session = SessionBindingSchema.parse({
    id: newId(),
    dsh_session_id: 'dsh-agent-tools',
    workspace_id: newId(),
    notebook_id: null,
    model_profile_id: null,
    created_at: nowIso(),
  });
  await repository.sessions.put(session);
  const run = AnalysisRunSchema.parse({
    id: newId(),
    session_id: session.id,
    trigger: 'user_message',
    status: 'running',
    phase: null,
    config_revision: 0,
    model_profile_snapshot_id: null,
    idempotency_key: null,
    payload_hash: null,
    started_at: nowIso(),
    ended_at: null,
  });
  await repository.runs.put(run);

  const events: TestEnv['events'] = [];
  const ctx = createToolContext({
    run,
    workspaceId: session.workspace_id,
    repository,
    runGovernor: governor,
    workspace,
    aggregation,
    workspacesDir: paths.workspacesDir,
    limits: LIMITS,
    emit: (type, payload) => events.push({ type, payload }),
    signal: new AbortController().signal,
  });
  return { root, repository, workspace, aggregation, governor, run, ctx, events };
}

async function importSales(env: TestEnv): Promise<{ refId: string; datasetName: string; workspaceId: string }> {
  const ws = await env.workspace.createWorkspace('销售分析');
  const source = join(env.root, 'fixture_sales.csv');
  await writeFile(source, SALES_CSV, 'utf8');
  const staged = await env.workspace.stageUpload(source);
  const imported = await env.workspace.importFile({
    workspace_id: ws.id,
    dataset_name: '渠道销售',
    format: 'csv',
    staged_path: staged,
  });
  return { refId: imported.dataRef.ref_id, datasetName: '渠道销售', workspaceId: ws.id };
}

function envWithWorkspace(env: TestEnv, workspaceId: string): ToolContext {
  return createToolContext({
    run: env.run,
    workspaceId,
    repository: env.repository,
    runGovernor: env.governor,
    workspace: env.workspace,
    aggregation: env.aggregation,
    workspacesDir: join(env.root, 'data', 'workspaces'),
    limits: LIMITS,
    emit: (type, payload) => env.events.push({ type, payload }),
    signal: new AbortController().signal,
  });
}

describe('ToolRegistry', () => {
  it('默认注册表包含四个 analyst.* 工具且描述符完整', () => {
    const registry = createDefaultToolRegistry();
    expect(registry.list().map((tool) => tool.name)).toEqual([
      'analyst.inspect_data',
      'analyst.list_artifacts',
      'analyst.commit_results',
      'analyst.verify_metrics',
    ]);
    const descriptors = registry.descriptors();
    for (const descriptor of descriptors) {
      expect(descriptor.parameters).toHaveProperty('type', 'object');
      expect(descriptor.description.length).toBeGreaterThan(0);
    }
  });

  it('同名工具重复注册被拒绝', () => {
    const registry = createDefaultToolRegistry();
    const tool = registry.list()[0]!;
    expect(() => registry.register(tool)).toThrowError(AnalystError);
  });
});

describe('analyst.inspect_data', () => {
  it('按 dataset 名称预览:行列规模、列名与引用', async () => {
    const env = await makeEnv();
    const { workspaceId } = await importSales(env);
    const ctx = envWithWorkspace(env, workspaceId);
    await ctx.setPhase('inspect');
    const result = await createDefaultToolRegistry()
      .get('analyst.inspect_data')!
      .execute({ dataset: '渠道销售' }, ctx);
    expect(result.summary).toContain('4 行');
    expect(result.summary).toContain('channel');
    expect(result.references[0]).toMatchObject({ sha256: expect.any(String) });
    expect(result.next_capabilities).toContain('analyst.commit_results');
  });

  it('未知 DataRef → NOT_FOUND;入参缺失 → UNPROCESSABLE', async () => {
    const env = await makeEnv();
    const { workspaceId } = await importSales(env);
    const ctx = envWithWorkspace(env, workspaceId);
    const tool = createDefaultToolRegistry().get('analyst.inspect_data')!;
    await expect(tool.execute({ data_ref_id: newId() }, ctx)).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND' },
    });
    await expect(tool.execute({}, ctx)).rejects.toMatchObject({
      payload: { code: 'UNPROCESSABLE' },
    });
  });
});

describe('ExecutionRecord 生命周期', () => {
  it('begin → registered/running;end → completed 且 run_events 关联', async () => {
    const env = await makeEnv();
    const { executionId } = await env.ctx.beginExecution('analyst.inspect_data', '{}');
    const running = await env.repository.executions.get(executionId);
    expect(running?.status).toBe('running');
    expect(running?.cell_id).toBe('tool:analyst.inspect_data');
    expect(running?.kernel_epoch).toBe(1);
    expect(running?.lease_token).toBe(env.run.id);
    expect(running?.source_hash).toHaveLength(64);

    await env.ctx.endExecution(executionId, 'completed');
    const finished = await env.repository.executions.get(executionId);
    expect(finished?.status).toBe('completed');
    expect(finished?.ended_at).not.toBeNull();

    const events = await env.governor.eventsForRun(env.run.id);
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['execution.registered', 'execution.started', 'execution.finished']),
    );
  });
});

describe('setPhase 单调不回退', () => {
  it('phase 只前进;回退请求被忽略', async () => {
    const env = await makeEnv();
    await env.ctx.setPhase('inspect');
    await env.ctx.setPhase('present');
    expect((await env.governor.getRun(env.run.id)).phase).toBe('present');
    await env.ctx.setPhase('quality');
    expect((await env.governor.getRun(env.run.id)).phase).toBe('present');
    // phase 前进伴随 run.status 事件
    expect(env.events.some((event) => event.type === 'run.status')).toBe(true);
  });
});

describe('analyst.commit_results', () => {
  it('登记已存在文件 → ready 产物 + artifact.ready 事件', async () => {
    const env = await makeEnv();
    const { workspaceId } = await importSales(env);
    const ctx = envWithWorkspace(env, workspaceId);
    await mkdir(join(env.root, 'data', 'workspaces', workspaceId, 'artifacts', 'demo'), {
      recursive: true,
    });
    await writeFile(
      join(env.root, 'data', 'workspaces', workspaceId, 'artifacts', 'demo', 'out.csv'),
      'a,b\n1,2\n',
      'utf8',
    );
    await ctx.setPhase('compute');
    const result = await createDefaultToolRegistry()
      .get('analyst.commit_results')!
      .execute({ path: 'artifacts/demo/out.csv', kind: 'table' }, ctx);
    const reference = result.references[0] as { artifact_id: string; state: string };
    expect(reference.state).toBe('ready');
    expect(env.events.some((event) => event.type === 'artifact.ready')).toBe(true);
  });

  it('哈希不符 → UNPROCESSABLE;穿越路径 → FORBIDDEN;文件缺失 → NOT_FOUND', async () => {
    const env = await makeEnv();
    const { workspaceId } = await importSales(env);
    const ctx = envWithWorkspace(env, workspaceId);
    const tool = createDefaultToolRegistry().get('analyst.commit_results')!;
    await mkdir(join(env.root, 'data', 'workspaces', workspaceId, 'artifacts', 'demo2'), {
      recursive: true,
    });
    await writeFile(
      join(env.root, 'data', 'workspaces', workspaceId, 'artifacts', 'demo2', 'x.csv'),
      'a\n1\n',
      'utf8',
    );
    await expect(
      tool.execute({ path: 'artifacts/demo2/x.csv', kind: 'table', sha256: '0'.repeat(64) }, ctx),
    ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
    await expect(
      tool.execute({ path: '../../outside.csv', kind: 'table' }, ctx),
    ).rejects.toMatchObject({ payload: { code: 'FORBIDDEN' } });
    await expect(
      tool.execute({ path: 'artifacts/missing.csv', kind: 'table' }, ctx),
    ).rejects.toMatchObject({ payload: { code: 'NOT_FOUND' } });
  });
});

describe('analyst.list_artifacts', () => {
  it('列出已登记产物,kind 过滤与 limit 生效', async () => {
    const env = await makeEnv();
    const { workspaceId } = await importSales(env);
    const ctx = envWithWorkspace(env, workspaceId);
    await ctx.setPhase('present');
    const tool = createDefaultToolRegistry().get('analyst.commit_results')!;
    for (const name of ['a.csv', 'b.csv', 'c.json']) {
      await mkdir(join(env.root, 'data', 'workspaces', workspaceId, 'artifacts', 'list'), {
        recursive: true,
      });
      await writeFile(
        join(env.root, 'data', 'workspaces', workspaceId, 'artifacts', 'list', name),
        'x\n',
        'utf8',
      );
      await tool.execute(
        { path: `artifacts/list/${name}`, kind: name.endsWith('.json') ? 'metrics' : 'table' },
        ctx,
      );
    }
    const listTool = createDefaultToolRegistry().get('analyst.list_artifacts')!;
    const all = await listTool.execute({}, ctx);
    expect(all.references).toHaveLength(3);
    const metrics = await listTool.execute({ kind: 'metrics' }, ctx);
    expect(metrics.references).toHaveLength(1);
    const limited = await listTool.execute({ limit: 2 }, ctx);
    expect(limited.references).toHaveLength(2);
  });
});

describe('analyst.verify_metrics', () => {
  it('聚合证据与重算一致 → consistent;篡改产物 → mismatch', async () => {
    const env = await makeEnv();
    const { refId, workspaceId } = await importSales(env);
    const ctx = envWithWorkspace(env, workspaceId);
    await ctx.setPhase('validate');

    const resolved = await env.workspace.resolveData(refId, {
      workspace_id: workspaceId,
      max_bytes: LIMITS.max_bytes,
      max_rows: LIMITS.max_rows,
    });
    const outcome = await env.aggregation.aggregate({
      workspaceId,
      dataRef: (await env.repository.dataRefs.get(refId))!,
      absolutePath: resolved.absolute_path,
      spec: {
        group_by: 'channel',
        metrics: [
          { name: 'visitors', kind: 'sum', column: 'visitors' },
          { name: 'conversions', kind: 'sum', column: 'conversions' },
        ],
        ratios: [{ name: 'conversion_rate', numerator: 'conversions', denominator: 'visitors' }],
      },
      runId: env.run.id,
    });

    const tool = createDefaultToolRegistry().get('analyst.verify_metrics')!;
    const ok = await tool.execute({}, ctx);
    expect(ok.summary).toContain('4 项一致');
    expect(ok.summary).toContain('0 项不一致');

    // 篡改 metrics.json 的 overall 值 → mismatch(重算不受产物影响)
    const metricsPath = join(
      env.root,
      'data',
      'workspaces',
      workspaceId,
      'artifacts',
      outcome.artifact.artifactId,
      'metrics.json',
    );
    const original = JSON.parse(await readFile(metricsPath, 'utf8')) as {
      overall: { values: Record<string, number | null> };
    };
    original.overall.values.visitors = 999999;
    await writeFile(metricsPath, JSON.stringify(original), 'utf8');
    const tampered = await tool.execute({}, ctx);
    expect(tampered.summary).toContain('1 项不一致');
  });

  it('数据文件被改动 → 相关证据标 stale(T14)', async () => {
    const env = await makeEnv();
    const { refId, workspaceId } = await importSales(env);
    const ctx = envWithWorkspace(env, workspaceId);
    await ctx.setPhase('validate');

    const resolved = await env.workspace.resolveData(refId, {
      workspace_id: workspaceId,
      max_bytes: LIMITS.max_bytes,
      max_rows: LIMITS.max_rows,
    });
    await env.aggregation.aggregate({
      workspaceId,
      dataRef: (await env.repository.dataRefs.get(refId))!,
      absolutePath: resolved.absolute_path,
      spec: {
        group_by: 'channel',
        metrics: [{ name: 'visitors', kind: 'sum', column: 'visitors' }],
        ratios: [],
      },
      runId: env.run.id,
    });

    // 直接改数据文件(绕过 resolveData,模拟人为篡改)
    await writeFile(resolved.absolute_path, SALES_CSV.replace('B,100,5', 'B,100,50'), 'utf8');
    const tool = createDefaultToolRegistry().get('analyst.verify_metrics')!;
    const result = await tool.execute({}, ctx);
    expect(result.summary).toContain('stale');
    const evidences = await env.repository.metricEvidence.list();
    expect(evidences.every((item) => item.verification === 'stale')).toBe(true);
  });

  it('没有证据的 Run 返回可读摘要', async () => {
    const env = await makeEnv();
    const tool = createDefaultToolRegistry().get('analyst.verify_metrics')!;
    const result = await tool.execute({}, env.ctx);
    expect(result.summary).toContain('没有已登记的指标证据');
  });
});
