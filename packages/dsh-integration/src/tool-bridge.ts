import { AnalystError } from '@data-analyst/contracts';
import type { ChatToolDefinition } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §7/§17 DSH Cordis 适配缝:把产品 analyst.* 工具桥接为 DSH 工具描述符与调用入口。
// 本里程碑只交付适配层,不做 Cordis 插件注册(compat 记录 pending);
// 注册路径确定后,DSH 侧以 descriptors + invoke 接入,行为与产品回路一致:
// JSON 进出,错误以 {error, code} 返回,绝不抛出。
// ---------------------------------------------------------------------------

export interface DshToolResultLike {
  summary: string;
  references: unknown[];
  next_capabilities: string[];
}

export interface DshBridgeableTool<Ctx> {
  name: string;
  description: string;
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>;
  execute(input: unknown, ctx: Ctx): Promise<DshToolResultLike>;
}

/** 结构化最小注册表:与产品 ToolRegistry 形状兼容,不引入对 core 的依赖。 */
export interface DshBridgeableRegistry<Ctx> {
  get(name: string): DshBridgeableTool<Ctx> | null;
  list(): DshBridgeableTool<Ctx>[];
}

export interface DshToolBridge {
  toDshToolDescriptors(): ChatToolDefinition[];
  /** JSON 进出:成功返回工具结果 JSON;失败返回 {error, code} JSON,不抛出。 */
  invoke(name: string, argsJson: string): Promise<string>;
}

export function createDshToolBridge<Ctx>(
  registry: DshBridgeableRegistry<Ctx>,
  ctxFactory: () => Ctx | Promise<Ctx>,
): DshToolBridge {
  return {
    toDshToolDescriptors(): ChatToolDefinition[] {
      return registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    },

    async invoke(name: string, argsJson: string): Promise<string> {
      const tool = registry.get(name);
      if (!tool) {
        return JSON.stringify({ error: `未知工具: ${name}`, code: 'NOT_FOUND' });
      }
      try {
        let input: unknown = {};
        if (argsJson.trim() !== '') input = JSON.parse(argsJson) as unknown;
        const ctx = await ctxFactory();
        const result = await tool.execute(input, ctx);
        return JSON.stringify({
          summary: result.summary,
          references: result.references,
          next_capabilities: result.next_capabilities,
        });
      } catch (cause) {
        if (cause instanceof AnalystError) {
          return JSON.stringify({ error: cause.message, code: cause.payload.code });
        }
        return JSON.stringify({ error: '工具执行失败', code: 'INTERNAL' });
      }
    },
  };
}
