// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeBusinessOperationKey, type Approval, type EffectReceiptV1, type IssueQuotePackageInputV1 } from "@mn/contracts";
import { AgentOsKernel, BusinessActionLedger, BUSINESS_ACTION_JOB_KIND } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { AgentOsWorker, createBusinessActionWorkerHandler, type BusinessProviderPorts } from "../src/index.js";

const timestamp = "2026-09-18T08:00:00.000Z";
const scope = { tenantId: "local", workspaceId: "workspace", principalId: "owner", customerId: "customer" };
function action(): IssueQuotePackageInputV1 {
  const draft = { schemaVersion: "1" as const, action: "issueQuotePackage" as const, actionId: "action", operationKey: "pending", scope,
    quote: { id: "quote", version: "1", digest: "a".repeat(64) }, businessDecision: { id: "decision", digest: "b".repeat(64) },
    template: { id: "standard", version: "1", digest: "c".repeat(64) }, renderVersion: "1", exportFormat: "pdf" as const, issueDate: "2026-09-18" };
  return { ...draft, operationKey: computeBusinessOperationKey(draft) };
}

for (const scenario of ["completed", "unknown", "abandoned", "revoked", "revoked_before", "version_changed", "expired"] as const) {
  test(`正式出包使用既有工具审批并处理 ${scenario}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "muniu-business-"));
    const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite"), hmacKey: Buffer.alloc(32, 1), now: () => new Date(timestamp) });
    store.configureProjectionJournal({ cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 2)), namespaces: ["*non-core"] });
    t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
    await store.transact("local", tx => tx.putProjection("membership", "workspace:owner", {
      id: "workspace:owner", tenantId: "local", workspaceId: "workspace", principalId: "owner", workspaceRole: "owner",
      organizationRoles: [], streamVersion: 1, createdAt: timestamp, updatedAt: timestamp,
    }));
    const ledger = new BusinessActionLedger(store, { now: () => timestamp });
    const kernel = new AgentOsKernel(store, { now: () => timestamp });
    const input = action();
    const created = await ledger.create(input, "create");
    let dispatches = 0;
    let authorityReads = 0;
    const receipt: EffectReceiptV1 = { schemaVersion: "1", actionId: input.actionId, operationKey: input.operationKey,
      status: "completed", packageId: "package", files: [{ name: "quote.pdf", mediaType: "application/pdf", sha256: "d".repeat(64), protectedContentRef: "sales://local/quote/package/file" }], observedAt: timestamp };
    const ports: BusinessProviderPorts = {
      snapshots: { async read() { authorityReads++; return { schemaVersion: "1", providerId: "sales", objectType: "quote", objectId: "quote", version: "1",
        digest: scenario === "version_changed" && authorityReads > 1 ? "e".repeat(64) : input.quote.digest,
        protectedContentRef: "sales://local/quote/quote/snapshot", scope, observedAt: timestamp, template: input.template, sourceRefs: [] }; } },
      decisions: { async read() { return { schemaVersion: "1", id: "decision", scope, snapshotDigest: input.quote.digest, snapshotVersion: "1", actorId: "owner",
        policyVersion: "1", approvedAt: timestamp, expiresAt: scenario === "expired" && authorityReads > 1 ? timestamp : "2026-09-19T08:00:00.000Z", status: "approved", digest: input.businessDecision.digest }; } },
      actions: { async admit(request) { dispatches++; assert.equal(request.identity.jobId, created.jobId); assert.ok(request.identity.fencingToken > 0);
        return { schemaVersion: "1", actionId: input.actionId, operationKey: input.operationKey, admissionId: "admission", status: "admitted" }; },
        async execute() { if (scenario === "unknown" || scenario === "abandoned") throw new Error("network timeout with secret"); return receipt; } },
      receipts: { async lookup() { return receipt; }, async reconcile() { return receipt; } },
    };
    const worker = new AgentOsWorker({ id: "worker", store, now: () => new Date(timestamp),
      lock: { engineLockDigest: "lock", expectedEngineLockDigest: "lock", pluginLockDigest: "lock", expectedPluginLockDigest: "lock" },
      handlers: { [BUSINESS_ACTION_JOB_KIND]: createBusinessActionWorkerHandler({ store, kernel, ports, now: () => timestamp, pollIntervalMs: 2 }) } });
    if (scenario === "revoked_before") await store.transact("local", tx => tx.deleteProjection("membership", "workspace:owner"));
    const running = worker.pollOnce();
    if (scenario === "revoked_before") {
      await running;
      assert.equal((await ledger.get("local", created.id))?.status, "rejected");
      assert.equal(dispatches, 0);
      return;
    }
    let pending: Approval | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      pending = await store.transact("local", tx => tx.listProjections<Approval>("approval")[0]);
      if (!pending) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(pending, `出包必须先等待批准：${JSON.stringify(await store.getJob(created.jobId))}`);
    assert.equal(dispatches, 0);
    if (scenario === "revoked") await store.transact("local", tx => tx.deleteProjection("membership", "workspace:owner"));
    await kernel.decideApproval("local", "owner", "approve", pending.id, pending.streamVersion, "approve_once");
    const result = await running;
    const final = (await ledger.get("local", created.id))!;
    assert.equal(final.status, scenario === "completed" ? "completed" : ["unknown", "abandoned"].includes(scenario) ? "needs_reconciliation" : "rejected");
    assert.equal(dispatches, ["completed", "unknown", "abandoned"].includes(scenario) ? 1 : 0);
    if (scenario === "unknown" || scenario === "abandoned") {
      assert.equal(result.status, "needs_reconciliation");
      assert.equal((await worker.pollOnce()).status, "idle");
      assert.equal(dispatches, 1);
      await assert.rejects(ledger.reconcile("local", created.id, final.streamVersion, "terminate"), { code: "BUSINESS_ABANDONMENT_REQUIRED" });
      const member = await store.transact("local", tx => tx.getProjection("membership", "workspace:owner"));
      await store.transact("local", tx => tx.deleteProjection("membership", "workspace:owner"));
      await assert.rejects(ledger.reconcile("local", created.id, final.streamVersion, "mark_completed", receipt,
        { actorId: "owner", idempotencyKey: "revoked-reconcile" }), { code: "BUSINESS_SCOPE_REVOKED" });
      await store.transact("local", tx => tx.putProjection("membership", "workspace:owner", member));
      const changed = { ...input, actionId: "another-action", issueDate: "2026-09-19" };
      await assert.rejects(ledger.create({ ...changed, operationKey: computeBusinessOperationKey(changed) }, "new-key"), { code: "BUSINESS_RECONCILIATION_REQUIRED" });
      const recovered = scenario === "unknown"
        ? await ledger.reconcile("local", created.id, final.streamVersion, "mark_completed", receipt)
        : await ledger.reconcile("local", created.id, final.streamVersion, "terminate", { ...receipt, status: "rejected", reasonCode: "ABANDONED", files: [] });
      assert.equal(recovered.status, scenario === "unknown" ? "completed" : "terminated");
    }
  });
}

test("出包检查点后重启只进入人工核对，旧Worker不能继续执行或提交", async t => {
  const root = await mkdtemp(join(tmpdir(), "muniu-business-restart-"));
  let clock = timestamp;
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite"), hmacKey: Buffer.alloc(32, 1), now: () => new Date(clock) });
  store.configureProjectionJournal({ cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 2)), namespaces: ["*non-core"] });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await store.transact("local", tx => tx.putProjection("membership", "workspace:owner", {
    id: "workspace:owner", tenantId: "local", workspaceId: "workspace", principalId: "owner", workspaceRole: "owner",
    organizationRoles: [], streamVersion: 1, createdAt: timestamp, updatedAt: timestamp,
  }));
  const ledger = new BusinessActionLedger(store, { now: () => clock });
  const kernel = new AgentOsKernel(store, { now: () => clock });
  const created = await ledger.create(action(), "create");
  const job = (await store.claimJob("old-worker", clock, { kinds: [BUSINESS_ACTION_JOB_KIND] }))!;
  const lease = { jobId: job.id, workerId: "old-worker", fencingToken: job.fencingToken, occurredAt: clock };
  await ledger.start("local", created.id, lease);
  const intent = await ledger.intent("local", created.id);
  const requested = await kernel.requestToolApproval("local", "owner", "approval", intent);
  assert.equal(requested.mode, "approval");
  if (requested.mode !== "approval") throw new Error("approval missing");
  await ledger.waiting("local", created.id, requested.approval.id, lease);
  await kernel.decideApproval("local", "owner", "approve", requested.approval.id, 1, "approve_once");
  await ledger.dispatch("local", created.id, intent, lease);
  const oldIdentity = { executionId: created.executionId, generation: 1, jobId: job.id, workerId: "old-worker", fencingToken: job.fencingToken };
  assert.equal((await ledger.authorizeExternal("local", created.id, oldIdentity)).allowed, true);
  clock = "2026-09-18T08:00:31.000Z";
  let externalCalls = 0;
  const forbidden = async (): Promise<never> => { externalCalls++; throw new Error("禁止重发未知操作"); };
  const ports: BusinessProviderPorts = { snapshots: { read: forbidden }, decisions: { read: forbidden },
    actions: { admit: forbidden, execute: forbidden }, receipts: { lookup: forbidden, reconcile: forbidden } };
  const restarted = new AgentOsWorker({ id: "new-worker", store, now: () => new Date(clock),
    lock: { engineLockDigest: "lock", expectedEngineLockDigest: "lock", pluginLockDigest: "lock", expectedPluginLockDigest: "lock" },
    handlers: { [BUSINESS_ACTION_JOB_KIND]: createBusinessActionWorkerHandler({ store, kernel, ports, now: () => clock }) } });
  assert.equal((await restarted.pollOnce()).status, "needs_reconciliation");
  assert.equal(externalCalls, 0);
  await assert.rejects(ledger.authorizeExternal("local", created.id, oldIdentity), { code: "STALE_FENCING_TOKEN" });
  await assert.rejects(ledger.record("local", created.id, { status: "completed" }, { ...lease, occurredAt: clock }), { code: "STALE_FENCING_TOKEN" });
  assert.equal((await ledger.get("local", created.id))?.status, "needs_reconciliation");
});
