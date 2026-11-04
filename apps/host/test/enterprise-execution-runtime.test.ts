// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionReceipt, BusinessObjectRef, ProviderBinding } from '@mn/contracts';
import type { BusinessProviderContribution } from '@mn/plugin-sdk';
import { EnterpriseQuotaService } from '@mn/enterprise-services';
import { AgentOsWorker } from '@mn/worker';
import { fixture } from './fixtures/business.js';
import { EnterpriseExecutionRuntime } from '../src/enterprise-execution-runtime.js';
import { EnterpriseExecutionConfigurationService } from '../src/enterprise-execution-config.js';
async function setup(t: test.TestContext) {
    const f = await fixture(t, true, true), base = await f.base(), configuration = new EnterpriseExecutionConfigurationService({ repository: f.repository, now: f.now });
    await f.permissions.grantRole(f.admin, 'manager-exec', { id: 'manager-exec', workspaceId: f.workspace.id, principalId: 'manager', role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read', 'execution_approve'], fieldClasses: ['public', 'price', 'contact'], expiresAt: '2027-01-01T00:00:00.000Z' });
    await f.permissions.grantRole(f.admin, 'sales-exec', { id: 'sales-exec', workspaceId: f.workspace.id, principalId: 'sales', role: 'sales', scope: { kind: 'owned' }, operations: ['read', 'execution_approve'], fieldClasses: ['public', 'price', 'contact'], expiresAt: '2027-01-01T00:00:00.000Z' });
    await configuration.configure(f.admin, f.workspace.id, 'config', { expectedStreamVersion: 0, responsibilities: [{ id: 'sales-support', capabilities: ['create_followup_task', 'update_followup_date', 'issue_quote_package'], fieldClasses: ['public', 'price', 'contact'] }] });
    const binding: ProviderBinding = { id: 'binding', tenantId: 'tenant', workspaceId: f.workspace.id, streamVersion: 1, mode: 'builtin', bindings: [{ objectType: 'opportunity', provider: 'fixture', allowedActions: ['create_followup_task', 'update_followup_date'], supportedPorts: ['executeAction', 'getReceipt'] }, { objectType: 'quote_version', provider: 'fixture', allowedActions: ['issue_quote_package'], supportedPorts: ['executeAction', 'getReceipt'] }] };
    await configuration.registerBinding(f.admin, f.workspace.id, 'binding', 0, binding);
    const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 100, costMinorUnits: '100', currency: 'CNY' as const, evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '100', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '10', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' };
    const quotas = new EnterpriseQuotaService({ repository: f.repository, now: f.now });
    await quotas.provision('tenant', 'platform', 0, limits);
    await quotas.configure(f.admin, 'quota', f.workspace.id, 0, limits);
    const receipts = new Map<string, ActionReceipt>();
    let calls = 0, resolveHook: (() => Promise<void>) | undefined, loseResponse = false;
    const provider: BusinessProviderContribution = { id: 'fixture', version: '1', binding, async readSnapshot() { return { status: 'not_supported', capability: 'readSnapshot' }; }, async listChanges() { return { status: 'not_supported', capability: 'listChanges' }; }, async prepareAction() { return { status: 'not_supported', capability: 'prepareAction' }; }, async executeAction(action) { calls++; const receipt: ActionReceipt = { id: 'receipt-' + action.id, tenantId: 'tenant', workspaceId: f.workspace.id, provider: 'fixture', operationKey: action.operationKey, actionDigest: (await runtime.coordinator.get('tenant', action.id))!.actionDigest, status: 'succeeded', receivedAt: f.now(), completedAt: f.now(), evidenceRefs: [{ id: 'proof', tenantId: 'tenant', workspaceId: f.workspace.id, sourceKind: 'business_fact', sourceVersion: '1', digest: 'c'.repeat(64), protectedContentRef: 'protected-receipt', permissionRef: 'fixture', locator: { paragraph: 'record' } }] }; receipts.set(action.operationKey, receipt); if (loseResponse)
            throw new Error('RESPONSE_LOST'); return { status: 'supported', value: receipt }; }, async getReceipt(key) { return receipts.has(key) ? { status: 'supported', value: receipts.get(key)! } : { status: 'supported', value: { id: 'unknown', tenantId: 'tenant', workspaceId: f.workspace.id, provider: 'fixture', operationKey: key, actionDigest: '0'.repeat(64), status: 'unknown', receivedAt: f.now() } }; } };
    const runtime = new EnterpriseExecutionRuntime({ store: f.store, repository: f.repository, now: f.now, resolveProvider: async () => { const hook = resolveHook; resolveHook = undefined; await hook?.(); return provider; }, usageForReceipt: () => ({ tokens: 1, costMinorUnits: '2', currency: 'CNY' }) });
    let sequence = 0;
    const input = (target: BusinessObjectRef, action: 'create_followup_task' | 'issue_quote_package' = 'create_followup_task') => ({ idempotencyKey: 'prepare-' + (++sequence), goalId: 'goal-' + sequence, nodeId: 'node', attemptId: 'attempt', operationKey: 'operation-' + sequence, responsibilityId: 'sales-support', target, action, preparedInputRef: 'opaque-input', inputDigest: 'a'.repeat(64), expiresAt: '2026-11-02T02:00:00.000Z', amount: { tokens: 10, costMinorUnits: '10', currency: 'CNY' }, goalBudget: { tokens: 20, costMinorUnits: '20', currency: 'CNY' } });
    const worker = () => new AgentOsWorker({ id: 'worker', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'provider.action.execute': runtime.workerHandler() } });
    return { ...f, base, configuration, binding, provider, runtime, quotas, limits, input, worker, calls: () => calls, setResolveHook: (hook: () => Promise<void>) => { resolveHook = hook; }, lose: () => { loseResponse = true; } };
}
test('当前企业身份、对象与字段、精确批准共同控制动作，管理员无默认业务权限', async (t) => {
    const f = await setup(t);
    await assert.rejects(f.runtime.prepare(f.admin, f.input(f.base.opportunity.reference)), { code: 'OBJECT_ACCESS_DENIED' });
    const action = await f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference));
    assert.equal(action.status, 'awaiting_approval');
    await assert.rejects(f.runtime.decide(f.actor('viewer'), 'wrong', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once'), { code: 'OBJECT_ACCESS_DENIED' });
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    assert.equal((await f.worker().pollOnce()).status, 'completed');
    assert.equal(f.calls(), 1);
});
test('异步提供方读取期间撤权，Worker 不产生副作用并释放未用预算', async (t) => {
    const f = await setup(t);
    const action = await f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference));
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    f.setResolveHook(async () => { await f.permissions.revoke(f.admin, 'revoke-sales', 'role', 'sales-own', 1); await f.permissions.revoke(f.admin, 'revoke-exec', 'role', 'sales-exec', 1); });
    assert.equal((await f.worker().pollOnce()).status, 'failed');
    assert.equal(f.calls(), 0);
    await assert.rejects(f.runtime.get(f.actor('sales'), action.id), { code: 'OBJECT_ACCESS_DENIED' });
});
test('未知结果保留原操作，核对只查询原回执；取消不能伪造已取消', async (t) => {
    const f = await setup(t);
    f.lose();
    const action = await f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference));
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    assert.equal((await f.worker().pollOnce()).status, 'needs_reconciliation');
    const pending = await f.runtime.get(f.actor('manager'), action.id);
    const cancelled = await f.runtime.cancel(f.actor('sales'), 'cancel', action.id, pending.streamVersion);
    assert.equal(cancelled.status, 'needs_reconciliation');
    assert.equal(f.calls(), 1);
    await f.runtime.reconcile(f.actor('manager'), 'reconcile', action.id, cancelled.streamVersion);
    assert.equal((await f.runtime.get(f.actor('manager'), action.id)).status, 'settled');
    assert.equal(f.calls(), 1);
});
test('正式报价同时要求业务批准和另一个合格人员的精确执行批准', async (t) => {
    const f = await setup(t);
    await f.permissions.grantRole(f.admin, 'qualified-maker', { id: 'qualified-maker', workspaceId: f.workspace.id, principalId: 'sales', role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read', 'execution_approve'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z' });
    await assert.rejects(f.runtime.prepare(f.actor('sales'), f.input(f.base.quote.reference, 'issue_quote_package')), { code: 'BUSINESS_APPROVAL_REQUIRED' });
    const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
    const input = { ...f.input(quote.reference, 'issue_quote_package'), businessApprovalRef: String(quote.values.approvalId) };
    const action = await f.runtime.prepare(f.actor('sales'), input);
    await assert.rejects(f.runtime.decide(f.actor('sales'), 'self', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once'), { code: 'SEPARATION_OF_DUTIES_REQUIRED' });
    await f.runtime.decide(f.actor('manager'), 'manager', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    assert.equal((await f.worker().pollOnce()).status, 'completed');
    assert.equal(f.calls(), 1);
});
test('不同 Goal 共享工作区实际预留，重复创建账户不能各自领取完整额度', async (t) => {
    const f = await setup(t);
    const amount = { tokens: 60, costMinorUnits: '60', currency: 'CNY' };
    const action = await f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), amount, goalBudget: amount });
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), amount, goalBudget: amount }), { code: 'WORKSPACE_BUDGET_EXCEEDED' });
    await f.runtime.cancel(f.actor('sales'), 'cancel', action.id, action.streamVersion);
    assert.equal((await f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), amount, goalBudget: amount })).status, 'awaiting_approval');
});
test('撤权后重新授予相同角色不使旧执行批准复活', async (t) => {
    const f = await setup(t);
    const action = await f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference));
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    await f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1);
    await f.permissions.grantRole(f.admin, 'replacement', { id: 'replacement', workspaceId: f.workspace.id, principalId: 'sales', role: 'sales', scope: { kind: 'owned' }, operations: ['read', 'write'], fieldClasses: ['public', 'price', 'contact'], expiresAt: '2027-01-01T00:00:00.000Z' });
    assert.equal((await f.worker().pollOnce()).status, 'failed');
    assert.equal(f.calls(), 0);
});
test('加密等待期间授权到期，整个准备事务回滚且没有 Job 或预算预留', async (t) => {
    const f = await setup(t), put = f.cas.put.bind(f.cas);
    let once = true;
    f.cas.put = async (bytes) => { const result = await put(bytes); if (once) {
        once = false;
        f.advance('2026-11-02T03:00:00.000Z');
    } return result; };
    await assert.rejects(f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference)));
    assert.equal(await f.store.transact('tenant', tx => tx.listProjections('provider.action').length), 0);
    assert.equal(await f.store.transact('tenant', tx => tx.listProjections('budget.reservation').length), 0);
});
test('已执行请求重发按当前读取权返回原结果，不能因来源推进而创建第二个动作', async (t) => {
    const f = await setup(t), input = f.input(f.base.opportunity.reference), action = await f.runtime.prepare(f.actor('sales'), input);
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    await f.worker().pollOnce();
    await f.command({ type: 'opportunity.update', id: 'opportunity', expectedStreamVersion: 1, customer: f.base.customer.reference, title: '来源已更新' });
    const replay = await f.runtime.prepare(f.actor('sales'), { ...input, idempotencyKey: 'another-request' });
    assert.equal(replay.id, action.id);
    assert.equal(replay.status, 'settled');
    assert.equal(f.calls(), 1);
    assert.equal((await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once')).id, action.id);
});
test('已接受的有限策略经中央批准路径执行，按原策略累计次数且重复请求不再计数', async (t) => {
    const f = await setup(t);
    await f.configuration.writePolicy(f.admin, f.workspace.id, 'policy', { id: 'followup', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', responsibilityId: 'sales-support', action: 'create_followup_task', target: f.base.opportunity.reference, maxActions: 1, validUntil: '2026-12-01T00:00:00.000Z' });
    await f.configuration.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 1, 'accept');
    const input = { ...f.input(f.base.opportunity.reference), policyId: 'followup' }, action = await f.runtime.prepare(f.actor('sales'), input);
    assert.equal(action.status, 'prepared');
    assert.ok(action.jobId);
    const origin = await f.store.transact('tenant', tx => tx.getProjection<any>('execution.approval_context', action.executionApprovalRef!));
    assert.equal(origin.mode, 'policy');
    assert.equal(origin.policyId, 'followup');
    assert.equal((await f.runtime.prepare(f.actor('sales'), { ...input, idempotencyKey: 'repeat' })).id, action.id);
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), policyId: 'followup' }), { code: 'POLICY_LIMIT_REACHED' });
    assert.equal((await f.worker().pollOnce()).status, 'completed');
    assert.equal(f.calls(), 1);
});
test('策略撤销阻止已排队动作，发布新版本也不重置已占用次数', async (t) => {
    const f = await setup(t);
    const definition = { id: 'followup', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', responsibilityId: 'sales-support', action: 'create_followup_task' as const, target: f.base.opportunity.reference, maxActions: 1, validUntil: '2026-12-01T00:00:00.000Z' };
    await f.configuration.writePolicy(f.admin, f.workspace.id, 'policy', definition);
    await f.configuration.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 1, 'accept');
    await f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), policyId: 'followup' });
    await f.configuration.revokePolicy(f.admin, f.workspace.id, 'followup', 2, 'revoke');
    assert.equal((await f.worker().pollOnce()).status, 'failed');
    assert.equal(f.calls(), 0);
    await f.configuration.writePolicy(f.admin, f.workspace.id, 'rewrite', { ...definition, expectedStreamVersion: 3 });
    await f.configuration.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 4, 'accept-new');
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), policyId: 'followup' }), { code: 'POLICY_LIMIT_REACHED' });
});
test('角色重授不恢复旧策略授权；跟进策略不能代替正式报价的逐次批准', async (t) => {
    const f = await setup(t);
    await f.configuration.writePolicy(f.admin, f.workspace.id, 'policy', { id: 'followup', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', responsibilityId: 'sales-support', action: 'create_followup_task', target: f.base.opportunity.reference, maxActions: 2, validUntil: '2026-12-01T00:00:00.000Z' });
    await f.configuration.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 1, 'accept');
    const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(quote.reference, 'issue_quote_package'), businessApprovalRef: String(quote.values.approvalId), policyId: 'followup' }), { code: 'POLICY_ACTION_NOT_ALLOWED' });
    await f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1);
    await f.permissions.grantRole(f.admin, 'replace', { id: 'replace', workspaceId: f.workspace.id, principalId: 'sales', role: 'sales', scope: { kind: 'owned' }, operations: ['read', 'write'], fieldClasses: ['public', 'price', 'contact'], expiresAt: '2027-01-01T00:00:00.000Z' });
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), policyId: 'followup' }), { code: 'POLICY_ACCEPTANCE_STALE' });
});
test('计量不可用时保留预留，核对时只结算原操作且不重复调用', async (t) => {
    const f = await setup(t), input = f.input(f.base.opportunity.reference), action = await f.runtime.prepare(f.actor('sales'), input);
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    const meter = f.runtime.options.usageForReceipt;
    (f.runtime.options as any).usageForReceipt = () => { throw new Error('METER_UNAVAILABLE'); };
    assert.equal((await f.worker().pollOnce()).status, 'needs_reconciliation');
    const pending = await f.runtime.get(f.actor('manager'), action.id);
    assert.equal(f.calls(), 1);
    (f.runtime.options as any).usageForReceipt = meter;
    await f.runtime.reconcile(f.actor('manager'), 'reconcile', action.id, pending.streamVersion);
    assert.equal(f.calls(), 1);
});
test('在途取消中断提供方等待，但在没有确定回执时仍保留原预算', async (t) => {
    const f = await setup(t), action = await f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference));
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.provider.executeAction = async (_intent, context) => { entered(); await new Promise<void>((_resolve, reject) => { if (context.signal.aborted)
        reject(new Error('ABORTED'));
    else
        context.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true }); }); throw new Error('UNREACHABLE'); };
    const running = f.worker().pollOnce();
    await started;
    const current = await f.runtime.get(f.actor('sales'), action.id);
    await f.runtime.cancel(f.actor('sales'), 'cancel', action.id, current.streamVersion);
    assert.equal((await running).status, 'needs_reconciliation');
    assert.equal(f.calls(), 0);
    const reservation = await f.store.transact('tenant', tx => tx.getProjection<any>('budget.reservation', action.reservationId));
    assert.equal(reservation.status, 'unknown');
    assert.equal(reservation.amount.costMinorUnits, '10');
});
test('取消请求之后实际成功的在途动作仍按真实回执结算，不能显示成未执行', async (t) => {
    const f = await setup(t), action = await f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference));
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const execute = f.provider.executeAction.bind(f.provider);
    f.provider.executeAction = async (intent, context) => { entered(); await wait; return execute(intent, context); };
    const running = f.worker().pollOnce();
    await started;
    const current = await f.runtime.get(f.actor('sales'), action.id);
    await f.runtime.cancel(f.actor('sales'), 'cancel', action.id, current.streamVersion);
    release();
    assert.equal((await running).status, 'completed');
    const result = await f.runtime.get(f.actor('manager'), action.id);
    assert.equal(result.receipt?.status, 'succeeded');
    assert.equal(result.localOutcome, undefined);
    assert.equal(f.calls(), 1);
});
test('策略不能因商机改关联客户而自动扩大客户范围', async (t) => {
    const f = await setup(t);
    await f.configuration.writePolicy(f.admin, f.workspace.id, 'policy', { id: 'followup', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', responsibilityId: 'sales-support', action: 'create_followup_task', target: f.base.opportunity.reference, maxActions: 2, validUntil: '2026-12-01T00:00:00.000Z' });
    await f.configuration.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 1, 'accept');
    const other = await f.command({ type: 'customer.create', id: 'other-customer', name: '另一个客户' });
    const updated = await f.command({ type: 'opportunity.update', id: 'opportunity', expectedStreamVersion: 1, customer: other.reference, title: '范围已变化' });
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(updated.reference), policyId: 'followup' }), { code: 'POLICY_SCOPE_MISMATCH' });
    assert.equal(f.calls(), 0);
});
test('异步计量器返回的拒绝不会成为未处理异常，动作仍保留待核对', async (t) => {
    const f = await setup(t), action = await f.runtime.prepare(f.actor('sales'), f.input(f.base.opportunity.reference));
    await f.runtime.decide(f.actor('manager'), 'approve', action.executionApprovalRef!, 1, action.actionDigest, 'approve_once');
    (f.runtime.options as any).usageForReceipt = () => Promise.reject(new Error('METER_FAILURE'));
    assert.equal((await f.worker().pollOnce()).status, 'needs_reconciliation');
    assert.equal((await f.runtime.get(f.actor('manager'), action.id)).status, 'needs_reconciliation');
    assert.equal(f.calls(), 1);
});
test('职责字段上限和跨租户输入范围独立于人员已有权限', async (t) => {
    const f = await setup(t);
    const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
    await f.configuration.configure(f.admin, f.workspace.id, 'narrow', { expectedStreamVersion: 1, responsibilities: [{ id: 'sales-support', capabilities: ['create_followup_task', 'issue_quote_package'], fieldClasses: ['public'] }] });
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(quote.reference, 'issue_quote_package'), businessApprovalRef: String(quote.values.approvalId) }), { code: 'RESPONSIBILITY_FIELD_DENIED' });
    await assert.rejects(f.runtime.prepare(f.actor('sales'), { ...f.input(f.base.opportunity.reference), inputSources: [{ reference: { ...f.base.customer.reference, tenantId: 'other' }, fields: ['name'] }] }), { code: 'OBJECT_SCOPE_MISMATCH' });
    assert.equal(f.calls(), 0);
});

test('提供方成功写入造成来源版本推进时，不把在途正常结果误判为撤权',async t=>{
 const f=await setup(t),action=await f.runtime.prepare(f.actor('sales'),f.input(f.base.opportunity.reference));await f.runtime.decide(f.actor('manager'),'approve',action.executionApprovalRef!,1,action.actionDigest,'approve_once');const execute=f.provider.executeAction.bind(f.provider);
 f.provider.executeAction=async(intent,context)=>{await f.command({type:'opportunity.update',id:'opportunity',expectedStreamVersion:1,customer:f.base.customer.reference,title:'提供方已写入跟进'});await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,650);context.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('UNEXPECTED_ABORT'));},{once:true});});return execute(intent,context);};
 assert.equal((await f.worker().pollOnce()).status,'completed');assert.equal(f.calls(),1);
});
