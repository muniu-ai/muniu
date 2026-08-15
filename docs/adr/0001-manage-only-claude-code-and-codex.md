# ADR 0001：仅管理 Claude Code 与 Codex

## 状态

已接受

## 背景

`docs/MUNIU_CCSWITCH_REDESIGN_PLAN.md` 将木牛定义为本地优先的 AI Coding Agent 管理平台。产品需要借鉴 CC Switch，但不照搬其完整的多工具范围。

## 决策

木牛只管理 Claude Code 与 Codex。

本轮改造不得增加 Gemini、OpenCode、OpenClaw、Hermes、Claude Desktop 或 Codex OAuth 反向代理支持。

## 影响

- `AgentProvider` 保持为 `"claude" | "codex"`。
- Provider 预设与桌面导航只面向 Claude Code 和 Codex。
- 后续扩展必须证明不会扩大被管理应用的范围。
