# 委派任务、跟进执行与验收成果

任务把预期结果、资料、执行计划和验收条款绑定到经营或研发会话。统一任务计划目前使用一个内置 Agent 和一个明确选择的模型连接，尚不支持多 Agent 并行、自动模型路由和自动跟进。外部 CLI Agent 可从[研发任务详情](./coding.md)调度，暂不纳入统一任务计划。

开始前，完成[快速开始](../quickstart.md)，启用对应插件，准备就绪的模型连接。桌面端会为新任务创建会话，CLI 可以关联已有 Thread。Coding 还需满足原任务的 Spec、Governance、Harness 和沙箱准入。创建目标和保存计划不会开始 Agent 执行；确认计划后启动才可能产生模型费用和工具调用。

本文使用源码 CLI。命令在仓库根目录执行，Host 的连接方式见 [CLI 指南](./cli.md)。已安装 CLI 时可把 `node apps/cli/dist/index.js` 替换为 `mn`。

## 在桌面端操作

点击「委派任务」，或按 Command / Ctrl + J，选择经营或研发。填写任务目标和逐行验收要求，也可以从经营复盘、客户与服务、实现功能、排查问题等模板开始。研发任务需选择仓库；尚未登记时，可直接选择文件夹并登记。

「添加资料」支持 UTF-8 文本文件（TXT、Markdown、CSV、JSON），也可拖入文件。最多 6 份，每份不超过 48 KB，任务说明和资料合计不超过 16000 字符。点击资料名称可预览，移除按钮可取消附加。图片、PDF 和语音尚未接入这个入口。经营任务可明确附加经营汇总，提交前核对统计期间和资料版本；快照用于分析，不是实时账目读取授权。

经营汇总的名称显示来源版本，点击名称可查看统计期间与金额。文本文件按此次读取的内容保存，不会追踪本机文件后续修改。准备计划后，可在「查看完整任务与资料」核对已保存的内容。

选择已连接的模型，在「补充约束与执行额度」中填写限制。费用币种跟随模型计量规则。点击「准备执行计划」会保存任务和待审阅计划，不会调用模型。核对目标、资料、模型、工具范围与额度后，再点击「确认计划并启动」。网络中断后点击「继续准备」，会沿用本次请求，不重复创建任务。

左侧「任务」提供任务列表、搜索和状态筛选。草稿只保留在本窗口，切换页面不会丢失；退出应用前需准备计划以保存任务。原「捕获」只保存一条机会或研发任务记录，现已由明确的委派入口替代；单独记录机会仍在「机会验证」中完成。

执行中可在同页查看会话、补充说明或调整方向。补充内容不改变已确认的范围、验收要求或额度。需要审批时，进入收件箱或「查看业务对象」；执行结束后不能直接在旧任务下开启额度外执行，新范围需新建任务。

运行中需要改变范围时，先取消旧任务，核对收件箱中的未决审批或待核对结果，再以新范围创建任务。启动或接收成果时断线，先点击错误提示中的「重试」读取任务状态；已进入执行中或已验收时，无须再次提交。状态仍待确认时，核对最新计划再操作，不能靠重复委派判断是否成功。

本地执行依赖桌面应用保持运行。退出应用会关闭本机执行服务；重新打开后，从「任务」列表查看已保存任务和当前状态。出现中断或结果待核对时，按任务及收件箱提示处理，不直接新开重复执行。

成果出现后，先阅读正文或代码差异，逐条勾选已经复核的标准，再点击「接收成果」。成果可下载为 Markdown 文件。来源或权限变化后，旧成果预览会隐藏，需先处理相关变化。经营助手提供方案和分析，不自动改账、发送报价或收付款。

预览因来源或权限变化而隐藏时，从「查看业务对象」核对资料，并在收件箱检查未决事项。无法恢复原有资料与授权版本时，使用当前资料新建任务并重新审阅，不能把旧成果当作当前资料下的验收结果。

「关联已有任务」保留针对现有机会或研发任务创建目标的入口。下文为 CLI 与 API 使用方式。

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

`resourceRefs` 可留空，由 Host 从 Thread 补入绑定机会、访谈及信号附件或 Coding 仓库的当前版本。手动填写时，只能使用该 Thread 已绑定的资源，提供 `namespace`、`resourceId`、`streamVersion` 及可选 `digest`；版本和摘要应来自 Host 当前响应。该字段不接受任意外部资源引用。桌面端添加的文本和经营汇总直接保存在目标说明中，不使用 `resourceRefs`。计划生成后需审阅最终资料清单；未绑定业务对象的 OPC Thread 使用经营助手分析明确提供的目标和资料。

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

启动与执行绑定、Job 在同一事务中保存。同一计划不会因重复请求生成另一个执行。CLI 为变更请求设置幂等键，但命令重新执行可能生成新的键；收到版本冲突时先重新读取并审阅，不能把换版本当作未知外部操作的重试办法。

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
| `running` | 原执行进行中 |
| `waiting_approval` | 执行等待已有审批流程处理 |
| `needs_reconciliation` | 结果或用量需要核对，不应重新派发 |
| `failed` | 原执行或检查失败，详情提供原因 |
| `awaiting_acceptance` | 候选成果已形成，等待逐项人工复核 |
| `accepted` | 程序检查和用户逐项接收均已完成 |
| `cancelled` | 原执行已终结且用量已核实，已发生用量继续保留 |

取消不会撤回已经发生的外部动作，也不会把未知用量清零。请求取消后仍有未知结果时，目标显示 `needs_reconciliation` 并保留取消意图；按原执行的核对流程处理，刷新目标只同步原执行。创建新目标不能证明旧动作未发生。

## 逐项验收

目标进入 `awaiting_acceptance` 后，读取最新详情，检查 `deliverySet.items` 中的成果、摘要、来源及程序检查结果，再到原 OPC 会话或 Coding 任务核对实际答复、变更和依据。仅有 JSON 中的成果引用不足以完成内容复核。OPC 程序检查只证明答复及来源、计量符合要求，内容判断由用户完成；接收材料不等于确认商业机会成立。Coding 继续要求原有 Gate 和 Evidence 有效。

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
