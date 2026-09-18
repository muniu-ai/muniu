// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "../src/store.js";
import { BusinessCandidateLedger } from "../src/business-candidates.js";

test("询价候选入队固定无工具权限，明文原文不进入执行和任务投影", async () => {
  const store = new InMemoryKernelStore();
  const now = "2026-09-18T01:00:00.000Z";
  await store.transact("tenant-a", tx => tx.putProjection("membership", "workspace-a:person-a", {
    workspaceId: "workspace-a", principalId: "person-a", workspaceRole: "owner" }));
  const ledger = new BusinessCandidateLedger(store, { now: () => now });
  const input = { id: "candidate-a", scope: { tenantId: "tenant-a", workspaceId: "workspace-a", principalId: "person-a", customerId: "customer-a" },
    inquiryId: "rfq-a", inquiryRevision: "1", sourceDigest: "a".repeat(64), sourceProtectedPayloadRef: "protected-source",
    sourceKeyRecord: { id: "protected-source" }, modelConnectionId: "model-a", modelConnectionVersion: 1,
    budget: { maxTokens: 1000, maxCostMinorUnits: "100", currency: "CNY", maxDurationMs: 60000, maxSubagents: 0, maxSubagentDepth: 0 } };
  const first = await ledger.create(input, "key-a");
  assert.deepEqual(await ledger.create({ ...input, id: "candidate-b" }, "key-a"), first);
  await assert.rejects(ledger.create({ ...input, inquiryRevision: "2" }, "key-a"), /幂等/u);
  const projections = await store.transact("tenant-a", tx => ({ execution: tx.getProjection<any>("execution", first.executionId),
    authorities: tx.listProjections<any>("authority"), jobs: tx.listProjections<any>("job") }));
  assert.equal(projections.execution.agentDefinitionId, "industry.rfq-candidate");
  assert.deepEqual(projections.authorities[0].toolIds, []);
  assert.equal(projections.authorities[0].budget.maxSubagents, 0);
  assert.deepEqual(Object.keys(projections.jobs[0].payload).sort(), ["candidateId", "executionId"]);
  assert.equal(await ledger.get("other-tenant", first.id), undefined);
  await store.transact("tenant-a", tx => {
    tx.putProjection("execution", first.executionId, { ...projections.execution, status: "running" });
    const original = projections.authorities[0];
    for (const patch of [{ dataScopes: [] }, { autoAllowedEffects: ["external_write"] }, { workspaceId: "other" }, { commitment: "f".repeat(64) }]) {
      tx.putProjection("authority", original.id, { ...original, ...patch });
      assert.throws(() => ledger.assertActive(tx, first), /权限已变化/u);
    }
    tx.putProjection("authority", original.id, original);
    assert.doesNotThrow(() => ledger.assertActive(tx, first));
  });
});
