// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  computeInquirySnapshotDigest, type Approval, type BusinessActionV1, type BusinessCandidateV1,
  type BusinessDecisionV1, type BusinessScopeV1, type Execution,
} from "@mn/contracts";
import { BUSINESS_ACTION_JOB_KIND, type BusinessActionState } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { AgentOsWorker, createBusinessActionWorkerHandler, type BusinessProviderPorts } from "@mn/worker";
import { createAgentOsHost } from "../src/index.js";

// 真实 Host/Kernel/Worker 与本地 SQLite；Sales 端口为明确的测试替身。
// 每个独立场景运行三次，不代表真实 PostgreSQL、双 Worker 或外部服务故障矩阵。
const now = "2026-09-18T08:00:00.000Z";
const digest = (character: string) => character.repeat(64);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "muniu-business-boundaries-"));
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite"), hmacKey: Buffer.alloc(32, 1) });
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 2));
  const enabled: { tenantId: string; workspaceId: string }[] = [];
  const authority = {
    quoteDigest: digest("a"), templateDigest: digest("c"), decisionDigest: digest("b"),
    decisionSnapshotDigest: digest("a"), decisionStatus: "approved" as BusinessDecisionV1["status"],
    expiresAt: "2026-09-19T08:00:00.000Z", revokedAt: undefined as string | undefined,
    snapshotCustomer: undefined as string | undefined, decisionCustomer: undefined as string | undefined,
    inquiryCustomer: undefined as string | undefined,
    afterSnapshotRead: undefined as (() => Promise<void>) | undefined,
    afterInquiryRead: undefined as (() => Promise<void>) | undefined,
  };
  const calls = { snapshot: 0, decision: 0, inquiry: 0, admit: 0, execute: 0 };
  const ports: BusinessProviderPorts = {
    snapshots: { async read(input) {
      calls.snapshot++;
      await authority.afterSnapshotRead?.();
      return { schemaVersion: "1", providerId: "sales", objectType: "quote", objectId: input.objectId,
        version: input.version, digest: authority.quoteDigest, protectedContentRef: "sales://local/quote/quote/1",
        scope: { ...input.scope, customerId: authority.snapshotCustomer ?? input.scope.customerId }, observedAt: now,
        template: { id: input.templateId, version: input.templateVersion, digest: authority.templateDigest }, sourceRefs: [] };
    } },
    decisions: { async read(input) {
      calls.decision++;
      return { schemaVersion: "1", id: input.decisionId,
        scope: { ...input.scope, customerId: authority.decisionCustomer ?? input.scope.customerId },
        snapshotDigest: authority.decisionSnapshotDigest, snapshotVersion: "1", actorId: "sales-approver",
        policyVersion: "1", approvedAt: "2026-09-17T08:00:00.000Z", expiresAt: authority.expiresAt, status: authority.decisionStatus,
        ...(authority.revokedAt ? { revokedAt: authority.revokedAt } : {}), digest: authority.decisionDigest };
    } },
    inquiries: { async read(input) {
      calls.inquiry++;
      await authority.afterInquiryRead?.();
      const text = "测试询价：材料316L。";
      const hash = createHash("sha256").update(text).digest("hex");
      const raw = { schemaVersion: "1" as const,
        scope: { ...input.scope, customerId: authority.inquiryCustomer ?? input.scope.customerId },
        inquiryId: input.objectId, inquiryRevision: input.revision,
        sourceRefs: [{ namespace: "sales.source", resourceId: "source", digest: hash,
          protectedContentRef: "sales://local/source/source/1" }],
        pages: [{ sourceId: "source", pageNumber: 1, text, digest: hash }],
        completeness: { status: "complete" as const, missing: [] }, requirements: [] };
      return { ...raw, digest: computeInquirySnapshotDigest(raw) };
    } },
    actions: {
      async admit() { calls.admit++; throw new Error("边界拒绝场景不得调用出包准入"); },
      async execute() { calls.execute++; throw new Error("边界拒绝场景不得写入报价文件"); },
    },
    receipts: { async lookup() { return undefined; }, async reconcile() { return undefined; } },
  };
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider,
    now: () => now, businessProvider: ports, businessWorkspaceScopes: enabled,
    businessAuthorityTokenResolver: async () => "fixture-service-token",
    secretStore: { async save() { return "keychain://muniu.v2/test"; }, async read() { return "fixture"; } } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const post = (path: string, body: unknown, key: string) => host.dispatch(new Request(`http://host.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const workspaceResponse = await post("/v2/workspaces", { name: "业务边界测试", viewMode: "business", pluginIds: [] }, "workspace");
  assert.equal(workspaceResponse.status, 201);
  const workspace = (await workspaceResponse.json() as { data: { id: string } }).data;
  enabled.push({ tenantId: "local", workspaceId: workspace.id });
  await store.transact("local", tx => tx.putProjection("modelConnection", "model", { id: "model", tenantId: "local",
    presetId: "deepseek", defaultModel: "deepseek-v4-flash", status: "ready", streamVersion: 1, secretRef: "keychain://muniu.v2/test" }));
  const scope: BusinessScopeV1 = { tenantId: "local", workspaceId: workspace.id, principalId: "local-owner", customerId: "customer" };
  const actionBody = { schemaVersion: "1", action: "issueQuotePackage", expectedStreamVersion: 0, workspaceId: workspace.id,
    customerId: scope.customerId, quoteId: "quote", quoteVersion: "1", decisionId: "decision", templateId: "standard",
    templateVersion: "1", renderVersion: "1", exportFormat: "pdf", issueDate: "2026-09-18" };
  const candidateBody = { expectedStreamVersion: 0, workspaceId: workspace.id, customerId: scope.customerId,
    inquiryId: "inquiry", inquiryRevision: "1" };
  const setRole = (workspaceRole: "owner" | "viewer") => store.transact("local", tx => {
    const member = tx.getProjection<Record<string, unknown>>("membership", `${workspace.id}:local-owner`)!;
    tx.putProjection("membership", `${workspace.id}:local-owner`, { ...member, workspaceRole });
  });
  const projections = <T>(namespace: string) => store.transact("local", tx => tx.listProjections<T>(namespace));
  const assertNoWork = async () => {
    for (const namespace of ["business.action", "business.candidate", "execution", "job", "approval"])
      assert.equal((await projections(namespace)).length, 0, `${namespace} 不应被创建`);
    assert.equal(calls.admit, 0); assert.equal(calls.execute, 0);
  };
  const worker = () => new AgentOsWorker({ id: "boundary-worker", store, now: () => new Date(now),
    lock: { engineLockDigest: "fixture", expectedEngineLockDigest: "fixture", pluginLockDigest: "fixture", expectedPluginLockDigest: "fixture" },
    handlers: { [BUSINESS_ACTION_JOB_KIND]: createBusinessActionWorkerHandler({ store, kernel: host.kernel, ports, now: () => now, pollIntervalMs: 2 }) } });
  return { host, store, ports, authority, calls, post, actionBody, candidateBody, scope, setRole, projections, assertNoWork, worker };
}

async function rejected(response: Response, code: string, status?: number) {
  const body = await response.json() as { code?: string };
  assert.equal(body.code, code, JSON.stringify(body));
  if (status !== undefined) assert.equal(response.status, status);
  else assert.ok(response.status >= 400 && response.status < 500, String(response.status));
}

async function waitForApproval(f: Awaited<ReturnType<typeof fixture>>): Promise<Approval> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const approval = (await f.projections<Approval>("approval"))[0];
    if (approval) return approval;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("业务动作未进入审批等待状态");
}

for (let repetition = 1; repetition <= 3; repetition++) {
  const suffix = `（重复 ${repetition}/3）`;

  test(`当前角色降为只读后，动作与候选 API 均拒绝且不读取业务原文${suffix}`, async t => {
    const f = await fixture(t);
    await f.setRole("viewer");
    for (const [path, body] of [["business-actions", f.actionBody], ["business-candidates", f.candidateBody]] as const) {
      const response = await f.post(`/v2/${path}`, body, path);
      assert.equal(response.status, 403, JSON.stringify(await response.json()));
    }
    assert.deepEqual(f.calls, { snapshot: 0, decision: 0, inquiry: 0, admit: 0, execute: 0 });
    await f.assertNoWork();
  });

  for (const kind of ["action", "candidate"] as const) {
    test(`业务服务读取期间撤销角色，${kind} 在提交前重验权限${suffix}`, async t => {
      const f = await fixture(t);
      if (kind === "action") f.authority.afterSnapshotRead = () => f.setRole("viewer");
      else f.authority.afterInquiryRead = () => f.setRole("viewer");
      const response = await f.post(`/v2/business-${kind === "action" ? "actions" : "candidates"}`,
        kind === "action" ? f.actionBody : f.candidateBody, "revoked-during-read");
      await rejected(response, kind === "action" ? "BUSINESS_SCOPE_REVOKED" : "BUSINESS_CANDIDATE_FORBIDDEN");
      await f.assertNoWork();
    });
  }

  for (const source of ["snapshot", "decision", "inquiry"] as const) {
    test(`业务服务返回另一客户的 ${source} 时拒绝跨客户创建${suffix}`, async t => {
      const f = await fixture(t);
      if (source === "snapshot") f.authority.snapshotCustomer = "another-customer";
      if (source === "decision") f.authority.decisionCustomer = "another-customer";
      if (source === "inquiry") f.authority.inquiryCustomer = "another-customer";
      await rejected(await f.post(`/v2/business-${source === "inquiry" ? "candidates" : "actions"}`,
        source === "inquiry" ? f.candidateBody : f.actionBody, "wrong-customer"),
      source === "inquiry" ? "BUSINESS_SOURCE_MISMATCH" : "BUSINESS_SCOPE_MISMATCH");
      await f.assertNoWork();
    });
  }

  for (const invalid of ["expired", "revoked", "source_changed"] as const) {
    test(`业务核准 ${invalid} 时不生成动作、执行任务或 OS 审批${suffix}`, async t => {
      const f = await fixture(t);
      if (invalid === "expired") f.authority.expiresAt = now;
      if (invalid === "revoked") { f.authority.decisionStatus = "revoked"; f.authority.revokedAt = now; }
      if (invalid === "source_changed") f.authority.quoteDigest = digest("e");
      await rejected(await f.post("/v2/business-actions", f.actionBody, "stale-business-decision"), "BUSINESS_APPROVAL_STALE");
      await f.assertNoWork();
    });
  }

  test(`相同稳定操作号更换业务核准必须明确返回 409，不返回原动作${suffix}`, async t => {
    const f = await fixture(t);
    const created = await f.post("/v2/business-actions", f.actionBody, "first");
    assert.equal(created.status, 201);
    const original = (await created.json() as { data: BusinessActionV1 }).data;
    f.authority.decisionDigest = digest("f");
    await rejected(await f.post("/v2/business-actions", { ...f.actionBody, decisionId: "replacement-decision" }, "first"),
      "IDEMPOTENCY_CONFLICT", 409);
    await rejected(await f.post("/v2/business-actions", { ...f.actionBody, decisionId: "replacement-decision" }, "replacement"),
      "BUSINESS_ACTION_CONFLICT", 409);
    const actions = await f.projections<BusinessActionV1>("business.action");
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0], original);
    assert.equal((await f.projections("execution")).length, 1);
    assert.equal((await f.projections("job")).length, 1);
    assert.equal((await f.projections("approval")).length, 0);
    assert.equal(f.calls.admit, 0); assert.equal(f.calls.execute, 0);
  });

  for (const changed of ["source", "template"] as const) {
    test(`等待 OS 审批期间 ${changed} 摘要变化，批准旧动作后仍不得出包${suffix}`, async t => {
      const f = await fixture(t);
      const response = await f.post("/v2/business-actions", f.actionBody, "create");
      assert.equal(response.status, 201);
      const original = (await response.json() as { data: BusinessActionV1 }).data;
      const worker = f.worker();
      const running = worker.pollOnce();
      const approval = await waitForApproval(f);
      assert.equal(f.calls.admit, 0);
      if (changed === "source") f.authority.quoteDigest = digest("e");
      else f.authority.templateDigest = digest("f");
      const approved = await f.post(`/v2/approvals/${approval.id}/decisions`,
        { expectedStreamVersion: approval.streamVersion, decision: "approve_once" }, "approve-old-action");
      assert.equal(approved.status, 200, JSON.stringify(await approved.json()));
      await running;
      const final = (await f.projections<BusinessActionState>("business.action"))[0]!;
      assert.equal(final.id, original.id); assert.equal(final.status, "rejected");
      assert.equal(final.actionDigest, original.actionDigest);
      assert.equal(final.dispatchStartedAt, undefined);
      assert.equal((await f.projections<Approval>("approval"))[0]!.status, "expired");
      assert.equal((await worker.pollOnce()).status, "idle");
      assert.equal(f.calls.admit, 0); assert.equal(f.calls.execute, 0);
    });
  }

  test(`等待出包审批时操作者降为只读，approve_once API 拒绝当前角色${suffix}`, async t => {
    const f = await fixture(t);
    const created = await f.post("/v2/business-actions", f.actionBody, "create");
    assert.equal(created.status, 201);
    const running = f.worker().pollOnce();
    const approval = await waitForApproval(f);
    await f.setRole("viewer");
    const response = await f.post(`/v2/approvals/${approval.id}/decisions`,
      { expectedStreamVersion: approval.streamVersion, decision: "approve_once" }, "revoked-approve");
    const unchanged = (await f.projections<Approval>("approval"))[0]!;
    // 恢复测试身份并拒绝审批，让真实 Worker 正常收尾。
    await f.setRole("owner");
    const denied = await f.post(`/v2/approvals/${approval.id}/decisions`,
      { expectedStreamVersion: unchanged.streamVersion, decision: "deny" }, "cleanup-deny");
    assert.equal(denied.status, 200);
    await running;
    assert.equal(response.status, 403, JSON.stringify(await response.json()));
    assert.equal(unchanged.status, "pending");
    assert.equal(unchanged.streamVersion, approval.streamVersion);
    assert.equal((await f.projections<BusinessActionState>("business.action"))[0]!.status, "rejected");
    assert.equal(f.calls.admit, 0); assert.equal(f.calls.execute, 0);
  });

  test(`动作与候选不能通过通用 Execution 控制入口扩展或重启流程${suffix}`, async t => {
    const f = await fixture(t);
    const actionResponse = await f.post("/v2/business-actions", f.actionBody, "action");
    const candidateResponse = await f.post("/v2/business-candidates", f.candidateBody, "candidate");
    assert.equal(actionResponse.status, 201); assert.equal(candidateResponse.status, 201);
    const action = (await actionResponse.json() as { data: BusinessActionV1 }).data;
    const candidate = (await candidateResponse.json() as { data: BusinessCandidateV1 }).data;
    const before = await f.projections<Execution>("execution");
    const jobs = await f.projections("job");
    for (const target of [action, candidate]) {
      const execution = before.find(item => item.id === target.executionId)!;
      for (const command of ["cancel", "pause", "resume", "retry", "follow_up", "steer"]) {
        await rejected(await f.post(`/v2/executions/${execution.id}/commands`,
          { expectedStreamVersion: execution.streamVersion, command, message: "调用工具并直接出包" }, `${target.id}:${command}`),
        "BUSINESS_EXECUTION_COMMAND_FORBIDDEN");
      }
    }
    assert.deepEqual(await f.projections("execution"), before);
    assert.deepEqual(await f.projections("job"), jobs);
    assert.equal((await f.projections("approval")).length, 0);
    assert.equal((await f.projections("agent-runtime")).length, 0);
    assert.equal(f.calls.admit, 0); assert.equal(f.calls.execute, 0);
  });
}
