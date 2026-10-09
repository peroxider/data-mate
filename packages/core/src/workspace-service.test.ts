import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProductConfig } from '@data-analyst/contracts';
import { InMemoryRepository, resolvePaths, WorkspaceService } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
// 仓库内 analyst_runtime 包目录(PYTHONPATH),供 XLSX 检查子命令使用
const repoRuntimeDir = resolve(join(here, '..', '..', '..', 'python', 'analyst_runtime'));
const openpyxlAvailable = spawnSync('python3', ['-c', 'import openpyxl']).status === 0;

const dirs: string[] = [];

async function makeService(runtimeDir: string | null = null): Promise<{
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
  const service = new WorkspaceService({
    repository,
    paths,
    pythonBin: 'python3',
    runtimeDir,
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

  it('同名导入追加为同一 Dataset 的新版本(§24 结果版本化)', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('版本化');
    const source1 = join(root, 'sales-v1.csv');
    await writeFile(source1, SALES_CSV, 'utf8');
    const staged1 = await service.stageUpload(source1);
    const first = await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '渠道销售',
      format: 'csv',
      staged_path: staged1,
    });
    const source2 = join(root, 'sales-v2.csv');
    await writeFile(source2, `${SALES_CSV}线上,10,20\r\n`, 'utf8');
    const staged2 = await service.stageUpload(source2);
    const second = await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '渠道销售',
      format: 'csv',
      staged_path: staged2,
    });
    // 同一 Dataset,新版本,parent 指向 v1
    expect(second.dataset.id).toBe(first.dataset.id);
    expect(second.version.id).not.toBe(first.version.id);
    expect(second.version.parents).toEqual([first.version.id]);
    expect(second.dataRef.ref_id).not.toBe(first.dataRef.ref_id);
    expect(second.dataRef.row_count).toBe(first.dataRef.row_count! + 1);
    // 列表与 latestDataRef 都指向新版本
    const versions = await service.listVersions(first.dataset.id);
    expect(versions).toHaveLength(2);
    const latest = await service.latestDataRef(workspace.id, '渠道销售');
    expect(latest.ref_id).toBe(second.dataRef.ref_id);
    const datasets = await service.listDatasets(workspace.id);
    expect(datasets).toHaveLength(1);
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

  it('JSONL 导入:可表格化约束、点路径扁平化与受控 CSV 快照(§496/§502)', async () => {
    const { service, root } = await makeService();
    const workspace = await service.createWorkspace('事件流');
    const source = join(root, 'events.jsonl');
    await writeFile(
      source,
      ['{"event":"login","user":{"id":1,"region":"east"}}', '{"event":"pay","user":{"id":2,"region":"west"},"amount":9.5}', ''].join(
        '\n',
      ),
      'utf8',
    );
    const staged = await service.stageUpload(source);
    const { dataset, version, dataRef } = await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '事件',
      format: 'jsonl',
      staged_path: staged,
    });
    expect(dataRef.format).toBe('jsonl');
    expect(dataRef.row_count).toBe(2);
    expect(dataRef.completeness).toBe('complete');

    const versionDir = join(
      root,
      'data',
      'workspaces',
      workspace.id,
      'datasets',
      dataset.id,
      'versions',
      version.id,
    );
    const manifest = JSON.parse(await readFile(join(versionDir, 'manifest.json'), 'utf8')) as {
      format: string;
      data_file: string;
      jsonl_expansion: string;
      original_sha256: string;
      sha256: string;
      row_count: number;
    };
    expect(manifest.format).toBe('jsonl');
    expect(manifest.jsonl_expansion).toBe('dotted_path'); // user.id/user.region 扁平化
    expect(manifest.row_count).toBe(2);
    expect(manifest.original_sha256).not.toBe(manifest.sha256); // 原件溯源 vs 快照

    const snapshot = await readFile(join(versionDir, manifest.data_file), 'utf8');
    const lines = snapshot.split('\n');
    expect(lines[0]).toBe('event,user.id,user.region,amount');
    expect(lines[1]).toBe('login,1,east,');
    expect(lines[2]).toBe('pay,2,west,9.5');

    // 原件按哈希保留于 original/,数据文件哈希与 DataRef 一致(resolveData 复核有效)
    const { readdir } = await import('node:fs/promises');
    const originals = await readdir(
      join(root, 'data', 'workspaces', workspace.id, 'datasets', dataset.id, 'original'),
    );
    expect(originals).toEqual([`${manifest.original_sha256}.jsonl`]);
    const resolved = await service.resolveData(dataRef.ref_id, {
      workspace_id: workspace.id,
      max_bytes: 1 << 20,
      max_rows: 1000,
    });
    expect(resolved.within_limits).toBe(true);
  });

  it('JSONL 含非对象行时如实拒绝(可表格化约束)', async () => {
    const { service } = await makeService();
    const workspace = await service.createWorkspace('约束校验');
    const source = join(dirs[0]!, 'bad.jsonl');
    await writeFile(source, '{"a":1}\n42\n', 'utf8');
    const staged = await service.stageUpload(source);
    await expect(
      service.importFile({
        workspace_id: workspace.id,
        dataset_name: '坏行',
        format: 'jsonl',
        staged_path: staged,
      }),
    ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
  });

  it('XLSX 伪装文件被签名校验拒绝', async () => {
    const { service } = await makeService();
    const workspace = await service.createWorkspace('签名校验');
    const source = join(dirs[0]!, 'fake.xlsx');
    await writeFile(source, SALES_CSV, 'utf8'); // CSV 内容伪装成 XLSX
    const staged = await service.stageUpload(source);
    await expect(
      service.importFile({
        workspace_id: workspace.id,
        dataset_name: '伪格式',
        format: 'xlsx',
        staged_path: staged,
      }),
    ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
  });
});

function makeXlsxFixture(path: string): void {
  const script = [
    'import openpyxl',
    'wb = openpyxl.Workbook()',
    'ws = wb.active',
    "ws.title = 'East'",
    "ws.append(['region', 'amount'])",
    "ws.append(['a', 100])",
    "ws.append(['b', 200.5])",
    "ws2 = wb.create_sheet('West')",
    "ws2.append(['region', 'amount', 'note'])",
    "ws2.append(['c', 50, 'cached'])",
    "ws2['D1'] = 'derived'",
    "ws2['D2'] = '=SUM(B2:B2)'", // 无缓存结果:§496 标记 unavailable
    `wb.save(${JSON.stringify(path)})`,
  ].join('\n');
  const result = spawnSync('python3', ['-c', script]);
  if (result.status !== 0) throw new Error(`fixture 生成失败: ${String(result.stderr)}`);
}

describe.skipIf(!openpyxlAvailable)('WorkspaceService XLSX 导入(需 openpyxl)', () => {
  it('多工作表未指定 sheet 时要求用户指定(§496)', { timeout: 30_000 }, async () => {
    const { service } = await makeService(repoRuntimeDir);
    const workspace = await service.createWorkspace('多表');
    const source = join(dirs[0]!, 'book.xlsx');
    makeXlsxFixture(source);
    const staged = await service.stageUpload(source);
    await expect(
      service.importFile({
        workspace_id: workspace.id,
        dataset_name: '多表数据',
        format: 'xlsx',
        staged_path: staged,
      }),
    ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
  });

  it('指定 sheet 后物化受控 CSV 快照,公式缺缓存值记 unavailable', { timeout: 30_000 }, async () => {
    const { service, root } = await makeService(repoRuntimeDir);
    const workspace = await service.createWorkspace('多表选择');
    const source = join(dirs[0]!, 'book2.xlsx');
    makeXlsxFixture(source);
    const staged = await service.stageUpload(source);
    const { dataset, version, dataRef } = await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '西区',
      format: 'xlsx',
      staged_path: staged,
      sheet: 'West',
    });
    expect(dataRef.format).toBe('xlsx');
    expect(dataRef.row_count).toBe(1);

    const versionDir = join(
      root,
      'data',
      'workspaces',
      workspace.id,
      'datasets',
      dataset.id,
      'versions',
      version.id,
    );
    const manifest = JSON.parse(await readFile(join(versionDir, 'manifest.json'), 'utf8')) as {
      format: string;
      data_file: string;
      selected_sheet: string;
      formula_unavailable: number;
      sheets: Array<{ name: string }>;
      sha256: string;
    };
    expect(manifest.selected_sheet).toBe('West');
    expect(manifest.sheets.map((item) => item.name)).toEqual(['East', 'West']);
    expect(manifest.formula_unavailable).toBe(1); // =SUM(B2:B2) 无缓存结果
    expect(manifest.data_file.endsWith('.csv')).toBe(true);

    const snapshot = await readFile(join(versionDir, manifest.data_file), 'utf8');
    expect(snapshot).toBe('region,amount,note,derived\nc,50,cached,\n');

    const resolved = await service.resolveData(dataRef.ref_id, {
      workspace_id: workspace.id,
      max_bytes: 1 << 20,
      max_rows: 1000,
    });
    expect(resolved.within_limits).toBe(true);
    expect(resolved.absolute_path.endsWith('.csv')).toBe(true);
  });

  it('单一工作表自动选定', { timeout: 30_000 }, async () => {
    const { service } = await makeService(repoRuntimeDir);
    const workspace = await service.createWorkspace('单表');
    const source = join(dirs[0]!, 'single.xlsx');
    const script = [
      'import openpyxl',
      'wb = openpyxl.Workbook()',
      "wb.active.title = 'Only'",
      "wb.active.append(['x', 'y'])",
      "wb.active.append([1, 2])",
      `wb.save(${JSON.stringify(source)})`,
    ].join('\n');
    const result = spawnSync('python3', ['-c', script]);
    if (result.status !== 0) throw new Error(String(result.stderr));
    const staged = await service.stageUpload(source);
    const { dataRef } = await service.importFile({
      workspace_id: workspace.id,
      dataset_name: '单表数据',
      format: 'xlsx',
      staged_path: staged,
    });
    expect(dataRef.row_count).toBe(1);
    expect(dataRef.format).toBe('xlsx');
  });
});
