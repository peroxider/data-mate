import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  ModelProfileSchema,
  ModelProfileUpdateSchema,
  ProductConfigSchema,
  SessionBindingSchema,
  RunSubmissionSchema,
} from '@data-analyst/contracts';
import type { ModelProfile, ModelProfileUpdate, ProductConfig, RunSubmission } from '@data-analyst/contracts';
import type { AggregationService, WorkspaceService } from './index.js';
import { InMemoryRepository } from './repository.js';
import { RunGovernor } from './run-governance.js';
import { ModelProfileService } from './model-profiles.js';
import { ApiServer } from './api-server.js';
import { OpenAiChatClient } from './model-client.js';
import { ToolRegistry } from './agent-tools.js';
import type { AgentTool, AgentToolLimits } from './agent-tools.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000005001';
const SESSION_ID = '00000000-0000-4000-8000-00000000a001';
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000b001';
const TOKEN = 'test-token';

function productConfig(): ProductConfig {
  return ProductConfigSchema.parse({
    schema_version: 1,
    server: { host: '127.0.0.1', port: 1 },
    auth: { mode: 'local-token' },
    paths: { data_dir: './data', state_dir: './state', cache_dir: './cache' },
    runtime: {
      profile: 'data-analysis',
      python: 'auto',
      compute_device: 'cpu',
      max_active_kernels: 2,
      idle_kernel_timeout_seconds: 1800,
      cell_timeout_seconds: 600,
      interrupt_grace_seconds: 10,
      max_cell_output_mib: 8,
      agent_max_turns: 12,
    },
    data: {
      max_upload_mib: 512,
      preview_rows: 100,
      model_sample_rows: 20,
      model_sample_cell_chars: 200,
      quality_ts_max_mib: 50,
      quality_ts_max_rows: 100_000,
    },
    database: {
      readonly: true,
      statement_timeout_seconds: 60,
      max_result_rows: 1_000_000,
      max_result_mib: 256,
    },
    network: {
      mode: 'intranet',
      allowed_model_endpoints: ['http://model-gateway.internal:8000/v1'],
      internet_runtime_downloads: false,
    },
    logging: { level: 'info', structured: true, store_data_samples: false },
  });
}

function profileUpdate(overrides: Partial<ModelProfileUpdate> = {}): ModelProfileUpdate {
  return ModelProfileUpdateSchema.parse({
    expected_revision: null,
    protocol: 'openai-chat',
    base_url: 'http://127.0.0.1:1/v1',
    model: 'analyst-model',
    credential_ref: 'none',
    capabilities: { streaming: 'disabled', tool_calling: 'disabled', vision: 'disabled' },
    connect_timeout_ms: 5_000,
    response_timeout_ms: 10_000,
    stream_idle_timeout_ms: 5_000,
    temperature: 0.2,
    max_output_tokens: 64,
    context_window_tokens: 65_536,
    extra_body: {},
    ...overrides,
  });
}

function submission(overrides: Partial<RunSubmission> = {}): RunSubmission {
  return RunSubmissionSchema.parse({
    message: '分析这份数据的缺失与重复',
    data_refs: [],
    model_profile_id: PROFILE_ID,
    expected_model_revision: 1,
    options: {},
    ...overrides,
  });
}

function storedProfile(baseUrl: string): ModelProfile {
  return ModelProfileSchema.parse({
    id: PROFILE_ID,
    revision: 1,
    protocol: 'openai-chat',
    base_url: baseUrl,
    model: 'analyst-model',
    credential_ref: 'none',
    capabilities: { streaming: 'disabled', tool_calling: 'disabled', vision: 'disabled' },
    config_hash: 'a'.repeat(64),
    created_at: '2026-10-09T00:00:00.000Z',
    connect_timeout_ms: 5_000,
    response_timeout_ms: 10_000,
    stream_idle_timeout_ms: 5_000,
    temperature: 0.2,
    max_output_tokens: 128,
    context_window_tokens: 65_536,
    extra_body: {},
  });
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function withMockModel(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface TestContext {
  api: ApiServer;
  baseUrl: string;
  repository: InMemoryRepository;
}

async function startApi(client?: OpenAiChatClient): Promise<TestContext> {
  const repository = new InMemoryRepository();
  const config = productConfig();
  const governor = new RunGovernor({ repository, maxActiveKernels: 2 });
  const modelProfiles = new ModelProfileService({ repository });
  const api = new ApiServer({
    config,
    repository,
    runGovernor: governor,
    modelProfiles,
    token: TOKEN,
    client,
  });
  await api.start(0);
  const addr = api.address;
  await repository.sessions.put(
    SessionBindingSchema.parse({
      id: SESSION_ID,
      dsh_session_id: 'dsh-1',
      workspace_id: WORKSPACE_ID,
      notebook_id: null,
      model_profile_id: null,
      created_at: '2026-10-09T00:00:00.000Z',
    }),
  );
  return { api, baseUrl: `http://127.0.0.1:${addr?.port ?? 0}`, repository };
}

async function stopApi(ctx: TestContext): Promise<void> {
  await ctx.api.stop();
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

async function waitForTerminal(ctx: TestContext, runId: string): Promise<string> {
  let status = '';
  for (let i = 0; i < 50; i += 1) {
    const view = await fetch(`${ctx.baseUrl}/api/v1/runs/${runId}`, { headers: headers() });
    status = ((await view.json()) as { status: string }).status;
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return status;
}

describe('ApiServer 基础端点', () => {
  it('healthz 无需认证;capabilities 需要令牌', async () => {
    const ctx = await startApi();
    try {
      const health = await fetch(`${ctx.baseUrl}/healthz`);
      expect(health.status).toBe(200);

      const unauth = await fetch(`${ctx.baseUrl}/api/v1/capabilities`);
      expect(unauth.status).toBe(401);
      const body = (await unauth.json()) as { error: { code: string; request_id: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.request_id).not.toBe('');

      const ok = await fetch(`${ctx.baseUrl}/api/v1/capabilities`, { headers: headers() });
      expect(ok.status).toBe(200);
      const caps = (await ok.json()) as { model_protocol: string; product: string };
      expect(caps.model_protocol).toBe('openai-chat');
    } finally {
      await stopApi(ctx);
    }
  });

  it('未知路径 → 统一错误结构 404', async () => {
    const ctx = await startApi();
    try {
      const res = await fetch(`${ctx.baseUrl}/api/v1/nope`, { headers: headers() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await stopApi(ctx);
    }
  });
});

describe('ApiServer 模型配置端点', () => {
  it('PUT 创建与更新;expected_revision 冲突 → 409;extra_body 保护字段 → 400', async () => {
    const ctx = await startApi();
    try {
      const created = await fetch(`${ctx.baseUrl}/api/v1/model-profiles/${PROFILE_ID}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(profileUpdate()),
      });
      expect(created.status).toBe(200);
      expect(((await created.json()) as { revision: number }).revision).toBe(1);

      const conflict = await fetch(`${ctx.baseUrl}/api/v1/model-profiles/${PROFILE_ID}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(profileUpdate({ expected_revision: null })),
      });
      expect(conflict.status).toBe(409);
      const conflictBody = (await conflict.json()) as { error: { code: string } };
      expect(conflictBody.error.code).toBe('CONFLICT');

      const stale = await fetch(`${ctx.baseUrl}/api/v1/model-profiles/${PROFILE_ID}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(profileUpdate({ expected_revision: 99 })),
      });
      expect(stale.status).toBe(409);

      const forbidden = await fetch(`${ctx.baseUrl}/api/v1/model-profiles/${PROFILE_ID}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(
          profileUpdate({ expected_revision: 1, extra_body: { stream: true } }),
        ),
      });
      expect(forbidden.status).toBe(400);
      const forbiddenBody = (await forbidden.json()) as { error: { code: string } };
      expect(forbiddenBody.error.code).toBe('CONFIG_INVALID');
    } finally {
      await stopApi(ctx);
    }
  });
});

describe('ApiServer Run 端点', () => {
  it('能力未探测时 required 能力拦截 → 422 且不创建 Run', async () => {
    const ctx = await startApi();
    try {
      await ctx.repository.modelProfiles.put(
        ModelProfileSchema.parse({
          id: PROFILE_ID,
          revision: 1,
          protocol: 'openai-chat',
          base_url: 'http://127.0.0.1:1/v1',
          model: 'analyst-model',
          credential_ref: 'none',
          capabilities: { streaming: 'required', tool_calling: 'required', vision: 'disabled' },
          config_hash: 'a'.repeat(64),
          created_at: '2026-10-09T00:00:00.000Z',
        }),
      );
      const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(submission()),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNPROCESSABLE');
      expect(body.error.message).toContain('required 能力');
      const runs = await ctx.repository.runs.list();
      expect(runs).toHaveLength(0);
    } finally {
      await stopApi(ctx);
    }
  });

  it('提交 → 202 执行完成 → run 终态 completed;Idempotency-Key 重放返回同一 Run', async () => {
    await withMockModel(
      (req, res, body) => {
        res.setHeader('content-type', 'text/event-stream');
        void body;
        res.write(sse({ choices: [{ delta: { content: '总体转化率 13.571429%' } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.end('data: [DONE]\n\n');
      },
      async (baseUrl) => {
        const ctx = await startApi(new OpenAiChatClient());
        try {
          await ctx.repository.modelProfiles.put(storedProfile(baseUrl));
          const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
            method: 'POST',
            headers: headers({ 'idempotency-key': 'idem-1' }),
            body: JSON.stringify(submission()),
          });
          expect(res.status).toBe(202);
          const { run_id } = (await res.json()) as { run_id: string };

          expect(await waitForTerminal(ctx, run_id)).toBe('completed');

          const replay = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
            method: 'POST',
            headers: headers({ 'idempotency-key': 'idem-1' }),
            body: JSON.stringify(submission()),
          });
          const replayBody = (await replay.json()) as {
            run_id: string;
            idempotent_replay: boolean;
          };
          expect(replayBody.run_id).toBe(run_id);
          expect(replayBody.idempotent_replay).toBe(true);

          // 同 key 不同 payload → 409(§629)
          const mismatch = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
            method: 'POST',
            headers: headers({ 'idempotency-key': 'idem-1' }),
            body: JSON.stringify(submission({ message: '不同的请求负载' })),
          });
          expect(mismatch.status).toBe(409);
          const mismatchBody = (await mismatch.json()) as { error: { code: string } };
          expect(mismatchBody.error.code).toBe('CONFLICT');
        } finally {
          await stopApi(ctx);
        }
      },
    );
  });

  it('profile 不存在 → 404', async () => {
    const ctx = await startApi();
    try {
      const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(submission({ expected_model_revision: 7 })),
      });
      expect(res.status).toBe(404);
    } finally {
      await stopApi(ctx);
    }
  });
});

describe('ApiServer SSE', () => {
  it('Last-Event-ID 重连从该 seq 之后重放,单调 seq', async () => {
    await withMockModel(
      (req, res, body) => {
        res.setHeader('content-type', 'text/event-stream');
        void body;
        res.write(sse({ choices: [{ delta: { content: 'A' } }] }));
        res.write(sse({ choices: [{ delta: { content: 'B' } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.end('data: [DONE]\n\n');
      },
      async (baseUrl) => {
        const ctx = await startApi(new OpenAiChatClient());
        try {
          await ctx.repository.modelProfiles.put(storedProfile(baseUrl));
          const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(submission()),
          });
          const { run_id } = (await res.json()) as { run_id: string };
          await waitForTerminal(ctx, run_id);

          const sseRes = await fetch(`${ctx.baseUrl}/api/v1/runs/${run_id}/events`, {
            headers: headers({ 'last-event-id': '1' }),
          });
          expect(sseRes.headers.get('content-type')).toBe('text/event-stream');
          const reader = sseRes.body?.getReader();
          const decoder = new TextDecoder();
          let text = '';
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.includes('run.completed')) {
              void reader.cancel();
              break;
            }
          }
          const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
          expect(seqs.length).toBeGreaterThan(0);
          expect(Math.min(...seqs)).toBeGreaterThan(1);
          expect(text).toContain('run.completed');
        } finally {
          await stopApi(ctx);
        }
      },
    );
  });
});

// ------------------------------ M6:多轮 Agent 回路 ------------------------------

/** 工具启用场景的 profile:tool_calling=optional(disabled 会触发提交时工具能力门)。 */
function agentProfile(baseUrl: string): ModelProfile {
  return ModelProfileSchema.parse({
    ...storedProfile(baseUrl),
    capabilities: { streaming: 'disabled', tool_calling: 'optional', vision: 'disabled' },
  });
}

const TOOL_LIMITS: AgentToolLimits = {
  max_bytes: 16 * 1024 * 1024,
  max_rows: 100_000,
  preview_rows: 100,
  model_sample_rows: 20,
  model_sample_cell_chars: 200,
};

function makeEchoTool(): AgentTool {
  return {
    name: 'test.echo',
    description: '回显输入参数中的 text 字段',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
    phase: 'inspect',
    async execute(input) {
      const text = (input as { text?: string }).text ?? '';
      return { summary: `echo:${text}`, references: [{ echo: text }], next_capabilities: [] };
    },
  };
}

interface ToolsTestContext extends TestContext {
  workspacesDir: string;
}

async function startApiWithTools(
  options: { maxActiveKernels?: number } = {},
): Promise<ToolsTestContext> {
  const workspacesDir = await mkdtemp(join(tmpdir(), 'api-agent-tools-'));
  const registry = new ToolRegistry();
  registry.register(makeEchoTool());
  const repository = new InMemoryRepository();
  const governor = new RunGovernor({
    repository,
    maxActiveKernels: options.maxActiveKernels ?? 2,
  });
  const modelProfiles = new ModelProfileService({ repository });
  const api = new ApiServer({
    config: productConfig(),
    repository,
    runGovernor: governor,
    modelProfiles,
    token: TOKEN,
    client: new OpenAiChatClient(),
    toolRegistry: registry,
    toolServices: {
      workspace: {} as unknown as WorkspaceService,
      aggregation: {} as unknown as AggregationService,
      workspacesDir,
      limits: TOOL_LIMITS,
    },
    agentLimits: { max_turns: 12 },
  });
  await api.start(0);
  const addr = api.address;
  await repository.sessions.put(
    SessionBindingSchema.parse({
      id: SESSION_ID,
      dsh_session_id: 'dsh-1',
      workspace_id: WORKSPACE_ID,
      notebook_id: null,
      model_profile_id: null,
      created_at: '2026-10-09T00:00:00.000Z',
    }),
  );
  return {
    api,
    baseUrl: `http://127.0.0.1:${addr?.port ?? 0}`,
    repository,
    workspacesDir,
  };
}

async function stopToolsApi(ctx: ToolsTestContext): Promise<void> {
  await ctx.api.stop();
  await rm(ctx.workspacesDir, { recursive: true, force: true });
}

async function readAllSse(ctx: TestContext, runId: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/api/v1/runs/${runId}/events`, { headers: headers() });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes('run.completed')) {
      void reader.cancel();
      break;
    }
  }
  return text;
}

async function waitForStatus(
  ctx: TestContext,
  runId: string,
  status: string,
  maxMs = 3_000,
): Promise<boolean> {
  for (let i = 0; i < Math.ceil(maxMs / 50); i += 1) {
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/${runId}`, { headers: headers() });
    if (((await res.json()) as { status: string }).status === status) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('ApiServer 多轮 Agent 回路(M6)', () => {
  it('第 1 轮 tool_call → 执行工具 → 第 2 轮携带 assistant tool_calls 与 tool 结果;SSE 顺序正确', async () => {
    const requests: string[] = [];
    await withMockModel(
      (_req, res, body) => {
        requests.push(body);
        res.setHeader('content-type', 'text/event-stream');
        if (requests.length === 1) {
          res.write(
            sse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        function: { name: 'test.echo', arguments: '{"text":"你好"}' },
                      },
                    ],
                  },
                },
              ],
            }),
          );
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
          res.end('data: [DONE]\n\n');
          return;
        }
        res.write(sse({ choices: [{ delta: { content: '工具结果已回收' } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.end('data: [DONE]\n\n');
      },
      async (baseUrl) => {
        const ctx = await startApiWithTools();
        try {
          await ctx.repository.modelProfiles.put(agentProfile(baseUrl));
          const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(submission()),
          });
          expect(res.status).toBe(202);
          const { run_id: runId } = (await res.json()) as { run_id: string };
          expect(await waitForTerminal(ctx, runId)).toBe('completed');

          // 第 1 轮请求携带工具描述符;第 2 轮携带 assistant tool_calls + tool 结果消息
          expect(requests).toHaveLength(2);
          expect(requests[0]).toContain('"name":"test.echo"');
          const second = requests[1]!;
          expect(second).toContain('"role":"tool"');
          expect(second).toContain('"tool_call_id":"call_1"');
          expect(second).toContain('echo:你好');
          expect(second).toContain('"tool_calls":[{');

          // SSE:tool.started → tool.completed(completed) → run.completed(completed)
          const text = await readAllSse(ctx, runId);
          const started = text.indexOf('event: tool.started');
          const completed = text.indexOf('event: tool.completed');
          const finished = text.indexOf('event: run.completed');
          expect(started).toBeGreaterThan(-1);
          expect(completed).toBeGreaterThan(started);
          expect(finished).toBeGreaterThan(completed);
          expect(text).toContain('"status":"completed"');
        } finally {
          await stopToolsApi(ctx);
        }
      },
    );
  });

  it('options.tools 含未知名 → 422 且不创建 Run', async () => {
    const ctx = await startApiWithTools();
    try {
      await ctx.repository.modelProfiles.put(agentProfile('http://127.0.0.1:1/v1'));
      const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(submission({ options: { tools: ['nope.tool'] } })),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        error: { code: string; details: Record<string, string> | null };
      };
      expect(body.error.code).toBe('UNPROCESSABLE');
      expect(body.error.details).toMatchObject({ tool: 'nope.tool' });
      expect(await ctx.repository.runs.list()).toHaveLength(0);
    } finally {
      await stopToolsApi(ctx);
    }
  });

  it('tools: [] 关闭工具 → 跳过 tool_calling 门并完成', async () => {
    await withMockModel(
      (_req, res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.write(sse({ choices: [{ delta: { content: '无工具回答' } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.end('data: [DONE]\n\n');
      },
      async (baseUrl) => {
        const ctx = await startApiWithTools();
        try {
          // storedProfile 的 tool_calling=disabled:空工具集必须放行
          await ctx.repository.modelProfiles.put(storedProfile(baseUrl));
          const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(submission({ options: { tools: [] } })),
          });
          expect(res.status).toBe(202);
          const { run_id: runId } = (await res.json()) as { run_id: string };
          expect(await waitForTerminal(ctx, runId)).toBe('completed');
          const text = await readAllSse(ctx, runId);
          expect(text).not.toContain('event: tool.started');
          expect(text).toContain('无工具回答');
        } finally {
          await stopToolsApi(ctx);
        }
      },
    );
  });

  it('tool_calling=disabled 且缺省全量工具 → 422 拒绝提交', async () => {
    const ctx = await startApiWithTools();
    try {
      await ctx.repository.modelProfiles.put(storedProfile('http://127.0.0.1:1/v1'));
      const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(submission()),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNPROCESSABLE');
      expect(body.error.message).toContain('tool_calling');
    } finally {
      await stopToolsApi(ctx);
    }
  });

  it('排队 Run 经 onRunStarted 唤醒后执行完成', async () => {
    let modelRequests = 0;
    await withMockModel(
      (_req, res) => {
        modelRequests += 1;
        const first = modelRequests === 1;
        res.setHeader('content-type', 'text/event-stream');
        // 第一个 Run 占住 kernel slot 300ms,给第二个 Run 留出排队窗口
        setTimeout(() => {
          res.write(sse({ choices: [{ delta: { content: first ? 'A 完成' : 'B 完成' } }] }));
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
          res.end('data: [DONE]\n\n');
        }, first ? 300 : 0);
      },
      async (baseUrl) => {
        const ctx = await startApiWithTools({ maxActiveKernels: 1 });
        try {
          await ctx.repository.modelProfiles.put(agentProfile(baseUrl));
          // 第二个 Session:同 Session 并发会 SESSION_BUSY,排队只发生在跨 Session 争抢 kernel slot
          const secondSessionId = '00000000-0000-4000-8000-00000000a002';
          await ctx.repository.sessions.put(
            SessionBindingSchema.parse({
              id: secondSessionId,
              dsh_session_id: 'dsh-2',
              workspace_id: WORKSPACE_ID,
              notebook_id: null,
              model_profile_id: null,
              created_at: '2026-10-09T00:00:00.000Z',
            }),
          );
          const submit = (sessionId: string): Promise<{ run_id: string }> =>
            fetch(`${ctx.baseUrl}/api/v1/sessions/${sessionId}/runs`, {
              method: 'POST',
              headers: headers(),
              body: JSON.stringify(submission()),
            }).then((res) => {
              expect(res.status).toBe(202);
              return res.json() as Promise<{ run_id: string }>;
            });
          const firstRun = await submit(SESSION_ID);
          const secondRun = await submit(secondSessionId);
          expect(await waitForStatus(ctx, secondRun.run_id, 'queued')).toBe(true);
          expect(await waitForTerminal(ctx, firstRun.run_id)).toBe('completed');
          expect(await waitForTerminal(ctx, secondRun.run_id)).toBe('completed');
        } finally {
          await stopToolsApi(ctx);
        }
      },
    );
  });

  it('运行中取消:取消句柄确认停止 → 终态 cancelled', async () => {
    await withMockModel(
      (_req, res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.write(sse({ choices: [{ delta: { content: '保持连接' } }] }));
        // 保持流打开等待取消;兜底销毁避免悬挂连接
        setTimeout(() => res.destroy(), 5_000).unref();
      },
      async (baseUrl) => {
        const ctx = await startApiWithTools();
        try {
          await ctx.repository.modelProfiles.put(agentProfile(baseUrl));
          const res = await fetch(`${ctx.baseUrl}/api/v1/sessions/${SESSION_ID}/runs`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(submission()),
          });
          const { run_id: runId } = (await res.json()) as { run_id: string };
          expect(await waitForStatus(ctx, runId, 'running')).toBe(true);
          const cancel = await fetch(`${ctx.baseUrl}/api/v1/runs/${runId}/cancel`, {
            method: 'POST',
            headers: headers(),
          });
          expect(cancel.status).toBe(200);
          expect(((await cancel.json()) as { status: string }).status).toBe('cancelled');
          expect(await waitForTerminal(ctx, runId)).toBe('cancelled');
        } finally {
          await stopToolsApi(ctx);
        }
      },
    );
  });
});
