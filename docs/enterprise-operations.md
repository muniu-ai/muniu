# 企业运维

企业部署运行同一 Agent OS 内核，使用 PostgreSQL、S3 与 Vault/KMS 替换本地存储实现。生产拓扑至少包含两个 Host 与两个 Worker，并通过蓝绿方式切换完整 engine/plugin lock。

本文面向部署和恢复操作者。Compose、Kind 和 `values-ci.yaml`、`values-kind.yaml` 是测试 fixture，不能直接作为生产配置。按当前任务选择入口：

| 任务 | 入口 |
| --- | --- |
| 首次部署 | [上线前条件](#上线前条件)与[部署](#部署) |
| 检查运行状态 | [运行检查](#运行检查) |
| 切换版本 | [蓝绿切换](#蓝绿切换) |
| 处理执行中断 | [Job 与故障恢复](#job-与故障恢复) |
| 恢复或重建数据 | [备份与恢复](#备份与恢复)与[离线维护入口](#离线维护入口) |
| 验证仓库部署场景 | [企业 fixture 验证](#企业-fixture-验证) |

## 上线前条件

- PostgreSQL 已创建 `mn_v2` schema，并启用事务、备份和时间同步。
- S3 bucket 的 `v2/` 前缀启用版本、加密和 create-only 语义。
- Vault/KMS 能包装敏感 payload 与受保护附件的 DEK，并提供事件 HMAC 所需的密钥。
- 身份层能提供 tenant 与 principal，并映射组织和工作区角色。
- 业务、执行、成果和审计保留策略都已配置。
- Host 与 Worker 使用相同的 engine lock、plugin lock 和镜像摘要。
- 启用第三方插件时，所有 Host 镜像包含相同的只读签名仓库、Ed25519 受信根和仓库摘要。
- Coding sandbox 使用明确的 RuntimeClass、无 token 的 ServiceAccount 与默认拒绝网络策略。
- 专用容器运行时将 PID 上限设为 256；只设置 kubelet 的 Pod 上限不足以通过容器内检查。Kind fixture 为 `test-handler` 配置独立 OCI base spec，不修改默认 `runc`。

缺少保留策略、密钥、存储或 lock 一致性时，readiness 必须失败。

Worker 的 `/tmp/mn-worker-live` 仅记录进程事件循环活性；`/tmp/mn-worker-ready` 记录 KMS、数据库版本 lock 与处理器就绪状态。依赖检查失败时，Worker 停止下一次领取，Kubernetes 不因该依赖故障判定进程失活。在途任务仍按原有租约和取消协议处理，未知结果进入核对。收到停止信号后不再领取新任务；事件循环停止响应或进程退出仍会使活性检查失败。

## 身份与隔离

本地隐式身份不能用于企业 profile。认证层应把组织身份解析为 `Tenant`、`Principal` 与 `WorkspaceMembership`。内核角色包括组织管理员、治理管理员、审计员，以及工作区 owner、operator、reviewer、viewer。

所有查询、事件位置、投影、Job、CAS 引用、插件安装与记忆授权都带 tenant 范围。运维验收必须证明 tenant A 的插件、事件、成果和对象无法由 tenant B 读取或枚举。

## 部署

从仓库的 [Helm 默认值](https://github.com/muniu-ai/muniu/blob/main/deploy/helm/muniu/values.yaml)创建私有 `values.production.yaml`，填写真实身份服务、存储、KMS、镜像、lock 和 sandbox 配置，并满足上线前条件。默认值中的空地址、空 RuntimeClass 和空 sandbox 摘要不能直接用于生产。凭据只通过现有 Secret 或 Vault/KMS 引用注入。

以下命令在仓库根目录执行，需要已连接目标集群的 Helm 和 kubectl；它会创建或更新 `muniu` namespace 中的部署资源：

```bash
helm upgrade --install muniu deploy/helm/muniu \
  --namespace muniu \
  --create-namespace \
  -f values.production.yaml
```

不要把数据库口令、S3 secret 或模型 API Key 写入 values、镜像、ConfigMap 或仓库。Host 与 Worker 使用不同 ServiceAccount。Candidate Pod 不自动挂载 token，不使用 `hostPath`，不接收模型凭据或宿主 secret。

Host 通过 `MN_VAULT_TRANSIT_MOUNT` 和 `MN_VAULT_TRANSIT_KEY` 指定 0.2 的 Transit mount 与密钥名前缀。每份受保护 payload 使用独立、不可导出的 Transit key，名称为前缀加 UUID；不共用可恢复已删除内容的包装密钥。令牌只允许访问该前缀下的 `keys`、`keys/*/config`、`encrypt` 和 `decrypt` 路径，分别授予创建、查询、配置、删除和加解密所需权限，不授予其他 mount 的管理权限。

令牌由 Secret 或工作负载身份注入。就绪检查通过只读健康请求和 `sys/capabilities-self` 查询验证连接及权限，不创建探测密钥。缺少配置、Vault 被封印、令牌失效或权限不足时返回 `KMS_UNAVAILABLE`；不再继续读取加密插件投影。普通产品变更的事实日志和幂等结果也需要 KMS，不能绕过加密使部署通过验收。Vault API 说明见[健康检查](https://developer.hashicorp.com/vault/api-docs/system/health)和[令牌权限查询](https://developer.hashicorp.com/vault/api-docs/system/capabilities-self)。

第三方插件应在构建阶段放入镜像内只读目录。Helm 的 `pluginRepository.enabled` 开启后，必须填写 `indexFile`、`trustedRootsFile` 与 `digest`；对应路径不能来自可变网络挂载。Host 不直接 import 文件路径，而是在仓库元数据、manifest、实际模块摘要和包策略全部通过后执行已读取的模块字节。仓库配置不完整、任一租户 lock 无法恢复或副本缺包时，readiness 失败。插件代码与 Host 进程权限等价，不是沙箱。

插件更新、全局停用和清除使用 PostgreSQL 内的租户级操作锁；执行提交、命令调用和工作区启用使用与其互斥的短期租约。排空锁存在时，所有副本都拒绝新的第三方插件工作。Host 崩溃后不自动删除残留锁，也不自动重放结果未知的变更；readiness 会提示人工核对。处理前应确认没有活动 Execution、插件版本和摘要未变化、目标投影 namespace 未切换，再按事件审计记录决定继续或回退部署。

若 NetworkPolicy 由 Service DNAT 之后的地址判断出站目标，还需显式放行实际 PostgreSQL、S3、KMS 和 Kubernetes API endpoint 的 CIDR/端口。Chart 不应猜测生产网段。

## 蓝绿切换

1. 备份 PostgreSQL、S3 版本与 plugin lock。
2. 在绿色环境部署同一版本的 Host、Worker 和插件。
3. 检查 `/v2/readiness`，确认所有已有租户插件 lock 已恢复，再用只读任务验证数据库、CAS、KMS 与 sandbox。
4. 停止蓝色环境接受新执行，等待活动执行到达安全边界。
5. 原子切换流量和 Worker claim 权限。
6. 观察事件位置、Job 租约、outbox 和人工核对队列。

不得在同一 Job 队列中混合运行不同 engine/plugin lock。插件升级应先在独立投影 namespace 完成重放和校验，再原子切换。

## Job 与故障恢复

Job 是至少一次投递，默认租约为 30 秒，并携带 fencing token。Worker owner 丢失后，数据库在租约到期时允许新 Worker 领取；陈旧 owner 的续租、结果与 checkpoint 必须被拒绝。

Worker 每秒重新检查数据库中的 engine/plugin lock。数据库不可达或摘要不一致时撤下就绪标记；停止进程后不再补写标记。

Host 或 Worker 中断后的已提交事件恢复目标是 RPO 0；数据库、CAS 和 KMS 的丢失仍取决于各自的备份与恢复能力。模型上下文和工具承诺都在外部请求前持久化。

外部副作用的结果未知时，执行进入 `needs_reconciliation`。恢复流程只能等待人工核对，不能自动重放。只读任务和明确可恢复的本地写入仍需遵循原幂等键、generation 和 authority commitment。

企业 `mark_completed` 是显式 Worker capability。发布配置 `MN_WORKER_SUPPORTED_KINDS`、handler 模块导出的 `supportedKinds` 与实际 `handlers` 必须完全一致；Worker 校验通过后才按这些 kind 领取 Job。内置生产模块同时提供 `coding.reconciliation.verify` 与 `coding.sandbox.cleanup`，在 Kubernetes 候选 Pod 中执行权威 Gate，并以租约和 fencing token 提交证据及清理结果。自定义模块未同时提供两项能力时，Host 关闭“标记完成”，保留终止或创建全新调用。

## 备份与恢复

备份应覆盖：

- PostgreSQL `mn_v2` schema、事件 HMAC 元数据和保留期配置；
- S3 `v2/` 对象、版本与对象锁设置；
- plugin lock、engine lock、签名信任根和撤销元数据；
- Vault/KMS key 标识、恢复权限和轮换记录，但不导出明文密钥。

恢复演练先在隔离环境完成。核心元数据来自事件内的投影事实；产品查询表与幂等结果来自加密事实日志及 CAS 引用。仅备份 events 表不足以恢复加密内容，必须同时保留对应 CAS 和 KMS。不得手工清空运行中的查询表。KMS 不可用或事件 HMAC 失败时停止维护，不能跳过校验。

### 离线维护入口

`npm run maintenance:enterprise` 提供 `verify`、`rebuild`、`gc` 和 `upgrade-core-protection`。以下前置条件适用于所有操作，包括 `verify`：它也会临时禁止数据库新连接。

维护前停止所有共用该数据库和 CAS 前缀的 Host、Worker 及其他写入程序。数据库必须专用于这一份木牛部署，CAS 前缀不能与另一份数据库共用。运行账号需要目标数据库所有者权限、连接同一主库的 `postgres` 数据库权限，以及执行 `pg_control_system()` 的权限。管理连接和数据连接会比较实例标识、启动时间与主库状态；维护不会终止其他数据库连接。

沿用 Host 的 `MN_POSTGRES_URL`、`MN_EVENT_HMAC_KEY`、S3 和 Vault 环境配置，另设 `MN_MAINTENANCE_ACTOR` 为运维操作者标识。密钥只通过私有环境注入，不写入命令行。先按[贡献指南](https://github.com/muniu-ai/muniu/blob/main/CONTRIBUTING.md)安装依赖并完成 `npm run build`。将 `DATABASE` 替换为连接 URL 中的实际数据库名，再执行需要的操作，不要把重建和清理当作例行只读检查：

```bash
npm run maintenance:enterprise -- verify --offline --database DATABASE
```

使用相同参数将 `verify` 替换为 `rebuild` 可重建查询状态，替换为 `gc` 会删除符合条件的孤儿对象。

`verify` 校验所有租户的完整 HMAC 事件链、事件头、核心事实、加密投影事实和 CAS 内容，不改写查询表。`rebuild` 先完成全部校验，再逐租户原子重建查询投影与幂等结果，不重放物理 Job 或外部副作用。`gc` 同样先完成校验，只清理未被任何历史事实引用且超过保留期的 CAS 对象；默认保留 7 天，`MN_CAS_ORPHAN_RETENTION_DAYS` 可设为 1 至 36500 天。空数据库不能授权清理 CAS。输出为不含业务内容的 JSON 汇总；重建和清理写入维护请求与完成事件。

维护先检查其他连接和预备事务，再临时禁用新连接并重复检查。PostgreSQL 的 `ALLOW_CONNECTIONS false` 会拒绝新连接，见 [ALTER DATABASE](https://www.postgresql.org/docs/16/sql-alterdatabase.html)。成功后重新开放连接。开始维护后发生校验失败、连接中断或进程崩溃时，数据库保持离线；不自动重试，也不重新投递结果未知的删除。

故障处理时继续保持 Host/Worker 停止。管理员从另一数据库连接，核对维护事件与对象存储状态并修复原因，再针对原目标执行 `ALTER DATABASE "实际数据库名" ALLOW_CONNECTIONS true`，随后重新执行 `verify`。只有完整校验通过后才启动业务进程。单租户超过 100 万事件时，当前入口拒绝维护，不截断事件后继续清理。

当前 GC 由操作者在停机维护窗口显式执行，不提供在线定时清理。S3 批量删除每批最多 1000 个对象，并检查 HTTP 200 响应中的单对象错误；版本化 bucket 的历史对象版本仍遵循存储管理员配置的保留策略。参见 [S3 列表分页](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)和[批量删除](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html)。

### 升级当前 0.2 数据

仅在当前 0.2 数据包含旧明文核心记录时执行此升级；它不读取或迁移 0.1 状态。先保存并验证数据库、CAS 与密钥备份，满足前述离线维护条件后执行：

```bash
npm run maintenance:enterprise -- upgrade-core-protection --offline --database DATABASE
```

升级校验历史事实，逐租户将当前核心记录加密并重建查询投影，不改写历史事件或执行外部业务调用；加密仍需访问 KMS 和 S3。每个租户独立提交；后续租户失败时，前序租户可能已经完成，数据库保持离线。失败租户也可能已创建 CAS 对象和 Transit 密钥，数据库事务回滚不会撤销这些写入。修复原因后可对同一事件头重复执行，已升级记录不会重复转换。历史明文和旧备份继续按原保留策略管理，升级不代表擦除了历史内容。

升级成功后，在恢复业务前同步更新数据库、CAS 和 KMS 备份，并验证新增 Transit 密钥可恢复。升级前的 KMS 备份不包含新密钥，不足以恢复新增的加密事实。

旧明文幂等回执只有在事件链中存在对应的已认证加密事实时，才能据此恢复。缺少事实会阻断升级与启动；必须保留原库、备份和幂等记录，先核对原操作，不能删除记录重试或将查询缓存重新认定为事实。

## 保留与删除

生产 profile 必须分别配置业务数据、执行、成果和审计保留期。删除在同一事务中写入 tombstone 与密钥撤销请求；后台销毁对应的独立 Transit key。销毁完成后，即使恢复旧数据库、WAL 或含 wrapped DEK 的备份，也不能通过当前 KMS 解密该数据。销毁请求超时或结果未知时保留人工核对项，不自动重发；收件箱提供显式核对和重新发起删除。只有 KMS 确认销毁后，才能显示密钥删除完成。

恢复 KMS 自身在删除前的备份可能恢复已经销毁的密钥。KMS 管理员必须保留并执行后续撤销记录；上述机制不抵御宿主或 KMS 管理员失陷，也不能召回已导出的明文。

撤销 share grant 立即阻止后续读取，并使派生记忆失效。已经发送到模型或外部服务的数据无法召回，操作界面与审计记录必须说明这一限制。

## 运行检查

将 `HOST` 替换为目标部署地址。这两项请求读取服务状态，不运行故障注入：

```bash
curl --fail http://HOST/v2/health
curl --fail http://HOST/v2/readiness
```

## 企业 fixture 验证

先在仓库根目录完成 `npm ci` 和 `npm run build`。Compose 验证需要 Docker、Compose 与 Helm；Kind 验证还需要 Kind、kubectl、buildx 和 curl。两项验证都会下载或构建镜像、写入测试数据并注入故障，不能连接生产数据库或复用生产集群。

MinIO 与 mc 的原测试版本现由[固定官方源码构建](https://github.com/muniu-ai/muniu/blob/main/deploy/fixtures/README.md)，Compose 和 Kind 共用本地镜像。首次构建需要访问 Docker Hub、GitHub 和 Go 模块源并编译 Go 程序；不再从已无法匿名拉取的 MinIO 镜像仓库下载。该历史版本只用于测试，不作为生产存储建议。

Compose 默认使用固定回环端口，运行前须确保端口空闲，并使用独立的 `COMPOSE_PROJECT_NAME`。脚本结束时默认执行 `down --volumes --remove-orphans`，删除该项目容器和卷；`--keep-compose` 可保留现场。Kind 默认创建 `muniu-v2` 集群，已有同名集群时拒绝执行；结束后删除本次创建的集群，`MN_KIND_KEEP=1` 可保留现场。

```bash
COMPOSE_PROJECT_NAME="muniu-check-$(date +%s)" npm run verify:enterprise-fixture
MN_KIND_CLUSTER_NAME="muniu-check-$(date +%s)" npm run verify:kind
```

仅检查静态 fixture 时使用 `npm run verify:enterprise-fixture -- --static`；此模式不启动 Compose，也不能证明数据库、KMS、租约或故障恢复行为。

发布验收场景包括：

- 两个 Host、两个 Worker 的无粘滞请求；
- tenant 交叉访问失败；
- 删除活动 owner 后，租约在 30 秒后过期，并在 60 秒测试窗口内恢复；
- PostgreSQL 重启后事件与 Job 状态一致；
- S3 缺失或摘要篡改时 fail closed；
- Candidate 与权威 Gate 在独立 sandbox 中运行；
- 外部副作用未知结果只进入人工核对。

测试通过只证明仓库定义的故障注入场景，不等同于生产可用性、容量或隔离认证。

Kind 使用导入后的 OCI manifest 摘要固定候选镜像，并校验该 manifest 引用本次构建的配置摘要；不能把 Docker image ID 当成 manifest 摘要。Calico 清单按固定版本经 IPv4 完整下载后应用，下载采用有限重试。

Compose fixture 的对外端口只绑定 `127.0.0.1`。PostgreSQL、S3、Vault、认证 fixture 和 Host 另接测试客户端网络，以支持 Docker Desktop 端口映射；Worker 只接内部网络。操作者必须设置独立的 `COMPOSE_PROJECT_NAME`，清理范围由该项目名决定。

Compose 与 Kind 的 Vault 使用固定版本、摘要和公开测试令牌，仅用于一次性集成测试。`-dev` 使用内存存储，重启会丢失密钥，绝不能用于生产。连接中断测试通过暂停和恢复进程保留内存密钥；它不构成 Vault 持久化重启或集群容灾证明。参见 [Vault dev server 边界](https://developer.hashicorp.com/vault/docs/concepts/dev-server)。
