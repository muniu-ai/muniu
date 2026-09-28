// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistentModelBudget } from "@mn/agent-runtime";
import { computeInquirySnapshotDigest, type BusinessInquirySourcePortV1, type JsonObject, type SalesInquirySnapshotV1 } from "@mn/contracts";
import { BusinessCandidateLedger } from "@mn/business-execution";
import { FileCas, InMemoryKeyProvider, SqliteStorage, storeProtectedJson } from "@mn/storage";
import { AgentOsWorker } from "../src/index.js";
import { createProtectedRuntimeStore, readProtectedRuntimePayload } from "../src/runtime-store.js";
import { createBusinessCandidateWorkerHandler } from "../src/business-candidates.js";

for (const scenario of ["completed", "missing_usage", "bad_citation", "tool_call", "missing_secret", "revoked_before_start", "pending_model", "revoked_during_model",
  "sales_revoked_before_start", "source_revision_changed", "source_digest_changed", "source_scope_changed", "missing_source_port",
  "sales_revoked_during_model", "source_changed_during_model", "sales_revoked_before_response_recovery"] as const) {
  test(`固定询价模型流程：${scenario}，测试模型标记且结果只进入受保护存储`, async t => {
    const root = await mkdtemp(join(tmpdir(), "muniu-candidate-"));
    const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite3"), hmacKey: Buffer.alloc(32, 1) });
    t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
    const now = "2026-09-18T01:00:00.000Z";
    const scope = { tenantId: "local", workspaceId: "workspace", principalId: "local-owner", customerId: "customer" };
    const protection = { cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 3)) };
    const text = "秘密询价原文：材料316L。";
    const textDigest = createHash("sha256").update(text).digest("hex");
    const raw = { schemaVersion: "1" as const, scope, inquiryId: "rfq", inquiryRevision: "1",
      sourceRefs: [{ namespace: "sales.source", resourceId: "source", digest: textDigest, protectedContentRef: "sales://local/source/source/1" }],
      pages: [{ sourceId: "source", pageNumber: 1, text, digest: textDigest }], completeness: { status: "complete" as const, missing: [] }, requirements: [] };
    const source: SalesInquirySnapshotV1 = { ...raw, digest: computeInquirySnapshotDigest(raw) };
    const protectedSource = await storeProtectedJson({ ...protection, tenantId: "local", workspaceId: "workspace", ownerType: "business-candidate-source",
      ownerId: "candidate", protectedPayloadRef: "candidate-source", value: source as unknown as JsonObject, createdAt: now });
    await store.transact("local", tx => {
      tx.putProjection("membership", "workspace:local-owner", { workspaceId: "workspace", principalId: "local-owner", workspaceRole: "owner" });
      tx.putProjection("modelConnection", "model", { id: "model", tenantId: "local", presetId: "deepseek", defaultModel: "test-fixture",
        status: "ready", streamVersion: 1, secretRef: "keychain://muniu.v2/test" });
    });
    const ledger = new BusinessCandidateLedger(store, { now: () => now });
    const candidate = await ledger.create({ id: "candidate", scope, inquiryId: "rfq", inquiryRevision: "1", sourceDigest: source.digest,
      sourceProtectedPayloadRef: protectedSource.protectedPayloadRef, sourceKeyRecord: protectedSource.keyRecord as unknown as JsonObject,
      modelConnectionId: "model", modelConnectionVersion: 1,
      budget: { maxTokens: 10000, maxCostMinorUnits: "100", currency: "CNY", maxDurationMs: 60000, maxSubagents: 0, maxSubagentDepth: 0 } }, "create");
    const runtime = createProtectedRuntimeStore({ ...protection, tenantId: "local", workspaceId: "workspace", store });
    if (scenario === "revoked_before_start") await store.transact("local", tx => tx.putProjection("membership", "workspace:local-owner", {
      workspaceId: "workspace", principalId: "local-owner", workspaceRole: "viewer" }));
    if (scenario === "pending_model") await new PersistentModelBudget({ store: runtime, executionId: candidate.executionId, limits: candidate.budget }).reserve({
      id: "persisted-before-crash", requestDigest: "a".repeat(64), inputTokenLimit: 100, maxOutputTokens: 100,
      rates: { id: "non-billable-fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0", cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } });
    if (scenario === "sales_revoked_before_response_recovery") await runtime.append({ executionId: candidate.executionId,
      type: "model/response", payload: { response: { text: JSON.stringify({ requirements: [], facts: [], suggestions: [], unknown: [], conflicts: [] }), toolCalls: [] } } });
    let calls = 0; let sourceReads = 0; let quoteCalls = 0;
    let salesAllowed = !["sales_revoked_before_start", "sales_revoked_before_response_recovery"].includes(scenario);
    let sourceChanged = scenario === "source_revision_changed";
    const sourcePort: BusinessInquirySourcePortV1 = { async read(input) {
      sourceReads++;
      assert.deepEqual(input, { schemaVersion: "1", scope, objectId: "rfq", revision: "1" });
      if (!salesAllowed) throw new Error("SALES_PRIVATE_PERMISSION_DETAILS");
      const current = { ...raw, ...(sourceChanged ? { inquiryRevision: "2" } : {}),
        ...(scenario === "source_digest_changed" ? { requirements: ["新要求"] } : {}),
        ...(scenario === "source_scope_changed" ? { scope: { ...scope, principalId: "new-owner" } } : {}) };
      return { ...current, digest: computeInquirySnapshotDigest(current) };
    } };
    const handler = createBusinessCandidateWorkerHandler({ store, runtimeProtection: protection, now: () => now, modelMode: "test_fixture",
      ...{ sourcePort: scenario === "missing_source_port" ? undefined as unknown as BusinessInquirySourcePortV1 : sourcePort },
      secretStore: { read: async () => { if (scenario === "missing_secret") throw new Error("SECRET_KEY_FAILURE"); return "fixture-key"; } },
      modelQuoter: async () => { quoteCalls++; return { inputTokenLimit: 100, maxOutputTokens: 100, rates: { id: "non-billable-fixture", currency: "CNY",
        inputNanoMinorUnitsPerToken: "0", cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }; },
      modelInvoker: async invocation => {
        calls++;
        assert.deepEqual(invocation.request.availableToolIds, []);
        const records = await runtime.readExecution(candidate.executionId);
        assert.equal(records.filter(record => record.type === "model/request").length, 1);
        assert.equal(records.filter(record => record.type === "model/reserved").length, 1);
        if (scenario === "revoked_during_model") await store.transact("local", tx => tx.putProjection("membership", "workspace:local-owner", {
          workspaceId: "workspace", principalId: "local-owner", workspaceRole: "viewer" }));
        if (scenario === "sales_revoked_during_model") salesAllowed = false;
        if (scenario === "source_changed_during_model") sourceChanged = true;
        return { text: JSON.stringify({ requirements: [{ text: "材料316L", citations: [{ sourceId: "source", pageNumber: 1,
          start: 0, end: Array.from(text).length, quote: scenario === "bad_citation" ? "伪造引文" : text }] }], facts: [], suggestions: [], unknown: [], conflicts: [] }),
          toolCalls: scenario === "tool_call" ? [{ id: "attack", toolId: "approve", arguments: {} }] : [],
          ...(scenario === "missing_usage" ? {} : { usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } }) };
      } });
    const worker = new AgentOsWorker({ id: "worker", store, now: () => new Date(now),
      lock: { engineLockDigest: "lock", expectedEngineLockDigest: "lock", pluginLockDigest: "lock", expectedPluginLockDigest: "lock" },
      handlers: { "business.candidate.extract": handler } });
    await worker.pollOnce();
    const state = (await ledger.get("local", "candidate"))!;
    const expectedCalls = ["missing_secret", "revoked_before_start", "pending_model", "sales_revoked_before_start", "source_revision_changed",
      "source_digest_changed", "source_scope_changed", "missing_source_port", "sales_revoked_before_response_recovery"].includes(scenario) ? 0 : 1;
    assert.equal(state.status, scenario === "completed" ? "completed" : ["missing_usage", "pending_model", "revoked_during_model"].includes(scenario) ? "needs_reconciliation" : "failed");
    assert.equal(calls, expectedCalls);
    assert.doesNotMatch(JSON.stringify(state), /秘密询价原文|fixture-key|SECRET_KEY_FAILURE|SALES_PRIVATE_PERMISSION_DETAILS/u);
    const events = await store.readEvents("local", 0, 500);
    assert.doesNotMatch(JSON.stringify(events), /秘密询价原文|fixture-key|SECRET_KEY_FAILURE|SALES_PRIVATE_PERMISSION_DETAILS/u);
    if (["sales_revoked_before_start", "source_revision_changed", "source_digest_changed", "source_scope_changed", "missing_source_port"].includes(scenario)) {
      assert.equal(quoteCalls, 0, "预算预检也可能发送原文，必须在业务授权之后");
      assert.equal((await runtime.readExecution(candidate.executionId)).filter(record => ["model/request", "model/reserved"].includes(record.type)).length, 0);
    }
    if (["sales_revoked_during_model", "source_changed_during_model"].includes(scenario)) {
      assert.ok(sourceReads >= 2);
      assert.equal((await runtime.readExecution(candidate.executionId)).filter(record => record.type === "model/settled").length, 1,
        "已知模型费用保留结算，业务撤权不能改记结果未知");
    }
    if (scenario === "completed") {
      const artifact = await readProtectedRuntimePayload({ ...protection, store, tenantId: "local", workspaceId: "workspace",
        ownerType: "business-candidate", ownerId: "candidate", protectedPayloadRef: state.candidateProtectedPayloadRef! });
      assert.equal((artifact.modelProvenance as JsonObject).mode, "test_fixture");
      assert.equal(state.counts?.requirements, 1);
    } else assert.equal(state.candidateProtectedPayloadRef, undefined);
    await worker.pollOnce();
    assert.equal(calls, expectedCalls, "未知模型结果不得重放");
  });
}
