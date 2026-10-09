import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  AnalystError,
  RunSubmissionSchema,
  ModelProfileUpdateSchema,
  httpStatusFor,
  newId,
} from '@data-analyst/contracts';
import type {
  AnalysisRun,
  Artifact,
  ModelProbeResult,
  ModelProfile,
  RunStreamEvent,
  RunStreamEventType,
  ProductConfig,
} from '@data-analyst/contracts';
import type { RepositoryPort } from './repository.js';
import type { RunGovernor } from './run-governance.js';
import type { ModelProfileService } from './model-profiles.js';
import { requiredCapabilitiesPassed, probeModelProfile } from './model-probe.js';
import { OpenAiChatClient } from './model-client.js';

// ---------------------------------------------------------------------------
// §17 REST API(/api/v1)。node:http 实现,无框架依赖。
// - 统一错误结构 AnalystError + httpStatusFor;错误 details 不含秘密/完整请求。
// - local-token Bearer 认证:/api/v1/* 与 /readyz 受保护,/healthz 仅活性。
// - 模型配置:PUT 携带 expected_revision 冲突控制;test 关联 revision;
//   required 能力未通过时拒绝创建表面 running 的 Run(§17/§10)。
// - SSE:/api/v1/runs/{id}/events 单调 seq,持久化状态/产物事件,
//   Last-Event-ID 重连;超出保留范围时返回恢复标记,不承诺无限重放。
// ---------------------------------------------------------------------------

const STREAM_BUFFER_LIMIT = 1000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface ApiServerOptions {
  config: ProductConfig;
  repository: RepositoryPort;
  runGovernor: RunGovernor;
  modelProfiles: ModelProfileService;
  /** 受控启动流程生成的本地令牌;/api/v1/* 必需 Bearer 认证(§18) */
  token: string;
  /** 产物文件解析根;缺省时 download 端点返回 NOT_FOUND */
  artifactsRoot?: string;
  version?: string;
  client?: OpenAiChatClient;
  /** 状态变更回调(如 model profile 保存后落盘快照) */
  onStateChange?: () => Promise<void>;
}

interface RunChannel {
  events: RunStreamEvent[];
  /** 缓冲区内最早的 seq(超出即视为超出保留范围) */
  bufferStartSeq: number;
  nextSeq: number;
  subscribers: Set<ServerResponse>;
}

function err(
  code: AnalystError['payload']['code'],
  message: string,
  details?: Record<string, unknown>,
): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: details ?? null,
  });
}

export class ApiServer {
  readonly #options: ApiServerOptions;
  readonly #server: Server;
  readonly #channels = new Map<string, RunChannel>();
  readonly #latestProbes = new Map<string, ModelProbeResult>();
  readonly #client: OpenAiChatClient;

  constructor(options: ApiServerOptions) {
    this.#options = options;
    this.#client = options.client ?? new OpenAiChatClient();
    this.#server = createServer((req, res) => {
      void this.#dispatch(req, res);
    });
    // 客户端断开不应使进程崩溃
    this.#server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  }

  /** 启动监听；portOverride 供测试/命令行临时覆盖配置端口（0=内核临时分配）。 */
  async start(portOverride?: number): Promise<void> {
    const host = this.#options.config.server.host;
    const port = portOverride ?? this.#options.config.server.port;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(port, host);
    });
  }

  async stop(): Promise<void> {
    for (const channel of this.#channels.values()) {
      for (const res of channel.subscribers) res.end();
      channel.subscribers.clear();
    }
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** 测试/运维读取实际监听端口。 */
  get address(): { host: string; port: number } | null {
    const addr = this.#server.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  // ------------------------------ 请求分发 -----------------------------------

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET' && path === '/healthz') {
        this.#json(res, 200, { status: 'ok' });
        return;
      }

      // §18:除 /healthz 外统一走同一认证边界
      this.#requireAuth(req);

      if (method === 'GET' && path === '/readyz') {
        await this.#handleReady(res);
        return;
      }

      if (!path.startsWith('/api/v1/')) {
        throw err('NOT_FOUND', `未知路径: ${path}`);
      }

      let matched: RegExpMatchArray | null;

      if (method === 'GET' && path === '/api/v1/capabilities') {
        this.#json(res, 200, {
          product: 'data-analyst',
          version: this.#options.version ?? '0.1.0-dev',
          schema_version: this.#options.config.schema_version,
          model_protocol: 'openai-chat',
          api: '/api/v1',
        });
        return;
      }

      if ((matched = path.match(/^\/api\/v1\/model-profiles\/([^/]+)$/))) {
        const profileId = decodeURIComponent(matched[1] ?? '');
        if (method === 'PUT') {
          const body = await this.#readJson(req);
          const update = ModelProfileUpdateSchema.parse(body);
          const profile = await this.#options.modelProfiles.save(profileId, update);
          if (this.#options.onStateChange) {
            await this.#options.onStateChange().catch(() => undefined);
          }
          this.#json(res, 200, this.#profileView(profile));
          return;
        }
        if (method === 'GET') {
          const profile = await this.#options.modelProfiles.get(profileId);
          if (!profile) throw err('NOT_FOUND', `ModelProfile 不存在: ${profileId}`);
          this.#json(res, 200, this.#profileView(profile));
          return;
        }
        throw err('UNPROCESSABLE', `不支持的方法: ${method}`);
      }

      if (
        (matched = path.match(/^\/api\/v1\/model-profiles\/([^/]+)\/test$/)) &&
        method === 'POST'
      ) {
        const profileId = decodeURIComponent(matched[1] ?? '');
        const profile = await this.#requireProfile(profileId);
        const credential = await this.#options.modelProfiles.resolveCredential(profile);
        const result = await probeModelProfile({ profile, credential, client: this.#client });
        this.#latestProbes.set(profileId, result);
        // 探测结果关联 revision(§17);不包含凭据
        this.#json(res, 200, result);
        return;
      }

      if ((matched = path.match(/^\/api\/v1\/sessions\/([^/]+)\/runs$/)) && method === 'POST') {
        const sessionId = decodeURIComponent(matched[1] ?? '');
        const body = await this.#readJson(req);
        const submission = RunSubmissionSchema.parse(body);
        const run = await this.#submitRun(sessionId, submission, req);
        this.#json(res, 202, {
          run_id: run.run.id,
          status: run.run.status,
          idempotent_replay: run.replayed,
        });
        return;
      }

      if ((matched = path.match(/^\/api\/v1\/runs\/([^/]+)$/)) && method === 'GET') {
        const runId = decodeURIComponent(matched[1] ?? '');
        const run = await this.#options.runGovernor.getRun(runId);
        this.#json(res, 200, this.#runView(run));
        return;
      }

      if ((matched = path.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/)) && method === 'POST') {
        const runId = decodeURIComponent(matched[1] ?? '');
        const { run } = await this.#options.runGovernor.cancelRun(runId);
        this.#json(res, 200, { run_id: run.id, status: run.status, confirmed: true });
        return;
      }

      if ((matched = path.match(/^\/api\/v1\/runs\/([^/]+)\/events$/)) && method === 'GET') {
        const runId = decodeURIComponent(matched[1] ?? '');
        await this.#options.runGovernor.getRun(runId);
        await this.#handleSse(req, res, runId);
        return;
      }

      if ((matched = path.match(/^\/api\/v1\/artifacts\/([^/]+)$/)) && method === 'GET') {
        const artifactId = decodeURIComponent(matched[1] ?? '');
        const artifact = await this.#options.repository.artifacts.get(artifactId);
        if (!artifact) throw err('NOT_FOUND', `产物不存在: ${artifactId}`);
        this.#json(res, 200, artifact);
        return;
      }

      if ((matched = path.match(/^\/api\/v1\/artifacts\/([^/]+)\/download$/)) && method === 'GET') {
        await this.#handleArtifactDownload(res, decodeURIComponent(matched[1] ?? ''));
        return;
      }

      throw err('NOT_FOUND', `未知路径: ${method} ${path}`);
    } catch (error) {
      this.#sendError(res, requestId, error);
    }
  }

  // ------------------------------ 认证与工具 ---------------------------------

  #requireAuth(req: IncomingMessage): void {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    const token = match?.[1] ?? '';
    const expected = this.#options.token;
    const given = createHash('sha256').update(token).digest('hex');
    const wanted = createHash('sha256').update(expected).digest('hex');
    if (!timingSafeEqualText(given, wanted)) {
      throw err('UNAUTHORIZED', '缺少或无效的 Bearer 令牌');
    }
  }

  async #handleReady(res: ServerResponse): Promise<void> {
    let storage = 'ok';
    try {
      await stat(this.#options.config.paths.state_dir);
    } catch {
      storage = 'state_dir_missing';
    }
    const profiles = await this.#options.modelProfiles.list();
    const modelStatuses = profiles.map((profile) => ({
      profile_id: profile.id,
      revision: profile.revision,
      probe: this.#latestProbes.get(profile.id)?.status ?? 'unknown',
    }));
    this.#json(res, 200, {
      ready: storage === 'ok',
      checks: {
        config: 'ok',
        storage,
      },
      model_profiles: modelStatuses,
    });
  }

  async #requireProfile(profileId: string): Promise<ModelProfile> {
    const profile = await this.#options.modelProfiles.get(profileId);
    if (!profile) throw err('NOT_FOUND', `ModelProfile 不存在: ${profileId}`);
    return profile;
  }

  async #submitRun(
    sessionId: string,
    submission: ReturnType<typeof RunSubmissionSchema.parse>,
    req: IncomingMessage,
  ): Promise<{ run: AnalysisRun; replayed: boolean }> {
    const session = await this.#options.repository.sessions.get(sessionId);
    if (!session) throw err('NOT_FOUND', `Session 不存在: ${sessionId}`);

    // DataRef 校验:启动 Agent 之前拒绝(§17)
    for (const refId of submission.data_refs) {
      const ref = await this.#options.repository.dataRefs.get(refId);
      if (!ref) throw err('UNPROCESSABLE', `DataRef 不存在: ${refId}`, { data_ref: refId });
      if (ref.workspace_id !== session.workspace_id) {
        throw err('UNPROCESSABLE', 'DataRef 属于其他 Workspace', { data_ref: refId });
      }
    }

    // 模型配置绑定与 revision 冲突控制
    if (submission.model_profile_id !== null) {
      const profile = await this.#requireProfile(submission.model_profile_id);
      if (
        submission.expected_model_revision !== null &&
        submission.expected_model_revision !== profile.revision
      ) {
        throw err('CONFLICT', '模型配置 revision 冲突,请读取最新配置后重试', {
          expected_revision: submission.expected_model_revision,
          current_revision: profile.revision,
        });
      }
      const probe = this.#latestProbes.get(submission.model_profile_id) ?? null;
      const gate = requiredCapabilitiesPassed(profile, probe);
      if (!gate.ok) {
        // 不创建表面 running 但永远无法工作的 Run(§17)
        throw err('UNPROCESSABLE', gate.reason ?? '模型必需能力未通过检查', {
          profile_id: profile.id,
        });
      }
    }

    // Idempotency-Key 重放:同 key+payload 返回原 Run;同 key 不同 payload → 409(§629)
    const idempotencyKey = req.headers['idempotency-key'];
    const payloadHash =
      typeof idempotencyKey === 'string' && idempotencyKey.length > 0
        ? createHash('sha256').update(JSON.stringify(submission)).digest('hex')
        : null;
    if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
      const runs = await this.#options.repository.runs.list();
      const existing = runs.find(
        (run) => run.idempotency_key === idempotencyKey && run.session_id === sessionId,
      );
      if (existing) {
        if (existing.payload_hash !== null && existing.payload_hash !== payloadHash) {
          throw err('CONFLICT', 'Idempotency-Key 已用于不同的请求负载,请更换幂等键', {
            run_id: existing.id,
          });
        }
        return { run: existing, replayed: true };
      }
    }

    const outcome = await this.#options.runGovernor.beginRun({
      session_id: sessionId,
      trigger: 'user_message',
      model_profile_id: submission.model_profile_id,
      idempotency_key: typeof idempotencyKey === 'string' ? idempotencyKey : null,
      payload_hash: payloadHash,
    });
    const run = outcome.run;

    this.#emitStreamEvent(run.session_id, run.id, 'run.status', {
      status: run.status,
      config_revision: run.config_revision,
    });

    if (!outcome.queued) {
      void this.#executeRun(run, submission).catch(() => undefined);
    }
    return { run, replayed: false };
  }

  /**
   * M5 最小执行回路:经 ModelInvocationPort 执行单次模型轮次,
   * 流式增量以 cell.output 事件发布。完整 Agent Turn 由 DSH 承接(§10)。
   */
  async #executeRun(run: AnalysisRun, submission: { message: string }): Promise<void> {
    try {
      if (run.model_profile_snapshot_id === null) {
        throw err('UNPROCESSABLE', 'Run 未绑定模型配置');
      }
      const snapshot = await this.#options.repository.modelProfiles.get(
        run.model_profile_snapshot_id,
      );
      if (!snapshot) throw err('NOT_FOUND', '模型配置快照不存在');
      const credential = await this.#options.modelProfiles.resolveCredential(snapshot);
      const request = {
        base_url: snapshot.base_url,
        model: snapshot.model,
        messages: [
          {
            role: 'user' as const,
            content: submission.message,
            tool_call_id: null,
            tool_calls: null,
          },
        ],
        tools: null,
        temperature: snapshot.temperature ?? 0,
        max_output_tokens: snapshot.max_output_tokens ?? 8192,
        extra_body: {},
        connect_timeout_ms: snapshot.connect_timeout_ms ?? 10_000,
        response_timeout_ms: snapshot.response_timeout_ms ?? 120_000,
        stream_idle_timeout_ms: snapshot.stream_idle_timeout_ms ?? 60_000,
      };

      let text = '';
      let terminal: 'completed' | 'interrupted' = 'completed';
      for await (const event of this.#client.stream(request, credential)) {
        const current = await this.#options.runGovernor.getRun(run.id);
        if (current.status !== 'running') {
          // 已被取消/中断:停止消费,旧输出不进入新 Run(§12)
          terminal = 'interrupted';
          break;
        }
        if (event.type === 'text_delta') {
          text += event.text;
          this.#emitStreamEvent(run.session_id, run.id, 'cell.output', { text: event.text });
        } else if (event.type === 'interrupted') {
          terminal = 'interrupted';
          break;
        } else if (event.type === 'done') {
          break;
        }
      }
      this.#emitStreamEvent(run.session_id, run.id, 'run.completed', {
        status: terminal,
        output_chars: text.length,
      });
      await this.#options.runGovernor.finishRun(run.id, terminal);
    } catch {
      this.#emitStreamEvent(run.session_id, run.id, 'run.completed', { status: 'failed' });
      await this.#options.runGovernor.finishRun(run.id, 'failed').catch(() => undefined);
    }
  }

  // ------------------------------ 事件流 -------------------------------------

  #channel(runId: string): RunChannel {
    let channel = this.#channels.get(runId);
    if (!channel) {
      channel = { events: [], bufferStartSeq: 0, nextSeq: 0, subscribers: new Set() };
      this.#channels.set(runId, channel);
    }
    return channel;
  }

  #emitStreamEvent(
    sessionId: string,
    runId: string,
    type: RunStreamEventType,
    payload: Record<string, unknown>,
  ): void {
    const channel = this.#channel(runId);
    const event: RunStreamEvent = {
      event_id: newId(),
      seq: channel.nextSeq,
      workspace_id: null,
      session_id: sessionId,
      run_id: runId,
      type,
      at: new Date().toISOString(),
      payload,
    };
    channel.nextSeq += 1;
    channel.events.push(event);
    if (channel.events.length > STREAM_BUFFER_LIMIT) {
      channel.events.shift();
      channel.bufferStartSeq = channel.events[0]?.seq ?? channel.nextSeq;
    }
    void this.#options.repository.runStreamEvents.put(event);
    const frame = this.#sseFrame(event);
    for (const res of channel.subscribers) res.write(frame);
  }

  #sseFrame(event: RunStreamEvent): string {
    return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  async #handleSse(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const channel = this.#channel(runId);
    if (channel.nextSeq === 0) {
      // 进程重启后内存缓冲为空:从持久化 runStreamEvents 恢复重放序列(§17 持久保存)
      const persisted = await this.#options.repository.runStreamEvents.list();
      const forRun = persisted
        .filter((event) => event.run_id === runId)
        .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      for (const event of forRun) {
        channel.events.push(event);
        channel.nextSeq = Math.max(channel.nextSeq, event.seq + 1);
      }
      if (channel.events.length > 0) {
        channel.bufferStartSeq = channel.events[0]?.seq ?? 0;
      }
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdHeader === 'string' && lastEventIdHeader !== ''
        ? Number(lastEventIdHeader)
        : null;

    if (lastEventId !== null && Number.isFinite(lastEventId) && lastEventId < channel.bufferStartSeq) {
      // 超出保留范围:恢复标记 + 当前状态,不承诺重放全部输出字节(§17)
      res.write(
        `event: recovery\ndata: ${JSON.stringify({
          run_id: runId,
          from_seq: channel.bufferStartSeq,
          message: '所请求的事件已超出保留范围',
        })}\n\n`,
      );
    } else if (lastEventId !== null && Number.isFinite(lastEventId)) {
      for (const event of channel.events) {
        if (event.seq > lastEventId) res.write(this.#sseFrame(event));
      }
    } else {
      for (const event of channel.events) res.write(this.#sseFrame(event));
    }

    channel.subscribers.add(res);
    res.on('close', () => {
      channel.subscribers.delete(res);
    });
  }

  // ------------------------------ 产物 ---------------------------------------

  async #handleArtifactDownload(res: ServerResponse, artifactId: string): Promise<void> {
    const artifact: Artifact | null = await this.#options.repository.artifacts.get(artifactId);
    if (!artifact) throw err('NOT_FOUND', `产物不存在: ${artifactId}`);
    const root = this.#options.artifactsRoot;
    if (!root) throw err('NOT_FOUND', '产物文件根未配置');
    if (artifact.state !== 'ready') {
      throw err('UNPROCESSABLE', `产物状态为 ${artifact.state},不可下载`, {
        state: artifact.state,
      });
    }
    // relative_path 仅在 Workspace 内作用:先按 workspace_id 定位其 Workspace 目录(§17)
    const base = resolve(root);
    const scope = artifact.workspace_id ? resolve(join(base, artifact.workspace_id)) : base;
    // 不接受用户拼接路径:解析后必须仍在作用域目录内(§17)
    const target = isAbsolute(artifact.relative_path)
      ? null
      : resolve(join(scope, artifact.relative_path));
    if (!target || !(target === scope || target.startsWith(scope + sep))) {
      throw err('UNPROCESSABLE', '非法产物路径');
    }
    try {
      await stat(target);
    } catch {
      throw err('NOT_FOUND', '产物文件缺失');
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(target).pipe(res);
  }

  // ------------------------------ 视图与序列化 --------------------------------

  #profileView(profile: ModelProfile): Record<string, unknown> {
    return {
      id: profile.id,
      revision: profile.revision,
      protocol: profile.protocol,
      base_url: profile.base_url,
      model: profile.model,
      credential_ref: profile.credential_ref,
      capabilities: profile.capabilities,
      config_hash: profile.config_hash,
      connect_timeout_ms: profile.connect_timeout_ms ?? null,
      response_timeout_ms: profile.response_timeout_ms ?? null,
      stream_idle_timeout_ms: profile.stream_idle_timeout_ms ?? null,
      temperature: profile.temperature ?? null,
      max_output_tokens: profile.max_output_tokens ?? null,
      context_window_tokens: profile.context_window_tokens ?? null,
      extra_body: profile.extra_body ?? {},
      created_at: profile.created_at,
    };
  }

  #runView(run: AnalysisRun): Record<string, unknown> {
    return {
      id: run.id,
      session_id: run.session_id,
      trigger: run.trigger,
      status: run.status,
      phase: run.phase,
      config_revision: run.config_revision,
      model_profile_snapshot_id: run.model_profile_snapshot_id,
      idempotency_key: run.idempotency_key,
      started_at: run.started_at,
      ended_at: run.ended_at,
    };
  }

  async #readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_JSON_BODY_BYTES) {
        throw err('PAYLOAD_TOO_LARGE', '请求体超过上限');
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw err('CONFIG_INVALID', '请求体不是合法 JSON');
    }
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  #sendError(res: ServerResponse, requestId: string, error: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    let status: number;
    let payload: AnalystError['payload'];
    if (error instanceof AnalystError) {
      status = httpStatusFor(error.payload.code);
      payload = { ...error.payload, request_id: error.payload.request_id ?? requestId };
    } else if (
      error !== null &&
      typeof error === 'object' &&
      'issues' in error &&
      Array.isArray((error as { issues: unknown }).issues)
    ) {
      // zod 校验错误 → 400
      status = 400;
      const first = (error as { issues: Array<{ path: unknown[]; message: string }> })
        .issues[0];
      payload = {
        code: 'CONFIG_INVALID',
        message: `请求校验失败: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
        request_id: requestId,
        run_id: null,
        retryable: false,
        details: null,
      };
    } else {
      status = 500;
      payload = {
        code: 'INTERNAL',
        message: '内部错误',
        request_id: requestId,
        run_id: null,
        retryable: false,
        details: null,
      };
    }
    this.#json(res, status, { error: payload });
  }
}

/** 恒定时间比较两个十六进制文本。 */
function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
