import { ModelProbeCheckSchema, ModelProbeResultSchema } from '@data-analyst/contracts';
import type {
  ModelProbeCheck,
  ModelProbeResult,
  ModelProbeStatus,
  ModelProfile,
} from '@data-analyst/contracts';
import { modelConfigHash } from './model-profiles.js';
import { OpenAiChatClient } from './model-client.js';

// ---------------------------------------------------------------------------
// §10 配置生效与模型能力测试:分层检查 network → auth → chat → streaming →
// tool_calling。GET /models 是可选检查,未提供时直接对配置 model 进行最小
// 生成测试。工具测试使用无副作用的固定示例工具,只验证格式与基本选择能力。
// 探测结果不含凭据;failed 的 required 能力禁止启动 Agent(由 API 层强制)。
// ---------------------------------------------------------------------------

const PROBE_TOOL = {
  name: 'probe_ping',
  description: '无副作用的固定示例工具,仅用于验证工具调用协议格式。',
  parameters: { type: 'object', properties: {}, required: [] as string[] },
} as const;

export interface ProbeInput {
  profile: ModelProfile;
  /** 由 ModelProfileService.resolveCredential 解析;探测层不持久化 */
  credential: string | null;
  client?: OpenAiChatClient;
}

type CheckDraft = {
  check: ModelProbeCheck['check'];
  status: ModelProbeStatus;
  message: string | null;
  latency_ms: number | null;
};

function failPayloadCode(error: unknown): { code: string; status?: number } | null {
  if (error && typeof error === 'object' && 'payload' in error) {
    const payload = (
      error as { payload: { code: string; details: Record<string, unknown> | null } }
    ).payload;
    const status = payload.details?.status;
    return { code: payload.code, status: typeof status === 'number' ? status : undefined };
  }
  return null;
}

/**
 * 分层探测 ModelProfile。任一层明确失败后,后续层标记 unknown(不假装支持)。
 * capability=disabled 的层不做网络请求,标记 disabled(§10)。
 */
export async function probeModelProfile(input: ProbeInput): Promise<ModelProbeResult> {
  const { profile, credential } = input;
  const client = input.client ?? new OpenAiChatClient();
  const checks: CheckDraft[] = [];

  const minimalRequest = {
    base_url: profile.base_url,
    model: profile.model,
    messages: [
      { role: 'user' as const, content: '回复 OK', tool_call_id: null, tool_calls: null },
    ],
    tools: null,
    temperature: profile.temperature ?? 0,
    max_output_tokens: 16,
    extra_body: {},
    connect_timeout_ms: profile.connect_timeout_ms ?? 10_000,
    response_timeout_ms: profile.response_timeout_ms ?? 120_000,
    stream_idle_timeout_ms: profile.stream_idle_timeout_ms ?? 60_000,
  };

  // ---- layer 1+2+3:network / auth / chat(一次最小生成联合判定) ----
  let chatReachable = false;
  let authOk = false;
  const started = Date.now();
  try {
    await client.complete(minimalRequest, credential);
    chatReachable = true;
    authOk = true;
    const latency = Date.now() - started;
    checks.push({ check: 'network', status: 'passed', message: null, latency_ms: latency });
    checks.push({ check: 'auth', status: 'passed', message: null, latency_ms: latency });
    checks.push({ check: 'chat', status: 'passed', message: null, latency_ms: latency });
  } catch (error) {
    const info = failPayloadCode(error);
    const message = error instanceof Error ? error.message.slice(0, 500) : '探测失败';
    if (info === null || info.code === 'MODEL_UNAVAILABLE' || info.code === 'TIMEOUT') {
      checks.push({
        check: 'network',
        status: 'failed',
        message,
        latency_ms: Date.now() - started,
      });
      checks.push({ check: 'auth', status: 'unknown', message: '网络不可达,无法验证认证', latency_ms: null });
      checks.push({ check: 'chat', status: 'unknown', message: '网络不可达,未执行最小生成', latency_ms: null });
    } else if (info.code === 'RATE_LIMITED') {
      // 网络与认证可达,但无法完成最小生成
      checks.push({ check: 'network', status: 'passed', message: null, latency_ms: Date.now() - started });
      checks.push({ check: 'auth', status: 'passed', message: null, latency_ms: Date.now() - started });
      checks.push({
        check: 'chat',
        status: 'failed',
        message: '模型服务限流',
        latency_ms: Date.now() - started,
      });
    } else if (info.status === 401 || info.status === 403) {
      checks.push({ check: 'network', status: 'passed', message: null, latency_ms: Date.now() - started });
      checks.push({ check: 'auth', status: 'failed', message, latency_ms: Date.now() - started });
      checks.push({ check: 'chat', status: 'unknown', message: '认证失败,未执行最小生成', latency_ms: null });
    } else {
      // 其他 4xx:请求被服务端拒绝;网络可达,认证无法确认
      checks.push({ check: 'network', status: 'passed', message: null, latency_ms: Date.now() - started });
      checks.push({
        check: 'auth',
        status: 'unknown',
        message: '服务端拒绝请求,认证状态无法确认',
        latency_ms: null,
      });
      checks.push({ check: 'chat', status: 'failed', message, latency_ms: Date.now() - started });
    }
  }

  // ---- layer 4:streaming ----
  if (profile.capabilities.streaming === 'disabled') {
    checks.push({ check: 'streaming', status: 'disabled', message: '管理员关闭该能力', latency_ms: null });
  } else if (!chatReachable || !authOk) {
    checks.push({ check: 'streaming', status: 'unknown', message: '前序检查未通过', latency_ms: null });
  } else {
    const streamStarted = Date.now();
    try {
      let sawDelta = false;
      let completed = false;
      let interrupted = false;
      for await (const event of client.stream(
        { ...minimalRequest, max_output_tokens: 16 },
        credential,
      )) {
        if (event.type === 'text_delta' || event.type === 'tool_call') sawDelta = true;
        if (event.type === 'done') completed = true;
        if (event.type === 'interrupted') interrupted = true;
      }
      if (sawDelta && completed) {
        checks.push({
          check: 'streaming',
          status: 'passed',
          message: null,
          latency_ms: Date.now() - streamStarted,
        });
      } else {
        checks.push({
          check: 'streaming',
          status: 'failed',
          message: interrupted ? '流式中断' : '流式未正常结束',
          latency_ms: Date.now() - streamStarted,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : '流式探测失败';
      checks.push({
        check: 'streaming',
        status: 'failed',
        message,
        latency_ms: Date.now() - streamStarted,
      });
    }
  }

  // ---- layer 5:tool_calling ----
  if (profile.capabilities.tool_calling === 'disabled') {
    checks.push({ check: 'tool_calling', status: 'disabled', message: '管理员关闭该能力', latency_ms: null });
  } else if (!chatReachable || !authOk) {
    checks.push({ check: 'tool_calling', status: 'unknown', message: '前序检查未通过', latency_ms: null });
  } else {
    const toolStarted = Date.now();
    try {
      const result = await client.complete(
        {
          ...minimalRequest,
          messages: [
            {
              role: 'user' as const,
              content: '请调用 probe_ping 工具完成能力探测。',
              tool_call_id: null,
              tool_calls: null,
            },
          ],
          tools: [
            {
              name: PROBE_TOOL.name,
              description: PROBE_TOOL.description,
              parameters: PROBE_TOOL.parameters,
            },
          ],
          max_output_tokens: 128,
        },
        credential,
      );
      const invoked = (result.message.tool_calls ?? []).some((c) => c.name === PROBE_TOOL.name);
      checks.push({
        check: 'tool_calling',
        status: 'passed',
        message: invoked
          ? null
          : '协议格式可用;模型未选择调用示例工具,仅验证基本能力',
        latency_ms: Date.now() - toolStarted,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : '工具调用探测失败';
      checks.push({
        check: 'tool_calling',
        status: 'failed',
        message,
        latency_ms: Date.now() - toolStarted,
      });
    }
  }

  const parsedChecks: ModelProbeCheck[] = checks.map((check) => ModelProbeCheckSchema.parse(check));
  const anyFailed = parsedChecks.some((check) => check.status === 'failed');
  const anyUnknown = parsedChecks.some((check) => check.status === 'unknown');
  const overall: ModelProbeStatus = anyFailed ? 'failed' : anyUnknown ? 'unknown' : 'passed';

  return ModelProbeResultSchema.parse({
    profile_id: profile.id,
    revision: profile.revision,
    status: overall,
    checks: parsedChecks,
    tested_at: new Date().toISOString(),
    config_hash: modelConfigHash({
      protocol: profile.protocol,
      base_url: profile.base_url,
      model: profile.model,
      credential_ref: profile.credential_ref,
      capabilities: profile.capabilities,
      connect_timeout_ms: profile.connect_timeout_ms ?? 10_000,
      response_timeout_ms: profile.response_timeout_ms ?? 120_000,
      stream_idle_timeout_ms: profile.stream_idle_timeout_ms ?? 60_000,
      temperature: profile.temperature ?? 0,
      max_output_tokens: profile.max_output_tokens ?? 8192,
      context_window_tokens: profile.context_window_tokens ?? 65_536,
      extra_body: profile.extra_body ?? {},
    }),
  });
}

/**
 * §10:required 能力未通过检查(非 passed)时禁止启动 Agent。
 * disabled 视为管理员显式关闭,不阻断。
 */
export function requiredCapabilitiesPassed(
  profile: ModelProfile,
  latestProbe: ModelProbeResult | null,
): { ok: boolean; reason: string | null } {
  const required: Array<{ name: 'streaming' | 'tool_calling' }> = [
    { name: 'streaming' },
    { name: 'tool_calling' },
  ];
  for (const capability of required) {
    if (profile.capabilities[capability.name] !== 'required') continue;
    const check = latestProbe?.checks.find((c) => c.check === capability.name);
    if (!check || check.status !== 'passed') {
      return {
        ok: false,
        reason: `required 能力 ${capability.name} 未通过检查(状态: ${check?.status ?? 'unknown'})`,
      };
    }
  }
  return { ok: true, reason: null };
}
