import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryRepository } from './repository.js';
import { AnalysisService } from './analysis.js';
import type { DataRef } from '@data-analyst/contracts';
import type { ResolvedPaths } from './paths.js';

// §13/§14/T14 端到端:真实 Python sidecar + 产品侧独立重算校验。
// 前提:python3 与 numpy/pandas/scipy 可用(与 notebook 测试同一前提)。

const RUNTIME_DIR = fileURLToPath(new URL('../../../python/analyst_runtime', import.meta.url));

const WORKSPACE_ID = '00000000-0000-4000-8000-00000000a001';
const VERSION_ID = '00000000-0000-4000-8000-00000000b001';

let baseDir: string;
let paths: ResolvedPaths;
let repository: InMemoryRepository;
let service: AnalysisService;

function makeDataRef(sha256: string, refId = '00000000-0000-4000-8000-00000000c001'): DataRef {
  return {
    ref_id: refId,
    workspace_id: WORKSPACE_ID,
    dataset_version_id: VERSION_ID,
    kind: 'table',
    format: 'csv',
    sha256,
    size_bytes: 100,
    row_count: 10,
    row_count_status: 'exact',
    schema_ref: 'test-schema',
    completeness: 'complete',
    scope: {
      source_ref: null,
      filter_description: null,
      sample_method: null,
      sample_seed: null,
      sampled_rows: null,
      query_result_complete: null,
    },
  };
}

const STATS_CSV = [
  'group,value',
  'A,10',
  'A,12',
  'A,11',
  'A,13',
  'A,12',
  'B,15',
  'B,16',
  'B,14',
  'B,17',
  'B,16',
].join('\n');

const ML_CSV = [
  'user_id,x1,x2,label,score',
  ...Array.from({ length: 60 }, (_, i) => {
    const x1 = (i % 10) + 1;
    const x2 = (i % 5) + 1;
    const score = 2 * x1 + 3 * x2;
    const label = score > 17.5 ? 'yes' : 'no';
    return `U${String(i).padStart(3, '0')},${x1},${x2},${label},${score}`;
  }),
].join('\n');

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'dm-analysis-'));
  paths = {
    dataDir: join(baseDir, 'data'),
    stateDir: join(baseDir, 'state'),
    cacheDir: join(baseDir, 'cache'),
    workspacesDir: join(baseDir, 'data', 'workspaces'),
    productStateFile: join(baseDir, 'state', 'product.sqlite'),
    dshStateDir: join(baseDir, 'state', 'dsh'),
    credentialsDir: join(baseDir, 'state', 'credentials'),
  };
  repository = new InMemoryRepository();
  service = new AnalysisService({
    repository,
    paths,
    pythonBin: process.env.DATA_ANALYST_PYTHON ?? 'python3',
    runtimeDir: process.env.DATA_ANALYST_RUNTIME_DIR ?? RUNTIME_DIR,
    maxBytes: 10 * 1024 * 1024,
    maxRows: 100_000,
  });
}, 30_000);

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('AnalysisService.compareGroups', () => {
  it('sidecar Welch 检验 + 产品侧独立重算 → 一致指标 consistent,p 值 unverified', async () => {
    const csvPath = join(baseDir, 'stats.csv');
    await writeFile(csvPath, STATS_CSV, 'utf8');
    const outcome = await service.compareGroups({
      workspaceId: WORKSPACE_ID,
      dataRef: makeDataRef('a'.repeat(64)),
      absolutePath: csvPath,
      groupCol: 'group',
      valueCol: 'value',
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.stats?.statistics.mean_diff).toBeCloseTo(-4, 10);
    const byName = Object.fromEntries(outcome.checks.map((check) => [check.name, check]));
    for (const name of ['mean_a', 'mean_b', 'mean_diff', 't_stat', 'cohens_d']) {
      expect(byName[name]?.status).toBe('consistent');
    }
    expect(byName['p_value']?.status).toBe('unverifiable');
    // evidence 与 checks 一一对应,状态如实
    expect(outcome.evidence).toHaveLength(outcome.checks.length);
    expect(outcome.evidence.filter((item) => item.verification === 'consistent')).toHaveLength(5);
    expect(outcome.evidence.some((item) => item.verification === 'unverified')).toBe(true);
    // 产物落盘,input_refs 已补齐为真实 ref
    const artifactPath = join(
      paths.workspacesDir,
      WORKSPACE_ID,
      outcome.artifacts.stats!.relative_path,
    );
    const persisted = JSON.parse(await readFile(artifactPath, 'utf8')) as {
      input_refs: string[];
      method: string;
    };
    expect(persisted.input_refs).toEqual(['00000000-0000-4000-8000-00000000c001']);
    expect(persisted.method).toBe('welch_t_test');
  }, 120_000);

  it('三组数据 → unsupported,不产工件也不挑方法', async () => {
    const csvPath = join(baseDir, 'three-groups.csv');
    await writeFile(csvPath, 'group,value\nA,1\nB,2\nC,3\n', 'utf8');
    const outcome = await service.compareGroups({
      workspaceId: WORKSPACE_ID,
      dataRef: makeDataRef('a'.repeat(64)),
      absolutePath: csvPath,
      groupCol: 'group',
      valueCol: 'value',
    });
    expect(outcome.status).toBe('unsupported');
    expect(outcome.stats).toBeNull();
    expect(outcome.artifacts.stats).toBeNull();
    expect(outcome.evidence).toHaveLength(0);
  }, 120_000);
});

describe('AnalysisService.trainModel', () => {
  it('回归训练:泄漏剔除 user_id,产品侧重算指标一致,split 绑定数据版本', async () => {
    const csvPath = join(baseDir, 'ml.csv');
    await writeFile(csvPath, ML_CSV, 'utf8');
    const outcome = await service.trainModel({
      workspaceId: WORKSPACE_ID,
      dataRef: makeDataRef('b'.repeat(64)),
      absolutePath: csvPath,
      task: 'regression',
      target: 'score',
      features: ['x1', 'x2', 'user_id'],
      splitSeed: 42,
      testRatio: 0.25,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.training?.split.leakage.excluded_fields).toContainEqual({
      column: 'user_id',
      reason: 'ID/标识命名列,无泛化意义',
    });
    expect(outcome.training?.split.dataset_version_id).toBe(VERSION_ID);
    expect(outcome.training?.split.split_seed).toBe(42);
    // §13:产品侧用预测文件重算,应全部一致
    expect(outcome.checks.map((check) => check.status)).toEqual([
      'consistent',
      'consistent',
      'consistent',
    ]);
    expect(outcome.evidence.every((item) => item.verification === 'consistent')).toBe(true);
    // 两个工件都落盘
    for (const artifact of [outcome.artifacts.model, outcome.artifacts.predictions]) {
      const file = join(paths.workspacesDir, WORKSPACE_ID, artifact!.relative_path);
      await expect(readFile(file, 'utf8')).resolves.toContain('"schema_version": 1');
    }
  }, 180_000);

  it('分类训练:指标重算一致,混淆矩阵在检查清单中', async () => {
    const csvPath = join(baseDir, 'ml.csv');
    const outcome = await service.trainModel({
      workspaceId: WORKSPACE_ID,
      dataRef: makeDataRef('b'.repeat(64)),
      absolutePath: csvPath,
      task: 'classification',
      target: 'label',
      features: ['x1', 'x2'],
      splitSeed: 42,
      testRatio: 0.25,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.training?.classes).toEqual(['no', 'yes']);
    expect(outcome.checks.map((check) => check.name)).toContain('confusion_matrix');
    expect(outcome.checks.every((check) => check.status === 'consistent')).toBe(true);
  }, 180_000);

  it('目标列泄漏(target 在特征列表)→ unsupported,不产工件', async () => {
    const csvPath = join(baseDir, 'ml.csv');
    const outcome = await service.trainModel({
      workspaceId: WORKSPACE_ID,
      dataRef: makeDataRef('b'.repeat(64)),
      absolutePath: csvPath,
      task: 'regression',
      target: 'score',
      features: ['x1', 'score'],
    });
    expect(outcome.status).toBe('unsupported');
    expect(outcome.artifacts.model).toBeNull();
    expect(outcome.evidence).toHaveLength(0);
  }, 180_000);
});

describe('AnalysisService 崩溃语义(§24)', () => {
  it('sidecar 进程失败 → ENVIRONMENT_INCOMPLETE,不产工件也不产证据', async () => {
    const csvPath = join(baseDir, 'stats.csv');
    const broken = new AnalysisService({
      repository,
      paths,
      pythonBin: 'definitely-not-a-python-bin-xyz',
      runtimeDir: RUNTIME_DIR,
      maxBytes: 10 * 1024 * 1024,
      maxRows: 100_000,
    });
    const artifactsBefore = (await repository.artifacts.list()).length;
    const evidenceBefore = (await repository.metricEvidence.list()).length;
    await expect(
      broken.compareGroups({
        workspaceId: WORKSPACE_ID,
        dataRef: makeDataRef('a'.repeat(64)),
        absolutePath: csvPath,
        groupCol: 'group',
        valueCol: 'value',
      }),
    ).rejects.toMatchObject({ payload: { code: 'ENVIRONMENT_INCOMPLETE' } });
    expect((await repository.artifacts.list()).length).toBe(artifactsBefore);
    expect((await repository.metricEvidence.list()).length).toBe(evidenceBefore);
  }, 60_000);
});

describe('结果版本化(§24)', () => {
  it('重复执行同一段训练 → 新工件 ID,旧结果文件保留', async () => {
    const csvPath = join(baseDir, 'ml.csv');
    const first = await service.trainModel({
      workspaceId: WORKSPACE_ID,
      dataRef: makeDataRef('b'.repeat(64)),
      absolutePath: csvPath,
      task: 'regression',
      target: 'score',
      features: ['x1', 'x2'],
      splitSeed: 42,
    });
    const second = await service.trainModel({
      workspaceId: WORKSPACE_ID,
      dataRef: makeDataRef('b'.repeat(64)),
      absolutePath: csvPath,
      task: 'regression',
      target: 'score',
      features: ['x1', 'x2'],
      splitSeed: 42,
    });
    expect(second.artifacts.model!.artifactId).not.toBe(first.artifacts.model!.artifactId);
    const firstModelPath = join(
      paths.workspacesDir,
      WORKSPACE_ID,
      first.artifacts.model!.relative_path,
    );
    await expect(readFile(firstModelPath, 'utf8')).resolves.toBeTruthy();
    // 确定性:同种子同数据 → 指标一致(可从固定数据+代码重建)
    expect(first.training?.metrics.mae).toBeCloseTo(second.training!.metrics.mae as number, 12);
  }, 180_000);
});

describe('AnalysisService.refreshEvidenceStatus (T14)', () => {
  it('数据文件被改动后,该数据版本下的证据全部 stale', async () => {
    const csvPath = join(baseDir, 'stale.csv');
    await writeFile(csvPath, STATS_CSV, 'utf8');
    const dataRef = makeDataRef('a'.repeat(64), '00000000-0000-4000-8000-00000000c003');
    const first = await service.compareGroups({
      workspaceId: WORKSPACE_ID,
      dataRef,
      absolutePath: csvPath,
      groupCol: 'group',
      valueCol: 'value',
    });
    expect(first.status).toBe('completed');
    expect(first.evidence.length).toBeGreaterThan(0);
    // 改动文件后刷新 → 登记库中对应证据全部 stale
    await writeFile(csvPath, `${STATS_CSV}\nA,99\n`, 'utf8');
    const { staleCount } = await service.refreshEvidenceStatus({
      dataRef,
      absolutePath: csvPath,
    });
    expect(staleCount).toBe(first.evidence.length);
    for (const item of first.evidence) {
      const updated = await repository.metricEvidence.get(item.id);
      expect(updated?.verification).toBe('stale');
    }
  }, 120_000);
});
