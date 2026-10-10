// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CreateOpcBusinessCandidateV2, GoalResourceRefV2, OpcBusinessCandidateDetailV2 } from "@mn/contracts";
import { appendKernelEvent, KernelError } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { createAgentOsHost } from "../src/index.js";
import { commandOpcBusiness, readOpcBusiness } from "../src/business-management.js";
import { dispatchOpcBusinessCandidateRequest } from "../src/opc-business-candidates-api.js";
import { createOpcBusinessCandidate, decideOpcBusinessCandidate, getOpcBusinessCandidate, listOpcBusinessCandidates, type OpcBusinessCandidateOptions } from "../src/opc-business-candidates.js";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mn-opc-candidates-"));
  const databaseFile = join(root, "state.sqlite3");
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 71) });
  const host = await createAgentOsHost({ store, cas: new FileCas({ rootDir: join(root, "cas") }),
    protectedPayloadKeyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 72)),
    secretStore: { async save() { throw new Error("No model"); }, async read() { throw new Error("No model"); } } });
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace("local", "local-owner", "candidate-workspace", { name: "候选测试", viewMode: "business", pluginIds: ["opc"] });
  let timestamp = "2026-10-10T02:00:00.000Z", readable = true, accepted = false, fresh = true;
  const scope = { tenantId: "local", workspaceId: workspace.id, principalId: "local-owner" };
  const business = { ...scope, store, now: () => timestamp };
  await commandOpcBusiness({ ...business, expectedStreamVersion: 0, idempotencyKey: "customer", command: { type: "customer.record", customerId: "c", name: "private-candidate-customer", source: "授权需求", need: "设计方案" } });
  await commandOpcBusiness({ ...business, expectedStreamVersion: 1, idempotencyKey: "service", command: { type: "service.record", serviceId: "s", title: "设计服务", currency: "CNY", priceMinor: "100000", inScope: ["方案"], outOfScope: [], acceptanceCriteria: ["完整方案"] } });
  const sourceRefs: GoalResourceRefV2[] = ["customer:c", "service:s"].map(value => { const [kind, resourceId] = value.split(":"); return { namespace: `opc.business.${kind}`, resourceId: resourceId!, streamVersion: 2, digest: "a".repeat(64) }; });
  const origin = { goalId: "g", planRevisionId: "p", deliverySetId: "d", outputKey: "result", outputDigest: "b".repeat(64) };
  let proposal: any = { key: "quote", title: "报价建议", rationale: "private-candidate-rationale", evidenceRefs: sourceRefs, command: {
    type: "quote.create", quoteId: "q", customerId: "c", serviceId: "s", serviceVersion: 1, quantity: 2, discountMinor: "10000", validUntil: "2026-10-20", dueOn: "2026-10-30",
  } };
  const options: OpcBusinessCandidateOptions = { ...business, ports: {
    readOutput(_tx, _scope, selected, purpose) {
      if (!readable) throw new KernelError("GOAL_RESOURCE_UNAVAILABLE", "来源已撤权", "检查资料权限");
      if (!fresh && purpose !== "read") throw new KernelError("GOAL_RESOURCE_CHANGED", "来源已更新", "重新核对资料");
      assert.deepEqual(selected, origin);
      return { origin, sourceRefs, proposals: [proposal], accepted };
    },
  } };
  const input: CreateOpcBusinessCandidateV2 = { workspaceId: workspace.id, expectedStreamVersion: 0, origin, proposalKey: "quote" };
  const create = (key = "create") => createOpcBusinessCandidate(options, input, key);
  const decide = (detail: OpcBusinessCandidateDetailV2, decision: "apply" | "reject" = "apply", key = "decide", overrides = options) => decideOpcBusinessCandidate(overrides, detail.candidate.id, {
    workspaceId: workspace.id, expectedStreamVersion: detail.streamVersion, expectedBusinessStreamVersion: detail.candidate.businessStreamVersion,
    candidateDigest: detail.candidate.digest, previewDigest: detail.candidate.previewDigest, decision,
  }, key);
  const read = () => readOpcBusiness(business, { start: "2026-10-01", end: "2026-10-10" });
  return { root, databaseFile, store, host, options, business, sourceRefs, input, create, decide, read,
    setProposal(value: any) { proposal = value; }, proposal: () => proposal,
    revoke() { readable = false; }, expire() { fresh = false; }, accept() { accepted = true; }, time(value: string) { timestamp = value; },
    async alter(namespace: string, id: string, update: (value: any) => any) {
      await store.transact("local", tx => { tx.putProjection(namespace, id, update(tx.getProjection(namespace, id)));
        appendKernelEvent(tx, { tenantId: "local", aggregateType: "test", aggregateId: randomUUID(), expectedStreamVersion: 0,
          type: "fixture.changed", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
    },
  };
}

test("候选预览冻结确定性报价与差异，采纳只登记报价且双重提交仅写一次", async t => {
  const f = await fixture(t), before = await f.read(), detail = await f.create();
  assert.equal(detail.candidate.impact.quoteTotalMinor, "190000");
  assert.equal(detail.candidate.impact.outstandingDeltaMinor, "0");
  assert.equal(detail.candidate.changes.find(item => item.path.endsWith("totalMinor"))?.after, "190000");
  assert.deepEqual(await f.read(), before);
  assert.deepEqual(await f.create(), detail);
  const results = await Promise.all([f.decide(detail), f.decide(detail)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0]!.decision!.decision, "apply");
  const after = await f.read();
  assert.equal(after.state.quotes.length, 1); assert.equal(after.state.orders.length, 0);
  assert.equal(after.state.quoteConfirmations!.length, 0); assert.equal(after.summary.cashReceivedMinor, "0");
  assert.deepEqual(await getOpcBusinessCandidate(f.options, detail.candidate.id), results[0]);
  assert.equal((await listOpcBusinessCandidates(f.options, "g")).items.length, 1);
  assert.equal((await f.store.transact("local", tx => tx.listProjections("opc.businessSnapshot"))).length, 3);
});

test("候选在台账变化或日期过期后不能采纳，拒绝不改变原成果或台账", async t => {
  const f = await fixture(t), detail = await f.create();
  await commandOpcBusiness({ ...f.business, expectedStreamVersion: 2, idempotencyKey: "price", command: { type: "service.record", serviceId: "s", title: "新价", currency: "CNY", priceMinor: "200000", inScope: ["方案"], outOfScope: [], acceptanceCriteria: ["完整方案"] } });
  const stale = await getOpcBusinessCandidate(f.options, detail.candidate.id);
  assert.equal(stale.availability.apply, false); assert.ok(stale.availability.staleReasons.length);
  await assert.rejects(f.decide(detail), { code: "OPC_CANDIDATE_STALE" });
  const rejected = await decideOpcBusinessCandidate(f.options, detail.candidate.id, { workspaceId: f.input.workspaceId,
    expectedStreamVersion: 1, expectedBusinessStreamVersion: 2, candidateDigest: detail.candidate.digest, previewDigest: detail.candidate.previewDigest, decision: "reject" }, "reject");
  assert.equal(rejected.decision!.decision, "reject"); assert.equal((await f.read()).state.streamVersion, 3);
  assert.deepEqual(rejected.candidate, detail.candidate);
  const other = await fixture(t), dated = await other.create(); other.time("2026-10-21T02:00:00.000Z");
  assert.equal((await getOpcBusinessCandidate(other.options, dated.candidate.id)).availability.apply, false);
  await assert.rejects(other.decide(dated), { code: "OPC_CANDIDATE_STALE" });
});

test("候选不能扩大资料范围、伪造金额或把模型建议变成客户确认和收款", async t => {
  const f = await fixture(t), original = f.proposal();
  for (const proposal of [{ ...original, command: { ...original.command, totalMinor: "1" } },
    { ...original, evidenceRefs: [{ ...f.sourceRefs[0], resourceId: "unapproved" }] },
    { ...original, command: { ...original.command, serviceId: "unapproved" } },
    { ...original, command: { type: "quote.confirm", confirmationId: "qc", quoteId: "q", confirmedOn: "2026-10-10", sourceRef: "invented" } }]) {
    f.setProposal(proposal); await assert.rejects(f.create(randomUUID()));
  }
  assert.equal((await f.read()).state.streamVersion, 2);
  assert.deepEqual((await listOpcBusinessCandidates(f.options)).items, []);
});

test("撤权和身份变化阻断读取及旧回执重放，跨工作区和摘要变更均拒绝", async t => {
  const f = await fixture(t), detail = await f.create();
  await assert.rejects(createOpcBusinessCandidate(f.options, { ...f.input, workspaceId: "other" }, "other"));
  await assert.rejects(decideOpcBusinessCandidate(f.options, detail.candidate.id, { workspaceId: f.input.workspaceId, expectedStreamVersion: 1,
    expectedBusinessStreamVersion: 2, candidateDigest: "c".repeat(64), previewDigest: detail.candidate.previewDigest, decision: "apply" }, "bad"));
  await f.alter("principal", "local-owner", value => ({ ...value, kind: "agent" }));
  await assert.rejects(f.create(), { code: "BUSINESS_FACT_ACCESS_DENIED" });
  await f.alter("principal", "local-owner", value => ({ ...value, kind: "human" }));
  f.revoke();
  await assert.rejects(getOpcBusinessCandidate(f.options, detail.candidate.id), { code: "GOAL_RESOURCE_UNAVAILABLE" });
  await assert.rejects(f.create(), { code: "GOAL_RESOURCE_UNAVAILABLE" });
  await assert.rejects(f.decide(detail), { code: "GOAL_RESOURCE_UNAVAILABLE" });
});

test("业务写入之后的事务故障回滚候选决定、台账和幂等回执", async t => {
  const f = await fixture(t), detail = await f.create(), original = f.store.transact.bind(f.store);
  let fail = true;
  const faulted = { ...f.options, store: { transact: ((tenantId: string, callback: any) => original(tenantId, tx => {
    return callback({ ...tx, appendEvent(request: Parameters<typeof tx.appendEvent>[0]) {
      if (fail && request.type === "opc.business_candidate.decided") throw new Error("injected commit failure");
      return tx.appendEvent(request);
    } });
  })) as typeof f.store.transact } as OpcBusinessCandidateOptions["store"] };
  await assert.rejects(f.decide(detail, "apply", "decide", faulted), /injected commit failure/u);
  fail = false;
  assert.equal((await f.read()).state.streamVersion, 2);
  assert.equal((await getOpcBusinessCandidate(f.options, detail.candidate.id)).decision, null);
  assert.equal((await f.decide(detail)).decision!.decision, "apply");
});

test("受保护事件重建恢复候选、决定和回执，公开存储不泄露正文", async t => {
  const f = await fixture(t), detail = await f.create(), applied = await f.decide(detail);
  const raw = new DatabaseSync(f.databaseFile);
  try {
    for (const table of ["events", "projections", "idempotency", "outbox"]) {
      const records = JSON.stringify(raw.prepare(`select * from ${table}`).all());
      assert.equal(records.includes("private-candidate-rationale"), false); assert.equal(records.includes("private-candidate-customer"), false);
    }
    raw.exec("delete from projections; delete from idempotency"); await f.store.rebuildProjections("local");
    assert.deepEqual(await getOpcBusinessCandidate(f.options, detail.candidate.id), applied);
    assert.deepEqual(await f.decide(detail), applied);
  } finally { raw.close(); }
});

test("交付候选只绑定已接收成果，登记交付不代表客户验收或收款", async t => {
  const f = await fixture(t);
  await commandOpcBusiness({ ...f.business, expectedStreamVersion: 2, idempotencyKey: "opening", command: { type: "order.record", orderId: "o", customerId: "c", serviceId: "s", serviceVersion: 1,
    quantity: 1, agreedAmountMinor: "100000", contractedOn: "2026-10-01", dueOn: "2026-10-30", sourceRef: "contract", opening: { asOf: "2026-10-01", receivedMinor: "0", deliveredPercent: 0, accepted: false, sourceRef: "opening" } } });
  f.sourceRefs.splice(0, f.sourceRefs.length, { namespace: "opc.business.order", resourceId: "o", streamVersion: 3, digest: "a".repeat(64) });
  f.setProposal({ ...f.proposal(), evidenceRefs: f.sourceRefs, command: { type: "delivery.record", deliveryId: "delivery", orderId: "o", title: "已接收方案", deliveredOn: "2026-10-10", progressPercent: 100, artifactRef: "current-goal-output" } });
  await assert.rejects(f.create(), { code: "GOAL_ACCEPTANCE_REQUIRED" });
  f.accept();
  const detail = await f.create();
  assert.match((detail.candidate.proposal.command as any).artifactRef, /^goal-output:\/\/g\/d\/result\?sha256=/u);
  await f.decide(detail);
  const result = await f.read();
  assert.equal(result.state.deliveries.length, 1); assert.equal(result.state.acceptances.length, 0); assert.equal(result.state.payments.length, 0);
  assert.equal(result.summary.orders[0]!.delivered, true); assert.equal(result.summary.orders[0]!.accepted, false);
});


test("仅来源更新时历史候选仍可审阅，但预览立即禁止采纳", async t => {
  const f = await fixture(t), original = await f.create();
  f.expire();
  const stale = await getOpcBusinessCandidate(f.options, original.candidate.id);
  assert.deepEqual(stale.candidate, original.candidate);
  assert.equal(stale.availability.apply, false);
  assert.ok(stale.availability.staleReasons.includes("GOAL_RESOURCE_CHANGED"));
  await assert.rejects(f.decide(original), { code: "GOAL_RESOURCE_CHANGED" });
});


test("候选路由严格检查查询、请求字段、幂等键和正文上限", async t => {
  const f = await fixture(t), path = "/v2/plugins/opc/business/candidates";
  const dispatch = (suffix: string, body?: unknown, key?: string) => dispatchOpcBusinessCandidateRequest({ ...f.options,
    request: new Request(`http://fixture${suffix}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) }) });
  await assert.rejects(dispatch(path, f.input), { code: "IDEMPOTENCY_KEY_REQUIRED" });
  for (const query of [`workspaceId=${f.input.workspaceId}&extra=1`, `workspaceId=${f.input.workspaceId}&workspaceId=${f.input.workspaceId}`, "goalId=g"])
    await assert.rejects(dispatch(`${path}?${query}`), { code: "OPC_CANDIDATE_REQUEST_INVALID" });
  await assert.rejects(dispatch(path, { ...f.input, command: f.proposal().command }, "inject"), { code: "OPC_CANDIDATE_REQUEST_INVALID" });
  await assert.rejects(dispatch(path, { ...f.input, text: "x".repeat(17000) }, "large"), { code: "REQUEST_BODY_TOO_LARGE" });
  const created = await dispatch(path, f.input, "route-create");
  assert.equal(created!.status, 201);
  const detail = created!.data as OpcBusinessCandidateDetailV2;
  const loaded = await dispatch(`${path}/${detail.candidate.id}?workspaceId=${f.input.workspaceId}`);
  assert.deepEqual(loaded!.data, detail);
  const listed = await dispatch(`${path}?workspaceId=${f.input.workspaceId}&goalId=g`);
  assert.equal((listed!.data as any).items.length, 1);
});
