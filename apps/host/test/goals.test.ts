// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Execution, GoalDetailV2, GoalExecutionObservationV2, GoalPlanProposalV2 } from "@mn/contracts";
import { AgentOsKernel, appendKernelEvent, KernelError } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage, DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from "@mn/storage";
import { createGoal, getGoal, getGoalForCoordination, readGoalForAccounting, reconcileGoalUsage, observeGoalInBackground, proposeGoalPlan, startGoal, advanceGoal, cancelGoal, acceptGoalDelivery, type GoalApplicationPorts } from "../src/goals.js";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mn-s1-goal-")), databaseFile = join(root, "kernel.sqlite");
  const cas = new FileCas({ rootDir: join(root, "cas") }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 13));
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 17), projectionJournal: { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES } });
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const kernel = new AgentOsKernel(store);
  await kernel.bootstrapLocal("bootstrap");
  const workspace = await kernel.createWorkspace("local", "local-owner", "workspace", { name: "目标测试", viewMode: "business", pluginIds: ["opc"] });
  const thread = await kernel.createThread("local", "local-owner", "thread", { workspaceId: workspace.id, subject: "验证目标", pluginId: "opc" });
  let failStart = false, ready = true, sourceAllowed = true;
  let observation: Omit<GoalExecutionObservationV2, "generation" | "executionStreamVersion"> = {};
  const ports: GoalApplicationPorts = {
    assertResources(tx, _scope, refs) {
      if (!sourceAllowed) throw new KernelError("SOURCE_REVOKED", "来源已撤销", "重新选择来源");
      for (const ref of refs) {
        const value = tx.getProjection<any>(ref.namespace, ref.resourceId);
        if (!value || value.workspaceId !== workspace.id || value.streamVersion !== ref.streamVersion || (ref.digest && value.digest !== ref.digest)) throw new KernelError("GOAL_RESOURCE_DENIED", "资料版本无效", "刷新资料");
      }
    },
    assertPlan() { if (!ready) throw new KernelError("PLAN_UNAVAILABLE", "执行配置已变化", "重新规划"); },
    start(tx, { goal, plan }) {
      const result = kernel.submitTurnInTransaction(tx, "local", "local-owner", `goal:${plan.id}`, {
        workspaceId: workspace.id, threadId: thread.id, expectedStreamVersion: plan.threadStreamVersion,
        message: goal.objective, agentDefinitionId: plan.agentDefinitionId, modelBindingId: plan.modelBindingId,
        executionPrincipalId: "agent:opc", authority: { workspaceId: workspace.id, principalId: "agent:opc", toolIds: plan.toolIds,
          dataScopes: plan.dataScopes, autoAllowedEffects: plan.autoAllowedEffects, budget: { ...plan.budget, maxSubagents: 0, maxSubagentDepth: 0 } },
      });
      if (failStart) throw new Error("dispatch rolled back");
      return result;
    },
    observe(_tx, { execution }) { return { ...observation, generation: execution.generation, executionStreamVersion: execution.streamVersion }; },
    assertAcceptance() { if (!sourceAllowed) throw new KernelError("SOURCE_REVOKED", "来源已撤销", "重新选择来源"); },
    cancel(tx, { execution }) { if (!["completed", "failed", "cancelled"].includes(execution.status)) kernel.commandExecutionInTransaction(tx, "local", "local-owner", `cancel:${execution.id}`, execution.id, execution.streamVersion, "cancel"); },
  };
  const base = { store, cas, keyProvider, protectedJournal: true, ports, tenantId: "local", workspaceId: workspace.id, principalId: "local-owner", now: () => "2026-10-09T10:00:00.000Z", id: (kind: string) => `${kind}-${randomUUID()}` };
  const created = await createGoal({ ...base, threadId: thread.id, objective: "goal-protected-objective-123", resourceRefs: [],
    budget: { maxTokens: 100, maxCostMinorUnits: "10", currency: "CNY", maxDurationMs: 10000 },
    deliverables: [{ key: "report", title: "报告", required: true, criteria: [{ id: "evidence", description: "结论逐项有来源" }] }], idempotencyKey: "create" });
  const scoped = { ...base, goalId: created.goal.id };
  const read = () => getGoal(scoped);
  const mutation = async () => ({ ...scoped, expectedStreamVersion: (await getGoalForCoordination(scoped)).goal.streamVersion, idempotencyKey: randomUUID() });
  const proposal: GoalPlanProposalV2 = { domainInputDigest: "b".repeat(64), threadStreamVersion: thread.streamVersion, pluginId: "opc", pluginVersion: "0.2.0", agentDefinitionId: "opc.fixture", modelBindingId: "model", modelConnectionStreamVersion: 1, model: "fixture", runnerId: "builtin", toolIds: [], dataScopes: [], autoAllowedEffects: [] };
  const plan = () => mutation().then(options => proposeGoalPlan({ ...options, proposal }));
  const start = async (detail: GoalDetailV2) => startGoal({ ...await mutation(), planRevisionId: detail.plan!.id, planDigest: detail.plan!.digest });
  const complete = async (detail: GoalDetailV2, usage = { tokens: 20, costMinorUnits: "2", currency: "CNY" }) => {
    let execution = await store.transact("local", tx => tx.getProjection<Execution>("execution", detail.goal.executionRef!.executionId)!);
    execution = await kernel.commandExecution("local", "local-owner", "run", execution.id, execution.streamVersion, "start");
    await kernel.commandExecution("local", "local-owner", "done", execution.id, execution.streamVersion, "complete");
    const ref = { namespace: "fixture.result", resourceId: "result", streamVersion: 1, digest: "a".repeat(64) };
    await store.transact("local", tx => {
      tx.putProjection(ref.namespace, ref.resourceId, { tenantId: "local", workspaceId: workspace.id, streamVersion: 1, digest: ref.digest });
      appendKernelEvent(tx, { tenantId: "local", aggregateType: ref.namespace, aggregateId: ref.resourceId, expectedStreamVersion: 0, type: "fixture.result", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} });
    });
    observation = { usage, outputs: [{ key: "report", resourceRef: ref, digest: ref.digest, criteriaVersion: detail.goal.criteriaVersion, preview: "测试报告正文",
      sourceRefs: [ref], checks: [{ checkId: "fixture.programmatic", status: "passed", evidenceRefs: [ref] }] }] };
  };
  const accept = async (detail: GoalDetailV2, reviewedCriterionIds = ["evidence"]) => acceptGoalDelivery({ ...await mutation(), deliverySetId: detail.deliverySet!.id,
    criteriaVersion: detail.goal.criteriaVersion, items: detail.deliverySet!.items.map(item => ({ key: item.key, digest: item.digest, reviewedCriterionIds })) });
  return { ...scoped, created, databaseFile, kernel, read, mutation, proposal, plan, start, complete, accept,
    failStart(value: boolean) { failStart = value; }, ready(value: boolean) { ready = value; }, sourceAllowed(value: boolean) { sourceAllowed = value; },
    observation(value: typeof observation) { observation = value; }, getObservation: () => observation };
}

test("目标与不可变计划从受保护事件重建，旧计划不能启动", async t => {
  const f = await fixture(t), first = await f.plan(), second = await f.plan();
  assert.notEqual(first.plan!.id, second.plan!.id);
  await assert.rejects(f.start(first), { code: "GOAL_PLAN_CHANGED" });
  const raw = new DatabaseSync(f.databaseFile);
  try {
    for (const table of ["events", "projections", "idempotency", "outbox"]) assert.equal(JSON.stringify(raw.prepare(`select * from ${table}`).all()).includes("goal-protected-objective-123"), false);
    raw.exec("delete from projections; delete from idempotency");
    await f.store.rebuildProjections("local");
    assert.equal((await f.read()).goal.objective, f.created.goal.objective);
    assert.deepEqual(await f.store.transact("local", tx => tx.getProjection("goal.plan", first.plan!.id)), first.plan);
  } finally { raw.close(); }
});

test("派发失败同事务回滚预算、Execution 与 Job；幂等重试不重复派发", async t => {
  const f = await fixture(t), planned = await f.plan();
  f.failStart(true);
  await assert.rejects(f.start(planned), /dispatch rolled back/u);
  assert.equal((await f.read()).goal.reservation, undefined);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("execution").length), 0);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("job").length), 0);
  f.failStart(false);
  const options = { ...await f.mutation(), planRevisionId: planned.plan!.id, planDigest: planned.plan!.digest };
  const result = await startGoal(options), replay = await startGoal(options);
  assert.deepEqual(replay, result);
  assert.equal(result.goal.reservation!.status, "reserved");
  assert.equal(await f.store.transact("local", tx => tx.listProjections("job").length), 1);
  await assert.rejects(f.plan(), { code: "GOAL_PLAN_IN_PROGRESS" });
});

test("计划重放绑定原请求，在会话变化后返回原计划且新请求仍校验配置", async t => {
  const f = await fixture(t);
  const options = { ...await f.mutation(), proposal: f.proposal, planRequest: { modelBindingId: f.proposal.modelBindingId } };
  const planned = await proposeGoalPlan(options);
  await f.start(planned);
  const threadVersion = await f.store.transact("local", tx => tx.getProjection<any>("thread", f.created.goal.threadId).streamVersion);
  const refreshed = { ...options, proposal: { ...f.proposal, threadStreamVersion: threadVersion, modelConnectionStreamVersion: 2 } };
  f.ready(false);
  assert.deepEqual(await proposeGoalPlan(refreshed), planned);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("goal.plan").length), 1);
  const changed = { ...refreshed, planRequest: { modelBindingId: "other" }, proposal: { ...refreshed.proposal, modelBindingId: "other" } };
  await assert.rejects(proposeGoalPlan(changed), { code: "IDEMPOTENCY_KEY_REUSED" });
  const mismatch = { ...refreshed, planRequest: { modelBindingId: "other" } };
  await assert.rejects(proposeGoalPlan(mismatch), { code: "GOAL_PLAN_INVALID" });
  f.sourceAllowed(false);
  await assert.rejects(proposeGoalPlan(refreshed), { code: "SOURCE_REVOKED" });

  const fresh = await fixture(t);
  fresh.ready(false);
  const newRequest = { ...await fresh.mutation(), proposal: fresh.proposal, planRequest: { modelBindingId: fresh.proposal.modelBindingId } };
  await assert.rejects(proposeGoalPlan(newRequest), { code: "PLAN_UNAVAILABLE" });
  assert.equal(await fresh.store.transact("local", tx => tx.listProjections("goal.plan").length), 0);
});

test("并发启动仅提交一次，配置变化拒绝旧计划", async t => {
  const f = await fixture(t), planned = await f.plan();
  f.ready(false); await assert.rejects(f.start(planned), { code: "PLAN_UNAVAILABLE" }); f.ready(true);
  const options = { ...await f.mutation(), planRevisionId: planned.plan!.id, planDigest: planned.plan!.digest };
  const values = await Promise.allSettled([startGoal(options), startGoal({ ...options, idempotencyKey: "other" })]);
  assert.equal(values.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("job").length), 1);
});

test("没有新执行事实的推进保留目标版本，幂等回执仍可重建", async t => {
  const f = await fixture(t), started = await f.start(await f.plan());
  const options = await f.mutation(), observed = await advanceGoal(options);
  assert.equal(observed.goal.streamVersion, started.goal.streamVersion);
  assert.deepEqual(await advanceGoal(options), observed);
});

test("接收绑定标准和成果版本，必须逐条确认标准且重查来源", async t => {
  const f = await fixture(t), started = await f.start(await f.plan()); await f.complete(started);
  const delivered = await advanceGoal(await f.mutation());
  assert.equal(delivered.goal.status, "awaiting_acceptance");
  await assert.rejects(f.accept(delivered, []), { code: "GOAL_CRITERIA_NOT_REVIEWED" });
  await assert.rejects(acceptGoalDelivery({ ...await f.mutation(), deliverySetId: delivered.deliverySet!.id, criteriaVersion: "stale", items: [] }), { code: "GOAL_CRITERIA_CHANGED" });
  f.sourceAllowed(false); await assert.rejects(f.accept(delivered), { code: "SOURCE_REVOKED" }); f.sourceAllowed(true);
  const accepted = await f.accept(delivered);
  assert.equal(accepted.goal.status, "accepted");
  assert.equal(await f.store.transact("local", tx => tx.listProjections("goal.deliveryAcceptance").length), 1);
});

for (const invalid of ["missing", "failed", "criteria", "unknown", "overrun"] as const) test(`成果或用量 ${invalid} 不会成为可接受交付`, async t => {
  const f = await fixture(t), started = await f.start(await f.plan()); await f.complete(started);
  const observation = f.getObservation();
  if (invalid === "missing") f.observation({ ...observation, outputs: [] });
  if (invalid === "failed") f.observation({ ...observation, outputs: observation.outputs!.map(output => ({ ...output, checks: output.checks.map(check => ({ ...check, status: "failed" })) })) });
  if (invalid === "criteria") f.observation({ ...observation, outputs: observation.outputs!.map(output => ({ ...output, criteriaVersion: "stale" })) });
  if (invalid === "unknown") f.observation({ outputs: observation.outputs });
  if (invalid === "overrun") f.observation({ ...observation, usage: { tokens: 101, costMinorUnits: "2", currency: "CNY" } });
  if (invalid === "criteria") await assert.rejects(advanceGoal(await f.mutation()), { code: "GOAL_CRITERIA_CHANGED" });
  else assert.notEqual((await advanceGoal(await f.mutation())).goal.status, "awaiting_acceptance");
});

test("取消原执行与目标同事务提交，迟到计量只结算原预留", async t => {
  const f = await fixture(t), started = await f.start(await f.plan());
  const cancelled = await cancelGoal(await f.mutation());
  assert.equal(cancelled.goal.status, "needs_reconciliation");
  assert.equal((await f.store.transact("local", tx => tx.getProjection<Execution>("execution", started.goal.executionRef!.executionId)))!.status, "cancelled");
  const control = await f.store.transact("local", tx => tx.getProjection<any>("execution-control", started.goal.executionRef!.executionId));
  assert.equal(control?.command, "cancel");
  assert.equal(control?.generation, started.goal.executionRef!.generation);
  const raw = new DatabaseSync(f.databaseFile);
  try {
    raw.exec("delete from projections where namespace = 'execution-control'");
    await f.store.rebuildProjections("local");
    assert.deepEqual(await f.store.transact("local", tx => tx.getProjection("execution-control", started.goal.executionRef!.executionId)), control);
  } finally { raw.close(); }
  f.observation({ usage: { tokens: 0, costMinorUnits: "0", currency: "CNY" } });
  const settled = await advanceGoal(await f.mutation());
  assert.equal(settled.goal.status, "cancelled");
  assert.equal(settled.goal.reservation!.status, "settled");
  assert.equal(await f.store.transact("local", tx => tx.listProjections("job").length), 1);
});

test("未知执行收到取消意图后保持待核对，核对终态之前不得显示已取消", async t => {
  const f = await fixture(t), started = await f.start(await f.plan());
  await f.store.transact("local", tx => {
    const execution = tx.getProjection<Execution>("execution", started.goal.executionRef!.executionId)!;
    tx.putProjection("execution", execution.id, { ...execution, status: "needs_reconciliation", streamVersion: execution.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "execution", aggregateId: execution.id, expectedStreamVersion: execution.streamVersion,
      type: "fixture.unknown", actorId: "local-owner", generation: execution.generation, correlationId: randomUUID(), publicPayload: {} });
  });
  const original = f.ports.cancel; f.ports.cancel = () => {};
  const pending = await cancelGoal(await f.mutation());
  assert.equal(pending.goal.status, "needs_reconciliation");
  assert.ok(pending.goal.cancellationRequestedAt);
  assert.equal((await advanceGoal(await f.mutation())).goal.status, "needs_reconciliation");
  f.ports.cancel = original;
  const execution = await f.store.transact("local", tx => tx.getProjection<Execution>("execution", started.goal.executionRef!.executionId)!);
  await f.kernel.commandExecution("local", "local-owner", "resolved", execution.id, execution.streamVersion, "reconcile");
  f.observation({ usage: { tokens: 0, costMinorUnits: "0", currency: "CNY" } });
  const settled = await advanceGoal(await f.mutation());
  assert.equal(settled.goal.status, "cancelled");
  assert.equal(settled.goal.reservation!.status, "settled");
});

test("来源撤权后公开读取和旧回执不能回显正文，内部取消与用量仍可提交", async t => {
  const f = await fixture(t), started = await f.start(await f.plan()); await f.complete(started);
  const refresh = await f.mutation(), delivered = await advanceGoal(refresh);
  assert.equal(delivered.deliverySet!.items[0]!.preview, "测试报告正文");
  const acceptance = { ...await f.mutation(), deliverySetId: delivered.deliverySet!.id, criteriaVersion: delivered.goal.criteriaVersion,
    items: delivered.deliverySet!.items.map(item => ({ key: item.key, digest: item.digest, reviewedCriterionIds: ["evidence"] })) };
  await acceptGoalDelivery(acceptance);
  f.sourceAllowed(false);
  await assert.rejects(f.read(), { code: "SOURCE_REVOKED" });
  await assert.rejects(acceptGoalDelivery(acceptance), { code: "SOURCE_REVOKED" });
  assert.equal((await getGoalForCoordination(f)).deliverySet, null);

  const second = await fixture(t), secondStarted = await second.start(await second.plan()); await second.complete(secondStarted);
  await advanceGoal(await second.mutation());
  const cancellation = await second.mutation(); second.sourceAllowed(false);
  const cancelled = await cancelGoal(cancellation);
  assert.equal(cancelled.goal.status, "cancelled"); assert.equal(cancelled.deliverySet, null);
  assert.equal((await cancelGoal(cancellation)).deliverySet, null);
  assert.equal((await advanceGoal(await second.mutation())).goal.reservation!.status, "settled");
});

test("后台仅记账入口在成员与来源撤权后结算原用量，不读取成果或新增执行", async t => {
  const f = await fixture(t), started = await f.start(await f.plan()); await f.complete(started);
  const original = f.ports.observe;
  f.ports.observe = (tx, context) => {
    assert.equal(context.accountingOnly, true);
    const observed = original(tx, context); return { executionStreamVersion: observed.executionStreamVersion, generation: observed.generation, usage: observed.usage };
  };
  await f.store.transact("local", tx => {
    const id = `${f.workspaceId}:local-owner`, membership = tx.getProjection<any>("membership", id)!;
    tx.putProjection("membership", id, { ...membership, workspaceRole: "viewer", streamVersion: membership.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "workspaceMembership", aggregateId: id, expectedStreamVersion: membership.streamVersion,
      type: "fixture.membership_revoked", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  f.sourceAllowed(false);
  await assert.rejects(f.read(), { code: "WORKSPACE_ACCESS_DENIED" });
  await reconcileGoalUsage(f);
  const settled = await readGoalForAccounting(f);
  assert.equal(settled.goal.reservation!.status, "settled");
  assert.equal(settled.goal.reservation!.actual!.tokens, 20);
  assert.equal(settled.goal.status, "needs_reconciliation");
  assert.equal(settled.goal.reasonCode, "GOAL_AUTHORIZATION_STALE");
  assert.equal(settled.deliverySet, null);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("goal.deliverySet").length), 0);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("execution").length), 1);
  const version = settled.goal.streamVersion; await reconcileGoalUsage(f);
  assert.equal((await readGoalForAccounting(f)).goal.streamVersion, version);
});

test("其他操作者不能启动创建者的目标", async t => {
  const f = await fixture(t), planned = await f.plan();
  await f.store.transact("local", tx => {
    const principal = tx.getProjection<any>("principal", "local-owner")!;
    tx.putProjection("principal", "other", { ...principal, id: "other", streamVersion: 1 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "principal", aggregateId: "other", expectedStreamVersion: 0,
      type: "fixture.operator", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  await f.kernel.setWorkspaceMembership("local", "local-owner", "member", f.workspaceId, "other", 0, "operator");
  await assert.rejects(startGoal({ ...await f.mutation(), principalId: "other", planRevisionId: planned.plan!.id, planDigest: planned.plan!.digest }), { code: "GOAL_CONTROLLER_REQUIRED" });
  assert.equal(await f.store.transact("local", tx => tx.listProjections("execution").length), 0);
});

test("同一会话已有活动执行或未结算目标时，另一个新计划不能抢占", async t => {
  const f = await fixture(t), planned = await f.plan(), started = await f.start(planned);
  const second = await createGoal({ ...f, threadId: f.created.goal.threadId, objective: "第二个目标", resourceRefs: [],
    budget: f.created.goal.budget, deliverables: f.created.goal.deliverables, idempotencyKey: "second-goal" });
  const version = await f.store.transact("local", tx => tx.getProjection<any>("thread", second.goal.threadId).streamVersion);
  const next = await proposeGoalPlan({ ...f, goalId: second.goal.id, expectedStreamVersion: second.goal.streamVersion,
    idempotencyKey: "second-plan", proposal: { ...f.proposal, threadStreamVersion: version } });
  const startSecond = () => startGoal({ ...f, goalId: second.goal.id, expectedStreamVersion: next.goal.streamVersion,
    idempotencyKey: "second-start", planRevisionId: next.plan!.id, planDigest: next.plan!.digest });
  await assert.rejects(startSecond(), { code: "GOAL_THREAD_BUSY" });
  await f.complete(started);
  await assert.rejects(startSecond(), { code: "GOAL_THREAD_BUSY" });
  assert.equal(await f.store.transact("local", tx => tx.listProjections("execution").length), 1);
});

test("后台重复观察不追加事件或回执，用户显式刷新仍保留幂等回执", async t => {
  const f = await fixture(t), started = await f.start(await f.plan());
  const raw = new DatabaseSync(f.databaseFile);
  const counts = () => ["events", "idempotency", "outbox", "projections"].map(table => Number(raw.prepare(`select count(*) as count from ${table}`).get()!.count));
  try {
    const before = counts();
    for (let attempt = 0; attempt < 3; attempt++) await observeGoalInBackground(f);
    assert.deepEqual(counts(), before);
    assert.equal((await f.read()).goal.streamVersion, started.goal.streamVersion);
    const manual = await f.mutation(), observed = await advanceGoal(manual), afterManual = counts();
    assert.ok(afterManual[0]! > before[0]!);
    assert.equal(afterManual[1], before[1]! + 1);
    assert.deepEqual(await advanceGoal(manual), observed);
    assert.deepEqual(counts(), afterManual);
    await f.complete(started);
    await observeGoalInBackground(f);
    const completed = await f.read(), afterCompletion = counts();
    assert.equal(completed.goal.status, "awaiting_acceptance");
    for (let attempt = 0; attempt < 3; attempt++) await observeGoalInBackground(f);
    assert.deepEqual(counts(), afterCompletion);
    assert.equal((await f.read()).goal.streamVersion, completed.goal.streamVersion);
  } finally { raw.close(); }
});
