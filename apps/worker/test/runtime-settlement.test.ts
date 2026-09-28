// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Execution } from "@mn/contracts";
import { AgentOsKernel } from "@mn/kernel";
import { AgentScope } from "@mn/agent-runtime";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { AgentOsWorker, createKernelAgentTurnHandler, createProtectedRuntimeStore } from "../src/index.js";

for (const scenario of [
  { name: "完成", status: "completed", jobStatus: "completed" },
  { name: "失败", status: "failed", jobStatus: "failed" },
  { name: "取消与完成竞争", status: "cancelled", jobStatus: "failed" },
  { name: "结束时仍有调整方向", status: "paused", jobStatus: "completed" },
  { name: "模型缺少用量时暂停", status: "paused", jobStatus: "completed" },
  { name: "模型预留超过 token 预算时暂停", status: "paused", jobStatus: "completed" },
  { name: "模型预检期间中断，禁止发出请求", status: "interrupted", jobStatus: "failed" },
  { name: "插件中断请求阻止完成并终结物理 Job", status: "interrupted", jobStatus: "failed" },
] as const) test(`通用 Agent Runtime：${scenario.name}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muniu-runtime-settlement-"));
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite3"), hmacKey: Buffer.alloc(32, 1) });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const now = "2026-09-04T00:00:00.000Z";
  const entity = { tenantId: "local", createdAt: now, updatedAt: now, streamVersion: 0 };
  await store.transact("local", tx => {
    tx.putProjection("membership", "workspace:local-owner", { ...entity, id: "workspace:local-owner",
      workspaceId: "workspace", principalId: "local-owner", workspaceRole: "owner", organizationRoles: [] });
    tx.putProjection("thread", "thread", { ...entity, id: "thread", workspaceId: "workspace", subject: "验证需求", pluginId: "opc" });
    tx.putProjection("execution", "execution", { ...entity, id: "execution", workspaceId: "workspace", threadId: "thread", pluginId: "opc",
      agentDefinitionId: "opc.opportunity-validator", modelBindingId: "model", initiatedBy: "local-owner", executionPrincipalId: "agent",
      generation: 1, status: "queued", authorityId: "authority" });
    tx.putProjection("authority", "authority", { ...entity, id: "authority", workspaceId: "workspace", executionId: "execution", principalId: "agent",
      toolIds: [], dataScopes: [], autoAllowedEffects: [], commitment: "authority", budget: {
        maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 10000, maxCostMinorUnits: "100", currency: "CNY", maxDurationMs: 60000,
      } });
    tx.putProjection("modelConnection", "model", { id: "model", tenantId: "local", presetId: "deepseek", secretRef: "keychain://muniu.v2/model",
      defaultModel: "deepseek-chat", status: "ready" });
    const job = { ...entity, id: "job", workspaceId: "workspace", kind: "agent.execution.run", payload: { executionId: "execution", message: "验证需求" },
      status: "available", attempts: 0, availableAt: now, fencingToken: 0, idempotencyKey: "job-key" };
    tx.putProjection("job", "job", job);
    tx.putJob(job);
  });
  const runtimeProtection = { cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 3)) };
  const reader = createProtectedRuntimeStore({ ...runtimeProtection, tenantId: "local", workspaceId: "workspace", store });
  const observed: string[] = [];
  let terminalObserved = false;
  const intercepted = new Proxy(store, { get(target, property) {
    if (property === "transact") return async (tenantId: string, work: Parameters<SqliteStorage["transact"]>[1]) => {
      const result = await target.transact(tenantId, work);
      if (!terminalObserved) {
        const records = await reader.readExecution("execution");
        if (records.at(-1)?.payload.status === scenario.status) {
          terminalObserved = true;
          observed.push((await target.getJob("job"))!.status);
        }
      }
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const kernel = new AgentOsKernel(store, { now: () => now });
  const owner = AgentScope.tenant("composition-fixture");
  await owner.ready;
  t.after(() => owner.dispose());
  const registrySize = owner.context.registry.size;
  let modelCalls = 0;
  const handler = createKernelAgentTurnHandler({ store: intercepted, runtimeProtection, controlPollIntervalMs: 60_000,
    ...{ scopeContext: owner.context },
    modelQuoter: async () => {
      if (scenario.name === "模型预检期间中断，禁止发出请求") await store.transact("local", tx =>
        tx.putProjection("execution-control", "execution", { executionId: "execution", generation: 1, command: "interrupt" }));
      return { inputTokenLimit: scenario.name.includes("token") ? 10_000 : 100, maxOutputTokens: 100,
      rates: { id: "non-billable-fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0",
        cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } };
    },
    secretStore: { read: async () => "fixture-key" }, modelInvoker: async () => {
      modelCalls++;
      assert.ok(owner.context.registry.size > registrySize, "运行时 Scope 必须由组合根持有");
      assert.equal((await reader.readExecution("execution")).filter(record => record.type === "model/reserved").length, 1);
      if (scenario.status === "failed") return { text: "", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
        toolCalls: [1, 2].map(() => ({ id: "duplicate", toolId: "missing-tool", arguments: {} })) };
      if (scenario.status === "cancelled") {
        const execution = await store.transact("local", tx => tx.getProjection<Execution>("execution", "execution"));
        await kernel.commandExecution("local", "local-owner", "cancel-before-completion", "execution", execution!.streamVersion, "cancel");
      }
      if (scenario.name === "模型缺少用量时暂停") return { text: "不能使用未结算的模型结果", toolCalls: [] };
      if (scenario.name === "结束时仍有调整方向") await reader.append({ executionId: "execution", type: "inbox/enqueued",
        payload: { id: "late-steer", kind: "steer", text: "还有未应用的调整" } });
      if (scenario.status === "interrupted") await store.transact("local", tx =>
        tx.putProjection("execution-control", "execution", { executionId: "execution", generation: 1, command: "interrupt" }));
      return { text: "需要更多证据", toolCalls: [], usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } };
    }, now: () => now });
  const worker = new AgentOsWorker({ id: "worker", store: intercepted, now: () => new Date(now),
    lock: { engineLockDigest: "lock", expectedEngineLockDigest: "lock", pluginLockDigest: "lock", expectedPluginLockDigest: "lock" },
    handlers: { "agent.execution.run": handler } });
  assert.deepEqual(await worker.pollOnce(), { status: scenario.status === "paused" ? "completed" : scenario.status, jobId: "job" });
  assert.deepEqual(observed, [scenario.status === "interrupted" ? "leased" : scenario.jobStatus]);
  assert.equal((await store.getJob("job"))?.status, scenario.jobStatus);
  assert.equal(owner.context.registry.size, registrySize, "一次执行的完整 Scope 树必须清理");
  const records = await reader.readExecution("execution");
  assert.equal(records.filter(record => record.type === "execution/status").at(-1)?.payload.status, scenario.status);
  assert.equal(JSON.stringify(records).includes("fixture-model-secret-failure"), false);
  assert.equal((await store.transact("local", tx => tx.getProjection<Execution>("execution", "execution")))?.status, scenario.status);
  if (scenario.name.startsWith("模型")) {
    assert.equal(modelCalls, scenario.name.includes("缺少用量") ? 1 : 0);
    assert.equal(records.filter(record => record.type === "model/settled").length, 0);
    if (scenario.status === "paused") {
      const inbox = await store.transact("local", tx => tx.listProjections<{ kind: string; executionId?: string; status: string }>("inbox"));
      assert.equal(inbox.filter(item => item.executionId === "execution" && item.kind === "agent_question" && item.status === "open").length, 1);
    }
  }
});
