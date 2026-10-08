import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProductConfig } from '@data-analyst/contracts';
import { InMemoryRepository, resolvePaths, WorkspaceService } from './index.js';

const dirs: string[] = [];

async function makeService(): Promise<{
  service: WorkspaceService;
  root: string;
  repository: InMemoryRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ws-service-'));
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
  const service = new WorkspaceService({
    repository,
    paths,
    pythonBin: 'python3',
    runtimeDir: null,
    limits: { maxUploadBytes: 16 * 1024 * 1024, maxRows: 100_000 },
  });
  return { service, root, repository };
}

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

describe('WorkspaceService', () => {
  it('创建 Workspace 并建立根目录', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('演示分析');
    expect(workspace.name).toBe('演示分析');
    expect(workspace.state).toBe('active');
    const listed = await service.listWorkspaces();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(workspace.id);
    const { stat } = await import('node:fs/promises');
    const info = await stat(join(root, 'data', 'workspaces', workspace.id));
    expect(info.isDirectory()).toBe(true);
  });

  it('CSV 导入登记版本与 DataRef,原文件按哈希保留', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('销售分析');
    const source = join(root, 'fixture_sales.csv');
    await writeFile(source, SALES_CSV, 'utf8');
    const staged = await service.stageUpload(source);
    const { dataset, version, dataRef } = await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '渠道销售',
      format: 'csv',
      staged_path: staged,
    });

    expect(dataset.name).toBe('渠道销售');
    expect(version.operation).toBe('import');
    expect(version.parents).toEqual([]);
    expect(version.state).toBe('ready');
    expect(dataRef.row_count).toBe(4);
    expect(dataRef.row_count_status).toBe('exact');
    expect(dataRef.completeness).toBe('complete');
    expect(dataRef.format).toBe('csv');

    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          'data',
          'workspaces',
          workspace.id,
          'datasets',
          dataset.id,
          'versions',
          version.id,
          'manifest.json',
        ),
        'utf8',
      ),
    ) as { row_count: number; delimiter: string; columns: Array<{ name: string; type: string }> };
    expect(manifest.row_count).toBe(4);
    expect(manifest.delimiter).toBe(',');
    expect(manifest.columns.map((c) => c.type)).toEqual(['string', 'integer', 'integer']);

    const { readdir } = await import('node:fs/promises');
    const originals = await readdir(
      join(root, 'data', 'workspaces', workspace.id, 'datasets', dataset.id, 'original'),
    );
    expect(originals).toEqual([`${dataRef.sha256}.csv`]);
  });

  it('内容与声明格式不一致时拒绝导入', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('格式校验');
    const source = join(root, 'fake.parquet');
    await writeFile(source, SALES_CSV, 'utf8'); // CSV 内容伪装成 parquet
    const staged = await service.stageUpload(source);
    await expect(
      service.importFile({
        workspace_id: workspace.id,
        dataset_name: '伪格式',
        format: 'parquet',
        staged_path: staged,
      }),
    ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
  });

  it('staged_path 越出受控暂存目录被拒绝', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('路径校验');
    const source = join(root, 'outside.csv');
    await writeFile(source, SALES_CSV, 'utf8');
    await expect(
      service.importFile({
        workspace_id: workspace.id,
        dataset_name: '越权',
        format: 'csv',
        staged_path: source,
      }),
    ).rejects.toMatchObject({ payload: { code: 'FORBIDDEN' } });
  });

  it('resolveData 复核哈希;文件被篡改时版本标记 corrupted', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('哈希校验');
    const source = join(root, 'data.csv');
    await writeFile(source, SALES_CSV, 'utf8');
    const staged = await service.stageUpload(source);
    const { dataRef } = await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '数据',
      format: 'csv',
      staged_path: staged,
    });

    const scope = { workspace_id: workspace.id, max_bytes: 1 << 20, max_rows: 1000 };
    const resolved = await service.resolveData(dataRef.ref_id, scope);
    expect(resolved.within_limits).toBe(true);
    expect(resolved.bytes_available).toBe(dataRef.size_bytes);

    // 篡改登记后的文件内容(§25 T14)
    await writeFile(resolved.absolute_path, SALES_CSV.replace('100,10', '100,99'), 'utf8');
    await expect(service.resolveData(dataRef.ref_id, scope)).rejects.toMatchObject({
      payload: { code: 'UNPROCESSABLE' },
    });
    const versions = await service.listVersions((await service.listDatasets(workspace.id))[0]!.id);
    expect(versions.at(-1)?.state).toBe('corrupted');
  });

  it('registerArtifact 校验哈希后登记 ready 产物', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('产物登记');
    const relativePath = 'artifacts/metrics.json';
    const absolutePath = join(root, 'data', 'workspaces', workspace.id, relativePath);
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    await mkdir(join(root, 'data', 'workspaces', workspace.id, 'artifacts'), { recursive: true });
    await wf(absolutePath, '{"total":95}', 'utf8');
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update('{"total":95}', 'utf8').digest('hex');

    const bad = await service
      .registerArtifact({
        workspace_id: workspace.id,
        run_id: null,
        kind: 'metrics',
        relative_path: relativePath,
        sha256: '0'.repeat(64),
      })
      .catch((e: unknown) => e);
    expect((bad as { payload: { code: string } }).payload.code).toBe('UNPROCESSABLE');

    const ref = await service.registerArtifact({
      workspace_id: workspace.id,
      run_id: null,
      kind: 'metrics',
      relative_path: relativePath,
      sha256,
    });
    expect(ref.state).toBe('ready');
    expect(ref.artifact_id).toBeTruthy();
  });

  it('快照持久化往返包含 dataRefs 集合', async () => {
    const { service, root, repository } = await makeService();
    const workspace = await service.createWorkspace('快照');
    const source = join(root, 'data.csv');
    await writeFile(source, SALES_CSV, 'utf8');
    const staged = await service.stageUpload(source);
    await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '数据',
      format: 'csv',
      staged_path: staged,
    });
    const snapshotPath = join(root, 'state', 'product.json');
    await repository.snapshotTo(snapshotPath);

    const restored = new InMemoryRepository();
    await restored.restoreFrom(snapshotPath);
    const refs = await restored.dataRefs.list();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.row_count).toBe(4);
  });
});
