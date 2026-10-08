# M0 补丁与兼容性说明(patch notes)

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
