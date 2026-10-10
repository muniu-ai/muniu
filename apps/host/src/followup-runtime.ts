// SPDX-License-Identifier: Apache-2.0
import type { FollowupRunV2, GoalV2, GoalUsageV2 } from '@mn/contracts';
import { sha256, type KernelStore, type KernelTransaction } from '@mn/kernel';
import { createGoalInTransaction, getGoalForCoordination, proposeGoalPlan, startGoal } from './goals.js';
import { createHostGoalRuntime, type HostGoalRuntimeOptions } from './goal-runtime.js';
import { FOLLOWUP_BINDING, FOLLOWUP_POLICY, FOLLOWUP_RUN, assertFollowupPolicy, followupFail, followupGoalDigest, type FollowupGoalBinding, type FollowupStoredPolicy } from './followup-authority.js';
import { FOLLOWUP_CURSOR, cancelPendingFollowups, followupDetail, followupEvent, followupPeriod, followupRuns, followupSource, type FollowupCursor, type FollowupOptions } from './followups.js';
function scope(options: HostGoalRuntimeOptions, policy: FollowupStoredPolicy): FollowupOptions {
  return { ...options, tenantId: policy.tenantId, workspaceId: policy.workspaceId, principalId: policy.principalId };
}
function saveRun(tx: KernelTransaction, options: FollowupOptions, previous: FollowupRunV2 | undefined, run: FollowupRunV2, type: string): FollowupRunV2 {
  const next = { ...run, streamVersion: (previous?.streamVersion ?? 0) + 1, updatedAt: options.now() };
  tx.putProjection(FOLLOWUP_RUN, run.id, next); followupEvent(tx, options, FOLLOWUP_RUN, run.id, previous?.streamVersion ?? 0, type); return next;
}
function notice(tx: KernelTransaction, options: FollowupOptions, policy: FollowupStoredPolicy, key: string, kind: 'result' | 'failure' | 'decision', goal?: GoalV2): void {
  const id = `followup-notice:${sha256([policy.id, key, kind])}`; if (tx.getProjection('followup.notice', id)) return;
  tx.putProjection('followup.notice', id, { id, tenantId: policy.tenantId, workspaceId: policy.workspaceId, principalId: policy.principalId, policyId: policy.id,
    kind, ...(goal ? { goalId: goal.id, threadId: goal.threadId, ...(goal.executionRef ? { executionId: goal.executionRef.executionId } : {}) } : {}), createdAt: options.now(), streamVersion: 1 });
  followupEvent(tx, options, 'followup.notice', id, 0, 'followup.notice_created');
}
function invalidate(tx: KernelTransaction, options: FollowupOptions, policy: FollowupStoredPolicy, error: unknown): void {
  const code = (error as { code?: string })?.code ?? 'FOLLOWUP_AUTHORIZATION_STALE';
  const next: FollowupStoredPolicy = { ...policy, streamVersion: policy.streamVersion + 1, updatedAt: options.now(),
    status: code === 'FOLLOWUP_EXPIRED' ? 'expired' : 'invalidated', reasonCode: code };
  tx.putProjection(FOLLOWUP_POLICY, policy.id, next); followupEvent(tx, options, FOLLOWUP_POLICY, policy.id, policy.streamVersion, 'followup.invalidated');
  notice(tx, options, policy, code, 'decision');
  cancelPendingFollowups(tx, options, policy, code);
}
function actualUsage(goal: GoalV2): GoalUsageV2 | undefined { return goal.reservation?.actual; }
function observe(tx: KernelTransaction, options: FollowupOptions, policy: FollowupStoredPolicy): void {
  for (const run of followupRuns(tx, policy)) {
    if (run.status === 'cancelled' && !run.executionId) continue;
    if (!run.goalId) continue;
    const goal = tx.getProjection<GoalV2>('goal.state', run.goalId); if (!goal) continue;
    let status: FollowupRunV2['status'] = run.status;
    if (goal.executionRef || goal.coordinationRef) status = ['accepted', 'cancelled', 'failed', 'awaiting_acceptance', 'needs_reconciliation'].includes(goal.status)
      ? goal.status as FollowupRunV2['status'] : 'running';
    if (goal.reservation?.status === 'unknown' || (['accepted', 'cancelled', 'failed'].includes(status) && goal.reservation?.status !== 'settled')) status = 'needs_reconciliation';
    let actual = actualUsage(goal);
    if (actual && (actual.currency !== run.reserved.currency || actual.tokens > run.reserved.tokens || BigInt(actual.costMinorUnits) > BigInt(run.reserved.costMinorUnits))) status = 'needs_reconciliation';
    if (actual && run.actual && (actual.tokens < run.actual.tokens || BigInt(actual.costMinorUnits) < BigInt(run.actual.costMinorUnits))) { status = 'needs_reconciliation'; actual = run.actual; }
    const next = { ...run, status, ...(actual ? { actual } : {}), ...(goal.executionRef ? { executionId: goal.executionRef.executionId } : {}), reasonCode: goal.reasonCode };
    if (sha256(next) !== sha256(run)) {
      saveRun(tx, options, run, next, 'followup.run_observed');
      if (status === 'awaiting_acceptance' && run.status !== status) notice(tx, options, policy, `${run.id}:${goal.planRevisionId}`, 'result', goal);
      if (['needs_reconciliation', 'failed'].includes(status) && run.status !== status) notice(tx, options, policy, `${run.id}:${goal.planRevisionId}`, 'failure', goal);
    }
  }
}
async function claim(options: FollowupOptions, policyId: string): Promise<FollowupRunV2 | undefined> {
  const service = await createHostGoalRuntime(options).service(options);
  return options.store.transact(options.tenantId, tx => {
    const policy = tx.getProjection<FollowupStoredPolicy>(FOLLOWUP_POLICY, policyId); if (!policy) return;
    observe(tx, options, policy);
    if (['stopped', 'invalidated', 'expired', 'exhausted'].includes(policy.status)) return;
    try { assertFollowupPolicy(tx, policy, options.now()); } catch (error) { invalidate(tx, options, policy, error); return; }
    if (policy.status !== 'active') return;
    const runs = followupRuns(tx, policy), pending = runs.find(run => run.status === 'pending');
    if (pending) return pending;
    if (runs.some(run => ['running', 'needs_reconciliation'].includes(run.status))) return;
    if (runs.length >= policy.definition.maxRuns) {
      tx.putProjection(FOLLOWUP_POLICY, policy.id, { ...policy, status: 'exhausted', streamVersion: policy.streamVersion + 1, updatedAt: options.now(), reasonCode: 'FOLLOWUP_RUN_LIMIT' });
      followupEvent(tx, options, FOLLOWUP_POLICY, policy.id, policy.streamVersion, 'followup.exhausted'); return;
    }
    const source = followupSource(tx, policy), contentDigest = sha256(source.content), cursor = tx.getProjection<FollowupCursor>(FOLLOWUP_CURSOR, policy.id);
    if (!cursor) followupFail('FOLLOWUP_CURSOR_MISSING', '跟进缺少初始来源记录');
    if (contentDigest === cursor.contentDigest) return;
    const period = followupDetail(tx, policy, options.now()).currentPeriod, limits = policy.definition.periodBudget, cap = policy.definition.perRunBudget;
    if (period.runCount >= limits.maxRuns || period.settled.tokens + period.reserved.tokens + period.unknown.tokens + cap.maxTokens > limits.maxTokens
      || BigInt(period.settled.costMinorUnits) + BigInt(period.reserved.costMinorUnits) + BigInt(period.unknown.costMinorUnits) + BigInt(cap.maxCostMinorUnits) > BigInt(limits.maxCostMinorUnits)) {
      notice(tx, options, policy, `budget:${period.startedAt}`, 'decision'); return;
    }
    const id = `followup-run:${sha256([policy.id, source.sourceRef, contentDigest])}`;
    const existing = tx.getProjection<FollowupRunV2>(FOLLOWUP_RUN, id); if (existing) return existing.status === 'pending' ? existing : undefined;
    const refs = policy.definition.resourceRefs.map(ref => ref.namespace === source.sourceRef.namespace && ref.resourceId === source.sourceRef.resourceId ? source.sourceRef : ref);
    const thread = options.kernel.createThreadInTransaction(tx, options.tenantId, options.principalId, `${id}:thread`, { workspaceId: policy.workspaceId, subject: policy.definition.title, pluginId: 'opc' });
    const goal = createGoalInTransaction(tx, { ...service, threadId: thread.id, objective: policy.definition.instruction, resourceRefs: refs, budget: cap,
      deliverables: [{ key: 'followup', title: '跟进成果', required: true, criteria: [{ id: 'source', description: '说明变化事实与来源' }, { id: 'next', description: '提出可由用户验收的分析与下一步' }] }], idempotencyKey: `${id}:goal` }).goal;
    const run = saveRun(tx, options, undefined, { id, policyId: policy.id, workspaceId: policy.workspaceId, streamVersion: 0, status: 'pending', sourceRef: source.sourceRef,
      periodStartedAt: followupPeriod(policy, options.now()).startedAt, reserved: { tokens: cap.maxTokens, costMinorUnits: cap.maxCostMinorUnits, currency: cap.currency }, goalId: goal.id, createdAt: options.now(), updatedAt: options.now() }, 'followup.run_reserved');
    const bindingBody: Omit<FollowupGoalBinding, 'digest'> = { id: goal.id, tenantId: policy.tenantId, workspaceId: policy.workspaceId, goalId: goal.id, policyId: policy.id, runId: run.id, goalInputDigest: followupGoalDigest(goal), authorizationDigest: policy.authorizationDigest };
    tx.putProjection(FOLLOWUP_BINDING, goal.id, { ...bindingBody, digest: sha256(bindingBody) }); followupEvent(tx, options, FOLLOWUP_BINDING, goal.id, 0, 'followup.goal_bound');
    tx.putProjection(FOLLOWUP_CURSOR, policy.id, { ...cursor, streamVersion: cursor.streamVersion + 1, sourceRef: source.sourceRef, contentDigest });
    followupEvent(tx, options, FOLLOWUP_CURSOR, policy.id, cursor.streamVersion, 'followup.change_claimed');
    tx.putOutbox({ id, tenantId: policy.tenantId, topic: 'followup.wake', availableAt: options.now(), payload: { workspaceId: policy.workspaceId, policyId: policy.id, runId: run.id, goalId: goal.id } });
    return run;
  });
}
async function dispatch(options: FollowupOptions, policy: FollowupStoredPolicy, run: FollowupRunV2): Promise<void> {
  if (!run.goalId) followupFail('FOLLOWUP_GOAL_MISSING', '跟进缺少独立目标');
  const runtime = createHostGoalRuntime({ ...options, followupRunId: run.id });
  const service = await runtime.service(options);
  let detail = await getGoalForCoordination({ ...service, goalId: run.goalId });
  if (detail.goal.status === 'draft') {
    const proposal = await options.store.transact(options.tenantId, tx => {
      const current = tx.getProjection<FollowupStoredPolicy>(FOLLOWUP_POLICY, policy.id)!; assertFollowupPolicy(tx, current, options.now(), true);
      return runtime.proposal(tx, detail.goal, policy.definition.modelBindingId);
    });
    detail = await proposeGoalPlan({ ...service, goalId: run.goalId, expectedStreamVersion: detail.goal.streamVersion, proposal,
      planRequest: { modelBindingId: policy.definition.modelBindingId }, idempotencyKey: `${run.id}:plan` });
  }
  if (detail.goal.status !== 'awaiting_authorization' || !detail.plan) return;
  const prepared = await runtime.service(options, detail, true);
  await startGoal({ ...prepared, ports: { ...prepared.ports, start(tx, current) {
    const savedPolicy = tx.getProjection<FollowupStoredPolicy>(FOLLOWUP_POLICY, policy.id)!, savedRun = tx.getProjection<FollowupRunV2>(FOLLOWUP_RUN, run.id)!;
    assertFollowupPolicy(tx, savedPolicy, options.now(), true);
    if (savedRun.status !== 'pending' || savedRun.goalId !== current.goal.id) followupFail('FOLLOWUP_RUN_CHANGED', '跟进已由其他调度器处理');
    const execution = prepared.ports.start(tx, current);
    saveRun(tx, options, savedRun, { ...savedRun, status: 'running', executionId: execution.id }, 'followup.run_started'); return execution;
  } }, goalId: run.goalId, expectedStreamVersion: detail.goal.streamVersion, planRevisionId: detail.plan.id, planDigest: detail.plan.digest, idempotencyKey: `${run.id}:start` });
}
const recoveryCursors = new WeakMap<KernelStore, Map<string, number>>();
export async function recoverFollowups(options: HostGoalRuntimeOptions & { readonly tenantId: string }): Promise<void> {
  const policies = await options.store.transact(options.tenantId, tx => {
    const unfinished = new Set(tx.listProjections<FollowupRunV2>(FOLLOWUP_RUN).filter(run => !['accepted', 'cancelled'].includes(run.status) || !run.actual).map(run => run.policyId));
    return tx.listProjections<FollowupStoredPolicy>(FOLLOWUP_POLICY).filter(policy => policy.tenantId === options.tenantId && (['active', 'paused'].includes(policy.status) || unfinished.has(policy.id)));
  });
  if (!policies.length) return;
  const cursors = recoveryCursors.get(options.store) ?? new Map<string, number>(); recoveryCursors.set(options.store, cursors);
  const start = (cursors.get(options.tenantId) ?? 0) % policies.length, count = Math.min(20, policies.length);
  cursors.set(options.tenantId, (start + count) % policies.length);
  for (let offset = 0; offset < count; offset++) {
    const policy = policies[(start + offset) % policies.length]!;
    const scoped = scope(options, policy);
    try { const run = await claim(scoped, policy.id); if (run) await dispatch(scoped, policy, run); }
    catch (error) {
      const code = (error as { code?: string })?.code;
      // A storage or transport failure does not revoke a valid grant or authorize a second run.
      if (!code || ['STREAM_VERSION_CONFLICT', 'FOLLOWUP_RUN_CHANGED', 'FOLLOWUP_STOPPED'].includes(code)) continue;
      await options.store.transact(options.tenantId, tx => {
        const current = tx.getProjection<FollowupStoredPolicy>(FOLLOWUP_POLICY, policy.id); if (!current) return;
        observe(tx, scoped, current);
        if (['active', 'paused'].includes(current.status)) invalidate(tx, scoped, current, error);
        cancelPendingFollowups(tx, scoped, current, code ?? 'FOLLOWUP_DISPATCH_FAILED');
      });
    }
  }
}
