# DeepSeek Harness rc.8 选择性 backport 实施记录

本改造不引入 DeepSeek Harness 运行时，也不改变 Muniu 的静态插件、工具审批、sandbox、telemetry 默认关闭和 macOS 首发边界。上游来源只能使用治理清单批准的两个固定提交，并按文件登记归属。

已实施的闭合能力：

- 明确取消时保存已组装的非空 text/thinking 前缀；完整或残缺 tool call 均不保存，provider/解析/持久化错误不伪装成取消。
- `ProviderWireCompatibilityV1` 显式控制 system role、stream usage、输出 token 字段和 reasoning 编码；默认 wire 请求保持不变，非法组合在 fetch 前失败，route/config digest 纳入配置。
- `AgentSessionEventV2` 支持图片 descriptor。V1 仍为 text-only，JSONL header 与每个 event 必须同版本；原始 bytes 只存在于临时 provider input，不进入事件、receipt、日志或 model audit。
- 本地附件使用权限 0700/0600、content-addressed、create-only object store；企业对象适配器使用 tenant/session HMAC key、S3 create-only 与 PUT/HEAD/GET digest 校验。只允许完整解码的 PNG/JPEG/WebP，不允许动画或多页图片。
- 图片上限通过 `BuildServerOptions.agentMultimodalLimits` 配置；默认采用单图 3.5 MiB、单边 2000 px、每消息 20 张、请求 base64 20 MiB。超出请求预算时仅在临时请求副本中确定性替换最旧图片，持久历史不变。
- SQLite schema v2 使用固定 SQL、STRICT tables、WAL、`synchronous=FULL`、事务与启动读回验证。旧 blob 先备份后单事务迁移，失败回滚；proxy log、replay 与 health 高频写入不再重写完整状态。

明确未引入 Claude/Codex Profile Bundle、Windows PTY、Python SDK、DSH Web/CLI、ACP、telemetry、feedback upload、任意 URL fetch、动态插件或自动五次 Provider retry。
