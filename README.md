# data-analyst

基于 DeepSeek Harness(DSH)+ 四个插件构建的数据分析 Agent。本仓库当前处于 **M6 阶段**:领域层、REST API(`serve`)、Agent 多轮工具回路与端到端链路已落地,并具备本机构建→安装→部署的完整流程(见下文[部署](#部署))。

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
| 组件冻结 / 契约验证工具 | `tools/` | ✅ freeze / profile:assemble 已交付;verify 4 pass / 5 pending(附证据) |
| 契约测试 + fixtures | `tests/` | ✅ 248 用例全绿 |
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

## 部署

本节是经本机(WSL2)实际验证过的部署流程。

### 1. 构建发行物

```bash
pnpm build         # tsc -b 全量构建
pnpm dist:build    # 组装发行物 → dist/distributions/(目录 + 同名 .tar.gz,含 manifest 与 sha256)
```

### 2. 本机安装

```bash
packaging/host/install.sh --media dist/distributions/<发行物目录或.tar.gz> --prefix ~/.local/data-analyst
```

安装结果:`$PREFIX/releases/<版本>/` + `current` 符号链接 + `bin/data-analyst` 包装器。脚本末尾会打印启动示例。可选 `--systemd` 安装 `packaging/host/systemd/data-analyst.service` 单元;回滚用 `packaging/host/rollback.sh`。

### 3. 配置模型与凭据

复制 `$PREFIX/current/config/config.example.yaml` 为实际配置,关键字段:

```yaml
model:
  profile_id: <固定 UUID>          # 必须是合法 UUID,否则 serve 启动即崩
  protocol: openai-chat             # 当前唯一协议;MiniMax/DeepSeek 等用其 OpenAI 兼容端点
  base_url: https://api.minimaxi.com/v1
  model: MiniMax-M3
  credential_ref: env:MINIMAX_API_KEY   # 只存引用,绝不把密钥写进配置
  capabilities:
    streaming: required
    tool_calling: required          # agent 工具回路必需
    vision: disabled
```

密钥放环境变量(建议独立 env 文件,权限 600):

```bash
echo 'MINIMAX_API_KEY=sk-xxxx' > ~/.local/data-analyst/model.env && chmod 600 ~/.local/data-analyst/model.env
# 启动 serve 前必须先加载:
set -a; . ~/.local/data-analyst/model.env; set +a
```

**重要**:配置 yaml 的 `model` 段只做**首次种子**。运行期 ModelProfile 的权威持久化在 `$STATE_DIR/product.sqlite`,之后修改要走 REST API(带乐观锁):

```bash
TOKEN=$(cat $PREFIX/current/config/.m0/state/credentials/local-token)
# 更新(注意 expected_revision 要与当前 revision 一致):
curl -X PUT http://127.0.0.1:3080/api/v1/model-profiles/<profile_id> \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{ ... }'
# 五层能力探测(network/auth/chat/streaming/tool_calling):
curl -X POST http://127.0.0.1:3080/api/v1/model-profiles/<profile_id>/test -H "Authorization: Bearer $TOKEN"
```

任何 `required` 能力探测未 `passed`,API 层会拒绝启动 Agent。

### 4. 启动产品 API

```bash
cd $PREFIX
set -a; . ./model.env; set +a
nohup node current/app/dist/index.js serve --config ./current/config/config.example.yaml > serve.log 2>&1 &
# 自检:curl http://127.0.0.1:3080/healthz ;认证边界外的就绪探测:/readyz
```

API 前缀 `/api/v1`,认证为 `Authorization: Bearer <local-token>`(token 在 `current/config/.m0/state/credentials/local-token`)。

### 5. 组装产品 DSH profile

Web UI 运行在 DSH profile(`~/.dsh/profiles/<name>/`)之上,profile 必须自带五组件依赖并由 profile 内 CLI 引导。用工具一键组装(前置:已在本仓库跑过 `pnpm freeze`,它同时生成 `.m0/profile` 与 `compat/components.lock.json`):

```bash
pnpm profile:assemble                              # 默认 profile 名 data-analysis-m0,装到 ~/.dsh/profiles/
pnpm profile:assemble --name <name> --home <dir>   # 自定义名称与 DSH_HOME
```

工具流程全部经 dsh 官方 CLI:从内置 `web` 模板初始化 profile → 向模板的 `pnpm-workspace.yaml` 登记构建脚本审批并把 `autoInstallPeers` 翻为 `true`(与 freeze 同源,见 `tools/profile-workspace.ts`;模板默认 false 会让 `dsh-app-boot` 的运行时 peer 缺失而启动崩,见 `docs/compat/patch-notes.md`)→ 逐个 `dsh plugin --profile <name> add <pkg>@<精确版本>` 安装五组件(dsh 插件管理器的 peer 门禁比裸 `pnpm add` 严格,notebook 对 dsh 0.2.0-rc.2 需要 `allow-version` 精确版本豁免,工具自动处理)→ 校验 `dsh.profile.bundles` 包含四插件(缺失自愈补登)→ **安装产品品牌定制**(`packaging/brand/dsh-brand-analyst` 槽位插件覆盖侧边栏 logo/名称与首屏标志,`tools/runtime-patches.ts` 品牌文案补丁替换首屏标语与页面标题;品牌常量单一来源 `tools/brand.ts`)→ 应用其余兼容补丁 → `--dump-config` 验证组合树。

品牌文案/图标要改时:改 `tools/brand.ts`(标语、产品名)与 `packaging/brand/dsh-brand-analyst/lib/client.js`(logo SVG、侧边栏名),对新环境重跑 `profile:assemble` 即生效;已有 profile 可用 `pnpm runtime:patch --profile <profile目录> --apply` 重打文案补丁(先不带 `--apply` 可预览变更,幂等;注意 pnpm 会把 `--` 原样传给脚本,不要写成 `-- --profile`)。

手工等价流程(需要排查细节时):

```bash
.m0/profile/node_modules/.bin/dsh <name> --from-default-profile web --dump-config   # 初始化
# 向 <profile>/pnpm-workspace.yaml 登记构建脚本审批(node-pty/koffi/protobufjs/@google/genai/@deepseek-ai/dsh-subprocess-local)
.m0/profile/node_modules/.bin/dsh plugin --profile <name> add <pkg>@<版本>          # 五组件逐个
.m0/profile/node_modules/.bin/dsh --profile <name> --dump-config                    # 验证组合树
```

### 6. 启动 DSH Web UI

Web UI 由产品 profile 的 bundles 列表 + `cordis.patch.yml` 用户补丁层组装(第 5 步已组装完成)。两条纪律:

- **profile 必须自带 `@deepseek-ai/dsh` CLI 并用它引导**(写进 profile 的 dependencies)。用外部二进制引导会导致 boot 进程与 profile 内 `dsh-config-editor` 各持一份 `dsh-app-boot` 模块实例,settings 写入报 "profile reload requires the root Include entry"(见 FAQ);
- 自定义 profile 直接 `dsh --profile <name>` 引导(`dsh web` 子命令不接受 `--profile`):

```bash
nohup ~/.dsh/profiles/<name>/node_modules/.bin/dsh --profile <name> --no-open --host 127.0.0.1 --port 8081 > dsh-web.log 2>&1 &
# 访问链接(含随机 token,每次启动变化)打印在日志首行:
# dsh web: http://127.0.0.1:8081/?token=...
```

向 profile 添加新插件条目要在 `cordis.patch.yml` 用 `- insert:` 包裹新条目(`id+name` 直接写只对已存在条目生效,新条目会警告 "entry not found" 被忽略);停用条目用 `- id: <id>` + `disabled: true`。

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
| `pnpm test` / `pnpm test:watch` | vitest 单测 | ✅ 248 用例全绿 |
| `pnpm lint` | eslint(flat config) | ✅ 可用 |
| `pnpm doctor` | 环境自检:Node 版本、Python 依赖、目录可写性、组件锁新鲜度;**绝不安装依赖**(脚本已内置 `--config config/dev.example.yaml`,自定义配置用 `pnpm run doctor --config=<路径>`;注意 pnpm 会拦截裸 `--config`) | ✅ 可用 |
| `pnpm version --json` | 离线 BOM 版本摘要(五组件 + integrity) | ✅ 可用 |
| `pnpm freeze` | 安装五个固定版本组件进隔离 profile,生成 `compat/components.lock.json` | ✅ 可用(幂等) |
| `pnpm profile:assemble` | 从内置 web 模板组装 `~/.dsh/profiles` 产品 profile(五组件精确版本 + 构建审批 + 品牌定制 + 兼容补丁,部署第 5 步) | ✅ 可用(幂等不可覆盖已有 profile) |
| `pnpm runtime:patch` | 对已组装 profile 应用兼容/品牌文案补丁(`--profile <dir> [--apply]`,缺省 dry-run) | ✅ 可用(幂等,含备份) |
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

## FAQ

**Q: Web UI 显示"暂时无法保存确认状态,请重试。"(或保存任何设置报 "profile reload requires the root Include entry")**

profile 由外部 DSH 二进制引导,boot 进程与 profile 内插件各持有一份 `dsh-app-boot` 模块实例,根 Include 登记在另一份的 `bootstrapIncludes` WeakMap 里。修法:把 `@deepseek-ai/dsh` 加进 profile 的 dependencies,并始终用 `~/.dsh/profiles/<name>/node_modules/.bin/dsh` 引导(见部署第 6 步;profile 组装见第 5 步)。

**Q: 重启 dsh/serve 报 `EADDRINUSE: 8081/3080 already in use`**

dsh 的 `bin.js` 会派生子 node 进程,而后台化启动时 `$!` 记到的往往是包装 shell 的 pid——只 kill pid 文件留不下子进程。用 `ss -tlnp | grep <端口>` 找到真正的监听 pid 全部 kill 后再启动。

**Q: serve 启动即崩,报 zod "Invalid UUID"**

`model.profile_id` 不是 UUID。`ModelProfileSchema.id` 要求 UUID,示例配置里的占位符也必须是合法 UUID 形式。

**Q: 改了配置里的模型信息,`model-profiles/{id}/test` 探测却还在连旧端点**

运行期 ModelProfile 权威在 `$STATE_DIR/product.sqlite`,配置 yaml 只做首次种子。用 `GET /api/v1/model-profiles/<id>` 看运行期实际值,用 `PUT`(带 `expected_revision`)更新,再重跑探测。

**Q: 探测报"无法连接模型服务",但同机 curl 能通**

先确认 serve 进程环境里有凭据:`tr '\0' '\n' < /proc/<serve_pid>/environ | grep <ENV_NAME>`。`credential_ref: env:XXX` 在进程启动时解析,启动前忘了加载 env 文件就会失败。

**Q: MiniMax 模型怎么接?**

当前协议层只支持 `openai-chat`。MiniMax 的 OpenAI 兼容端点为 `https://api.minimaxi.com/v1`(海外站 `api.minimax.io`),同一把 key 也可用于其 `/anthropic` 端点。`tool_calling` 建议 `required` 并跑一次五层探测确认。注意 M3 系列回复的 content 内自带 `<think>…</think>` 思维链,展示层如需干净正文要自行过滤。

**Q: `.m0/profile` 的 node_modules 全是断链 / 根 pnpm-lock 出现上万行假差异**

`.m0/profile` 是独立 pnpm workspace(自带 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml`)。断链用 `pnpm freeze` 幂等重建;根 lock 若残留 `.m0/profile` importer,在仓库根跑 `pnpm install --lockfile-only` 重新生成即可。

**Q: `pnpm freeze` 报 `ERR_PNPM_IGNORED_BUILDS`,或报 `ENOENT .../dsh-client-ui-sidebar-documentpreview/package.json`**

freeze 会在 `.m0/profile/pnpm-workspace.yaml` 缺失时自动生成正确配置(`nodeLinker: hoisted` 布局 + 五个依赖包的构建脚本审批,按实际 pnpm 版本选择 `allowBuilds`/`onlyBuiltDependencies` 方言,见 `tools/profile-workspace.ts`)。该文件被 gitignore,陈旧或损坏时删除 `.m0/profile` 重跑 `pnpm freeze` 即可。老环境手动修法:构建脚本审批用 `pnpm approve-builds --all`(pnpm v11 已将 `onlyBuiltDependencies` 更名为 `allowBuilds`,写 package.json 的 `pnpm` 字段无效);补丁目标 documentpreview 是 dsh 的传递依赖,`tools/runtime-patches.ts` 按 `node_modules/<包名>` 直连,isolated 布局下不在顶层,须改 `nodeLinker: hoisted` 并重装(改布局必须重装)。注意 pnpm 版本按 cwd 经 corepack 解析:仓库根是 pin 的 10.33.0,profile 目录则用全局版本,方言要按 profile 目录实测选择。

**Q: WSL 下 vitest 偶发 worker RPC 超时退出**

`/mnt/c` 的 9p 文件系统 I/O 抖动所致,重跑即可;仓库放在 WSL 原生文件系统(如 `~/`)可根治。

## 相关文档

- 详细设计:`docs/Data_Analysis_Agent_Requirements_Detailed_Design_v0.1.md`
- 架构决策记录:`docs/adr/`(ADR001 模型服务外置、ADR002 部署无关、ADR003 插件优先复用、ADR004 dsh-notebook 主 Notebook Runtime、ADR005 文件数据引用与不可变版本、ADR006 单 Kernel 串行执行)— 待补
- 兼容性与组件冻结证据:`compat/`、`docs/compat/` — 待生成
