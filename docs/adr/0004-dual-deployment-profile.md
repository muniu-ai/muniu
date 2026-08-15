# ADR 0004: Local 与 Enterprise 双部署 Profile

## Status

Accepted

## Decision

同一领域内核支持 `local` 与 `enterprise`。local 保留隐式租户、loopback 和现有本地存储；enterprise 要求认证、tenant scope、持久队列、对象存储、强审计与能力匹配。非 loopback 且缺少认证时 fail closed。

## Consequences

所有新增 repository/API/worker 接口必须接受可选兼容的 RequestContext，并在 enterprise 模式强制存在。
