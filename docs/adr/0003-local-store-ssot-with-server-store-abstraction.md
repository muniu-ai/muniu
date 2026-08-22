# ADR 0003：本地 Store 是桌面端唯一事实来源

## 状态

已接受

## 背景

v0.1 API 使用内存状态，`prisma/schema.prisma` 则为未来 PostgreSQL 服务端模型保留了草案。改造计划要求以本地 SQLite store 作为桌面端事实来源，同时保留未来接入 server store 的路径。

## 决策

Provider、projection、proxy 和桌面控制面状态由 `packages/store` 下的本地 store abstraction 统一管理。

当前实现使用 SQLite schema v2 作为 local store，并继续使用加密 local secret vault。schema v2 将 provider、health、proxy log、replay 与 extensions 分表保存；旧 `local_state` JSON blob 首次打开时先生成权限 0600 的内容寻址备份，再以 `BEGIN IMMEDIATE` 单事务迁移并核对数量和 digest。迁移失败回滚，旧 blob 与备份均保留。

## 影响

- Claude/Codex live config 是投影，不是事实来源。
- API 与桌面端从 `packages/store` 读取 Provider 状态。
- 测试使用同一 store 行为契约验证 SQLite，并覆盖 WAL/FULL pragma、STRICT 表、并发 writer、迁移回滚、权限和 symlink 边界。
