# 子计划 03：模型、会话与公共协议实现计划

> **致 Claude：** 必须使用子技能 dev-executing-plans 逐任务执行此计划。

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

## 测试命令与退出门槛

~~~sh
npm run test -w @mn/local-proxy
npm run test -w @mn/provider-catalog
npm run test -w @mn/store
npm run test -w @mn/api
npm test
~~~

mock API 完成多轮、重启恢复、SSE 续传、并发序号、取消和审批；三种 Provider contract tests 全绿，新增逻辑覆盖率不低于 70%。
