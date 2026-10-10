// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { CoordinationAttemptV2, Execution, GoalDeliverySetV2, GoalPlanRevisionV2, GoalPlanV2, GoalV2, Job } from '@mn/contracts';
import { AgentOsKernel, appendKernelEvent, KernelError, sha256 } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage, DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from '@mn/storage';
import { createProtectedRuntimeStore } from '@mn/worker';
import { PersistentModelBudget } from '@mn/agent-runtime';
import { getGoalDeliveryReview, decideGoalDelivery, previewGoalRework, confirmGoalRework, type GoalDeliveryApplicationPorts } from '../src/goal-delivery-service.js';

const now = '2026-10-10T00:00:00.000Z';
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mn-delivery-service-'));
  const cas = new FileCas({ rootDir: join(root, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 13));
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: Buffer.alloc(32, 17), now: () => new Date(now), projectionJournal: { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const kernel = new AgentOsKernel(store, { now: () => now }); await kernel.bootstrapLocal('bootstrap');
  const ws = await kernel.createWorkspace('local', 'local-owner', 'ws', { name: '交付', viewMode: 'business', pluginIds: ['opc'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: ws.id, subject: '交付', pluginId: 'opc' });
  const budget = { currency: 'CNY', maxTokens: 100, maxCostMinorUnits: '100', maxDurationMs: 3_600_000 };
  const source = { namespace: 'asset', resourceId: 'source', streamVersion: 1, digest: 'a'.repeat(64) };
  const deliverables = ['one', 'two'].map(key => ({ key, title: key, required: true, criteria: [{ id: 'check', description: '完成指定内容' }] }));
  const basePlan = { id: 'legacy-plan', goalId: 'goal', threadId: thread.id, revision: 1, inputVersion: 1, criteriaVersion: sha256(deliverables), budget,
    resourceRefs: [source], deliverables, createdAt: now, domainInputDigest: 'b'.repeat(64), threadStreamVersion: thread.streamVersion, pluginId: 'opc' as const,
    pluginVersion: '0.2.0', agentDefinitionId: 'opc.agent', modelBindingId: 'model', modelConnectionStreamVersion: 1, model: 'fixture', runnerId: 'builtin' as const,
    toolIds: [], dataScopes: [], autoAllowedEffects: [] };
  const plan: GoalPlanRevisionV2 = { ...basePlan, digest: sha256(basePlan) };
  const execution = await store.transact('local', tx => kernel.submitTurnInTransaction(tx, 'local', 'local-owner', 'initial', {
    workspaceId: ws.id, threadId: thread.id, expectedStreamVersion: thread.streamVersion, message: '交付', executionPrincipalId: 'agent:opc', agentDefinitionId: 'opc.agent', modelBindingId: 'model', runnerId: 'builtin',
    coordination: { aggregateType: 'goal', aggregateId: 'goal', revisionId: plan.id },
    authority: { workspaceId: ws.id, principalId: 'agent:opc', toolIds: [], dataScopes: [], autoAllowedEffects: [], budget: { ...budget, maxSubagents: 0, maxSubagentDepth: 0 } },
  }));
  const runtime = createProtectedRuntimeStore({ store, cas, keyProvider, tenantId: 'local', workspaceId: ws.id });
  const modelBudget = new PersistentModelBudget({ store: runtime, executionId: execution.id, limits: budget });
  await modelBudget.reserve({ id: 'initial-usage', requestDigest: 'a'.repeat(64), inputTokenLimit: 5, maxOutputTokens: 5,
    rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '1000000000', cachedInputNanoMinorUnitsPerToken: '1000000000', outputNanoMinorUnitsPerToken: '1000000000' } });
  await modelBudget.settle('initial-usage', { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5 });
  let revoked = false, failStart = false;
  const ports: GoalDeliveryApplicationPorts = {
    assertResources() { if (revoked) throw new KernelError('SOURCE_REVOKED', '来源已撤销', '更新资料'); },
    assertHistorical() { if (revoked) throw new KernelError('SOURCE_REVOKED', '来源已撤销', '更新资料'); }, assertPlan() {},
    preparePlan(_tx, { plan }) { return plan; }, resolveReuse() { throw new Error('single has no reusable nodes'); },
    start(tx, { goal, plan, reworkAdmission: admission }) {
      const run = kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', `start:${plan.id}`, {
        id: `run:${plan.id}`, workspaceId: ws.id, threadId: thread.id, aggregateType: 'goal', aggregateId: goal.id, revisionId: plan.id, revisionDigest: plan.digest,
        grant: { toolIds: [], dataScopes: [], autoAllowedEffects: [] }, budgets: [budget],
        nodes: plan.nodes.map(node => ({ id: node.id, kind: node.kind, dependsOn: node.dependsOn, pluginId: 'opc', agentDefinitionId: 'opc.agent', modelBindingId: 'model', runnerId: 'builtin',
          role: { toolIds: [], dataScopes: [], autoAllowedEffects: [] }, budget: node.kind === 'agent' ? node.budget : { ...budget, maxTokens: 0, maxCostMinorUnits: '0' } })),
        limits: { maxParallel: 3, maxNodes: 12, maxAttempts: 24, maxDepth: 1 }, deadlineAt: admission.deadlineAt, reuses: admission.reuses,
        initialAccounting: admission.initialAccounting, expectedGroupStreamVersion: admission.expectedGroupStreamVersion,
        rework: { sourceRevisionId: admission.rework.sourcePlanRevisionId, decisionDigest: sha256(admission.rework) },
      });
      if (failStart) throw new Error('atomic rollback'); return run;
    },
  };
  const base = { store, cas, keyProvider, protectedJournal: true, ports, tenantId: 'local', workspaceId: ws.id, principalId: 'local-owner', goalId: 'goal', now: () => now, id: (kind: string) => `${kind}-${randomUUID()}` };
  const completed = async (original = false) => {
    const currentExecution = original ? execution : await store.transact('local', tx => {
      const goal = tx.getProjection<GoalV2>('goal.state', 'goal')!, run = tx.getProjection<any>('coordination.run', goal.coordinationRef!.runId)!;
      return kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', `admit:${run.id}`, { runId: run.id, expectedStreamVersion: run.streamVersion, nodeId: 'execute', attempt: 1, message: '修订' }).execution;
    });
    const claimed = await store.claimJob('worker', now); assert.ok(claimed); assert.equal(claimed.payload.executionId, currentExecution.id);
    return store.transact('local', tx => {
    const prior = tx.getProjection<GoalV2>('goal.state', 'goal');
    const currentPlan = original ? plan : tx.getProjection<GoalPlanV2>('goal.plan', prior!.planRevisionId!)!;
    const job = tx.listProjections<Job>('job').find(job => job.payload.executionId === currentExecution.id)!;
    kernel.settleCoordinatedTurnInTransaction(tx, 'local', { jobId: job.id, workerId: 'worker', fencingToken: claimed.fencingToken, outcome: 'completed', occurredAt: now, value: {} });
    if (!original) {
      const attempt = tx.listProjections<CoordinationAttemptV2>('coordination.attempt').find(attempt => attempt.executionId === currentExecution.id)!;
      kernel.settleCoordinationUsageInTransaction(tx, 'local', 'local-owner', `settle:${attempt.id}`, { attemptId: attempt.id, expectedStreamVersion: attempt.streamVersion, occurredAt: now, usage: { currency: 'CNY', tokens: 10, costMinorUnits: '10' } });
    }
    const body = { goalId: 'goal', planRevisionId: currentPlan.id, criteriaVersion: currentPlan.criteriaVersion,
      items: deliverables.map(spec => ({ key: spec.key, preview: `protected-delivery-${currentPlan.revision}-${spec.key}`, digest: source.digest, resourceRef: source, sourceRefs: [source], criteriaVersion: currentPlan.criteriaVersion, checks: [{ checkId: 'verified', status: 'passed' as const, evidenceRefs: [source] }] })) };
    const set: GoalDeliverySetV2 = { ...body, id: `set:${currentPlan.id}`, digest: sha256(body), createdAt: now };
    const goal: GoalV2 = { ...(prior ?? { id: 'goal', tenantId: 'local', workspaceId: ws.id, principalId: 'local-owner', threadId: thread.id, objective: '原目标', inputVersion: 1, criteriaVersion: plan.criteriaVersion,
      deliverables, resourceRefs: [source], budget, createdAt: now, executionRef: { executionId: execution.id, threadId: thread.id, generation: execution.generation, planRevisionId: plan.id },
      authorization: { planDigest: plan.digest, principalId: 'local-owner', membershipStreamVersion: 1 } }), status: 'awaiting_acceptance', streamVersion: (prior?.streamVersion ?? 0) + 1, updatedAt: now,
      planRevisionId: currentPlan.id, deliverySetId: set.id, reservation: { status: 'settled', actual: { currency: 'CNY', tokens: 10 * currentPlan.revision, costMinorUnits: `${10 * currentPlan.revision}` } } };
    tx.putProjection('goal.plan', currentPlan.id, currentPlan); tx.putProjection('goal.deliverySet', set.id, set); tx.putProjection('goal.state', 'goal', goal);
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'goal', aggregateId: 'goal', expectedStreamVersion: prior?.streamVersion ?? 0, type: 'goal.observed', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: { workspaceId: ws.id, goalId: 'goal' } });
  }); };
  await completed(true);
  const mutation = async () => ({ ...base, idempotencyKey: randomUUID(), expectedStreamVersion: (await getGoalDeliveryReview(base)).goal.streamVersion });
  const change = async () => { const detail = await getGoalDeliveryReview(base); return decideGoalDelivery({ ...await mutation(), deliverySetId: detail.deliverySet!.id, criteriaVersion: detail.goal.criteriaVersion,
    items: [{ key: 'one', digest: source.digest, decision: 'accept', reviewedCriterionIds: ['check'] }, { key: 'two', digest: source.digest, decision: 'request_changes', failedCriterionIds: ['check'], instruction: '补充遗漏内容' }] }); };
  return { ...base, databaseFile: join(root, 'state.sqlite'), mutation, change, completed, setRevoked(value: boolean) { revoked = value; }, setFailStart(value: boolean) { failStart = value; } };
}

test('旧 single 两轮返工累计费用、期限和历史，部分通过成果保持原版本', async t => {
  const f = await fixture(t);
  for (let round = 1; round <= 2; round++) {
    const decided = await f.change();
    const decision = decided.deliveryReview!.decisions.at(-1)!;
    const before = decided.goal.streamVersion;
    const input = { ...await f.mutation(), decisionId: decision.id };
    const preview = await previewGoalRework(input);
    assert.deepEqual(await previewGoalRework(input), preview);
    assert.equal(preview.plan.kind, 'single-v2'); assert.equal(preview.round, round);
    assert.equal(preview.remainingBudget.maxCostMinorUnits, `${100 - round * 10}`);
    assert.equal(preview.deadlineAt, '2026-10-10T01:00:00.000Z'); assert.deepEqual(preview.retainedDeliverableKeys, ['one']);
    assert.equal((await getGoalDeliveryReview(f)).goal.streamVersion, before);
    const confirm = { ...await f.mutation(), previewId: preview.id, previewDigest: preview.digest };
    if (round === 1) { f.setFailStart(true); await assert.rejects(confirmGoalRework(confirm), /rollback/); f.setFailStart(false); }
    const started = await confirmGoalRework(confirm); assert.deepEqual(await confirmGoalRework(confirm), started);
    assert.equal(started.goal.status, 'running'); assert.equal(started.goal.executionRef, undefined);
    assert.equal(started.deliveryReview!.reworks.length, round);
    assert.equal(started.deliveryReview!.reworks.at(-1)!.retainedOutputs[0]!.output.preview, `protected-delivery-${round}-one`);
    await f.completed();
  }
  const final = await f.change();
  await assert.rejects(previewGoalRework({ ...await f.mutation(), decisionId: final.deliveryReview!.decisions.at(-1)!.id }), /返工/u);
  const group = await f.store.transact('local', tx => tx.listProjections<any>('coordination.group')[0]);
  assert.equal(group.initialAccounting.usage.tokens, 10); assert.equal(group.reworkRounds, 2);
  const expected = await getGoalDeliveryReview(f), raw = new DatabaseSync(f.databaseFile);
  try {
    for (const table of ['events', 'projections', 'idempotency', 'outbox']) assert.equal(JSON.stringify(raw.prepare(`select * from ${table}`).all()).includes('protected-delivery'), false);
    raw.exec('delete from projections; delete from idempotency'); await f.store.rebuildProjections('local');
    assert.deepEqual(await getGoalDeliveryReview(f), expected);
  } finally { raw.close(); }
});

test('返工前重算旧模型费用，汇总被改小不能增加可用预算', async t => {
  const f = await fixture(t), decided = await f.change();
  await f.store.transact('local', tx => {
    const goal = tx.getProjection<GoalV2>('goal.state', 'goal')!;
    tx.putProjection('goal.state', 'goal', { ...goal, reservation: { status: 'settled', actual: { currency: 'CNY', tokens: 1, costMinorUnits: '1' } } });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'fixture', aggregateId: 'changed-usage', expectedStreamVersion: 0, type: 'fixture.usage_changed', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: { workspaceId: f.workspaceId } });
  });
  await assert.rejects(previewGoalRework({ ...await f.mutation(), decisionId: decided.deliveryReview!.decisions.at(-1)!.id }), /计量|核对/u);
});

test('部分决定继承同版本逐项状态，暂缓项保留且不被视为接收', async t => {
  const f = await fixture(t), detail = await getGoalDeliveryReview(f), output = detail.deliverySet!.items;
  await decideGoalDelivery({ ...await f.mutation(), deliverySetId: detail.deliverySet!.id, criteriaVersion: detail.goal.criteriaVersion,
    items: [{ key: 'one', digest: output[0]!.digest, decision: 'defer', reason: '稍后核对' }] });
  const decided = await decideGoalDelivery({ ...await f.mutation(), deliverySetId: detail.deliverySet!.id, criteriaVersion: detail.goal.criteriaVersion,
    items: [{ key: 'two', digest: output[1]!.digest, decision: 'request_changes', failedCriterionIds: ['check'], instruction: '补齐内容' }] });
  assert.equal(decided.deliveryReview!.decisions.at(-1)!.items.find(item => item.key === 'one')!.decision, 'defer');
  const preview = await previewGoalRework({ ...await f.mutation(), decisionId: decided.deliveryReview!.decisions.at(-1)!.id });
  assert.deepEqual(preview.retainedDeliverableKeys, ['one']);
  assert.notEqual(decided.goal.status, 'accepted');
});

test('撤权阻断历史、决定重放及返工确认，待核对费用不能新开轮次', async t => {
  const f = await fixture(t), decided = await f.change();
  const preview = await previewGoalRework({ ...await f.mutation(), decisionId: decided.deliveryReview!.decisions.at(-1)!.id });
  const confirm = { ...await f.mutation(), previewId: preview.id, previewDigest: preview.digest };
  f.setRevoked(true); await assert.rejects(getGoalDeliveryReview(f), /撤销/u); await assert.rejects(confirmGoalRework(confirm), /撤销/u);
  f.setRevoked(false);
  await f.store.transact('local', tx => { const goal = tx.getProjection<GoalV2>('goal.state', 'goal')!; tx.putProjection('goal.state', 'goal', { ...goal, streamVersion: goal.streamVersion + 1, reservation: { status: 'unknown' } });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'goal', aggregateId: 'goal', expectedStreamVersion: goal.streamVersion, type: 'goal.usage_unknown', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: { workspaceId: f.workspaceId, goalId: 'goal' } }); });
  await assert.rejects(confirmGoalRework(confirm), /核对|变化/u);
});

test('返工预览先检查累计节点与尝试额度，原 single 也计入已用额度', async t => {
  for (const limits of [{ maxNodes: 1 }, { maxAttempts: 1 }, { maxReworkRounds: 0 }]) {
    const f = await fixture(t), decided = await f.change();
    await f.store.transact('local', tx => { tx.putProjection('coordination.workspace-policy', f.workspaceId, { limits });
      appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'fixture', aggregateId: 'policy', expectedStreamVersion: 0, type: 'fixture.policy_changed', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: { workspaceId: f.workspaceId } }); });
    await assert.rejects(previewGoalRework({ ...await f.mutation(), decisionId: decided.deliveryReview!.decisions.at(-1)!.id }), /返工|累计|上限/u);
  }
});

test('并发确认只开启一个返工修订，其他父会话执行阻断预览', async t => {
  const f = await fixture(t), decided = await f.change();
  const preview = await previewGoalRework({ ...await f.mutation(), decisionId: decided.deliveryReview!.decisions.at(-1)!.id });
  const confirm = { ...await f.mutation(), previewId: preview.id, previewDigest: preview.digest };
  const results = await Promise.allSettled([confirmGoalRework(confirm), confirmGoalRework({ ...confirm, idempotencyKey: randomUUID() })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('goal.rework').length), 1);
  const g = await fixture(t), next = await g.change();
  await g.store.transact('local', tx => { const execution = tx.listProjections<Execution>('execution')[0]!; tx.putProjection('execution', 'other', { ...execution, id: 'other', status: 'running' }); });
  await assert.rejects(previewGoalRework({ ...await g.mutation(), decisionId: next.deliveryReview!.decisions.at(-1)!.id }), /会话/u);
});
