# 委派任务、跟进执行与验收成果

任务把预期结果、资料、执行计划和验收条款绑定到经营或研发会话。默认由单 Agent 完成，可推荐或指定内置 Agent、Codex CLI、Claude Code；需要分工时可显式选择固定团队模板。团队功能的本轮集成状态见[P2 验证记录](../verification/agent-os-p2-2026-10-10.md)，不会自动替换现有单 Agent 计划。

开始前，完成[快速开始](../quickstart.md)，启用对应插件；内置 Agent 需要就绪的模型连接，外部 CLI 需要启用对应 Runner 插件并确认原生可执行文件。桌面端会为新任务创建会话，CLI 可以关联已有 Thread。Coding 还需满足原任务的 Spec、Governance、Harness 和沙箱准入。创建目标和保存计划不会开始 Agent 执行；确认计划后启动才可能产生模型费用和工具调用。

本文使用源码 CLI。命令在仓库根目录执行，Host 的连接方式见 [CLI 指南](./cli.md)。已安装 CLI 时可把 `node apps/cli/dist/index.js` 替换为 `mn`。

## 在桌面端操作

点击「委派任务」，或按 Command / Ctrl + J，选择经营或研发。填写任务目标和逐行验收要求，也可以从经营复盘、客户与服务、实现功能、排查问题等模板开始。研发任务需选择仓库；尚未登记时，可直接选择文件夹并登记。

“添加资料”支持 TXT、Markdown、CSV、JSON、含文本的 PDF、DOCX 和 XLSX，也可拖入文件。最多 6 份，每份不超过 20 MB；文本文件使用 UTF-8。文件保存为受保护资料，目标保存版本引用，正文不占目标说明的 16000 字符额度。点击资料名称核对解析状态和定位；部分提取不表示完整阅读，详见[资料指南](./materials.md)。经营任务可附加经营汇总快照，提交前核对统计期间和版本。

经营汇总显示读取时的事实版本，快照不会随台账更新。文件也不会追踪本机后续修改；从客户、订单、交付或复盘页面委派时，绑定的业务事实版本会在执行前重新核对。

选择单 Agent 时，在“交给谁来完成”中选择自动推荐或指定执行者，默认质量优先；在“补充约束与执行额度”中填写币种和限制。内置模型必须支持所选币种。点击「准备执行计划」会保存任务和待审阅计划，不会调用模型。核对目标、资料、执行者、推荐依据、工具范围与额度后，再点击「确认计划并启动」。网络中断后点击「继续准备」，会沿用本次请求，不重复创建任务。

左侧「任务」提供任务列表、搜索和状态筛选。草稿只保留在本窗口，切换页面不会丢失；退出应用前需准备计划以保存任务。原「捕获」只保存一条机会或研发任务记录，现已由明确的委派入口替代；单独记录机会仍在「机会验证」中完成。

单 Agent 执行中可查看会话、补充说明或调整方向。补充内容不改变已确认的范围、验收要求或额度。团队成员由固定计划管理，不能直接向成员会话补充消息或另行启动。需要审批时，进入收件箱或「查看业务对象」；执行结束后不能直接在旧任务下开启额度外执行，新范围需新建任务。

运行中需要改变范围时，先取消旧任务，核对收件箱中的未决审批或待核对结果，再以新范围创建任务。启动或接收成果时断线，先点击错误提示中的「重试」读取任务状态；已进入执行中或已验收时，无须再次提交。状态仍待确认时，核对最新计划再操作，不能靠重复委派判断是否成功。

本地执行依赖桌面应用保持运行。退出应用会关闭本机执行服务；重新打开后，从「任务」列表查看已保存任务和当前状态。出现中断或结果待核对时，按任务及收件箱提示处理，不直接新开重复执行。

成果出现后，先阅读正文或代码差异，逐条勾选已经复核的标准，再点击「接收成果」。成果可下载为 Markdown 文件。来源或权限变化后，旧成果预览会隐藏，需先处理相关变化。经营助手提供方案和分析，不自动改账、发送报价或收付款。

预览因来源或权限变化而隐藏时，从「查看业务对象」核对资料，并在收件箱检查未决事项。无法恢复原有资料与授权版本时，使用当前资料新建任务并重新审阅，不能把旧成果当作当前资料下的验收结果。

「关联已有任务」保留针对现有机会或研发任务创建目标的入口。下文为 CLI 与 API 使用方式。

## 显式选择团队

在委派表单的“执行方式”中选择模板，并选择与预算币种一致的内置模型。模板不可用时会显示缺少的模型、插件或沙箱条件；保持“单 Agent”即可沿用原调度方式。团队首版不使用外部 CLI，不自动增删节点，也不在失败后自动改换执行者。

| 模板 | 执行步骤 | 需要用户决定什么 |
| --- | --- | --- |
| 研究汇总 | 主要方向与反证取证 → 汇总 → 独立复核 → 汇合 | 核对来源、反证和成果验收条款 |
| 经营方案 | 整理需求 → 方案与报价候选 → 独立复核 → 确认事实 → 汇合 | 人工确认业务事实后继续或停止；此决定不登记客户接受、订单生效或收款 |
| 代码交付 | Coding 完成规格、实现、检查与批准候选 → 只读复核 → 汇合 | 保留原 Coding 审批和成果验收；须启用 Coding、OPC 及可用沙箱 |

代码变更保存在隔离候选中，批准候选不自动写回原仓库。研究和经营模板只分析本次绑定的获准资料，不自动搜索网页或联系客户。计划显示每个步骤的依赖、输入输出、执行者和额度。审阅后点击“确认计划并启动”。详情按目标、计划、进展、成果分组；进展显示等待原因、节点尝试和当前允许的操作。

“暂停”立即阻止后续步骤派发，已派发步骤可完成当前工作；恢复前重新核对授权和来源。暂停和恢复不改变计划版本、不重置预算或期限。“取消”保留已发出操作和费用的核对记录。状态为“需要核对”时不能通过新节点、另一 Agent 或重复委派重放未知操作。

独立复核读取要求、成果和证据，默认不接收生成者自评分。模型判断只作辅助；复核通过后仍需有效的程序证据和用户逐项接收。复核要求修改时，本轮不自动返工，也没有扩充预算的重试入口。

完成下文的创建目标步骤，取得工作区和目标 ID 后，CLI 使用同一流程：

```bash
mn goal templates --workspace "$WORKSPACE_ID" --json
mn goal plan "$GOAL_ID" --workspace "$WORKSPACE_ID" \
  --version '替换为当前 goal.streamVersion' --team research-summary \
  --model '替换为模型连接 ID' --key '本次计划请求的唯一标识' --json
mn goal nodes "$GOAL_ID" --workspace "$WORKSPACE_ID" --json
```

使用下文的 `goal start` 启动已审阅计划。团队控制支持 `goal pause`、`goal resume` 和 `goal cancel`，均需目标 ID、`--workspace` 与最新 `--version`。经营团队等待确认时，使用 `goal decide "$GOAL_ID" --workspace "$WORKSPACE_ID" --version <当前版本> --node confirm --decision continue`；选择 `stop` 会停止后续工作。响应丢失时，保持原参数及 `--key` 重试；版本冲突时先读取当前事实。

## 查看调度依据与核对费用

单 Agent 计划展示候选执行者、同类任务的验收记录、预计执行费和耗时。质量记录只计入已验收或已失败、且完成费用结算的任务；待验收答复不算成功。样本不足时显示初始估计，不能据此判断哪个模型更强。任务类型、负载分组、工作区和连接版本分别统计；这些分组不能消除不同任务难度造成的偏差。

自动调度采用质量门槛，再比较所选偏好的成本与时间。CLI 尚无足够已结算记录时，需要先人工指定；未知费用不会按免费处理。用户可选填完成价值和时间成本，同币种计算估计净收益及 ROI；未填价值时只展示成本比较。统计与参考价格都不能替代实际账单，也不保证推荐最优。

CLI 调用使用自有账户。木牛强制执行时限与审批，但不能实时限制 CLI 的订阅费或 Token 消耗；费用与 Token 额度用于事后核对。经营 CLI 在隔离任务目录处理明确资料，关闭工具和个性化扩展；研发 CLI 沿用受控仓库与检查关卡。旧版 CLI 不接受必需参数时停止，不降低隔离要求。CLI 账户的默认模型可能由厂商调整，历史记录代表该 CLI 配置下的任务表现，不等同于固定模型评测；改变账户或默认模型后应重新确认 CLI 配置，使历史统计重新开始。

外部执行结束后，任务显示“费用或用量需要核对”。工作区所有者在“核对 CLI 用量”填写实际费用、tokens 以及账单或订阅分摊依据，再确认用量。零费用只适用于有明确依据的零增量费用。未确认进程结果、仍有未决工具或超出额度时不能进入成果验收；账单一经固定不能覆盖。结果未知的经营 CLI 当前保持待核对，不提供强制成功或自动重试入口。

CLI 也可生成自动推荐计划：

```bash
mn goal plan <目标ID> --workspace <工作区ID> --version <目标版本> --runner auto --strategy quality
```

指定外部执行者时把 `auto` 改为 `codex-cli` 或 `claude-cli`，无需 `--model`。可选 `--value` 和 `--time-cost` 分别表示完成价值和每小时时间成本，均为预算币种最小单位。记录用量使用 `mn goal usage <目标ID> --workspace <工作区ID> --version <目标版本> --file usage.json`，文件包含 `{"usage":{"tokens":1000,"costMinorUnits":"20","currency":"CNY"},"source":"账单条目或分摊依据"}`；例中数字仅展示格式。

## 选择会话与模型

使用当前工作区 ID 查询已有会话和模型连接；不要把执行 ID 当作 Thread ID。

```bash
WORKSPACE_ID='替换为当前工作区 ID'
curl --fail --silent --show-error "http://127.0.0.1:7318/v2/workspaces/$WORKSPACE_ID/threads"
curl --fail --silent --show-error http://127.0.0.1:7318/v2/model-connections
node apps/cli/dist/index.js goal list --workspace "$WORKSPACE_ID" --json
```

只选择当前工作区内有权操作的 OPC/Coding Thread，以及状态为 `ready` 的模型连接。预算币种须与选定模型的计量币种一致。模型密钥通过现有连接配置提供，不写入目标文件。

## 创建目标

将以下结构保存为 `goal.json`，替换 Thread ID，并按实际任务修改目标、验收条款和额度。金额使用币种最小单位的整数字符串；`maxDurationMs` 使用毫秒。下列额度仅展示字段格式。

```json
{
  "threadId": "替换为已有 Thread ID",
  "objective": "根据当前机会资料整理支持证据、反证和待核实事项",
  "resourceRefs": [],
  "budget": {
    "maxTokens": 10000,
    "maxCostMinorUnits": "1000",
    "currency": "CNY",
    "maxDurationMs": 300000
  },
  "deliverables": [
    {
      "key": "analysis",
      "title": "机会分析",
      "required": true,
      "criteria": [
        { "id": "evidence", "description": "区分支持证据、反证和待核实事项" }
      ]
    }
  ]
}
```

`resourceRefs` 可留空，由 Host 补入 Thread 已绑定的机会、访谈、信号附件或 Coding 仓库版本。额外资料使用上传接口返回的 `sourceRef`；业务对象使用上下文接口返回的版本引用。引用须包含 Host 返回的 `namespace`、`resourceId`、`streamVersion` 和摘要，不接受任意外部 URL。桌面添加的文件及经营汇总同样使用受保护 Asset 引用；模型实际读取哪些内容，见[资料指南](./materials.md)。

`deliverables[].key` 和 `criteria[].id` 用于绑定后续成果与验收，名称应在本目标中保持明确、唯一。OPC 和 Coding 当前均只支持一个完整交付项；需要检查的多个方面分别写为该交付项的验收条款。

```bash
node apps/cli/dist/index.js goal create --workspace "$WORKSPACE_ID" --file goal.json --json
```

成功后保存 `data.goal.id`，并读取当前详情。详情中的 `goal.streamVersion` 是下一次变更需要的版本；`plan` 和 `deliverySet` 尚未生成时为 `null`。

```bash
GOAL_ID='替换为 data.goal.id'
node apps/cli/dist/index.js goal show "$GOAL_ID" --workspace "$WORKSPACE_ID" --json
```

## 审阅并启动计划

用当前 Goal 版本和所选模型连接生成计划：

```bash
node apps/cli/dist/index.js goal plan "$GOAL_ID" \
  --workspace "$WORKSPACE_ID" --version 1 --model '替换为模型连接 ID' --json
```

审阅返回的 `data.plan`：Thread、插件和 Agent、模型及连接版本、工具范围、数据范围、预算和交付条款。计划是固定版本；启动时同时提交 `plan.id` 和 `plan.digest`，防止执行未审阅的计划。

```bash
node apps/cli/dist/index.js goal start "$GOAL_ID" \
  --workspace "$WORKSPACE_ID" --version '替换为当前 goal.streamVersion' \
  --plan '替换为 plan.id' --plan-digest '替换为 plan.digest' --json
```

单 Agent 启动与执行绑定、Job 在同一事务中保存。团队启动先保存持久调度意图，后续节点分别在 Kernel 事务内提交尝试、执行、Job、预算预留和事件。同一请求不会重复派发。CLI 为变更请求设置幂等键，但命令重新执行可能生成新的键；收到版本冲突时先重新读取并审阅，不能把换版本当作未知外部操作的重试办法。

## 查看进度与取消

`show` 读取当前事实；`refresh` 同步原执行的状态与成果，不重新执行任务。已有目标的操作都要指定 `--workspace`，变更还要指定最新 `--version`。

```bash
node apps/cli/dist/index.js goal refresh "$GOAL_ID" \
  --workspace "$WORKSPACE_ID" --version '替换为当前 goal.streamVersion' --json
node apps/cli/dist/index.js goal cancel "$GOAL_ID" \
  --workspace "$WORKSPACE_ID" --version '替换为最新 goal.streamVersion' --json
```

| 状态 | 含义 |
| --- | --- |
| `draft` | 目标已保存，尚无待执行计划 |
| `awaiting_authorization` | 计划已保存，等待用户审阅并启动 |
| `running` | 单次执行或团队步骤进行中 |
| `waiting_approval` | 等待工具审批，或团队等待人工事实确认 |
| `pausing` | 团队已停止后续派发，等待已派发步骤结束 |
| `paused` | 团队已暂停，恢复仍受原预算、期限及当前授权约束 |
| `needs_reconciliation` | 结果或用量需要核对，不应重新派发 |
| `failed` | 原执行或检查失败，详情提供原因 |
| `awaiting_acceptance` | 候选成果已形成，等待逐项人工复核 |
| `accepted` | 程序检查和用户逐项接收均已完成 |
| `cancelled` | 原执行已终结且用量已核实，已发生用量继续保留 |

取消不会撤回已经发生的外部动作，也不会把未知用量清零。请求取消后仍有未知结果时，目标显示 `needs_reconciliation` 并保留取消意图；按原执行的核对流程处理，刷新目标只同步原执行。创建新目标不能证明旧动作未发生。

## 逐项验收

目标进入 `awaiting_acceptance` 后，读取最新详情，检查 `deliverySet.items` 中的成果、摘要、来源及程序检查结果，再到原 OPC 会话或 Coding 任务核对实际答复、变更和依据。仅有 JSON 中的成果引用不足以完成内容复核。OPC 程序检查只证明答复及来源、计量符合要求；团队复核记录不能替代用户的内容判断。接收材料不等于确认商业机会成立。Coding 继续要求原有 Gate 和 Evidence 有效。

将本次接收决定保存为 `acceptance.json`。`deliverySetId`、`criteriaVersion`、`key`、`digest` 全部来自当前响应；`reviewedCriterionIds` 只填写已实际复核的条款 ID。每个必需交付项都需覆盖其全部条款。

```json
{
  "deliverySetId": "替换为当前 deliverySet.id",
  "criteriaVersion": "替换为当前 goal.criteriaVersion",
  "items": [
    {
      "key": "analysis",
      "digest": "替换为该成果的当前摘要",
      "reviewedCriterionIds": ["evidence"]
    }
  ]
}
```

```bash
node apps/cli/dist/index.js goal accept "$GOAL_ID" \
  --workspace "$WORKSPACE_ID" --version '替换为当前 goal.streamVersion' \
  --file acceptance.json --json
```

Host 只接收与当前成果和条款版本一致的决定。不要在文件中添加 `checks` 或伪造检查依据；成果、输入或权限变化后，旧接收请求不能证明当前成果可验收。完整接口见 [API 路由](../reference/api-routes.md)和 [CLI 参考](../reference/cli.md)，实施范围见 [ADR 0013](../adr/0013-goal-delivery-orchestration.md)。
