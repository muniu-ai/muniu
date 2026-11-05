// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionIntentView, type ProviderBinding } from '@mn/contracts';
import { EnterpriseQuotaService } from '@mn/enterprise-services';
import { fixture } from './fixtures/business.js';
import { EnterpriseBuiltinProvider } from '../src/enterprise-builtin-provider.js';
import { EnterpriseExecutionRuntime } from '../src/enterprise-execution-runtime.js';
import { EnterpriseExecutionConfigurationService } from '../src/enterprise-execution-config.js';
async function setup(t: test.TestContext, provisionQuota = true, continuity = true) {
  const f = await fixture(t, true, true), base = await f.base(), config = new EnterpriseExecutionConfigurationService({ repository: f.repository, now: f.now });
  await f.permissions.grantRole(f.admin, 'manager-exec', { id: 'manager-exec', workspaceId: f.workspace.id, principalId: 'manager', role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read','execution_approve'], fieldClasses: ['public','price'], expiresAt: '2027-01-01T00:00:00.000Z' });
  await config.configure(f.admin, f.workspace.id, 'configure', { expectedStreamVersion: 0, responsibilities: [{ id: 'sales', capabilities: ['create_followup_task','update_followup_date','issue_quote_package'], fieldClasses: ['public','price'] }] });
  const binding: ProviderBinding = { tenantId: 'tenant', workspaceId: f.workspace.id, id: 'builtin', streamVersion: 1, mode: 'builtin', bindings: ['customer','opportunity','quote_version','followup_task'].map(type => ({ objectType: type as 'customer'|'opportunity'|'quote_version'|'followup_task', provider: 'builtin', allowedActions: type === 'quote_version' ? ['issue_quote_package'] : type === 'followup_task' ? [] : ['create_followup_task','update_followup_date'], supportedPorts: ['readSnapshot','listChanges','prepareAction','executeAction','getReceipt'] })) };
  await config.registerBinding(f.admin, f.workspace.id, 'binding', 0, binding);
  const quota = new EnterpriseQuotaService({ repository: f.repository, now: f.now }), limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 1000, costMinorUnits: '100', currency: 'CNY' as const, evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '10', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '1', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' };
  if (provisionQuota) { await quota.provision('tenant', 'platform', 0, limits); await quota.configure(f.admin, 'quota', f.workspace.id, 0, limits); }
  let runtime: EnterpriseExecutionRuntime;
  const provider = new EnterpriseBuiltinProvider({ store: f.store, repository: f.repository, binding, protection: { cas: f.cas, keyProvider: f.keyProvider }, now: f.now, actorFor: async ctx => f.actor(ctx.principalId), hasContinuousHistory: () => continuity, assertExecution: (tx, records, intent, ctx) => runtime.assertProviderExecution(tx, records, intent, ctx) });
  runtime = new EnterpriseExecutionRuntime({ store: f.store, repository: f.repository, now: f.now, resolveProvider: async () => provider, usageForReceipt: () => ({ tokens: 0, costMinorUnits: '0', currency: 'CNY' }) });
  const worker = runtime.createWorker({ id: 'builtin-worker', jobs: f.store, lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' } });
  const context = (person = 'sales') => ({ tenantId: 'tenant', workspaceId: f.workspace.id, principalId: person, signal: new AbortController().signal });
  const prepare = async (operationKey: string, goalBudget = { tokens: 0, costMinorUnits: '0', currency: 'CNY' as const }) => {
    const target = (await f.get('customer', 'customer')).reference, draft = { tenantId: 'tenant', workspaceId: f.workspace.id, operationKey, providerBindingVersion: 1, target, expiresAt: '2026-11-02T02:00:00.000Z', action: 'create_followup_task' as const, input: { title: '核对下一步', dueAt: '2026-11-03T00:00:00.000Z' } };
    const prepared = await provider.prepareAction(draft, context()); if (prepared.status !== 'supported') throw new Error('unsupported');
    return runtime.prepare(f.actor('sales'), { ...prepared.value, idempotencyKey: operationKey, goalId: 'goal-' + operationKey, nodeId: 'followup', attemptId: 'attempt-' + operationKey, operationKey, responsibilityId: 'sales', target, action: draft.action, amount: { tokens: 0, costMinorUnits: '0', currency: 'CNY' }, goalBudget });
  };
  return { ...f, base, provider, runtime, worker, context, prepare };
}
test('内置动作经原生批准和 Worker 执行，业务事实与回执一同保存，重复回执不重写对象', async t => {
  const f = await setup(t), action = await f.prepare('once');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  assert.equal((await f.worker.pollOnce()).status, 'completed');
  const tasks = await f.service.list(f.actor('sales'), f.workspace.id, 'followup_task');
  assert.equal(tasks.length, 1); assert.equal(tasks[0]!.values.title, '核对下一步');
  const receipt = await f.provider.getReceipt(action.operationKey, f.context());
  assert.equal(receipt.status, 'supported'); if (receipt.status !== 'supported') throw new Error('missing receipt');
  assert.equal(receipt.value.status, 'succeeded');
  assert.deepEqual(await f.provider.getReceipt(action.operationKey, f.context()), receipt);
  assert.equal((await f.get('customer','customer')).reference.streamVersion, 2);
  assert.equal((await f.runtime.get(f.actor('manager'), action.id)).status, 'settled');
  await assert.rejects(f.provider.getReceipt('unseen', f.context()), { code: 'PROVIDER_RECEIPT_UNAVAILABLE' });
});
test('仅把状态字符串改成 committed 不能执行，缺少实际租约也不能产生业务事实', async t => {
  const f = await setup(t), action = await f.prepare('forged');
  await assert.rejects(f.provider.executeAction({ ...actionIntentView(action), status: 'committed' }, { ...f.context(), authorityRevisionId: action.authorityRevisionId }), { code: 'PROVIDER_EXECUTION_NOT_COMMITTED' });
  assert.equal((await f.service.list(f.actor('sales'), f.workspace.id, 'followup_task')).length, 0);
});

test('业务提交后响应丢失只核对原回执，不再执行跟进或改变原操作标识', async t => {
  const f = await setup(t), execute = f.provider.executeAction.bind(f.provider); let calls = 0;
  f.provider.executeAction = async (intent, ctx) => { calls++; await execute(intent, ctx); throw new Error('response-lost'); };
  const action = await f.prepare('lost-response');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  assert.equal((await f.worker.pollOnce()).status, 'needs_reconciliation'); assert.equal(calls, 1);
  const pending = await f.runtime.get(f.actor('manager'), action.id);
  await f.runtime.reconcile(f.actor('manager'), 'reconcile', action.id, pending.streamVersion);
  assert.equal((await f.runtime.get(f.actor('manager'), action.id)).status, 'settled');
  assert.equal((await f.service.list(f.actor('sales'), f.workspace.id, 'followup_task')).length, 1);
  assert.equal((await f.get('customer','customer')).reference.streamVersion, 2);
  assert.equal(calls, 1);
});
test('无模型和模型额度时，零用量的人工业务动作仍可经过正式审批执行', async t => {
  const f = await setup(t, false), action = await f.prepare('no-model');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  assert.equal((await f.worker.pollOnce()).status, 'completed');
  assert.equal((await f.service.list(f.actor('sales'), f.workspace.id, 'followup_task')).length, 1);
});

test('零成本动作不能借机开通非零模型额度，陈旧租约不能写入业务', async t => {
  const noQuota = await setup(t, false);
  await assert.rejects(noQuota.prepare('unfunded', { tokens: 10, costMinorUnits: '10', currency: 'CNY' }), { code: 'MODEL_QUOTA_UNCONFIGURED' });
  const f = await setup(t), action = await f.prepare('stale-lease');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  const job = await f.store.claimJob('stale-worker', f.now(), { tenantId: 'tenant', kinds: ['provider.action.execute'] }); assert.ok(job);
  const lease = { jobId: job.id, workerId: 'stale-worker', fencingToken: job.fencingToken, occurredAt: f.now() };
  const committed = await f.runtime.coordinator.begin('tenant', action.id, lease);
  f.advance('2026-11-02T01:00:31.000Z');
  await assert.rejects(f.provider.executeAction({ ...actionIntentView(committed), status: 'committed' }, { ...f.context(), authorityRevisionId: action.authorityRevisionId, executionLease: { jobId: job.id, workerId: 'stale-worker', fencingToken: job.fencingToken } }), { code: 'STALE_FENCING_TOKEN' });
  assert.equal((await f.service.list(f.actor('sales'), f.workspace.id, 'followup_task')).length, 0);
});
test('已承诺但尚未进入提供方的操作，到期后凭原准备记录确认未执行并持久保存回执', async t => {
  const f = await setup(t), action = await f.prepare('expired-before-call');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  const job = await f.store.claimJob('expired-worker', f.now(), { tenantId: 'tenant', kinds: ['provider.action.execute'] }); assert.ok(job);
  const committed = await f.runtime.coordinator.begin('tenant', action.id, { jobId: job.id, workerId: 'expired-worker', fencingToken: job.fencingToken, occurredAt: f.now() });
  f.advance('2026-11-02T02:00:01.000Z');
  const result = await f.provider.getReceipt(action.operationKey, f.context('manager'));
  assert.equal(result.status, 'supported'); if (result.status !== 'supported') throw new Error('missing receipt');
  assert.equal(result.value.status, 'not_executed');
  await f.runtime.reconcile(f.actor('manager'), 'expired-reconcile', action.id, committed.streamVersion);
  assert.equal((await f.runtime.get(f.actor('manager'), action.id)).status, 'settled');
  assert.equal((await f.get('customer','customer')).reference.streamVersion, 1);
  assert.equal((await f.service.list(f.actor('sales'), f.workspace.id, 'followup_task')).length, 0);
});

test('缺少存储连续性证明时，不能因回执缺失和到期就宣称未执行', async t => {
  const f = await setup(t, true, false), action = await f.prepare('uncertain-history');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  const job = await f.store.claimJob('uncertain-worker', f.now(), { tenantId: 'tenant', kinds: ['provider.action.execute'] }); assert.ok(job);
  await f.runtime.coordinator.begin('tenant', action.id, { jobId: job.id, workerId: 'uncertain-worker', fencingToken: job.fencingToken, occurredAt: f.now() });
  f.advance('2026-11-02T02:00:01.000Z');
  await assert.rejects(f.provider.getReceipt(action.operationKey, f.context('manager')), { code: 'PROVIDER_RECEIPT_UNAVAILABLE' });
  assert.equal((await f.runtime.get(f.actor('manager'), action.id)).status, 'committed');
});
test('正式报价出包绑定业务与执行批准，文件摘要对应实际字节，出包不等于客户接受', async t => {
  const f = await setup(t);
  const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
  const request = { tenantId: 'tenant', workspaceId: f.workspace.id, operationKey: 'quote-package', providerBindingVersion: 1, target: quote.reference, action: 'issue_quote_package' as const, businessApprovalRef: String(quote.values.approvalId), expiresAt: '2026-11-02T02:00:00.000Z', input: { format: 'docx' as const } };
  const prepared = await f.provider.prepareAction(request, f.context()); if (prepared.status !== 'supported') throw new Error('unsupported');
  const preview = await f.provider.readPrepared(prepared.value.preparedInputRef, f.context('manager'));
  assert.equal(preview.inputDigest, prepared.value.inputDigest); assert.equal(preview.request.action, 'issue_quote_package'); assert.ok(preview.document);
  const stagedFile = await f.provider.readPackage(preview.document!.protectedContentRef, f.context('manager'));
  assert.equal(stagedFile.official, false);
  const action = await f.runtime.prepare(f.actor('sales'), { ...prepared.value, target: quote.reference, businessApprovalRef: request.businessApprovalRef, idempotencyKey: 'quote-package', operationKey: request.operationKey, goalId: 'quote-goal', nodeId: 'package', attemptId: 'package-attempt', responsibilityId: 'sales', action: request.action, amount: { tokens: 0, costMinorUnits: '0', currency: 'CNY' }, goalBudget: { tokens: 0, costMinorUnits: '0', currency: 'CNY' } });
  await assert.rejects(f.runtime.decide(f.actor('sales'), 'maker-approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once'));
  await f.runtime.decide(f.actor('manager'), 'package-approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  assert.equal((await f.worker.pollOnce()).status, 'completed');
  const file = await f.provider.readPackage(preview.document!.protectedContentRef, f.context('manager'));
  const { createHash } = await import('node:crypto');
  assert.equal(file.digest, createHash('sha256').update(Buffer.from(file.bytesBase64, 'base64')).digest('hex'));
  assert.equal(file.official, true);
  const { extractDocument } = await import('../src/document-extraction.js');
  const parsed = await extractDocument({ fileName: 'quote.docx', mediaType: file.mediaType, bytes: Buffer.from(file.bytesBase64, 'base64') });
  const text = parsed.blocks.map(b => b.text).join('\n');
  assert.match(text, /业务报价已批准/); assert.doesNotMatch(text, /成果接收/);
  const result = await f.get('quote_version','quote');
  assert.equal(result.values.status, 'approved'); assert.equal(result.values.totalMinor, 30000);
  await assert.rejects(f.provider.readPackage(preview.document!.protectedContentRef, f.context('viewer')), { code: 'FIELD_ACCESS_DENIED' });
});
test('提供方产生的业务变化保留原操作来源，持续规则不能把自己的结果重复接单', async t => {
  const f = await setup(t);
  const { EnterpriseOperatingService, OPERATING } = await import('../src/enterprise-operating.js');
  const operating = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  await operating.initializeWorkspace('tenant', f.workspace.id);
  const action = await f.prepare('self-origin');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  assert.equal((await f.worker.pollOnce()).status, 'completed');
  await operating.ingestBusinessChanges('tenant', f.workspace.id);
  const triggers = await f.store.transact('tenant', tx => tx.listProjections<{ status: string }>(OPERATING.trigger));
  assert.ok(triggers.length >= 2); assert.ok(triggers.every(row => row.status === 'loop_filtered'));
  const changes = await f.provider.listChanges(null, f.context());
  if (changes.status !== 'supported') throw new Error('missing changes');
  const own = changes.value.changes.filter(change => change.causedByOperationKey === action.operationKey);
  assert.equal(own.length, 2); assert.ok(own.every(change => change.origin === 'muniu'));
});
test('动作回执的受保护引用能核对真实结果对象，失权后不能继续读取', async t => {
  const f = await setup(t), action = await f.prepare('receipt-evidence');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  assert.equal((await f.worker.pollOnce()).status, 'completed');
  const result = await f.provider.getReceipt(action.operationKey, f.context());
  if (result.status !== 'supported' || result.value.status !== 'succeeded') throw new Error('missing receipt');
  const evidence = await f.provider.readReceiptEvidence(result.value.evidenceRefs[0]!.protectedContentRef, f.context());
  assert.equal(evidence.receipt.operationKey, action.operationKey);
  assert.equal(evidence.result!.objectType, 'followup_task');
  assert.equal((await f.get('followup_task', evidence.result!.objectId)).values.title, '核对下一步');
  await f.permissions.revoke(f.admin, 'revoke-evidence', 'role', 'sales-own', 1);
  await assert.rejects(f.provider.readReceiptEvidence(result.value.evidenceRefs[0]!.protectedContentRef, f.context()), { code: 'OBJECT_ACCESS_DENIED' });
});
test('重复 execute 在异步读取期间失权时，不能从旧快照返回成功回执', async t => {
  const f = await setup(t), action = await f.prepare('replay-revocation');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  assert.equal((await f.worker.pollOnce()).status, 'completed');
  const settled = await f.runtime.get(f.actor('manager'), action.id);
  const { createEnterpriseEventRepository } = await import('../src/enterprise-event-repository.js');
  const { EnterprisePermissionService } = await import('@mn/enterprise-services');
  const permissions = new EnterprisePermissionService({ repository: createEnterpriseEventRepository({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, allowExecutionEvents: true }), now: f.now });
  const read = f.repository.read.bind(f.repository); let revoke = true;
  f.repository.read = async tenant => { const old = await read(tenant); if (revoke) { revoke = false; await permissions.revoke(f.admin, 'revoke-replay', 'role', 'sales-own', 1); } return old; };
  await assert.rejects(f.provider.executeAction({ ...actionIntentView(settled), status: 'committed' }, { ...f.context(), authorityRevisionId: action.authorityRevisionId }), { code: 'OBJECT_ACCESS_DENIED' });
});
test('并发 execute 在输入解密后命中内层既有回执时，仍须拒绝另一仓库已提交的撤权', async t => {
  const f = await setup(t), action = await f.prepare('concurrent-replay-revocation');
  await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
  const workerId = 'concurrent-provider-worker';
  const job = await f.store.claimJob(workerId, f.now(), { tenantId: 'tenant', kinds: ['provider.action.execute'] }); assert.ok(job);
  const committed = await f.runtime.coordinator.begin('tenant', action.id, { jobId: job.id, workerId, fencingToken: job.fencingToken, occurredAt: f.now() });
  const intent = { ...actionIntentView(committed), status: 'committed' as const };
  const context = { ...f.context(), authorityRevisionId: committed.authorityRevisionId, executionLease: { jobId: job.id, workerId, fencingToken: job.fencingToken } };
  const { createEnterpriseEventRepository } = await import('../src/enterprise-event-repository.js');
  const { EnterprisePermissionService, EnterpriseError } = await import('@mn/enterprise-services');
  const { PROTECTED_PAYLOAD_KEY_NAMESPACE } = await import('@mn/kernel');
  const peerRepository = createEnterpriseEventRepository({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, allowExecutionEvents: true });
  const peerProvider = new EnterpriseBuiltinProvider({ ...f.provider.options, repository: peerRepository });
  const permissions = new EnterprisePermissionService({ repository: peerRepository, now: f.now });
  const inputDigest = await f.store.transact('tenant', tx => {
    const prepared = tx.getProjection<{ protectedPayloadRef: string }>('enterprise-provider.preparation', committed.preparedInputRef)!;
    return tx.getProjection<{ ciphertextDigest: string }>(PROTECTED_PAYLOAD_KEY_NAMESPACE, prepared.protectedPayloadRef)!.ciphertextDigest;
  });
  const get = f.cas.get.bind(f.cas), transact = f.repository.transact;
  let duplicateStarted = false, duplicateCommitted = false, revoked = false, innerReplay = false, receiptObject: string | undefined;
  f.repository.transact = (tenant, work, guard) => transact(tenant, records => {
    const result = work(records);
    if (duplicateCommitted && revoked && !result.events.length && typeof result.value === 'object' && result.value !== null
      && 'operationKey' in result.value && result.value.operationKey === action.operationKey) {
      assert.ok(guard, '必须到达带原生提交检查的内层业务事务');
      assert.ok(records.some(record => record.type === 'enterprise.provider.receipt_recorded' && record.payload.operationKey === action.operationKey));
      innerReplay = true;
    }
    return result;
  }, guard);
  f.cas.get = async digest => {
    const bytes = await get(digest);
    if (digest === inputDigest && !duplicateStarted) {
      duplicateStarted = true;
      const duplicate = await peerProvider.executeAction(intent, context);
      assert.ok(duplicate.status === 'supported' && duplicate.value.status === 'succeeded');
      duplicateCommitted = true;
      const history = await f.store.readEventHistory!('tenant', 0, 1000);
      const event = history.events.find(item => item.type === 'enterprise.provider.receipt_recorded');
      assert.ok(event?.protectedPayloadRef); receiptObject = event.protectedPayloadRef;
    } else if (digest === receiptObject && !revoked) {
      revoked = true;
      await permissions.revoke(f.admin, 'revoke-concurrent-replay', 'role', 'sales-own', 1);
    }
    return bytes;
  };
  let failure: unknown;
  try { await f.provider.executeAction(intent, context); }
  catch (error) { failure = error; }
  finally { f.cas.get = get; f.repository.transact = transact; }
  assert.ok(duplicateStarted && duplicateCommitted, '并发调用必须先真实提交业务与回执');
  assert.ok(revoked, '加载内层回执时必须实际提交撤权');
  assert.ok(innerReplay, '必须覆盖内层 priorReceipt 回放，不能仅覆盖入口回放');
  assert.ok(failure instanceof EnterpriseError, '内层回放必须在返回既有回执前拒绝失权主体');
  assert.equal(failure.code, 'OBJECT_ACCESS_DENIED');
  assert.equal((await f.service.list(f.actor('manager'), f.workspace.id, 'followup_task')).length, 1);
  assert.equal((await f.get('customer', 'customer', 'manager')).reference.streamVersion, 2);
});
