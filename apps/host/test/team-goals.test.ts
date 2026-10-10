// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CoordinationRunV2, GoalOutputRefV2, GoalTeamPlanProposalV2, TeamPlanNodeV1 } from "@mn/contracts";
import { AgentOsKernel, appendKernelEvent, KernelError } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage, DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from "@mn/storage";
import { getTeamTemplate, TEAM_DEFAULT_LIMITS } from "@mn/task-orchestration";
import { createGoal } from "../src/goals.js";
import { proposeTeamGoalPlan, replayTeamGoalPlan, getTeamGoal, startTeamGoal, advanceTeamGoal, reconcileTeamGoalUsage, commandTeamGoal, acceptTeamGoalDelivery,
  type TeamGoalApplicationPorts, type TeamGoalObservation } from "../src/team-goals.js";

const now = "2026-10-10T00:00:00.000Z";
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mn-team-goal-")), databaseFile = join(root, "kernel.sqlite");
  const cas = new FileCas({ rootDir: join(root, "cas") }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 13));
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 17), projectionJournal: { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES } });
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const kernel = new AgentOsKernel(store, { now: () => now }); await kernel.bootstrapLocal("bootstrap");
  const workspace = await kernel.createWorkspace("local", "local-owner", "workspace", { name: "团队目标", viewMode: "business", pluginIds: ["opc"] });
  const thread = await kernel.createThread("local", "local-owner", "thread", { workspaceId: workspace.id, subject: "目标", pluginId: "opc" });
  let sourceAllowed = true, ready = true, failStart = false;
  let observed: TeamGoalObservation = { status: "running" };
  const ports: TeamGoalApplicationPorts = {
    assertResources(_tx, _scope, refs) { if (!sourceAllowed && refs.length) throw new KernelError("SOURCE_REVOKED", "来源已撤销", "更新资料"); },
    assertPlan() { if (!ready) throw new KernelError("PLAN_UNAVAILABLE", "能力已变化", "重新规划"); },
    start(tx, { goal, plan }) {
      const run = kernel.createCoordinationRunInTransaction(tx, "local", "local-owner", `team:${plan.id}`, {
        id: `run:${plan.id}`, workspaceId: workspace.id, threadId: thread.id, aggregateType: "goal", aggregateId: goal.id,
        revisionId: plan.id, revisionDigest: plan.digest, grant: { toolIds: [], dataScopes: [], autoAllowedEffects: [] },
        budgets: [plan.budget], nodes: plan.nodes.map(node => ({ id: node.id, kind: node.kind, dependsOn: node.dependsOn,
          pluginId: node.kind === "agent" ? node.executor.pluginId : "opc", agentDefinitionId: node.kind === "agent" ? node.executor.agentDefinitionId : "control",
          modelBindingId: node.kind === "agent" ? node.executor.modelBindingId : "control", runnerId: "builtin",
          role: { toolIds: [], dataScopes: [], autoAllowedEffects: [] }, budget: node.kind === "agent" ? node.budget : { maxTokens: 0, maxCostMinorUnits: "0", currency: "CNY" } })),
        limits: { maxParallel: 3, maxNodes: 12, maxAttempts: 24, maxDepth: 1 }, deadlineAt: "2026-10-10T00:10:00.000Z",
      });
      if (failStart) throw new Error("start rollback"); return run;
    },
    advance() { return observed; },
    command(tx, { run }, command) {
      if (command === "decide") return run;
      return kernel.commandCoordinationRunInTransaction(tx, "local", "local-owner", randomUUID(), { runId: run.id, expectedStreamVersion: run.streamVersion,
        status: command === "pause" ? "paused" : command === "resume" ? "active" : "cancelled" });
    },
    assertAcceptance() { if (!sourceAllowed) throw new KernelError("SOURCE_REVOKED", "来源已撤销", "更新资料"); },
  };
  const base = { store, cas, keyProvider, protectedJournal: true, ports, tenantId: "local", workspaceId: workspace.id, principalId: "local-owner", now: () => now, id: (kind: string) => `${kind}-${randomUUID()}` };
  const source = { namespace: "asset", resourceId: "source", streamVersion: 1, digest: "a".repeat(64) };
  const created = await createGoal({ ...base, ports: { assertResources: ports.assertResources, assertPlan() {}, assertAcceptance() {}, start() { throw new Error("single dispatch forbidden"); }, observe() { throw new Error("single observe forbidden"); }, cancel() {} },
    threadId: thread.id, objective: "team-protected-objective-123", resourceRefs: [source], budget: { maxTokens: 100, maxCostMinorUnits: "10", currency: "CNY", maxDurationMs: 600000 },
    deliverables: [{ key: "report", title: "报告", required: true, criteria: [{ id: "evidence", description: "依据可回溯" }] }], idempotencyKey: "create" });
  const template = getTeamTemplate("research-summary");
  const proposal: GoalTeamPlanProposalV2 = { kind: "team-v1", template: { id: template.id, version: "1", digest: template.digest }, pluginId: "opc",
    domainInputDigest: "b".repeat(64), threadStreamVersion: thread.streamVersion, limits: TEAM_DEFAULT_LIMITS,
    nodes: template.nodes.map(node => ({ ...node, inputs: [], outputs: [], ...(node.kind === "agent" ? { roleId: node.roleId!, executor: {
      domainInputDigest: "b".repeat(64), threadStreamVersion: thread.streamVersion, pluginId: "opc", pluginVersion: "0.2.0", agentDefinitionId: "opc.fixture",
      modelBindingId: "model", modelConnectionStreamVersion: 1, model: "fixture", runnerId: "builtin", toolIds: [], dataScopes: [], autoAllowedEffects: [] },
      capabilityRef: { id: "fixture", version: "1", digest: "a".repeat(64) }, budget: { maxTokens: 20, maxCostMinorUnits: "2", currency: "CNY", maxDurationMs: 600000 } } : { mappings: [] }) })) as TeamPlanNodeV1[],
    deliverableBindings: [{ deliverableKey: "report", nodeId: "handoff", outputKey: "result" }] };
  const scoped = { ...base, goalId: created.goal.id };
  const version = () => store.transact("local", tx => tx.getProjection<{ streamVersion: number }>("goal.state", created.goal.id)!.streamVersion);
  const mutation = async () => ({ ...scoped, expectedStreamVersion: await version(), idempotencyKey: randomUUID() });
  const plan = async () => proposeTeamGoalPlan({ ...await mutation(), proposal });
  const start = async () => { const planned = await plan(); return startTeamGoal({ ...await mutation(), planRevisionId: planned.plan.id, planDigest: planned.plan.digest }); };
  const complete = async () => {
    const detail = await getTeamGoal(scoped);
    const output: GoalOutputRefV2 = { key: "report", digest: source.digest, resourceRef: { ...source, resourceId: "result" }, criteriaVersion: detail.goal.criteriaVersion,
      preview: "团队成果正文", sourceRefs: [source], checks: [{ checkId: "verified", status: "passed", evidenceRefs: [source] }] };
    observed = { status: "awaiting_acceptance", usage: { tokens: 10, costMinorUnits: "1", currency: "CNY" }, outputs: [output] };
    return advanceTeamGoal(await mutation());
  };
  return { ...scoped, workspace, created, databaseFile, proposal, mutation, plan, start, complete, version,
    setSource(value: boolean) { sourceAllowed = value; }, setReady(value: boolean) { ready = value; }, setFailStart(value: boolean) { failStart = value; }, setObserved(value: TeamGoalObservation) { observed = value; } };
}

test("team revisions remain immutable, explicit start is idempotent and crashes roll back the run", async t => {
  const f = await fixture(t), first = await f.plan(), second = await f.plan();
  assert.notEqual(first.plan.id, second.plan.id);
  await assert.rejects(startTeamGoal({ ...await f.mutation(), planRevisionId: first.plan.id, planDigest: first.plan.digest }), { code: "GOAL_PLAN_CHANGED" });
  const input = { ...await f.mutation(), planRevisionId: second.plan.id, planDigest: second.plan.digest };
  f.setFailStart(true); await assert.rejects(startTeamGoal(input), /rollback/);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("coordination.run").length), 0);
  f.setFailStart(false); const started = await startTeamGoal(input);
  assert.deepEqual(await startTeamGoal(input), started);
  assert.equal(await f.store.transact("local", tx => tx.listProjections("coordination.run").length), 1);
  await assert.rejects(f.plan(), { code: "GOAL_PLAN_IN_PROGRESS" });
});

test("current source grants, membership and scope gate reads, replay, start and continuation", async t => {
  const f = await fixture(t), planned = await f.plan();
  f.setReady(false); await assert.rejects(startTeamGoal({ ...await f.mutation(), planRevisionId: planned.plan.id, planDigest: planned.plan.digest }), { code: "PLAN_UNAVAILABLE" });
  f.setReady(true); f.setSource(false);
  await assert.rejects(getTeamGoal(f), { code: "SOURCE_REVOKED" });
  await assert.rejects(startTeamGoal({ ...await f.mutation(), planRevisionId: planned.plan.id, planDigest: planned.plan.digest }), { code: "SOURCE_REVOKED" });
  f.setSource(true); await startTeamGoal({ ...await f.mutation(), planRevisionId: planned.plan.id, planDigest: planned.plan.digest });
  await assert.rejects(getTeamGoal({ ...f, workspaceId: "other" }), { code: "WORKSPACE_ACCESS_DENIED" });
  await f.store.transact("local", tx => { const member = tx.getProjection<any>("membership", `${f.workspace.id}:local-owner`)!; tx.putProjection("membership", member.id, { ...member, streamVersion: member.streamVersion + 1 }); });
  await assert.rejects(advanceTeamGoal(await f.mutation()), { code: "GOAL_AUTHORIZATION_STALE" });
});

test("pause prevents progression, resume rechecks grants, cancel retains unknown usage", async t => {
  const f = await fixture(t); await f.start();
  const paused = await commandTeamGoal({ ...await f.mutation(), command: "pause" });
  assert.equal(paused.goal.status, "paused");
  f.setSource(false); await assert.rejects(commandTeamGoal({ ...await f.mutation(), command: "resume" }), { code: "SOURCE_REVOKED" });
  const cancelled = await commandTeamGoal({ ...await f.mutation(), command: "cancel" });
  assert.equal(cancelled.goal.status, "needs_reconciliation"); assert.equal(cancelled.deliverySet, null);
  assert.deepEqual(await commandTeamGoal({ ...await f.mutation(), command: "cancel" }), cancelled);
  f.setSource(true); await assert.rejects(commandTeamGoal({ ...await f.mutation(), command: "resume" }), { code: "GOAL_RESUME_INVALID" });
});

test("unknown or exceeded usage cannot create an acceptable delivery", async t => {
  const f = await fixture(t); await f.start();
  f.setObserved({ status: "awaiting_acceptance", outputs: [] });
  assert.equal((await advanceTeamGoal(await f.mutation())).goal.status, "needs_reconciliation");
  f.setObserved({ status: "awaiting_acceptance", usage: { tokens: 101, costMinorUnits: "1", currency: "CNY" }, outputs: [] });
  assert.equal((await advanceTeamGoal(await f.mutation())).goal.reasonCode, "GOAL_BUDGET_OVERRUN");
});

test("start rejects a run whose persisted budget, runner or node authority differs from the plan", async t => {
  for (const changed of ["budget", "runner", "authority"] as const) {
    const f = await fixture(t), planned = await f.plan(), start = f.ports.start;
    const ports: TeamGoalApplicationPorts = { ...f.ports, start(tx, context) {
      const run = start(tx, context), corrupted: CoordinationRunV2 = { ...run,
        ...(changed === "budget" ? { budgets: run.budgets.map(budget => ({ ...budget, maxCostMinorUnits: "1000" })) } : {}),
        ...(changed === "runner" ? { nodes: run.nodes.map(node => ({ ...node, runnerId: "codex-cli" as const })) } : {}),
        ...(changed === "authority" ? { nodes: run.nodes.map(node => ({ ...node, role: { ...node.role, toolIds: ["secret.write"] } })) } : {}),
      }; tx.putProjection("coordination.run", corrupted.id, corrupted); return corrupted;
    } };
    await assert.rejects(startTeamGoal({ ...await f.mutation(), ports, planRevisionId: planned.plan.id, planDigest: planned.plan.digest }), { code: "GOAL_EXECUTION_INVALID" });
  }
});

test("failed evidence and changed criteria are rejected before delivery acceptance", async t => {
  const f = await fixture(t); await f.start(); const delivered = await f.complete();
  f.setObserved({ status: "awaiting_acceptance", usage: { tokens: 10, costMinorUnits: "1", currency: "CNY" },
    outputs: delivered.deliverySet!.items.map(item => ({ ...item, checks: item.checks.map(check => ({ ...check, status: "failed" })) })) });
  assert.equal((await advanceTeamGoal(await f.mutation())).goal.reasonCode, "GOAL_DELIVERY_INCOMPLETE");
  await assert.rejects(acceptTeamGoalDelivery({ ...await f.mutation(), deliverySetId: delivered.deliverySet!.id, criteriaVersion: "stale", items: [] }), { code: "GOAL_CRITERIA_CHANGED" });
});

test("acceptance binds exact criteria and sources; events rebuild the same plan and receipt", async t => {
  const f = await fixture(t); await f.start(); const delivered = await f.complete();
  const input = { ...await f.mutation(), deliverySetId: delivered.deliverySet!.id, criteriaVersion: delivered.goal.criteriaVersion,
    items: delivered.deliverySet!.items.map(item => ({ key: item.key, digest: item.digest, reviewedCriterionIds: ["evidence"] })) };
  await assert.rejects(acceptTeamGoalDelivery({ ...input, items: input.items.map(item => ({ ...item, reviewedCriterionIds: [] })) }), { code: "GOAL_CRITERIA_NOT_REVIEWED" });
  f.setSource(false); await assert.rejects(acceptTeamGoalDelivery(input), { code: "SOURCE_REVOKED" }); f.setSource(true);
  const accepted = await acceptTeamGoalDelivery(input); assert.equal(accepted.goal.status, "accepted");
  const raw = new DatabaseSync(f.databaseFile);
  try {
    for (const table of ["events", "projections", "idempotency", "outbox"]) assert.equal(JSON.stringify(raw.prepare(`select * from ${table}`).all()).includes("team-protected-objective-123"), false);
    raw.exec("delete from projections; delete from idempotency"); await f.store.rebuildProjections("local");
    assert.deepEqual((await getTeamGoal(f)).plan, accepted.plan);
    assert.deepEqual(await acceptTeamGoalDelivery(input), accepted);
  } finally { raw.close(); }
});

test("competition commits one authorization and missing idempotency or stale goal version is rejected", async t => {
  const f = await fixture(t), planned = await f.plan();
  const input = { ...await f.mutation(), planRevisionId: planned.plan.id, planDigest: planned.plan.digest };
  await assert.rejects(startTeamGoal({ ...input, idempotencyKey: " " }), { code: "IDEMPOTENCY_KEY_REQUIRED" });
  const results = await Promise.allSettled([startTeamGoal(input), startTeamGoal({ ...input, idempotencyKey: "competitor" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  await assert.rejects(advanceTeamGoal({ ...await f.mutation(), expectedStreamVersion: 1 }), { code: "STREAM_VERSION_CONFLICT" });
});

test("plan replay binds explicit template/model intent and still checks revoked sources", async t => {
  const f = await fixture(t), input = { ...await f.mutation(), proposal: f.proposal,
    planRequest: { kind: "team-v1", templateId: "research-summary", templateVersion: "1", modelBindingId: "model" } };
  const planned = await proposeTeamGoalPlan(input);
  f.setReady(false); assert.deepEqual(await replayTeamGoalPlan(input, input.planRequest), planned);
  await assert.rejects(proposeTeamGoalPlan({ ...input, planRequest: { ...input.planRequest, modelBindingId: "other" } }), { code: "GOAL_PLAN_INVALID" });
  f.setSource(false); await assert.rejects(replayTeamGoalPlan(input, input.planRequest), { code: "SOURCE_REVOKED" });
});

test("revoked sources still settle terminal usage without reading or accepting output content", async t => {
  const f = await fixture(t); await f.start(); f.setSource(false);
  let accountingCalls = 0;
  const ports: TeamGoalApplicationPorts = { ...f.ports, advance(_tx, context) {
    assert.equal(context.accountingOnly, true); accountingCalls++;
    return { status: "awaiting_acceptance", usage: { tokens: 7, costMinorUnits: "1", currency: "CNY" }, outputs: [{
      key: "ignored", preview: "x".repeat(600_000), digest: "a".repeat(64), criteriaVersion: "ignored",
      resourceRef: { namespace: "asset", resourceId: "ignored", streamVersion: 1 }, sourceRefs: [], checks: [],
    }] };
  } };
  await reconcileTeamGoalUsage({ ...f, ports });
  const stored = await f.store.transact("local", tx => tx.getProjection<any>("goal.state", f.goalId));
  assert.equal(accountingCalls, 1); assert.equal(stored.reservation.status, "settled"); assert.equal(stored.reservation.actual.tokens, 7);
  assert.equal(stored.status, "needs_reconciliation"); assert.equal(stored.reasonCode, "GOAL_AUTHORIZATION_STALE");
  assert.equal(await f.store.transact("local", tx => tx.listProjections("goal.deliverySet").length), 0);
});
