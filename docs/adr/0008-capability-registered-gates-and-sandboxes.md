# ADR 0008: Gate 与 Sandbox 能力注册

## Status

Accepted

## Decision

wire 层 Gate 使用稳定字符串 ID，并通过 capabilities API 暴露 runner、语言、证据格式和 enforcement level。保留旧 Gate ID 兼容。enterprise required gate 无 runner 或 skipped 时失败；弱能力 worker 不得领取强约束任务。

## Consequences

Desktop/CLI 不再硬编码完整 Gate 列表；worker claim 必须匹配 GovernanceSnapshot。
