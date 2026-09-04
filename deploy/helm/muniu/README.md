# 木牛 Agent OS 0.2 Helm Chart

本 Chart 默认部署两个 `mn-host` 和两个 Worker 副本。所有副本共用 PostgreSQL 与 S3：数据库状态固定写入 `mn_v2` schema，CAS 对象固定写入 `v2/` 前缀。Job 使用 30 秒租约和 fencing token。

## 部署前配置

生产部署必须提供 PostgreSQL、事件 HMAC 和 S3 凭据 Secret，并配置 OIDC issuer、audience 与 JWKS URL。启用模型连接时还必须配置 Vault KV；Vault token 只能来自已有 Secret。遥测固定关闭。

Worker 的 `worker.handlerModule` 必须指向受信的绝对路径。该模块需要导出 `handlers`，或导出异步 `createHandlers(context)`；生产模块必须提供 `agent.execution.run`，并接入真实的 LLM、Scope、持久 RuntimeStore 与审批端口。内置 `scripts/enterprise-worker-handlers.mjs` 只用于确定性 fixture，生产环境使用它会使 Worker 拒绝启动。

Chart 在下列条件不成立时拒绝渲染：

- 已配置全部保留期；
- engine/plugin lock 是有效 SHA-256；
- S3 前缀位于 `v2/`；
- Worker 租约为 30 秒；
- Kubernetes sandbox 身份完整；
- 已显式声明运行时网络出口。

Host readiness 还会检查 PostgreSQL、S3 和数据库中的 engine/plugin lock。Worker lock 不一致时不会 claim Job。
Worker 对 `agent.execution.run` 的认领、成功和失败会在同一 PostgreSQL 事务内更新 Job 与 Execution，并写入带 HMAC 的事件和 outbox；陈旧 fencing token 无法提交结果。

## 升级

Deployment 使用 `Recreate`，不支持混合 engine/plugin generation 的滚动升级。需要零停机时，请用独立 Helm release 部署新版本；等待投影重放和 readiness 通过后切换流量，再删除旧 release。

## 验证

```bash
npm run verify:helm
npm run verify:kind
```

`verify:kind` 会创建临时 Kind 集群，验证以下行为：

- 双 Host 和双 Worker；
- 租约接管与陈旧 fencing token 拒绝；
- 已提交事件 RPO 0、S3 CAS 与 PostgreSQL 重启恢复；
- 候选 Pod 与权威 Coding Gate 隔离。
