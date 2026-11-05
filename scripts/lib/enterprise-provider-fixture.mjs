// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryKeyProvider } from '@mn/storage';
import { AgentOsWorker } from '@mn/worker';
import { EnterpriseIdentityService, EnterprisePermissionService, EnterpriseQuotaService } from '@mn/enterprise-services';
import { createEnterpriseEventRepository } from '../../apps/host/dist/enterprise-event-repository.js';
import { EnterpriseBusinessService, enterpriseBusinessFacts } from '../../apps/host/dist/enterprise-business.js';
import { EnterpriseExecutionConfigurationService, executionConfiguration } from '../../apps/host/dist/enterprise-execution-config.js';
import { EnterpriseBuiltinProvider } from '../../apps/host/dist/enterprise-builtin-provider.js';
import { EnterpriseExecutionRuntime } from '../../apps/host/dist/enterprise-execution-runtime.js';

const TENANT = 'enterprise-provider';
const receiptType = 'enterprise.provider.receipt_recorded';
const budgetAmount = { tokens: 10, costMinorUnits: '10', currency: 'CNY' };
const goalBudget = { tokens: 20, costMinorUnits: '20', currency: 'CNY' };
const actor = principalId => ({ tenantId: TENANT, principalId, sessionEpoch: 1 });

export async function enterpriseProviderRuntime({ store, cas, key, tenantId, workspaceId, now = () => new Date().toISOString(), beforeExecute, afterExecute, onExecute }) {
  const keyProvider = new InMemoryKeyProvider(Buffer.from(key, 'hex'));
  const repository = createEnterpriseEventRepository({ store, cas, keyProvider, allowExecutionEvents: true });
  const binding = executionConfiguration(await repository.read(tenantId), workspaceId).binding;
  assert.equal(binding?.mode, 'builtin'); assert.equal(binding.tenantId, tenantId);
  let runtime;
  const provider = new EnterpriseBuiltinProvider({ store, repository, binding, protection: { cas, keyProvider }, now,
    actorFor: context => runtime.providerActor(context),
    assertExecution: (tx, records, intent, context) => runtime.assertProviderExecution(tx, records, intent, context),
  });
  const execute = provider.executeAction.bind(provider);
  provider.executeAction = async (intent, context) => {
    await beforeExecute?.(intent, context);
    await onExecute?.(intent);
    const result = await execute(intent, context);
    if (result.status === 'supported') await afterExecute?.(intent, result.value, context);
    return result;
  };
  runtime = new EnterpriseExecutionRuntime({ store, repository, now, resolveProvider: async (requestedTenant, requestedWorkspace, providerId) => {
    assert.equal(requestedTenant, tenantId); assert.equal(requestedWorkspace, workspaceId); assert.equal(providerId, 'builtin'); return provider;
  }, usageForReceipt: () => ({ tokens: 0, costMinorUnits: '0', currency: 'CNY' }) });
  const worker = id => new AgentOsWorker({ id, tenantId, store: runtime.workerStore(store), now: () => new Date(now()),
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'provider.action.execute': runtime.workerHandler() },
  });
  return { store, cas, repository, provider, runtime, worker, now, business: new EnterpriseBusinessService({ repository, now }), permissions: new EnterprisePermissionService({ repository, now }) };
}

async function waitForBoundary(child, expected) {
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', failed); child.off('exit', exited); };
    const failed = error => { cleanup(); reject(error); };
    const exited = () => failed(new Error('PROVIDER_CHILD_EXITED_BEFORE_BOUNDARY'));
    const message = value => {
      try { assert.equal(value?.status, expected.phase); assert.equal(value?.operationKey, expected.operationKey); cleanup(); resolve(); }
      catch (error) { failed(error); }
    };
    const timer = setTimeout(() => failed(new Error('PROVIDER_CHILD_BOUNDARY_TIMEOUT')), 20000);
    child.on('message', message); child.once('error', failed); child.once('exit', exited);
  });
}
async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(child.kill('SIGKILL'), true);
  const result = await exited; assert.equal(result.signal, 'SIGKILL');
}

export async function verifyEnterpriseProvider({ store, cas, key, pool, rebuild, config, root, connect, registerChild }) {
  const now = () => new Date().toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString();
  const keyProvider = new InMemoryKeyProvider(Buffer.from(key, 'hex'));
  const repository = createEnterpriseEventRepository({ store, cas, keyProvider, allowExecutionEvents: true });
  const identity = new EnterpriseIdentityService({ repository, now }), permissions = new EnterprisePermissionService({ repository, now });
  const business = new EnterpriseBusinessService({ repository, now }), configuration = new EnterpriseExecutionConfigurationService({ repository, now });
  await identity.provision({ tenantId: TENANT, name: '合成内置提供方企业', issuer: 'https://provider-issuer.test/', maxMembers: 3, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
  const workspace = await identity.createWorkspace(actor('admin'), 'provider-workspace', { name: '提供方验收', mode: 'builtin' });
  for (const principalId of ['sales', 'manager']) {
    const invitation = await identity.invite(actor('admin'), 'invite-' + principalId, { id: principalId, subject: principalId, displayName: principalId, organizationAdmin: false });
    await identity.acceptInvitation(actor(principalId), 'accept-' + principalId, principalId, 1, invitation.token);
  }
  const salesRole = { id: 'provider-sales', workspaceId: workspace.id, principalId: 'sales', role: 'sales', scope: { kind: 'workspace' }, operations: ['read', 'write'], fieldClasses: ['public', 'price'], expiresAt };
  await permissions.grantRole(actor('admin'), 'sales-role', salesRole);
  await permissions.grantRole(actor('admin'), 'manager-role', { ...salesRole, id: 'provider-manager', principalId: 'manager', role: 'sales_manager', operations: ['read', 'write', 'business_approve', 'execution_approve'] });
  await configuration.configure(actor('admin'), workspace.id, 'settings', { expectedStreamVersion: 0, responsibilities: [{ id: 'sales', capabilities: ['create_followup_task', 'update_followup_date'], fieldClasses: ['public', 'price'] }] });
  const binding = { tenantId: TENANT, workspaceId: workspace.id, id: 'builtin', streamVersion: 1, mode: 'builtin', bindings: [
    { objectType: 'customer', provider: 'builtin', allowedActions: ['create_followup_task', 'update_followup_date'], supportedPorts: ['readSnapshot', 'listChanges', 'prepareAction', 'executeAction', 'getReceipt'] },
    { objectType: 'followup_task', provider: 'builtin', allowedActions: [], supportedPorts: ['readSnapshot', 'listChanges'] },
  ] };
  await configuration.registerBinding(actor('admin'), workspace.id, 'binding', 0, binding);
  const quotas = new EnterpriseQuotaService({ repository, now });
  const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 2000, costMinorUnits: '2000', currency: 'CNY', evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '100', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '10', validFrom: new Date(Date.now() - 10000).toISOString(), expiresAt };
  await quotas.provision(TENANT, 'quota-platform', 0, limits); await quotas.configure(actor('admin'), 'quota-workspace', workspace.id, 0, limits);
  await pool.query('create table fixture_provider.builtin_calls(operation_key text primary key, calls integer not null)');

  let beforeExecute, afterExecute, child, clockOffset = 0;
  const countCall = intent => pool.query('insert into fixture_provider.builtin_calls values($1,1) on conflict(operation_key) do update set calls=fixture_provider.builtin_calls.calls+1', [intent.operationKey]);
  const assemble = connection => enterpriseProviderRuntime({ store: connection.store, cas: connection.cas, key, tenantId: TENANT, workspaceId: workspace.id, now: connection.now ?? now,
    beforeExecute: async (intent, context) => { const fn = beforeExecute; beforeExecute = undefined; await fn?.(intent, context); },
    afterExecute: async (intent, receipt) => { const fn = afterExecute; afterExecute = undefined; await fn?.(intent, receipt); }, onExecute: countCall });
  let f = await assemble({ store, cas, now });
  const otherConnection = await connect(), other = await assemble(otherConnection);
  const calls = async operationKey => (await pool.query('select calls from fixture_provider.builtin_calls where operation_key=$1', [operationKey])).rows[0]?.calls ?? 0;
  const context = (principalId = 'sales') => ({ tenantId: TENANT, workspaceId: workspace.id, principalId, principalSessionEpoch: 1, signal: new AbortController().signal });
  const facts = async runtime => enterpriseBusinessFacts(await runtime.repository.read(TENANT), TENANT, workspace.id);
  const receipts = async operationKey => (await f.repository.read(TENANT)).filter(record => record.type === receiptType && record.payload.operationKey === operationKey);
  const tasks = async operationKey => (await f.business.list(actor('manager'), workspace.id, 'followup_task')).filter(task => task.values.operationKey === operationKey);
  const reservation = action => f.store.transact(TENANT, tx => tx.getProjection('budget.reservation', action.reservationId));
  let sequence = 0;
  const command = (selected, body) => selected.business.execute({ actor: actor('sales'), actorKind: 'human', workspaceId: workspace.id, idempotencyKey: 'provider-business-' + (++sequence), command: body });
  const prepare = async operationKey => {
    const customer = await command(f, { type: 'customer.create', id: operationKey, name: 'CONFIDENTIAL-provider-customer-' + operationKey });
    const request = { tenantId: TENANT, workspaceId: workspace.id, operationKey, providerBindingVersion: 1, target: customer.reference, expiresAt: new Date(Date.now() + 3600000).toISOString(), action: 'create_followup_task', input: { title: 'CONFIDENTIAL-provider-followup', dueAt: new Date(Date.now() + 86400000).toISOString() } };
    const before = await facts(f), reply = await f.provider.prepareAction(request, context());
    assert.equal(reply.status, 'supported'); assert.deepEqual(await f.provider.prepareAction(request, context()), reply);
    assert.deepEqual(await facts(f), before); assert.equal((await tasks(operationKey)).length, 0);
    const nativeInput = { ...reply.value, target: request.target, idempotencyKey: operationKey, operationKey, goalId: 'provider-goal-' + operationKey, nodeId: request.action, attemptId: 'attempt-' + operationKey, responsibilityId: 'sales', action: request.action, amount: budgetAmount, goalBudget };
    const action = await f.runtime.prepare(actor('sales'), nativeInput);
    assert.ok(action.executionApprovalRef);
    await assert.rejects(f.runtime.decide(actor('sales'), 'self-approve-' + operationKey, action.executionApprovalRef, 1, action.actionDigest, 'approve_once'));
    await f.runtime.decide(actor('manager'), 'approve-' + operationKey, action.executionApprovalRef, 1, action.actionDigest, 'approve_once');
    return { request, prepared: reply.value, nativeInput, action };
  };
  const assertAtomicReceipt = async (selected, operationKey, receipt) => {
    const events = []; let position = 0;
    for (;;) {
      const page = await selected.store.readEventHistory(TENANT, position, 1000); events.push(...page.events);
      assert.ok(events.length <= 10000, 'The synthetic provider history exceeded its bound');
      if (page.events.length < 1000) break;
      position = page.events.at(-1).position;
    }
    const index = events.findIndex(event => event.type === receiptType && event.aggregateId === receipt.id);
    assert.ok(index >= 2);
    assert.deepEqual(events.slice(index - 2, index + 2).map(event => event.type), ['enterprise.business.followup_task.created', 'enterprise.business.customer.followup_scheduled', receiptType, 'enterprise.batch.committed']);
    assert.equal(events[index + 1].publicPayload.recordCount, 3);
    const records = (await selected.repository.read(TENANT)).filter(record => record.type === receiptType && record.payload.operationKey === operationKey);
    assert.equal(records.length, 1); assert.equal(records[0].payload.receipt.actionDigest, receipt.actionDigest);
  };
  const crashAt = async (operationKey, phase) => {
    const item = await prepare(operationKey), file = join(root, 'enterprise-provider-child.json');
    await writeFile(file, JSON.stringify({ ...config, enterpriseProvider: { tenantId: TENANT, workspaceId: workspace.id, operationKey, phase, clockOffset } }), { mode: 0o600 });
    child = fork(new URL('../enterprise-provider-child.mjs', import.meta.url), [file], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=128' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    registerChild?.(child);
    child.stderr?.resume();
    await waitForBoundary(child, { operationKey, phase });
    const committed = await f.runtime.get(actor('manager'), item.action.id); assert.equal(committed.status, 'committed');
    const job = await f.store.transact(TENANT, tx => tx.getProjection('job', committed.jobId));
    assert.equal(job.leaseOwner, 'builtin-provider-child'); assert.ok(job.fencingToken > 0);
    await killChild(child); child = undefined;
    return { ...item, lease: { jobId: job.id, workerId: job.leaseOwner, fencingToken: job.fencingToken } };
  };
  try {
    const first = await prepare('provider-success');
    const snapshots = await f.provider.readSnapshot(first.request.target, context()); assert.equal(snapshots.status, 'supported');
    const initialContent = await f.provider.readContent(snapshots.value.protectedContentRef, context()); assert.deepEqual(initialContent.reference, first.request.target);
    const raced = await Promise.all([f.worker('provider-a').pollOnce(), other.worker('provider-b').pollOnce()]);
    assert.equal(raced.filter(result => result.status === 'completed').length, 1);
    const firstReceipt = await f.provider.getReceipt(first.action.operationKey, context()); assert.equal(firstReceipt.status, 'supported'); assert.equal(firstReceipt.value.status, 'succeeded');
    assert.equal((await tasks(first.action.operationKey)).length, 1); assert.equal(await calls(first.action.operationKey), 1);
    assert.equal((await business.get(actor('sales'), workspace.id, 'customer', first.action.operationKey)).reference.streamVersion, 2);
    await assertAtomicReceipt(f, first.action.operationKey, firstReceipt.value);

    const lost = await prepare('provider-lost-response');
    afterExecute = async () => { throw new Error('SYNTHETIC_RESPONSE_LOST_AFTER_PROVIDER_COMMIT'); };
    assert.equal((await f.worker('provider-lost').pollOnce()).status, 'needs_reconciliation');
    let pending = await f.runtime.get(actor('manager'), lost.action.id), held = await reservation(pending);
    assert.equal(held.status, 'unknown'); assert.deepEqual(held.amount, budgetAmount); assert.equal(held.operationKey, lost.action.operationKey);
    const account = await f.store.transact(TENANT, tx => tx.getProjection('budget.account', held.accountId));
    assert.equal(account.heldCostMinorUnits, '10'); assert.equal(account.spentCostMinorUnits, '0');
    assert.equal((await f.runtime.prepare(actor('sales'), lost.nativeInput)).id, pending.id);
    const receiptBeforeRebuild = await f.provider.getReceipt(lost.action.operationKey, context());
    await rebuild(TENANT); f = await assemble({ store, cas, now });
    assert.deepEqual(await f.provider.getReceipt(lost.action.operationKey, context()), receiptBeforeRebuild);
    assert.deepEqual(await f.provider.readContent(snapshots.value.protectedContentRef, context()), initialContent);
    assert.equal((await f.worker('provider-after-rebuild').pollOnce()).status, 'idle');
    pending = await f.runtime.get(actor('manager'), lost.action.id);
    const settled = await f.runtime.reconcile(actor('manager'), 'reconcile-lost', pending.id, pending.streamVersion);
    assert.deepEqual(await f.runtime.reconcile(actor('manager'), 'reconcile-lost', pending.id, pending.streamVersion), settled);
    assert.equal(settled.reservationId, held.id); assert.equal((await reservation(settled)).status, 'settled');
    assert.equal(await calls(lost.action.operationKey), 1); assert.equal((await tasks(lost.action.operationKey)).length, 1);

    const revoked = await prepare('provider-revoked-during-commit'), beforeRevoke = await facts(f);
    const originalPut = cas.put, put = originalPut.bind(cas); let revokeBoundary = false;
    cas.put = async bytes => {
      const result = await put(bytes); let purpose;
      try { purpose = JSON.parse(Buffer.from(bytes).toString('utf8')).context?.purpose; } catch { /* Projection ciphertext is not an E1 envelope. */ }
      if (!revokeBoundary && typeof purpose === 'string' && purpose.startsWith('enterprise-event:')) {
        revokeBoundary = true;
        await other.permissions.revoke(actor('admin'), 'revoke-at-provider-commit', 'role', salesRole.id, 1);
      }
      return result;
    };
    try { assert.equal((await f.worker('provider-revoke').pollOnce()).status, 'needs_reconciliation'); }
    finally { cas.put = originalPut; }
    assert.equal(revokeBoundary, true); assert.deepEqual(await facts(f), beforeRevoke);
    assert.equal((await receipts(revoked.action.operationKey)).length, 0); assert.equal((await tasks(revoked.action.operationKey)).length, 0);
    await assert.rejects(f.provider.readContent(snapshots.value.protectedContentRef, context()), { code: 'OBJECT_ACCESS_DENIED' });
    await permissions.grantRole(actor('admin'), 'restore-sales-role', { ...salesRole, id: 'provider-sales-restored' });

    const conflict = await prepare('provider-source-conflict'); let changed;
    beforeExecute = async () => {
      changed = await command(other, { type: 'customer.rename', id: conflict.action.operationKey, expectedStreamVersion: 1, name: 'CONFIDENTIAL-concurrent-update' });
    };
    assert.equal((await f.worker('provider-source-race').pollOnce()).status, 'needs_reconciliation');
    assert.equal(changed.reference.streamVersion, 2);
    assert.deepEqual((await f.business.get(actor('manager'), workspace.id, 'customer', conflict.action.operationKey)).reference, changed.reference);
    assert.equal((await tasks(conflict.action.operationKey)).length, 0); assert.equal((await receipts(conflict.action.operationKey)).length, 0);
    await assert.rejects(f.provider.getReceipt(conflict.action.operationKey, context('manager')), { code: 'PROVIDER_RECEIPT_UNAVAILABLE' });

    const effectCrash = await crashAt('provider-crash-after-effect', 'effect_committed');
    assert.equal(await calls(effectCrash.action.operationKey), 1); assert.equal((await tasks(effectCrash.action.operationKey)).length, 1);
    const savedReceipt = await f.provider.getReceipt(effectCrash.action.operationKey, context('manager')); assert.equal(savedReceipt.status, 'supported');
    await assertAtomicReceipt(f, effectCrash.action.operationKey, savedReceipt.value);
    const recoveredConnection = await connect({ offset: 31000 });
    await rebuild(TENANT); f = await assemble(recoveredConnection); clockOffset = 31000;
    assert.equal((await f.worker('provider-recover-effect').pollOnce()).status, 'needs_reconciliation');
    pending = await f.runtime.get(actor('manager'), effectCrash.action.id); assert.equal((await reservation(pending)).status, 'unknown');
    await f.runtime.reconcile(actor('manager'), 'reconcile-crash', pending.id, pending.streamVersion);
    assert.equal(await calls(effectCrash.action.operationKey), 1); assert.equal((await tasks(effectCrash.action.operationKey)).length, 1);

    const unknownCrash = await crashAt('provider-crash-before-effect', 'dispatch_committed');
    assert.equal(await calls(unknownCrash.action.operationKey), 0); assert.equal((await tasks(unknownCrash.action.operationKey)).length, 0);
    const missingProofConnection = await connect({ offset: 7200000 });
    await rebuild(TENANT); f = await assemble(missingProofConnection);
    assert.equal((await f.worker('provider-recover-unknown').pollOnce()).status, 'needs_reconciliation');
    pending = await f.runtime.get(actor('manager'), unknownCrash.action.id);
    assert.equal(pending.operationKey, unknownCrash.action.operationKey); assert.equal(pending.reservationId, unknownCrash.action.reservationId);
    assert.ok(Date.parse(pending.expiresAt) < Date.parse(missingProofConnection.now()));
    const retained = await reservation(pending); assert.equal(retained.status, 'unknown'); assert.deepEqual(retained.amount, budgetAmount);
    assert.equal((await f.store.transact(TENANT, tx => tx.getProjection('budget.account', retained.accountId))).heldCostMinorUnits, '10');
    await assert.rejects(f.store.transact(TENANT, tx => tx.assertJobLease({ ...unknownCrash.lease, occurredAt: missingProofConnection.now() })), { code: 'STALE_FENCING_TOKEN' });
    await assert.rejects(f.provider.getReceipt(pending.operationKey, context('manager')), { code: 'PROVIDER_RECEIPT_UNAVAILABLE' });
    await assert.rejects(f.runtime.reconcile(actor('manager'), 'no-recovery-proof', pending.id, pending.streamVersion), { code: 'PROVIDER_RECEIPT_UNAVAILABLE' });
    assert.equal(await calls(pending.operationKey), 0); assert.equal((await receipts(pending.operationKey)).length, 0);
    const raw = await pool.query('select public_payload::text from mn_enterprise_v1.events where tenant_id=$1', [TENANT]);
    assert.doesNotMatch(JSON.stringify(raw.rows), /CONFIDENTIAL|inputDigest|preparedInputRef|permissionDigest/);
    assert.deepEqual((await pool.query('select value from mn_v2.sentinel')).rows, [{ value: 'untouched' }]);
    process.stdout.write('E5.1 PostgreSQL：真实内置准备、原生审批、双 Worker、业务与回执原子提交、响应丢失核对、提交撤权、源版本竞争、两处 SIGKILL、投影重建及缺少恢复证明时保留未知通过。\n');
  } finally { if (child) await killChild(child); }
}
