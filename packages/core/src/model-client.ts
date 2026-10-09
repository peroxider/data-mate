import {
  AnalystError,
  ChatMessageSchema,
  ModelCompleteResultSchema,
} from '@data-analyst/contracts';
import type {
  ChatMessage,
  ChatToolCall,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelInvocationPort,
  ModelStreamEvent,
} from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §10 openai-chat 协议适配器(Chat Completions + 流式 + 工具调用)。
// - 重试:连接失败/5xx/429 至多 2 次有界重试并尊重 Retry-After;
//   请求字段错误(4xx)与上下文超限不重试。
// - 流式:按 index 聚合工具调用片段,参数 JSON 完整后才交付;
//   开始返回内容后断线/空闲超时 → interrupted,保留已收内容。
// - 凭据仅作为 Authorization 头发送,绝不进入错误消息、日志或事件。
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5_000;

function err(
  code: AnalystError['payload']['code'],
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown> } = {},
): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: null,
    run_id: null,
    retryable: options.retryable ?? false,
    details: options.details ?? null,
  });
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

interface ChatApiToolCallFragment {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatApiResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ChatApiToolCallFragment[];
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; type?: string };
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_WAIT_MS);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function buildRequestBody(
  request: ModelCompleteRequest,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => {
      const wire: Record<string, unknown> = { role: message.role };
      if (message.content !== null) wire.content = message.content;
      if (message.tool_call_id !== null) wire.tool_call_id = message.tool_call_id;
      if (message.tool_calls !== null) {
        wire.tool_calls = message.tool_calls.map((call) => ({
          id: call.call_id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments_json },
        }));
      }
      return wire;
    }),
    temperature: request.temperature,
    max_tokens: request.max_output_tokens,
    stream,
  };
  if (request.tools !== null) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  return { ...body, ...request.extra_body };
}

function toolCallFromFragment(call: ChatApiToolCallFragment): ChatToolCall | null {
  const callId = call.id;
  const name = call.function?.name;
  const args = call.function?.arguments ?? '';
  if (!callId || !name) return null;
  const json = args.trim() === '' ? '{}' : args;
  try {
    JSON.parse(json);
  } catch {
    return null;
  }
  return { call_id: callId, name, arguments_json: json };
}

interface ToolFragmentSlot {
  id: string | null;
  name: string | null;
  args: string;
}

/** 流结束/中断前,交付已聚合完整且参数 JSON 可解析的工具调用(§10)。 */
function* drainToolCalls(
  fragments: Map<number, ToolFragmentSlot>,
  emittedCallIds: Set<string>,
): Generator<ModelStreamEvent> {
  const indices = [...fragments.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    const slot = fragments.get(index);
    if (!slot?.id || !slot.name) continue;
    if (emittedCallIds.has(slot.id)) continue;
    const args = slot.args.trim() === '' ? '{}' : slot.args;
    try {
      JSON.parse(args);
    } catch {
      continue;
    }
    emittedCallIds.add(slot.id);
    yield { type: 'tool_call', call: { call_id: slot.id, name: slot.name, arguments_json: args } };
  }
  fragments.clear();
}

export interface OpenAiChatClientOptions {
  /** 测试注入:替代全局 fetch */
  fetchImpl?: typeof fetch;
}

export class OpenAiChatClient implements ModelInvocationPort {
  readonly #fetchImpl: typeof fetch;

  constructor(options: OpenAiChatClientOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(
    request: ModelCompleteRequest,
    credential: string | null,
  ): Promise<ModelCompleteResult> {
    const url = endpointUrl(request.base_url, '/chat/completions');
    const body = JSON.stringify(buildRequestBody(request, false));

    let lastError: AnalystError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetchImpl(url, {
          method: 'POST',
          headers: this.#headers(credential),
          body,
          signal: AbortSignal.timeout(request.response_timeout_ms),
        });
      } catch (cause) {
        lastError = this.#networkError(cause, request);
        if (attempt < MAX_RETRIES) {
          await sleep(200 * (attempt + 1));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        const payload = (await response.json()) as ChatApiResponse;
        return this.#parseCompleteResponse(payload);
      }

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const detail = await this.#safeErrorDetail(response, credential);
      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        await sleep(retryAfter ?? 200 * (attempt + 1));
        continue;
      }
      throw this.#httpError(response.status, detail);
    }
    throw lastError ?? err('MODEL_UNAVAILABLE', '模型请求失败', { retryable: true });
  }

  async *stream(
    request: ModelCompleteRequest,
    credential: string | null,
  ): AsyncIterable<ModelStreamEvent> {
    const url = endpointUrl(request.base_url, '/chat/completions');
    const body = JSON.stringify(buildRequestBody(request, true));

    // 连接阶段(未收到任何字节)允许有界重试;已开始接收后断线 → interrupted(§10)。
    let response: Response | null = null;
    let lastError: AnalystError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const candidate = await this.#fetchImpl(url, {
          method: 'POST',
          headers: this.#headers(credential),
          body,
          signal: AbortSignal.timeout(request.response_timeout_ms),
        });
        if (candidate.ok) {
          response = candidate;
          break;
        }
        const detail = await this.#safeErrorDetail(candidate, credential);
        if (isRetryableStatus(candidate.status) && attempt < MAX_RETRIES) {
          await sleep(parseRetryAfter(candidate.headers.get('retry-after')) ?? 200 * (attempt + 1));
          continue;
        }
        throw this.#httpError(candidate.status, detail);
      } catch (cause) {
        // 4xx 等明确拒绝不盲目重试(§10);仅连接类错误参与有界重试
        if (cause instanceof AnalystError) throw cause;
        lastError = this.#networkError(cause, request);
        if (attempt >= MAX_RETRIES) throw lastError;
        await sleep(200 * (attempt + 1));
      }
    }
    if (!response || !response.body) {
      throw lastError ?? err('MODEL_UNAVAILABLE', '模型流不可用', { retryable: true });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const fragments = new Map<number, ToolFragmentSlot>();
    const emittedCallIds = new Set<string>();
    let textSoFar = '';
    let buffer = '';
    let finished = false;
    let idleDeadline = Date.now() + request.stream_idle_timeout_ms;

    try {
      while (!finished) {
        const remaining = idleDeadline - Date.now();
        if (remaining <= 0) {
          void reader.cancel().catch(() => undefined);
          yield* drainToolCalls(fragments, emittedCallIds);
          yield { type: 'interrupted', reason: 'stream_idle_timeout', text_so_far: textSoFar };
          return;
        }
        const readResult = await Promise.race([
          reader.read(),
          new Promise<null>((resolveRace) => {
            setTimeout(() => resolveRace(null), remaining).unref();
          }),
        ]);
        if (readResult === null) {
          void reader.cancel().catch(() => undefined);
          yield* drainToolCalls(fragments, emittedCallIds);
          yield { type: 'interrupted', reason: 'stream_idle_timeout', text_so_far: textSoFar };
          return;
        }
        if (readResult.done) break;
        idleDeadline = Date.now() + request.stream_idle_timeout_ms;
        buffer += decoder.decode(readResult.value, { stream: true });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');

          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            finished = true;
            break;
          }
          let chunk: {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: ChatApiToolCallFragment[];
              };
              finish_reason?: string | null;
            }>;
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.delta?.content) {
            textSoFar += choice.delta.content;
            yield { type: 'text_delta', text: choice.delta.content };
          }
          if (choice.delta?.tool_calls) {
            for (const fragment of choice.delta.tool_calls) {
              const index = fragment.index ?? 0;
              const slot = fragments.get(index) ?? { id: null, name: null, args: '' };
              if (fragment.id) slot.id = fragment.id;
              if (fragment.function?.name) slot.name = fragment.function.name;
              if (fragment.function?.arguments) slot.args += fragment.function.arguments;
              fragments.set(index, slot);
            }
          }
          if (choice.finish_reason) {
            finished = true;
            break;
          }
        }
      }
    } catch (cause) {
      void reader.cancel().catch(() => undefined);
      yield* drainToolCalls(fragments, emittedCallIds);
      const reason =
        cause instanceof Error && cause.name === 'TimeoutError'
          ? 'response_timeout'
          : cause instanceof Error
            ? `stream_disconnected: ${cause.message.slice(0, 200)}`
            : 'stream_disconnected';
      yield { type: 'interrupted', reason, text_so_far: textSoFar };
      return;
    }

    yield* drainToolCalls(fragments, emittedCallIds);
    yield { type: 'done', finish_reason: null };
  }

  // ------------------------------ 内部实现 -----------------------------------

  #headers(credential: string | null): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credential !== null) {
      headers.authorization = `Bearer ${credential}`;
    }
    return headers;
  }

  #networkError(cause: unknown, request: ModelCompleteRequest): AnalystError {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      return err('TIMEOUT', `模型响应超时(${request.response_timeout_ms}ms)`, { retryable: true });
    }
    return err('MODEL_UNAVAILABLE', '无法连接模型服务', { retryable: true });
  }

  #httpError(status: number, detail: string | null): AnalystError {
    if (status === 429) {
      return err('RATE_LIMITED', '模型服务限流', { retryable: true, details: { status } });
    }
    if (status >= 500) {
      return err('MODEL_UNAVAILABLE', `模型服务错误(status=${status})`, {
        retryable: true,
        details: { status },
      });
    }
    // 4xx:请求字段错误/上下文超限,不盲目重试(§10)
    return err(
      'UNPROCESSABLE',
      detail ? `模型拒绝请求: ${detail.slice(0, 500)}` : '模型拒绝请求',
      { details: { status } },
    );
  }

  /**
   * 读取错误响应体摘要;凭据可能被对方回显进错误消息,输出前先屏蔽(§10:秘密绝不进入错误)。
   */
  async #safeErrorDetail(response: Response, credential: string | null): Promise<string | null> {
    try {
      const text = await response.text();
      const scrub = (value: string): string =>
        credential === null ? value : value.split(credential).join('[已屏蔽]');
      try {
        const parsed = JSON.parse(text) as ChatApiResponse;
        return scrub(parsed.error?.message ?? text.slice(0, 500)).slice(0, 500);
      } catch {
        return scrub(text).slice(0, 500);
      }
    } catch {
      return null;
    }
  }

  #parseCompleteResponse(payload: ChatApiResponse): ModelCompleteResult {
    const choice = payload.choices?.[0];
    const apiMessage = choice?.message;
    if (!apiMessage) {
      throw err('MODEL_UNAVAILABLE', '模型响应缺少 message 字段', { retryable: false });
    }
    const toolCalls: ChatToolCall[] = [];
    for (const fragment of apiMessage.tool_calls ?? []) {
      const call = toolCallFromFragment(fragment);
      if (call) toolCalls.push(call);
    }
    const message: ChatMessage = ChatMessageSchema.parse({
      role: apiMessage.role ?? 'assistant',
      content: apiMessage.content ?? null,
      tool_call_id: null,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
    });
    return ModelCompleteResultSchema.parse({
      message,
      finish_reason: choice?.finish_reason ?? null,
    });
  }
}
