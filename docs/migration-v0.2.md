# v0.2.0 迁移指南

v0.2.0 是一次性协议切换。升级会把 V1/V2 Agent 事件转换为 `AgentEventV3`，并把首方客户端切换到 app-server v2。旧控制 REST/SSE 客户端不能连接 v0.2.0。

## 前提

- 使用 Node.js `22.19.x`、npm `11.10.1` 和 TypeScript `5.7.2`。
- 停止 v0.1 API、Worker、CLI、Desktop 和所有写入方。
- 备份本地状态目录，或同时备份 PostgreSQL、S3 bucket/version 和部署配置。
- 记录备份摘要、对象数量、数据库快照标识和当前版本。
- 在生产数据副本上先完成一次 dry-run 和 apply 演练。

迁移期间不能混合 v0.1 与 v0.2 进程。任何未知事件、损坏链、数量差异、摘要差异或制品缺失都会终止迁移。

## 本地迁移

默认输入目录为 `~/.muniu/agent-service`。先执行只读检查：

```bash
mn migrate app-server-v3 --dry-run
```

检查输出中的旧 schema、session/event 数量、旧根摘要、预期新根摘要和逐记录映射。保留输出后执行：

```bash
mn migrate app-server-v3 --apply
```

也可明确指定根目录：

```bash
mn migrate app-server-v3 \
  --root /srv/muniu/agent-service \
  --apply
```

apply 在 staging 目录写入并校验 V3 线程、事件和投影，再原子发布。旧 SQLite/API state 与 JSONL 会移动到只读 `archive/app-server-v1-v2-*`；迁移 manifest 记录旧根摘要、新根摘要、数量和工具版本。迁移不会覆盖旧数据。

## 企业迁移

Helm pre-install/pre-upgrade Job 先执行控制面 schema migration，再执行 `apps/api/dist/migrateAppServerV3.js`。正式升级使用：

```yaml
migration:
  appServerV3Mode: apply
```

Job 从以下变量读取 PostgreSQL 与 S3 配置：

- `MN_POSTGRES_URL`
- `MN_ARTIFACT_REMOTE_STORE_ENDPOINT_URL`
- `MN_ARTIFACT_REMOTE_STORE_BUCKET`
- `MN_ARTIFACT_S3_REGION`
- `MN_ARTIFACT_REMOTE_STORE_PREFIX`
- `MN_ARTIFACT_S3_ACCESS_KEY_ID`
- `MN_ARTIFACT_S3_SECRET_ACCESS_KEY`
- 可选的 `MN_AGENT_SESSION_KMS_KEY_ID`

单独演练时把 `MN_APP_SERVER_V3_MIGRATION_MODE` 设为 `dry-run`。企业迁移锁定旧 session/event 索引表，在 S3 写入不可变事件对象，逐对象校验 SHA-256，再提交 PostgreSQL activation manifest。

全新空库会建立零 thread、零事件的 activation manifest。旧 session/event 表只存在一张时，迁移会把数据库视为结构残缺并停止。

## 验证与切换

完成 apply 后，按顺序执行：

1. 比较 manifest 中的旧/新事件数量、thread 数量和根摘要。
2. 对每个 thread 校验最后 sequence、chain digest 和 S3 对象摘要。
3. 启动 v0.2 gateway，但暂不开放写入。
4. 使用 `@mn/sdk` 完成 `initialize`、`thread/list`、`thread/read` 和通知恢复检查。
5. 升级 CLI、Worker 协调器和 Desktop。
6. 确认旧客户端收到明确的 protocol mismatch 后开放写入。

旧 S3 prefix、SQLite/API state 和 JSONL 保持只读归档。不要把旧事实链与已经写入的新事实链拼接。

## 回退边界

首次 V3 写入前，可以停机后执行：

```bash
mn migrate app-server-v3 --rollback
```

rollback 会重新校验 V3 根摘要、事件数量和旧归档摘要。只要 V3 链出现任何新写入、计数变化或摘要变化，命令就会拒绝回退。

首次 V3 写入后，只能停止全部 v0.2 进程并恢复整套备份，包括 PostgreSQL、S3 和本地状态。不能只恢复数据库或只恢复对象存储，也不能把两条事实链合并。

## 发布前检查

```bash
npm run verify:app-server-schema
npm run verify:rpc-coverage
npm run verify:migration-v3
npm run verify:sdk-e2e
npm run verify:gateway-e2e
npm run verify:desktop-e2e
```

完整发布门见 [v0.2.0 发布说明](release/v0.2.0.md)。
