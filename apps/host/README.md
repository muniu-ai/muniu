# `@mn/host`

`@mn/host` 是木牛 Agent OS 0.2 的唯一组合根。它通过 Cordis 装载内核、Agent Runtime、存储实现和已启用插件，并向 Desktop、CLI 与企业客户端提供同一套 `/v2` 接口。

## 组合边界

- Host Scope 装载身份、事件、存储、插件与运行时定义。
- tenant、workspace、thread 和 execution 分别创建子 Scope。
- 官方 OPC 与 Coding 插件随应用提供，由工作区按需启用。
- 插件故障只降低对应插件能力；核心健康检查、收件箱、设置和其他插件保持可用。
- 生产插件与 Host 同进程运行，是宿主级可信代码，不是沙箱。

本地 profile 使用隐式 `local` tenant 和 `local-owner`，权威状态位于 `~/.muniu/v2`。企业 profile 通过注入的 PostgreSQL、S3 与 Vault/KMS 端口运行，使用 `mn_v2` schema 和 `v2/` 对象前缀。

## 本地运行

```bash
npm run dev:host
```

Host 默认监听 `http://127.0.0.1:7318`。常用只读入口：

```text
GET /v2/health
GET /v2/readiness
GET /v2/openapi.json
```

所有 mutation 都要求 `Idempotency-Key`；修改现有 aggregate 时还要求 `expectedStreamVersion`。完整契约见 [API 路由](../../docs/reference/api-routes.md) 与 [OpenAPI](../../docs/reference/openapi.md)。

## 就绪与恢复

Host 仅在权威存储、密钥服务、engine lock 和 plugin lock 一致时就绪。事件、投影、Job、outbox、审批与幂等结果必须在同一数据库事务提交；结果未知的外部副作用进入 `needs_reconciliation`，不会自动重放。

企业环境使用蓝绿切换。Host 与 Worker 的 lock 摘要不一致时，Host 拒绝 readiness，Worker 拒绝领取 Job。

## 验证

```bash
npm run typecheck -w @mn/host
npm run test -w @mn/host
```
