import { z } from 'zod';
import { UuidSchema } from './ids.js';

// §8 DataRef 契约:小型描述对象,定位可重读的数据版本,表达范围/格式/完整性/类型。
// 服务端保存实际相对路径;客户端与 Agent 只持有 ref_id。

export const DataCompletenessSchema = z.enum(['complete', 'sampled', 'truncated', 'unknown']);
export const DataRefSchema = z.object({
  ref_id: UuidSchema,
  workspace_id: UuidSchema,
  dataset_version_id: UuidSchema.nullable(),
  kind: z.enum(['table', 'metrics', 'figure_data']),
  format: z.enum(['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'parquet']),
  sha256: z.string().length(64),
  size_bytes: z.number().int().nonnegative(),
  row_count: z.number().int().nonnegative().nullable(), // 未知用 null,不用 0
  row_count_status: z.enum(['exact', 'estimated', 'unknown']),
  schema_ref: z.string().min(1),
  completeness: DataCompletenessSchema,
  scope: z.object({
    source_ref: UuidSchema.nullable(),
    filter_description: z.string().max(2000).nullable(),
    sample_method: z.string().max(200).nullable(),
    sample_seed: z.number().int().nullable(),
    sampled_rows: z.number().int().nonnegative().nullable(),
    query_result_complete: z.boolean().nullable(),
  }),
});
export type DataRef = z.infer<typeof DataRefSchema>;

export const ArtifactRefSchema = z.object({
  artifact_id: UuidSchema,
  workspace_id: UuidSchema,
  kind: z.enum([
    'notebook',
    'table',
    'metrics',
    'figure',
    'html-report',
    'quality-report',
    'ml-model',
  ]),
  relative_path: z.string().min(1),
  sha256: z.string().length(64),
  state: z.enum(['pending', 'ready', 'incomplete', 'corrupted']),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const AccessScopeSchema = z.object({
  workspace_id: UuidSchema,
  max_bytes: z.number().int().nonnegative().default(50 * 1024 * 1024),
  max_rows: z.number().int().nonnegative().default(100_000),
});
export type AccessScope = z.infer<typeof AccessScopeSchema>;

export const ResolvedDataSchema = z.object({
  ref: DataRefSchema,
  /** 服务端解析出的文件系统绝对路径;仅存在于服务进程内,不进入模型上下文 */
  absolute_path: z.string().min(1),
  bytes_available: z.number().int().nonnegative(),
  within_limits: z.boolean(),
});
export type ResolvedData = z.infer<typeof ResolvedDataSchema>;
