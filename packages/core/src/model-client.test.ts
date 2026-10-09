import { describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnalystError, ModelCompleteRequestSchema } from '@data-analyst/contracts';
import type { ModelCompleteRequest } from '@data-analyst/contracts';
import { OpenAiChatClient } from './model-client.js';

function baseRequest(overrides: Partial<ModelCompleteRequest> = {}): ModelCompleteRequest {
  return ModelCompleteRequestSchema.parse({
    base_url: 'http://127.0.0.1:1/v1',
    model: 'analyst-model',
    messages: [{ role: 'user', content: '分析这份数据', tool_call_id: null, tool_calls: null }],
    tools: null,
    temperature: 0.2,
    max_output_tokens: 128,
    extra_body: {},
    connect_timeout_ms: 5_000,
    response_timeout_ms: 10_000,
    stream_idle_timeout_ms: 5_000,
    ...overrides,
  });
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 启动 mock OpenAI 兼容服务;handler 可读取累计请求计数以验证重试行为。 */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, count: number) => void,
  run: (baseUrl: string, getCount: () => number) => Promise<void>,
): Promise<void> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    requests += 1;
    handler(req, res, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}/v1`, () => requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('OpenAiChatClient.complete', () => {
  it('解析 content 与 tool_calls;无凭据时不发送 Authorization 头', async () => {
    await withServer(
      (req, res) => {
        void readBody(req).then((body) => {
          expect(body).toContain('"stream":false');
          expect(req.headers.authorization).toBeUndefined();
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'A 渠道转化率 17.5%',
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'analyst.inspect_data', arguments: '{"ref":"d1"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
        });
      },
      async (baseUrl) => {
        const client = new OpenAiChatClient();
        const result = await client.complete(baseRequest({ base_url: baseUrl }), null);
        expect(result.message.content).toBe('A 渠道转化率 17.5%');
        expect(result.finish_reason).toBe('tool_calls');
        expect(result.message.tool_calls?.[0]).toEqual({
          call_id: 'call_1',
          name: 'analyst.inspect_data',
          arguments_json: '{"ref":"d1"}',
        });
      },
    );
  });

  it('凭据以 Bearer 头发送且不进入错误消息;重试上限 2 次', async () => {
    await withServer(
      (req, res) => {
        expect(req.headers.authorization).toBe('Bearer test-credential-value');
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'boom' } }));
      },
      async (baseUrl, getCount) => {
        const client = new OpenAiChatClient();
        try {
          await client.complete(baseRequest({ base_url: baseUrl }), 'test-credential-value');
          throw new Error('expected failure');
        } catch (error) {
          expect(error).toBeInstanceOf(AnalystError);
          expect((error as AnalystError).message).not.toContain('test-credential-value');
          expect((error as AnalystError).payload.code).toBe('MODEL_UNAVAILABLE');
        }
        expect(getCount()).toBe(3); // 首次 + 2 次有界重试
      },
    );
  });

  it('503 后恢复 → 重试成功并尊重 Retry-After', async () => {
    await withServer(
      (req, res, count) => {
        if (count <= 2) {
          res.statusCode = 503;
          res.setHeader('retry-after', '0');
          res.end(JSON.stringify({ error: { message: 'unavailable' } }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
        );
      },
      async (baseUrl) => {
        const client = new OpenAiChatClient();
        const result = await client.complete(baseRequest({ base_url: baseUrl }), null);
        expect(result.message.content).toBe('ok');
      },
    );
  });

  it('4xx 请求字段错误不重试', async () => {
    await withServer(
      (req, res) => {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'max_tokens too large' } }));
      },
      async (baseUrl, getCount) => {
        const client = new OpenAiChatClient();
        await expect(
          client.complete(baseRequest({ base_url: baseUrl }), null),
        ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
        expect(getCount()).toBe(1);
      },
    );
  });
});

describe('OpenAiChatClient.stream', () => {
  it('文本增量按序交付,工具调用片段按 index 聚合且只交付一次', async () => {
    await withServer(
      (req, res) => {
        void readBody(req).then(() => {
          res.setHeader('content-type', 'text/event-stream');
          res.write(sse({ choices: [{ delta: { content: '转化率' } }] }));
          res.write(sse({ choices: [{ delta: { content: ' 17.5%' } }] }));
          // 工具调用分两段到达(按 index 聚合)
          res.write(
            sse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_a', function: { name: 't', arguments: '{"x":' } },
                    ],
                  },
                },
              ],
            }),
          );
          res.write(
            sse({
              choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
            }),
          );
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
          res.end('data: [DONE]\n\n');
        });
      },
      async (baseUrl) => {
        const client = new OpenAiChatClient();
        const events = [];
        for await (const event of client.stream(baseRequest({ base_url: baseUrl }), null)) {
          events.push(event);
        }
        const text = events
          .filter((e) => e.type === 'text_delta')
          .map((e) => (e as { text: string }).text)
          .join('');
        expect(text).toBe('转化率 17.5%');
        const toolCalls = events.filter((e) => e.type === 'tool_call');
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]).toEqual({
          type: 'tool_call',
          call: { call_id: 'call_a', name: 't', arguments_json: '{"x":1}' },
        });
        expect(events.at(-1)?.type).toBe('done');
      },
    );
  });

  it('开始返回内容后连接断开 → interrupted 且保留已收内容', async () => {
    await withServer(
      (req, res) => {
        void readBody(req).then(() => {
          res.setHeader('content-type', 'text/event-stream');
          res.write(sse({ choices: [{ delta: { content: '部分内容' } }] }));
          setTimeout(() => {
            res.socket?.destroy();
          }, 50);
        });
      },
      async (baseUrl) => {
        const client = new OpenAiChatClient();
        const events = [];
        for await (const event of client.stream(baseRequest({ base_url: baseUrl }), null)) {
          events.push(event);
        }
        const last = events.at(-1);
        expect(last?.type).toBe('interrupted');
        expect((last as { text_so_far: string }).text_so_far).toBe('部分内容');
      },
    );
  });

  it('参数 JSON 不完整的工具调用不交付', async () => {
    await withServer(
      (req, res) => {
        void readBody(req).then(() => {
          res.setHeader('content-type', 'text/event-stream');
          res.write(
            sse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_b', function: { name: 't', arguments: '{"x":' } },
                    ],
                  },
                },
              ],
            }),
          );
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
          res.end('data: [DONE]\n\n');
        });
      },
      async (baseUrl) => {
        const client = new OpenAiChatClient();
        const events = [];
        for await (const event of client.stream(baseRequest({ base_url: baseUrl }), null)) {
          events.push(event);
        }
        expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
      },
    );
  });

  it('取消信号:开始前已取消 → 立即 interrupted(cancelled);流中取消 → interrupted(cancelled)', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse({ choices: [{ delta: { content: 'A' } }] }));
        // 保持连接不结束,等待客户端取消
      },
      async (baseUrl) => {
        const client = new OpenAiChatClient();
        // 流中取消
        const controller = new AbortController();
        const events = [];
        for await (const event of client.stream(baseRequest({ base_url: baseUrl }), null, {
          signal: controller.signal,
        })) {
          events.push(event);
          if (event.type === 'text_delta') controller.abort();
        }
        const last = events.at(-1) as { type: string; reason: string };
        expect(last.type).toBe('interrupted');
        expect(last.reason).toBe('cancelled');
      },
    );

    // 开始前已取消
    const client = new OpenAiChatClient();
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of client.stream(baseRequest(), null, { signal: controller.signal })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'interrupted', reason: 'cancelled', text_so_far: '' }]);
  });

  it('complete 路径:已取消的信号 → CANCELLED 错误,不发起请求', async () => {
    const client = new OpenAiChatClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.complete(baseRequest(), null, { signal: controller.signal }),
    ).rejects.toMatchObject({ payload: { code: 'CANCELLED', retryable: false } });
  });
});
