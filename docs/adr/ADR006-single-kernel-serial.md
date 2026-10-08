# ADR006:单 Kernel 串行执行

- 状态:已接受(M0)
- 日期:2026-10-08

## 背景

设计文档 §23:一 Session 一 Kernel;Cell 串行执行,中断宽限 `interrupt_grace_seconds`;KernelLease 以 session 为主键。M0 环境无内核栈(ipykernel 缺失),无法联调执行语义,先固化实体与存储契约。

## 决策

KernelLease 以 `session_id` 为主键(一 Session 一租约),Cell 在租约内串行执行;租约含 epoch 与状态机(starting/idle/busy/interrupting/failed/stopped)。领域层提供不可变实体与按 session_id 键控的存储;执行调度属于 M1(依赖内核栈)。M0 只交付契约与存储语义,不伪造执行验证。

## 适用范围

Cell 执行队列、中断与超时路径、内核租约续期/回收;后续 Agent Loop 的 Kernel 交互。

## 实现位置

- `packages/contracts/src/entities.ts`(`KernelLeaseSchema`:session_id / kernel_id / epoch / status / state_dirty / last_used_at)
- `packages/core/src/repository.ts`(`kernelLeases` 以 session_id 键控;快照往返)
- `python/analyst_runtime`(只读探测内核栈可导入性,不承载执行)

## 验证方法

`pnpm test`(packages/core/src/repository.test.ts:双租约按 session_id 独立、快照往返保留 KernelLease、非法实体拒绝);`pnpm verify`(`notebook-kernel-stack` 检查项按证据 pending,绝不记 pass)。串行执行与中断语义的运行时验证在 M1。
