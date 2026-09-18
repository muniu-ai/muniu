// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeyProvider } from "@mn/storage";
import { InMemoryKernelStore } from "@mn/kernel";
import type { EffectReceiptV1 } from "@mn/contracts";
import type { BusinessProviderPorts } from "@mn/worker";
import { createAgentOsHost, startLocalAgentOsHost, type AgentOsHost } from "../src/index.js";

function fixturePorts(timestamp = "2026-09-18T08:00:00.000Z"): BusinessProviderPorts {
  return {
    snapshots: { async read(input) { return { schemaVersion: "1", providerId: "sales", objectType: "quote", objectId: input.objectId, version: input.version,
      digest: "a".repeat(64), protectedContentRef: "sales://local/quote/q/snapshot", scope: input.scope, observedAt: timestamp,
      template: { id: input.templateId, version: input.templateVersion, digest: "c".repeat(64) }, sourceRefs: [] }; } },
    decisions: { async read(input) { return { schemaVersion: "1", id: input.decisionId, scope: input.scope, snapshotDigest: "a".repeat(64), snapshotVersion: "1", actorId: "local-owner",
      policyVersion: "1", approvedAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + 86_400_000).toISOString(), status: "approved", digest: "b".repeat(64) }; } },
    actions: { async admit() { throw new Error("Host不能发起业务副作用"); }, async execute() { throw new Error("Host不能发起业务副作用"); } },
    receipts: { async lookup() { return undefined; }, async reconcile() { return undefined; } },
  };
}

test("业务动作创建只接受用户选择，哈希和执行身份来自Host与Sales", async () => {
  const enabled: { tenantId: string; workspaceId: string }[] = [];
  const ports = fixturePorts();
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: { async save() { return "keychain://muniu.v2/test"; }, async read() { return "test"; } },
    businessProvider: ports, businessWorkspaceScopes: enabled, now: () => "2026-09-18T08:00:00.000Z" });
  const post = (path: string, body: unknown, key: string) => host.dispatch(new Request(`http://host.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const workspace = (await (await post("/v2/workspaces", { name: "工业询价", viewMode: "business", pluginIds: [] }, "workspace")).json() as any).data;
  const body = { schemaVersion: "1", action: "issueQuotePackage", expectedStreamVersion: 0, workspaceId: workspace.id,
    customerId: "customer", quoteId: "quote", quoteVersion: "1", decisionId: "decision", templateId: "standard", templateVersion: "1", renderVersion: "1", exportFormat: "pdf", issueDate: "2026-09-18" };
  assert.notEqual((await post("/v2/business-actions", body, "disabled")).status, 201);
  enabled.push({ tenantId: "local", workspaceId: workspace.id });
  const response = await post("/v2/business-actions", body, "create");
  const result = await response.json() as any;
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.data.action.scope.principalId, "local-owner");
  assert.equal(result.data.action.quote.digest, "a".repeat(64));
  const repeat = await (await post("/v2/business-actions", body, "create")).json() as any;
  assert.equal(repeat.data.id, result.data.id);
  assert.notEqual((await post("/v2/business-actions", { ...body, fencingToken: 999 }, "forged")).status, 201);
  const read = await host.dispatch(new Request(`http://host.test/v2/business-actions/${result.data.id}`));
  assert.equal(read.status, 200);
  const bypass = await post(`/v2/executions/${result.data.executionId}/commands`, { command: "cancel", expectedStreamVersion: 1 }, "bypass");
  assert.equal((await bypass.json() as any).code, "BUSINESS_EXECUTION_COMMAND_FORBIDDEN");
  await host.close();
});

for (const scenario of ["completed", "unknown"] as const) {
test(`本地启动接通业务Worker和受信回执核对：${scenario}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-business-host-"));
  const enabled: { tenantId: string; workspaceId: string }[] = [];
  let host: AgentOsHost | undefined;
  t.after(async () => { await host?.close(); await rm(directory, { recursive: true, force: true }); });
  const ports = fixturePorts(new Date().toISOString());
  let calls = 0;
  let reconciliations = 0;
  let receipt: EffectReceiptV1 | undefined;
  const actions: BusinessProviderPorts["actions"] = {
    async admit(input) {
      calls++;
      const params = new URLSearchParams(Object.entries({ tenantId: input.action.scope.tenantId, ...input.identity }).map(([key, value]) => [key, String(value)]));
      const url = `http://host.test/v2/business-actions/${input.action.actionId}/execution-authority?${params}`;
      const rawToken = await host!.dispatch(new Request(url, { headers: { authorization: "authority-test-secret" } }));
      assert.notEqual(rawToken.status, 200);
      const response = await host!.dispatch(new Request(url, { headers: { authorization: "Bearer authority-test-secret" } }));
      const authority = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(authority));
      assert.equal(authority.data.allowed, true);
      assert.equal(authority.data.actionDigest, input.actionDigest);
      assert.ok(Date.parse(authority.data.leaseExpiresAt) > Date.now());
      params.set("fencingToken", String(input.identity.fencingToken + 1));
      const stale = await host!.dispatch(new Request(`http://host.test/v2/business-actions/${input.action.actionId}/execution-authority?${params}`, { headers: { authorization: "Bearer authority-test-secret" } }));
      assert.notEqual(stale.status, 200);
      return { schemaVersion: "1", actionId: input.action.actionId, operationKey: input.action.operationKey, admissionId: "admitted", status: "admitted" };
    },
    async execute(input) {
      receipt = { schemaVersion: "1", actionId: input.actionId, operationKey: input.operationKey, status: "completed", packageId: "package",
        files: [{ name: "quote.pdf", mediaType: "application/pdf", sha256: "d".repeat(64), protectedContentRef: "sales://local/quote/package/file" }], observedAt: new Date().toISOString() };
      if (scenario === "unknown") throw new Error("结果未收到");
      return receipt;
    },
  };
  host = await startLocalAgentOsHost({ stateRoot: directory, port: 0, workerIdleDelayMs: 5,
    legacyDaemonProbe: async () => false, protectedPayloadKeyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 4)),
    secretStore: { async save() { return "keychain://muniu.v2/test"; }, async read() { return "test"; }, async getOrCreateBytes() { return Buffer.alloc(32, 3); } },
    businessProvider: { ...ports, actions, receipts: { async lookup() { return undefined; }, async reconcile() { reconciliations++; return receipt; } } }, businessWorkspaceScopes: enabled, businessAuthorityTokenResolver: async () => "authority-test-secret" });
  const post = (path: string, body: unknown, key: string) => host!.dispatch(new Request(`http://host.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const workspace = (await (await post("/v2/workspaces", { name: "工业询价", viewMode: "business", pluginIds: [] }, "workspace")).json() as any).data;
  enabled.push({ tenantId: "local", workspaceId: workspace.id });
  const createdResponse = await post("/v2/business-actions", { schemaVersion: "1", action: "issueQuotePackage", expectedStreamVersion: 0, workspaceId: workspace.id,
    customerId: "customer", quoteId: "quote", quoteVersion: "1", decisionId: "decision", templateId: "standard", templateVersion: "1", renderVersion: "1", exportFormat: "pdf", issueDate: "2026-09-18" }, "create");
  const created = (await createdResponse.json() as any).data;
  assert.equal(createdResponse.status, 201);
  let state = created;
  for (let i = 0; i < 300 && !state.approval; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    state = (await (await host.dispatch(new Request(`http://host.test/v2/business-actions/${created.id}`))).json() as any).data;
  }
  assert.ok(state.approval, JSON.stringify(state));
  assert.equal(calls, 0);
  const approval = await post(`/v2/approvals/${state.approval.id}/decisions`, { expectedStreamVersion: state.approval.streamVersion, decision: "approve_once" }, "approve");
  assert.equal(approval.status, 200);
  for (let i = 0; i < 300 && state.status !== (scenario === "unknown" ? "needs_reconciliation" : "completed"); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    state = (await (await host.dispatch(new Request(`http://host.test/v2/business-actions/${created.id}`))).json() as any).data;
  }
  if (scenario === "unknown") {
    const reconciled = await post(`/v2/business-actions/${state.id}/reconciliation-decisions`, { expectedStreamVersion: state.streamVersion, decision: "mark_completed" }, "reconcile");
    const result = await reconciled.json() as any;
    assert.equal(reconciled.status, 200, JSON.stringify(result));
    state = result.data;
    assert.equal(reconciliations, 1);
  }
  assert.equal(state.status, "completed", JSON.stringify(state));
  assert.equal(calls, 1);
  assert.equal(state.dispatchStartedAt, undefined);
  assert.equal(state.admissionId, undefined);
});
}
