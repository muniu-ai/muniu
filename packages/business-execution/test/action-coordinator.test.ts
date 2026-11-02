// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore, createBudgetAccount, closeBudgetAccount, type KernelJobLeaseAssertion } from '@mn/kernel';
import type { ActionReceipt, Execution, Job } from '@mn/contracts';
import { ActionCoordinator, PROVIDER_ACTION_AGENT_ID } from '../src/index.js';
const now = '2026-11-02T01:00:00.000Z';
async function fixture(executionCap = 100) {
  const store = new InMemoryKernelStore(undefined, () => now), kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '动作', viewMode: 'business', pluginIds: ['business'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: workspace.id, pluginId: 'business', subject: '业务动作' });
  const target = { tenantId: 'local', workspaceId: workspace.id, provider: 'fixture', objectType: 'opportunity' as const, objectId: 'opportunity-a',
    sourceVersion: 'source-1', digest: 'a'.repeat(64), observedAt: now, permissionRef: 'permission-1' };
  const toolId = 'provider.fixture.followup';
  const execution = await kernel.createExecution('local', 'local-owner', 'execution', { workspaceId: workspace.id, threadId: thread.id, pluginId: 'business',
    agentDefinitionId: PROVIDER_ACTION_AGENT_ID, modelBindingId: 'none', executionPrincipalId: 'agent:business', authority: {
      workspaceId: workspace.id, principalId: 'agent:business', toolIds: [toolId], dataScopes: [{ namespace: 'provider.fixture.opportunity', resourceId: target.objectId, digest: target.digest }], autoAllowedEffects: [],
      budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: executionCap, maxCostMinorUnits: String(executionCap), currency: 'CNY', maxDurationMs: 3600000 } } });
  const account = await store.transact('local', tx => createBudgetAccount(tx, { tenantId: 'local', workspaceId: workspace.id, principalId: 'local-owner', occurredAt: now,
    scope: { namespace: 'goal', resourceId: 'goal' }, limit: { tokens: 100, costMinorUnits: '100', currency: 'CNY' }, expiresAt: '2026-11-02T02:00:00.000Z' }));
  let allowed = true;
  const coordinator = new ActionCoordinator({ store, kernel, now: () => now, assertCurrent: () => { if (!allowed) throw new Error('CURRENT_POLICY_REVOKED'); } });
  const input = { id: 'action-a', tenantId: 'local', workspaceId: workspace.id, operationKey: 'stable-operation', goalId: 'goal', nodeId: 'node', attemptId: 'attempt', generation: 1,
    provider: 'fixture', action: 'create_followup_task' as const, target, authorityRevisionId: execution.authorityId, providerBindingVersion: 1,
    preparedInputRef: 'protected-input', inputDigest: 'b'.repeat(64), expiresAt: '2026-11-02T01:30:00.000Z' };
  const options = { executionId: execution.id, accountId: account.id, actorId: 'local-owner', idempotencyKey: 'prepare', toolId, toolVersion: '1', amount: { tokens: 20, costMinorUnits: '20', currency: 'CNY' } };
  const prepare = () => coordinator.prepare(input, options);
  const approve = async () => {
    const approval = await coordinator.requestApproval('local', input.id);
    await kernel.decideApproval('local', 'local-owner', 'approve', approval.id, approval.streamVersion, 'approve_once');
    return coordinator.enqueue('local', input.id);
  };
  const lease = async (jobId: string, fence = 1): Promise<KernelJobLeaseAssertion> => {
    await store.transact('local', tx => {
      const job = tx.getProjection<Job>('job', jobId)!;
      tx.putProjection('job', jobId, { ...job, status: 'leased', leaseOwner: 'worker', fencingToken: fence, leaseExpiresAt: '2026-11-02T01:10:00.000Z' });
    });
    return { jobId, workerId: 'worker', fencingToken: fence, occurredAt: now };
  };
  return { store, kernel, coordinator, execution, input, options, account, prepare, approve, lease, revoke: () => { allowed = false; } };
}
const receipt = (f: Awaited<ReturnType<typeof fixture>>, actionDigest: string): ActionReceipt => ({ id: 'receipt', tenantId: 'local', workspaceId: f.input.workspaceId,
  operationKey: f.input.operationKey, actionDigest, provider: 'fixture', receivedAt: now, completedAt: now, status: 'succeeded',
  evidenceRefs: [{ tenantId: 'local', workspaceId: f.input.workspaceId, id: 'evidence', sourceKind: 'business_fact', protectedContentRef: 'protected-evidence',
    sourceVersion: '2', digest: 'c'.repeat(64), permissionRef: 'permission-1', locator: { paragraph: 'followup' } }] });

test('等待批准没有 Worker Job，批准后 Job 与 outbox 原子去重', async () => {
  const f = await fixture(); const first = await f.prepare();
  assert.deepEqual(await f.coordinator.prepare({ ...f.input, id: 'other-action-id' }, { ...f.options, idempotencyKey: 'repeat' }), first);
  await assert.rejects(f.coordinator.prepare({ ...f.input, id: 'changed', operationKey: 'changed' }, { ...f.options, idempotencyKey: 'repeat' }), { code: 'ACTION_OPERATION_CONFLICT' });
  assert.equal(f.store.readJobs('local').length, 0);
  await f.coordinator.requestApproval('local', first.id);
  await assert.rejects(f.coordinator.enqueue('local', first.id), { code: 'APPROVAL_REQUIRED' });
  const queued = await f.approve(); assert.ok(queued.jobId);
  assert.equal((await f.coordinator.enqueue('local', first.id)).jobId, queued.jobId);
  assert.equal(f.store.readJobs('local').length, 1);
});

test('承诺先于外部动作，陈旧租约与重复派发被拒绝，回执一次结算预算和 Job', async () => {
  const f = await fixture(); await f.prepare(); const queued = await f.approve(); const lease = await f.lease(queued.jobId!);
  const committed = await f.coordinator.begin('local', queued.id, lease);
  assert.equal(committed.status, 'committed');
  await assert.rejects(f.coordinator.begin('local', queued.id, lease), { code: 'ACTION_RECONCILIATION_REQUIRED' });
  await assert.rejects(f.coordinator.complete('local', queued.id, receipt(f, committed.actionDigest), { tokens: 5, costMinorUnits: '5', currency: 'CNY' }, { ...lease, fencingToken: 0 }), { code: 'STALE_FENCING_TOKEN' });
  await assert.rejects(f.coordinator.complete('local', queued.id, { ...receipt(f, committed.actionDigest), operationKey: 'wrong' }, { tokens: 5, costMinorUnits: '5', currency: 'CNY' }, lease), { code: 'ACTION_RECEIPT_MISMATCH' });
  await f.coordinator.complete('local', queued.id, receipt(f, committed.actionDigest), { tokens: 5, costMinorUnits: '5', currency: 'CNY' }, lease);
  const view = await f.coordinator.get('local', queued.id); assert.equal(view?.status, 'settled'); assert.equal(view?.receipt?.status, 'succeeded');
  const account = await f.store.transact('local', tx => tx.getProjection<any>('budget.account', f.account.id));
  assert.equal(account.heldCostMinorUnits, '0'); assert.equal(account.spentCostMinorUnits, '5');
  assert.equal((await f.store.transact('local', tx => tx.getProjection<Execution>('execution', f.execution.id)))!.status, 'completed');
});

test('未知结果保留原操作与预算，换操作号不能绕过同一对象的待核对状态', async () => {
  const f = await fixture(); await f.prepare(); const queued = await f.approve(); const lease = await f.lease(queued.jobId!);
  const committed = await f.coordinator.begin('local', queued.id, lease);
  await f.coordinator.markUnknown('local', queued.id, lease);
  await assert.rejects(f.coordinator.prepare({ ...f.input, id: 'bypass', operationKey: 'replacement' }, { ...f.options, idempotencyKey: 'bypass' }), { code: 'ACTION_RECONCILIATION_REQUIRED' });
  await assert.rejects(f.coordinator.cancelBeforeDispatch('local', queued.id, 'local-owner'), { code: 'ACTION_RECONCILIATION_REQUIRED' });
  const pending = await f.coordinator.get('local', queued.id); assert.equal(pending?.operationKey, 'stable-operation');
  await f.coordinator.reconcile('local', queued.id, pending!.streamVersion, 'local-owner', receipt(f, committed.actionDigest), { tokens: 5, costMinorUnits: '5', currency: 'CNY' });
  assert.equal((await f.coordinator.get('local', queued.id))?.receipt?.status, 'succeeded');
  const closedJob = await f.store.transact('local', tx => tx.getProjection<Job>('job', queued.jobId!));
  assert.equal(closedJob?.status, 'failed'); assert.ok(closedJob!.fencingToken > lease.fencingToken);
});

test('批准后权限改变阻止承诺，错误回执不结案', async () => {
  const f = await fixture(); await f.prepare(); const queued = await f.approve(); const lease = await f.lease(queued.jobId!);
  f.revoke();
  await assert.rejects(f.coordinator.begin('local', queued.id, lease), /CURRENT_POLICY_REVOKED/);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('toolAdmission').length), 0);
});

test('动作预算和期限不能超出执行授权，关闭预算后不能创建就绪 Job', async () => {
  const small = await fixture(10);
  await assert.rejects(small.prepare(), { code: 'ACTION_BUDGET_EXCEEDED' });
  const f = await fixture();
  await assert.rejects(f.coordinator.prepare({ ...f.input, expiresAt: '2026-11-02T03:00:00.000Z' }, f.options), { code: 'ACTION_AUTHORITY_EXPIRED' });
  await f.prepare(); const approval = await f.coordinator.requestApproval('local', f.input.id);
  await f.kernel.decideApproval('local', 'local-owner', 'approve', approval.id, approval.streamVersion, 'approve_once');
  await f.store.transact('local', tx => closeBudgetAccount(tx, { tenantId: 'local', workspaceId: f.input.workspaceId, principalId: 'local-owner', occurredAt: now, accountId: f.account.id }));
  await assert.rejects(f.coordinator.enqueue('local', f.input.id), { code: 'BUDGET_EXCEEDED' });
  assert.equal(f.store.readJobs('local').length, 0);
});

test('准入回调不能异步或以 false 返回代替拒绝，失败不留下预留', async () => {
  const f = await fixture();
  const predicate = new ActionCoordinator({ ...f.coordinator.options, assertCurrent: () => false });
  await assert.rejects(predicate.prepare(f.input, f.options), { code: 'ACTION_POLICY_INVALID_RESULT' });
  assert.equal(await f.store.transact('local', tx => tx.listProjections('budget.reservation').length), 0);
  assert.throws(() => new ActionCoordinator({ ...f.coordinator.options, assertCurrent: async () => {} }), { code: 'ACTION_POLICY_MUST_BE_SYNCHRONOUS' });
});

test('派发准入收到事务内核验的当前租约，不能仅凭 Worker 名称放行', async () => {
  const f = await fixture(); await f.prepare(); const queued = await f.approve(); const lease = await f.lease(queued.jobId!);
  const coordinator = new ActionCoordinator({ ...f.coordinator.options, assertCurrent: (_tx, context) => {
    if (context.phase === 'dispatch') assert.deepEqual(context.lease, lease);
  } });
  await coordinator.begin('local', queued.id, lease);
});

test('正式动作不能由服务主体代替人员批准，即使工作区角色仍可审核', async () => {
  const f = await fixture(); await f.prepare(); const queued = await f.approve(); const lease = await f.lease(queued.jobId!);
  await f.store.transact('local', tx => {
    const principal = tx.getProjection<any>('principal', 'local-owner');
    tx.putProjection('principal', 'local-owner', { ...principal, kind: 'service' });
  });
  await assert.rejects(f.coordinator.begin('local', queued.id, lease), { code: 'ACTION_HUMAN_APPROVAL_REQUIRED' });
  assert.equal(await f.store.transact('local', tx => tx.listProjections('toolAdmission').length), 0);
});
