import { describe, expect, it } from 'vitest';
import { AnalystError } from '@data-analyst/contracts';
import { createDshToolBridge } from './tool-bridge.js';
import type { DshBridgeableTool } from './tool-bridge.js';

interface Ctx {
  tag: string;
}

const tool: DshBridgeableTool<Ctx> = {
  name: 'analyst.inspect_data',
  description: '预览数据',
  parameters: { type: 'object', properties: {} },
  async execute(input, ctx) {
    if (input !== null && typeof input === 'object' && 'boom' in input) {
      throw new AnalystError({
        code: 'UNPROCESSABLE',
        message: '入参不符合模式',
        request_id: null,
        run_id: null,
        retryable: false,
        details: null,
      });
    }
    return {
      summary: `inspected by ${ctx.tag}`,
      references: [{ data_ref_id: 'r1' }],
      next_capabilities: ['analyst.commit_results'],
    };
  },
};

const registry = {
  get: (name: string) => (name === tool.name ? tool : null),
  list: () => [tool],
};

describe('createDshToolBridge', () => {
  it('描述符与产品工具一一对应', () => {
    const bridge = createDshToolBridge<Ctx>(registry, () => ({ tag: 't' }));
    expect(bridge.toDshToolDescriptors()).toEqual([
      { name: 'analyst.inspect_data', description: '预览数据', parameters: { type: 'object', properties: {} } },
    ]);
  });

  it('invoke JSON 进出:成功返回工具结果 JSON', async () => {
    const bridge = createDshToolBridge<Ctx>(registry, () => ({ tag: 't' }));
    const output = await bridge.invoke('analyst.inspect_data', '{"dataset":"sales"}');
    expect(JSON.parse(output)).toMatchObject({
      summary: 'inspected by t',
      next_capabilities: ['analyst.commit_results'],
    });
  });

  it('未知工具与入参错误都以 {error, code} JSON 返回,不抛出', async () => {
    const bridge = createDshToolBridge<Ctx>(registry, () => ({ tag: 't' }));
    const unknown = JSON.parse(await bridge.invoke('analyst.no_such_tool', '{}')) as {
      error: string;
      code: string;
    };
    expect(unknown.code).toBe('NOT_FOUND');
    const bad = JSON.parse(await bridge.invoke('analyst.inspect_data', '{"boom":true}')) as {
      error: string;
      code: string;
    };
    expect(bad.code).toBe('UNPROCESSABLE');
    const malformed = JSON.parse(await bridge.invoke('analyst.inspect_data', '{oops')) as {
      error: string;
      code: string;
    };
    expect(malformed.code).toBe('INTERNAL');
  });
});
