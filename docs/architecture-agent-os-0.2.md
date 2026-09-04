# 木牛 Agent OS 0.2 架构

## 组合关系

```text
Desktop / CLI / API Shell
            ↓
      Agent OS 内核
      ↙          ↘
  OPC 插件      Coding 插件
                    ↘
          Claude / Codex Runner Adapter
```

Cordis 是唯一组合根。Host Scope 装载内核定义；Tenant 与 Workspace Scope 激活产品插件；Thread Scope 隔离 Session、Tool 和 Model；Execution 与 Subagent 使用子 Scope。每个 turn 重新解析贡献并固定 generation，HMR 只影响下一 turn。

## 事实与模型视图

`KernelEventV1` 是事实源。它同时包含租户单调 `position`、聚合 `streamVersion`、因果与相关标识、generation、公开载荷、加密载荷引用、前序摘要和 HMAC。查询表与快照都可从事件重建。

Session Log 只保存模型可见上下文。Surface 与 Compaction 可以改变模型视图，不覆盖事件、原始访谈或工具事实。

## 可靠写入

事件、投影、Job、outbox 和审批状态在同一数据库事务提交。写入者必须提供 `expectedStreamVersion`，冲突返回 `409`。CAS 先按摘要 create-only 写入，再提交事件引用；孤儿对象由保留期 GC 清理。

模型上下文在请求发送前持久化。工具调用的参数摘要、资源摘要、generation 和 authority commitment 在执行前持久化。结果未知的外部副作用进入 `needs_reconciliation`，绝不自动重放。

## 本地与企业实现

本地使用 SQLite WAL 与 `synchronous=FULL`、文件 CAS、Keychain 包装数据密钥和 AES-256-GCM。企业使用 PostgreSQL、S3 与 Vault/KMS。事件 HMAC 用于检测无密钥的数据库改写，不宣称抵御宿主或 KMS 管理员失陷。

Job 采用至少一次投递、30 秒租约和 fencing token。数据库拒绝陈旧 Worker 完成任务。企业生产 profile 缺少业务、执行、成果或审计保留策略时拒绝 readiness。

## 产品边界

OPC 首版只支持机会发现、证据验证、人工访谈、反证、最小收费方案和人工决策。没有 CRM、自动外联、发布、报价发送或收款工具。

Coding 插件承接 Spec、Governance、Harness、Loop、Gate、Evidence、Verifier、Sandbox 和仓库索引。Builtin Agent 是默认 Runner；Claude 与 Codex CLI 只是显式启用的 Runner Adapter，不接管 Provider、MCP、Prompt、Skill 或历史会话。
