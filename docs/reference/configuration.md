# 配置参考

Agent OS 0.2 使用显式部署配置与签名 plugin lock。用户不需要填写内部厂商标识、模型标识、Base URL 或报文格式。

## 本地配置

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| Host 地址 | `http://127.0.0.1:7318` | 仅绑定回环地址 |
| 状态根 | `~/.muniu/v2` | 可用 `MN_V2_STATE_ROOT` 覆盖 |
| SQLite | `~/.muniu/v2/state.sqlite3` | WAL 与 `synchronous=FULL` |
| 文件 CAS | `~/.muniu/v2/cas` | 按 SHA-256 create-only 写入 |
| Keychain service | `com.muniu.agent-os.v2` | 保存模型密钥和包装密钥 |
| CLI API 地址 | 与 Host 默认地址相同 | 可用 `MN_API_URL` 覆盖 |

`MN_V2_STATE_ROOT` 必须指向 0.2 专用目录，不能指向早期状态目录。Desktop 启动时发现同端口已有早期 daemon 会拒绝继续。

## 模型连接

BYOK 是唯一模型接入方式。Desktop 从厂商预设创建连接，将 API Key 写入 Keychain，再通过连接探测发现默认模型。数据库只保存不含密钥的连接元数据与 Keychain 引用。

不要在配置文件、命令行参数、日志、诊断包或测试 fixture 中保存 API Key。企业环境由每个 Host 副本从 Vault/KMS 获取密钥；Worker、Coding candidate 和插件投影不接收模型凭据。

## 企业配置

企业 profile 至少需要：

- PostgreSQL 连接与 schema `mn_v2`；
- S3 bucket 与对象前缀 `v2/`；
- Vault/KMS 包装密钥；
- tenant/principal 身份解析；
- 业务数据、执行、成果和审计保留策略；
- engine lock 与 plugin lock 摘要；
- Worker 运行时、租约和 sandbox 设置。

缺少任一保留策略时，生产 readiness 必须失败。Host 与 Worker 的 engine/plugin lock 摘要不一致时，Host 拒绝 readiness 或 Worker 拒绝 claim。

### 企业签名插件仓库

第三方插件仓库必须随发布镜像以只读文件提供，并同时配置：

- `MN_PLUGIN_REPOSITORY_INDEX`：绝对路径的仓库索引；
- `MN_PLUGIN_TRUSTED_ROOTS`：绝对路径的 Ed25519 受信根文件；
- `MN_PLUGIN_REPOSITORY_DIGEST`：索引、受信根、manifest 和实际模块摘要形成的固定摘要。

三个变量必须同时存在。Host 先验证仓库序号、撤销时效、发布签名、包 SHA-256、精确依赖和包策略，再执行已读取的同一份模块字节。生产仓库拒绝浮动版本、install hook、远程 JavaScript、摘要降级和 release 回滚。当前企业文件仓库只接受自包含的 Host 入口；声明 Worker、UI 或 CLI 入口的第三方包会失败关闭，直到这些入口具备同等验签装载链。

插件 installation 和 lock 属于 tenant，激活属于 workspace。企业 Host 启动时通过存储列出已有 tenant，逐个恢复运行定义并核对持久化 lock。任一副本缺少已安装制品或 lock 被改写时，`/v2/readiness` 返回失败；`/v2/health`、首页和未受影响的官方插件仍可响应。全局安装、更新、停用和清除要求组织管理员或治理管理员，工作区启用和停用只允许该工作区 owner。

更新、全局停用和清除会先在租户权威存储写入插件操作锁；第三方插件的新执行和工作区启用会在同一存储获取短期使用租约。操作锁与使用租约互斥，因此一个 Host 排空时，其他 Host 不能接收新执行。操作锁不会按时间自动失效；若发起操作的 Host 异常退出，readiness 保持失败，管理员必须先核对执行、installation、工作区和投影切换状态，再人工处理残留锁。该选择避免未知结果被自动重放。

## 视图和插件

`business` 与 `professional` 是工作区展示设置，不是不同业务配置。插件安装是 tenant 级记录，启用是 workspace 级状态。插件配置属于各自 `dataNamespace`，不能用全局配置绕过授权或跨插件共享数据。

开发模式可显式启用本地路径与 HMR；生产环境不得加载远程 JavaScript。遥测保持关闭，启用任何新出站数据通道都需要独立设计和批准。
