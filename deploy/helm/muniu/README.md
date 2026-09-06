# 木牛 Agent OS 0.2 Helm Chart

本 Chart 默认部署两个 `mn-host` 和两个 Worker 副本。所有副本共用 PostgreSQL 与 S3：数据库状态固定写入 `mn_v2` schema，CAS 对象固定写入 `v2/` 前缀。Job 使用 30 秒租约和 fencing token。

## 部署前配置

生产部署必须提供 PostgreSQL、事件 HMAC 和 S3 凭据 Secret，并配置 OIDC issuer、audience 与 JWKS URL。启用模型连接时还必须配置 Vault KV；Vault token 只能来自已有 Secret。遥测固定关闭。

启用第三方插件时，将仓库索引、Ed25519 受信根和自包含模块归档放入发布镜像的只读目录，再配置 `pluginRepository.enabled`、`indexFile`、`trustedRootsFile` 和 `digest`。Chart 拒绝相对路径或无效摘要。Host 在执行模块前完成仓库、manifest、包摘要与包策略校验。UI、CLI 入口返回声明式贡献，由 Shell 渲染；Worker 入口按租户安装记录和 Execution 固定摘要加载，工具仍经过内核审批。

Worker 的 `worker.handlerModule` 必须指向受信的绝对路径。该模块需要导出 `handlers`，或导出异步 `createHandlers(context)`，并显式导出与实际 handler 完全一致的 `supportedKinds`。`worker.supportedKinds` 是 Host 与 Worker 共用的受信发布配置；它必须与模块声明逐项一致。Worker 在 readiness 通过前校验三者，只领取已经注册的 kind。

内置 `scripts/enterprise-worker-handlers.mjs` 在生产 profile 提供 `agent.execution.run`：它使用 PostgreSQL `mn_v2` RuntimeStore、S3 加密上下文、Vault Transit 包装密钥、Vault KV v2 BYOK、Cordis Scope 与内核审批端口。fixture profile 使用确定性的失败 handler 验证恢复链路。生产部署必须配置 `vault.address` 与 `vault.existingSecret`；Worker 不接受环境变量中的明文模型密钥。

内置生产模块同时提供 `coding.reconciliation.verify` 和 `coding.sandbox.cleanup`。builtin Coding 使用共享卷中的独立候选目录，每次 Git 命令由固定镜像摘要的短期 Kubernetes Pod 执行。Pod 禁止网络出口，不挂载 ServiceAccount token，只挂载授权子目录。Worker 核对 Pod UID、实际镜像摘要和运行时证明后，使用 Job 租约与 fencing token 提交 Gate 和证据。Claude/Codex 外部 Runner 的本地执行依赖 macOS 沙箱，不能直接用于企业 Kubernetes。

自定义 handler 模块若缺少验证或清理能力，Host 会关闭 `mark_completed`，仍允许终止或在其他条件满足时创建新调用。

Chart 在下列条件不成立时拒绝渲染：

- 已配置全部保留期；
- engine/plugin lock 是有效 SHA-256；
- 已启用插件仓库使用绝对镜像路径和固定 SHA-256 摘要；
- S3 前缀位于 `v2/`；
- Worker 租约为 30 秒；
- Worker capability 列表非空，验证与清理 kind 成对配置；
- Kubernetes sandbox 身份完整；
- 已显式声明运行时网络出口。

Host readiness 还会检查 PostgreSQL、S3、数据库中的 engine/plugin lock，以及全部已有租户的插件 installation 与租户 lock。任一 Host 缺少 lock 对应制品时失败关闭。Worker lock 不一致时不会 claim Job。
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

节点镜像固定为 Kubernetes `v1.34.0` 及其 SHA-256，不跟随本机 Kind 的默认版本。摘要来源为 [Kind v0.30.0 发布记录](https://github.com/kubernetes-sigs/kind/releases/tag/v0.30.0)，配置见 `deploy/kind/config.yaml`。生产 Coding 测试使用生产 handler、真实 PostgreSQL/S3 和候选 Pod；模型输出使用确定性 fixture，不调用外部模型。
