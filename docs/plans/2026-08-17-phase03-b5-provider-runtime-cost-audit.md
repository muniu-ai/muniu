# Phase03 B5 Provider Runtime 与成本审计实现计划

> **执行要求：** 使用 `dev-executing-plans` 逐任务执行此计划；计划执行不绑定任何外部 Agent CLI。

**目标：** 让内嵌 Agent 从本地权威 Provider 配置安全构造真实三协议模型运行时，生成受保护、可恢复、成本状态精确的模型审计事实，并让 local-proxy 复用共同的安全传输核心。

**架构：** B5a 在应用边界严格快照 ProviderRecord；每次执行都重读权威记录，仅按完整 provider configDigest 有界复用不含明文密钥的 `HttpModelAdapter`，密钥仍在每次请求时解析。`LlmRuntime.stream(request, internalContext)` 承载不进入公共 JSON `LlmRequest` 的可信执行上下文；模型 side effect 采用 `model/attempt-started` fsync 后才 fetch、terminal audit 再 fsync 的双事实协议。B5b 抽取 agent-llm/local-proxy 共用的 abort、原生 Response 快照、dispatch 和 usage-state 原语；local-proxy 保留客户端协议转换、企业记账与历史 replay 语义。

**技术栈：** TypeScript 5.7、Node 22.19、Fastify、FileLocalStore、LocalSecretVault、JSONL protected events、Node test runner。

---

### 任务 1：权威 Provider route factory

**文件：**
- 创建：`apps/api/src/agentRuntimeFactory.ts`
- 创建：`apps/api/test/agentRuntimeFactory.test.ts`
- 修改：`apps/api/package.json`

1. 写失败测试：拒绝 Proxy/accessor/cycle/额外键、disabled、非 agent/unified、catalog 不含模型、错误协议/URL/secretRef；错误不包含原值。
2. 运行 pinned Node 22 focused test，确认缺少 factory API 的 RED。
3. 实现 bounded exact snapshot、稳定错误码、immutable route/binding；不读取密钥。
4. 运行 focused test，确认 GREEN。
5. 写失败测试：请求级 secret resolver、abort/late rejection、configDigest route cache 不缓存 secret；disable/update/rotation 在下一次 resolve 生效。
6. 实现 `resolveAdapter(binding)`：每次重读记录、按 bounded configDigest 安全复用 adapter，并在每次 stream 解析 secret。
7. 运行 focused test 与 agent-llm test/coverage。

### 任务 2：显式 mock/production 服务模式和动态 adapter resolver

**文件：**
- 修改：`packages/agent-llm/src/runtime.ts`
- 修改：`packages/agent-host/src/host.ts`
- 修改：`apps/api/src/agentSessionService.ts`
- 修改：`apps/api/src/server.ts`
- 测试：`packages/agent-llm/test/runtime.test.ts`
- 测试：`packages/agent-host/test/host.test.ts`
- 测试：`apps/api/test/agentSessionRoutes.test.ts`

1. 写失败测试：production 不注册 mock；每次 stream 按 durable providerId 异步解析 borrowed adapter；跨 provider 不混用；hostile resolver 结果 fail closed；pre-abort 零解析、mid-resolve abort/late reject 安全。
2. 实现 sealed runtime 的只读 resolver seam；不缓存、不 dispose borrowed adapter，验证 adapter.id 精确匹配请求。
3. 写失败测试：create/restart 始终使用 durable binding，当前默认/ProviderRecord 变化不得重绑 session。
4. 实现 service 明确 `mode: "mock" | "production"`，server 正常路径只装配 production factory，测试显式 mock。
5. 映射 missing/disabled/not-agent/model/secret 失败为不回显原值的 versioned V1 error。
6. 运行 llm/host/API focused 与 coverage。

### 任务 3：模型审计 DTO、protected event 与精确成本

**文件：**
- 创建：`packages/agent-protocol/src/model-audit.ts`
- 修改：`packages/agent-protocol/src/model.ts`
- 修改：`packages/agent-protocol/src/session-payload.ts`
- 修改：`packages/agent-protocol/src/events.ts`
- 修改：`packages/agent-protocol/src/index.ts`
- 修改：`packages/agent-session/src/projection.ts`
- 测试：`packages/agent-protocol/test/model-audit.test.ts`
- 测试：`packages/agent-protocol/test/session-payload.test.ts`
- 测试：`packages/agent-session/test/session.test.ts`

1. 写失败测试：attempt/terminal receipt exact/roundtrip/Proxy-accessor fail closed；usage complete/partial/missing；cost `estimated | partial | unpriced`。
2. 写失败测试：decimal 价格乘 token 后按固定规则精确舍入并绑定 pricingDigest；缺价格/缺 usage/overflow 为 partial/unpriced，绝不记 0。
3. 实现字符串十进制定点算法和 bounded receipt inspector，不使用浮点累计。
4. 写失败测试：`model/audit` payload 保护手机号/身份证/credential，保留普通文本但不得包含 key/raw body/header。
5. 实现 event-specific protected payload、digest/chain validation 和 projection 容忍审计事实。
6. 运行 protocol/session focused 与 coverage。

### 任务 4：Kernel durable audit 顺序

**文件：**
- 修改：`packages/agent-kernel/src/react-driver.ts`
- 修改：`packages/agent-llm/src/model-client.ts`
- 修改：`packages/agent-protocol/src/model.ts`
- 测试：`packages/agent-kernel/test/kernel.test.ts`
- 测试：`packages/agent-llm/test/model-client.test.ts`

1. 写失败测试：attempt-started 绑定 immutable model binding、session/run/candidate/turn/step/attempt/requestDigest/routeDigest；durable append 失败时 fetch 次数为 0。
2. 增加 `LlmRuntime.stream(request, internalContext)` 的内部 execution envelope；严格快照可信 JSON controls 与 sink 方法，不修改公共 `LlmRequest`，不用全局 AsyncLocal。
3. 保证 `model/attempt-started` fsync 后才 dispatch，terminal audit 在步骤结束前 fsync；sink 失败抛专用 outcome-persistence error，Kernel 不写 step/end 或 turn/end。
4. recovery 对无 terminal 的 attempt 追加 unknown/interrupted 且永不 replay；SSE/cursor 可追溯。
5. 覆盖 cancellation、observer late reject、partial/missing usage、单 binding 单 route、dispatch 后 no replay；跨 Provider fallback 留 Phase05 的 versioned strategy。
6. 运行 kernel/llm/session/API focused 与 coverage。

### 任务 5：三协议假 upstream 和 DeepSeek preset

**文件：**
- 修改：`packages/provider-catalog/src/catalog.ts`
- 测试：`packages/provider-catalog/test/catalog.test.ts`
- 测试：`apps/api/test/agentSessionRoutes.test.ts`

1. 写失败测试：DeepSeek official 仅 v4-flash/pro；三协议 HTTP/SSE 通过 production service 完成会话。
2. 实现 factory 到现有 `HttpModelAdapter` 的三协议 route 装配。
3. 覆盖 secret unavailable、HTTP/stream error、usage 三态、隐私和 restart binding。
4. 运行 catalog/store/llm/API focused 与 coverage。

### 任务 6：B5a 冻结、门禁与独立审查

1. 运行 pinned Node 22 protocol/store/catalog/llm/host/kernel/session/API focused tests 和覆盖率。
2. 运行 root typecheck、`npm test`、OSS/license/audit/diff-check。
3. stage 全部 B5a 文件，确认 0 unstaged，记录 cached diff hash。
4. 请求原独立 reviewer；只修 reviewer 可复现问题，重新冻结直至 APPROVED。
5. reviewer APPROVED 后提交 B5a，不推送、不改 Git identity。

### 任务 7：B5b 共享传输原语与 local-proxy 去重

**文件：**
- 创建：`packages/agent-llm/src/http-transport.ts`
- 修改：`packages/agent-llm/src/model-client.ts`
- 修改：`packages/local-proxy/src/proxy.ts`
- 修改：`packages/local-proxy/package.json`
- 测试：`packages/agent-llm/test/http-transport.test.ts`
- 测试：`packages/local-proxy/test/proxy.test.ts`

1. 写失败契约测试：native Request/Response、abort/timeout/late reject、body/read error、usage complete/partial/missing。
2. 抽取无协议转换、无企业策略的单次 dispatch 原语；返回 bounded metadata，不返回或记录 headers/raw body。
3. agent model client 与 local-proxy 同时复用；删除两处重复 fetch/abort/Response snapshot/usage-state 代码。
4. 保留 local-proxy 客户端协议转换、enterprise preauthorization/accounting/replay；Agent 路径仍严格 dispatch 前 fallback。
5. 运行 local-proxy 兼容测试/覆盖率和 B5a 回归。

### 任务 8：B5b 冻结、门禁与独立审查

1. 运行 focused/full/OSS/license/audit/diff 门禁。
2. stage、确认 0 unstaged、记录 hash并请求同一 reviewer。
3. APPROVED 后提交 B5b；不推送，停止在 Phase03。
