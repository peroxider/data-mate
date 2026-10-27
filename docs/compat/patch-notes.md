# 补丁与兼容性说明(patch notes)

## 2026-10-23 浏览器端到端回归补丁

当前产品在锁定上游包之上应用仓库维护的兼容层，原 M0 的“零源码补丁”记录仅描述下文的历史冻结状态。

补丁入口：`tools/runtime-patches.ts`；命令：`tools/apply-runtime-patches.ts`。适用版本：文档预览 `0.2.0-rc.2`、Notebook `0.2.4`、GenUI `0.11.4`。

- HTML 预览：以 `srcDoc` 加载已打包文档，避免嵌入式浏览器无法导航父页面 Blob URL 而出现空白。保留 `sandbox="allow-scripts"`、不增加 `allow-same-origin`，继续使用原资源打包、更新隔离和清理逻辑。
- Notebook：公开快照排除内部 `_runJob` Promise；Agent 的 `nb_kernel_restart_and_run_all` 与 `nb_run_all` 一样传入 `wait:true`，等待逐单元执行结果。HTTP 页面异步排队行为保持不变。
- GenUI：将表格 `details:true/false` 视为没有实际行详情数据的显示提示并规范化为省略字段。合法行详情数组保留；对象、字符串等不合法详情继续报错。修复同时覆盖源代码、宿主验证、浏览器和离线导出运行时，不全局放宽字段校验。

在安装 profile 的环境中执行（工作目录为本仓库）：

```sh
# 只校验版本、补丁锚点并显示预期变化，不修改文件
node --import tsx tools/apply-runtime-patches.ts --profile /path/to/profile
# 明确应用；应用后重启对应 DSH 服务并刷新页面
node --import tsx tools/apply-runtime-patches.ts --profile /path/to/profile --apply
```

也可使用 `pnpm runtime:patch --profile /path/to/profile --apply`。`pnpm freeze` 在安装精确版本后自动应用兼容层，另写 `compat/runtime-patches.json`；npm integrity 继续描述上游输入，不冒充补丁后的文件哈希。

应用前会检查全部包版本与替换锚点，任何不匹配都在写文件前终止。写入使用临时文件加原子替换，避免修改 pnpm 共享硬链接；重复应用无变化。原文件与前后 SHA256 保存在目标 profile 的 `.data-mate-runtime-patches/`。该备份目录不进入发行物，补丁清单可随发行物保留。

回归用例在 `tools/runtime-patches.test.ts`，覆盖 HTML 的 iframe 属性、队列 Promise 隔离、等待完成语义、GenUI 嵌套表格和正常/异常详情。未安装冻结 profile 的源码环境会明确跳过这些依赖集成用例。

## 2026-10-27 产品 profile 组装路径

- 组装工具:`tools/assemble-dsh-profile.ts`(`pnpm profile:assemble`)。全部经 dsh 官方 CLI:`--from-default-profile web` 初始化、`dsh plugin --profile <name> add` 逐个注册五组件精确版本、`--dump-config` 验证组合树;应用与 freeze 同源的 runtime-patches。沙箱与本机 `~/.dsh/profiles/data-analysis-m0` 均已验证(组合树含四插件,`.bin/dsh` 就位)。
- **dsh 插件管理器 peer 门禁比裸 `pnpm add` 严格**:`@beihaizb/dsh-notebook@0.2.4` 的 peer `@deepseek-ai/dsh-tools@^0.1.0-rc.6` 与 dsh 0.2.0-rc.2 不兼容,拒绝安装且原子回滚("nothing was installed")。须 `dsh plugin allow-version <pkg>@<ver> --dsh-version 0.2.0-rc.2 --accept-risk` 精确版本豁免后重试;工具检测到拒绝时自动豁免重试。豁免仅对精确版本对生效。
- **批量 `plugin add` 中断重试会丢 bundle 登记**:依赖写入 package.json,但 `dsh.profile.bundles` 不追加(重装已装包是 no-op,不会补登)。工具改为逐个安装,并在第 4 步自愈校验 bundles 完整性。
- **构建脚本审批的方言按目标目录实测**:pnpm 版本经 corepack 随 cwd 解析(仓库根 pin 10.33.0,profile 目录用全局 11.28.2),v11 只认 `allowBuilds`,v10 只认 `onlyBuiltDependencies`。工具以 profile 目录为 cwd 探测版本后选择方言(`tools/profile-workspace.ts`)。dsh 内置 profile 模板自带 `nodeLinker: hoisted`。

## 原 M0 冻结记录

- 生成:2026-10-08(`pnpm freeze` + `pnpm verify` 实际运行产物)
- 结论:**零源码补丁** —— 五个上游组件按原包精确版本使用,未 fork、未打补丁。

## 组件锁

`compat/components.lock.json`(§21 结构):五组件精确版本 + sha512 integrity + peer/直接依赖;`compat/dependency-tree.json` 全依赖树;`compat/tool-inventory.json` 静态工具清单(方法标注 static-regex-scan,runtime_confirmed=pending)。

| key | package | version |
| --- | --- | --- |
| dsh | @deepseek-ai/dsh | 0.2.0-rc.2 |
| dsh_notebook | @beihaizb/dsh-notebook | 0.2.4 |
| dsh_data_quality | dsh-data-quality | 0.3.18 |
| dsh_data_agent | @yejiming/dsh-data-agent | 0.2.2 |
| dsh_genui | @changfenhuang/dsh-genui | 0.11.4 |

防仿冒:freeze 内置断言 —— genui 只接受 scoped 包 `@changfenhuang/dsh-genui`(npm 上无 scope 的 `dsh-genui` 为无关仿冒包)。

## 兼容性结论(compat/compatibility.json)

pass=4:install-and-lock(锁与安装一致)/ quality-computation(进程内 dsh-data-quality 对 fixture 计算,原文件 sha256 前后一致)/ cli-boot(doctor + version 退出码 0)/ offline-static(仅静态 URL 扫描,注明非运行时断网验证)。

pending=5(附原始证据,绝不伪造):
1. profile-composition —— `DSH_HOME=<repo>/.m0 dsh --profile data-analysis-m0 --dump-config` 拒绝符号链接注册的 profile 目录,要求 `dsh plugin --profile data-analysis-m0 add <package>`(该路径经 pnpm 重新解析,M1 执行)。
2. notebook-kernel-stack —— ipykernel/jupyter_client/nbformat 缺失(环境准备项,产品绝不安装依赖)。
3. sql-materialization —— M0 无数据库端点(§7 属环境准备)。
4. model-convergence —— M0 无模型端点(内网 base_url 未配置)。
5. genui-runtime —— 需模型端点 + 浏览器 DOM 的运行时确认。

## 已知偏差与回退记录

- **profile 注册回退**:计划预想的 `dsh plugin --profile` pnpm 转发未验证;实际使用直接 `pnpm add --save-exact` 于 `.m0/profile` 并生成锁。组合启动待 M1 经官方 `dsh plugin --profile add` 重建后验证。
- **CLI components**:lock 已委托 `tools/freeze-components.ts`;verify 仍为诚实桩(提示由 verify-contracts 提供)。
- **doctor python 探测**:`python3 -m analyst_runtime doctor --json` 在未 pip 安装/PYTHONPATH 下如实报 warn(模块缺失),exit 0;不自动安装。

## M1 待办(承接 pending)

profile 组合启动(headless + 工具注册运行时确认)、Notebook 双 Session/Cell 生命周期、SQL 物化、模型汇聚、GenUI 双通道渲染;`pnpm verify` 的 pending 项随环境准备逐项转 pass/fail。
