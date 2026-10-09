// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { AgentOsKernel, InMemoryKernelStore, type SubmitTurnInput } from "../src/index.js";

test("事务内提交会话与调用方事实一起回滚，重试只创建一个执行和 Job", async () => {
  const store = new InMemoryKernelStore();
  const kernel = new AgentOsKernel(store);
  await kernel.bootstrapLocal("init");
  const workspace = await kernel.createWorkspace("local", "local-owner", "workspace", { name: "目标事务", viewMode: "business", pluginIds: ["opc"] });
  const thread = await kernel.createThread("local", "local-owner", "thread", { workspaceId: workspace.id, subject: "原子提交", pluginId: "opc" });
  const input: SubmitTurnInput = { workspaceId: workspace.id, threadId: thread.id, expectedStreamVersion: thread.streamVersion,
    message: "提交目标", agentDefinitionId: "opc.agent", modelBindingId: "model", executionPrincipalId: "agent:opc",
    authority: { workspaceId: workspace.id, principalId: "agent:opc", toolIds: [], dataScopes: [], autoAllowedEffects: [],
      budget: { maxSubagents: 0, maxSubagentDepth: 0, maxTokens: 100, maxCostMinorUnits: "1", currency: "CNY", maxDurationMs: 1000 } } };
  assert.equal(typeof (kernel as any).submitTurnInTransaction, "function");
  await assert.rejects(store.transact("local", tx => {
    (kernel as any).submitTurnInTransaction(tx, "local", "local-owner", "turn", input);
    throw new Error("caller failed");
  }), /caller failed/u);
  assert.equal(await store.transact("local", tx => tx.listProjections("execution").length), 0);
  assert.equal(await store.transact("local", tx => tx.listProjections("job").length), 0);
  const first = await store.transact("local", tx => (kernel as any).submitTurnInTransaction(tx, "local", "local-owner", "turn", input));
  const replay = await kernel.submitTurn("local", "local-owner", "turn", input);
  assert.equal(replay.id, first.id);
  assert.equal(await store.transact("local", tx => tx.listProjections("job").length), 1);
  assert.equal(typeof (kernel as any).commandExecutionInTransaction, "function");
  await assert.rejects(store.transact("local", tx => {
    (kernel as any).commandExecutionInTransaction(tx, "local", "local-owner", "cancel", first.id, first.streamVersion, "cancel");
    throw new Error("caller failed");
  }), /caller failed/u);
  assert.equal((await store.transact("local", tx => tx.getProjection<any>("execution", first.id))).status, "queued");
  assert.equal(await store.transact("local", tx => tx.getProjection("execution-control", first.id)), undefined);
  await store.transact("local", tx => tx.putProjection("toolAdmission", "pending", { id: "pending", executionId: first.id, status: "started" }));
  const uncertain = await kernel.commandExecution("local", "local-owner", "uncertain-cancel", first.id, first.streamVersion, "cancel");
  assert.equal(uncertain.status, "needs_reconciliation");
  assert.equal(uncertain.generation, first.generation);
  const control = await store.transact("local", tx => tx.getProjection<any>("execution-control", first.id));
  assert.equal(control?.command, "cancel");
  assert.equal(control?.generation, uncertain.generation);
  assert.equal(control?.executionId, uncertain.id);
  assert.equal(control?.requestedAt, uncertain.updatedAt);
  const events = await store.readEvents("local", 0, 100);
  const cancellation = events.events.filter(event => event.executionId === uncertain.id).at(-1);
  assert.equal(cancellation?.type, "execution.needs_reconciliation");
  assert.equal(cancellation?.publicPayload.command, "cancel");
  assert.deepEqual(await kernel.commandExecution("local", "local-owner", "uncertain-cancel", first.id, first.streamVersion, "cancel"), uncertain);
  assert.deepEqual(await store.readEvents("local", 0, 100), events);
});
