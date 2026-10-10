// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore, assertCurrentCoordinationAuthorization, replayCoreProjections, sha256 } from '../src/index.js';
import type { CoordinationRunV2, Execution, Job } from '@mn/contracts';

const now = '2026-10-10T00:00:00.000Z';
async function fixture() {
  const store = new InMemoryKernelStore(undefined, () => now);
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '团队', viewMode: 'business', pluginIds: ['opc'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: workspace.id, subject: '协作', pluginId: 'opc' });
  const grant = { toolIds: ['read'], dataScopes: [{ namespace: 'asset', resourceId: 'a' }], autoAllowedEffects: ['local_read'] as const };
  const input = { id: 'run', workspaceId: workspace.id, threadId: thread.id, aggregateType: 'test', aggregateId: 'target', revisionId: 'revision', revisionDigest: 'digest', grant,
    budgets: [{ currency: 'CNY', maxTokens: 100, maxCostMinorUnits: '100' }, { currency: 'USD', maxTokens: 100, maxCostMinorUnits: '100' }],
    nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, dependsOn: id === 'd' ? ['a', 'b'] : [], pluginId: 'opc', agentDefinitionId: 'opc.agent', modelBindingId: 'model',
      role: { ...grant, toolIds: ['read', 'write'] }, budget: { currency: id === 'c' ? 'USD' : 'CNY', maxTokens: 40, maxCostMinorUnits: '40' } })),
    limits: { maxParallel: 3, maxNodes: 12, maxAttempts: 24, maxDepth: 1 }, deadlineAt: '2026-10-10T01:00:00.000Z' };
  const create = () => store.transact('local', tx => (kernel as any).createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run', input)) as Promise<CoordinationRunV2>;
  const admit = (nodeId: string, version: number, key = `admit-${nodeId}`, ordinal = 1) => store.transact('local', tx =>
    (kernel as any).admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', key, { runId: 'run', expectedStreamVersion: version, nodeId, attempt: ordinal, message: '研究资料' }));
  return { store, kernel, workspace, thread, input, create, admit };
}

test('节点准入与调用方一起回滚，竞争派发仅创建一次', async () => {
  const f = await fixture(); await f.create();
  await assert.rejects(f.store.transact('local', tx => {
    (f.kernel as any).admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'fail', { runId: 'run', expectedStreamVersion: 1, nodeId: 'a', attempt: 1, message: '研究资料' });
    throw new Error('crash');
  }), /crash/);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('execution').length), 0);
  const results = await Promise.allSettled([f.admit('a', 1), f.admit('a', 1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  const [first, replay] = results.map(r => r.status === 'fulfilled' ? r.value : null);
  assert.equal(first.execution.id, replay.execution.id);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('job').length), 1);
  await assert.rejects(f.admit('a', 2, 'other'), /已|重复/);
  const authority = await f.store.transact('local', tx => tx.getProjection<any>('authority', first.execution.authorityId));
  assert.deepEqual(authority.toolIds, ['read']);
  assert.equal(authority.budget.maxSubagents, 0);
  assert.notEqual(first.thread.id, f.thread.id);
  assert.equal(first.thread.id, `coordination-thread:${sha256({ runId: 'run', nodeId: 'a', attempt: 1 })}`);
});

test('预先加密的节点输入必须绑定确定性成员会话和当前租户工作区', async () => {
  const f = await fixture(); await f.create();
  const threadId = `coordination-thread:${sha256({ runId: 'run', nodeId: 'a', attempt: 1 })}`;
  const keyRecord = { id: 'payload', workspaceId: f.workspace.id, ownerType: 'thread', ownerId: threadId,
    context: { tenantId: 'local', purpose: `thread:${threadId}` } };
  for (const invalid of [
    { ...keyRecord, ownerId: 'other-thread' }, { ...keyRecord, workspaceId: 'other-workspace' },
    { ...keyRecord, context: { tenantId: 'other-tenant', purpose: `thread:${threadId}` } }, { ...keyRecord, id: 'other-payload' },
  ]) await assert.rejects(f.store.transact('local', tx => f.kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'bad-input', {
    runId: 'run', expectedStreamVersion: 1, nodeId: 'a', attempt: 1, message: '研究资料',
    preparedMessage: { protectedPayloadRef: 'payload', keyRecord: invalid },
  })), /受保护输入/u);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('execution').length), 0);
  const admitted = await f.store.transact('local', tx => f.kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'good-input', {
    runId: 'run', expectedStreamVersion: 1, nodeId: 'a', attempt: 1, message: '研究资料',
    preparedMessage: { protectedPayloadRef: 'payload', keyRecord },
  }));
  assert.equal(admitted.thread.id, threadId);
});

test('依赖、当前授权及按币种累计预留阻止不合法派发', async () => {
  const f = await fixture(); await f.create();
  await assert.rejects(f.admit('d', 1), /依赖/);
  await f.admit('a', 1); await f.admit('b', 2); await f.admit('c', 3);
  const attempts = await f.store.transact('local', tx => tx.listProjections<any>('coordination.attempt'));
  assert.equal(attempts.length, 3);
  assert.equal(attempts.filter(a => a.reservation.budget.currency === 'USD').length, 1);
  await f.store.transact('local', tx => {
    const member = tx.getProjection<any>('membership', `${f.workspace.id}:local-owner`)!;
    tx.putProjection('membership', member.id, { ...member, removedAt: now });
  });
  await assert.rejects(f.admit('a', 4, 'retry', 2), /授权/);
});

test('终态与唤醒原子提交，旧租约拒绝，未知费用保留预留且不可重试', async () => {
  const f = await fixture(); await f.create(); const admitted = await f.admit('a', 1);
  await f.store.transact('local', tx => {
    const job = tx.getProjection<Job>('job', admitted.attempt.jobId)!;
    tx.putProjection('job', job.id, { ...job, status: 'leased', leaseOwner: 'worker', fencingToken: 2, leaseExpiresAt: '2026-10-10T00:10:00.000Z' });
  });
  const settle = (fence: number) => f.store.transact('local', tx => (f.kernel as any).settleCoordinatedTurnInTransaction(tx, 'local', {
    jobId: admitted.attempt.jobId, workerId: 'worker', fencingToken: fence, outcome: 'completed', value: { executionId: admitted.execution.id, status: 'completed' }, occurredAt: now,
  }));
  await assert.rejects(settle(1), /lease|租约|owns/);
  await settle(2);
  const attempt = await f.store.transact('local', tx => tx.getProjection<any>('coordination.attempt', admitted.attempt.id));
  assert.equal(attempt.status, 'completed'); assert.equal(attempt.reservation.status, 'reserved');
  await assert.rejects(f.admit('a', 3, 'retry', 2), /已|核对|预算/);
  const events = await f.store.readEvents('local', 0, 100);
  assert.ok(events.events.some(e => e.type === 'coordination.attempt_completed'));
  assert.ok(events.events.some(e => e.type === 'coordination.wake_requested'));
});

test('新修订不能重置累计额度和期限，旧执行停止且未知副作用阻断新派发', async () => {
  const f = await fixture(); await f.create(); const admitted = await f.admit('a', 1);
  await f.store.transact('local', tx => tx.putProjection('toolAdmission', 'unknown', { id: 'unknown', executionId: admitted.execution.id, status: 'started' }));
  const next = { ...f.input, id: 'run-2', revisionId: 'revision-2', deadlineAt: '2026-10-11T00:00:00.000Z' };
  await assert.rejects(f.store.transact('local', tx => (f.kernel as any).createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run-2', next)), /期限/);
  await f.store.transact('local', tx => (f.kernel as any).createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run-2', { ...next, deadlineAt: f.input.deadlineAt }));
  const execution = await f.store.transact('local', tx => tx.getProjection<Execution>('execution', admitted.execution.id));
  assert.equal(execution?.status, 'needs_reconciliation');
  await assert.rejects(f.store.transact('local', tx => (f.kernel as any).admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'new', {
    runId: 'run-2', expectedStreamVersion: 1, nodeId: 'a', attempt: 1, message: '研究资料',
  })), /核对/);
});

test('控制节点需要当前授权与固定证据，Agent不能越过人工决定', async () => {
  const f = await fixture();
  const approval = { ...f.input.nodes[0]!, id: 'decision', kind: 'human_decision', dependsOn: [] };
  await f.store.transact('local', tx => (f.kernel as any).createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run', {
    ...f.input, nodes: [approval, { ...f.input.nodes[0]!, dependsOn: ['decision'] }],
  }));
  await assert.rejects(f.admit('a', 1), /依赖/);
  await assert.rejects(f.admit('decision', 1), /控制|人工/);
  await f.store.transact('local', tx => (f.kernel as any).completeCoordinationControlInTransaction(tx, 'local', 'local-owner', 'decision', {
    runId: 'run', expectedStreamVersion: 1, nodeId: 'decision', decision: 'approved', evidenceDigest: 'a'.repeat(64),
  }));
  await f.admit('a', 2);
  const controls = await f.store.transact('local', tx => tx.listProjections<any>('coordination.control'));
  assert.equal(controls.length, 1); assert.equal(controls[0].decidedBy, 'local-owner');
  assert.equal(controls[0].evidenceDigest, 'a'.repeat(64));
});

test('暂停阻止新派发但允许已派发节点终结，权限预算篡改立即拒绝', async () => {
  const f = await fixture(); await f.create(); const admitted = await f.admit('a', 1);
  await f.store.transact('local', tx => f.kernel.commandCoordinationRunInTransaction(tx, 'local', 'local-owner', 'pause', { runId: 'run', expectedStreamVersion: 2, status: 'paused' }));
  await assert.rejects(f.admit('b', 3), /停止/);
  await f.store.transact('local', tx => assertCurrentCoordinationAuthorization(tx, admitted.execution, now));
  await f.store.transact('local', tx => {
    const authority = tx.getProjection<any>('authority', admitted.execution.authorityId);
    tx.putProjection('authority', authority.id, { ...authority, budget: { ...authority.budget, maxTokens: 1000 } });
  });
  await assert.rejects(f.store.transact('local', tx => assertCurrentCoordinationAuthorization(tx, admitted.execution, now)), /权限|预算/);
});

for (const status of ['interrupted', 'paused'] as const) test(`${status} 节点只在物理任务结束且计量明确后结算，不改执行状态或允许重跑`, async () => {
  const f = await fixture(); await f.create(); const admitted = await f.admit('a', 1);
  await f.store.transact('local', tx => {
    const job = tx.getProjection<Job>('job', admitted.attempt.jobId)!;
    tx.putProjection('job', job.id, { ...job, status: 'leased', leaseOwner: 'worker', fencingToken: 1, leaseExpiresAt: '2026-10-10T00:10:00.000Z' });
    tx.putProjection('execution', admitted.execution.id, { ...admitted.execution, status });
  });
  const settleUsage = () => f.store.transact('local', tx => {
    const attempt = tx.getProjection<any>('coordination.attempt', admitted.attempt.id)!;
    return f.kernel.settleCoordinationUsageInTransaction(tx, 'local', 'local-owner', 'known-usage', {
      attemptId: attempt.id, expectedStreamVersion: attempt.streamVersion, usage: { currency: 'CNY', tokens: 7, costMinorUnits: '4' }, occurredAt: now,
    });
  });
  await assert.rejects(settleUsage(), /终结|核对/u);
  await f.store.transact('local', tx => f.kernel.settleCoordinatedTurnInTransaction(tx, 'local', {
    jobId: admitted.attempt.jobId, workerId: 'worker', fencingToken: 1, outcome: status === 'paused' ? 'completed' : 'failed',
    value: { status }, occurredAt: now,
  }));
  await f.store.transact('local', tx => tx.putProjection('agent-runtime', admitted.execution.id, { records: [{ type: 'model/reserved' }] }));
  await assert.rejects(settleUsage(), /计量|核对/u);
  await f.store.transact('local', tx => tx.putProjection('agent-runtime', admitted.execution.id, { records: [{ type: 'model/reserved' }, { type: 'model/settled' }] }));
  await f.store.transact('local', tx => tx.putProjection('execution', admitted.execution.id, { ...tx.getProjection<Execution>('execution', admitted.execution.id)!, generation: 2 }));
  await assert.rejects(settleUsage(), /绑定|版本/u);
  await f.store.transact('local', tx => tx.putProjection('execution', admitted.execution.id, { ...tx.getProjection<Execution>('execution', admitted.execution.id)!, generation: 1 }));
  const settled = await settleUsage();
  assert.equal(settled.reservation.status, 'settled');
  assert.equal(settled.status, status);
  assert.equal((await f.store.transact('local', tx => tx.getProjection<Execution>('execution', admitted.execution.id)))!.status, status);
  const run = await f.store.transact('local', tx => tx.getProjection<CoordinationRunV2>('coordination.run', 'run')!);
  await assert.rejects(f.admit('a', run.streamVersion, 'retry-after-interrupt', 2), /已|核对|重复/u);
});

test('累计预算跨修订保留且协调事实可从事件重建', async () => {
  const f = await fixture(); await f.create(); await f.admit('a', 1); await f.admit('b', 2);
  const next = { ...f.input, id: 'run-next', revisionId: 'next' };
  await f.store.transact('local', tx => f.kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'next', next));
  await assert.rejects(f.store.transact('local', tx => f.kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'next-a', {
    runId: 'run-next', expectedStreamVersion: 1, nodeId: 'a', attempt: 1, message: '继续',
  })), /预算/);
  const events = await f.store.readEvents('local', 0, 200);
  const rebuilt = replayCoreProjections(events.events, 'local', Buffer.from('development-only-kernel-hmac-key'));
  assert.equal(rebuilt.records.filter(item => item.namespace === 'coordination.attempt').length, 2);
  assert.equal(rebuilt.records.filter(item => item.namespace === 'coordination.run').length, 2);
});

test('终结事务提交前崩溃不会留下节点终态或唤醒，迟到费用不唤醒新修订', async () => {
  const f = await fixture(); await f.create(); const admitted = await f.admit('a', 1);
  await f.store.transact('local', tx => {
    const job = tx.getProjection<Job>('job', admitted.attempt.jobId)!;
    tx.putProjection('job', job.id, { ...job, status: 'leased', leaseOwner: 'worker', fencingToken: 1, leaseExpiresAt: '2026-10-10T00:10:00.000Z' });
  });
  const settlement = { jobId: admitted.attempt.jobId, workerId: 'worker', fencingToken: 1, outcome: 'completed' as const, value: { executionId: admitted.execution.id, status: 'completed' }, occurredAt: now };
  await assert.rejects(f.store.transact('local', tx => {
    f.kernel.settleCoordinatedTurnInTransaction(tx, 'local', settlement); throw new Error('crash');
  }), /crash/);
  assert.equal((await f.store.transact('local', tx => tx.getProjection<any>('coordination.attempt', admitted.attempt.id))).status, 'queued');
  await f.store.transact('local', tx => f.kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'next', { ...f.input, id: 'next', revisionId: 'next' }));
  await f.store.transact('local', tx => f.kernel.settleCoordinatedTurnInTransaction(tx, 'local', { ...settlement, outcome: 'failed', value: { code: 'EXECUTION_CANCELLED' } }));
  await f.store.transact('local', tx => f.kernel.settleCoordinationUsageInTransaction(tx, 'local', 'local-owner', 'usage', { attemptId: admitted.attempt.id, expectedStreamVersion: 2,
    usage: { currency: 'CNY', tokens: 7, costMinorUnits: '7' }, occurredAt: now }));
  assert.equal((await f.store.readEvents('local', 0, 200)).events.filter(e => e.type === 'coordination.wake_requested').length, 0);
});

test('工作区限额取严，节点和尝试硬上限不能由新计划放宽', async () => {
  const f = await fixture();
  await f.store.transact('local', tx => tx.putProjection('coordination.workspace-policy', f.workspace.id, { limits: { maxParallel: 1 } }));
  const run = await f.store.transact('local', tx => f.kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run', {
    ...f.input, limits: { maxParallel: 99, maxNodes: 99, maxAttempts: 99, maxDepth: 99 },
  }));
  assert.deepEqual(run.limits, { maxParallel: 1, maxNodes: 12, maxAttempts: 24, maxDepth: 1 });
  await f.admit('a', 1);
  await assert.rejects(f.admit('b', 2), /并行/);
  await assert.rejects(f.store.transact('local', tx => f.kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'new-nodes', {
    ...f.input, id: 'new-run', revisionId: 'new-revision', nodes: Array.from({ length: 12 }, (_, i) => ({ ...f.input.nodes[0]!, id: `new-${i}` })),
  })), /累计协调节点/);
});

test('失败结算后仍累计尝试，第二十五次准入失败且新修订不重置', async () => {
  const f = await fixture(); await f.create();
  for (let ordinal = 1; ordinal <= 24; ordinal++) {
    const run = await f.store.transact('local', tx => tx.getProjection<CoordinationRunV2>('coordination.run', 'run')!);
    const admitted = await f.admit('a', run.streamVersion, `attempt-${ordinal}`, ordinal);
    await f.store.transact('local', tx => {
      const job = tx.getProjection<Job>('job', admitted.attempt.jobId)!;
      tx.putProjection('job', job.id, { ...job, status: 'leased', leaseOwner: 'worker', fencingToken: 1, leaseExpiresAt: '2026-10-10T00:10:00.000Z' });
      f.kernel.settleCoordinatedTurnInTransaction(tx, 'local', { jobId: job.id, workerId: 'worker', fencingToken: 1, outcome: 'failed', value: { code: 'JOB_EXECUTION_FAILED' }, occurredAt: now });
      f.kernel.settleCoordinationUsageInTransaction(tx, 'local', 'local-owner', `usage-${ordinal}`, { attemptId: admitted.attempt.id, expectedStreamVersion: 2,
        usage: { currency: 'CNY', tokens: 0, costMinorUnits: '0' }, occurredAt: now });
    });
  }
  const run = await f.store.transact('local', tx => tx.getProjection<CoordinationRunV2>('coordination.run', 'run')!);
  await assert.rejects(f.admit('a', run.streamVersion, 'attempt-25', 25), /累计节点尝试/);
  await f.store.transact('local', tx => f.kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'next', { ...f.input, id: 'next', revisionId: 'next' }));
  await assert.rejects(f.store.transact('local', tx => f.kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'next-a', {
    runId: 'next', expectedStreamVersion: 1, nodeId: 'a', attempt: 1, message: '继续',
  })), /累计节点尝试/);
});
