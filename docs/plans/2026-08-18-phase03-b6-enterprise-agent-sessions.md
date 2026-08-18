# Phase03 B6 企业 Agent 会话实现计划

> **执行要求：** 使用 `dev-executing-plans` 逐任务执行此计划；计划执行不绑定任何外部 Agent CLI。

**目标：** 让 enterprise profile 通过租户隔离的 PostgreSQL 事实源、跨进程事件通知和 S3 兼容附件对象后端安全暴露与本地相同的版本化 Agent REST/SSE 协议。

**架构：** PostgreSQL 保存不可变 session header、append-only protected event、幂等 mutation receipt 和可重建 projection；事件 payload 不保存 raw prompt、凭据或工具参数。内嵌 Agent 直接调用受治理的模型 Provider API，不启动或依赖 Claude Code/Codex CLI。每次 mutation 通过 PostgreSQL advisory writer lease 串行化同一 tenant/session，事件提交与 `pg_notify` 同事务发生；SSE 先按 cursor 回放数据库事实，再通过独立 LISTEN 连接接收提示并回查数据库。附件对象先 create-only 写 S3，再以 digest/size/object-key descriptor 进入 PostgreSQL；任何不确定写入不自动重放。

**技术栈：** Node.js 22.19、TypeScript 5.7、Fastify 5、PostgreSQL/pg、S3CompatibleArtifactStore、REST/SSE。

---

### 任务 1：租户作用域服务契约与路由门禁

**文件：**
- 修改：`apps/api/src/agentSessionRoutes.ts`
- 修改：`apps/api/src/agentSessionService.ts`
- 修改：`apps/api/src/enterpriseSurface.ts`
- 测试：`apps/api/test/enterpriseAgentSession.test.ts`

1. 编写失败测试：enterprise allowlist 接受固定 Agent 端点；每个请求必须从已认证 `RequestContext` 得到 tenantId/actorId，worker principal、跨 tenant sessionId、缺失 context 均在调用存储前拒绝。
2. 运行 `npm run test -w @mn/api -- --test-name-pattern='enterprise Agent route scope'`，确认 RED。
3. 引入只含版本化方法的 `AgentSessionServiceV1` 与 `AgentSessionRequestScopeV1`：

   ```ts
   interface AgentSessionRequestScopeV1 {
     readonly tenantId: string;
     readonly actorId: string;
   }

   interface AgentSessionServiceV1 {
     create(scope: AgentSessionRequestScopeV1, request: AgentSessionCreateRequestV1): Promise<AgentServiceResponse>;
     get(scope: AgentSessionRequestScopeV1, sessionId: string): Promise<AgentSessionViewV1>;
     // message/events/cancel/close/approve 使用同一 scope。
   }
   ```

4. 本地 service 由 route adapter 注入固定 local scope；enterprise 必须显式解析认证 scope。错误只返回 V1 code，不回显 tenant/session 原值。
5. 运行 focused test，确认 GREEN；提交本任务。

### 任务 2：PostgreSQL append-only 会话事实源

**文件：**
- 创建：`apps/api/src/enterpriseAgentSessionStore.ts`
- 修改：`apps/api/src/enterprisePostgres.ts`
- 测试：`apps/api/test/enterpriseAgentSessionPostgres.test.ts`

1. 编写失败测试：migration 创建 `mn_agent_sessions`、`mn_agent_session_events`、`mn_agent_mutations`、`mn_agent_projection`，并对 header/event/mutation 的 UPDATE/DELETE 安装拒绝 trigger。
2. 编写失败测试：create 原子写 header+session/created；append 只接受 expected seq/previous digest；重复 eventId/seq、坏 digest、跨 tenant 读取、未知 session 全部 fail closed。
3. 运行 PostgreSQL focused integration test，确认缺表/API 的 RED。
4. 实现 exact JSON runtime validation；数据库读回必须重新执行 `isAgentSessionEventV1` 和完整 chain 校验，不直接 cast JSONB。
5. 在同一事务中执行 insert event、projection upsert 和 `SELECT pg_notify('mn_agent_session_events', '<bounded opaque key>')`；通知不得包含 payload、tenantId、sessionId 或凭据。
6. 运行 focused test，确认 GREEN；提交本任务。

### 任务 3：跨进程单 writer lease 与不可重放恢复

**文件：**
- 修改：`apps/api/src/enterpriseAgentSessionStore.ts`
- 修改：`packages/agent-kernel/src/agent-registry.ts`
- 测试：`apps/api/test/enterpriseAgentSessionPostgres.test.ts`
- 测试：`packages/agent-kernel/test/kernel.test.ts`

1. 编写失败测试：两个 runtime 对同一 tenant/session 并发 mutation 时只允许一个进入 model/tool side effect；不同 session 可并发。
2. 编写失败测试：持 lease 进程断开后另一进程可接管；started model/tool effect 无 terminal 时仅追加 unknown/interrupted，不 dispatch。
3. 为 session 增加整个 kernel run 的 store-backed exclusive seam；PostgreSQL 实现用 dedicated client + `pg_try_advisory_lock`，在 finally 中解锁并 release，所有 append 仍验证链尾。
4. lease 丢失、连接关闭或 append 冲突使当前 session poisoned；不得继续关闭 step/turn 为成功。
5. 运行 focused tests，确认 GREEN；提交本任务。

### 任务 4：企业幂等 mutation journal 与审批协调

**文件：**
- 创建：`apps/api/src/enterpriseAgentSessionService.ts`
- 修改：`apps/api/src/agentApprovalCoordinator.ts`
- 测试：`apps/api/test/enterpriseAgentSessionPostgres.test.ts`

1. 编写失败测试：`clientRequestId` 在 tenant 内绑定 exact scope+semanticDigest；同输入返回相同 bounded receipt，不同输入/端点 409，跨 tenant 可独立使用。
2. 编写失败测试：accepted 已持久但 terminal 缺失时重启返回 interrupted，不能重放 effect；completed receipt 篡改即启动失败。
3. 实现 accepted→effect→completed 状态机，completed 与最终 event/projection 在同一事务提交；receipt 只保存 sessionId、state、cursor 和 model binding。
4. 审批 requested/resolved、cancel/close 和 waiter 的唤醒只依据 durable facts；重启不恢复 session-scope grant。
5. 运行 focused test，确认 GREEN；提交本任务。

### 任务 5：跨进程 SSE cursor 与背压

**文件：**
- 创建：`apps/api/src/enterpriseAgentEventHub.ts`
- 修改：`apps/api/src/agentSessionRoutes.ts`
- 测试：`apps/api/test/enterpriseAgentSessionPostgres.test.ts`

1. 编写失败测试：实例 A mutation 后实例 B 的同连接 SSE 收到一次事件；断线以 `after` 回放不丢不重；通知乱序/重复只触发 cursor 回查。
2. 编写失败测试：客户端背压暂停数据库读取；早断、server close、LISTEN 断线都清理 listener/client，app.close 有界完成。
3. 实现专用 LISTEN client；notification payload 仅为随机 channel wake token，收到后按 `(tenant_id,session_id,seq > cursor)` 查询。
4. LISTEN 丢失时进入有界 polling 回退；不得把 payload 放进 NOTIFY，也不得跳过 tenant predicate。
5. 运行 focused test，确认 GREEN；提交本任务。

### 任务 6：S3 兼容附件对象后端

**文件：**
- 创建：`apps/api/src/enterpriseAgentObjectStore.ts`
- 修改：`packages/agent-protocol/src/session-payload.ts`
- 测试：`apps/api/test/enterpriseAgentObjectStore.test.ts`

1. 编写失败测试：对象 key 由 tenant/session/content digest 的 HMAC 派生且不含原文件名、手机号、身份证或凭据；create-only 写入，descriptor 绑定 sha256/byteLength/contentType。
2. 编写失败测试：S3 超时、条件冲突、digest/length mismatch、对象缺失、跨 tenant descriptor 全部 fail closed；未知结果不自动 PUT 第二次。
3. 增加 bounded `attachment/stored` protected event，仅包含安全 descriptor；raw bytes 永不进 event/receipt/log。
4. 实现 put→head/get verify→PostgreSQL descriptor event；孤儿对象只记录清理候选，不在请求路径破坏性删除。
5. 运行 protocol/API focused test，确认 GREEN；提交本任务。

### 任务 7：enterprise server 装配与真实协议验收

**文件：**
- 修改：`apps/api/src/server.ts`
- 修改：`apps/api/src/enterpriseSurface.ts`
- 测试：`apps/api/test/enterpriseAgentSessionPostgres.test.ts`

1. 编写失败测试：enterprise profile 注册 Agent routes，使用 PostgreSQL/S3 backend；不再创建 JSONL/SQLite agent-service 文件。
2. 编写失败测试：两个 server 实例完成 create→message→SSE→approval→cancel/close；DeepSeek/OpenAI Chat/OpenAI Responses/Anthropic fake upstream 均使用 durable model binding。
3. server 只在 PostgreSQL migrate+read/write、S3 probe、listener 建立后暴露 ready；任一依赖失败 `/healthz` 503 且 mutation effect=0。
4. dispose 顺序为停止新请求→关闭 SSE→取消/排空 active runs→释放 writer/listener→关闭 PostgreSQL/S3 资源。
5. 运行 focused integration test，确认 GREEN；提交本任务。

### 任务 8：Phase03 出口门禁与独立审查

1. 运行 Node 22.19：protocol/session/llm/tools/kernel/host/API/provider/store/local-proxy tests 和 coverage，新增逻辑 lines/branches/functions 均不低于 70%。
2. 运行 `npm run typecheck`、`npm test`、`npm run verify:enterprise-fixture`、OSS baseline/policy、第三方许可证、production audit、secret scan、`git diff --check`。
3. stage 全部 B6 文件，确认 0 unstaged，记录 cached diff hash。
4. 请求独立 reviewer 复验 tenant isolation、writer lease、幂等、SSE、S3、恢复不重放；只修可复现问题并重新冻结。
5. APPROVED 后提交并推送到 GitHub `main`；不创建 `v0.1.0` 标签。
