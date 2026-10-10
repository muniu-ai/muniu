# `mn` 命令行

`@mn/cli` 是木牛 Agent OS 0.2 的命令行 Shell。业务命令调用 Host 的 `/v2` 接口；`backup` 直接使用本地存储和 Keychain。默认输出适合直接阅读，`--json` 提供机器格式。

命令解析、HTTP 客户端与本地备份入口位于 [src/index.ts](src/index.ts)，契约客户端来自 `@mn/contracts`。CLI 不装配产品插件或 Kernel。

## 命令面

```text
mn setup
mn ask
mn inbox
mn resume
mn doctor --fix
mn plugin ...
mn opc ...
mn code ...
mn goal ...
mn skill ...
mn memory ...
mn followup ...
mn asset ...
mn business context ...
mn backup ...
```

`setup` 负责视图、插件、模型与工作区设置；`inbox` 汇总审批、Agent 问题、凭据失效、执行失败和人工核对。OPC 与 Coding 子命令只封装插件领域路由，不能绕过内核审批或代替人工确认。

`mn ask <问题> --workspace <工作区 ID>` 会自动选择工作区最近的机会或 Coding 任务会话。有多个机会时，可用 `--opportunity <标题关键词>` 选择，无需查找 Thread ID。

外部 Coding Runner 只支持官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。Host 确认阶段不会执行目标路径；确认后，Worker 才会把已确认制品复制到其管理的只读目录，并在受限环境中探测版本。

完整参数、退出码和 JSON 格式见 [CLI 参考](../../docs/reference/cli.md)。

## 资料与业务上下文

```bash
mn asset upload --workspace WORKSPACE_ID --file ./资料.docx --key MATERIAL_REQUEST_ID --json
mn asset extract ASSET_ID --json
mn business context customer CUSTOMER_ID --workspace WORKSPACE_ID --json
```

资料上传始终使用受保护 Asset，支持 TXT、Markdown、CSV、JSON、PDF、DOCX 和 XLSX，每份不超过 20 MB。上传返回 `asset` 和 `sourceRef`；将 `sourceRef` 加入 `mn goal create --file` 输入的 `resourceRefs`，无需把资料全文复制到 `objective`。`digest` 原样取 Host 返回值，不使用本地文件摘要替代。

团队执行需要显式选择。先用 `mn goal templates --workspace <id>` 查看可用模板，再用 `mn goal plan <goal-id> --workspace <id> --version <版本> --team research-summary --model <连接-id>` 生成待审阅计划。模板还包括 `business-proposal` 和 `code-delivery`，首版均使用内置模型。省略 `--team` 时沿用单 Agent 调度。

`mn goal nodes <goal-id> --workspace <id>` 返回步骤、尝试记录和当前允许的操作。团队可用 `goal pause`、`goal resume` 控制；人工节点使用 `goal decide --node <节点-id> --decision continue|stop`。变更仍须指定目标、工作区及 `--version`，计划和执行控制可附 `--key`，响应丢失时用原参数与原键重试。结果未知时按 Host 提供的核对方式处理。

`--key` 是这次上传的请求标识。响应丢失时保持文件、工作区和标识不变，重新运行同一命令；CLI 不自动重发。省略时按既有约定生成随机请求标识。提取结果保留 `complete`、`partial` 或 `unreadable` 状态、遗漏说明与页码、段落或单元格位置，提取成功不代表 Agent 已阅读全部资料。

业务上下文支持 `customer`、`service`、`quote`、`order`、`delivery` 和 `review`，返回当前授权下的事实正文与版本引用。资料或经营记录变化后，应重新读取并审阅计划；读取上下文不修改经营台账。`service` 选择当前服务版本，`quote` 保留报价固定的服务版本；历史回源同时传入 `--version <事实版本>` 与 `--digest <来源摘要>`。报价接受使用 `quote.confirm`，订单生效另用 `order.activate`，客户验收与实际收款也分别登记。

## 成果决定、返工与经营候选

`goal create` 的 `deliverables` 可包含多个交付项，每项使用独立的 `key`、名称与验收标准。`goal show` 返回当前成果、逐项决定和历史版本。

```bash
mn goal delivery-decide GOAL_ID --workspace WORKSPACE_ID --version 5 --file decisions.json --key DECISION_REQUEST --json
mn goal rework-preview GOAL_ID --workspace WORKSPACE_ID --version 6 --decision DECISION_ID --key PREVIEW_REQUEST --json
mn goal rework GOAL_ID --workspace WORKSPACE_ID --version 6 --preview PREVIEW_ID --preview-digest PREVIEW_DIGEST --key REWORK_REQUEST --json
```

逐项决定文件包含 `deliverySetId`、`criteriaVersion` 和非空 `items`。每项固定 `key`、`digest`，选择 `accept` 时附 `reviewedCriterionIds`；选择 `request_changes` 时附 `failedCriterionIds` 与 `instruction`；选择 `defer` 时可附 `reason`。未提交的成果保留原决定。返工预览返回受影响步骤、沿用成果、剩余额度及原期限，核对后再确认；新修订不会覆盖历史成果和费用。

成果的 `businessProposals` 列出可审阅的经营建议，创建候选时只引用该成果与候选标识。Host 生成字段差异、依据和经营影响，CLI 不提交任意业务命令来伪造候选。

```bash
mn business candidate create --workspace WORKSPACE_ID --goal GOAL_ID --plan PLAN_ID --delivery-set SET_ID --output OUTPUT_KEY --output-digest OUTPUT_DIGEST --proposal PROPOSAL_KEY --key CANDIDATE_REQUEST --json
mn business candidate list --workspace WORKSPACE_ID --json
mn business candidate show CANDIDATE_ID --workspace WORKSPACE_ID --json
mn business candidate decide CANDIDATE_ID --workspace WORKSPACE_ID --version 1 --business-version 9 --candidate-digest CANDIDATE_DIGEST --preview-digest PREVIEW_DIGEST --decision apply --key APPLY_REQUEST --json
```

采纳前核对字段变化及 `availability`。过期候选需要重新核验；`reject` 只拒绝建议。以上变更支持 `--key`，响应丢失时保持全部参数和键不变重试。

## 技能、记忆与受控跟进

```bash
mn skill list --workspace WORKSPACE_ID --json
mn skill show SKILL_ID --workspace WORKSPACE_ID --skill-version 1 --json
mn memory list --workspace WORKSPACE_ID --json
mn memory accept MEMORY_ID --version 1 --key MEMORY_DECISION --json
mn followup list --workspace WORKSPACE_ID --json
mn followup create --workspace WORKSPACE_ID --file followup.json --key FOLLOWUP_REQUEST --json
mn followup pause POLICY_ID --workspace WORKSPACE_ID --version 1 --key PAUSE_REQUEST --json
```

`skill list --goal GOAL_ID` 查询 Host 对指定新目标给出的推荐，返回的 `recommended` 不会自动替换计划。技能版本来自已验收的团队成果。`skill create` 文件填写固定 `source`（目标、计划、成果集与摘要）、名称、说明及角色；新技能 `--version 0`，后续版本使用技能流的当前版本。`skill evaluate` 登记固定模型、资料、权限、预算和代码版本；`skill report` 提交受保护报告的 `reportRef` 与人工或确定性 `evidence`。可先通过 `asset upload` 获取报告来源引用。

`skill enable|rollback` 的 `--version` 取详情中的 `activation.streamVersion`，并指定技能版本、摘要与通过评测的 ID。只有显式添加无值开关 `--recommend` 才申请自动推荐，Host 仍检查实测质量门。`skill disable` 清空启用指针并停止后续推荐，用户仍可明确试用可访问的固定版本；已运行任务继续固定旧版本。

来源撤权后，技能详情可能无法读取。若 `skill list` 返回 `stopControl.expectedStreamVersion`，可将该版本用于 `skill disable --version`；目录不会为此返回旧资料或角色正文。

试用先新建目标，再用 `goal plan --team TEMPLATE --model MODEL_ID --skill SKILL_ID --skill-version VERSION --skill-digest DIGEST`。新目标重新选择资料范围与额度，保留技能输出要求；省略团队及技能参数时仍为单 Agent。

`memory propose` 的 JSON 可附 `provenance`：`version:1`、`kind:fact|preference`、`origin:user|model`、`sourceRefs`。模型提案还需真实 `sourceExecution`，Host 补足来源闭包；确认前不会成为跨任务记忆。资料失效时按返回的 `access` 与 `allowedActions` 处理，不把隐藏内容当作空事实。

跟进文件必须明确 `enabled:true`，并绑定原目标版本、批准计划摘要、触发对象、资料范围、内置模型连接、`perRunBudget`、`periodBudget`（24 小时或 7 天）、`maxRuns` 与 `expiresAt`。周期额度是新的授权，原任务额度不重置。无变化不调用模型；暂停只停止新派发，未知费用保留待核对。各命令返回完整版本及允许操作，变更响应丢失时保持参数和 `--key` 不变重试。

## 本地开发

先按[贡献指南](../../CONTRIBUTING.md)准备 Node.js 22.19.x、npm 11.10.1 并执行 `npm ci`。需要调用业务命令时，在仓库根目录启动 Host：

```bash
npm run dev:host
```

另开终端构建并运行 CLI：

```bash
npm run dev:cli -- --help
npm run dev:cli -- doctor
```

默认连接 `http://127.0.0.1:7318`。需要改用其他 Host 时设置 `MN_API_URL`。`doctor` 读取健康与就绪状态；`doctor --fix` 还会重新探测未就绪的模型连接并更新状态，可能访问模型服务。

`backup` 使用 `MN_V2_STATE_ROOT` 指定的本地状态根，默认是 `~/.muniu/v2`；它不受 `MN_API_URL` 影响。备份与恢复的前置条件见 [CLI 参考](../../docs/reference/cli.md)。

## 验证

先在仓库根目录完成 `npm run build`，再执行：

```bash
npm run typecheck -w @mn/cli
npm run test -w @mn/cli
```

不要通过 CLI 参数传递模型密钥。模型连接应由 Desktop 向导创建，密钥由 Host 写入 Keychain 或企业密钥系统。

## 责任、导出与只读连接

```bash
mn goal assignment GOAL_ID --workspace WORKSPACE_ID --json
mn goal assign GOAL_ID --workspace WORKSPACE_ID --version 0 --responsible PRINCIPAL_ID --key ASSIGN_REQUEST --json
mn goal unassign GOAL_ID --workspace WORKSPACE_ID --version ASSIGNMENT_VERSION --key CLEAR_REQUEST --json
mn notification read NOTICE_ID --workspace WORKSPACE_ID --version NOTICE_VERSION --key READ_REQUEST --json
mn goal export GOAL_ID --workspace WORKSPACE_ID --plan PLAN_ID --delivery-set SET_ID --output-key OUTPUT_KEY --output-digest OUTPUT_DIGEST --format pdf --key EXPORT_REQUEST --json
mn goal exports GOAL_ID --workspace WORKSPACE_ID --json
mn goal export-save GOAL_ID --workspace WORKSPACE_ID --export EXPORT_ID --output ./report.pdf --json
```

责任版本取 `goal assignment` 的 `assignment.streamVersion`，初次为 0。只允许选择 Host 标记可用的成员；赋责不改变任务读取权限、执行身份或授权。通知已读版本取收件箱记录，`notification unread` 可标回未读；这些操作不处理审批或验收。

导出固定计划、成果集、成果项及摘要，支持 `pdf`、`docx` 和 `xlsx`。`goal export` 创建导出记录，`export-save` 读取同一记录并保存文件，下载失败无须重新生成。保存前检查类型、20 MiB 上限、长度和明文摘要；文件按私有权限创建，不覆盖已有文件或符号链接。导出记录的 `accepted` 仅表示导出时 Agent 成果是否已接收，不表示客户验收。

```bash
mn mcp create --workspace WORKSPACE_ID --file connection.json --key CONNECTION_REQUEST --json
mn mcp list --workspace WORKSPACE_ID --json
mn mcp requests --workspace WORKSPACE_ID --json
mn mcp request CONNECTION_ID --workspace WORKSPACE_ID --version CONNECTION_VERSION --file request.json --key READ_REQUEST --json
mn mcp show REQUEST_ID --workspace WORKSPACE_ID --json
mn mcp disable CONNECTION_ID --workspace WORKSPACE_ID --version CONNECTION_VERSION --key DISABLE_REQUEST --json
mn mcp rotate CONNECTION_ID --workspace WORKSPACE_ID --version CONNECTION_VERSION --credential-file ./credential.txt --key ROTATE_REQUEST --json
```

连接文件填写 `label`、HTTPS `endpoint`、`expiresAt`、`uriPrefixes` 和 `maxRequests`；需要身份验证时可填写 `bearerToken`，使用后妥善处理本地凭据文件。不要把凭据放进命令行参数。MCP 响应不返回凭据。

读取请求文件先用 `{"kind":"resources"}` 或 `{"kind":"templates"}` 发现获准资料。应用重启后通过 `mcp requests` 找到已有请求，再使用 `mcp show` 读取；请求状态列表不返回资源正文或附件引用。请求返回后使用 `mcp show` 查询；只有 `completed` 才能选中目录结果。导入填写 `kind:"read"` 和 `selection:{catalogRequestId,uri}`；简单模板使用 `uriTemplate` 与 `variables`。分页使用上一页 `nextCursor`。读取次数包含目录、模板和资料读取，结果未知时先核对，不通过新请求重跑。

导入返回受保护 `assetRefs`，可通过 `asset extract` 核对解析状态与位置，再明确加入目标 `resourceRefs`。快照版本不会随远端更新。连接只提供资料发现和读取，不开放工具调用、脚本或消息发送。响应丢失时保持请求参数和 `--key` 不变重试。
