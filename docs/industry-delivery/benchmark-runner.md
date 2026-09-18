# P6 比较执行器

`scripts/industry-delivery-benchmark.mjs` 为四套独立环境提供统一 HTTP 适配协议：`fixed_workflow`、`muniu`、`deepseek_harness`、`adp`。它不调用猜测的 DSH 或 ADP 私有接口，不安装、登录或购买竞品服务。各环境须自行实现适配服务，并提供可核验的版本、模型调用与业务事件证据。

当前提交验证了执行器协议，未执行真实模型或竞品比较。协议测试使用本地模拟 HTTP 服务，所有结果都标为 `protocol_fixture`，汇总时仍为 `not_run`。不能据此声称性能、准确率、成本优势或安全机制领先。

## 执行边界

- 默认读取开发集 40 项；`--split holdout` 读取留出集 20 项。先校验整个语料包及文档摘要，再选择本轮样本。
- 标准答案仅用于执行器内部断言。发送给适配服务的输入只含样本标识、合成 tenant、文档、步骤与 DEMO 输出规则；递归删除全部以 `expected` 开头的字段，包括 `expectedIssueCount` 和步骤中的 `expected`。不发送分类标签或留出集标识。
- 四组收到同一冻结配置、同一资料和同一步骤。冻结配置包含四组实现清单，允许实现版本不同；共同模型、模型参数、提示词、Sales 契约、业务规则与预算必须一致。
- 每个调用只发送一次。超时、断连或不可解析结果按未确认结果处理，保存证据并阻断该适配器后续样本；不自动重试。
- 任一关键违规会令本轮 `safetyGate=blocked`。其余适配器仍可独立执行，失败环境不得换参数继续本轮测试。
- 无 endpoint、无适配凭据或无模型凭据时记为 `not_run`，不记失败，不填零耗时或零费用。尚未执行的 72 项故障矩阵由现有汇总器继续列为缺失项。

这套执行器只覆盖 60 个合成业务样本。字段比对和响应摘要不能独立证明服务回报的事件真实发生，也不等于完整故障验收、真实客户收益或生产准入。

## 冻结配置

配置文件不得包含任何凭据。结构如下；摘要和版本须从实际部署取得，示例占位值不能用于实测：

```json
{
  "schemaVersion": 1,
  "frozenAt": "2026-09-18T00:00:00.000Z",
  "model": {
    "provider": "实际提供方",
    "name": "实际模型名",
    "revision": "已固定的模型版本",
    "parameters": { "temperature": 0 }
  },
  "prompt": { "text": "四组共用的完整提示词", "sha256": "提示词UTF-8原文的64位摘要" },
  "policySha256": "共用权限、批准、禁止动作和报价规则的64位摘要",
  "salesContractSha256": "共用Sales端口与业务规则版本的64位摘要",
  "budget": { "maxTokens": 50000, "maxCostMinorUnits": "100", "currency": "CNY" },
  "adapters": {
    "fixed_workflow": { "implementationSha256": "64位实现摘要", "version": "固定工作流版本" },
    "muniu": { "implementationSha256": "两仓库及部署清单的64位摘要", "version": "OS与Sales固定提交" },
    "deepseek_harness": { "implementationSha256": "上游加独立适配代码的64位摘要", "version": "ddefc45fbc7f8e46dd73185e68295696d1297887" },
    "adp": { "implementationSha256": "导出配置及外部服务的64位摘要", "version": "实际套餐、平台版本与核验日期" }
  }
}
```

`configurationDigest()` 对 JSON 对象的键排序后计算 SHA-256，数组顺序保留。提示词摘要单独按 UTF-8 原文字节计算。实测传入 `--config-sha256`，必须与配置一致；留出集缺少这个参数会直接拒绝启动。

冻结摘要是复现约束，不是第三方见证。更改配置后生成新摘要不能视作同一轮结果；留出集若参与调试，须登记泄漏并更换独立评估集。四组无法使用相同模型时，另开结果集，不能把差异归因于框架。

## 环境与运行

认证只从环境读取。执行器不会把认证头或环境中的服务地址写入请求证据和汇总；若原始响应包含本轮已知凭据，则拒绝保存该响应。适配服务仍须自行脱敏未向执行器公开的秘密。

| 环境变量 | 用途 |
| --- | --- |
| `MN_BENCH_MODEL_TOKEN` | 本轮具备模型凭据的启动条件；实际端口也须单独配置同一获准模型凭据。执行器不向远端适配服务转发此值。 |
| `MN_BENCH_FIXED_WORKFLOW_URL` / `_TOKEN` | 固定工作流服务完整 HTTP endpoint 与 Bearer 凭据 |
| `MN_BENCH_MUNIU_URL` / `_TOKEN` | 木牛适配服务 |
| `MN_BENCH_DEEPSEEK_HARNESS_URL` / `_TOKEN` | 独立固定提交 DSH 环境的适配服务 |
| `MN_BENCH_ADP_URL` / `_TOKEN` | 获准 ADP 环境及所需外部服务的适配服务 |

URL 须用 HTTPS；仅回环地址允许 HTTP，供本地适配服务和协议测试使用。禁止 URL 内嵌凭据、查询串和重定向。模型和平台密钥由秘密管理系统注入，不放入配置文件或 shell 历史。

```bash
node scripts/industry-delivery-benchmark.mjs \
  --config /absolute/private/frozen-config.json \
  --config-sha256 ACTUAL_FROZEN_CONFIG_SHA256 \
  --split development \
  --output /absolute/private/new-development-run

node scripts/industry-delivery-summary.mjs \
  /absolute/private/new-development-run/results.json --verify-evidence
```

输出目录必须不存在。执行器创建权限为 `0700` 的目录及 `0600` 的证据文件，拒绝覆盖旧结果。准备留出集时把 `--split` 改为 `holdout`，使用同一已冻结配置和新的输出目录。

`--fixture` 仅用于协议联调，即使所有断言通过，也输出 `not_run` 和 `PROTOCOL_FIXTURE_ONLY`，不计入比较通过数。真实模式中，服务若声明 `executionMode=fixture`，同样不能计入实测。

## HTTP shim 协议

每个适配器接收一个 `POST` JSON 请求，认证头为 `Authorization: Bearer …`：

```json
{
  "schemaVersion": 1,
  "adapter": "fixed_workflow",
  "runId": "执行器生成的本次唯一标识",
  "caseId": "DEMO-RFQ-001",
  "configuration": "完整冻结配置对象",
  "configurationSha256": "配置摘要",
  "input": "去掉答案后的合成输入对象",
  "inputSha256": "输入对象摘要"
}
```

响应必须回显 `adapter/runId/caseId/configurationSha256/inputSha256`。任一不一致即阻断。响应不能包含凭据；检测到本轮已知凭据原文、URL 编码或 JSON 转义后，不保存原始响应，只保存原始字节摘要和脱敏失败记录。

完成响应字段如下：

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | 数字 `1` |
| `executionMode` | `live` 或 `fixture` |
| `status` | `completed`、`not_run` 或 `blocked`；后两项须有大写下划线形式的 `reasonCode` |
| `modelInvocation` | `status` 为 `executed` 或 `fixture`；`configurationSha256` 必须等于冻结 `model` 对象摘要；真实执行另需 `providerRequestId` |
| `modelInvocation.actualCost` | 可省略；若提供，含 `currency`、整数最小货币单位字符串 `minorUnits` 和账单/用量依据 `source`，不能用估算或缺失值填 `0` |
| `criticalFailures` | 必填数组，每项至少有大写下划线 `code`；没有已知违规时为空数组 |
| `actual.requirements` | 按统一字段顺序给出 `field/value/status/sources`，来源为 `documentId/version/line` |
| `actual.unresolvedIssues` | 含 `code/field` 的待澄清事项；描述不参与严格文本匹配 |
| `actual.prices` | 共用规则的整数分计算结果及来源；缺项报价为 `null`，税额计算仍在范围外 |
| `actual.effectiveQuoteVersion` | 最终有效版本 |
| `actual.formalDemoExport` | `blocked` 或 `allowed_after_current_version_human_approval` |
| `actual.outputs` | 已提供的成果类型标识 |
| `actual.approvals` | 人工批准证据摘要，含 `kind:human/status:approved/version` |
| `actual.exports` | 导出证据，含 `format:pdf/classification:demo/version/sha256`；禁止导出时为空 |
| `actual.sideEffects` | 实际外部动作记录，至少含 `action/status`；禁止动作执行成功会阻断 |
| `actual.stepResults` | 步骤结果；旧批准导出测试须有对应 `action` 的 `status:denied` |

响应价格和需求字段采用语料的统一结构，由各 shim 负责确定性归一化。标准答案不会交给 shim。执行器核对结构化字段、来源、整数价格、当前版本、人工批准、DEMO 成果以及旧批准拒绝结果。它不把自然语言措辞差异当准确率，也不会替适配器补出缺失证据。

实际费用仅覆盖 `actualCost.source` 所说明的账单范围。没有提供云平台、外部服务、人工作业或维护成本时，这些成本仍未知；不能把单次模型费用当总成本。

## 固定工作流示例服务

同一脚本导出 `createFixedWorkflowShim()`，并提供可执行入口：

```bash
node scripts/industry-delivery-benchmark.mjs --serve-fixed \
  --config /absolute/private/frozen-config.json \
  --module /absolute/private/fixed-workflow-ports.mjs --port 3199
```

服务绑定 `127.0.0.1`，仅处理 `/v1/benchmark/run`。`fixed-workflow-ports.mjs` 为受信任代码，须导出以下工厂；这两个端口是本比较程序的接口，不是任何厂商的私有 API：

```js
export async function createFixedWorkflowPorts({ environment }) {
  return {
    modelPort: {
      async extract({ runId, configuration, documents, modelToken }) {
        // 使用 configuration.model 与 configuration.prompt 发起真实只读提取。
        // 返回 invoked:true、candidate、providerRequestId，以及可取得的 actualCost。
      }
    },
    salesPort: {
      async runDemoScenario({ runId, configuration, input, candidate }) {
        // 使用同一 Sales 业务规则和批准端口执行获准的 DEMO 人工操作步骤。
        // 核验候选、业务版本、当前权限与人工批准；返回 actual、criticalFailures。
      }
    }
  };
}
```

固定流程顺序为只读模型提取、交给共用 Sales 端口执行 DEMO 场景、收集回执。模型不能自行批准、修改价格或外发。端口实现须负责实际费用/预算、模型与服务凭据、人工批准证据、动作记录和清理，不能仅返回预期答案。缺少模型凭据或任一端口时，示例服务返回 `not_run`，不会调用模型或业务端口。

DSH 和 ADP 用各自独立部署实现相同协议。公开文档不能充当本次执行证据；官方固定提交/平台版本与额外治理服务的成本须随配置归档。适配模块属于进程等价的受信代码，此处没有沙箱承诺。

## 证据和校验

每项保存去答案请求、原始响应字节、独立断言结果和 SHA-256。耗时由执行器实测，未知费用省略。报告兼容现有 `industry-delivery-summary.mjs`；汇总仍要求每组 132 项，不能把本程序覆盖的部分样本当完整通过。

```bash
node --test scripts/industry-delivery-benchmark.test.mjs
```

测试只使用临时目录和本地模拟服务，覆盖分组、答案剥离、身份与摘要绑定、关键违规、凭据回显保护、证据摘要、缺失配置以及固定流程的端口顺序与凭据隔离。协议通过仍须分别完成真实模型实测、框架环境核验、原始事件审查、完整故障矩阵和真实客户验收。
