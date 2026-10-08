# ADR005:文件数据引用与不可变版本

- 状态:已接受(M0)
- 日期:2026-10-08

## 背景

设计文档 §8/§15:DataRef 携带 row_count(可 null)、completeness、scope;DatasetVersion 一经创建不可变;SQL 结果物化为文件工件(Artifact)。M0 无数据库端点,文件数据路径是唯一可落地验证的引用形态。

## 决策

数据引用与不可变版本:DataRef 按 `DataRefSchema` 承载(row_count 可 null,completeness/scope 必填);版本实体 `DatasetVersion` 一经创建不可变,完整性以 sha256 佐证。SQL 物化依赖数据库端点,属 M1(compatibility.json 的 `sql-materialization` 记 pending,附证据)。

## 适用范围

数据集上传/登记/版本化;质量报告引用;SQL 结果物化(M1);Artifact 引用。

## 实现位置

- `packages/contracts/src/data-ref.ts`(`DataRefSchema` / `ArtifactRef` / `AccessScope` / `ResolvedData`)
- `packages/contracts/src/entities.ts`(`DatasetVersionSchema`)
- `packages/core/src/hashing.ts`(`sha256File` 流式哈希,§21 integrity 证据)

## 验证方法

`pnpm test`(contracts 单测 + repository 快照往返);`pnpm verify`(`quality-computation` pass:进程内质量计算前后 fixture sha256 一致;`sql-materialization` pending 附证据)。
