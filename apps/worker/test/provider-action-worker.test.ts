// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ActionReceipt } from '@mn/contracts';
import type { BusinessProviderContribution } from '@mn/plugin-sdk';
import { AgentOsKernel, createBudgetAccount } from '@mn/kernel';
import { ActionCoordinator, PROVIDER_ACTION_AGENT_ID, PROVIDER_ACTION_JOB_KIND } from '@mn/business-execution';
import { DEFAULT_PROJECTION_JOURNAL_NAMESPACES, FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, createProviderActionWorkerHandler } from '../src/index.js';
async function fixture(t: test.TestContext, loseResponse: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'mn-provider-worker-'));
  let offset = 0; const now = () => new Date(Date.now() + offset).toISOString();
  const storageOptions = { databaseFile: join(root, 'state.sqlite'), hmacKey: randomBytes(32), projectionJournal: {
    cas: new FileCas({ rootDir: join(root, 'cas') }), keyProvider: new InMemoryKeyProvider(randomBytes(32)), namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES }, now: () => new Date(now()) };
  let store = new SqliteStorage(storageOptions);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  let kernel = new AgentOsKernel(store, { now }); await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '动作验收', viewMode: 'business', pluginIds: ['business'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: workspace.id, pluginId: 'business', subject: '跟进' });
  const target = { tenantId: 'local', workspaceId: workspace.id, provider: 'fixture', objectType: 'opportunity' as const, objectId: 'opportunity',
    sourceVersion: '1', digest: 'a'.repeat(64), observedAt: now(), permissionRef: 'permission' };
  const execution = await kernel.createExecution('local', 'local-owner', 'execution', { workspaceId: workspace.id, threadId: thread.id, pluginId: 'business',
    agentDefinitionId: PROVIDER_ACTION_AGENT_ID, modelBindingId: 'none', executionPrincipalId: 'agent:business', authority: {
      workspaceId: workspace.id, principalId: 'agent:business', toolIds: ['provider.followup'], dataScopes: [{ namespace: 'provider.fixture.opportunity', resourceId: target.objectId, digest: target.digest }],
      autoAllowedEffects: [], budget: { maxSubagents: 0, maxSubagentDepth: 0, maxTokens: 100, maxCostMinorUnits: '100', currency: 'CNY', maxDurationMs: 3600000 } } });
  const account = await store.transact('local', tx => createBudgetAccount(tx, { tenantId: 'local', workspaceId: workspace.id, principalId: 'local-owner', occurredAt: now(),
    scope: { namespace: 'goal', resourceId: 'goal' }, limit: { tokens: 100, costMinorUnits: '100', currency: 'CNY' }, expiresAt: new Date(Date.now() + 3600000).toISOString() }));
  let allowed = true;
  let coordinator = new ActionCoordinator({ store, kernel, now, assertCurrent: (_tx, context) => {
    if (!allowed && !(context.phase === 'cancel' && context.lease) && context.phase !== 'reconcile') throw new Error('REVOKED');
  } });
  const action = await coordinator.prepare({ id: 'action', tenantId: 'local', workspaceId: workspace.id, operationKey: 'operation', goalId: 'goal', nodeId: 'node', attemptId: 'attempt', generation: 1,
    provider: 'fixture', action: 'create_followup_task', target, authorityRevisionId: execution.authorityId, providerBindingVersion: 1, preparedInputRef: 'opaque-input', inputDigest: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 1800000).toISOString() }, { executionId: execution.id, actorId: 'local-owner', idempotencyKey: 'prepare', accountId: account.id,
      toolId: 'provider.followup', toolVersion: '1', amount: { tokens: 10, costMinorUnits: '10', currency: 'CNY' } });
  const approval = await coordinator.requestApproval('local', action.id);
  await kernel.decideApproval('local', 'local-owner', 'approve', approval.id, approval.streamVersion, 'approve_once');
  const queued = await coordinator.enqueue('local', action.id);
  let calls = 0, saved: ActionReceipt | undefined;
  const provider: BusinessProviderContribution = {
    id: 'fixture', version: '1', binding: { id: 'binding', tenantId: 'local', workspaceId: workspace.id, streamVersion: 1, mode: 'builtin',
      bindings: [{ objectType: 'opportunity', provider: 'fixture', allowedActions: ['create_followup_task'], supportedPorts: ['executeAction', 'getReceipt'] }] },
    async readSnapshot() { return { status: 'not_supported', capability: 'readSnapshot' }; },
    async listChanges() { return { status: 'not_supported', capability: 'listChanges' }; },
    async prepareAction() { return { status: 'not_supported', capability: 'prepareAction' }; },
    async executeAction(intent) {
      calls++; assert.equal(intent.status, 'committed');
      assert.equal((await coordinator.get('local', action.id))?.status, 'committed');
      saved = { id: 'receipt', tenantId: 'local', workspaceId: workspace.id, provider: 'fixture', operationKey: intent.operationKey, actionDigest: action.actionDigest,
        status: 'succeeded', receivedAt: now(), completedAt: now(), evidenceRefs: [{ id: 'evidence', tenantId: 'local', workspaceId: workspace.id,
          sourceKind: 'business_fact', protectedContentRef: 'opaque-receipt', sourceVersion: '2', digest: 'c'.repeat(64), permissionRef: 'permission', locator: { paragraph: 'record' } }] };
      if (loseResponse) throw new Error('response lost after provider commit');
      return { status: 'supported', value: saved };
    },
    async getReceipt() { if (!saved) throw new Error('unknown'); return { status: 'supported', value: saved }; },
  };
  const worker = () => new AgentOsWorker({ id: `worker-${randomBytes(8).toString('hex')}`, store, now: () => new Date(now()),
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { [PROVIDER_ACTION_JOB_KIND]: createProviderActionWorkerHandler({ store, coordinator, resolveProvider: async () => provider,
      usageForReceipt: () => ({ tokens: 0, costMinorUnits: '0', currency: 'CNY' }) }) } });
  return { get store() { return store; }, get coordinator() { return coordinator; }, now,
    action: queued, account, worker, calls: () => calls, receipt: () => saved!, revoke: () => { allowed = false; },
    async restart() {
      const policy = coordinator.options.assertCurrent;
      await store.close(); store = new SqliteStorage(storageOptions); await store.rebuildProjections('local');
      kernel = new AgentOsKernel(store, { now }); coordinator = new ActionCoordinator({ store, kernel, now, assertCurrent: policy });
    }, advance(milliseconds: number) { offset += milliseconds; } };

}
test('真实持久 Job 先提交承诺再调用提供方，回执、预算与任务一次结算', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.worker().pollOnce()).status, 'completed'); assert.equal(f.calls(), 1);
  assert.equal((await f.store.getJob(f.action.jobId!))?.status, 'completed');
  assert.equal((await f.coordinator.get('local', f.action.id))?.receipt?.status, 'succeeded');
});
test('提供方提交后丢失响应进入待核对，重启 Worker 不重复副作用', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.worker().pollOnce()).status, 'needs_reconciliation'); assert.equal(f.calls(), 1);
  const pending = (await f.coordinator.get('local', f.action.id))!;
  assert.equal(pending.status, 'needs_reconciliation');
  await f.restart();
  assert.equal((await f.worker().pollOnce()).status, 'idle'); assert.equal(f.calls(), 1);
  const account = await f.store.transact('local', tx => tx.getProjection<any>('budget.account', f.account.id));
  assert.equal(account.heldCostMinorUnits, '10');
  await f.coordinator.reconcile('local', f.action.id, pending.streamVersion, 'local-owner', f.receipt(), { tokens: 0, costMinorUnits: '0', currency: 'CNY' });
  assert.equal((await f.coordinator.get('local', f.action.id))?.status, 'settled'); assert.equal(f.calls(), 1);
});
test('排队后撤权在调用前拒绝并释放已知未使用的预算', async t => {
  const f = await fixture(t, false); f.revoke();
  assert.equal((await f.worker().pollOnce()).status, 'failed'); assert.equal(f.calls(), 0);
  const account = await f.store.transact('local', tx => tx.getProjection<any>('budget.account', f.account.id));
  assert.equal(account.heldCostMinorUnits, '0');
  assert.equal((await f.store.getJob(f.action.jobId!))?.status, 'failed');
});


test('承诺后在调用前进程退出，重开数据库并重建投影也不重放动作', async t => {
  const f = await fixture(t, false);
  const job = (await f.store.claimJob('lost-worker', f.now(), { kinds: [PROVIDER_ACTION_JOB_KIND] }))!;
  const lease = { jobId: job.id, workerId: 'lost-worker', fencingToken: job.fencingToken, occurredAt: f.now() };
  await f.coordinator.begin('local', f.action.id, lease);
  f.advance(31_000); await f.restart();
  assert.equal((await f.worker().pollOnce()).status, 'needs_reconciliation');
  assert.equal(f.calls(), 0);
  assert.equal((await f.coordinator.get('local', f.action.id))?.operationKey, 'operation');
  const account = await f.store.transact('local', tx => tx.getProjection<any>('budget.account', f.account.id));
  assert.equal(account.heldCostMinorUnits, '10');
});
