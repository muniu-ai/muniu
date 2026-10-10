// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FollowupRunV2 } from '@mn/contracts';
import { AgentOsKernel, InMemoryKernelStore } from '@mn/kernel';
import { FOLLOWUP_POLICY, FOLLOWUP_RUN, type FollowupStoredPolicy } from '../src/followup-authority.js';
import { commandFollowup, followupDetail, followupEvent, type FollowupOptions } from '../src/followups.js';
import { recoverFollowups } from '../src/followup-runtime.js';

const start = '2026-10-10T00:00:00.000Z', nextPeriod = '2026-10-11T00:00:00.000Z';
const sourceRef = { namespace: 'opc.business.customer', resourceId: 'customer', streamVersion: 1, digest: 'a'.repeat(64) };
const reserved = { tokens: 1000, costMinorUnits: '100', currency: 'CNY' }, actual = { tokens: 400, costMinorUnits: '30', currency: 'CNY' };
const zero = { tokens: 0, costMinorUnits: '0', currency: 'CNY' };
const policy: FollowupStoredPolicy = {
  id: 'policy', tenantId: 'local', workspaceId: 'workspace', principalId: 'owner', parentPlanId: 'plan', streamVersion: 2,
  status: 'active', authorizationDigest: 'b'.repeat(64), createdAt: start, updatedAt: start,
  stopConditions: ['goal_closed', 'permission_revoked', 'expired', 'max_runs'],
  definition: { expectedStreamVersion: 0, parentGoalId: 'parent', expectedGoalStreamVersion: 3, parentPlanDigest: 'c'.repeat(64),
    title: '客户需求跟进', instruction: '整理变化', enabled: true, trigger: { kind: 'business_changed', sourceRef }, resourceRefs: [sourceRef], modelBindingId: 'model',
    perRunBudget: { maxTokens: 1000, maxCostMinorUnits: '100', currency: 'CNY', maxDurationMs: 60000 },
    periodBudget: { periodMs: 86400000, maxRuns: 3, maxTokens: 3000, maxCostMinorUnits: '300', currency: 'CNY' }, maxRuns: 10, expiresAt: '2026-10-20T00:00:00.000Z' },
};
async function detail(policyStatus: FollowupStoredPolicy['status'], status: FollowupRunV2['status'], now = start) {
  const store = new InMemoryKernelStore();
  return store.transact('local', tx => {
    tx.putProjection(FOLLOWUP_RUN, 'run', { id: 'run', policyId: policy.id, workspaceId: policy.workspaceId, streamVersion: 2, status,
      sourceRef, periodStartedAt: start, reserved, actual, createdAt: start, updatedAt: now } satisfies FollowupRunV2);
    return followupDetail(tx, { ...policy, status: policyStatus }, now);
  });
}

test('永久停止的跟进释放已结算失败或待验收任务的未用额度，保留实际费用', async () => {
  for (const policyStatus of ['stopped', 'expired', 'invalidated'] as const) {
    for (const status of ['failed', 'awaiting_acceptance'] as const) {
      const view = await detail(policyStatus, status);
      assert.deepEqual(view.currentPeriod.settled, actual);
      assert.deepEqual(view.currentPeriod.reserved, zero, `${policyStatus}/${status}`);
      assert.deepEqual(view.currentPeriod.unknown, zero);
    }
  }
});
test('永久停止仍保留在途任务额度和未知费用，不能将未知费用视为已释放', async () => {
  for (const policyStatus of ['stopped', 'expired', 'invalidated'] as const) {
    for (const status of ['pending', 'running', 'needs_reconciliation'] as const) {
      const view = await detail(policyStatus, status), remaining = { tokens: 600, costMinorUnits: '70', currency: 'CNY' };
      assert.deepEqual(view.currentPeriod.settled, actual);
      assert.deepEqual(view.currentPeriod.reserved, status === 'needs_reconciliation' ? zero : remaining);
      assert.deepEqual(view.currentPeriod.unknown, status === 'needs_reconciliation' ? remaining : zero);
    }
  }
});
test('暂时暂停或用完派发次数时，既有任务继续保留未用额度', async () => {
  for (const policyStatus of ['active', 'paused', 'exhausted'] as const) {
    for (const status of ['failed', 'awaiting_acceptance'] as const) {
      const view = await detail(policyStatus, status);
      assert.deepEqual(view.currentPeriod.reserved, { tokens: 600, costMinorUnits: '70', currency: 'CNY' });
    }
  }
});
test('上一周期迟到的已知或未知费用保留在原执行，不计入新周期额度', async () => {
  for (const status of ['accepted', 'needs_reconciliation'] as const) {
    const view = await detail('active', status, nextPeriod);
    assert.equal(view.runs.length, 1);
    assert.deepEqual(view.runs[0]!.actual, actual);
    assert.equal(view.runs[0]!.periodStartedAt, start);
    assert.equal(view.currentPeriod.runCount, 0);
    for (const field of ['settled', 'reserved', 'unknown'] as const) assert.deepEqual(view.currentPeriod[field], zero);
  }
});

test('显式停止在同一事务取消未派发任务并归还额度，暂停保留任务且重放不重复变更', async () => {
  const store = new InMemoryKernelStore(), kernel = new AgentOsKernel(store);
  await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '跟进额度', viewMode: 'business', pluginIds: ['opc'] });
  let sequence = 0;
  const options = { tenantId: 'local', workspaceId: workspace.id, principalId: 'local-owner', store, kernel, now: () => start,
    id: () => `followup-event-${++sequence}`, protectedJournal: true, cas: {}, keyProvider: {} } as unknown as FollowupOptions;
  await store.transact('local', tx => {
    const current: FollowupStoredPolicy = { ...policy, principalId: options.principalId, workspaceId: workspace.id, streamVersion: 1 };
    tx.putProjection(FOLLOWUP_POLICY, current.id, current);
    followupEvent(tx, options, FOLLOWUP_POLICY, current.id, 0, 'fixture.policy');
    for (const dispatched of [false, true]) {
      const run: FollowupRunV2 = { id: dispatched ? 'running' : 'pending', policyId: current.id, workspaceId: workspace.id, streamVersion: 1,
        status: dispatched ? 'running' : 'pending', sourceRef, reserved, periodStartedAt: start, createdAt: start, updatedAt: start,
        ...(dispatched ? { executionId: 'execution' } : {}) };
      tx.putProjection(FOLLOWUP_RUN, run.id, run);
      followupEvent(tx, options, FOLLOWUP_RUN, run.id, 0, 'fixture.run');
    }
  });
  const paused = await commandFollowup(options, policy.id, { command: 'pause', expectedStreamVersion: 1 }, 'pause');
  assert.equal(paused.runs.find(run => run.id === 'pending')?.status, 'pending');
  const stopped = await commandFollowup(options, policy.id, { command: 'stop', expectedStreamVersion: paused.policy.streamVersion }, 'stop');
  assert.equal(stopped.policy.status, 'stopped');
  const cancelled = stopped.runs.find(run => run.id === 'pending')!;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.actual, zero);
  assert.equal(cancelled.streamVersion, 2);
  assert.equal(stopped.runs.find(run => run.id === 'running')?.status, 'running');
  assert.deepEqual(stopped.currentPeriod.reserved, reserved);
  const replay = await commandFollowup(options, policy.id, { command: 'stop', expectedStreamVersion: paused.policy.streamVersion }, 'stop');
  assert.deepEqual(replay, stopped);
});

test('停止后的恢复扫描保留未派发取消的已知零费用，不因另一执行在途改为未知', async () => {
  const store = new InMemoryKernelStore();
  let sequence = 0;
  const options = { tenantId: 'local', workspaceId: policy.workspaceId, principalId: policy.principalId, store, kernel: new AgentOsKernel(store), now: () => start,
    id: () => `followup-event-${++sequence}`, protectedJournal: true, cas: {}, keyProvider: {}, definitions: [] } as unknown as FollowupOptions;
  await store.transact('local', tx => {
    tx.putProjection(FOLLOWUP_POLICY, policy.id, { ...policy, status: 'stopped' });
    for (const cancelled of [true, false]) {
      const id = cancelled ? 'cancelled' : 'running';
      const run: FollowupRunV2 = { id, goalId: id, policyId: policy.id, workspaceId: policy.workspaceId, streamVersion: 1,
        status: cancelled ? 'cancelled' : 'running', sourceRef, reserved, periodStartedAt: start, createdAt: start, updatedAt: start,
        ...(cancelled ? { actual: zero } : { executionId: 'execution' }) };
      tx.putProjection(FOLLOWUP_RUN, run.id, run);
      followupEvent(tx, options, FOLLOWUP_RUN, run.id, 0, 'fixture.run');
      tx.putProjection('goal.state', id, { id, status: cancelled ? 'draft' : 'running', ...(cancelled ? {} : { executionRef: { executionId: 'execution' }, reservation: { status: 'reserved' } }) });
    }
  });
  await recoverFollowups(options);
  await recoverFollowups(options);
  const run = await store.transact('local', tx => tx.getProjection<FollowupRunV2>(FOLLOWUP_RUN, 'cancelled'));
  assert.equal(run?.status, 'cancelled');
  assert.deepEqual(run?.actual, zero);
});
