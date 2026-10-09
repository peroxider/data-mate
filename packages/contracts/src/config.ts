import { z } from 'zod';
import { CapabilityLevelSchema } from './entities.js';

// ---------------------------------------------------------------------------
// §18 产品配置 Schema。未知字段或非法范围在启动时 → CONFIG_INVALID。
// 相对路径以配置文件所在目录解析(由 core 加载器实现,本文件只定义形状)。
// ---------------------------------------------------------------------------

/** §18 credential_ref:env:NAME、file:PATH、svc:ID,无凭据 Endpoint 显式 none(可带标记 none:xxx)。 */
export const CredentialRefSchema = z
  .string()
  .regex(
    /^(env|file|svc):.+$|^none(:[A-Za-z0-9._-]+)?$/,
    'credential_ref must be env:NAME, file:PATH, svc:ID or none[:MARKER]',
  );
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

export const ServerConfigSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  public_base_url: z.url().optional(),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const AuthConfigSchema = z.strictObject({
  mode: z.literal('local-token'),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const PathsConfigSchema = z.strictObject({
  data_dir: z.string().min(1),
  state_dir: z.string().min(1),
  cache_dir: z.string().min(1),
  runtime_dir: z.string().min(1).optional(),
});
export type PathsConfig = z.infer<typeof PathsConfigSchema>;

export const RuntimeConfigSchema = z.strictObject({
  profile: z.string().min(1),
  python: z.string().min(1),
  compute_device: z.enum(['cpu']),
  max_active_kernels: z.number().int().min(1).max(16),
  idle_kernel_timeout_seconds: z.number().int().min(60),
  cell_timeout_seconds: z.number().int().min(1),
  interrupt_grace_seconds: z.number().int().min(1).max(120),
  max_cell_output_mib: z.number().int().min(1),
  /** §13 Agent 多轮回路轮次上限;耗尽 → Run failed */
  agent_max_turns: z.number().int().min(1).max(50).default(12),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const DataLimitsConfigSchema = z.strictObject({
  max_upload_mib: z.number().int().min(1),
  preview_rows: z.number().int().min(1).max(500),
  model_sample_rows: z.number().int().min(1),
  model_sample_cell_chars: z.number().int().min(1),
  quality_ts_max_mib: z.number().int().min(1),
  quality_ts_max_rows: z.number().int().min(1),
});
export type DataLimitsConfig = z.infer<typeof DataLimitsConfigSchema>;

export const DatabaseConfigSchema = z.strictObject({
  readonly: z.literal(true),
  statement_timeout_seconds: z.number().int().min(1),
  max_result_rows: z.number().int().min(1),
  max_result_mib: z.number().int().min(1),
});
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export const ModelConfigSchema = z.strictObject({
  profile_id: z.string().min(1),
  protocol: z.literal('openai-chat'),
  base_url: z.url(),
  model: z.string().min(1),
  credential_ref: CredentialRefSchema,
  connect_timeout_ms: z.number().int().min(1000),
  response_timeout_ms: z.number().int().min(1000),
  stream_idle_timeout_ms: z.number().int().min(1000),
  temperature: z.number().min(0).max(2),
  max_output_tokens: z.number().int().min(1),
  context_window_tokens: z.number().int().min(1024),
  capabilities: z.strictObject({
    streaming: CapabilityLevelSchema,
    tool_calling: CapabilityLevelSchema,
    vision: CapabilityLevelSchema,
  }),
  /** 不得覆盖 model/messages/tools/stream 或认证字段;冲突在保存时拒绝(core 层校验) */
  extra_body: z.record(z.string(), z.unknown()),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const NetworkConfigSchema = z.strictObject({
  mode: z.enum(['intranet']),
  allowed_model_endpoints: z.array(z.url()),
  internet_runtime_downloads: z.literal(false),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

export const LoggingConfigSchema = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  structured: z.boolean(),
  store_data_samples: z.literal(false),
});
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const ProductConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  server: ServerConfigSchema,
  auth: AuthConfigSchema,
  paths: PathsConfigSchema,
  runtime: RuntimeConfigSchema,
  data: DataLimitsConfigSchema,
  database: DatabaseConfigSchema,
  /** §18:model 块仅在对应 profile 不存在时导入为初始配置;权威来源为 SQLite 中的 ModelProfile */
  model: ModelConfigSchema.optional(),
  network: NetworkConfigSchema,
  logging: LoggingConfigSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;
