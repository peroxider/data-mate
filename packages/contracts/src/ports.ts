import { z } from 'zod';
import { UuidSchema, IsoDatetimeSchema } from './ids.js';
import { DataRefSchema } from './data-ref.js';
import type { SessionBinding, NotebookRef, KernelLease } from './entities.js';
import type { DataRef, ArtifactRef, AccessScope, ResolvedData } from './data-ref.js';

// ---------------------------------------------------------------------------
// §8 产品内部服务端口。领域代码不直接访问 DSH / 插件内部对象;
// 适配层在 M0 验证后提供实现。端口参数(revision、超时、取消、scope)是实际执行参数。
// ---------------------------------------------------------------------------

// ----------------------------- WorkspacePort -------------------------------

export const ImportRequestSchema = z.object({
  workspace_id: UuidSchema,
  dataset_name: z.string().min(1).max(300),
  format: z.enum(['csv', 'tsv', 'xlsx', 'jsonl', 'parquet']),
  /** 服务端受控目录内的路径;不接受调用方拼接的任意绝对路径 */
  staged_path: z.string().min(1),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const ArtifactCommitSchema = z.object({
  workspace_id: UuidSchema,
  run_id: UuidSchema.nullable(),
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
});
export type ArtifactCommit = z.infer<typeof ArtifactCommitSchema>;

export interface WorkspacePort {
  importFile(input: ImportRequest): Promise<DataRef>;
  resolveData(refId: string, scope: AccessScope): Promise<ResolvedData>;
  registerArtifact(input: ArtifactCommit): Promise<ArtifactRef>;
}

// ------------------------------ NotebookPort -------------------------------

export const CellSnapshotSchema = z.object({
  cell_id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  source: z.string(),
  language: z.string().min(1),
});
export type CellSnapshot = z.infer<typeof CellSnapshotSchema>;

export const CellUpdateSchema = z.object({
  notebook_id: z.string().min(1),
  cell_id: z.string().min(1),
  expected_revision: z.number().int().nonnegative(),
  source: z.string(),
});
export type CellUpdate = z.infer<typeof CellUpdateSchema>;

export const CellExecutionSchema = z.object({
  notebook_id: z.string().min(1),
  cell_id: z.string().min(1),
  expected_revision: z.number().int().nonnegative().nullable(),
  timeout_seconds: z.number().int().positive(),
  allow_stdin: z.literal(false),
  idempotency_key: z.string().min(1).nullable(),
});
export type CellExecution = z.infer<typeof CellExecutionSchema>;

export const ExecutionEventSchema = z.object({
  execution_id: UuidSchema,
  session_id: UuidSchema,
  kernel_epoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  type: z.enum([
    'status',
    'stdout',
    'stderr',
    'execute_result',
    'display_data',
    'error',
    'done',
  ]),
  payload: z.record(z.string(), z.unknown()),
  at: IsoDatetimeSchema,
});
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

export const InterruptResultSchema = z.object({
  execution_id: UuidSchema,
  interrupted: z.boolean(),
  state_dirty: z.boolean(),
});
export type InterruptResult = z.infer<typeof InterruptResultSchema>;

export interface NotebookPort {
  ensureSession(binding: SessionBinding): Promise<NotebookRef>;
  getCells(notebookId: string): Promise<CellSnapshot[]>;
  updateCell(input: CellUpdate): Promise<CellSnapshot>;
  execute(input: CellExecution): AsyncIterable<ExecutionEvent>;
  interrupt(executionId: string): Promise<InterruptResult>;
  restart(sessionId: string): Promise<KernelLease>;
  save(notebookId: string): Promise<NotebookRef>;
}

// ------------------------------- QualityPort -------------------------------

export const ProfileRequestSchema = z.object({
  data_ref: DataRefSchema,
  columns: z.array(z.string().min(1)).nullable(),
  sample: z
    .object({
      rows: z.number().int().positive(),
      seed: z.number().int(),
    })
    .nullable(),
});
export type ProfileRequest = z.infer<typeof ProfileRequestSchema>;

export const ProfileFindingSchema = z.object({
  metric: z.string().min(1),
  column: z.string().nullable(),
  value: z.unknown(),
  scope: z.string().max(2000),
});
export type ProfileFinding = z.infer<typeof ProfileFindingSchema>;

export const ProfileResultSchema = z.object({
  ref: DataRefSchema,
  completeness: z.enum(['complete', 'sampled', 'truncated', 'unknown']),
  findings: z.array(ProfileFindingSchema),
  report_artifact: z.string().nullable(),
});
export type ProfileResult = z.infer<typeof ProfileResultSchema>;

export const CleanRuleSchema = z.object({
  rule_id: z.string().min(1),
  kind: z.string().min(1),
  column: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
});
export type CleanRule = z.infer<typeof CleanRuleSchema>;

export const CleanRequestSchema = z.object({
  data_ref: DataRefSchema,
  rules: z.array(CleanRuleSchema).min(1),
  dry_run: z.boolean(),
});
export type CleanRequest = z.infer<typeof CleanRequestSchema>;

export const CleanResultSchema = z.object({
  input_ref: DataRefSchema,
  output_ref: DataRefSchema.nullable(),
  rows_before: z.number().int().nonnegative().nullable(),
  rows_after: z.number().int().nonnegative().nullable(),
  applied_rules: z.array(
    z.object({
      rule_id: z.string().min(1),
      affected_rows: z.number().int().nonnegative(),
    }),
  ),
});
export type CleanResult = z.infer<typeof CleanResultSchema>;

export const VerifyRequestSchema = z.object({
  data_ref: DataRefSchema,
  rules: z.array(CleanRuleSchema),
  as_of: IsoDatetimeSchema.nullable(),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const VerifyFailureSchema = z.object({
  rule_id: z.string().min(1),
  message: z.string().min(1),
  /** 有限证据样本,单规则上限 20 条(§7 evidenceRowLimit 语义) */
  sample_values: z.array(z.unknown()).max(20),
});
export type VerifyFailure = z.infer<typeof VerifyFailureSchema>;

export const VerifyResultSchema = z.object({
  passed: z.boolean(),
  failures: z.array(VerifyFailureSchema),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export interface QualityPort {
  profile(input: ProfileRequest): Promise<ProfileResult>;
  clean(input: CleanRequest): Promise<CleanResult>;
  verify(input: VerifyRequest): Promise<VerifyResult>;
}

// ------------------------------ DatabasePort -------------------------------

export const ConnectionTestSchema = z.object({
  ok: z.boolean(),
  driver: z.string().min(1),
  message: z.string().nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
});
export type ConnectionTest = z.infer<typeof ConnectionTestSchema>;

export const CatalogSnapshotSchema = z.object({
  source_id: UuidSchema,
  schemas: z.array(
    z.object({
      name: z.string().min(1),
      tables: z.array(
        z.object({
          name: z.string().min(1),
          columns: z.array(
            z.object({
              name: z.string().min(1),
              type: z.string().min(1),
              nullable: z.boolean(),
            }),
          ),
        }),
      ),
    }),
  ),
  truncated: z.boolean(),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

export const QueryRequestSchema = z.object({
  source_id: UuidSchema,
  sql: z.string().min(1),
  params: z.array(z.unknown()),
  max_rows: z.number().int().positive(),
  max_bytes: z.number().int().positive(),
  timeout_seconds: z.number().int().positive(),
  idempotency_key: z.string().min(1).nullable(),
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

export const QueryResultRefSchema = z.object({
  data_ref: DataRefSchema,
  statement: z.string().min(1),
  truncated: z.boolean(),
  rows_fetched: z.number().int().nonnegative(),
});
export type QueryResultRef = z.infer<typeof QueryResultRefSchema>;

export interface DatabasePort {
  testConnection(sourceId: string): Promise<ConnectionTest>;
  describe(sourceId: string): Promise<CatalogSnapshot>;
  query(input: QueryRequest): Promise<QueryResultRef>;
}
