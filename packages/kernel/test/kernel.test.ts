import assert from "node:assert/strict";
import test from "node:test";
import type { Execution, ExecutionAuthority, MemoryRecord, ToolCallIntent } from "@mn/contracts";
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
