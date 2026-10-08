import { describe, expect, it } from 'vitest';
import {
  numbersConsistent,
  recomputeBinaryMetrics,
  recomputeRegressionMetrics,
  recomputeWelch,
  evidenceStale,
  verifyTrainingMetrics,
} from './evidence.js';
import type { TrainingResult } from '@data-analyst/contracts';

// §13:指标重算的独立实现必须与 sidecar 自报值可对账;
// 本文件用已知数值验证重算逻辑本身。

describe('recomputeBinaryMetrics', () => {
  it('对已知混淆矩阵给出一致指标', () => {
    const result = recomputeBinaryMetrics(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b']);
    expect(result.accuracy).toBe(0.5);
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(0.5);
    expect(result.f1).toBe(0.5);
    expect(result.confusion).toEqual({ labels: ['a', 'b'], matrix: [[1, 1], [1, 1]] });
  });

  it('测试集只有一个类别时用训练类别表,不产生 accuracy>1 的假象', () => {
    // 全部 actual 为 no,预测也全为 no → 正确率应为 1,而不是 (tp+tn)/n=2
    const result = recomputeBinaryMetrics(['no', 'no', 'no'], ['no', 'no', 'no'], ['no', 'yes']);
    expect(result.accuracy).toBe(1);
    expect(result.confusion).toEqual({ labels: ['no', 'yes'], matrix: [[3, 0], [0, 0]] });
  });

  it('完美预测给出 accuracy=1 与对角混淆矩阵', () => {
    const result = recomputeBinaryMetrics(['no', 'yes', 'yes'], ['no', 'yes', 'yes'], ['no', 'yes']);
    expect(result.accuracy).toBe(1);
    expect(result.confusion.matrix).toEqual([[1, 0], [0, 2]]);
  });

  it('全错预测给出 accuracy=0', () => {
    const result = recomputeBinaryMetrics(['no', 'yes'], ['yes', 'no'], ['no', 'yes']);
    expect(result.accuracy).toBe(0);
  });
});

describe('recomputeRegressionMetrics', () => {
  it('已知数值的 MAE/RMSE/R²', () => {
    const result = recomputeRegressionMetrics([1, 2, 3, 4], [2, 3, 4, 5]);
    expect(result.mae).toBe(1);
    expect(result.rmse).toBe(1);
    // 常量偏移:残差平方和 4,总平方和 5 → R² = 0.2
    expect(result.r2).toBeCloseTo(0.2, 12);
  });

  it('完美拟合 R²=1,零方差目标 R²=null(不伪造)', () => {
    expect(recomputeRegressionMetrics([1, 2, 3], [1, 2, 3]).r2).toBe(1);
    expect(recomputeRegressionMetrics([2, 2, 2], [2, 3, 2]).r2).toBeNull();
  });
});

describe('recomputeWelch', () => {
  it('已知两组数值的均值差/t 统计量/Cohen d', () => {
    const a = [10, 12, 11, 13, 12];
    const b = [15, 16, 14, 17, 16];
    const result = recomputeWelch(a, b);
    expect(result.meanA).toBe(11.6);
    expect(result.meanB).toBe(15.6);
    expect(result.meanDiff).toBe(-4);
    // 样本方差 a=b=5.2/4=1.3 → se = sqrt(1.3/5+1.3/5);pooled 标准差 = sqrt(1.3)
    const se = Math.sqrt(1.3 / 5 + 1.3 / 5);
    expect(result.tStat).toBeCloseTo(-4 / se, 12);
    expect(result.cohensD).toBeCloseTo(-4 / Math.sqrt(1.3), 12);
  });

  it('零方差组不产生除零(返回 NaN 而不是伪造值)', () => {
    const result = recomputeWelch([5, 5, 5], [6, 6, 6]);
    expect(result.meanDiff).toBe(-1);
    expect(Number.isNaN(result.cohensD)).toBe(true);
  });
});

describe('numbersConsistent', () => {
  it('相对 1e-6 容差内一致,超出判不一致', () => {
    expect(numbersConsistent(123456.789, 123456.789 * (1 + 1e-9))).toBe(true);
    expect(numbersConsistent(1.0, 1.001)).toBe(false);
    expect(numbersConsistent(null, null)).toBe(true);
    expect(numbersConsistent(1, null)).toBe(false);
  });
});

describe('evidenceStale', () => {
  it('哈希不一致 → stale(T14)', () => {
    const sha = 'a'.repeat(64);
    expect(evidenceStale(sha, sha)).toBe(false);
    expect(evidenceStale(sha, 'b'.repeat(64))).toBe(true);
  });
});

describe('verifyTrainingMetrics', () => {
  const training: TrainingResult = {
    schema_version: 1,
    task: 'classification',
    model: {
      kind: 'logistic',
      feature_order: ['x'],
      standardization: { means: [0], stds: [1] },
      coefficients: [1],
      intercept: 0,
    },
    split: {
      schema_version: 1,
      dataset_version_id: null,
      data_sha256: 'a'.repeat(64),
      task: 'classification',
      target: 'label',
      features: ['x'],
      split_strategy: 'random',
      split_seed: 42,
      test_ratio: 0.25,
      train_indices: [0, 1],
      test_indices: [2, 3, 4, 5],
      leakage: { checked: true, excluded_fields: [] },
    },
    classes: ['no', 'yes'],
    n_train: 2,
    n_test: 4,
    metrics: {
      accuracy: 0.75,
      precision: 1,
      recall: 2 / 3,
      f1: 0.8,
    },
    confusion_matrix: { labels: ['no', 'yes'], matrix: [[1, 0], [1, 2]] },
    baseline: { accuracy: 0.5 },
    environment: { python: '3', numpy: '1', scipy: null },
    created_at: '2026-10-08T00:00:00+08:00',
  };

  it('自报值与预测文件一致 → 全部 consistent(含混淆矩阵)', () => {
    const checks = verifyTrainingMetrics(training, {
      actual: ['no', 'yes', 'yes', 'yes'],
      predicted: ['no', 'yes', 'no', 'yes'],
    });
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(byName['accuracy']).toMatchObject({ status: 'consistent', recomputed: 0.75 });
    expect(byName['precision']).toMatchObject({ status: 'consistent' });
    expect(byName['recall']).toMatchObject({ status: 'consistent' });
    expect(byName['f1']).toMatchObject({ status: 'consistent' });
    expect(byName['confusion_matrix']?.status).toBe('consistent');
  });

  it('自报值被篡改 → mismatch', () => {
    const tampered: TrainingResult = {
      ...training,
      metrics: { ...training.metrics, accuracy: 0.99 },
    };
    const checks = verifyTrainingMetrics(tampered, {
      actual: ['no', 'yes', 'yes', 'yes'],
      predicted: ['no', 'yes', 'no', 'yes'],
    });
    expect(checks.find((check) => check.name === 'accuracy')).toMatchObject({
      status: 'mismatch',
      reported: 0.99,
      recomputed: 0.75,
    });
  });

  it('自报值缺失 → unverifiable,不虚构一致', () => {
    const reduced: TrainingResult = {
      ...training,
      metrics: { accuracy: 0.75 },
    };
    const checks = verifyTrainingMetrics(reduced, {
      actual: ['no', 'yes', 'yes', 'yes'],
      predicted: ['no', 'yes', 'no', 'yes'],
    });
    expect(checks.find((check) => check.name === 'precision')?.status).toBe('unverifiable');
  });

  it('回归任务:重算 mae/rmse/r2 并与自报值比对', () => {
    const regression: TrainingResult = {
      ...training,
      task: 'regression',
      classes: null,
      confusion_matrix: null,
      model: { ...training.model, kind: 'linear' },
      metrics: { mae: 1, rmse: 1, r2: 0.2 },
    };
    const checks = verifyTrainingMetrics(regression, {
      actual: [1, 2, 3, 4],
      predicted: [2, 3, 4, 5],
    });
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(byName['mae']).toMatchObject({ status: 'consistent', recomputed: 1 });
    expect(byName['rmse']).toMatchObject({ status: 'consistent' });
    expect(byName['r2']).toMatchObject({ status: 'consistent' });
  });
});
