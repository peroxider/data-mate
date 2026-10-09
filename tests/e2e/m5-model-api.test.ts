import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// M5 验收测试(§10/§17/§18):serve REST API 全链路经真实 CLI 进程执行。
// 覆盖:YAML model 块导入、local-token 认证、模型探测(test-model 与 POST /test)、
// Run 提交流式完成、SSE Last-Event-ID 重放、Idempotency-Key 重放、
// revision 冲突 409、运行中取消、serve 重启快照恢复。
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '..', '..');
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'index.js');

const PROFILE_ID = '00000000-0000-4000-8000-000000005101';
const dirs: string[] = [];
let configDir: string;
let configYaml: string;
let mockServer: Server;

let serveProc: ChildProcess | null = null;
let serveStderr = '';
let apiBase = '';
let token = '';

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
  return port;
}

/** 模拟 openai-chat SSE 端点;message 含 SLOW 时逐增量延迟以便测试取消。 */
function startMockModel(): Promise<number> {
  mockServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let wantsStream = true;
      try {
        wantsStream = (JSON.parse(body) as { stream?: boolean }).stream !== false;
      } catch {
        // 非 JSON 请求按流式处理
      }
      const finishJson = (): void => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'M5 链路 完成' }, finish_reason: 'stop' }],
          }),
        );
      };
      if (!wantsStream) {
        finishJson();
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      const deltas = ['M5 ', '链路 ', '完成'];
      const slow = body.includes('SLOW');
      let i = 0;
      const writeNext = (): void => {
        if (i < deltas.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: deltas[i] } }] })}\n\n`);
          i += 1;
          setTimeout(writeNext, slow ? 400 : 5);
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      writeNext();
    });
  });
  return new Promise((resolveListen) => {
    mockServer.listen(0, '127.0.0.1', () => {
      resolveListen((mockServer.address() as { port: number }).port);
    });
  });
}

/** 异步执行 CLI:不能阻塞事件循环——mock 模型服务依赖本进程响应探测请求。 */
async function runCli(args: string[], timeoutMs = 60_000): Promise<string> {
  const child = spawn(process.execPath, [cliEntry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const code = await new Promise<number | null>((resolveExit) => {
    child.once('exit', (exitCode) => resolveExit(exitCode));
  });
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`CLI 退出码 ${code}: ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  return stdout;
}

function parseJson(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  return JSON.parse(stdout.slice(start));
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra };
}

async function startServe(): Promise<void> {
  serveStderr = '';
  serveProc = spawn(process.execPath, [cliEntry, 'serve', '--config', configYaml], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  serveProc.stderr?.on('data', (chunk: Buffer) => {
    serveStderr += chunk.toString('utf8');
  });
  const port = Number(readFileSync(join(configDir, 'server.port'), 'utf8').trim());
  apiBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${apiBase}/healthz`);
      if (res.ok) break;
    } catch {
      // 尚未监听
    }
    if (Date.now() > deadline) {
      throw new Error(`serve 未在 20s 内就绪;stderr: ${serveStderr}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  const tokenPath = join(configDir, '.m0', 'state', 'credentials', 'local-token');
  token = readFileSync(tokenPath, 'utf8').trim();
}

async function stopServe(): Promise<void> {
  const proc = serveProc;
  serveProc = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    proc.once('exit', () => resolveExit());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 10_000).unref();
  });
}

async function waitForTerminal(runId: string, maxMs = 40_000): Promise<string> {
  for (let i = 0; i < Math.ceil(maxMs / 100); i += 1) {
    const res = await fetch(`${apiBase}/api/v1/runs/${runId}`, { headers: headers() });
    const body = (await res.json()) as { status: string };
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(body.status)) return body.status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Run 未在期限内到达终态');
}

async function readSseUntil(runId: string, marker: string, lastEventId?: string): Promise<string> {
  const res = await fetch(`${apiBase}/api/v1/runs/${runId}/events`, {
    headers: headers(lastEventId ? { 'last-event-id': lastEventId } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes(marker)) {
      void reader.cancel();
      break;
    }
  }
  return text;
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'm5-e2e-'));
  dirs.push(configDir);
  configYaml = join(configDir, 'config.yaml');
  const serverPort = await freePort();
  await writeFile(join(configDir, 'server.port'), `${serverPort}\n`, 'utf8');
  const mockUrl = `http://127.0.0.1:${await startMockModel()}/v1`;
  await writeFile(
    configYaml,
    [
      'schema_version: 1',
      `server: { host: 127.0.0.1, port: ${serverPort} }`,
      'auth: { mode: local-token }',
      'paths:',
      '  data_dir: ./.m0/data',
      '  state_dir: ./.m0/state',
      '  cache_dir: ./.m0/cache',
      'runtime:',
      '  profile: data-analysis',
      '  python: auto',
      '  compute_device: cpu',
      '  max_active_kernels: 2',
      '  idle_kernel_timeout_seconds: 1800',
      '  cell_timeout_seconds: 120',
      '  interrupt_grace_seconds: 10',
      '  max_cell_output_mib: 8',
      'data:',
      '  max_upload_mib: 16',
      '  preview_rows: 100',
      '  model_sample_rows: 20',
      '  model_sample_cell_chars: 200',
      '  quality_ts_max_mib: 8',
      '  quality_ts_max_rows: 100000',
      'database:',
      '  readonly: true',
      '  statement_timeout_seconds: 60',
      '  max_result_rows: 1000',
      '  max_result_mib: 64',
      'model:',
      `  profile_id: ${PROFILE_ID}`,
      '  protocol: openai-chat',
      `  base_url: ${mockUrl}`,
      '  model: e2e-mock-model',
      '  credential_ref: none:e2e',
      '  connect_timeout_ms: 5000',
      '  response_timeout_ms: 30000',
      '  stream_idle_timeout_ms: 10000',
      '  temperature: 0.2',
      '  max_output_tokens: 256',
      '  context_window_tokens: 65536',
      '  capabilities: { streaming: optional, tool_calling: optional, vision: disabled }',
      '  extra_body: {}',
      'network:',
      '  mode: intranet',
      `  allowed_model_endpoints: [${mockUrl}]`,
      '  internet_runtime_downloads: false',
      'logging: { level: info, structured: true, store_data_samples: false }',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterAll(async () => {
  await stopServe();
  await new Promise<void>((resolveClose) => mockServer.close(() => resolveClose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!existsSync(cliEntry))('M5 全链路(模型服务 + REST API)', () => {
  let workspaceId = '';
  let sessionId = '';

  it('serve 启动:YAML model 块按需导入为 profile revision 1,认证边界生效', { timeout: 60_000 }, async () => {
    const ws = parseJson(await runCli(['workspace', 'create', '--config', configYaml, '--name', 'M5 E2E'])) as {
      id: string;
    };
    workspaceId = ws.id;
    const session = parseJson(await runCli(['session', 'create', '--config', configYaml, '--workspace', workspaceId])) as {
      id: string;
    };
    sessionId = session.id;

    await startServe();

    const unauth = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`, { headers: headers() });
    expect(res.status).toBe(200);
    const profile = (await res.json()) as { id: string; revision: number; model: string };
    expect(profile.id).toBe(PROFILE_ID);
    expect(profile.revision).toBe(1);
    expect(profile.model).toBe('e2e-mock-model');
  });

  it('test-model CLI:分层探测输出结构化结果且通过', { timeout: 120_000 }, async () => {
    const stdout = await runCli(['test-model', '--config', configYaml], 120_000);
    const result = JSON.parse(stdout) as {
      status: string;
      checks: Array<{ check: string; status: string }>;
      profile_id: string;
    };
    expect(result.profile_id).toBe(PROFILE_ID);
    expect(result.status).toBe('passed');
    const layers = result.checks.map((check) => check.check);
    expect(layers).toEqual(expect.arrayContaining(['network', 'auth', 'chat', 'streaming']));
    expect(result.checks.every((check) => check.status !== 'failed')).toBe(true);
  });

  it('POST /test 探测关联 revision;提交 Run 流式完成;SSE Last-Event-ID 重放;幂等重放', { timeout: 60_000 }, async () => {
    const probeRes = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}/test`, {
      method: 'POST',
      headers: headers(),
    });
    expect(probeRes.status).toBe(200);
    const probe = (await probeRes.json()) as { status: string; revision: number };
    expect(probe.status).toBe('passed');
    expect(probe.revision).toBe(1);

    const submit = await fetch(`${apiBase}/api/v1/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        message: '分析这份数据',
        data_refs: [],
        model_profile_id: PROFILE_ID,
        expected_model_revision: 1,
        options: {},
      }),
    });
    expect(submit.status).toBe(202);
    const { run_id: runId } = (await submit.json()) as { run_id: string };
    expect(await waitForTerminal(runId)).toBe('completed');

    // 幂等重放:同 Idempotency-Key 返回同一 Run
    const replay = await fetch(`${apiBase}/api/v1/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: headers({ 'idempotency-key': 'm5-e2e-idem-1' }),
      body: JSON.stringify({
        message: '幂等请求',
        data_refs: [],
        model_profile_id: PROFILE_ID,
        expected_model_revision: 1,
        options: {},
      }),
    });
    expect(replay.status).toBe(202);
    const first = (await replay.json()) as { run_id: string; idempotent_replay: boolean };
    expect(first.idempotent_replay).toBe(false);
    const replay2 = await fetch(`${apiBase}/api/v1/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: headers({ 'idempotency-key': 'm5-e2e-idem-1' }),
      body: JSON.stringify({
        message: '幂等请求',
        data_refs: [],
        model_profile_id: PROFILE_ID,
        expected_model_revision: 1,
        options: {},
      }),
    });
    const second = (await replay2.json()) as { run_id: string; idempotent_replay: boolean };
    expect(second.run_id).toBe(first.run_id);
    expect(second.idempotent_replay).toBe(true);
    await waitForTerminal(first.run_id);

    // SSE:Last-Event-ID=1 重连只重放 seq>1,seq 单调,且包含 run.completed
    const text = await readSseUntil(runId, 'run.completed', '1');
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(seqs.length).toBeGreaterThan(0);
    expect(Math.min(...seqs)).toBeGreaterThan(1);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(text).toContain('cell.output');
  });

  it('PUT 更新 revision→2;旧 expected revision 提交 Run → 409 CONFLICT', { timeout: 60_000 }, async () => {
    const current = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`, { headers: headers() });
    const profile = (await current.json()) as { base_url: string };

    const updated = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        expected_revision: 1,
        protocol: 'openai-chat',
        base_url: profile.base_url,
        model: 'e2e-mock-model-v2',
        credential_ref: 'none:e2e',
        capabilities: { streaming: 'optional', tool_calling: 'optional', vision: 'disabled' },
        connect_timeout_ms: 5_000,
        response_timeout_ms: 30_000,
        stream_idle_timeout_ms: 10_000,
        temperature: 0.2,
        max_output_tokens: 256,
        context_window_tokens: 65_536,
        extra_body: {},
      }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { revision: number }).revision).toBe(2);

    const conflict = await fetch(`${apiBase}/api/v1/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        message: '旧 revision 提交',
        data_refs: [],
        model_profile_id: PROFILE_ID,
        expected_model_revision: 1,
        options: {},
      }),
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as {
      error: { code: string; details: { current_revision: number } | null };
    };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details?.current_revision).toBe(2);
  });

  it('运行中取消 → 确认停止 → 终态 cancelled', { timeout: 60_000 }, async () => {
    const submit = await fetch(`${apiBase}/api/v1/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        message: 'SLOW 分析',
        data_refs: [],
        model_profile_id: PROFILE_ID,
        expected_model_revision: null,
        options: {},
      }),
    });
    expect(submit.status).toBe(202);
    const { run_id: runId } = (await submit.json()) as { run_id: string };

    const cancel = await fetch(`${apiBase}/api/v1/runs/${runId}/cancel`, {
      method: 'POST',
      headers: headers(),
    });
    expect(cancel.status).toBe(200);
    // M6 起执行回路注册取消句柄:abort 模型流并确认停止 → 终态 cancelled(§12 confirmed)
    expect(((await cancel.json()) as { status: string }).status).toBe('cancelled');
    expect(await waitForTerminal(runId, 30_000)).toBe('cancelled');
  });

  it('serve 重启:快照恢复 profile revision 与 Run 终态', { timeout: 60_000 }, async () => {
    await stopServe();
    await startServe();

    const profileRes = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`, { headers: headers() });
    const profile = (await profileRes.json()) as { revision: number; model: string };
    expect(profile.revision).toBe(2);
    expect(profile.model).toBe('e2e-mock-model-v2');

    const runsRes = await fetch(`${apiBase}/api/v1/model-profiles/${PROFILE_ID}`, { headers: headers() });
    expect(runsRes.status).toBe(200);
    // 终态 Run 在重启后仍可查询
    const runs = parseJson(await runCli(['run', 'list', '--config', configYaml, '--session', sessionId])) as Array<{
      id: string;
      status: string;
    }>;
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const firstRun = runs.find((run) => run.status === 'completed');
    expect(firstRun).toBeDefined();
  });
});
