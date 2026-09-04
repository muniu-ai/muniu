import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  type Execution,
  type ExecutionAuthority,
  type MemoryRecord,
  type ToolCallIntent,
  verifyEventIntegrity,
} from "@mn/contracts";
import {
  AgentOsKernel,
  InMemoryKernelStore,
  assertAuthorityAttenuation,
  authorityAllowsIntent,
  canReadMemory,
  transitionExecution,
  unknownEffectStatus,
} from "../src/index.js";

const now = "2026-09-04T00:00:00.000Z";

test("内存事件使用与持久化存储相同的摘要 HMAC", async () => {
  const hmacKey = Buffer.alloc(32, 7);
  const store = new InMemoryKernelStore(hmacKey, () => now);
  const event = await store.transact("tenant-a", (transaction) => transaction.appendEvent({
    tenantId: "tenant-a",
    aggregateType: "workspace",
    aggregateId: "workspace-1",
    expectedStreamVersion: 0,
    type: "workspace.created",
    actorId: "owner",
    generation: 1,
    correlationId: "correlation-1",
    publicPayload: { name: "新业务" },
  }));

  assert.equal(event.hmac, createHmac("sha256", hmacKey).update(event.digest).digest("hex"));
  assert.equal(verifyEventIntegrity(event, hmacKey), true);
  assert.deepEqual(await store.listTenantIds(), ["tenant-a"]);
});

function authority(executionId: string): Omit<ExecutionAuthority, "id" | "tenantId" | "executionId" | "streamVersion" | "createdAt" | "updatedAt"> {
  return {
    workspaceId: "workspace-1",
    principalId: "agent-1",
    toolIds: ["web.read"],
    dataScopes: [{ namespace: "web", resourceId: "https://example.com" }],
    autoAllowedEffects: ["external_read"],
    budget: {
      maxSubagentDepth: 3, maxSubagents: 4, maxTokens: 10_000,
      maxCostMinorUnits: "1000", currency: "CNY", maxDurationMs: 60_000,
    },
    commitment: `authority:${executionId}`,
  };
}

test("本地身份、工作区、线程和执行共用同一事件流", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  assert.deepEqual(await kernel.bootstrapLocal("setup-1"), { tenantId: "local", principalId: "local-owner" });
  assert.deepEqual(await kernel.bootstrapLocal("setup-1"), { tenantId: "local", principalId: "local-owner" });
  const workspace = await kernel.createWorkspace("local", "local-owner", "workspace-1", {
    name: "新业务", viewMode: "business", pluginIds: ["opc"],
  });
  const thread = await kernel.createThread("local", "local-owner", "thread-1", {
    workspaceId: workspace.id, subject: "验证设计师获客问题", pluginId: "opc",
  });
  const execution = await kernel.createExecution("local", "local-owner", "execution-1", {
    workspaceId: workspace.id, threadId: thread.id, pluginId: "opc",
    agentDefinitionId: "opc-validator", modelBindingId: "model-1", executionPrincipalId: "agent-1",
    authority: { ...authority("new"), workspaceId: workspace.id },
  });
  const events = await store.readEvents("local", 0, 20);
  assert.deepEqual(events.events.map((event) => event.position), [1, 2, 3, 4]);
  assert.equal(events.events.at(-1)?.aggregateId, execution.id);
  assert.equal(events.events.every((event) => event.hmac.length === 64), true);
});

test("企业组织角色随工作区所有者成员关系持久化", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  const workspace = await kernel.createWorkspace("tenant-a", "owner", "enterprise-workspace", {
    name: "企业工作区",
    viewMode: "professional",
    pluginIds: ["coding"],
    organizationRoles: ["organization_admin", "auditor"],
  });
  const membership = await store.transact("tenant-a", (transaction) =>
    transaction.getProjection("membership", `${workspace.id}:owner`));
  assert.deepEqual(membership, {
    id: `${workspace.id}:owner`,
    tenantId: "tenant-a",
    workspaceId: workspace.id,
    principalId: "owner",
    organizationRoles: ["organization_admin", "auditor"],
    workspaceRole: "owner",
    streamVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
});

test("模型密钥引用策略可按部署 profile 注入且默认只接受 v2 Keychain", async () => {
  const connection = {
    presetId: "openai",
    displayName: "OpenAI",
    secretRef: "vault://muniu/v2/model-openai",
    defaultModel: "gpt-5",
    discoveredModels: ["gpt-5"],
  } as const;
  const localKernel = new AgentOsKernel(new InMemoryKernelStore(), { now: () => now });
  await assert.rejects(
    localKernel.saveModelConnection("local", "local-owner", "local-secret", connection),
    /密钥引用不属于当前部署的受信存储/,
  );

  const enterpriseKernel = new AgentOsKernel(new InMemoryKernelStore(), {
    now: () => now,
    acceptsModelSecretReference: (reference) => reference.startsWith("vault://muniu/v2/"),
  });
  const saved = await enterpriseKernel.saveModelConnection("tenant-a", "owner", "vault-secret", connection);
  assert.equal(saved.secretRef, connection.secretRef);
  await assert.rejects(
    enterpriseKernel.saveModelConnection("tenant-a", "owner", "keychain-secret", {
      ...connection,
      secretRef: "keychain://muniu.v2/model-openai",
    }),
    /密钥引用不属于当前部署的受信存储/,
  );
});

test("提交 turn 会原子持久化上下文、权限、Execution、Job 和 outbox", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("setup-turn");
  const workspace = await kernel.createWorkspace("local", "local-owner", "workspace-turn", {
    name: "机会验证", viewMode: "business", pluginIds: ["opc"],
  });
  const thread = await kernel.createThread("local", "local-owner", "thread-turn", {
    workspaceId: workspace.id, subject: "验证设计师获客", pluginId: "opc",
  });
  const execution = await kernel.submitTurn("local", "local-owner", "turn-1", {
    workspaceId: workspace.id,
    threadId: thread.id,
    expectedStreamVersion: thread.streamVersion,
    message: "请整理支持证据和反证",
    agentDefinitionId: "opc.opportunity-validator",
    modelBindingId: "connection-1",
    executionPrincipalId: "agent:opc",
    authority: {
      workspaceId: workspace.id,
      principalId: "agent:opc",
      toolIds: ["opc.public-web.read"],
      dataScopes: [{ namespace: "workspace", resourceId: workspace.id }],
      autoAllowedEffects: ["local_read", "external_read", "local_reversible_write"],
      budget: {
        maxSubagentDepth: 2, maxSubagents: 4, maxTokens: 20_000,
        maxCostMinorUnits: "1000", currency: "CNY", maxDurationMs: 3_600_000,
      },
    },
  });

  assert.equal(execution.status, "queued");
  const saved = await store.transact("local", (transaction) => ({
    authority: transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId),
    session: transaction.listProjections<{ message: string }>("session-log-entry"),
  }));
  assert.equal(saved.authority?.commitment.length, 64);
  assert.equal(saved.session[0]?.message, "请整理支持证据和反证");
  assert.deepEqual(store.readJobs("local").map((job) => [job.kind, job.payload.executionId]), [
    ["agent.execution.run", execution.id],
  ]);
  assert.deepEqual(store.readOutbox("local").map((message) => message.topic), ["job.available"]);

  await assert.rejects(kernel.submitTurn("local", "local-owner", "turn-stale", {
    workspaceId: workspace.id,
    threadId: thread.id,
    expectedStreamVersion: thread.streamVersion,
    message: "过期写入",
    agentDefinitionId: "opc.opportunity-validator",
    modelBindingId: "connection-1",
    executionPrincipalId: "agent:opc",
    authority: {
      workspaceId: workspace.id,
      principalId: "agent:opc",
      toolIds: [], dataScopes: [], autoAllowedEffects: [],
      budget: {
        maxSubagentDepth: 1, maxSubagents: 1, maxTokens: 1,
        maxCostMinorUnits: "0", currency: "CNY", maxDurationMs: 1,
      },
    },
  }), /版本冲突/);
  assert.equal(store.readJobs("local").length, 1);
});

test("执行只允许明确状态转换，恢复会递增 generation", async () => {
  assert.equal(transitionExecution("paused", "resume"), "queued");
  assert.throws(() => transitionExecution("running", "resume"), /不能执行/);
  assert.equal(unknownEffectStatus("external_side_effect", false), "needs_reconciliation");
  assert.equal(unknownEffectStatus("external_read", false), undefined);
});

test("恢复执行会在同一事务创建新 generation 的 Job 与 outbox", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  let sequence = 0;
  const kernel = new AgentOsKernel(store, {
    now: () => now,
    id: (kind) => `${kind}-${++sequence}`,
  });
  await kernel.bootstrapLocal("resume-setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "resume-workspace", {
    name: "恢复测试", viewMode: "professional", pluginIds: ["opc"],
  });
  const thread = await kernel.createThread("local", "local-owner", "resume-thread", {
    workspaceId: workspace.id, subject: "恢复机会验证", pluginId: "opc",
  });
  const execution = await kernel.createExecution("local", "local-owner", "resume-execution", {
    workspaceId: workspace.id, threadId: thread.id, pluginId: "opc",
    agentDefinitionId: "opc.opportunity-validator", modelBindingId: "model-1",
    executionPrincipalId: "agent-1", authority: { ...authority("resume"), workspaceId: workspace.id },
  });
  const running = await kernel.commandExecution(
    "local", "local-owner", "resume-start", execution.id, execution.streamVersion, "start",
  );
  const interrupted = await kernel.commandExecution(
    "local", "local-owner", "resume-interrupt", execution.id, running.streamVersion, "interrupt",
  );
  const resumed = await kernel.commandExecution(
    "local", "local-owner", "resume-command", execution.id, interrupted.streamVersion, "resume",
  );

  assert.equal(resumed.status, "queued");
  assert.equal(resumed.generation, 2);
  assert.deepEqual(store.readJobs("local").map((job) => job.payload), [
    { executionId: execution.id, command: "resume", generation: 2 },
  ]);
  assert.deepEqual(store.readOutbox("local").map((message) => message.topic), ["job.available"]);
  const jobs = await store.transact("local", (transaction) =>
    transaction.listProjections<import("@mn/contracts").Job>("job"));
  assert.equal(jobs[0]?.idempotencyKey, `execution:${execution.id}:generation:2`);
});

test("恢复会原子失效旧 generation 的待审批项", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("resume-approval-setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "resume-approval-workspace", {
    name: "审批恢复", viewMode: "professional", pluginIds: ["opc"],
  });
  const thread = await kernel.createThread("local", "local-owner", "resume-approval-thread", {
    workspaceId: workspace.id, subject: "等待审批时中断", pluginId: "opc",
  });
  const execution = await kernel.createExecution("local", "local-owner", "resume-approval-execution", {
    workspaceId: workspace.id, threadId: thread.id, pluginId: "opc",
    agentDefinitionId: "opc.opportunity-validator", modelBindingId: "model-1",
    executionPrincipalId: "agent-1", authority: { ...authority("resume-approval"), workspaceId: workspace.id },
  });
  const running = await kernel.commandExecution(
    "local", "local-owner", "resume-approval-start", execution.id, execution.streamVersion, "start",
  );
  const request = await kernel.requestToolApproval("local", "agent-1", "resume-old-intent", {
    id: "old-generation-call", executionId: execution.id, generation: 1,
    toolId: "web.read", toolVersion: "1.0.0", effectClass: "external_side_effect",
    intent: "发布旧代次结果", normalizedArguments: { url: "https://example.com" },
    argumentsDigest: "args", resourcesDigest: "resources",
    resourceRefs: [{ namespace: "web", resourceId: "https://example.com" }],
    authorityCommitment: "authority:resume-approval", expiresAt: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(request.mode, "approval");
  if (request.mode !== "approval") return;
  const waiting = await store.transact("local", (transaction) =>
    transaction.getProjection<Execution>("execution", execution.id)!);
  const interrupted = await kernel.commandExecution(
    "local", "local-owner", "resume-approval-interrupt",
    execution.id, waiting.streamVersion, "interrupt",
  );
  await kernel.commandExecution(
    "local", "local-owner", "resume-approval-command",
    execution.id, interrupted.streamVersion, "resume",
  );

  const expired = await store.transact("local", (transaction) =>
    transaction.getProjection<import("@mn/contracts").Approval>("approval", request.approval.id));
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.streamVersion, 2);
  assert.equal((await kernel.listInbox("local")).length, 0);
  await assert.rejects(
    kernel.decideApproval(
      "local", "local-owner", "resume-old-decision", request.approval.id, 2, "approve_once",
    ),
    /已经处理/u,
  );
  assert.equal(running.generation, 1);
});

test("子 Agent 的工具、数据和预算必须是父权限的严格子集", () => {
  const parent: ExecutionAuthority = {
    ...authority("parent"), id: "parent", tenantId: "local", executionId: "parent",
    streamVersion: 1, createdAt: now, updatedAt: now,
  };
  const child: ExecutionAuthority = {
    ...parent,
    id: "child",
    executionId: "child",
    parentAuthorityId: "parent",
    budget: { ...parent.budget, maxSubagentDepth: 2, maxTokens: 5_000, maxCostMinorUnits: "500" },
  };
  assert.doesNotThrow(() => assertAuthorityAttenuation(parent, child));
  assert.throws(
    () => assertAuthorityAttenuation(parent, { ...child, toolIds: ["web.read", "mail.send"] }),
    /没有的工具/,
  );
  assert.throws(
    () => assertAuthorityAttenuation(parent, { ...child, budget: { ...child.budget, maxSubagentDepth: 3 } }),
    /没有衰减/,
  );
  assert.doesNotThrow(() => assertAuthorityAttenuation(
    { ...parent, dataScopes: [{ namespace: "web", resourceId: "*" }] },
    { ...child, dataScopes: [{ namespace: "web", resourceId: "https://example.com/case" }] },
  ));
});

test("资源通配范围仍约束 namespace，固定摘要不可被替换", () => {
  const executionAuthority: ExecutionAuthority = {
    ...authority("resource"),
    id: "authority-resource",
    tenantId: "local",
    executionId: "execution-resource",
    commitment: "commitment-resource",
    dataScopes: [
      { namespace: "web", resourceId: "*" },
      { namespace: "repository", resourceId: "/workspace/muniu", digest: "sha256:approved" },
    ],
    streamVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const base: ToolCallIntent = {
    id: "resource-call",
    executionId: executionAuthority.executionId,
    generation: 1,
    toolId: "web.read",
    toolVersion: "1",
    effectClass: "external_read",
    intent: "读取公开网页",
    normalizedArguments: {},
    argumentsDigest: "args",
    resourceRefs: [{ namespace: "web", resourceId: "https://example.com/case" }],
    resourcesDigest: "resources",
    authorityCommitment: executionAuthority.commitment,
    expiresAt: "2026-09-05T00:00:00Z",
  };
  assert.equal(authorityAllowsIntent(executionAuthority, base), "auto");
  assert.throws(() => authorityAllowsIntent(executionAuthority, {
    ...base,
    resourceRefs: [{ namespace: "private-network", resourceId: "http://127.0.0.1" }],
  }), /超出已授权资源范围/);
  assert.throws(() => authorityAllowsIntent({ ...executionAuthority, toolIds: ["repository.read"] }, {
    ...base,
    toolId: "repository.read",
    effectClass: "local_read",
    resourceRefs: [{ namespace: "repository", resourceId: "/workspace/muniu", digest: "sha256:changed" }],
  }), /超出已授权资源范围/);
});

test("只读工具可自动执行，高影响操作进入审批收件箱", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "ws", { name: "业务", viewMode: "business", pluginIds: ["opc"] });
  const thread = await kernel.createThread("local", "local-owner", "thread", { workspaceId: workspace.id, subject: "机会", pluginId: "opc" });
  const execution = await kernel.createExecution("local", "local-owner", "exec", {
    workspaceId: workspace.id, threadId: thread.id, pluginId: "opc", agentDefinitionId: "a",
    modelBindingId: "m", executionPrincipalId: "agent", authority: { ...authority("exec"), workspaceId: workspace.id },
  });
  const base: ToolCallIntent = {
    id: "call", executionId: execution.id, generation: 1, toolId: "web.read", toolVersion: "1.0.0",
    effectClass: "external_read", intent: "读取公开网页", normalizedArguments: { url: "https://example.com" },
    argumentsDigest: "args", resourceRefs: [{ namespace: "web", resourceId: "https://example.com" }],
    resourcesDigest: "resources", authorityCommitment: "authority:exec", expiresAt: "2026-09-05T00:00:00Z",
  };
  assert.equal((await kernel.requestToolApproval("local", "agent", "read", base)).mode, "auto");
  const manual = await kernel.requestToolApproval("local", "agent", "write", {
    ...base, id: "call-2", effectClass: "external_side_effect", intent: "发布内容",
  });
  assert.equal(manual.mode, "approval");
  if (manual.mode === "approval") {
    assert.equal(manual.approval.status, "pending");
    const decided = await kernel.decideApproval("local", "local-owner", "decision", manual.approval.id, 1, "approve_once");
    assert.equal(decided.status, "approved_once");
    assert.equal((await kernel.listInbox("local")).length, 0);
    const updatedExecution = await store.transact("local", (transaction) =>
      transaction.getProjection<Execution>("execution", execution.id));
    assert.equal(updatedExecution?.status, "running");
    assert.equal(updatedExecution?.streamVersion, 4);
    const executionEvents = (await store.readEvents("local", 0, 30)).events
      .filter((event) => event.aggregateType === "execution" && event.aggregateId === execution.id);
    assert.equal(executionEvents.at(-1)?.type, "execution.approval_approved_once");
    assert.equal(executionEvents.at(-1)?.streamVersion, 4);

    const stale = await kernel.requestToolApproval("local", "agent", "write-stale", {
      ...base, id: "call-3", effectClass: "external_side_effect", intent: "再次发布内容",
    });
    assert.equal(stale.mode, "approval");
    if (stale.mode === "approval") {
      const cancelled = await kernel.commandExecution(
        "local", "local-owner", "cancel-waiting", execution.id, 5, "cancel",
      );
      assert.equal(cancelled.status, "cancelled");
      await assert.rejects(
        kernel.decideApproval(
          "local", "local-owner", "stale-decision", stale.approval.id, 1, "approve_once",
        ),
        /不再等待批准/,
      );
      const stillCancelled = await store.transact("local", (transaction) =>
        transaction.getProjection<Execution>("execution", execution.id));
      assert.equal(stillCancelled?.status, "cancelled");
      assert.equal(stillCancelled?.streamVersion, 6);
    }
  }
});

test("跨 namespace 记忆必须有未撤销授权", () => {
  const memory: MemoryRecord = {
    id: "memory", tenantId: "local", workspaceId: "workspace", scopeType: "resource",
    namespace: "opc", resourceId: "opportunity", sourceEventId: "event", status: "accepted",
    confidence: 0.8, value: { note: "客户重视交付周期" }, confirmedAt: now, shareGrantIds: ["grant"],
    streamVersion: 2, createdAt: now, updatedAt: now,
  };
  const grant = {
    id: "grant", tenantId: "local", workspaceId: "workspace", memoryId: "memory",
    fromNamespace: "opc", toNamespace: "coding", grantedBy: "owner", grantedAt: now,
    streamVersion: 1, createdAt: now, updatedAt: now,
  } as const;
  assert.equal(canReadMemory(memory, "opc", []), true);
  assert.equal(canReadMemory(memory, "coding", []), false);
  assert.equal(canReadMemory(memory, "coding", [grant]), true);
  assert.equal(canReadMemory(memory, "coding", [{ ...grant, revokedAt: now }]), false);
});

test("撤销共享授权会在同一事务使派生记忆失效", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("memory-derived-setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "memory-derived-workspace", {
    name: "记忆治理", viewMode: "professional", pluginIds: ["opc", "coding"],
  });
  const source = await kernel.proposeMemory("local", "agent:opc", "memory-source", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "opc",
    resourceId: "opportunity-1",
    sourceEventId: "event-source",
    confidence: 0.9,
    value: { summary: "客户重视恢复能力" },
  });
  const accepted = await kernel.decideMemory(
    "local", "local-owner", "memory-source-accept", source.id, source.streamVersion, "accept",
  );
  const grant = await kernel.createShareGrant(
    "local", "local-owner", "memory-source-share", source.id, accepted.streamVersion, "coding",
  );
  const derived = await kernel.proposeMemory("local", "agent:coding", "memory-derived", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "coding",
    resourceId: "repository-1",
    sourceEventId: "event-derived",
    confidence: 0.7,
    value: { summary: "恢复检查应进入 Gate" },
    derivedFromMemoryId: source.id,
    derivedViaShareGrantId: grant.id,
  });

  await kernel.revokeShareGrant("local", "local-owner", "memory-revoke", grant.id, grant.streamVersion);
  const invalidated = await store.transact("local", (transaction) =>
    transaction.getProjection<MemoryRecord>("memory", derived.id));
  assert.equal(invalidated?.status, "invalidated");
  assert.equal(invalidated?.streamVersion, derived.streamVersion + 1);
});

test("撤销上游共享授权会递归使多层派生记忆失效", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("memory-transitive-setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "memory-transitive-workspace", {
    name: "链式记忆治理", viewMode: "professional", pluginIds: ["opc", "coding"],
  });
  const source = await kernel.proposeMemory("local", "agent:opc", "memory-transitive-source", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "opc",
    resourceId: "opportunity-1",
    sourceEventId: "event-source",
    confidence: 0.9,
    value: { summary: "客户要求审计证据" },
  });
  const acceptedSource = await kernel.decideMemory(
    "local", "local-owner", "memory-transitive-source-accept", source.id, source.streamVersion, "accept",
  );
  const firstGrant = await kernel.createShareGrant(
    "local", "local-owner", "memory-transitive-first-share",
    source.id, acceptedSource.streamVersion, "coding",
  );
  const firstDerived = await kernel.proposeMemory("local", "agent:coding", "memory-transitive-first", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "coding",
    resourceId: "repository-1",
    sourceEventId: "event-first-derived",
    confidence: 0.8,
    value: { summary: "Gate 应保留审计证据" },
    derivedFromMemoryId: source.id,
    derivedViaShareGrantId: firstGrant.id,
  });
  const acceptedFirst = await kernel.decideMemory(
    "local", "local-owner", "memory-transitive-first-accept",
    firstDerived.id, firstDerived.streamVersion, "accept",
  );
  const secondGrant = await kernel.createShareGrant(
    "local", "local-owner", "memory-transitive-second-share",
    firstDerived.id, acceptedFirst.streamVersion, "opc",
  );
  const secondDerived = await kernel.proposeMemory("local", "agent:opc", "memory-transitive-second", {
    workspaceId: workspace.id,
    scopeType: "workspace",
    namespace: "opc",
    resourceId: workspace.id,
    sourceEventId: "event-second-derived",
    confidence: 0.7,
    value: { summary: "后续机会也应保留审计证据" },
    derivedFromMemoryId: firstDerived.id,
    derivedViaShareGrantId: secondGrant.id,
  });

  await kernel.revokeShareGrant(
    "local", "local-owner", "memory-transitive-revoke", firstGrant.id, firstGrant.streamVersion,
  );
  const [invalidatedFirst, invalidatedSecond] = await store.transact("local", (transaction) => [
    transaction.getProjection<MemoryRecord>("memory", firstDerived.id),
    transaction.getProjection<MemoryRecord>("memory", secondDerived.id),
  ]);
  assert.equal(invalidatedFirst?.status, "invalidated");
  assert.equal(invalidatedSecond?.status, "invalidated");
  const revokeEvent = (await store.readEvents("local", 0, 100)).events
    .find((event) => event.type === "share_grant.revoked" && event.aggregateId === firstGrant.id);
  assert.equal(revokeEvent?.publicPayload.invalidatedMemoryCount, 2);
});

test("用户可在接受前修改记忆提案，已确认记忆不可被静默改写", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("memory-revise-setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "memory-revise-workspace", {
    name: "记忆修正", viewMode: "business", pluginIds: ["opc"],
  });
  const proposal = await kernel.proposeMemory("local", "agent:opc", "memory-revise-source", {
    workspaceId: workspace.id,
    scopeType: "workspace",
    namespace: "opc",
    resourceId: workspace.id,
    sourceEventId: "event-memory-revise",
    confidence: 0.55,
    value: { summary: "客户可能重视速度" },
  });
  const revised = await kernel.reviseMemoryProposal(
    "local", "local-owner", "memory-revise", proposal.id, proposal.streamVersion,
    { confidence: 0.9, value: { summary: "客户明确重视恢复速度" } },
  );
  assert.equal(revised.confidence, 0.9);
  assert.equal(revised.value?.summary, "客户明确重视恢复速度");
  const accepted = await kernel.decideMemory(
    "local", "local-owner", "memory-revise-accept", revised.id, revised.streamVersion, "accept",
  );
  await assert.rejects(kernel.reviseMemoryProposal(
    "local", "local-owner", "memory-revise-after-accept", accepted.id, accepted.streamVersion,
    { confidence: 0.1, value: { summary: "静默改写" } },
  ), /只有待确认记忆/);
});

test("删除敏感记忆先锁定版本，再销毁密钥并写入 tombstone", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("memory-delete-setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "memory-delete-workspace", {
    name: "记忆删除", viewMode: "business", pluginIds: ["opc"],
  });
  const memory = await kernel.proposeMemory("local", "agent:opc", "memory-delete-source", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "opc",
    resourceId: "opportunity-secret",
    sourceEventId: "event-secret",
    confidence: 0.8,
    protectedPayloadRef: "key://memory-secret",
  });
  let destroyCalls = 0;
  const keys = { async destroy() { destroyCalls += 1; } };
  await assert.rejects(kernel.deleteMemory(
    "local", "local-owner", "memory-delete-stale", memory.id, 0, "用户要求删除", keys,
  ), /版本/);
  assert.equal(destroyCalls, 0);

  let first = true;
  const flakyKeys = {
    async destroy() {
      destroyCalls += 1;
      if (first) { first = false; throw new Error("Keychain 暂时不可用"); }
    },
  };
  await assert.rejects(kernel.deleteMemory(
    "local", "local-owner", "memory-delete", memory.id, memory.streamVersion, "用户要求删除", flakyKeys,
  ), /Keychain/);
  const pending = await store.transact("local", (transaction) =>
    transaction.getProjection<MemoryRecord>("memory", memory.id));
  assert.equal(pending?.status, "deletion_pending");
  assert.equal(pending?.value, undefined);

  const deleted = await kernel.deleteMemory(
    "local", "local-owner", "memory-delete", memory.id, memory.streamVersion, "用户要求删除", flakyKeys,
  );
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.protectedPayloadRef, undefined);
  assert.equal(deleted.streamVersion, memory.streamVersion + 2);
  assert.equal(destroyCalls, 2);
  const events = (await store.readEvents("local", 0, 50)).events
    .filter((event) => event.aggregateType === "memory" && event.aggregateId === memory.id);
  assert.deepEqual(events.slice(-2).map((event) => event.type), [
    "memory.deletion_requested",
    "memory.deleted",
  ]);
});

test("事务失败时事件和投影都不提交", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  await assert.rejects(
    store.transact("local", (transaction) => {
      transaction.putProjection("workspace", "bad", { id: "bad" });
      transaction.appendEvent({
        tenantId: "local", aggregateType: "workspace", aggregateId: "bad", expectedStreamVersion: 1,
        type: "bad", actorId: "owner", generation: 0, correlationId: "c", publicPayload: {},
      });
    }),
    /版本冲突/,
  );
  assert.equal((await store.readEvents("local", 0, 10)).events.length, 0);
});

test("工作区成员角色可审计修改，且不能移除最后一名所有者", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal("membership-setup");
  const workspace = await kernel.createWorkspace("local", "local-owner", "membership-workspace", {
    name: "成员治理", viewMode: "professional", pluginIds: [],
  });

  const added = await kernel.setWorkspaceMembership(
    "local", "local-owner", "membership-add", workspace.id, "operator-a", 0, "operator",
  );
  assert.equal(added.workspaceRole, "operator");
  assert.equal(added.streamVersion, 1);
  const changed = await kernel.setWorkspaceMembership(
    "local", "local-owner", "membership-change", workspace.id, "operator-a", 1, "reviewer",
  );
  assert.equal(changed.workspaceRole, "reviewer");
  assert.equal(changed.streamVersion, 2);
  assert.deepEqual((await kernel.listWorkspaceMemberships("local", workspace.id))
    .map((membership) => [membership.principalId, membership.workspaceRole]), [
    ["local-owner", "owner"],
    ["operator-a", "reviewer"],
  ]);

  const removed = await kernel.removeWorkspaceMembership(
    "local", "local-owner", "membership-remove", workspace.id, "operator-a", 2,
  );
  assert.equal(typeof removed.removedAt, "string");
  assert.equal(removed.streamVersion, 3);
  assert.deepEqual((await kernel.listWorkspaceMemberships("local", workspace.id))
    .map((membership) => membership.principalId), ["local-owner"]);
  await assert.rejects(kernel.removeWorkspaceMembership(
    "local", "local-owner", "membership-remove-owner", workspace.id, "local-owner", 1,
  ), /最后一名所有者/);

  const restored = await kernel.setWorkspaceMembership(
    "local", "local-owner", "membership-restore", workspace.id, "operator-a", 3, "viewer",
  );
  assert.equal(restored.removedAt, undefined);
  assert.equal(restored.streamVersion, 4);
  const events = (await store.readEvents("local", 0, 50)).events
    .filter((event) => event.aggregateType === "workspaceMembership");
  assert.deepEqual(events.map((event) => event.type), [
    "workspace_membership.created",
    "workspace_membership.role_changed",
    "workspace_membership.removed",
    "workspace_membership.restored",
  ]);
});
