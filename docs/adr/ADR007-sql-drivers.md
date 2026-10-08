# ADR007:SQL 驱动选型与只读/超时/截断的驱动侧语义

- 状态:已接受(M3)
- 日期:2026-10-08

## 背景

设计文档 §24 M3:SQLite/PostgreSQL/MySQL 三类真实环境接入,只读强制、查询超时与截断语义(T09/T10)。发行物为离线包:SQLite 必须零外部依赖开箱可用;PostgreSQL/MySQL 客户端库不允许随发行物强绑定(§7:CLI 不安装依赖)。node:sqlite 为同步 API,单条慢查询会阻塞主线程,无法实现真实的"超时中断"。

## 决策

1. **SQLite 用 node:sqlite + 独立子进程**:查询在一次性子进程内以 `readOnly: true` 打开数据库执行,主线程超时后 `SIGKILL` 强杀,获得真实的超时中断。不采用 worker_threads:其 `terminate()` 无法中断同步原生 SQLite 调用(如对无限递归 CTE 的 `COUNT(*)` 聚合,永不返回首行),且存活的 worker 会阻止宿主进程退出。写入语句在驱动层物理失败(只读打开),不依赖白名单单层防线。截断语义在子进程内取数到 maxRows+1/maxBytes 即停止,多取的一行不返回、仅标记 truncated(T09)。
2. **PostgreSQL/MySQL 懒加载 + 如实报错**:`pg`/`mysql2` 通过计算型模块说明符动态 import,依赖缺失时抛 `ENVIRONMENT_INCOMPLETE`(明确说明离线发行包不含该客户端),绝不静默降级、绝不安装依赖。超时交给服务端会话参数(`statement_timeout` / `MAX_EXECUTION_TIME`),行数上限由 SELECT/WITH 语句包装 LIMIT 实现。
3. **纵深防御三层**:契约层 `DataSourceBinding.readonly`、守卫层语句白名单(sql-guard:单语句 + 只读关键字 + 拒绝模式)、驱动层只读连接/会话参数。任何一层失效,另两层兜底;错误码 FORBIDDEN(白名单)/UNPROCESSABLE(多语句)/TIMEOUT(超时)。
4. **幂等在适配层**:同 source_id + idempotency_key 直接返回既有 DataRef(按 datasetVersions.manifest.source 反查),模型流重试不得重复执行 SQL。

## 适用范围

`packages/data-adapters` 全部驱动与 DatabaseAdapter;CLI `datasource`/`sql-query`/`m3-demo`;后续 Agent Loop 的查询结果 DataRef 引用。

## 实现位置

- `packages/data-adapters/src/drivers/sqlite-driver.ts`(CHILD_SOURCE + runQueryIsolated,SIGKILL 超时终止)
- `packages/data-adapters/src/drivers/pg-driver.ts`、`mysql-driver.ts`(懒加载 + 会话参数)
- `packages/data-adapters/src/sql-guard.ts`(只读守卫)、`database-adapter.ts`(幂等与物化)
- `packages/contracts/src/ports.ts`(QueryResultRef 含 dataset_id/version_id 回链)

## 验证方法

`pnpm vitest run packages/data-adapters`(T10:CREATE TABLE 因只读打开物理失败;无限递归 CTE 400ms 超时返回 TIMEOUT;多语句 statement_count=2;T09:maxRows/maxBytes 截断 → truncated);`pnpm vitest run tests/e2e`(真实 CLI 全链路,SQL 聚合与 Notebook stdlib 复算一致)。
