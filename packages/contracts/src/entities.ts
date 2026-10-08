import { z } from 'zod';
import { UuidSchema, IsoDatetimeSchema } from './ids.js';

// ---------------------------------------------------------------------------
// §8 核心实体 — 所有持久 ID 为 UUID,时间为 UTC RFC3339,终态不可回退。
// ---------------------------------------------------------------------------

export const WorkspaceStateSchema = z.enum(['active', 'archived', 'deleted']);
export const WorkspaceSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(200),
  root: z.string().min(1), // 由 Workspace 服务解析的相对根,不接受调用方绝对路径
  created_at: IsoDatetimeSchema,
  state: WorkspaceStateSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const SessionBindingSchema = z.object({
  id: UuidSchema,
  dsh_session_id: z.string().min(1),
  workspace_id: UuidSchema,
  notebook_id: UuidSchema.nullable(),
  model_profile_id: UuidSchema.nullable(),
  created_at: IsoDatetimeSchema,
});
export type SessionBinding = z.infer<typeof SessionBindingSchema>;

export const RunTriggerSchema = z.enum(['user_message', 'manual_cell', 'replay', 'system']);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;
export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelling',
  'cancelled',
  'interrupted',
]);
export const RunPhaseSchema = z.enum(['inspect', 'quality', 'compute', 'validate', 'present']);
export const AnalysisRunSchema = z.object({
  id: UuidSchema,
  session_id: UuidSchema,
  trigger: RunTriggerSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema.nullable(),
  config_revision: z.number().int().nonnegative(),
  model_profile_snapshot_id: UuidSchema.nullable(),
  idempotency_key: z.string().min(1).nullable(),
  started_at: IsoDatetimeSchema,
  ended_at: IsoDatetimeSchema.nullable(),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

export const DatasetSourceKindSchema = z.enum(['file_upload', 'sql_query', 'derived']);
export const DatasetSchema = z.object({
  id: UuidSchema,
  workspace_id: UuidSchema,
  name: z.string().min(1).max(300),
  source_kind: DatasetSourceKindSchema,
  created_at: IsoDatetimeSchema,
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const VersionOperationSchema = z.enum(['import', 'sql_extract', 'clean', 'filter', 'sample', 'derive']);
export const DatasetVersionSchema = z.object({
  id: UuidSchema,
  dataset_id: UuidSchema,
  parents: z.array(UuidSchema),
  data_ref_id: UuidSchema,
  operation: VersionOperationSchema,
  scope: z.string().max(2000),
  schema_json: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  sha256: z.string().length(64),
  created_at: IsoDatetimeSchema,
  state: z.enum(['ready', 'incomplete', 'corrupted']),
});
export type DatasetVersion = z.infer<typeof DatasetVersionSchema>;

export const NotebookRefSchema = z.object({
  id: UuidSchema,
  session_id: UuidSchema,
  relative_path: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type NotebookRef = z.infer<typeof NotebookRefSchema>;

export const KernelLeaseSchema = z.object({
  session_id: UuidSchema,
  kernel_id: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  status: z.enum(['starting', 'idle', 'busy', 'interrupting', 'failed', 'stopped']),
  state_dirty: z.boolean(),
  last_used_at: IsoDatetimeSchema,
});
export type KernelLease = z.infer<typeof KernelLeaseSchema>;

export const ExecutionRecordSchema = z.object({
  id: UuidSchema,
  run_id: UuidSchema.nullable(),
  cell_id: z.string().min(1),
  source_revision: z.number().int().nonnegative(),
  source_hash: z.string().length(64),
  kernel_epoch: z.number().int().nonnegative(),
  lease_token: z.string().min(1),
  status: z.enum(['registered', 'running', 'completed', 'failed', 'interrupted', 'unknown']),
  started_at: IsoDatetimeSchema,
  ended_at: IsoDatetimeSchema.nullable(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

/** §9 最小表集合 run_events:Run/Session/Cell 维度的结构化日志关联(FR17)。 */
export const RunEventLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export const RunEventSchema = z.object({
  id: UuidSchema,
  run_id: UuidSchema.nullable(),
  session_id: UuidSchema.nullable(),
  cell_id: z.string().min(1).nullable(),
  execution_id: UuidSchema.nullable(),
  level: RunEventLevelSchema,
  event: z.string().min(1).max(100),
  message: z.string().max(2000),
  at: IsoDatetimeSchema,
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const MetricEvidenceSchema = z.object({
  id: UuidSchema,
  run_id: UuidSchema.nullable(),
  data_ref_id: UuidSchema,
  locator: z.string().min(1),
  value_type: z.enum(['number', 'string', 'boolean', 'ratio', 'percent']),
  unit: z.string().max(50).nullable(),
  scope: z.string().max(2000),
  verification: z.enum(['unverified', 'consistent', 'mismatch', 'stale']),
  created_at: IsoDatetimeSchema,
});
export type MetricEvidence = z.infer<typeof MetricEvidenceSchema>;

export const ArtifactKindSchema = z.enum([
  'notebook',
  'table',
  'metrics',
  'figure',
  'html-report',
  'quality-report',
  'ml-model',
]);
export const ArtifactSchema = z.object({
  id: UuidSchema,
  run_id: UuidSchema.nullable(),
  kind: ArtifactKindSchema,
  relative_path: z.string().min(1),
  sha256: z.string().length(64),
  inputs: z.array(UuidSchema),
  producer: z.string().min(1),
  state: z.enum(['pending', 'ready', 'incomplete', 'corrupted']),
  created_at: IsoDatetimeSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const CapabilityLevelSchema = z.enum(['required', 'optional', 'disabled']);
export const ModelProfileSchema = z.object({
  id: UuidSchema,
  revision: z.number().int().positive(),
  protocol: z.literal('openai-chat'),
  base_url: z.url(),
  model: z.string().min(1),
  credential_ref: z.string().regex(/^(env|file|none|svc):.+/),
  capabilities: z.object({
    streaming: CapabilityLevelSchema,
    tool_calling: CapabilityLevelSchema,
    vision: CapabilityLevelSchema,
  }),
  config_hash: z.string().length(64),
  created_at: IsoDatetimeSchema,
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const DataSourceBindingSchema = z.object({
  id: UuidSchema,
  workspace_id: UuidSchema.nullable(),
  driver: z.string().min(1),
  endpoint: z.string().min(1),
  credential_ref: z.string().regex(/^(env|file|none|svc):.+/),
  readonly: z.literal(true),
  created_at: IsoDatetimeSchema,
});
export type DataSourceBinding = z.infer<typeof DataSourceBindingSchema>;
