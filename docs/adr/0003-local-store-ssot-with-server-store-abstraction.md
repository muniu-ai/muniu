# ADR 0003：本地 Store 是桌面端唯一事实来源

## 状态

已接受

## 背景

v0.1 API 使用内存状态，`prisma/schema.prisma` 则为未来 PostgreSQL 服务端模型保留了草案。改造计划要求以本地 SQLite store 作为桌面端事实来源，同时保留未来接入 server store 的路径。

## 决策

Provider、projection、proxy 和桌面控制面状态由 `packages/store` 下的本地 store abstraction 统一管理。

当前实现使用文件持久化 local store 与加密 local secret vault，以先建立 SSOT 契约和可测试性。未来的 SQLite migration runner 可以在不改变 package 边界的前提下替换底层存储引擎。

## 影响

- Claude/Codex live config 是投影，不是事实来源。
- API 与桌面端从 `packages/store` 读取 Provider 状态。
- 测试可先用临时目录验证 store，之后复用同一行为契约验证 SQLite。
