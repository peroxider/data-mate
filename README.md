# data-analyst

基于 DeepSeek Harness(DSH)+ 四个插件构建的数据分析 Agent。本仓库当前处于 **M0 阶段:组件冻结与领域层骨架**(设计文档 §24),不包含模型服务调用与端到端业务流。

> 设计文档:`docs/Data_Analysis_Agent_Requirements_Detailed_Design_v0.1.md`(下文 §N 均指该文档章节)

## 当前状态

| 模块 | 位置 | 状态 |
| --- | --- | --- |
| Monorepo 脚手架 | 根 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` | ✅ 完成 |
| 领域契约(zod Schema) | `packages/contracts` | ✅ 完成 |
| 核心领域服务 | `packages/core` | ✅ 完成(配置加载、路径解析、内存 Repository) |
| CLI | `apps/cli` | ✅ doctor / version / config / components / serve 全部可用 |
| DSH 集成层 | `packages/dsh-integration` | ✅ 受控启动(argv 数组,禁 npx) |
| 其余领域包 | `artifacts` / `data-adapters` / `model-service` / `notebook-adapter` / `web-extension` | ⬜ 空骨架 |
| Python 运行时自检 | `python/analyst_runtime` | ✅ `doctor --json` 只读探测 |
| 组件冻结 / 契约验证工具 | `tools/` | ✅ freeze 已交付;verify 4 pass / 5 pending(附证据) |
| 契约测试 + fixtures | `tests/` | ✅ 47 用例全绿 |
| ADR / 兼容性补丁说明 | `docs/adr/`、`docs/compat/` | ✅ ADR001–006 + patch-notes |
| 组件锁与兼容性证据 | `compat/` | ✅ components.lock / compatibility / dependency-tree / tool-inventory |

## 快速开始

环境要求:**Node >= 22.19**、**pnpm 10**(`packageManager` 已固定为 `pnpm@10.33.0`)。

```bash
pnpm install        # 安装工作区依赖
pnpm build          # tsc -b,按 project references 顺序构建
pnpm test           # vitest run
pnpm lint           # eslint packages apps tools
```

已实现的包(`@data-analyst/contracts`、`@data-analyst/core`)构建产物输出到各自 `dist/`,以 workspace 依赖(`workspace:*`)相互引用。

## 架构

### 包依赖(monorepo)

```
apps/cli ──► packages/dsh-integration ──► packages/core ──► packages/contracts
                    │                          ▲
                    └──── 依赖 ────────────────┘
python/analyst_runtime(独立,经 CLI doctor 探测)
```

- **contracts**(§8/§10/§17/§18):纯 zod Schema + 类型 —— 12 个实体、`DataRef`/`ArtifactRef`、四个端口(Workspace/Notebook/Quality/Database)、统一错误 `AnalystError`(15 个错误码 + HTTP 映射)、产品配置 Schema、`newId()`/`nowIso()`。禁止导入 DSH/React/Python,由导入守卫测试强制。
- **core**(§9/§18):配置加载(内置默认 → YAML 文件 → 固定映射环境变量 → zod 校验)、§9 目录布局解析(`workspaces/{ws}/datasets/{ds}/versions/{vid}` 等,一律校验 UUID,不接受调用方拼接的任意绝对路径)、`RepositoryPort` + `InMemoryRepository`(JSON 快照持久化;SQLite 按决策 D1 推迟到 M1)。
- **dsh-integration**(计划):`buildDshLaunchArgs(config)` + `spawnDsh()` —— `child_process.spawn` 仅用 argv 数组启动本地 DSH 二进制,禁止 npx 下载。

### 运行时形态(M0 冻结的五个上游组件)

| 组件 | 冻结版本 | 角色 |
| --- | --- | --- |
| `@deepseek-ai/dsh` | 0.2.0-rc.2 | Agent Harness(bin `dsh`,profile 强校验) |
| `@beihaizb/dsh-notebook` | 0.2.4 | `nb_*` 工具,每 Session 独立 notebook/kernel |
| `dsh-data-quality` | 0.3.18 | `data_profile/clean/verify/report` |
| `@yejiming/dsh-data-agent` | 0.2.2 | MySQL/PG/SQLite 等 9 种数据库 |
| `@changfenhuang/dsh-genui` | 0.11.4 | registry/DOM 双渲染(**必须用 scoped 包名**,npm 上无 scope 的 `dsh-genui` 是仿冒包) |

五个组件冻结在同一 DSH 兼容版本,精确版本与 integrity 哈希记录于 `compat/components.lock.json`(§21),由 `pnpm freeze` 生成。

## 目录结构

```
data-mate/
├── apps/cli/              # commander CLI(doctor/version/components/config/serve)
├── packages/
│   ├── contracts/         # §8 实体、§10 数据引用、§11 端口、§17 错误、§18 配置 Schema
│   ├── core/              # §18 配置加载、§9 路径布局、内存 Repository
│   └── dsh-integration/   # DSH 启动集成
├── python/analyst_runtime/ # doctor 自检(ipykernel/jupyter_client/nbformat 可导入性)
├── tools/                 # freeze-components.ts、verify-contracts.ts
├── tests/
│   ├── contracts/         # 契约测试套件
│   ├── fixtures/          # fixture_sales.csv(A 17.5% / B 8.333333% / 总体 13.5714%)、fixture_edge.csv
│   └── e2e/
├── compat/                # components.lock.json + compatibility.json(证据:命令 + 时间戳)
├── config/
│   ├── defaults.yaml      # 内置默认配置的镜像
│   └── dev.example.yaml   # 开发环境示例
└── docs/
    ├── Data_Analysis_Agent_Requirements_Detailed_Design_v0.1.md
    ├── adr/               # ADR001–006
    └── compat/            # 补丁说明
```

## 脚本说明

| 脚本 | 作用 | 状态 |
| --- | --- | --- |
| `pnpm build` / `pnpm clean` | `tsc -b` 增量构建 / 清理 | ✅ 可用 |
| `pnpm test` / `pnpm test:watch` | vitest 单测 | ✅ 47 用例全绿 |
| `pnpm lint` | eslint(flat config) | ✅ 可用 |
| `pnpm doctor --config …` | 环境自检:Node 版本、Python 依赖、目录可写性、组件锁新鲜度;**绝不安装依赖** | ✅ 可用 |
| `pnpm version --json` | 离线 BOM 版本摘要(五组件 + integrity) | ✅ 可用 |
| `pnpm freeze` | 安装五个固定版本组件进隔离 profile,生成 `compat/components.lock.json` | ✅ 可用(幂等) |
| `pnpm verify` | 执行 §7 兼容性矩阵,生成 `compat/compatibility.json` | ✅ 可用(4 pass / 5 pending) |
| `pnpm config:validate` | 校验 YAML 配置 | ✅ 可用 |

## 配置

加载顺序(§18,`packages/core/src/config-loader.ts`):

1. 内置默认(镜像 `config/defaults.yaml`);
2. 用户 YAML 文件(相对路径以配置文件所在目录为基准);
3. 固定映射环境变量(**仅接受**):`DATA_ANALYST_SERVER_HOST`、`DATA_ANALYST_SERVER_PORT`、`DATA_ANALYST_DATA_DIR`、`DATA_ANALYST_STATE_DIR`、`DATA_ANALYST_CACHE_DIR`;
4. zod(`ProductConfigSchema`)严格校验,失败抛 `CONFIG_INVALID`,未知字段拒绝。

## 统一错误(§17)

所有错误经 `AnalystError`(`packages/contracts`)承载,负载为 `{ code, message, request_id, run_id, retryable, details }`;`details` 不得包含密钥、完整模型请求或未过滤的数据样本。错误码全集与 HTTP 映射见 `packages/contracts/src/errors.ts` 的 `httpStatusFor()`:`CONFIG_INVALID`、`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`CELL_REVISION_CONFLICT`、`SESSION_BUSY`、`UNPROCESSABLE`、`RATE_LIMITED`、`PAYLOAD_TOO_LARGE`、`ENVIRONMENT_INCOMPLETE`、`MODEL_UNAVAILABLE`、`DATABASE_UNAVAILABLE`、`TIMEOUT`、`INTERNAL`。

## 技术栈

- TypeScript 5.9,`strict` + `noUncheckedIndexedAccess`,`NodeNext` 模块,project references(composite)增量构建
- zod v4(唯一运行时 Schema 库,`z.infer` 保证 Schema 与 TS 类型同源,§23)
- vitest 3、eslint 9(flat config)、pnpm 10 workspace
- js-yaml(仅配置加载)、commander(仅 CLI)

## 开发指南

- **新增包**:在 `packages/<name>` 建 `package.json`(`"type": "module"`)+ `tsconfig.json`(extends `tsconfig.base.json`,`references` 声明依赖包),并加入根 `tsconfig.json` 的 `references`。
- **测试**:vitest 匹配 `packages/**`、`apps/**`、`tests/**`、`tools/**` 下的 `*.test.ts`;契约测试须覆盖 `CONFIG_INVALID` 用例与 fixture 数值断言(总转化率 = 总成交/总访客,不得平均各渠道比率)。
- **导入守卫**:`packages/contracts` 禁止导入 DSH/React/Python 侧代码。
- **验证纪律**(§7):无模型端点/内核/数据库环境下无法验证的项,状态只能记 `pending` 并附证据,**绝不伪造 pass**;`compatibility.json` 状态严格为 `pass | fail | pending`。
- **路径纪律**(§9):业务代码不接受调用方拼接的任意绝对路径,一律经 `packages/core` 的 `resolvePaths` 及其派生函数(内部对 ID 做 UUID 校验)。

## 相关文档

- 详细设计:`docs/Data_Analysis_Agent_Requirements_Detailed_Design_v0.1.md`
- 架构决策记录:`docs/adr/`(ADR001 模型服务外置、ADR002 部署无关、ADR003 插件优先复用、ADR004 dsh-notebook 主 Notebook Runtime、ADR005 文件数据引用与不可变版本、ADR006 单 Kernel 串行执行)— 待补
- 兼容性与组件冻结证据:`compat/`、`docs/compat/` — 待生成
