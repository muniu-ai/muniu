// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { businessDateAt, type GoalResourceRefV2 } from "@mn/contracts";
import { appendKernelEvent } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { AgentOsWorker, createKernelAgentTurnHandler } from "@mn/worker";
import { createAgentOsHost } from "../src/host.js";
import { validateBusinessContextSource } from "../src/business-context.js";
import { assertGoalExecutionResources } from "../src/goal-runtime.js";
import { createOpcModelContextReader } from "../src/opc-model-context.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "mn-business-delivery-flow-"));
  const store = new SqliteStorage({ databaseFile: join(directory, "state.sqlite"), hmacKey: Buffer.alloc(32, 75) });
  const cas = new FileCas({ rootDir: join(directory, "cas") }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 76));
  const secretStore = { async save() { return "keychain://muniu.v2/business-flow"; }, async read() { return "fixture"; } };
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, goalPollIntervalMs: 10 });
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace("local", "local-owner", randomUUID(), { name: "经营交付流程", viewMode: "business", pluginIds: ["opc"] });
  const model = await host.kernel.saveModelConnection("local", "local-owner", randomUUID(), { presetId: "deepseek", displayName: "合成模型",
    secretRef: "keychain://muniu.v2/business-flow", defaultModel: "deepseek-v4-flash", discoveredModels: ["deepseek-v4-flash"] });
  await store.transact("local", tx => {
    tx.putProjection("modelConnection", model.id, { ...model, status: "ready", streamVersion: 2 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "modelConnection", aggregateId: model.id, expectedStreamVersion: 1,
      type: "fixture.model_ready", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const send = async (path: string, body?: unknown, key: string = randomUUID()) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : { method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (path: string, body?: unknown, key?: string) => {
    const result = await send(path, body, key); assert.ok(result.status >= 200 && result.status < 300, JSON.stringify({ path, ...result })); return result.body.data;
  };
  const readBusiness = () => ok(`/v2/plugins/opc/business?workspaceId=${workspace.id}`);
  const command = async (command: unknown) => ok("/v2/plugins/opc/business/commands", { workspaceId: workspace.id,
    expectedStreamVersion: (await readBusiness()).state.streamVersion, command });
  const source = async (kind: string, resourceId: string): Promise<GoalResourceRefV2> => (await ok(`/v2/workspaces/${workspace.id}/business-context/${kind}/${resourceId}`)).sourceRef;
  const today = businessDateAt(new Date().toISOString()), later = businessDateAt(new Date(Date.now() + 30 * 86_400_000).toISOString());
  const service = { type: "service.record", serviceId: "s", title: "文档服务", currency: "CNY", priceMinor: "100000", inScope: ["需求方案和使用说明"], outOfScope: [], acceptanceCriteria: ["来源可核对"] };
  await command({ type: "customer.record", customerId: "c", name: "合成客户", source: "合成访谈", need: "整理需求并交付使用说明" });
  await command(service);
  let produced = "", calls = 0;
  const worker = new AgentOsWorker({ id: "business-flow-worker", store,
    lock: { engineLockDigest: "fixture", expectedEngineLockDigest: "fixture", pluginLockDigest: "fixture", expectedPluginLockDigest: "fixture" },
    handlers: { "agent.execution.run": createKernelAgentTurnHandler({ store, approvalKernel: host.kernel, secretStore,
      runtimeProtection: { cas, keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store, cas, protectedPayloadKeyProvider: keyProvider }), codingSandboxRoot: join(directory, "sandboxes"),
      modelInvoker: async input => { calls++; return { text: JSON.stringify(input.request.messages).includes("当前职责：独立复核")
        ? JSON.stringify({ decision: "pass", findings: [] }) : produced, toolCalls: [], usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 60 } }; },
      modelQuoter: async () => ({ inputTokenLimit: 6000, maxOutputTokens: 2500, rates: { id: "fixture", currency: "CNY",
        inputNanoMinorUnitsPerToken: "0", cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }),
    }) } });
  const runGoal = async (sources: readonly GoalResourceRefV2[], items: readonly { key: string; text: string; proposals: readonly unknown[] }[], team = false) => {
    produced = JSON.stringify({ format: "muniu.goal-delivery.v1", items });
    const thread = await host.kernel.createThread("local", "local-owner", randomUUID(), { workspaceId: workspace.id, subject: "经营交付", pluginId: "opc" });
    const created = await ok(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: "依据授权资料形成可审阅成果与业务候选，不登记外部事实", resourceRefs: sources,
      budget: { maxTokens: 60000, maxCostMinorUnits: "1000", currency: "CNY", maxDurationMs: 120000 },
      deliverables: items.map(item => ({ key: item.key, title: item.key, required: true, criteria: [{ id: "complete", description: "本项内容完整且来源明确" }] })) });
    const path = `/v2/goals/${created.goal.id}`;
    const planned = await ok(`${path}/plan-revisions`, { workspaceId: workspace.id, expectedStreamVersion: created.goal.streamVersion, modelBindingId: model.id,
      ...(team ? { kind: "team-v1", templateId: "business-proposal", templateVersion: "1" } : {}) });
    await ok(`${path}/commands`, { workspaceId: workspace.id, expectedStreamVersion: planned.goal.streamVersion, command: "start", planRevisionId: planned.plan.id, planDigest: planned.plan.digest });
    const deadline = Date.now() + 30000; let latest: any;
    while (Date.now() < deadline) {
      await worker.pollOnce();
      latest = await ok(`${path}?workspaceId=${workspace.id}`);
      if (latest.goal.status === "awaiting_acceptance") return { path, detail: latest };
      if (latest.goal.status === "waiting_approval") {
        const progress = await ok(`${path}/nodes?workspaceId=${workspace.id}`);
        const waiting = progress.nodes.find((node: any) => node.status === "awaiting_decision");
        if (waiting) await ok(`${path}/commands`, { workspaceId: workspace.id, expectedStreamVersion: latest.goal.streamVersion, command: "decide", nodeId: waiting.nodeId, decision: "continue" });
      }
      assert.ok(!["failed", "cancelled", "needs_reconciliation"].includes(latest.goal.status), JSON.stringify(latest));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(JSON.stringify({ latest, calls }));
  };
  const acceptItem = async (goal: Awaited<ReturnType<typeof runGoal>>, key: string) => {
    const current = await ok(`${goal.path}?workspaceId=${workspace.id}`), item = current.deliverySet.items.find((item: any) => item.key === key);
    return ok(`${goal.path}/delivery-decisions`, { workspaceId: workspace.id, expectedStreamVersion: current.goal.streamVersion,
      deliverySetId: current.deliverySet.id, criteriaVersion: current.goal.criteriaVersion,
      items: [{ key, digest: item.digest, decision: "accept", reviewedCriterionIds: ["complete"] }] });
  };
  const candidate = async (goal: Awaited<ReturnType<typeof runGoal>>, outputKey: string, proposalKey: string) => {
    const current = await ok(`${goal.path}?workspaceId=${workspace.id}`), item = current.deliverySet.items.find((item: any) => item.key === outputKey);
    return ok("/v2/plugins/opc/business/candidates", { workspaceId: workspace.id, expectedStreamVersion: 0, proposalKey,
      origin: { goalId: current.goal.id, planRevisionId: current.plan.id, deliverySetId: current.deliverySet.id, outputKey, outputDigest: item.digest } });
  };
  const decideCandidate = (detail: any, key: string = randomUUID()) => send(`/v2/plugins/opc/business/candidates/${detail.candidate.id}/decisions`, {
    workspaceId: workspace.id, expectedStreamVersion: detail.streamVersion, expectedBusinessStreamVersion: detail.candidate.businessStreamVersion,
    candidateDigest: detail.candidate.digest, previewDigest: detail.candidate.previewDigest, decision: "apply",
  }, key);
  return { host, store, workspace, send, ok, command, source, today, later, service, runGoal, acceptItem, candidate, decideCandidate, readBusiness };
}

test("公开接口贯通需求、报价候选、独立业务事实、交付验收收款和复盘", async t => {
  const f = await fixture(t), refs = [await f.source("customer", "c"), await f.source("service", "s")];
  const proposal = { key: "quote", title: "报价草稿", rationale: "按客户需求和授权服务范围生成", evidenceRefs: refs,
    command: { type: "quote.create", quoteId: "q", customerId: "c", serviceId: "s", serviceVersion: 1, quantity: 1, discountMinor: "0", validUntil: f.later, dueOn: f.later } };
  const analysis = await f.runGoal(refs, [{ key: "proposal", text: "需求已整理；交付范围为方案与使用说明。", proposals: [] }, { key: "quote", text: "报价草稿，仅为内部候选。", proposals: [proposal] }], true);
  assert.equal(analysis.detail.deliverySet.items.length, 2);
  assert.equal((await f.acceptItem(analysis, "proposal")).goal.status, "awaiting_acceptance");
  assert.equal((await f.acceptItem(analysis, "quote")).goal.status, "accepted");
  const draft = await f.candidate(analysis, "quote", "quote");
  assert.equal(draft.candidate.impact.quoteTotalMinor, "100000");
  assert.equal((await f.readBusiness()).state.quotes.length, 0);
  const applied = await f.decideCandidate(draft, "apply-quote");
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual((await f.decideCandidate(draft, "apply-quote")).body.data, applied.body.data);
  assert.equal((await f.ok(`${analysis.path}?workspaceId=${f.workspace.id}`)).goal.status, "accepted", "采纳自身不能使获准的历史成果不可读");
  let business = await f.readBusiness();
  assert.equal(business.state.quotes.length, 1); assert.equal(business.state.orders.length, 0); assert.equal(business.state.quoteConfirmations.length, 0);
  business = await f.command({ type: "quote.confirm", confirmationId: "qc", quoteId: "q", confirmedOn: f.today, sourceRef: "synthetic-customer-confirmation" });
  assert.equal(business.state.quoteConfirmations.length, 1); assert.equal(business.state.orders.length, 0); assert.equal(business.summary.outstandingMinor, "0");
  business = await f.command({ type: "order.activate", orderId: "o", quoteConfirmationId: "qc", contractedOn: f.today, sourceRef: "synthetic-signed-contract" });
  assert.equal(business.state.orders.length, 1); assert.equal(business.state.deliveries.length, 0); assert.equal(business.summary.cashReceivedMinor, "0");
  const orderRefs = [await f.source("order", "o")];
  const delivery = await f.runGoal(orderRefs, [{ key: "manual", text: "完整使用说明：准备资料、核对范围、逐项确认结果。", proposals: [{ key: "delivery", title: "登记本次交付", rationale: "将已接收的使用说明关联到订单", evidenceRefs: orderRefs,
    command: { type: "delivery.record", deliveryId: "d", orderId: "o", title: "使用说明", deliveredOn: f.today, artifactRef: "current-goal-output", progressPercent: 100 } }] }]);
  const premature = await f.send("/v2/plugins/opc/business/candidates", { workspaceId: f.workspace.id, expectedStreamVersion: 0, proposalKey: "delivery", origin: { goalId: delivery.detail.goal.id, planRevisionId: delivery.detail.plan.id, deliverySetId: delivery.detail.deliverySet.id, outputKey: "manual", outputDigest: delivery.detail.deliverySet.items[0].digest } });
  assert.equal(premature.body.code, "GOAL_ACCEPTANCE_REQUIRED");
  await f.acceptItem(delivery, "manual");
  const deliveryCandidate = await f.candidate(delivery, "manual", "delivery"), delivered = await f.decideCandidate(deliveryCandidate);
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  business = await f.readBusiness(); assert.equal(business.state.deliveries.length, 1); assert.equal(business.state.acceptances.length, 0); assert.equal(business.state.payments.length, 0);
  assert.match(business.state.deliveries[0].artifactRef, /^goal-output:\/\//u);
  business = await f.command({ type: "acceptance.record", acceptanceId: "ca", orderId: "o", deliveryIds: ["d"], acceptedOn: f.today, customerConfirmationRef: "synthetic-customer-acceptance", complete: true });
  assert.equal(business.summary.orders[0].accepted, true); assert.equal(business.summary.cashReceivedMinor, "0");
  business = await f.command({ type: "payment.record", paymentId: "payment", orderId: "o", amountMinor: "100000", receivedOn: f.today, sourceRef: "synthetic-bank-receipt" });
  assert.equal(business.summary.outstandingMinor, "0"); assert.equal(business.summary.cashReceivedMinor, "100000");
  const reviewRefs = [await f.source("order", "o")];
  const review = await f.runGoal(reviewRefs, [{ key: "review", text: "合成交付已由客户验收，实际收款已登记，下一次继续明确验收项。", proposals: [{ key: "review", title: "保存本期复盘", rationale: "依据本订单已发生事实", evidenceRefs: reviewRefs,
    command: { type: "review.record", reviewId: "review", period: { start: f.today, end: f.today }, explanation: "交付与资金事实分别核对", nextDecisions: ["保留独立客户验收依据"] } }] }]);
  await f.acceptItem(review, "review");
  const reviewCandidate = await f.candidate(review, "review", "review"), reviewed = await f.decideCandidate(reviewCandidate);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  business = await f.readBusiness(); assert.equal(business.state.reviews.length, 1); assert.equal(business.state.reviews[0].summary.cashReceivedMinor, "100000");
  assert.equal((await f.ok(`${delivery.path}?workspaceId=${f.workspace.id}`)).goal.status, "accepted");
});

test("真实成果生成的报价候选在产品价格更新后过期，历史阅读仍获准", async t => {
  const f = await fixture(t), refs = [await f.source("customer", "c"), await f.source("service", "s")];
  const goal = await f.runGoal(refs, [{ key: "quote", text: "按选定服务版本提出的报价候选。", proposals: [{ key: "quote", title: "报价建议", rationale: "引用已选定价格版本", evidenceRefs: refs,
    command: { type: "quote.create", quoteId: "q-old", customerId: "c", serviceId: "s", serviceVersion: 1, quantity: 1, discountMinor: "0", validUntil: f.later, dueOn: f.later } }] }]);
  await f.acceptItem(goal, "quote");
  const candidate = await f.candidate(goal, "quote", "quote");
  await f.command({ ...f.service, priceMinor: "200000" });
  const stale = await f.ok(`/v2/plugins/opc/business/candidates/${candidate.candidate.id}?workspaceId=${f.workspace.id}`);
  assert.equal(stale.availability.apply, false); assert.ok(stale.availability.staleReasons.length);
  const rejected = await f.decideCandidate(candidate); assert.equal(rejected.body.code, "OPC_CANDIDATE_STALE");
  assert.equal((await f.readBusiness()).state.quotes.length, 0);
  assert.equal((await f.ok(`${goal.path}?workspaceId=${f.workspace.id}`)).deliverySet.items[0].preview, goal.detail.deliverySet.items[0].preview);
  const turns = await f.ok(`/v2/workspaces/${f.workspace.id}/threads/${goal.detail.goal.threadId}/turns`);
  assert.ok(JSON.stringify(turns).includes('按选定服务版本提出的报价候选'));
});
