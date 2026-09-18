# 本地业务比较适配器

`scripts/industry-delivery-local-adapters.mjs` 实现两条 HTTP 业务路径，接入已有比较执行器的 `/v1/benchmark/run` 协议。服务不会自行部署 Sales 或 OS，不加载 DSH/ADP，也不提供默认模型凭据。

**当前状态：适配代码已实现，真实服务接线待验证。** 本次按用户要求只做单进程协议测试，没有启动 PGlite、SQLite、Docker、Chromium 或外部模型。测试使用内存响应替身，不能算真实业务执行、模型质量或竞品表现。

| 标识 | 实际路径 | 结果用途 |
| --- | --- | --- |
| `muniu` | Sales 导入 → OS 固定候选任务 → Sales 人类读取与采纳 → 人工复核 → Sales 报价和业务核准 → OS `approve_once` → Worker 出包 → 下载文件并核对摘要 | 完成真实部署验证后，可评估已支持的单版本场景；模拟端口仍为 fixture |
| `fixed_workflow` | Sales 导入 → 受信模型适配器固定抽取 → 相同人工复核、Sales 核准及 OS 受控出包路径 | **固定抽取编排＋木牛受控执行的内部消融**；完整固定工作流替代方案仍未实现 |

第二组依赖木牛执行治理，因此即使业务操作成功，响应仍是 `status:not_run`、`reasonCode:INTERNAL_ABLATION_ONLY`、`ablationStatus:completed`。真实业务结果和文件证据照常保存，但不计入现有汇总器的独立 `fixed_workflow` 通过数。不得据此声称木牛优于独立固定工作流。

## 支持范围

目前仅执行以下五步顺序的单版本样本：

1. `import`
2. `extract_and_review`
3. `create_current_draft`
4. `human_approve_current_version`
5. `export_demo_pdf`

缺项澄清、多版本替换和旧批准故障尚未接入；这些步骤在任何业务写入前返回 `SCENARIO_NOT_IMPLEMENTED`。就现有语料而言，接口可处理正常样本的步骤形状，不能写成 60 项已覆盖。复核者发现缺项时保留 `HUMAN_CLARIFICATION_REQUIRED`，不会继续报价。

适配器先读取 Sales `/api/v1/bootstrap`，要求服务返回当前租户 `demo:true`，才允许创建询价。原始文档按真实资料接口上传；摘要不符即停止。目录 CSV、需求确认、报价和两步批准均调用实际服务接口，没有向数据库直接写入“成功”状态的路径。正式 PDF 从下载接口取得，核对 OS 回执、Sales 包记录及下载字节的 SHA-256；内部证据另核对内容版本、报价摘要、需求 CSV 和来源列表。

价格和需求评估来自实际保存后的业务数据。报价方案必须由独立人工复核端口给出，模型没有目录写入、业务核准或 OS 执行批准权限。适配器不外发报价、不自动核对未知副作用、不更换操作号重试。人工决策缺失时返回 `not_run`，已经开始的业务记录保留以供核对。

## 部署入口

先准备已配置互信身份映射、资料端口、候选 Worker、动作 Worker、对象存储和 PDF 渲染器的独立演示环境。启动本脚本不代表这些依赖已经通过验收。

环境变量由秘密管理工具注入，不写入冻结配置：

| 环境变量 | 用途 |
| --- | --- |
| `MN_LOCAL_SALES_URL` | Sales 根地址，不含 `/api/v1`、凭据或查询串 |
| `MN_LOCAL_OS_URL` | OS Host 根地址 |
| `MN_LOCAL_SALES_SESSION` | 当前有权经理的 Sales 会话，仅作为 Cookie 发送给 Sales |
| `MN_LOCAL_SALES_ORIGIN` | Sales 配置的页面来源，默认 `http://localhost:3000` |
| `MN_LOCAL_OS_TOKEN` | 独立 OS 人类身份 Bearer 凭据，仅发送给 OS |
| `MN_LOCAL_WORKSPACE_ID`、`MN_LOCAL_CUSTOMER_ID` | 已获准演示工作区及客户；服务仍检查当前权限 |
| `MN_BENCH_MODEL_TOKEN` | 明确获准的模型凭据；固定抽取端口使用，木牛模式由其已保存 BYOK 连接实际调用 |
| `MN_BENCH_MUNIU_TOKEN` 或 `MN_BENCH_FIXED_WORKFLOW_TOKEN` | 比较执行器访问本适配服务的专用 Bearer 凭据 |

仅回环地址允许 HTTP，其余地址须 HTTPS。适配服务监听本机 `127.0.0.1`。协议服务需传入与 runner 相同的冻结配置：

```sh
node scripts/industry-delivery-local-adapters.mjs \
  --adapter muniu \
  --config /private/frozen-config.json \
  --module /private/reviewed-local-benchmark-ports.mjs \
  --evidence /private/benchmark-business-evidence \
  --port 3199
```

另一组把 `--adapter` 改为 `fixed_workflow`，使用独立端口和证据目录。相应 runner endpoint 为 `http://127.0.0.1:3199/v1/benchmark/run`。`--fixture` 必须与端口声明的 `executionMode:fixture` 一致；真实模式拒绝测试端口。缺少凭据、端口或冻结配置不调用模型，也不进行业务写入。

## 受信模型与人类端口

模块须导出 `createLocalBenchmarkPorts({environment})`。它是经审阅的本地代码，具有进程权限，不是沙箱。此提交实现了 Sales/OS 业务调用，不附带会自动付费调用模型或自动代替真人批准的默认模块。

| 端口 | 输入与职责 | 返回要求 |
| --- | --- | --- |
| `executionMode` | 声明本部署模式 | `live` 或 `fixture` |
| `checkModelReady({configuration,adapter})` | 调用前核对实际模型、提示词和 Worker 配置；不得通过一次生成来“测试连接” | 明确布尔值；未就绪返回 `false` |
| `modelPort.extract({runId,configuration,input,modelToken})` | 仅固定抽取组使用。按冻结模型和提示词提取资料，不调用业务工具 | `{candidate,modelInvocation}` |
| `readModelEvidence({candidateState,configuration})` | 仅木牛组使用。读取该 execution 的实际受保护模型调用记录与连接版本 | `modelInvocation`；不能只回显请求配置 |
| `humanReviewPort.reviewExtraction(...)` | 获取来源映射、原文、候选及其摘要；由获准复核者确认字段和报价输入 | 以下复核结构 |
| `humanReviewPort.approveQuote({runId,quote,configuration})` | 展示已保存的精确报价内容；取得独立业务核准 | 绑定 `quote.digest` 的决策 |
| `humanReviewPort.approveAction({runId,action,configuration})` | 展示精确 OS 动作、模板及日期；取得本次执行批准 | 绑定 `action.actionDigest` 的决策 |

`modelInvocation` 必须包含 `status:executed`（fixture 为 `fixture`）、实际模型配置的 `configurationSha256`、实际 system 提示词的 `promptSha256`。真实模式另需 `providerRequestId`。可取得的实际费用用 `{currency,minorUnits,source}` 表达；未知费用省略，不能填零。模型配置和提示词任一不符都停止后续业务。

木牛候选流程目前使用固定 system 提示词。固定抽取组须使用相同文本，且共同冻结配置的提示词摘要必须与真实调用记录一致；不能换一套提示词后仍宣称框架同条件比较。

三处人类决策都必须包含 `{approved:true,subjectDigest,actorId,kind:'human'}`。测试端口使用 `kind:'test_fixture'`，不会成为实测人类审批证据。复核结构额外包含：

- `requirements`：`{field,value,status:'supported',sources:[{documentId,version,line}]}` 数组；首版每项限一个可核对出处。
- `unresolvedIssues`：未解决事项数组；非空则暂停本场景。
- `quote.catalog`：`{name,unitPriceCents}`。适配器生成隔离的 DEMO 目录编号，使用真实经理 CSV 核准入口。
- `quote.quantity/discountBps/taxBasis/company/validUntil/deliveryTerms/paymentTerms/issueDate`：复核者给出的精确报价条件，继续接受 Sales 当前规则校验。
- `quote.priceSources`：价格与计算条款的来源文档、版本和行号，必须属于本次已导入文档。

来源目录、有效期与服务时钟必须相容。适配器不改系统时间，不跳过服务的报价有效期或出具日期校验。

测试环境可以提供 `driveWorkers()` 以驱动真实 Worker 单次轮询，只在 fixture 模式调用。真实运行要求独立 Worker 进程已经启动。测试模块必须实际把候选 Worker 配成 `modelMode:test_fixture` 并注入无网络模型；给本适配器加 `--fixture` 不会自动改动远端 Worker 的模型配置。

## 证据与待验项

每个 `runId` 创建独立私有目录，重复调用或服务重启后相同目录已存在即拒绝重新写入。记录 HTTP 方法、路径、状态与正文摘要；不记录认证头。保存实际下载的 PDF、内部证据和结果，文件权限为 `0600`，目录为 `0700`。已知本轮凭据出现在待保存内容时拒绝落盘。

这版核对 PDF 标识、文件字节摘要和业务 `demo` 标记，没有重新解析 PDF 页面或视觉验收；不能据此新增“演示水印在所有页面可见”的结论。独立事件审查、费用账单、人工耗时和完整维护成本也需另行记录。

轻量检查如下，使用内存 HTTP 响应替身，不启动真实服务：

```sh
node --test scripts/industry-delivery-local-adapters.test.mjs
```

后续单独安排：真实 Sales + OS + fixture 模型的正常场景接线、真实 PDF 和内部包核验；获准模型的单版本样本；缺项与多版本场景；独立固定工作流替代方案；DSH/ADP 同条件适配与实测。未经这些验证，不把此提交写成完整 P6 已完成。
