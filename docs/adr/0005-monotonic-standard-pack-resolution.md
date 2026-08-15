# ADR 0005: Standard Pack 单调收紧解析

## Status

Accepted

## Decision

作用域顺序为 builtin、organization、team、project、service、task。required/deny/protected 取并集，allowlist 取交集，预算取最小值，审批取更严格值。只有明确标为可豁免的规则才能通过限时、具名、经审批 waiver 放宽。

## Consequences

每次解析输出唯一 GovernanceSnapshot 与 digest；冲突或空 allowlist 在执行前失败。
