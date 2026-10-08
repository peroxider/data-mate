# ADR003:插件优先复用

- 状态:已接受(M0)
- 日期:2026-10-08

## 背景

设计文档 §7 表与 §24:五个上游组件(dsh / dsh-notebook / dsh-data-quality / dsh-data-agent / dsh-genui)以固定版本复用;若需大幅重写才能接入,必须先修订适配决策,不得静默 fork。

## 决策

五个组件按冻结版本(pnpm `--save-exact` + sha512 integrity)安装进隔离 profile `.m0/profile`,产品不 fork、不打源码补丁。适配只经产品侧薄层(`packages/dsh-integration`:argv 数组 + `shell:false` 受控启动)。已知缺口如实记录:dsh-data-agent 工具名未公开文档化(tool-inventory 静态扫描 0 命中,runtime_confirmed=pending);genui 必须用 scoped 包 `@changfenhuang/dsh-genui`(npm 上无 scope 的 `dsh-genui` 是无关仿冒包,freeze 脚本内置断言)。

## 适用范围

全部五个冻结组件;任何后续新增插件的引入流程。

## 实现位置

- `tools/freeze-components.ts`(冻结 + 防仿冒断言 + `compat/components.lock.json` / `dependency-tree.json` / `tool-inventory.json`)
- `packages/dsh-integration/src/launch.ts`(`resolveDshBin` / `buildDshLaunchArgs` / `spawnDsh`,禁 npx 下载)
- `apps/cli/src/commands/components.ts`(`components lock` 委托 freeze)

## 验证方法

`pnpm freeze`(幂等重跑,锁与安装一致性断言);`pnpm verify`(`install-and-lock` 与 `profile-composition` 检查项,后者按证据记 pending);`node apps/cli/dist/index.js version --json`(BOM 含五组件精确版本与 integrity)。
