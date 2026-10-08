# ADR002:部署无关

- 状态:已接受(M0)
- 日期:2026-10-08

## 背景

设计文档 §22:同一发行物需支持宿主安装与容器交付;可写路径(data/state/cache)必须显式指定,产品不得硬编码目录假设。

## 决策

路径、端口等全部来自 §18 配置链(内置默认 → 配置文件 → 固定映射环境变量 `DATA_ANALYST_*`),业务代码不接受调用方拼接的任意绝对路径。目录布局由 `resolvePaths` 统一推导(§9),相对路径以配置文件所在目录为基准。

## 适用范围

所有文件读写、状态落盘、DSH 状态目录、凭据目录;宿主与容器共用同一配置语义。

## 实现位置

- `packages/core/src/paths.ts`(`resolvePaths`:dataDir/stateDir/cacheDir/workspacesDir/productStateFile/dshStateDir/credentialsDir)
- `packages/core/src/config-loader.ts`(`SUPPORTED_ENV_KEYS` 固定映射,禁止任意环境变量拼入配置)
- `config/defaults.yaml` + `config/dev.example.yaml`(示例布局)

## 验证方法

`pnpm test`(packages/core/src/paths.test.ts:相对目录以配置目录解析、绝对目录保持不变、§9 派生布局断言);`pnpm doctor --config config/dev.example.yaml`(doctor 只探测可写性,绝不创建/安装)。
