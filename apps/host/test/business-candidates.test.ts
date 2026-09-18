// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeInquirySnapshotDigest } from "@mn/contracts";
import { BusinessCandidateLedger, InMemoryKernelStore } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { AgentOsWorker, createBusinessCandidateWorkerHandler, type BusinessProviderPorts } from "@mn/worker";
import { businessCandidateContentResponse, createBusinessCandidate, publicBusinessCandidate } from "../src/business-candidates.js";
import { createAgentOsHost } from "../src/index.js";

test("候选服务读取要求专用 Bearer 身份、精确客户范围和当前成员权限", async t => {
  const root = await mkdtemp(join(tmpdir(), "muniu-candidate-host-"));
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite3"), hmacKey: Buffer.alloc(32, 1) });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const now = "2026-09-18T01:00:00.000Z";
  const protection = { cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 3)) };
  const scope = { tenantId: "local", workspaceId: "workspace", principalId: "local-owner", customerId: "customer" };
  const base = { ...protection, store, now: () => now, tokenResolver: async () => "service-secret", allowedScopes: [{ tenantId: "local", workspaceId: "workspace" }] };
  const query = new URLSearchParams(scope);
  const request = (authorization: string, parameters = query) => new Request(`http://localhost/v2/business-candidates/id/content?${parameters}`, { headers: { authorization } });
  await assert.rejects(businessCandidateContentResponse(request("service-secret"), "missing", base), (error: any) => error.code === "AUTHENTICATION_REQUIRED");
  await assert.rejects(businessCandidateContentResponse(request("Bearer wrong"), "missing", base), (error: any) => error.code === "AUTHENTICATION_REQUIRED");
  const body = { expectedStreamVersion: 0 as const, workspaceId: "workspace", customerId: "customer", inquiryId: "rfq", inquiryRevision: "1" };
  const text = "工件材料为316L。";
  const digest = createHash("sha256").update(text).digest("hex");
  const raw = { schemaVersion: "1" as const, scope, inquiryId: "rfq", inquiryRevision: "1", requirements: [],
    sourceRefs: [{ namespace: "sales.source", resourceId: "source", digest, protectedContentRef: "sales://local/source/source/1" }],
    pages: [{ sourceId: "source", pageNumber: 1, text, digest }], completeness: { status: "complete" as const, missing: [] } };
  const sourcePort = { read: async () => ({ ...raw, digest: computeInquirySnapshotDigest(raw) }) };
  await store.transact("local", tx => tx.putProjection("membership", "workspace:local-owner", { workspaceId: "workspace", principalId: "local-owner", workspaceRole: "owner" }));
  await assert.rejects(createBusinessCandidate(body, scope, "create", { ...base, sourcePort }), (error: any) => error.code === "MODEL_CONNECTION_REQUIRED");
  await store.transact("local", tx => tx.putProjection("modelConnection", "model", { id: "model", tenantId: "local", presetId: "deepseek",
    defaultModel: "deepseek-v4-flash", status: "ready", streamVersion: 1, secretRef: "keychain://muniu.v2/test" }));
  const state = await createBusinessCandidate(body, scope, "create", { ...base, sourcePort });
  assert.equal(publicBusinessCandidate(state).status, "queued");
  assert.equal("sourceProtectedPayloadRef" in publicBusinessCandidate(state), false);
  const worker = new AgentOsWorker({ id: "worker", store, now: () => new Date(now), lock: {
    engineLockDigest: "lock", expectedEngineLockDigest: "lock", pluginLockDigest: "lock", expectedPluginLockDigest: "lock" }, handlers: {
    "business.candidate.extract": createBusinessCandidateWorkerHandler({ store, sourcePort, runtimeProtection: protection, now: () => now, modelMode: "test_fixture",
      secretStore: { read: async () => "fixture" }, modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100,
        rates: { id: "non-billable-fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0", cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }),
      modelInvoker: async () => ({ text: JSON.stringify({ requirements: [{ text: "材料316L", citations: [{ sourceId: "source", pageNumber: 1, start: 0,
        end: Array.from(text).length, quote: text }] }], facts: [], suggestions: [], unknown: [], conflicts: [] }),
        toolCalls: [], usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }) }),
  } });
  await worker.pollOnce();
  const content = await businessCandidateContentResponse(request("Bearer service-secret"), state.id, base);
  assert.equal(content.candidate.requirements.length, 1);
  assert.equal(content.candidate.modelProvenance.mode, "test_fixture");
  assert.equal(content.digest, (await new BusinessCandidateLedger(store).get("local", state.id))!.candidateDigest);
  await assert.rejects(businessCandidateContentResponse(request("Bearer service-secret", new URLSearchParams({ ...scope, customerId: "other" })), state.id, base),
    (error: any) => error.code === "BUSINESS_CANDIDATE_NOT_FOUND");
  await store.transact("local", tx => tx.putProjection("membership", "workspace:local-owner", { workspaceId: "workspace", principalId: "local-owner", workspaceRole: "viewer" }));
  await assert.rejects(businessCandidateContentResponse(request("Bearer service-secret"), state.id, base), (error: any) => error.code === "BUSINESS_CANDIDATE_FORBIDDEN");
});

test("真实 Host 候选接口要求显式启用、当前权限和服务身份，公开响应不包含原文或保护引用", async t => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-candidate-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new InMemoryKernelStore();
  const enabled: { tenantId: string; workspaceId: string }[] = [];
  let sourceReads = 0;
  const now = "2026-09-18T01:00:00.000Z";
  const ports: BusinessProviderPorts = {
    snapshots: { async read() { throw new Error("不应读取报价"); } },
    decisions: { async read() { throw new Error("不应生成业务核准"); } },
    actions: { async admit() { throw new Error("不应受理业务副作用"); }, async execute() { throw new Error("不应执行业务副作用"); } },
    receipts: { async lookup() { return undefined; }, async reconcile() { return undefined; } },
    inquiries: { async read(input) {
      sourceReads++;
      const text = "受保护的工业询价原文：材料316L。";
      const digest = createHash("sha256").update(text).digest("hex");
      const raw = { schemaVersion: "1" as const, scope: input.scope, inquiryId: input.objectId, inquiryRevision: input.revision,
        sourceRefs: [{ namespace: "sales.source", resourceId: "source", digest, protectedContentRef: "sales://local/source/source/1" }],
        pages: [{ sourceId: "source", pageNumber: 1, text, digest }], completeness: { status: "complete" as const, missing: [] }, requirements: [] };
      return { ...raw, digest: computeInquirySnapshotDigest(raw) };
    } },
  };
  const host = await createAgentOsHost({ store, now: () => now, businessProvider: ports, businessWorkspaceScopes: enabled,
    secretStore: { async save() { return "keychain://muniu.v2/test"; }, async read() { return "fixture"; } },
    cas: new FileCas({ rootDir: join(directory, "cas") }), protectedPayloadKeyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 4)),
    businessAuthorityTokenResolver: async () => "service-secret" });
  t.after(() => host.close());
  const post = (path: string, body: unknown, key?: string) => host.dispatch(new Request(`http://host.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) }));
  const workspace = (await (await post("/v2/workspaces", { name: "工业询价", viewMode: "business", pluginIds: [] }, "workspace")).json() as any).data;
  const body = { expectedStreamVersion: 0, workspaceId: workspace.id, customerId: "customer", inquiryId: "rfq", inquiryRevision: "1" };
  assert.equal((await (await post("/v2/business-candidates", body, "disabled")).json() as any).code, "BUSINESS_PROVIDER_DISABLED");
  assert.equal(sourceReads, 0);
  enabled.push({ tenantId: "local", workspaceId: workspace.id });
  assert.equal((await (await post("/v2/business-candidates", body, "no-model")).json() as any).code, "MODEL_CONNECTION_REQUIRED");
  assert.equal(sourceReads, 0);
  await store.transact("local", tx => tx.putProjection("modelConnection", "model", { id: "model", tenantId: "local", presetId: "deepseek",
    defaultModel: "deepseek-v4-flash", status: "ready", streamVersion: 1, secretRef: "keychain://muniu.v2/test" }));
  assert.notEqual((await post("/v2/business-candidates", body)).status, 201);
  assert.notEqual((await post("/v2/business-candidates", { ...body, modelId: "model-controlled" }, "forged")).status, 201);
  const response = await post("/v2/business-candidates", body, "create");
  const payload = await response.json() as any;
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.data.status, "queued");
  assert.equal(payload.data.scope.principalId, "local-owner");
  assert.doesNotMatch(JSON.stringify(payload), /受保护的工业询价原文|ProtectedPayloadRef|secretRef|keychain|modelConnection/u);
  const read = await host.dispatch(new Request(`http://host.test/v2/business-candidates/${payload.data.id}`));
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json() as any).data, payload.data);
  const params = new URLSearchParams(payload.data.scope);
  const contentUrl = `http://host.test/v2/business-candidates/${payload.data.id}/content?${params}`;
  const unauthenticatedHeaders: HeadersInit[] = [{}, { authorization: "service-secret" }, { authorization: "Bearer wrong" }];
  for (const headers of unauthenticatedHeaders) {
    const denied = await host.dispatch(new Request(contentUrl, { headers }));
    assert.equal((await denied.json() as any).code, "AUTHENTICATION_REQUIRED");
  }
  const pending = await host.dispatch(new Request(contentUrl, { headers: { authorization: "Bearer service-secret" } }));
  assert.equal((await pending.json() as any).code, "BUSINESS_CANDIDATE_NOT_READY");
  await store.transact("local", tx => tx.putProjection("membership", `${workspace.id}:local-owner`, {
    workspaceId: workspace.id, principalId: "local-owner", workspaceRole: "viewer" }));
  assert.notEqual((await post("/v2/business-candidates", body, "viewer")).status, 201);
  const forbidden = await host.dispatch(new Request(contentUrl, { headers: { authorization: "Bearer service-secret" } }));
  assert.equal((await forbidden.json() as any).code, "BUSINESS_CANDIDATE_FORBIDDEN");
  enabled.splice(0);
  const disabled = await host.dispatch(new Request(`http://host.test/v2/business-candidates/${payload.data.id}`));
  assert.equal((await disabled.json() as any).code, "BUSINESS_PROVIDER_DISABLED");
});

test("真实 Host 未配置业务资料端口或保护存储时不能创建询价候选", async t => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(),
    secretStore: { async save() { return "keychain://muniu.v2/test"; }, async read() { return "fixture"; } } });
  t.after(() => host.close());
  const response = await host.dispatch(new Request("http://host.test/v2/business-candidates", { method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "disabled" },
    body: JSON.stringify({ expectedStreamVersion: 0, workspaceId: "workspace", customerId: "customer", inquiryId: "rfq", inquiryRevision: "1" }) }));
  assert.equal((await response.json() as any).code, "BUSINESS_PROVIDER_DISABLED");
});
