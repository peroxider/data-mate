import { z } from 'zod';
import { UuidSchema, IsoDatetimeSchema } from './ids.js';
import { CapabilityLevelSchema } from './entities.js';
import { CredentialRefSchema } from './config.js';

// ---------------------------------------------------------------------------
// §10 模型服务:能力探测(probe)与归一化调用(ModelInvocationPort)的契约类型。
// 探测状态 passed/failed/unknown/disabled —— required 能力缺失时禁止启动 Agent。
// 调用事件中,工具调用片段由适配层按 call_id+index 聚合,
// 仅当参数 JSON 完整可解析后才以 tool_call 事件交付(§10)。
// ---------------------------------------------------------------------------

/** §10 检测状态。unknown 表示未测试或无法确认,不假装支持。 */
export const ModelProbeStatusSchema = z.enum(['passed', 'failed', 'unknown', 'disabled']);
export type ModelProbeStatus = z.infer<typeof ModelProbeStatusSchema>;

/** 分层检查顺序:network → auth → chat → streaming → tool_calling(§10)。 */
export const ModelProbeCheckKindSchema = z.enum([
  'network',
  'auth',
  'chat',
  'streaming',
  'tool_calling',
]);
export type ModelProbeCheckKind = z.infer<typeof ModelProbeCheckKindSchema>;

export const ModelProbeCheckSchema = z.object({
  check: ModelProbeCheckKindSchema,
  status: ModelProbeStatusSchema,
  /** 可定位原因;不含凭据、完整请求体或未过滤数据样本 */
  message: z.string().max(2000).nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
});
export type ModelProbeCheck = z.infer<typeof ModelProbeCheckSchema>;

export const ModelProbeResultSchema = z.object({
  profile_id: z.string().min(1).nullable(),
  revision: z.number().int().positive().nullable(),
  /** 汇总状态:任一 required 能力 failed → failed;全部通过 → passed */
  status: ModelProbeStatusSchema,
  checks: z.array(ModelProbeCheckSchema),
  tested_at: IsoDatetimeSchema,
  /** 不含秘密的配置哈希,用于关联探测结果与具体配置内容 */
  config_hash: z.string().length(64),
});
export type ModelProbeResult = z.infer<typeof ModelProbeResultSchema>;

// ------------------------------ 消息与调用 ----------------------------------

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatToolCallSchema = z.object({
  call_id: z.string().min(1),
  name: z.string().min(1),
  /** 完整参数 JSON 文本;适配层仅在 JSON 可解析后交付 */
  arguments_json: z.string(),
});
export type ChatToolCall = z.infer<typeof ChatToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().nullable(),
  tool_call_id: z.string().min(1).nullable(),
  tool_calls: z.array(ChatToolCallSchema).nullable(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema 对象 */
  parameters: z.record(z.string(), z.unknown()),
});
export type ChatToolDefinition = z.infer<typeof ChatToolDefinitionSchema>;

export const ModelCompleteRequestSchema = z.object({
  base_url: z.url(),
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  tools: z.array(ChatToolDefinitionSchema).nullable(),
  temperature: z.number().min(0).max(2),
  max_output_tokens: z.number().int().min(1),
  extra_body: z.record(z.string(), z.unknown()),
  connect_timeout_ms: z.number().int().min(1000),
  response_timeout_ms: z.number().int().min(1000),
  stream_idle_timeout_ms: z.number().int().min(1000),
});
export type ModelCompleteRequest = z.infer<typeof ModelCompleteRequestSchema>;

export const ModelCompleteResultSchema = z.object({
  message: ChatMessageSchema,
  finish_reason: z.string().nullable(),
});
export type ModelCompleteResult = z.infer<typeof ModelCompleteResultSchema>;

/** 流式事件:文本增量 / 聚合完成的工具调用 / 中断(保留已收内容) / 结束。 */
export const ModelStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    call: ChatToolCallSchema,
  }),
  z.object({
    type: z.literal('interrupted'),
    reason: z.string().max(500),
    /** §10:开始返回流式内容后断线,本轮标记 interrupted 并保留已收到内容 */
    text_so_far: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    finish_reason: z.string().nullable(),
  }),
]);
export type ModelStreamEvent = z.infer<typeof ModelStreamEventSchema>;

/**
 * §10 ModelInvocationPort:对模型能力的归一化。首版协议为 openai-chat;
 * DSH 适配实现应委托其原生 Completion/Provider 调用层,而非再次启动 Agent Turn。
 * 凭据由服务端解析 credential_ref,绝不作为本端口参数出现。
 * options.signal 为调用方可选的取消信号(§12 取消语义),不进入 wire 请求。
 */
export interface ModelInvocationPort {
  complete(
    request: ModelCompleteRequest,
    credential: string | null,
    options?: { signal?: AbortSignal },
  ): Promise<ModelCompleteResult>;
  stream(
    request: ModelCompleteRequest,
    credential: string | null,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<ModelStreamEvent>;
}

// --------------------------- §17 REST API 载荷 ------------------------------

/** PUT /api/v1/model-profiles/{id} 请求体;expected_revision 控制并发冲突。 */
export const ModelProfileUpdateSchema = z.object({
  expected_revision: z.number().int().positive().nullable(),
  protocol: z.literal('openai-chat'),
  base_url: z.url(),
  model: z.string().min(1),
  credential_ref: CredentialRefSchema,
  capabilities: z.object({
    streaming: CapabilityLevelSchema,
    tool_calling: CapabilityLevelSchema,
    vision: CapabilityLevelSchema,
  }),
  connect_timeout_ms: z.number().int().min(1000),
  response_timeout_ms: z.number().int().min(1000),
  stream_idle_timeout_ms: z.number().int().min(1000),
  temperature: z.number().min(0).max(2),
  max_output_tokens: z.number().int().min(1),
  context_window_tokens: z.number().int().min(1024),
  extra_body: z.record(z.string(), z.unknown()),
});
export type ModelProfileUpdate = z.infer<typeof ModelProfileUpdateSchema>;

/** POST /api/v1/sessions/{id}/runs 请求体(§17 分析请求)。 */
export const RunSubmissionSchema = z.object({
  message: z.string().min(1),
  data_refs: z.array(z.string().min(1)).default([]),
  model_profile_id: UuidSchema.nullable().default(null),
  expected_model_revision: z.number().int().positive().nullable().default(null),
  options: z.record(z.string(), z.unknown()).default({}),
});
export type RunSubmission = z.infer<typeof RunSubmissionSchema>;

/** §17 事件流类型;SSE 在同一 Run 下使用单调 seq,携带 Last-Event-ID 可重连。 */
export const RunStreamEventTypeSchema = z.enum([
  'run.status',
  'tool.started',
  'tool.completed',
  'cell.output',
  'artifact.ready',
  'run.completed',
]);
export type RunStreamEventType = z.infer<typeof RunStreamEventTypeSchema>;

export const RunStreamEventSchema = z.object({
  event_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  workspace_id: UuidSchema.nullable(),
  session_id: UuidSchema.nullable(),
  run_id: UuidSchema.nullable(),
  type: RunStreamEventTypeSchema,
  at: IsoDatetimeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type RunStreamEvent = z.infer<typeof RunStreamEventSchema>;
