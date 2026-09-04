# 企业运维

企业部署运行同一 Agent OS 内核，使用 PostgreSQL、S3 与 Vault/KMS 替换本地存储实现。生产拓扑至少包含两个 Host 与两个 Worker，并通过蓝绿方式切换完整 engine/plugin lock。

## 上线前条件

- PostgreSQL 已创建 `mn_v2` schema，并启用事务、备份和时间同步。
- S3 bucket 的 `v2/` 前缀启用版本、加密和 create-only 语义。
- Vault/KMS 能包装敏感 payload、CAS 与事件 HMAC 所需的密钥。
- 身份层能提供 tenant 与 principal，并映射组织和工作区角色。
- 业务、执行、成果和审计保留策略都已配置。
- Host 与 Worker 使用相同的 engine lock、plugin lock 和镜像摘要。
- Coding sandbox 使用明确的 RuntimeClass、无 token 的 ServiceAccount 与默认拒绝网络策略。

缺少保留策略、密钥、存储或 lock 一致性时，readiness 必须失败。

## 身份与隔离

本地隐式身份不能用于企业 profile。认证层应把组织身份解析为 `Tenant`、`Principal` 与 `WorkspaceMembership`。内核角色包括组织管理员、治理管理员、审计员，以及工作区 owner、operator、reviewer、viewer。

所有查询、事件位置、投影、Job、CAS 引用、插件安装与记忆授权都带 tenant 范围。运维验收必须证明 tenant A 的插件、事件、成果和对象无法由 tenant B 读取或枚举。

## 部署

复制 Helm values 到私有配置，凭据只通过现有 Secret 或 Vault/KMS 引用注入：

```bash
helm upgrade --install muniu deploy/helm/muniu \
  --namespace muniu \
  --create-namespace \
  -f values.production.yaml
```

不要把数据库口令、S3 secret 或模型 API Key 写入 values、镜像、ConfigMap 或仓库。Host 与 Worker 使用不同 ServiceAccount。Candidate Pod 不自动挂载 token，不使用 `hostPath`，不接收模型凭据或宿主 secret。

若 NetworkPolicy 由 Service DNAT 之后的地址判断出站目标，还需显式放行实际 PostgreSQL、S3、KMS 和 Kubernetes API endpoint 的 CIDR/端口。Chart 不应猜测生产网段。

## 蓝绿切换

1. 备份 PostgreSQL、S3 版本与 plugin lock。
2. 在绿色环境部署同一版本的 Host、Worker 和插件。
3. 检查 `/v2/readiness`，并用只读任务验证数据库、CAS、KMS 与 sandbox。
4. 停止蓝色环境接受新执行，等待活动执行到达安全边界。
5. 原子切换流量和 Worker claim 权限。
6. 观察事件位置、Job 租约、outbox 和人工核对队列。

不得在同一 Job 队列中混合运行不同 engine/plugin lock。插件升级应先在独立投影 namespace 完成重放和校验，再原子切换。

## Job 与故障恢复

Job 是至少一次投递，默认租约为 30 秒，并携带 fencing token。Worker owner 丢失后，数据库在租约到期时允许新 Worker 领取；陈旧 owner 的续租、结果与 checkpoint 必须被拒绝。

已提交事件的恢复目标是 RPO 0。Host 或 Worker 中断不应丢失已经提交的事件、审批或 outbox。模型上下文和工具承诺都在外部请求前持久化。

外部副作用的结果未知时，执行进入 `needs_reconciliation`。恢复流程只能等待人工核对，不能自动重放。只读任务和明确可恢复的本地写入仍需遵循原幂等键、generation 和 authority commitment。

## 备份与恢复

备份应覆盖：

- PostgreSQL `mn_v2` schema、事件 HMAC 元数据和保留期配置；
- S3 `v2/` 对象、版本与对象锁设置；
- plugin lock、engine lock、签名信任根和撤销元数据；
- Vault/KMS key 标识、恢复权限和轮换记录，但不导出明文密钥。

恢复演练先在隔离环境完成。按事件摘要链验证数据库，从 CAS 抽样重新计算 SHA-256，再重建投影并比较 checkpoint。KMS 不可用或事件 HMAC 失败时停止 readiness，不能跳过校验启动。

## 保留与删除

生产 profile 必须分别配置业务数据、执行、成果和审计保留期。删除敏感内容时销毁对应数据密钥并写入 tombstone；审计只保留操作者、时间、对象摘要与删除原因。

撤销 share grant 立即阻止后续读取，并使派生记忆失效。已经发送到模型或外部服务的数据无法召回，操作界面与审计记录必须说明这一限制。

## 运行检查

```bash
curl --fail http://HOST/v2/health
curl --fail http://HOST/v2/readiness
npm run verify:enterprise-fixture
npm run verify:kind
```

发布验收还应覆盖：

- 两个 Host、两个 Worker 的无粘滞请求；
- tenant 交叉访问失败；
- 删除活动 owner 后，租约在 30 秒后过期，并在 60 秒测试窗口内恢复；
- PostgreSQL 重启后事件与 Job 状态一致；
- S3 缺失或摘要篡改时 fail closed；
- Candidate 与权威 Gate 在独立 sandbox 中运行；
- 外部副作用未知结果只进入人工核对。

`verify:kind` 需要 Docker、Kind、kubectl、Helm、buildx 和 curl。测试通过只证明仓库定义的故障注入场景，不等同于生产可用性或隔离认证。
