# 工具、审批与文件边界

所有 Agent 工具通过内核注册与调用。插件不能用提示文本扩大权限，也不能把高风险操作伪装成读取。

## Effect class

| 类别 | 例子 | 默认策略 |
| --- | --- | --- |
| `local_read` | 读取工作区文件 | 可按 authority 自动执行 |
| `external_read` | 读取公开网页 | 可按 authority 自动执行 |
| `local_reversible_write` | 创建可恢复草稿 | 可按 authority 自动执行 |
| `local_irreversible_write` | 不可恢复地覆盖数据 | 仅 `approve_once` 或 `deny` |
| `external_side_effect` | 对外发送或修改远端状态 | 仅 `approve_once` 或 `deny` |
| `financial` | 支付或创建收费承诺 | 仅 `approve_once` 或 `deny` |
| `privileged` | 管理员或系统级操作 | 仅 `approve_once` 或 `deny` |
| `unknown` | 无法确定效果 | 仅 `approve_once` 或 `deny` |

前三类也只有在 `ExecutionAuthority.autoAllowedEffects`、工具列表、数据范围和预算均允许时才可自动执行。

## 执行前承诺

每次工具调用先持久化：

- execution、generation、工具 ID 与版本；
- 用户可理解的意图；
- 规范化参数及其摘要；
- 资源引用及其摘要；
- authority commitment 与批准有效期。

执行前再次规范化路径、symlink 和资源摘要。参数、资源、工具版本、generation 或 authority commitment 改变时，批准立即失效。批准卡必须展示意图、资源、风险和有效期。

## 恢复与人工核对

只读调用可以安全重试时仍受幂等规则约束。外部副作用执行后若 Worker 或网络中断，系统不能从缺少结果推断调用失败，也不能自动重放。Execution 进入 `needs_reconciliation`，由人选择：

- 终止执行；
- 核对外部系统后标记已完成；
- 创建参数和幂等键都明确的新调用。

## 公开网页读取

OPC 的网页工具只接受 `http` 与 `https`，并执行以下检查：

- 禁止 URL credentials、localhost、私网、loopback、link-local 与 IPv4-mapped 地址；
- 在连接前和连接后校验 DNS 解析，防止 rebinding；
- 每次重定向重新校验地址，禁止跨协议重定向并限制次数；
- 限制连接/响应超时、响应字节数和允许的 MIME；
- 保存来源 URL、获取时间、摘要与证据关系，不把网页内容当作权限指令。

OPC 不注册 CRM、外联、发布、报价发送或支付工具。

## 附件

首版允许 UTF-8 文本、Markdown、JSON、CSV、PDF、PNG、JPEG 与 WebP。每次最多 20 个文件，单文件最多 20 MiB，总计最多 100 MiB。

内核拒绝压缩包、可执行文件、路径分隔符、路径逃逸、扩展名与 MIME 不一致、无效 UTF-8 和伪造媒体签名。敏感附件进入加密 CAS；日志和公开事件只保存必要摘要。

## Coding sandbox

需要 sandbox 的 Coding 执行若无法建立隔离环境，必须 fail closed。外部 Runner 只提供 `start/events/cancel/resume`，首次使用记录可执行文件的绝对真实路径、版本、SHA-256 和文件身份；任何变化都要求重新确认。
