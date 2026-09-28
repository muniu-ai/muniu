// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Approval, Execution, WorkspaceMembership } from "@mn/contracts";
import { AgentOsKernel, type ToolAdmission } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { AgentOsWorker, createKernelAgentTurnHandler, createProtectedRuntimeStore } from "../src/index.js";

const NOW = "2026-09-04T00:00:00.000Z";
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };

async function fixture(t: TestContext, hooks: {
  readonly model?: () => Promise<void>;
  readonly quote?: () => Promise<void>;
  readonly revalidate?: () => Promise<void>;
  readonly execute?: () => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "muniu-revocation-"));
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite3"), hmacKey: Buffer.alloc(32, 1) });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const kernel = new AgentOsKernel(store, { now: () => NOW });
  const workspace = await kernel.createWorkspace("local", "owner", "workspace", {
    name: "撤权测试", viewMode: "professional", pluginIds: ["fixture"],
  });
  await kernel.setWorkspaceMembership("local", "owner", "member", workspace.id, "operator", 0, "operator");
  const thread = await kernel.createThread("local", "operator", "thread", { workspaceId: workspace.id, subject: "检查授权", pluginId: "fixture" });
  const execution = await kernel.submitTurn("local", "operator", "turn", {
    workspaceId: workspace.id, threadId: thread.id, expectedStreamVersion: thread.streamVersion, message: "发送结果",
    agentDefinitionId: "fixture.agent", modelBindingId: "model", executionPrincipalId: "agent:fixture", authority: {
      workspaceId: workspace.id, principalId: "agent:fixture", toolIds: ["fixture.send"], dataScopes: [], autoAllowedEffects: ["external_side_effect"],
      budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 1000, maxCostMinorUnits: "100", currency: "CNY", maxDurationMs: 60_000 },
    },
  });
  await store.transact("local", tx => tx.putProjection("modelConnection", "model", {
    id: "model", tenantId: "local", presetId: "deepseek", secretRef: "keychain://muniu.v2/model", defaultModel: "deepseek-chat", status: "ready",
  }));
  const protection = { cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 3)) };
  const runtime = createProtectedRuntimeStore({ ...protection, store, tenantId: "local", workspaceId: workspace.id });
  let modelCalls = 0;
  let toolCalls = 0;
  let preparations = 0;
  const handler = createKernelAgentTurnHandler({ store, runtimeProtection: protection, now: () => NOW,
    controlPollIntervalMs: 60_000, approvalPollIntervalMs: 1,
    secretStore: { read: async () => "fixture-secret" },
    modelQuoter: async () => {
      await hooks.quote?.();
      return { inputTokenLimit: 10, maxOutputTokens: 10, rates: { id: "fixture", currency: "CNY",
        inputNanoMinorUnitsPerToken: "0", cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } };
    },
    modelInvoker: async () => {
      modelCalls += 1;
      await hooks.model?.();
      return modelCalls === 1 ? { text: "", toolCalls: [{ id: "send", toolId: "fixture.send", arguments: {} }], usage }
        : { text: "完成", toolCalls: [], usage };
    },
    resolvePluginWorker: async () => ({ agents: [{ id: "fixture.agent", instructions: "发送测试结果", toolIds: ["fixture.send"] }], tools: [{
      id: "fixture.send", version: "1.0.0", effectClass: "external_side_effect",
      async prepare() { preparations += 1; if (preparations === 2) await hooks.revalidate?.(); return { normalizedArguments: {}, resourceRefs: [] }; },
      async execute() { toolCalls += 1; await hooks.execute?.(); return { sent: true }; },
    }] }),
  });
  const worker = new AgentOsWorker({ id: "worker", store, now: () => new Date(NOW),
    lock: { engineLockDigest: "lock", expectedEngineLockDigest: "lock", pluginLockDigest: "lock", expectedPluginLockDigest: "lock" },
    handlers: { "agent.execution.run": handler } });
  return { store, kernel, workspace, execution, runtime, worker,
    modelCalls: () => modelCalls, toolCalls: () => toolCalls,
    read: () => store.transact("local", tx => tx.getProjection<Execution>("execution", execution.id)!),
    revoke: () => kernel.removeWorkspaceMembership("local", "owner", "revoke", workspace.id, "operator", 1),
    async dropMembership() { await store.transact("local", tx => {
      const member = tx.getProjection<WorkspaceMembership>("membership", `${workspace.id}:operator`)!;
      tx.putProjection("membership", member.id, { ...member, removedAt: NOW });
    }); },
  };
}

async function waitForApproval(f: Awaited<ReturnType<typeof fixture>>): Promise<Approval> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const approval = await f.store.transact("local", tx => tx.listProjections<Approval>("approval").find(value => value.status === "pending"));
    if (approval) return approval;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("等待审批超时");
}

async function approve(f: Awaited<ReturnType<typeof fixture>>) {
  const approval = await waitForApproval(f);
  await f.kernel.decideApproval("local", "owner", "approve", approval.id, approval.streamVersion, "approve_once");
}

test("排队后撤权的执行不会调用模型", async t => {
  const f = await fixture(t);
  await f.revoke();
  await f.worker.pollOnce();
  assert.equal(f.modelCalls(), 0);
  assert.equal((await f.read()).status, "interrupted");
});

test("模型预算预检期间撤权，在模型准入事务阻断请求", async t => {
  const f = await fixture(t, { quote: async () => f.dropMembership() });
  const result = await f.worker.pollOnce();
  assert.equal(result.status, "failed");
  assert.equal(f.modelCalls(), 0);
});

test("模型在途时撤权，响应不能引发工具调用", async t => {
  const f = await fixture(t, { model: async () => { await f.revoke(); } });
  await f.worker.pollOnce();
  assert.equal(f.modelCalls(), 1);
  assert.equal(f.toolCalls(), 0);
  assert.equal((await f.read()).status, "interrupted");
});

test("等待批准期间当前成员失效，审批端口终止等待", async t => {
  const f = await fixture(t);
  const polling = f.worker.pollOnce();
  await waitForApproval(f);
  await f.dropMembership();
  const result = await Promise.race([polling, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("撤权后审批等待未结束")), 1000);
    timer.unref();
  })]);
  assert.equal(result.status, "failed");
  assert.equal(f.toolCalls(), 0);
});

test("批准后复核期间撤权，工具准入事务重新检查当前成员", async t => {
  const f = await fixture(t, { revalidate: async () => f.dropMembership() });
  const polling = f.worker.pollOnce();
  await approve(f);
  const result = await polling;
  assert.equal(result.status, "failed");
  assert.equal(f.toolCalls(), 0);
  assert.equal((await f.runtime.readExecution(f.execution.id)).filter(record => record.type === "tool/started").length, 0);
});

test("已准入请求撤权后结果未知，重新入会不能自动重放", async t => {
  const f = await fixture(t, { execute: async () => {
    const revoked = await f.revoke();
    await f.kernel.setWorkspaceMembership("local", "owner", "restore", f.workspace.id, "operator", revoked.streamVersion, "operator");
    throw new Error("接收方结果未知");
  } });
  const polling = f.worker.pollOnce();
  await approve(f);
  assert.equal((await polling).status, "needs_reconciliation");
  assert.equal((await f.read()).status, "needs_reconciliation");
  assert.equal(f.toolCalls(), 1);
  assert.equal((await f.store.transact("local", tx => tx.listProjections<ToolAdmission>("toolAdmission")))[0]?.status, "started");
  assert.equal((await f.worker.pollOnce()).status, "idle");
  assert.equal(f.toolCalls(), 1);
});

test("批准后审批人失去审核权限，派发前再次核验批准人", async t => {
  const f = await fixture(t, { revalidate: async () => {
    await f.store.transact("local", tx => {
      const membership = tx.getProjection<WorkspaceMembership>("membership", `${f.workspace.id}:owner`)!;
      tx.putProjection("membership", membership.id, { ...membership, workspaceRole: "viewer" });
    });
  } });
  const polling = f.worker.pollOnce();
  await approve(f);
  const result = await polling;
  assert.equal(result.status, "failed");
  assert.equal(f.toolCalls(), 0);
});
