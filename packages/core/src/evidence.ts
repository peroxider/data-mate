import type { TrainingResult } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §13 关键结论验证:指标重算的 TypeScript 独立实现。
// 不信任 sidecar 自报值 —— 用预测文件(固定 actual/predicted)在产品侧
// 重新计算,一致才把 MetricEvidence 标 consistent;无法独立重算的指标
// (如依赖 t 分布 CDF 的 p 值)如实留 unverified。
// ---------------------------------------------------------------------------

export type MetricCheckStatus = 'consistent' | 'mismatch' | 'unverifiable';

export interface MetricCheck {
  name: string;
  reported: number | null;
  recomputed: number | null;
  status: MetricCheckStatus;
}

export interface BinaryMetrics {
  accuracy: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  confusion: { labels: string[]; matrix: number[][] };
}

export function recomputeBinaryMetrics(
  actual: string[],
  predicted: string[],
  knownLabels?: string[],
): BinaryMetrics {
  // 测试集可能只出现一个类别;此时用训练时的类别表,避免把双类问题算成单类
  const labels = knownLabels && knownLabels.length > 0
    ? [...knownLabels].sort()
    : [...new Set([...actual, ...predicted])].sort();
  const positive = labels[1] ?? labels[0];
  const negative = labels[0] ?? positive;
  const singleLabel = positive === negative;
  const tp = actual.filter((v, i) => v === positive && predicted[i] === positive).length;
  const fp = singleLabel ? 0 : actual.filter((v, i) => v === negative && predicted[i] === positive).length;
  const fn = singleLabel ? 0 : actual.filter((v, i) => v === positive && predicted[i] === negative).length;
  const tn = singleLabel ? 0 : actual.filter((v, i) => v === negative && predicted[i] === negative).length;
  const ratio = (numerator: number, denominator: number): number | null =>
    denominator > 0 ? numerator / denominator : null;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return {
    accuracy: actual.length > 0 ? (tp + tn) / actual.length : 0,
    precision,
    recall,
    f1,
    confusion: { labels, matrix: [[tn, fp], [fn, tp]] },
  };
}

export interface RegressionMetrics {
  mae: number;
  rmse: number;
  r2: number | null;
}

export function recomputeRegressionMetrics(
  actual: number[],
  predicted: number[],
): RegressionMetrics {
  const errors = actual.map((value, index) => value - (predicted[index] as number));
  const mae = errors.reduce((sum, value) => sum + Math.abs(value), 0) / actual.length;
  const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / actual.length);
  const mean = actual.reduce((sum, value) => sum + value, 0) / actual.length;
  const ssRes = errors.reduce((sum, value) => sum + value * value, 0);
  const ssTot = actual.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return { mae, rmse, r2: ssTot > 0 ? 1 - ssRes / ssTot : null };
}

/** 相对 1e-6 / 绝对 1e-9 容差(§25:数值容差随环境记录,不承诺逐位一致) */
export function numbersConsistent(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= Math.max(1e-9, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
}

export interface PredictionPayload {
  actual: unknown[];
  predicted: unknown[];
}

/** 用预测文件独立重算训练指标,与自报值逐一比对。 */
export function verifyTrainingMetrics(
  training: TrainingResult,
  predictions: PredictionPayload,
): MetricCheck[] {
  const reported = training.metrics;
  const check = (name: string, value: number | null): MetricCheck => ({
    name,
    reported: (reported[name] as number | undefined) ?? null,
    recomputed: value,
    status:
      reported[name] === undefined
        ? 'unverifiable'
        : numbersConsistent((reported[name] as number) ?? null, value)
          ? 'consistent'
          : 'mismatch',
  });
  if (training.task === 'classification') {
    const actual = predictions.actual.map(String);
    const predicted = predictions.predicted.map(String);
    const recomputed = recomputeBinaryMetrics(actual, predicted, training.classes ?? undefined);
    // 混淆矩阵自报值在顶层 confusion_matrix 字段(不在数值 metrics 里)
    const reportedMatrix = training.confusion_matrix;
    const matrixCheck: MetricCheck = reportedMatrix
      ? {
          name: 'confusion_matrix',
          reported: null,
          recomputed: null,
          status:
            JSON.stringify(recomputed.confusion) === JSON.stringify(reportedMatrix)
              ? 'consistent'
              : 'mismatch',
        }
      : {
          name: 'confusion_matrix',
          reported: null,
          recomputed: null,
          status: 'unverifiable',
        };
    return [
      check('accuracy', recomputed.accuracy),
      check('precision', recomputed.precision),
      check('recall', recomputed.recall),
      check('f1', recomputed.f1),
      matrixCheck,
    ];
  }
  const actual = predictions.actual.map(Number);
  const predicted = predictions.predicted.map(Number);
  const recomputed = recomputeRegressionMetrics(actual, predicted);
  return [check('mae', recomputed.mae), check('rmse', recomputed.rmse), check('r2', recomputed.r2)];
}

/** Welch t 统计量的 TS 独立重算(不依赖 scipy;p 值留 unverifiable)。 */
export function recomputeWelch(
  groupA: number[],
  groupB: number[],
): { meanA: number; meanB: number; meanDiff: number; tStat: number; cohensD: number } {
  const mean = (values: number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = (values: number[]): number => {
    const mu = mean(values);
    return values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (values.length - 1);
  };
  const meanA = mean(groupA);
  const meanB = mean(groupB);
  const varA = variance(groupA);
  const varB = variance(groupB);
  const se = Math.sqrt(varA / groupA.length + varB / groupB.length);
  const pooled = Math.sqrt(
    ((groupA.length - 1) * varA + (groupB.length - 1) * varB) /
      (groupA.length + groupB.length - 2),
  );
  return {
    meanA,
    meanB,
    meanDiff: meanA - meanB,
    tStat: (meanA - meanB) / se,
    cohensD: pooled > 0 ? (meanA - meanB) / pooled : Number.NaN,
  };
}

/** 数据哈希与登记时不一致 → 相关证据全部 stale(T14)。 */
export function evidenceStale(dataSha256: string, currentSha256: string): boolean {
  return dataSha256 !== currentSha256;
}
