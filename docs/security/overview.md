# 安全边界

Agent OS 0.2 的安全模型以显式信任、最小权限、先持久化后执行和失败关闭为基础。它不把同进程插件描述成沙箱，也不把事件 HMAC 描述成宿主失陷防护。

## 信任分层

| 边界 | 信任与约束 |
| --- | --- |
| Host 核心 | 受信应用代码，持有存储与密钥访问能力 |
| 生产插件 | 与 Host 进程权限等价；依赖签名、摘要、来源和人工审阅建立信任 |
| Agent 与工具 | 受 `ExecutionAuthority`、effect class、批准、预算和数据范围约束 |
| Coding candidate | 在 fail-closed sandbox 中运行，不持有模型密钥或 Kubernetes token |
| 外部模型与服务 | 只获得当前批准范围内的数据；已经发送的数据无法召回 |

插件签名能证明包与受信发布者的关系，不能证明插件没有恶意行为。安装界面必须显示进程等价边界和完整权限。

## 身份与权限

本地使用隐式 `local` tenant 和 `local-owner`。企业身份由部署的认证层解析，组织角色与工作区 owner/operator/reviewer/viewer 分开授权。每个 Agent 行为同时记录发起人和 execution principal。

子 Agent 只能获得父 Agent 工具、数据范围、预算与时限的子集。提示注入、网页内容、Skill 文本和模型输出都不能授予权限。

启动、恢复、模型请求、审批和工具派发检查当前工作区权限。撤权使尚未派发的操作停止、旧批准失效；已经准入的在途请求只能尽力取消。重新授权不能清除未知副作用，详见[执行准入决策](../adr/0012-application-boundaries.md)。

## 工具与副作用

模型上下文、工具参数摘要、资源摘要、generation 和 authority commitment 必须在外部调用前持久化。高风险 effect class 只能 `approve_once` 或 `deny`；批准绑定完整调用身份，并在参数或资源变化时失效。

执行前重新解析路径、symlink 和资源摘要，防止批准后的 TOCTOU。结果未知的外部副作用进入 `needs_reconciliation`，不得自动重放。

## 数据保护

本地 SQLite 文件权限收紧并使用 WAL/FULL；敏感 payload 与 CAS 使用 AES-256-GCM，数据密钥由 macOS Keychain 包装。企业使用 PostgreSQL、S3 与 Vault/KMS。受保护附件先加密再写 CAS，wrapped DEK 不与密文存放在同一对象中。

模型 API Key、访问 token、私钥和密码不得进入事件公开 payload、日志、诊断、fixture 或持久化成果。原始访谈、客户资料与敏感附件存入加密 payload/CAS，只公开必要摘要。OPC 访谈事件、机会投影和幂等记录只保存受保护 Asset ID；授权读取和导出响应按需解密，不缓存原文。

含用户正文的核心记录也使用加密事实日志，普通事件不再复制这些记录的正文。旧 0.2 明文核心事实需要[显式升级](../reference/cli.md#备份)，升级不擦除既有历史事件、历史备份或已经导出的明文。

删除敏感内容时，先提交 tombstone 与独立包装密钥的撤销请求，移除当前正文投影和密钥引用，再销毁包装密钥。只有确认销毁后才能显示加密删除完成；撤销结果未知时保留人工核对要求，不自动重发。不可变审计只保留操作者、时间、对象摘要与原因摘要，不保留已删除明文或密钥材料。

历史事实仍引用的 CAS 密文会保留；GC 只清理没有历史引用且超过保留期的孤儿对象。恢复删除前的 KMS 备份可能恢复包装密钥，因此密钥系统恢复必须同时处理后续撤销记录。具体流程见[企业保留与删除](../enterprise-operations.md#保留与删除)。

## 网络与内容

OPC 公开网页读取阻止 URL credentials、本机、私网、loopback、link-local、IPv4-mapped、DNS rebinding 与跨协议重定向，并限制次数、超时、字节数和 MIME。网页内容始终是不受信输入。

附件只接受规定的文本、文档和图片类型，同时校验文件名、扩展名、MIME、媒体签名、UTF-8 和大小。压缩包与可执行文件被拒绝。

Desktop 生产 CSP 只允许同源脚本，并设置 `object-src 'none'`、`frame-src 'none'`、`base-uri 'none'`、`form-action 'none'`。开发 CSP 只额外允许本机 HMR，并持续显示开发模式警告。

## 完整性与审计

事件使用 tenant position、aggregate stream version、摘要链与 HMAC。HMAC 能发现不知道密钥的数据库改写；若宿主或 KMS 管理员失陷，该保证不成立。

摘要链不能证明数据库从未整体回退。数据库、CAS 和密钥独立恢复后，仍需核对授权、撤销记录与外部回执；缺少这些证据时不能凭旧快照继续未知操作。

插件安装、升级、卸载、配置变更，批准、工具调用、记忆共享与删除都产生审计记录。遥测默认关闭，不生成匿名标识，不上传反馈。

## 验证重点

- 租户与工作区隔离；
- 审批参数篡改、TOCTOU、路径穿越与 symlink；
- SSRF、DNS rebinding、跨协议重定向与恶意附件；
- 提示注入不扩大权限；
- 密钥和客户资料不进入日志；
- OPC 跨 tenant、跨工作区 Asset 引用被拒绝，删除或撤权后读取失败关闭；
- sandbox 不可用时 fail closed；
- 陈旧 Worker、批准和 generation 被拒绝；
- 未知外部副作用只进入人工核对。

具体规则见 [工具与审批](../reference/tools.md)、[日志脱敏](./redaction-policy.md) 与 [密钥扫描](./secret-scanning.md)。
