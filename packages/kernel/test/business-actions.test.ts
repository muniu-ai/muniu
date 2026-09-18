// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { computeBusinessOperationKey } from "@mn/contracts";
import { BusinessActionLedger, InMemoryKernelStore } from "../src/index.js";

const now = "2026-09-18T08:00:00.000Z";
const draft = {
  schemaVersion: "1" as const, action: "issueQuotePackage" as const,
  actionId: "action-a", operationKey: "operation-a",
  scope: { tenantId: "tenant-a", workspaceId: "workspace-a", principalId: "owner", customerId: "customer-a" },
  quote: { id: "quote-a", version: "1", digest: "a".repeat(64) },
  businessDecision: { id: "decision-a", digest: "b".repeat(64) },
  template: { id: "standard", version: "1", digest: "c".repeat(64) },
  renderVersion: "1", exportFormat: "pdf" as const, issueDate: "2026-09-18",
};
const action = { ...draft, operationKey: computeBusinessOperationKey(draft) };

test("同一出包操作只建立一个执行和任务，幂等键不能替换业务参数", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const ledger = new BusinessActionLedger(store, { now: () => now });
  await store.transact("tenant-a", tx => tx.putProjection("membership", "workspace-a:owner", { workspaceRole: "owner" }));
  const first = await ledger.create(action, "request-a");
  const replay = await ledger.create(action, "request-a");
  assert.deepEqual(replay, first);
  assert.equal(first.status, "queued");
  await assert.rejects(ledger.create({ ...action, quote: { ...action.quote, version: "2" } }, "request-a"));
  const duplicate = await ledger.create({ ...action, actionId: "action-b" }, "request-b");
  assert.equal(duplicate.id, first.id);
  assert.equal((await store.transact("tenant-a", tx => tx.listProjections("execution"))).length, 1);
  assert.equal(await ledger.get("tenant-b", first.id), undefined);
  const events = await store.readEvents("tenant-a", 0, 100);
  assert.ok(!JSON.stringify(events).includes("decision-a"));
  await ledger.record("tenant-a", first.id, { status: "rejected" });
  assert.equal((await ledger.create(action, "request-a")).status, "rejected");
});

test("业务创建在事务中拒绝已撤销的当前成员权限", async () => {
  const ledger = new BusinessActionLedger(new InMemoryKernelStore(undefined, () => now), { now: () => now });
  await assert.rejects(ledger.create(action, "revoked"), { code: "BUSINESS_SCOPE_REVOKED" });
});

test("稳定操作号不能静默复用另一个业务批准或操作者的执行审批", async () => {
  const store = new InMemoryKernelStore(undefined, () => now);
  const ledger = new BusinessActionLedger(store, { now: () => now });
  await store.transact("tenant-a", tx => {
    tx.putProjection("membership", "workspace-a:owner", {workspaceRole:"owner"});
    tx.putProjection("membership", "workspace-a:other", {workspaceRole:"owner"});
  });
  await ledger.create(action, "first");
  await assert.rejects(ledger.create({...action, actionId:"other-decision", businessDecision:{id:"decision-b",digest:"d".repeat(64)}},"changed-decision"), {code:"BUSINESS_ACTION_CONFLICT"});
  await assert.rejects(ledger.create({...action, actionId:"other-principal", scope:{...action.scope,principalId:"other"}},"changed-principal"), {code:"BUSINESS_ACTION_CONFLICT"});
});
