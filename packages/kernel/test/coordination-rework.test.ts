// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore, reserveCoordinationCounterInTransaction, coordinationCounterRemaining, replayCoreProjections } from '../src/index.js';
import type { CoordinationRunV2, Execution, Job } from '@mn/contracts';

const now = '2026-10-10T00:00:00.000Z';
async function fixture() {
  const store = new InMemoryKernelStore(undefined, () => now), kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'ws', { name: '返工', viewMode: 'business', pluginIds: ['opc'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: workspace.id, subject: '交付', pluginId: 'opc' });
  const grant = { toolIds: [], dataScopes: [], autoAllowedEffects: ['local_read'] as const };
  const base = { workspaceId: workspace.id, threadId: thread.id, aggregateType: 'goal', aggregateId: 'goal', revisionDigest: 'a'.repeat(64), grant,
    budgets: [{ currency: 'CNY', maxTokens: 100, maxCostMinorUnits: '100' }],
    nodes: [{ id: 'execute', dependsOn: [], pluginId: 'opc', agentDefinitionId: 'opc.agent', modelBindingId: 'model', role: grant, budget: { currency: 'CNY', maxTokens: 60, maxCostMinorUnits: '60' } }],
    limits: { maxParallel: 3, maxNodes: 12, maxAttempts: 24, maxDepth: 1 }, deadlineAt: '2026-10-10T01:00:00.000Z' };
  const create = (id: string, more: Record<string, unknown> = {}) => store.transact('local', tx => kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', id, { ...base, id, revisionId: id, ...more } as any));
  const admit = (run: CoordinationRunV2) => store.transact('local', tx => kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', `admit:${run.id}`, { runId: run.id, expectedStreamVersion: run.streamVersion, nodeId: 'execute', attempt: 1, message: '修改指定缺陷' }));
  const finish = async (admitted: Awaited<ReturnType<typeof admit>>) => store.transact('local', tx => {
    const job = tx.getProjection<Job>('job', admitted.attempt.jobId)!;
    tx.putProjection('job', job.id, { ...job, status: 'leased', leaseOwner: 'w', fencingToken: 1, leaseExpiresAt: '2026-10-10T00:05:00.000Z' });
    tx.putProjection('execution', admitted.execution.id, { ...admitted.execution, status: 'completed' });
    kernel.settleCoordinatedTurnInTransaction(tx, 'local', { jobId: job.id, workerId: 'w', fencingToken: 1, outcome: 'completed', value: {}, occurredAt: now });
    kernel.settleCoordinationUsageInTransaction(tx, 'local', 'local-owner', `settle:${job.id}`, { attemptId: admitted.attempt.id, expectedStreamVersion: 2, usage: { currency: 'CNY', tokens: 5, costMinorUnits: '5' }, occurredAt: now });
  });
  return { store, kernel, base, create, admit, finish, workspace, thread };
}

test('返工两轮按目标累计，重复回执不消耗轮次，未知旧执行阻止新轮', async () => {
  const f = await fixture(), first = await f.create('initial'), attempt = await f.admit(first);
  const rework = (sourceRevisionId: string) => ({ rework: { sourceRevisionId, decisionDigest: 'a'.repeat(64) } });
  await assert.rejects(f.create('second', rework('initial')), /核对|终结/u);
  await f.finish(attempt);
  await f.create('second', rework('initial')); await f.create('second', rework('initial'));
  await f.create('third', rework('second'));
  await assert.rejects(f.create('fourth', rework('third')), /返工/u);
  assert.equal((await f.store.transact('local', tx => tx.listProjections<any>('coordination.group')))[0]!.reworkRounds, 2);
});

test('沿用以已结算原执行为证据，满足新依赖但不重复执行或收费', async () => {
  const f = await fixture(), first = await f.create('initial'), attempt = await f.admit(first); await f.finish(attempt);
  const next = await f.create('second', { rework: { sourceRevisionId: 'initial', decisionDigest: 'a'.repeat(64) },
    nodes: [...f.base.nodes, { ...f.base.nodes[0]!, id: 'review', dependsOn: ['execute'] }],
    reuses: [{ nodeId: 'execute', sourceAttemptId: attempt.attempt.id, inputDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64) }] });
  await assert.rejects(f.admit(next), /沿用/u);
  const admitted = await f.store.transact('local', tx => f.kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'review', { runId: next.id, expectedStreamVersion: next.streamVersion, nodeId: 'review', attempt: 1, message: '复核' }));
  assert.ok(admitted.execution.id);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('execution').length), 2);
  const events = await f.store.readEvents('local', 0, 200);
  const rebuilt = replayCoreProjections(events.events, 'local', Buffer.from('development-only-kernel-hmac-key'));
  assert.equal(rebuilt.records.filter(item => item.namespace === 'coordination.reuse').length, 1);
  await f.store.transact('local', tx => tx.putProjection('execution', attempt.execution.id, { ...tx.getProjection<Execution>('execution', attempt.execution.id)!, generation: 2 }));
  await assert.rejects(f.create('third', { rework: { sourceRevisionId: 'second', decisionDigest: 'a'.repeat(64) }, reuses: [{ nodeId: 'execute', sourceAttemptId: attempt.attempt.id, inputDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64) }] }), /沿用|核对/u);
});

test('累计修复计数在原子事务保留，重试幂等且旧修订不能占用额度', async () => {
  const f = await fixture(), first = await f.create('initial'), attempt = await f.admit(first);
  const reserve = (id: string) => f.store.transact('local', tx => reserveCoordinationCounterInTransaction(tx, attempt.execution, { kind: 'coding_repair', id, limit: 3 }, now));
  await reserve('one'); await reserve('one'); await reserve('two'); await reserve('three');
  assert.equal(await f.store.transact('local', tx => coordinationCounterRemaining(tx, attempt.execution, 'coding_repair', 3)), 0);
  await assert.rejects(reserve('four'), /修复|额度/u);
  await f.finish(attempt);
  const next = await f.create('second', { rework: { sourceRevisionId: 'initial', decisionDigest: 'a'.repeat(64) } }), second = await f.admit(next);
  assert.equal(await f.store.transact('local', tx => coordinationCounterRemaining(tx, second.execution, 'coding_repair', 3)), 0);
  await assert.rejects(f.store.transact('local', tx => reserveCoordinationCounterInTransaction(tx, attempt.execution, { kind: 'coding_repair', id: 'old', limit: 3 }, now)), /停止|修订|授权/u);
  const rebuilt = replayCoreProjections((await f.store.readEvents('local', 0, 200)).events, 'local', Buffer.from('development-only-kernel-hmac-key'));
  assert.equal((rebuilt.records.find(item => item.namespace === 'coordination.group')!.value as any).counterReservations.length, 3);
});

test('原单执行者的已结算费用只导入一次，预算期限和修复计数不重置', async () => {
  const f = await fixture();
  const execution = await f.store.transact('local', tx => f.kernel.submitTurnInTransaction(tx, 'local', 'local-owner', 'single', {
    coordination: { aggregateType: 'goal', aggregateId: 'goal', revisionId: 'single-plan' }, workspaceId: f.workspace.id,
    threadId: f.thread.id, expectedStreamVersion: f.thread.streamVersion, message: '首次交付', executionPrincipalId: 'agent:opc', agentDefinitionId: 'opc.agent', modelBindingId: 'model',
    authority: { ...f.base.grant, workspaceId: f.workspace.id, principalId: 'agent:opc', budget: { ...f.base.budgets[0]!, maxDurationMs: 3_600_000, maxSubagents: 0, maxSubagentDepth: 0 } },
  }));
  const job = await f.store.transact('local', tx => tx.listProjections<Job>('job').find(job => job.payload.executionId === execution.id)!);
  const proof = { executionId: execution.id, jobId: job.id, generation: execution.generation, revisionId: 'single-plan',
    executionStreamVersion: execution.streamVersion, jobStreamVersion: job.streamVersion, runtimeLastSequence: 0,
    usage: { currency: 'CNY', tokens: 70, costMinorUnits: '70' }, usageEvidenceDigest: 'a'.repeat(64), deadlineAt: f.base.deadlineAt,
    counterReservations: ['1', '2', '3'].map(id => ({ kind: 'coding_repair', id, limit: 3 })) };
  const input = { rework: { sourceRevisionId: 'single-plan', decisionDigest: 'b'.repeat(64) }, initialAccounting: proof };
  await assert.rejects(f.create('rework', input), /终结|核对/u);
  await f.store.transact('local', tx => { tx.putProjection('execution', execution.id, { ...execution, status: 'completed' }); tx.putProjection('job', job.id, { ...job, status: 'completed' }); });
  await f.store.transact('local', tx => tx.putProjection('agent-runtime', execution.id, { records: [{ type: 'model/reserved', sequence: 1 }] }));
  await assert.rejects(f.create('rework', { ...input, initialAccounting: { ...proof, runtimeLastSequence: 1 } }), /计量|用量/u);
  await f.store.transact('local', tx => tx.putProjection('agent-runtime', execution.id, { records: [] }));
  await assert.rejects(f.create('rework', { ...input, deadlineAt: '2026-10-10T02:00:00.000Z' }), /期限/u);
  await f.store.transact('local', tx => tx.putProjection('coordination.workspace-policy', f.workspace.id, { limits: { maxNodes: 1 } }));
  await assert.rejects(f.create('rework', input), /累计协调节点/u);
  await f.store.transact('local', tx => tx.deleteProjection('coordination.workspace-policy', f.workspace.id));
  const run = await f.create('rework', input);
  await assert.rejects(f.admit(run), /预算/u);
  assert.deepEqual((await f.store.transact('local', tx => tx.getProjection<Job>('job', job.id)))!.payload.coordination, { aggregateType: 'goal', aggregateId: 'goal', revisionId: 'single-plan' });
  await assert.rejects(f.create('again', input), /再次导入/u);
  const group = (await f.store.transact('local', tx => tx.listProjections<any>('coordination.group')))[0]!;
  assert.equal(group.initialAccounting.usage.tokens, 70); assert.equal(group.reworkRounds, 1);
});

test('省略返工字段不能绕过两轮，工作区可关闭返工', async () => {
  const f = await fixture(); await f.create('first'); await f.create('second'); await f.create('third');
  await assert.rejects(f.create('fourth'), /返工/u);
  const g = await fixture(); await g.create('first');
  await g.store.transact('local', tx => tx.putProjection('coordination.workspace-policy', g.workspace.id, { limits: { maxReworkRounds: 0 } }));
  await assert.rejects(g.create('second'), /返工/u);
});

test('沿用不能接受被换绑的原任务或跨工作区执行', async () => {
  for (const change of ['binding', 'scope', 'authority'] as const) {
    const f = await fixture(), first = await f.create('initial'), attempt = await f.admit(first); await f.finish(attempt);
    await f.store.transact('local', tx => {
      if (change === 'binding') { const job = tx.getProjection<Job>('job', attempt.attempt.jobId)!; tx.putProjection('job', job.id, { ...job, payload: { ...job.payload, coordination: { ...(job.payload.coordination as object), nodeId: 'other' } } }); }
      else { const execution = tx.getProjection<Execution>('execution', attempt.execution.id)!; tx.putProjection('execution', execution.id, { ...execution, ...(change === 'scope' ? { workspaceId: 'other' } : { agentDefinitionId: 'other' }) }); }
    });
    await assert.rejects(f.create('second', { rework: { sourceRevisionId: 'initial', decisionDigest: 'a'.repeat(64) },
      reuses: [{ nodeId: 'execute', sourceAttemptId: attempt.attempt.id, inputDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64) }] }), /沿用/u);
  }
});

test('修订中重新执行的同名节点计入累计新增上限，沿用不占新节点', async () => {
  const f = await fixture();
  const nodes = Array.from({ length: 7 }, (_, index) => ({ ...f.base.nodes[0]!, id: `node-${index}` }));
  await f.create('first', { nodes });
  await assert.rejects(f.create('second', { nodes }), /累计协调节点/u);
});

test('更换运行标识不能复用同一修订绕过累计节点上限', async () => {
  const f = await fixture();
  const nodes = Array.from({ length: 7 }, (_, index) => ({ ...f.base.nodes[0]!, id: `node-${index}` }));
  await f.create('first', { nodes });
  await assert.rejects(f.create('second', { nodes, revisionId: 'first' }), (error: any) => error.code === 'COORDINATION_REVISION_EXISTS');
  assert.equal((await f.store.transact('local', tx => tx.listProjections('coordination.run'))).length, 1);
});
