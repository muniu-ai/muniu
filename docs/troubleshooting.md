# 故障排查

先在仓库根目录执行只读诊断。需要先完成项目构建，并保持 Desktop 或独立 Host 运行：

```bash
node apps/cli/dist/index.js doctor --json
```

检查 `data.readiness.ready` 和 `data.readiness.issues`。`ok: true` 或退出码 `0` 仅表示诊断命令完成，不一定表示 Host 就绪。

如果尚未构建 CLI，先执行 `npm run build`。本文命令使用源码入口；已安装 CLI 时可用 `mn` 替换 `node apps/cli/dist/index.js`。

## 首次构建或启动失败

| 现象 | 检查与处理 |
| --- | --- |
| `npm ci` 或构建报告工具版本不符 | 在仓库根目录检查 `node --version`、`npm --version` 和 `rustc --version`，分别使用 Node.js `22.19.x`、npm `11.10.1`、Rust `1.88.0` |
| 找不到 `apps/cli/dist/index.js` | 回到仓库根目录，完成 `npm ci` 和 `npm run build` |
| Tauri 找不到 `mn-host` sidecar | 先执行 `npm run build:host-sidecar`，再启动 Tauri；该构建只支持 macOS |
| 找不到 Apple 构建工具 | 用 `xcode-select -p` 检查开发工具目录，并确认 `clang`、`lipo`、`codesign` 可用 |
| 打开了浏览器页面，但无法连接 Host | `npm run dev:desktop` 只启动页面；另开终端执行 `npm run dev:host`，或按快速开始启动完整 Desktop |

完整命令顺序见[快速开始](./quickstart.md)。

## Host 无法启动

默认地址是 `127.0.0.1:7318`。Desktop 会拒绝在已占用的端口上启动；占用者可能是旧版 daemon，也可能是另一个 0.2 Host。Desktop 托管 Host 与 `npm run dev:host` 不能同时占用该端口。

先从对应应用正常退出，或在自己启动独立 Host 的终端按 `Ctrl+C`。不要杀死不明进程，也不要把 `MN_V2_STATE_ROOT` 指向早期数据目录。

检查：

```bash
curl --silent --show-error http://127.0.0.1:7318/v2/health
curl --silent --show-error http://127.0.0.1:7318/v2/readiness
```

连接被拒绝说明该地址当前没有可响应的 Host。能收到响应时，检查 health 的 `data.core.status` 和 readiness 的 `data.ready`、`data.issues`。readiness 未就绪会返回 HTTP `503`，因此这里保留响应体供诊断。单个插件降级时，核心 health 仍可成功；Host 就绪也不代表已经配置模型。

若启动返回 `PROTECTED_CORE_STATE_UPGRADE_REQUIRED`，表示当前 0.2 数据仍采用旧版核心记录保护范围。保留原目录、备份和密钥；本地按 [CLI 备份升级](reference/cli.md#备份)恢复到新目录，企业按 [离线维护](enterprise-operations.md#离线维护入口)升级。不要清空数据库或跳过校验。

## 模型连接失败

首次向导的“连接模型”要求填写 API Key，没有跳过按钮。无密钥时可先进行 [CLI 练习](./guides/cli.md#无模型密钥的首次练习)，但不能进行真实模型执行。

已经进入工作台时，打开“技术配置 → 集成 → 模型连接”，对已有连接点击“检查连接”。需要更换密钥时，选择模型厂商，填写“新模型密钥”，点击“保存并用于新任务”。新默认连接只影响新执行，不会自动恢复暂停任务。

也可执行：

```bash
node apps/cli/dist/index.js doctor --fix --json
```

`--fix` 会重新探测未就绪的模型连接，可能向厂商发送请求。它不会替换无效密钥、删除状态、批准工具或重放结果未知的外部调用；它也不会把端口冲突或 lock 故障自动修复。

确认：

- API Key 仍有效且具有模型访问权限；
- 系统时间准确；
- macOS Keychain 未锁定；
- 企业 Host 有权访问 Vault/KMS；

不要将 API Key 放入终端参数或诊断附件。需要提交问题时提供 `traceId` 和已脱敏诊断。

## 样例成功，但没有 Agent 回答或代码差异

“运行只读样例”只验证对应插件已启用并记录完成事件，不调用模型、读取网页或读取仓库。创建机会或 Coding 任务也不会自动发送 Agent 消息。

打开机会档案或 Coding 任务，在“给 OPC Agent 的消息”或“给 Coding Agent 的消息”中描述请求，再发送。真实执行需要可用模型；Coding 还需要实际仓库和 sandbox。流程分别见 [OPC 指南](./guides/opc.md)与 [Coding 指南](./guides/coding.md)。

## Coding 无法捕获任务

先在“Coding → 工作区仓库”登记仓库绝对路径。只有一个仓库时自动选择，有多个仓库时必须在快速捕获的“任务仓库”中选择一个。

登记仓库只保存路径。路径不存在或没有权限时，登记成功也不代表之后能够执行。首次向导中的“第一个仓库或任务”创建的是仓库记录，任务要在进入工作台后另行捕获。

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

本机 Coding 默认使用 macOS 的 `/usr/bin/sandbox-exec`。系统不是 macOS、程序缺失或真实路径变化时，默认本地执行会拒绝继续。

企业 sandbox 需检查 RuntimeClass、Candidate ServiceAccount、网络策略、共享存储和镜像摘要，见[企业运维](./enterprise-operations.md)。任何部署都不能切换到无隔离执行作为临时修复。

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
