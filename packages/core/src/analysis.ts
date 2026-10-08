import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AnalystError,
  StatsResultSchema,
  TrainingResultSchema,
  newId,
  nowIso,
} from '@data-analyst/contracts';
import type { DataRef, MetricEvidence, StatsResult, TrainingResult } from '@data-analyst/contracts';
import type { RepositoryPort } from './repository.js';
import type { ResolvedPaths } from './paths.js';
import { runSidecar, parseSidecarJson } from './sidecar.js';
import { readCsvRecords } from './csv-scan.js';
import { sha256File } from './hashing.js';
import {
  numbersConsistent,
  recomputeWelch,
  evidenceStale,
  verifyTrainingMetrics,
} from './evidence.js';
import type { MetricCheck } from './evidence.js';

// ---------------------------------------------------------------------------
// §14 统计与训练编排:通过 Python sidecar 执行计算,产物(stats.json /
// model.json / predictions.json)落盘为工作区工件;§13 关键指标在产品侧用
// 确定性 TS 代码独立重算,一致 → evidence consistent,不一致 → mismatch,
// 无法重算(p 值等)→ 如实 unverified。T14:数据哈希与登记不一致时相关
// 证据全部 stale。sidecar 报错/依赖缺失如实抛 ENVIRONMENT_INCOMPLETE,
// 方法不适用返回 unsupported,不静默降级、不挑选能产生显著结果的方法。
// ---------------------------------------------------------------------------

export interface StatsEnvelope {
  ok: boolean;
  reason?: string;
  unsupported?: string;
  n_total?: number;
  stats?: StatsResult;
}

export interface TrainEnvelope {
  ok: boolean;
  reason?: string;
  unsupported?: string;
  n_total?: number;
  n_used?: number;
  input_refs?: string[];
  result?: {
    training: TrainingResult | null;
    predictions: { split: string; actual: unknown[]; predicted: unknown[] } | null;
  } | null;
}

export interface ArtifactFileInfo {
  artifactId: string;
  relative_path: string;
  sha256: string;
}

export interface CompareOutcome {
  status: 'completed' | 'unsupported';
  unsupported_reason?: string;
  stats: StatsResult | null;
  artifacts: { stats: ArtifactFileInfo | null };
  evidence: MetricEvidence[];
  checks: MetricCheck[];
}

export interface TrainOutcome {
  status: 'completed' | 'unsupported';
  unsupported_reason?: string;
  training: TrainingResult | null;
  artifacts: {
    model: ArtifactFileInfo | null;
    predictions: ArtifactFileInfo | null;
  };
  evidence: MetricEvidence[];
  checks: MetricCheck[];
}

function err(
  code: AnalystError['payload']['code'],
  message: string,
  details?: Record<string, unknown>,
): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: details ?? null,
  });
}

const WELCH_CHECKS: Array<{ name: string; key: keyof ReturnType<typeof recomputeWelch> }> = [
  { name: 'mean_a', key: 'meanA' },
  { name: 'mean_b', key: 'meanB' },
  { name: 'mean_diff', key: 'meanDiff' },
  { name: 't_stat', key: 'tStat' },
  { name: 'cohens_d', key: 'cohensD' },
];

export class AnalysisService {
  readonly #repository: RepositoryPort;
  readonly #paths: ResolvedPaths;
  readonly #pythonBin: string;
  readonly #runtimeDir: string | null;
  readonly #maxBytes: number;
  readonly #maxRows: number;
  readonly #timeoutSeconds: number;

  constructor(options: {
    repository: RepositoryPort;
    paths: ResolvedPaths;
    pythonBin: string;
    runtimeDir: string | null;
    maxBytes: number;
    maxRows: number;
    timeoutSeconds?: number;
  }) {
    this.#repository = options.repository;
    this.#paths = options.paths;
    this.#pythonBin = options.pythonBin;
    this.#runtimeDir = options.runtimeDir;
    this.#maxBytes = options.maxBytes;
    this.#maxRows = options.maxRows;
    this.#timeoutSeconds = options.timeoutSeconds ?? 300;
  }

  async #writeArtifact(
    workspaceId: string,
    fileName: string,
    content: string,
  ): Promise<ArtifactFileInfo> {
    const artifactId = newId();
    const artifactDir = join(this.#paths.workspacesDir, workspaceId, 'artifacts', artifactId);
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, fileName);
    await writeFile(artifactPath, content, 'utf8');
    const sha256 = await sha256File(artifactPath);
    return {
      artifactId,
      relative_path: `artifacts/${artifactId}/${fileName}`,
      sha256,
    };
  }

  #evidence(input: {
    runId: string | null;
    dataRef: DataRef;
    locator: string;
    valueType: MetricEvidence['value_type'];
    scope: string;
    verification: MetricEvidence['verification'];
  }): MetricEvidence {
    return {
      id: newId(),
      run_id: input.runId,
      data_ref_id: input.dataRef.ref_id,
      locator: input.locator,
      value_type: input.valueType,
      unit: null,
      scope: input.scope.slice(0, 2000),
      verification: input.verification,
      created_at: nowIso(),
    };
  }

  static #verificationOf(check: MetricCheck): MetricEvidence['verification'] {
    if (check.status === 'consistent') return 'consistent';
    if (check.status === 'mismatch') return 'mismatch';
    return 'unverified';
  }

  /** 两独立样本 Welch t 检验(sidecar scipy 计算 + 产品侧确定性重算校验)。 */
  async compareGroups(request: {
    workspaceId: string;
    dataRef: DataRef;
    absolutePath: string;
    groupCol: string;
    valueCol: string;
    alpha?: number;
    runId?: string | null;
  }): Promise<CompareOutcome> {
    const delimiter = request.dataRef.format === 'tsv' ? '\t' : ',';
    const run = await runSidecar({
      pythonBin: this.#pythonBin,
      runtimeDir: this.#runtimeDir,
      args: [
        'stats-compare',
        '--input',
        request.absolutePath,
        '--group-col',
        request.groupCol,
        '--value-col',
        request.valueCol,
        '--alpha',
        String(request.alpha ?? 0.05),
        '--delimiter',
        delimiter,
        '--input-ref',
        request.dataRef.ref_id,
      ],
      timeoutSeconds: this.#timeoutSeconds,
    });
    const envelope = parseSidecarJson<StatsEnvelope>(run);
    if (!envelope.ok) {
      throw err('ENVIRONMENT_INCOMPLETE', `统计计算失败: ${envelope.reason ?? '(无原因说明)'}`);
    }
    if (envelope.unsupported !== undefined) {
      return {
        status: 'unsupported',
        unsupported_reason: envelope.unsupported,
        stats: null,
        artifacts: { stats: null },
        evidence: [],
        checks: [],
      };
    }
    const statsResult = StatsResultSchema.safeParse(envelope.stats);
    if (!statsResult.success) {
      throw err('UNPROCESSABLE', 'sidecar 返回的 stats.json 结构不符合契约', {
        issues: statsResult.error.issues.slice(0, 5),
      });
    }
    const stats: StatsResult = {
      ...statsResult.data,
      input_refs: [request.dataRef.ref_id],
    };

    // §13 产品侧独立重算:从原始文件重读两组数值,重算 Welch 统计量。
    const checks: MetricCheck[] = [];
    const groupA = stats.statistics.group_a;
    const groupB = stats.statistics.group_b;
    let recomputed: ReturnType<typeof recomputeWelch> | null = null;
    if (typeof groupA === 'string' && typeof groupB === 'string') {
      try {
        const { header, records } = await readCsvRecords(request.absolutePath, {
          delimiter,
          maxBytes: this.#maxBytes,
          maxRows: this.#maxRows,
        });
        const groupIndex = header.indexOf(request.groupCol);
        const valueIndex = header.indexOf(request.valueCol);
        if (groupIndex >= 0 && valueIndex >= 0) {
          const valuesA: number[] = [];
          const valuesB: number[] = [];
          for (const record of records) {
            const value = Number(record[valueIndex]);
            if (record[groupIndex] === groupA && Number.isFinite(value)) valuesA.push(value);
            if (record[groupIndex] === groupB && Number.isFinite(value)) valuesB.push(value);
          }
          if (valuesA.length >= 2 && valuesB.length >= 2) {
            recomputed = recomputeWelch(valuesA, valuesB);
          }
        }
      } catch {
        recomputed = null; // 读不了原始数据 → 无法独立重算,如实 unverified
      }
    }
    for (const item of WELCH_CHECKS) {
      const reported = stats.statistics[item.name];
      if (recomputed === null || typeof reported !== 'number') {
        checks.push({
          name: item.name,
          reported: typeof reported === 'number' ? reported : null,
          recomputed: null,
          status: 'unverifiable',
        });
        continue;
      }
      const value = recomputed[item.key];
      checks.push({
        name: item.name,
        reported,
        recomputed: value,
        status: numbersConsistent(reported, value) ? 'consistent' : 'mismatch',
      });
    }
    // p 值依赖 t 分布 CDF,产品侧不做重算,如实 unverified
    if (stats.statistics.p_value !== undefined) {
      checks.push({
        name: 'p_value',
        reported: typeof stats.statistics.p_value === 'number' ? stats.statistics.p_value : null,
        recomputed: null,
        status: 'unverifiable',
      });
    }

    const content = JSON.stringify(stats, null, 2);
    const artifact = await this.#writeArtifact(request.workspaceId, 'stats.json', content);

    const evidence: MetricEvidence[] = checks.map((check) =>
      this.#evidence({
        runId: request.runId ?? null,
        dataRef: request.dataRef,
        locator: `artifacts/${artifact.artifactId}/stats.json#statistics.${check.name}`,
        valueType: 'number',
        scope: stats.population_scope,
        verification: AnalysisService.#verificationOf(check),
      }),
    );
    for (const item of evidence) {
      await this.#repository.metricEvidence.put(item);
    }

    return { status: 'completed', stats, artifacts: { stats: artifact }, evidence, checks };
  }

  /** 分类/回归训练(sidecar numpy 确定性实现 + 产品侧指标重算校验)。 */
  async trainModel(request: {
    workspaceId: string;
    dataRef: DataRef;
    absolutePath: string;
    task: 'classification' | 'regression';
    target: string;
    features: string[];
    splitSeed?: number;
    testRatio?: number;
    runId?: string | null;
  }): Promise<TrainOutcome> {
    const delimiter = request.dataRef.format === 'tsv' ? '\t' : ',';
    const run = await runSidecar({
      pythonBin: this.#pythonBin,
      runtimeDir: this.#runtimeDir,
      args: [
        'train-model',
        '--input',
        request.absolutePath,
        '--delimiter',
        delimiter,
        '--task',
        request.task,
        '--target',
        request.target,
        '--features',
        request.features.join(','),
        '--split-seed',
        String(request.splitSeed ?? 42),
        '--test-ratio',
        String(request.testRatio ?? 0.25),
        '--input-ref',
        request.dataRef.ref_id,
      ],
      timeoutSeconds: this.#timeoutSeconds,
    });
    const envelope = parseSidecarJson<TrainEnvelope>(run);
    if (!envelope.ok) {
      throw err('ENVIRONMENT_INCOMPLETE', `训练失败: ${envelope.reason ?? '(无原因说明)'}`);
    }
    if (envelope.unsupported !== undefined) {
      return {
        status: 'unsupported',
        unsupported_reason: envelope.unsupported,
        training: null,
        artifacts: { model: null, predictions: null },
        evidence: [],
        checks: [],
      };
    }
    const trainingRaw = envelope.result?.training;
    const predictionsRaw = envelope.result?.predictions;
    const trainingResult = TrainingResultSchema.safeParse(trainingRaw);
    if (!trainingResult.success || !predictionsRaw || !Array.isArray(predictionsRaw.actual)) {
      throw err('UNPROCESSABLE', 'sidecar 返回的训练产物不符合契约', {
        issues: trainingResult.success ? [] : trainingResult.error.issues.slice(0, 5),
      });
    }
    const training: TrainingResult = {
      ...trainingResult.data,
      split: {
        ...trainingResult.data.split,
        dataset_version_id: request.dataRef.dataset_version_id,
      },
    };

    // §13 产品侧用预测文件独立重算指标,再决定 evidence 状态
    const checks = verifyTrainingMetrics(training, {
      actual: predictionsRaw.actual,
      predicted: predictionsRaw.predicted,
    });

    const modelArtifact = await this.#writeArtifact(
      request.workspaceId,
      'model.json',
      JSON.stringify(training, null, 2),
    );
    const predictionsArtifact = await this.#writeArtifact(
      request.workspaceId,
      'predictions.json',
      JSON.stringify(
        { schema_version: 1, ...predictionsRaw, data_ref_id: request.dataRef.ref_id },
        null,
        2,
      ),
    );

    const evidence: MetricEvidence[] = checks.map((check) =>
      this.#evidence({
        runId: request.runId ?? null,
        dataRef: request.dataRef,
        locator: `artifacts/${modelArtifact.artifactId}/model.json#metrics.${check.name}`,
        valueType: check.name === 'confusion_matrix' ? 'string' : 'number',
        scope: `${training.task}; target=${training.split.target}; n_train=${training.n_train}; n_test=${training.n_test}`,
        verification: AnalysisService.#verificationOf(check),
      }),
    );
    for (const item of evidence) {
      await this.#repository.metricEvidence.put(item);
    }

    return {
      status: 'completed',
      training,
      artifacts: { model: modelArtifact, predictions: predictionsArtifact },
      evidence,
      checks,
    };
  }

  /**
   * T14:数据哈希与登记时不一致 → 该数据版本下的所有证据标 stale。
   * 登记时哈希来自 DataRef.sha256(导入时固定)。
   */
  async refreshEvidenceStatus(request: {
    dataRef: DataRef;
    absolutePath: string;
  }): Promise<{ staleCount: number }> {
    const current = await sha256File(request.absolutePath);
    if (!evidenceStale(request.dataRef.sha256, current)) {
      return { staleCount: 0 };
    }
    const all = await this.#repository.metricEvidence.list();
    let staleCount = 0;
    for (const item of all) {
      if (item.data_ref_id !== request.dataRef.ref_id || item.verification === 'stale') continue;
      await this.#repository.metricEvidence.put({ ...item, verification: 'stale' });
      staleCount++;
    }
    return { staleCount };
  }
}
