# ADR001:模型服务外置

- 状态:已接受(M0)
- 日期:2026-10-08

## 背景

设计文档 §7/§24:模型推理经内网 OpenAI 兼容端点提供;M0 阶段无模型端点。产品边界要求模型端点属部署配置,不属于产品代码。

## 决策

模型调用一律经 `openai-chat` 协议访问外置端点(base_url 来自 §18 配置的 `model.base_url`,凭据经 `credential_ref` 引用,绝不内联)。产品内核不含模型服务,不内嵌 API Key。M0 环境无端点时,模型汇聚类验证记 pending,不伪造 pass。

## 适用范围

Agent Loop 的模型汇聚路径;模型能力协商(capabilities: streaming / tool_calling / vision)。

## 实现位置

- Schema:`packages/contracts/src/config.ts`(`ModelConfigSchema`,credential_ref 形态 `env:|file:|svc:|none`)
- 加载:`packages/core/src/config-loader.ts`(§18 顺序:内置默认 → YAML → 固定映射环境变量)
- CLI:`apps/cli/src/commands/config.ts`(`config validate` 输出 `CONFIG_INVALID` 负载)

## 验证方法

`pnpm config:validate`(校验通过/非法凭据形态拒绝);`node apps/cli/dist/index.js version --json`(BOM 摘要,不含任何凭据)。模型汇聚的端到端验证在 M1(依赖 `model-convergence` pending 项解除)。
