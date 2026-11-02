# 企业权限、额度与独立存储

E1.2 为新企业入口提供部门、角色、对象授权、字段过滤、职责分离和额度配置。权限服务与执行预算的结合由 E3.2 实施；本包的额度检查不能单独作为模型调用许可。业务聚合与查询由 E2 接入这些权限。

## 业务权限

企业管理员负责成员、部门、授权和额度配置，不因管理员身份自动取得财务或销售批准资格。业务资格来自明确的角色授予；Agent 名称和外部令牌中的角色声明不产生权限。

| 角色 | 对象与操作 |
| --- | --- |
| 销售 | 本人或明确共享的客户、联系人、商机；获准范围内起草报价、合同和订单 |
| 销售经理 | 获准部门及子部门范围；具有正式报价、合同与订单的业务批准资格 |
| 项目负责人 | 获准项目及关联里程碑、交付、变更；具有客户验收的业务批准资格 |
| 财务 | 获准订单的付款期与资金记录；具有到账、退款及调整的业务批准资格 |
| 审计员 | 获准范围内的成果、证据、决定和复盘，只读与审计 |

角色操作、对象范围与字段类别共同决定结果。范围可设为本人、整个工作区、部门或指定对象；项目和订单引用覆盖其明确关联的对象。对象共享只扩展已有角色的对象范围，不能把销售共享成财务批准人。共享与角色的字段权限取交集。

`public`、`price`、`cost`、`contact` 分别控制普通字段、价格、成本和联系方式。未分类字段默认不返回。领域服务必须从可信的当前业务记录创建对象描述，不能采用客户端或模型提交的 owner、department、project 或字段分类。

业务批准还要求当前角色具有该操作、能够读取领域命令规定的关键字段、批准人与制单人不同。领域命令未指定关键审批字段时拒绝批准。业务权限检查是业务事实确认的前置条件；实际确认事件由 E2 领域命令提交，不能用一次权限检查代替到账或客户验收事实。

成员停用、会话版本变化、角色撤销、对象共享撤销和授予期限均在每次判断时重验。领域写入应在 `EnterpriseRepository.transact` 中使用 `resolveObjectAccess` 或 `assertBusinessDecisionAccess`；异步读取后的旧判断不能直接授权提交。

## 接口与版本

登录、同源与 CSRF 规则沿用[企业身份入口](enterprise-identity.md)。下列接口均来自统一 schema；业务 POST 要求 `Idempotency-Key`，撤销及额度更新还要求 `expectedStreamVersion`。

| 路径（前缀 `/v2/workspaces/{workspaceId}`） | 方法与行为 |
| --- | --- |
| `/access` | GET 读取部门及授权配置，仅企业管理员 |
| `/departments` | POST 创建部门，可指定本工作区的上级部门 |
| `/role-grants` | POST 授予角色、操作、范围、字段与有效期 |
| `/object-grants` | POST 授予明确对象共享 |
| `/role-grants/{grantId}/revocations` | POST 撤销当前版本的角色授予 |
| `/object-grants/{grantId}/revocations` | POST 撤销当前版本的对象共享 |
| `/quota` | GET 读取额度；POST 配置工作区额度 |

每个部门、角色授予、对象共享、平台额度和工作区额度独立版本。当前不提供部门编辑和角色原地修改；授权变更通过撤销旧授予、创建新授予表达。两个请求使用同一旧版本撤销时只有一个成功，另一请求收到版本冲突。

## 额度配置

默认没有模型额度。运维人员通过受信 Host 的 `quotas.provision` 或入口配置文件中的 `platformQuotas` 开通平台上限；该能力没有公开 HTTP 接口。企业管理员只能在平台上限内分配工作区额度，不能自行提高平台上限。平台降额后，超出上限的工作区配置立即不能通过新执行准入，须重新配置。

每份额度固定有效期、人民币费用上限和 token 上限，另设入站评估的每日额度与单次额度。初始调度上限为每项工作 6 个并行节点、32 个累计节点、64 次尝试、3 次自动重规划，以及每租户 20 个执行中节点。提高这些平台上限必须由运维提供容量验收摘要；摘要是运维声明，程序不会凭摘要自动证明容量测试通过。

配置文件的 `platformQuotas` 数组每项包含 `tenantId`、`idempotencyKey`、`expectedStreamVersion`、`limits`，提高调度上限时另附 `capacityEvidenceDigest`。首次版本为 0；重启使用同一键与相同内容不会重复修改。`limits` 的完整字段见[企业 OpenAPI](reference/enterprise-openapi.yaml)中的 `EnterpriseQuotaConfigure`，`limits` 对象只放额度字段，不放 `expectedStreamVersion`；该版本字段仍是配置项顶层的必填项。

调整平台额度时，管理员先通过 GET `/v2/workspaces/{workspaceId}/quota` 取得 `platform.streamVersion`，运维将其填入配置项顶层的 `expectedStreamVersion`，更换未使用的 `idempotencyKey` 并修改 `limits`，随后重新启动本地入口。成功后再次 GET 可见新的平台版本；沿用原幂等键修改内容会被拒绝。工作区额度调整使用 POST 同一路径、当前 `workspace.streamVersion` 与新幂等键。

零额度、过期额度、超过有效期的任务及超过单次评估额度的请求均拒绝。`assertModelQuota` 只检查当前政策，实际累计消耗、并发槽位、未知费用保留和额度结算必须通过 E3 的持久预算账户；不能重复调用政策检查来代替预留。

## 存储与恢复

本地入口继续使用独立 `enterprise-v1` 状态目录和 Keychain service。企业事实由带完整性校验的 `KernelEventV1` 与加密 CAS 重放；查询投影不是权限来源。提交前的并发检查覆盖权限与业务事件读取到提交之间的变更。

PostgreSQL 存储适配新增显式 `namespace: 'mn_enterprise_v1'`，S3 CAS 新增 `namespace: 'enterprise-v1'`。新适配只在新命名空间操作；不会迁移、改名或加载旧 `mn_v2`、`v2/` 状态。底层旧入口保留原默认值，便于旧产品壳在 E6.3 替换前继续独立验收。企业 Host 装配必须显式选择新命名空间。

数据库命名空间绑定只改写仓库自有 SQL 模板中的标识符，不修改查询参数、字符串、注释或 dollar 字符串，不设置共享 `search_path`。已绑定的连接不能再次切换命名空间。S3 拒绝越出所选根前缀的配置，孤立对象清理也仅扫描所选前缀。

## 验证

执行 `npm run verify:enterprise-access` 验证合成身份、权限、额度、加密重放及命名空间隔离。执行 `npm run verify:enterprise-access-postgres` 会创建仅绑定回环随机端口的一次性 PostgreSQL 容器，验证两个服务实例的并发提交与撤权，并在结束时删除本次容器；不会连接用户数据库。它使用本地加密 CAS，不代表 S3/KMS 联合灾备通过。

完整托管入口、双 Host/Worker、真实 S3/KMS、模型额度执行、检索与导出过滤仍需后续工作包的集成验收。实际记录见 [E1.2 验证记录](verification/enterprise-e1-2-2026-11-02.md)。
