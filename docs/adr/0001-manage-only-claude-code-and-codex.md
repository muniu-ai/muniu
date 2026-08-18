# ADR 0001：Claude Code 与 Codex 的兼容范围

## 状态

已被内嵌 Agent 架构取代

本 ADR 仅作为历史决策记录。当前权威架构见 `docs/plans/2026-08-15-muniu-v0.1-master-design.md` 和 `docs/TECHNICAL_DESIGN.md`。

## 背景

`docs/MUNIU_CCSWITCH_REDESIGN_PLAN.md` 将木牛定义为本地优先的 AI Coding Agent 管理平台。产品需要借鉴 CC Switch，但不照搬其完整的多工具范围。

## 决策

木牛的核心运行时是直接连接模型 Provider API 的内嵌 Agent，不依赖 Claude Code 或 Codex CLI。

Claude Code 与 Codex CLI 只保留为显式启用的 legacy executor、配置投影和历史会话导入目标。本轮仍不增加 Gemini、OpenCode、OpenClaw、Hermes、Claude Desktop 或 Codex OAuth 反向代理支持。

## 影响

- 模型 Provider ID 与 Agent runtime ID 分离，不再用 Claude/Codex 应用枚举限制模型协议。
- 木牛启动、内嵌 Agent 会话和 Provider API 调用不得探测或启动 Claude/Codex binary。
- legacy 集成继续遵守显式启用、fail-closed、凭据不落日志的兼容边界。
