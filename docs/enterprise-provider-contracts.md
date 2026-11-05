# 提供方契约套件

本页供内置提供方与 Sales 连接器开发者使用。E5.1 交付同一套五端口断言及可移植导出工具；E5.2 必须将套件接到 Sales 的真实实现。套件自测、结构校验和文件摘要校验分别验证测试工具、数据格式和文件完整性，不能代替两种提供方的业务验收。范围依据为[完整计划第 8、9 节](proposals/enterprise-operating-platform-2026-11-02.md)及 [ADR 0015](adr/0015-enterprise-operating-platform.md)。

## 契约来源与导出

对象结构以 `packages/contracts/src/enterprise-schema.ts` 为准。五端口签名以 `packages/plugin-sdk/src/business-provider.ts` 为准。导出器读取这两处来源，使用仓库已锁定的 esbuild 生成独立文件，不手工维护另一份 schema。

准备请求 `EnterpriseProviderActionPreparation` 固定业务输入、目标原始版本、操作标识、提供方绑定版本及有效期。此时尚未生成执行授权和预算预留，因此不接受 `authorityRevisionId`、`reservationId`、`executionApprovalRef` 或执行状态。正式 `ActionIntent` 仍由持久执行体系生成；`executeAction` 必须核验真实动作、当前授权及原 Job 的有效租约。

在已安装锁定依赖的木牛工作树根目录执行。正式冻结包要求工作树干净，并使用尚不存在的输出目录：

```bash
node scripts/export-provider-contracts.mjs --out /tmp/muniu-provider-contracts
node scripts/export-provider-contracts.mjs --check /tmp/muniu-provider-contracts
```

开发中可加 `--allow-dirty`，清单会保留 `workingTreeDirty: true`。该包只用于核对；正式交付须提交来源后重新导出。输出目录已存在时命令拒绝覆盖。导出结果只包含下列文件，不读取凭据、配置、对象存储或数据库。

| 文件 | 来源和用途 |
| --- | --- |
| `enterprise-schema.json` | 权威企业 schema 和五端口名称，包含引用依赖 |
| `enterprise-types.d.ts` | 从同一 schema 生成的 TypeScript 声明 |
| `provider-types.d.ts` | 公共 SDK 的类型声明，仅将 contracts 导入改为本包声明 |
| `provider-contract-suite.mjs` | 只依赖 Node 标准库的共用断言 |
| `validate.mjs` | 从权威 `parseEnterpriseContract` 实现打包的结构解析器 |
| `verify.mjs` | 仅依赖 Node 标准库的独立校验器，检查固定文件清单、路径、字节数和摘要，包含自身 |
| `package.json` | 私有测试包说明及导出入口，不发布 npm 包 |
| `manifest.json` | 基准提交、未提交状态、实际来源文件与输出文件的 SHA-256 摘要 |

导出时检查源码读取前后一致，并记录 Node 与 esbuild 版本。正式交付包含完整冻结目录，以及保存在该目录之外的交付记录。记录须包含导出结果中的 `source` 提交号和 `manifestSha256`，并确认 `workingTreeDirty` 为 `false`。不要只交付单个套件文件，也不要向冻结目录添加记录或配置文件。

Sales 接收方使用 Node.js 22.19.x，复制完整目录后即可独立验证。假定接收目录为 `/tmp/muniu-provider-contracts`：

```bash
node /tmp/muniu-provider-contracts/verify.mjs
```

校验成功时命令退出码为 0，输出 `status: "integrity-verified"`、`source`、`workingTreeDirty` 和 `manifestSha256`。接收方须将提交号和清单摘要与交付记录逐项核对，正式包的未提交状态必须为 `false`。缺失或额外文件、符号链接、目录外路径、字节数或摘要不符都会返回非零。校验器只读取包内固定文件，并以流式方式计算摘要，不读取企业配置或凭据。

摘要可发现文件变化，不能证明发布者身份；来源记录应经可信交付渠道取得。Sales 保持自己的锁文件及 TypeScript 5.9.3，不需要木牛工作区、私有包或 esbuild。开发包即使通过完整性校验，`workingTreeDirty: true` 也不能计为正式冻结交付。

## 接入真实实现

套件导出 `PROVIDER_CONTRACT_CASES`、`runProviderContractCase(caseId, createFixture)` 和 `runProviderContractSuite(createFixture)`。全部场景为必测项；缺少方法、返回 `not_supported`、跳过执行或提前报通过都会失败。每个场景新建一个合成企业夹具，结束或失败时调用 `close()`。整套入口按顺序执行；外层测试也须保持单进程、单并发。

接入文件中的 `createFixture` 由提供方所属仓库实现。内置模式连接真实企业服务、持久动作协调器和 Worker；Sales 模式通过批准的连接器及版本化 HTTP 契约连接真实 Sales 服务。夹具可以用合成数据、隔离状态和故障注入，但不能用固定成功响应替代五端口，也不能直接访问另一个系统的数据库。

消费方在自己的测试文件中导入已冻结的套件和本仓库的夹具工厂，再将 `runProviderContractSuite(createFixture)` 注册为一个异步 Node 测试。需要逐项报告时，按 `PROVIDER_CONTRACT_CASES` 顺序调用 `runProviderContractCase`；两种入口执行同一组断言。成功结果为 `status: 'passed'`，且 `cases` 数量等于固定场景数。构建、类型检查和业务流程验收仍由各仓库负责。

工厂接受 `{ caseId, action }`。`action` 为 `create_followup_task`、`update_followup_date` 或 `issue_quote_package`；每次创建的夹具必须提供下列接口。

| 字段或方法 | 约定 |
| --- | --- |
| `reference` | 合成客户的真实初始引用，保留内部流版本或外部原始版本及摘要 |
| `fieldReference` | 带公共字段与受限价格字段的真实报价引用 |
| `fieldExpectations` | `{ publicFields, restrictedFields }`，两组字段都必须非空且实际存在于完整读取结果 |
| `context(role)` | 返回已验证主体的上下文；角色为 `writer`、`restricted`、`otherTenant`。上下文字符串本身不能授予权限 |
| `providerFor(role)` | 返回按该真实主体绑定的五端口实现，可异步返回 |
| `readContent(ref, context)` | 经过当前权限检查读取受保护内容，返回 `{ reference, values }`；不能绕过内容读取入口 |
| `request(operationKey, action)` | 返回对应准备请求。报价出包目标须已获有效业务批准 |
| `businessState()` | 返回真实业务事实与对象版本的可复制值。须涵盖动作影响的目标、跟进任务和报价出包；排除读取游标、准备记录、权限记录和执行元数据 |
| `mutateTarget()` | 通过真实业务命令改变客户，返回更新后的原始引用 |
| `revoke('writer')` | 持久撤销写入人的实际权限，不能只改变测试上下文 |
| `commit(request, prepared)` | 经真实执行准入、职责分离批准和 Job 领取，返回 `{ intent, context, actionDigest }`，此时尚未调用提供方 |
| `expireLease(committed)` | 使已领取的原租约过期或被新的 fencing token 取代 |
| `armRevocation(boundary)` | 在 `snapshot` 异步存储边界或 `commit` 原生提交边界撤权，返回 `{ triggered(): boolean }`；必须实际到达该边界 |
| `dispatch(request, prepared, { execute })` | 经真实协调器和 Worker 派发动作，以传入函数替换该次提供方执行调用，保留完整结果处理流程 |
| `executionState(operationKey)` | 返回 `{ operationKey, reservationId, status, reservationStatus }`，将真实预留状态规范为 `reserved` 或 `settled` |
| `reconcile(operationKey)` | 由获准核对人经真实核对流程查询原提供方回执并结算 |
| `close()` | 释放本夹具的连接、进程与隔离临时状态，保留其他服务 |

`commit()` 返回的 `intent` 是正式且已承诺的 `ActionIntent`。`context.executionLease` 必须包含真实 `jobId`、`workerId` 和 `fencingToken`，不能另造字符串满足检查。`actionDigest` 来自持久动作记录。需要传入 `principalSessionEpoch` 时，必须来自可信会话或被封存的原责任主体。

故障注入须接在真实存储或传输边界。丢响应场景由套件先执行真实提供方再抛出合成传输错误；随后检查协调器保留原操作标识和预算预留，仅凭原回执核对，不再次调用执行端口。测试中的错误拒绝必须携带业务错误码；普通编程异常不能计为授权拒绝。

## 断言范围

| 场景 | 必须观察到的结果 |
| --- | --- |
| 原始快照版本 | 历史引用保持原版本；摘要不匹配及不存在的版本被拒绝 |
| 字段和租户隔离 | 受限读取保留公共字段、移除价格字段；跨主体内容引用及跨租户读取被拒绝 |
| 增量游标 | 相同游标返回相同来源事件标识；重复读取不改变业务；游标不能跨主体或继续使用已撤销权限 |
| 准备与版本冲突 | 同键同输入结果一致，同键改输入失败；准备不产生业务事实，过期目标版本被拒绝 |
| 三类动作 | 真实承诺后产生业务变化；重复执行及重复读取回执保留同一结果且不重复副作用 |
| 伪造执行与陈旧租约 | 缺少真实租约、动作标识不匹配或原 fencing token 失效时均不能写业务 |
| 未知回执与丢响应 | 未知操作保持未知；已提交但丢响应的操作保留预算，以原回执核对后结算 |
| 撤权 | 内容读取、执行、快照异步边界和原生提交边界均检查当前权限 |
| 同一原版本竞争 | 两个动作按同一原版本准备，第一份承诺后由真实业务命令改变目标；第一份执行及第二份承诺均被拒绝，保留外部改版结果 |

`getReceipt` 对没有可信历史的操作应抛出 `PROVIDER_RECEIPT_UNAVAILABLE`，或返回严格的 `pending` / `unknown` 回执。缺失记录不能证明未执行。生产 Host 当前不注入 `hasContinuousHistory`；当原回执不存在时，默认始终保持未知。已保存的回执仍按当前权限正常读取和核对。

生成 `not_executed` 必须同时满足：真实原生 `ActionIntent` 与已到期的准备记录存在；动作、准备请求和查询属于同一 `tenantId`、`workspaceId`、`operationKey`；`preparedInputRef` 指向该准备记录；`inputDigest` 与准备结果固定的输入摘要一致；当前主体仍有目标读取权限；可信存储连续性证明有效。仅凭操作标识、到期时间或缺失记录均不满足条件。

`hasContinuousHistory` 的 `true` 只能由受信恢复控制面提供。证明必须覆盖从准备到本次查询期间未丢失任何已提交的业务事实或回执，并确认系统未处于尚未核对的恢复窗口。E7 完成相应恢复验收前，不得在生产启用该证明入口。测试夹具显式返回 `true` 只覆盖合成条件下的分支，不能作为生产恢复证明。

该套件检查协议与安全边界。金额守恒、客户接受、三类动作的具体业务内容、真正并发事务、PostgreSQL 恢复、HTTP 联合身份和双系统完整流程仍需所属工作包的领域与集成测试；一次协议通过不能覆盖这些验收项。

## 工具自测与验收记录

从木牛工作树根目录执行工具自测：

```bash
node --test --test-concurrency=1 scripts/test/provider-contract-suite.test.mjs
```

自测使用测试模型，验证套件能识别故意泄露字段、替换历史版本、修改事件标识、准备阶段写业务、重复副作用、伪造未执行回执、重放未知结果和忽略异步撤权等错误。导出测试将完整包复制到木牛工作区之外，由独立 Node 进程验证清单、路径、符号链接和篡改检测。该命令仅验证工具自身，不能记为内置或 Sales 通过。

提供方验收记录应分别列出提供方源码提交、冻结包来源提交及摘要、夹具实现、实际执行命令和逐项结果。缺少真实接口、依赖或场景时标为未运行；不得用自测模型或合成成功回执补齐记录。
