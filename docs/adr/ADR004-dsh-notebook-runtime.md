# ADR004:dsh-notebook 为主 Notebook Runtime

- 状态:已接受(M0)
- 日期:2026-10-08

## 背景

设计文档 §12 与上游事实:`@beihaizb/dsh-notebook@0.2.4` 提供 25 个 `nb_*` 工具,每 Session 独立 notebook/kernel/cwd;Python 侧依赖 ipykernel + jupyter_client + nbformat。M0 环境缺内核栈(analyst_runtime doctor 证据:ipykernel/jupyter_client/nbformat 模块缺失)。

## 决策

Notebook 运行时以 dsh-notebook 为主,产品不自建内核管理、不启动第二个 Kernel(§23);Python 侧 `analyst_runtime` 仅做只读环境自检(绝不安装依赖)。单 Kernel 串行执行与租约语义(`KernelLease` 以 `session_id` 为主键,一 Session 一租约)在领域层预留,M1 联调验证。

## 适用范围

Notebook 双 Session 映射、Cell 生命周期(registered/running/completed/failed/interrupted)、内核租约与中断宽限。

## 实现位置

- `packages/contracts/src/entities.ts`(`KernelLeaseSchema`:session_id 主键、epoch、status 枚举、state_dirty)
- `packages/core/src/repository.ts`(`kernelLeases` 按 session_id 键控,快照往返含 KernelLease)
- `python/analyst_runtime/analyst_runtime/doctor.py`(只读探测,缺依赖输出 warn 并退出 0)

## 验证方法

`pnpm test`(repository.test.ts:双租约按 session_id 独立存取;snapshot 往返);`PYTHONPATH=. python3 -m analyst_runtime doctor --json`(缺依赖时 warn,不安装);`pnpm verify`(`notebook-kernel-stack` 检查项按证据记 pending,附缺失模块清单)。Cell 生命周期端到端验证在 M1。
