import { describe, expect, it } from 'vitest';
import { renderCoefficientSvg } from './figure.js';
import type { TrainingResult } from '@data-analyst/contracts';

// §24 基础解释图:SVG 内联、无远程引用;无内容时返回 null 不伪造图形。

const training: TrainingResult = {
  schema_version: 1,
  task: 'regression',
  model: {
    kind: 'linear',
    feature_order: ['x1', 'x2'],
    standardization: { means: [0, 0], stds: [1, 1] },
    coefficients: [2, -3],
    intercept: 0,
  },
  split: {
    schema_version: 1,
    dataset_version_id: null,
    data_sha256: 'a'.repeat(64),
    task: 'regression',
    target: 'y',
    features: ['x1', 'x2'],
    split_strategy: 'random',
    split_seed: 42,
    test_ratio: 0.25,
    train_indices: [0, 1],
    test_indices: [2],
    leakage: { checked: true, excluded_fields: [] },
  },
  classes: null,
  n_train: 2,
  n_test: 1,
  metrics: { mae: 0 },
  confusion_matrix: null,
  baseline: { mae: 1 },
  environment: { python: '3', numpy: '1', scipy: null },
  created_at: '2026-10-08T00:00:00Z',
};

describe('renderCoefficientSvg', () => {
  it('按系数绝对值排序的水平条形图,正值蓝/负值红', () => {
    const svg = renderCoefficientSvg(training);
    expect(svg).not.toBeNull();
    expect(svg).toContain('<svg');
    // |−3| > |2| → x2 排第一
    const svgText = svg as string;
    const x1Pos = svgText.indexOf('>x1<');
    const x2Pos = svgText.indexOf('>x2<');
    expect(x2Pos).toBeGreaterThan(-1);
    expect(x2Pos).toBeLessThan(x1Pos);
    expect(svgText).toContain('#3567b0');
    expect(svgText).toContain('#b03535');
    expect(svgText).not.toContain('http://');
    expect(svgText).not.toContain('https://');
  });

  it('无特征或系数全零时返回 null(不伪造图形)', () => {
    expect(
      renderCoefficientSvg({
        ...training,
        model: { ...training.model, feature_order: [], coefficients: [] },
      }),
    ).toBeNull();
    expect(
      renderCoefficientSvg({
        ...training,
        model: { ...training.model, coefficients: [0, 0] },
      }),
    ).toBeNull();
  });

  it('特征与系数数量不一致时返回 null', () => {
    expect(
      renderCoefficientSvg({
        ...training,
        model: { ...training.model, coefficients: [1] },
      }),
    ).toBeNull();
  });
});
