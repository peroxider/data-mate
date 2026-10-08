import { z } from 'zod';
import { IsoDatetimeSchema, UuidSchema } from './ids.js';

// ---------------------------------------------------------------------------
// §14 统计分析与机器学习:结构化结果契约。
// stats.json 必须自包含方法、范围、缺失处理与限制,方法不适用时如实返回
// unsupported 而不是挑选能产生显著结果的方法。训练产物(模型参数/特征
// schema/切分 manifest/指标)可独立查看,不依赖先加载模型文件;
// 模型权重用 JSON 数组而非 pickle/joblib(§14:不自动反序列化不可信文件)。
// ---------------------------------------------------------------------------

export const StatsResultSchema = z.object({
  schema_version: z.literal(1),
  analysis_type: z.string().min(1),
  input_refs: z.array(UuidSchema),
  population_scope: z.string().min(1),
  n_total: z.number().int().nonnegative(),
  n_used: z.number().int().nonnegative(),
  missing_policy: z.string().min(1),
  method: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  statistics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  uncertainty: z.record(z.string(), z.unknown()),
  assumptions_checked: z.record(z.string(), z.unknown()),
  limitations: z.array(z.string()),
});
export type StatsResult = z.infer<typeof StatsResultSchema>;

export const SplitStrategySchema = z.enum(['random', 'stratified', 'group', 'temporal']);
export type SplitStrategy = z.infer<typeof SplitStrategySchema>;

/** §14/R6:切分 manifest 固定可复现索引、种子与数据哈希;泄漏检查结果必须留痕。 */
export const SplitManifestSchema = z.object({
  schema_version: z.literal(1),
  dataset_version_id: UuidSchema.nullable(),
  data_sha256: z.string().length(64),
  task: z.enum(['classification', 'regression']),
  target: z.string().min(1),
  features: z.array(z.string().min(1)),
  split_strategy: SplitStrategySchema,
  split_seed: z.number().int(),
  test_ratio: z.number(),
  train_indices: z.array(z.number().int().nonnegative()),
  test_indices: z.array(z.number().int().nonnegative()),
  leakage: z.object({
    checked: z.boolean(),
    excluded_fields: z.array(z.object({ column: z.string(), reason: z.string() })),
  }),
});
export type SplitManifest = z.infer<typeof SplitManifestSchema>;

export const TrainingResultSchema = z.object({
  schema_version: z.literal(1),
  task: z.enum(['classification', 'regression']),
  model: z.object({
    kind: z.enum(['logistic', 'linear']),
    feature_order: z.array(z.string().min(1)),
    /** 标准化参数在训练集上 fit(T13),应用到验证/测试 */
    standardization: z.object({
      means: z.array(z.number()),
      stds: z.array(z.number()),
    }),
    coefficients: z.array(z.number()),
    intercept: z.number(),
  }),
  split: SplitManifestSchema,
  classes: z.array(z.string()).nullable(),
  n_train: z.number().int().nonnegative(),
  n_test: z.number().int().nonnegative(),
  /** metrics 只放数值指标;混淆矩阵单独放顶层,保证 metrics 可独立重算比对 */
  metrics: z.record(z.string(), z.union([z.number(), z.null()])),
  confusion_matrix: z
    .object({ labels: z.array(z.string()), matrix: z.array(z.array(z.number())) })
    .nullable(),
  baseline: z.record(z.string(), z.union([z.number(), z.null()])),
  environment: z.object({
    python: z.string(),
    numpy: z.string(),
    scipy: z.string().nullable(),
  }),
  created_at: IsoDatetimeSchema,
});
export type TrainingResult = z.infer<typeof TrainingResultSchema>;

/** sidecar 统一信封:ok=false 时 reason 必填(如实报告,不静默) */
export const SidecarEnvelopeSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  result: z.unknown().optional(),
});
export type SidecarEnvelope = z.infer<typeof SidecarEnvelopeSchema>;
