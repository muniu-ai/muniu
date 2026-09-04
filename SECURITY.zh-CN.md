# 安全策略

## 支持版本

安全修复面向 Agent OS 0.2 的最新已发布补丁。源码快照、开发分支和本地修改构建不承诺响应或修复时限。

## 报告漏洞

请使用 [GitHub 私密漏洞报告](https://github.com/muniu-ai/muniu/security/advisories/new)。该功能不可用时，使用木牛 GitHub 组织主页列出的私密联系方式。不要在公开 issue 中提交利用细节、密钥、客户资料、模型上下文或附件。

报告应包含受影响版本和提交、复现条件、影响、建议严重级别与最小安全复现。维护者会在条件允许时确认完整报告，并协调修复和披露；项目不承诺响应时限。

## 信任边界

- 官方与第三方生产插件在 Host 进程内运行。签名、摘要、权限和 `ExecutionAuthority` 保护安装及经内核调用的动作，但不能隔离恶意的进程等价代码。
- Coding sandbox 隔离候选实现。无法证明所需 sandbox 可用时，执行必须失败关闭，不能退回 Host 直接运行。
- Desktop 与 CLI 调用相同的 Host 契约。视图模式只能改变展示，不能减弱策略、审批或审计。
- 遥测和诊断上传默认关闭。BYOK 是唯一模型连接方式。

## 密钥与受保护数据

本地模型凭据和数据包装密钥写入 Agent OS 0.2 专用 Keychain service；企业凭据写入 Vault/KMS。密钥不得进入事件、投影、日志、fixture、诊断、搜索索引、崩溃报告或发布物。

敏感事件 payload 与 CAS 对象使用 AES-256-GCM，并由独立数据密钥加密。删除受保护内容时销毁对应数据密钥并追加 tombstone；不可变审计只保留操作者、时间、对象摘要和原因。事件 HMAC 可检测没有密钥的数据库改写，但不用于抵御 Host 或 KMS 管理员失陷。

脱敏只是补充措施，不能代替访问控制。详见[日志脱敏规则](docs/security/redaction-policy.md)与[密钥扫描](docs/security/secret-scanning.md)。

## 工具、审批与恢复

每次工具调用都在执行前记录规范化参数、资源、工具版本、execution generation 和 authority commitment。执行前再次规范化路径与资源摘要；任一项变化都会使原批准失效。

只读操作和可恢复的本地写入，只有在 authority 与策略允许时才能自动执行。不可恢复写入、外部副作用、财务操作、特权操作和未知效果只接受 `approve_once` 或 `deny`。提示文本不能授予权限。

模型请求上下文必须先持久化。Job 使用租约和 fencing token，陈旧 Worker 不能提交结果。外部副作用结果未知时进入 `needs_reconciliation`，不得自动重放。

## 网络与附件

OPC 公开网页读取器只接受 HTTP 和 HTTPS，拒绝 URL 凭据、本机、私网、link-local、IPv4-mapped 绕过、DNS rebinding 与跨协议重定向，并限制重定向次数、响应大小、耗时和 MIME。

附件只接受 UTF-8 文本、Markdown、JSON、CSV、PDF、PNG、JPEG 和 WebP。Host 拒绝压缩包、可执行文件、路径逃逸、MIME 伪装、超过 20 个文件、单文件超过 20 MiB 或单次超过 100 MiB 的请求。

## 企业运行

生产 readiness 要求配置业务数据、执行、成果和审计保留策略。tenant 范围覆盖事件、投影、Job、CAS 引用、插件、记忆与 share grant。Host 与 Worker 的 engine/plugin lock 摘要必须一致。

企业升级采用蓝绿切换，不能混合版本滚动更新。PostgreSQL、S3 与 Vault/KMS 恢复必须保证已提交事件 RPO 为 0，并拒绝缺失或被篡改的内容。详见[企业运维](docs/enterprise-operations.md)。

## macOS 分发

公开 macOS 产物必须通过 Developer ID 签名、Apple 公证、staple、Gatekeeper 评估、摘要校验和干净设备安装测试。运行时 updater 保持关闭；本地 unsigned 构建不能作为公开发布物。

## 不受理范围

必须主动关闭已记录的保护措施才能触发的问题、需要不合理流量的拒绝服务、没有产品缺陷的社会工程，以及不受支持的修改快照，可能不发布安全公告。维护者仍会审慎评估可信影响。
