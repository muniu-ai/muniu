# 子计划 03：模型、会话与公共协议实现计划

> **执行要求：** 使用 `dev-executing-plans` 逐任务执行此计划；计划执行不绑定任何外部 Agent CLI。

**目标：** 提供三类模型协议、持久会话和可通过 REST/SSE 使用的版本化 Agent API。

**架构：** 从 local-proxy 抽出 model client；本地 JSONL 是会话事实源、SQLite 是可重建投影，企业版使用 PostgreSQL 与对象存储。所有传输映射到 AgentSessionEventV1，不兼容 DSH rc5 wire/session 格式。

**技术栈：** Fastify 5、SSE、SQLite、PostgreSQL、OpenAI Chat/Responses、Anthropic Messages、DeepSeek API。

---

## 依赖与任务

- 依赖子计划 02 的 protocol/session/llm 稳定边界。
- 先为流式文本、thinking、tool call、错误、用量、故障转移和三种协议写 contract tests。
- 增加 agent consumer 与 DeepSeek official preset，默认 deepseek-v4-flash、可选 deepseek-v4-pro。
- 定义事件 schema、digest、单调序号、clientRequestId 幂等、SSE after cursor、取消/关闭/审批接口。
- 实现固定 REST 端点：POST/GET /v1/agent-sessions、messages、events?after=<seq>、cancel、close 与 approvals/:approvalId；审批值仅 approve_once、approve_session_scope、deny。
- 未完成副作用恢复为 interrupted，任何恢复路径不得自动重放。
- 实现统一的数据分类与输出过滤：业务内容仅脱敏手机号和身份证号；姓名、邮箱、地址、路径、普通用户名和模型文本不脱敏。API key、token、password、private key 等凭据始终隐藏，任何 raw/debug 开关不得绕过。
- 企业 Agent 会话的 PostgreSQL 事实源、跨进程 writer lease/SSE 与 S3 对象边界按 `docs/plans/2026-08-18-phase03-b6-enterprise-agent-sessions.md` 执行；在该计划退出前，子计划 03 不得标记完成。

## 测试命令与退出门槛

~~~sh
npm run test -w @mn/local-proxy
npm run test -w @mn/provider-catalog
npm run test -w @mn/store
npm run test -w @mn/api
npm test
~~~

mock API 完成多轮、重启恢复、SSE 续传、并发序号、取消和审批；三种 Provider contract tests 全绿；传输与持久化 contract tests 证明业务内容只处理手机号/身份证号且凭据无条件隐藏；新增逻辑覆盖率不低于 70%。
