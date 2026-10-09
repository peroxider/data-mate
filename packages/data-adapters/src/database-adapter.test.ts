import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataSourceBinding, ProductConfig, QueryRequest } from '@data-analyst/contracts';
import { DataSourceBindingSchema, QueryRequestSchema } from '@data-analyst/contracts';
import { InMemoryRepository, resolvePaths, WorkspaceService } from '@data-analyst/core';
import { DatabaseAdapter } from './database-adapter.js';

const dirs: string[] = [];

async function makeAdapter(): Promise<{
  adapter: DatabaseAdapter;
  repository: InMemoryRepository;
  workspaceId: string;
  binding: DataSourceBinding;
  dbPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'db-adapter-'));
  dirs.push(root);
  const dbPath = join(root, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, amount REAL)');
  const insert = db.prepare('INSERT INTO sales (region, amount) VALUES (?, ?)');
  for (let i = 0; i < 12; i += 1) {
    insert.run(i < 6 ? 'east' : 'west', i * 10);
  }
  db.close();

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

  const repository = new InMemoryRepository();
  const workspaces = new WorkspaceService({
    repository,
    paths: resolvePaths(config, root),
    pythonBin: 'python3',
    runtimeDir: null,
    limits: { maxUploadBytes: 16 * 1024 * 1024, maxRows: 100_000 },
  });
  const workspace = await workspaces.createWorkspace('SQL 演示');

  const binding = DataSourceBindingSchema.parse({
    id: 'd1000000-0000-4000-8000-000000000001',
    workspace_id: workspace.id,
    driver: 'sqlite',
    endpoint: dbPath,
    credential_ref: 'none:sqlite-local',
    readonly: true,
    created_at: new Date().toISOString(),
  });
  await repository.dataSources.put(binding);

  const adapter = new DatabaseAdapter({
    repository,
    workspaces,
    config: {
      statement_timeout_seconds: config.database.statement_timeout_seconds,
      max_result_rows: config.database.max_result_rows,
      max_result_bytes: config.database.max_result_mib * 1024 * 1024,
    },
  });
  return { adapter, repository, workspaceId: workspace.id, binding, dbPath };
}

function makeQuery(sourceId: string, overrides: Partial<QueryRequest> = {}): QueryRequest {
  return QueryRequestSchema.parse({
    source_id: sourceId,
    sql: 'SELECT region, COUNT(*) AS n, SUM(amount) AS total FROM sales GROUP BY region',
    params: [],
    max_rows: 100,
    max_bytes: 1_048_576,
    timeout_seconds: 30,
    idempotency_key: null,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DatabaseAdapter.query', () => {
  it('查询结果物化为可追溯数据版本(SQL→DataRef)', async () => {
    const { adapter, repository, binding } = await makeAdapter();
    const result = await adapter.query(makeQuery(binding.id));

    expect(result.statement).toContain('GROUP BY');
    expect(result.truncated).toBe(false);
    expect(result.rows_fetched).toBe(2);
    expect(result.version_id).not.toBeNull();
    expect(result.data_ref.completeness).toBe('complete');
    expect(result.data_ref.scope.filter_description).toBe(result.statement);
    expect(result.data_ref.scope.query_result_complete).toBe(true);

    const version = await repository.datasetVersions.get(result.version_id!);
    expect(version?.operation).toBe('sql_extract');
    expect(version?.dataset_id).toBe(result.dataset_id);
    expect((version?.manifest['source'] as Record<string, unknown>)['kind']).toBe('sql_query');
    const dataset = await repository.datasets.get(result.dataset_id!);
    expect(dataset?.source_kind).toBe('sql_query');
  });

  it('max_rows 服务端收敛并标记 truncated(T09)', async () => {
    const { adapter, binding } = await makeAdapter();
    const result = await adapter.query(
      makeQuery(binding.id, { sql: 'SELECT id FROM sales', max_rows: 5 }),
    );
    expect(result.rows_fetched).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.data_ref.completeness).toBe('truncated');
    expect(result.data_ref.scope.query_result_complete).toBe(false);
  });

  it('写语句被守卫拒绝(T10)', async () => {
    const { adapter, binding } = await makeAdapter();
    await expect(
      adapter.query(makeQuery(binding.id, { sql: 'DROP TABLE sales' })),
    ).rejects.toMatchObject({ payload: { code: 'FORBIDDEN' } });
  });

  it('多语句被拒绝并给出 statement_count(T10)', async () => {
    const { adapter, binding } = await makeAdapter();
    await expect(
      adapter.query(makeQuery(binding.id, { sql: 'SELECT 1; SELECT 2' })),
    ).rejects.toMatchObject({
      payload: { code: 'UNPROCESSABLE', details: { statement_count: 2 } },
    });
  });

  it('幂等键命中时返回既有 DataRef,不重复执行', async () => {
    const { adapter, repository, binding } = await makeAdapter();
    const first = await adapter.query(makeQuery(binding.id, { idempotency_key: 'demo-key' }));
    const before = (await repository.datasetVersions.list()).length;
    const second = await adapter.query(makeQuery(binding.id, { idempotency_key: 'demo-key' }));
    expect(second.data_ref.ref_id).toBe(first.data_ref.ref_id);
    expect(second.version_id).toBe(first.version_id);
    expect((await repository.datasetVersions.list()).length).toBe(before);
  });

  it('未知数据源 → NOT_FOUND;未绑定 Workspace → UNPROCESSABLE', async () => {
    const { adapter, repository, dbPath } = await makeAdapter();
    await expect(
      adapter.query(makeQuery('e1000000-0000-4000-8000-000000000001')),
    ).rejects.toMatchObject({ payload: { code: 'NOT_FOUND' } });

    const unbound = DataSourceBindingSchema.parse({
      id: 'e2000000-0000-4000-8000-000000000002',
      workspace_id: null,
      driver: 'sqlite',
      endpoint: dbPath,
      credential_ref: 'none:sqlite-local',
      readonly: true,
      created_at: new Date().toISOString(),
    });
    await repository.dataSources.put(unbound);
    await expect(adapter.query(makeQuery(unbound.id))).rejects.toMatchObject({
      payload: { code: 'UNPROCESSABLE' },
    });
  });

  it('testConnection 对 sqlite fixture 返回 ok', async () => {
    const { adapter, binding } = await makeAdapter();
    const result = await adapter.testConnection(binding.id);
    expect(result.ok).toBe(true);
    expect(result.driver).toBe('sqlite');
  });

  it('describe 返回带 source_id 的目录快照', async () => {
    const { adapter, binding } = await makeAdapter();
    const catalog = await adapter.describe(binding.id);
    expect(catalog.source_id).toBe(binding.id);
    expect(catalog.truncated).toBe(false);
    expect(catalog.schemas[0]!.tables.map((table) => table.name)).toContain('sales');
  });
});
