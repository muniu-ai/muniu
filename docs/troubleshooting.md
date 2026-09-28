# 故障排查

先运行：

```bash
mn doctor --fix
```

该命令检查 Host health 与 readiness，并只执行可恢复的本地修复。它不会删除状态、批准高风险操作或重放结果未知的外部调用。

## Host 无法启动

默认地址是 `127.0.0.1:7318`。如果日志提示端口上已有早期 daemon，先从对应应用正常退出，再启动 0.2。不要杀死不明进程，也不要把 `MN_V2_STATE_ROOT` 指向早期数据目录。

检查：

```bash
curl --fail http://127.0.0.1:7318/v2/health
curl --fail http://127.0.0.1:7318/v2/readiness
```

health 表示进程与插件可响应，readiness 表示存储、密钥和 lock 条件允许接收工作。单个插件 degraded 时，核心 health 仍可成功。

若启动返回 `PROTECTED_CORE_STATE_UPGRADE_REQUIRED`，表示当前 0.2 数据仍采用旧版核心记录保护范围。保留原目录、备份和密钥；本地按 [CLI 备份升级](reference/cli.md#备份)恢复到新目录，企业按 [离线维护](enterprise-operations.md#离线维护入口)升级。不要清空数据库或跳过校验。

## 模型连接失败

回到 Desktop 的集成设置，重新选择厂商预设并运行探测。不要手工填写底层 Base URL、报文格式或内部模型标识。

确认：

- API Key 仍有效且具有模型访问权限；
- 系统时间准确；
- macOS Keychain 未锁定；
- 企业 Host 有权访问 Vault/KMS；
- 日志和错误响应没有包含密钥。

探测失败不会把明文密钥写入数据库。需要提交问题时只提供 `traceId` 和已脱敏诊断。

## 请求返回 `409`

`409` 通常表示 stream version 冲突，或同一 `Idempotency-Key` 被用于不同请求。刷新实体，使用最新 `streamVersion` 重新构造请求；不要只修改版本后盲目重放外部副作用。

如果幂等键已绑定其他请求，请为新的用户意图创建新键。原请求是否产生外部效果不明确时，到收件箱处理人工核对。

## 事件流返回 `410`

事件游标已超出保留期。重新读取工作区快照，保存服务端给出的最新 tenant position，再建立 SSE 连接。不要从旧游标猜测缺失事件。

工作区事件 ID 可以跳号，因为 tenant 内其他工作区的事件会被过滤。

## 执行停在等待审批

审批卡应显示意图、资源、effect class、有效期和 authority commitment。只可选择 `approve_once` 或 `deny`。以下任一项变化都会使原批准失效：

- 工具 ID 或版本；
- 参数或资源摘要；
- execution generation；
- authority commitment；
- 批准有效期。

守护进程重启后，待审批状态从权威存储恢复；无需重新提交原 turn。

## 执行需要人工核对

`needs_reconciliation` 表示系统无法确认一次外部副作用的结果。先到外部系统核对，再选择终止、标记已完成或创建新调用。不要直接恢复或重复点击执行。

## 插件降级

调用 `/v2/health?workspaceId=WORKSPACE_ID` 查看对应插件。检查签名、包摘要、依赖、plugin lock、投影重放与健康检查结果。

不要通过禁用签名或摘要校验恢复生产插件。新版本已经写入事件时不能自动降级；修复后发布更高 release sequence，或让活动执行在安全边界中断。

## Worker 不领取 Job

核对 Host 与 Worker 的 engine/plugin lock 摘要、租约时间和 fencing token。lock 不一致或生产保留策略缺失时拒绝 claim 是预期行为。

陈旧 Worker 的结果不能手工写回数据库。等待 30 秒租约过期，由新 owner 恢复；外部副作用结果未知时转入人工核对。

## Coding sandbox 不可用

Coding 执行必须 fail closed。检查 RuntimeClass、Candidate ServiceAccount、网络策略、共享存储和镜像摘要。不要切换到无隔离执行作为临时修复。

Claude 或 Codex Runner 的路径、版本或摘要变化时需要重新确认。外部 Runner 不接管模型连接、Prompt、Skill 或历史会话。

## 附件被拒绝

确认文件属于允许的文本、Markdown、JSON、CSV、PDF、PNG、JPEG 或 WebP；单文件不超过 20 MiB，一次不超过 20 个且总计不超过 100 MiB。

压缩包、可执行文件、路径逃逸、无效 UTF-8、扩展名与 MIME 不一致或媒体签名伪造都会被拒绝。不要通过改扩展名绕过检查。

## 提交诊断

只提交：

- `traceId`、时间、版本与操作系统；
- health/readiness 的非敏感摘要；
- 插件 ID、精确版本、release sequence 与包摘要；
- 复现步骤和预期结果。

提交前按 [日志脱敏规则](./security/redaction-policy.md) 处理诊断，并运行 [密钥扫描](./security/secret-scanning.md)。不要上传本地数据库、Keychain 内容、原始访谈、客户附件或完整模型上下文。
