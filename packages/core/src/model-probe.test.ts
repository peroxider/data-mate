import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelProfileSchema } from '@data-analyst/contracts';
import type { ModelProfile } from '@data-analyst/contracts';
import { probeModelProfile, requiredCapabilitiesPassed } from './model-probe.js';
import { buildModelSample } from './data-samples.js';

function profileInput(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return ModelProfileSchema.parse({
    id: '00000000-0000-4000-8000-000000005001',
    revision: 1,
    protocol: 'openai-chat',
    base_url: 'http://127.0.0.1:1/v1',
    model: 'analyst-model',
    credential_ref: 'none',
    capabilities: { streaming: 'required', tool_calling: 'required', vision: 'disabled' },
    config_hash: 'a'.repeat(64),
    created_at: '2026-10-09T00:00:00.000Z',
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

function completeOk(): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  });
}

describe('probeModelProfile', () => {
  it('全部能力通过 → passed,分层检查齐备', async () => {
    await withMockModel(
      (req, res, body) => {
        res.setHeader(
          'content-type',
          body.includes('"stream":true') ? 'text/event-stream' : 'application/json',
        );
        if (body.includes('"stream":true')) {
          res.write(sse({ choices: [{ delta: { content: 'OK' } }] }));
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
          res.end('data: [DONE]\n\n');
          return;
        }
        if (body.includes('"tools"')) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_p',
                        type: 'function',
                        function: { name: 'probe_ping', arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
          return;
        }
        res.end(completeOk());
      },
      async (baseUrl) => {
        const result = await probeModelProfile({
          profile: profileInput({ base_url: baseUrl }),
          credential: null,
        });
        expect(result.status).toBe('passed');
        expect(result.checks.map((c) => `${c.check}:${c.status}`)).toEqual([
          'network:passed',
          'auth:passed',
          'chat:passed',
          'streaming:passed',
          'tool_calling:passed',
        ]);
      },
    );
  });

  it('401 → auth failed,chat/streaming/tool_calling 不假装可用(unknown);汇总 failed', async () => {
    await withMockModel(
      (req, res) => {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      },
      async (baseUrl) => {
        const result = await probeModelProfile({
          profile: profileInput({ base_url: baseUrl }),
          credential: null,
        });
        expect(result.status).toBe('failed');
        const byCheck = Object.fromEntries(result.checks.map((c) => [c.check, c.status]));
        expect(byCheck).toEqual({
          network: 'passed',
          auth: 'failed',
          chat: 'unknown',
          streaming: 'unknown',
          tool_calling: 'unknown',
        });
      },
    );
  });

  it('连接失败 → network failed,汇总 failed', async () => {
    const result = await probeModelProfile({
      profile: profileInput({
        base_url: 'http://127.0.0.1:9/v1',
        connect_timeout_ms: 1000,
        response_timeout_ms: 1000,
      }),
      credential: null,
    });
    expect(result.status).toBe('failed');
    expect(result.checks[0]).toMatchObject({ check: 'network', status: 'failed' });
  });

  it('disabled 能力不做网络请求,标记 disabled', async () => {
    await withMockModel(
      (req, res) => {
        res.end(completeOk());
      },
      async (baseUrl) => {
        const result = await probeModelProfile({
          profile: profileInput({
            base_url: baseUrl,
            capabilities: { streaming: 'disabled', tool_calling: 'disabled', vision: 'disabled' },
          }),
          credential: null,
        });
        expect(result.status).toBe('passed');
        const byCheck = Object.fromEntries(result.checks.map((c) => [c.check, c.status]));
        expect(byCheck.streaming).toBe('disabled');
        expect(byCheck.tool_calling).toBe('disabled');
      },
    );
  });
});

describe('requiredCapabilitiesPassed', () => {
  it('required 能力无 passed 记录 → 禁止启动', () => {
    expect(requiredCapabilitiesPassed(profileInput(), null).ok).toBe(false);
  });

  it('流式探测失败时 required 能力拦截启动', async () => {
    await withMockModel(
      (req, res, body) => {
        // 仅支持非流式:流式请求也返回普通 JSON,流解析将失败/无内容
        res.setHeader('content-type', 'application/json');
        res.end(completeOk());
        void body;
      },
      async (baseUrl) => {
        const result = await probeModelProfile({
          profile: profileInput({ base_url: baseUrl }),
          credential: null,
        });
        expect(result.checks.find((c) => c.check === 'streaming')?.status).not.toBe('passed');
        expect(requiredCapabilitiesPassed(profileInput({ base_url: baseUrl }), result).ok).toBe(
          false,
        );
      },
    );
  });
});

describe('buildModelSample', () => {
  it('行数与单元格字符双重截断', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ ch: `渠道${i}`, v: i }));
    const sample = buildModelSample(['ch', 'v'], rows, { maxRows: 20, maxCellChars: 200 });
    expect(sample.rows).toHaveLength(20);
    expect(sample.truncated).toBe(true);
    expect(sample.totalRows).toBe(30);
  });

  it('敏感列值被屏蔽,列名保留', () => {
    const sample = buildModelSample(
      ['name', 'id_card'],
      [{ name: '张三', id_card: '110101199001011234' }],
      { maxRows: 20, maxCellChars: 200 },
      new Set(['id_card']),
    );
    expect(sample.rows[0]).toEqual(['张三', '[屏蔽]']);
    expect(sample.maskedColumns).toEqual(['id_card']);
  });

  it('超长单元格按字符上限截断', () => {
    const sample = buildModelSample(['text'], [{ text: 'x'.repeat(500) }], {
      maxRows: 20,
      maxCellChars: 200,
    });
    expect((sample.rows[0]?.[0] as string).length).toBe(200);
  });
});
