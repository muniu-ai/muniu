// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { workspaceActivity } from "../src/index.js";
import { KernelProjectionRuntimeStore, PersistentModelBudget } from "@mn/agent-runtime";

test("活动费用由执行账本生成；未知用量不会丢失已知费用或伪装成零", async () => {
  const store = new InMemoryKernelStore();
  const limits = { currency: "CNY", maxTokens: 1000, maxCostMinorUnits: "100" };
  await store.transact("tenant", tx => {
    tx.putProjection("execution", "run", { id: "run", workspaceId: "workspace", authorityId: "authority" });
    tx.putProjection("authority", "authority", { budget: limits });
    tx.appendEvent({ tenantId: "tenant", aggregateType: "execution", aggregateId: "run", executionId: "run",
      type: "execution.paused", expectedStreamVersion: 0, generation: 1, actorId: "owner", correlationId: "run",
      publicPayload: { workspaceId: "workspace" } });
  });
  const runtime = new KernelProjectionRuntimeStore({ tenantId: "tenant", store });
  const budget = new PersistentModelBudget({ executionId: "run", store: runtime, limits });
  const quote = { requestDigest: "a".repeat(64), inputTokenLimit: 100, maxOutputTokens: 100,
    rates: { id: "fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "100000000",
      cachedInputNanoMinorUnitsPerToken: "10000000", outputNanoMinorUnitsPerToken: "100000000" } };
  await budget.reserve({ id: "settled", ...quote });
  await budget.settle("settled", { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 });
  await budget.reserve({ id: "unknown", ...quote });
  assert.equal((await workspaceActivity(store, "tenant", "workspace"))[0]!.cost, "预估 CNY 0.02，另有待核对用量");
});

test("活动页显示最新一千项，隔离工作区且不受 SSE 保留期影响，不把未知费用显示为零", async () => {
  const store = new InMemoryKernelStore();
  await store.transact("tenant", tx => {
    for (let index = 0; index < 1100; index++) tx.appendEvent({ tenantId: "tenant", aggregateType: "execution", aggregateId: `run-${index}`,
      executionId: `run-${index}`, type: "execution.completed", expectedStreamVersion: 0, generation: 1, actorId: "owner",
      correlationId: `run-${index}`, publicPayload: { workspaceId: "workspace" } });
    tx.appendEvent({ tenantId: "tenant", aggregateType: "workspace", aggregateId: "foreign", type: "workspace.created",
      expectedStreamVersion: 0, generation: 0, actorId: "owner", correlationId: "foreign", publicPayload: { workspaceId: "foreign" } });
  });
  const all = await store.readEventHistory("tenant", 0, 1200);
  store.readEventHistory = store.readEvents.bind(store);
  store.readEvents = async () => { throw new Error("EVENT_CURSOR_EXPIRED"); };
  const activity = await workspaceActivity(store, "tenant", "workspace");
  assert.equal(activity.length, 1000);
  assert.equal(activity[0]!.id, all.events[1099]!.id);
  assert.equal(activity.at(-1)!.id, all.events[100]!.id);
  assert.equal(activity.some(item => item.cost === "未产生模型费用"), false);
  assert.equal(JSON.stringify(activity).includes(all.events[1100]!.id), false);
});
