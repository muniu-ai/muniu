// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseQuotaService } from '@mn/enterprise-services';
import { AgentOsWorker } from '@mn/worker';
import { EnterpriseEvaluationRuntime } from '../src/enterprise-evaluation.js';
import { fixture } from './fixtures/business.js';
import { EnterpriseOperatingService } from '../src/enterprise-operating.js';

async function setup(t: test.TestContext) {
  const f = await fixture(t, true, true), base = await f.base();
  const service = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  const source = { id: 'internal', tenantId: 'tenant', workspaceId: f.workspace.id, kind: 'internal' as const };
  await service.registerSource(f.admin, 'register', source);
  const input = { id: 'policy', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', sourceIds: ['internal'], eventTypes: ['business.changed'],
    sources: [{ reference: base.opportunity.reference, fields: ['title'] }], mode: 'observe' as const,
    validUntil: '2026-12-01T00:00:00.000Z', evaluation: { tokens: 10, costMinorUnits: '10', currency: 'CNY' as const }, notification: 'source' as const };
  await service.writePolicy(f.admin, f.workspace.id, 'policy', input);
  await service.controlPolicy(f.actor('sales'), f.workspace.id, 'policy', 'accept', 1, 'accept');
  const port = service.ingress(source);
  const event = (id: string) => ({ id, type: 'business.changed', objectRefs: [base.opportunity.reference], origin: 'external' as const });
  return { ...f, base, service, source, input, port, event };
}

test('来源事件与游标一起提交，重复事件与请求不重复接单', async t => {
  const f = await setup(t);
  const first = await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('event')] });
  assert.equal(first.accepted, 1);
  const again = await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('event')] });
  assert.deepEqual(again, first);
  await f.port.receive({ expectedCursor: '1', nextCursor: '2', events: [f.event('event')] });
  const state = await f.service.inspect(f.actor('sales'), f.workspace.id);
  assert.equal(state.triggers.length, 1);
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0]!.triggerIds.length, 1);
  assert.equal((await f.port.cursor()).cursor, '2');
  await assert.rejects(f.port.receive({ expectedCursor: '1', nextCursor: '3', events: [f.event('other')] }), { code: 'SOURCE_CURSOR_CONFLICT' });
  assert.equal((await f.service.inspect(f.actor('sales'), f.workspace.id)).triggers.length, 1);
});

test('不同对象不会因标题相近合并，未知发送者和自身通知不能启动工作', async t => {
  const f = await setup(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [
    { ...f.event('unknown'), senderPrincipalId: 'missing' }, { ...f.event('loop'), origin: 'muniu' }, f.event('valid'),
  ] });
  const state = await f.service.inspect(f.admin, f.workspace.id);
  assert.equal(state.triggers.find(x => x.sourceEventId === 'unknown')?.status, 'quarantined');
  assert.equal(state.triggers.find(x => x.sourceEventId === 'loop')?.status, 'loop_filtered');
  assert.equal(state.batches.length, 1);
});

test('接受责任后撤权会暂停规则，重新授予相同角色不能恢复旧授权', async t => {
  const f = await setup(t);
  await f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('revoked')] });
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).policies[0]!.status, 'paused');
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).batches.length, 0);
  await assert.rejects(f.service.controlPolicy(f.admin, f.workspace.id, 'policy', 'accept', 3, 'admin-accept'), { code: 'POLICY_RESPONSIBLE_REQUIRED' });
});

test('加密保存期间规则到期，事件、游标、批次全部回滚', async t => {
  const f = await setup(t), put = f.cas.put.bind(f.cas); let once = true;
  f.cas.put = async bytes => { const result = await put(bytes); if (once) { once = false; f.advance('2026-12-01T00:00:01.000Z'); } return result; };
  await assert.rejects(f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('expired')] }));
  assert.equal((await f.port.cursor()).cursor, null);
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).triggers.length, 0);
});

test('同一周期多副本只触发一次，业务版本无变化时只推进周期检查点', async t => {
  const f = await setup(t), timer = { ...f.source, id: 'timer', kind: 'timer' as const };
  await f.service.registerSource(f.admin, 'timer', timer);
  await f.service.writePolicy(f.admin, f.workspace.id, 'timed', { ...f.input, id: 'timed', sourceIds: ['timer'], eventTypes: ['timer.due'], intervalMinutes: 1 });
  await f.service.controlPolicy(f.actor('sales'), f.workspace.id, 'timed', 'accept', 1, 'accept-timed');
  const other = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  await Promise.all([f.service.tick('tenant', f.workspace.id), other.tick('tenant', f.workspace.id)]);
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).triggers.length, 1);
  f.advance('2026-11-02T01:01:00.000Z'); await f.service.tick('tenant', f.workspace.id);
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).triggers.length, 1);
  await f.command({ type: 'opportunity.update', id: 'opportunity', expectedStreamVersion: 1, customer: f.base.customer.reference, title: '新事实' });
  f.advance('2026-11-02T01:02:00.000Z'); await other.tick('tenant', f.workspace.id);
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).triggers.length, 2);
});

test('Sales 五分钟轮询保留失败游标并退避，多副本不重复请求', async t => {
  const f = await setup(t), source = { ...f.source, id: 'sales', kind: 'sales' as const };
  await f.service.registerSource(f.admin, 'sales', source);
  const port = f.service.ingress(source); let calls = 0;
  const fail = async () => { calls++; throw new Error('NETWORK'); };
  await Promise.all([port.poll(fail), port.poll(fail)]);
  assert.equal(calls, 1); assert.equal((await port.cursor()).cursor, null);
  f.advance('2026-11-02T01:04:00.000Z'); await port.poll(fail); assert.equal(calls, 1);
  f.advance('2026-11-02T01:05:00.000Z');
  await port.poll(async current => { calls++; assert.equal(current, null); return { nextCursor: 'stable', events: [] }; });
  assert.equal((await port.cursor()).cursor, 'stable');
  f.advance('2026-11-02T01:10:00.000Z'); await port.poll(async () => { calls++; return { nextCursor: 'stable', events: [] }; });
  assert.equal((await port.cursor()).nextPollAt, '2026-11-02T01:15:00.000Z');
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).triggers.length, 0);
});

async function evaluator(t: test.TestContext) {
  const f = await setup(t), quotas = new EnterpriseQuotaService({ repository: f.repository, now: f.now });
  const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 100, costMinorUnits: '100', currency: 'CNY' as const, evaluationDailyTokens: 20, evaluationDailyCostMinorUnits: '20', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '10', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' };
  await quotas.provision('tenant', 'platform', 0, limits); await quotas.configure(f.admin, 'quota', f.workspace.id, 0, limits);
  let calls = 0, enabled = true, unknown = false, hook: (() => Promise<void>) | undefined;
  const model = { id: 'evaluation', version: 1, providerId: 'openai' as const, modelId: 'gpt-4.1-mini', secretRef: 'fixture://enterprise/model', mode: 'test_fixture' as const };
  const runtime = new EnterpriseEvaluationRuntime({ operating: f.service, protection: { cas: f.cas, keyProvider: f.keyProvider }, modelFor: () => enabled ? model : undefined,
    secretStore: { async read() { if (hook) { const current = hook; hook = undefined; await current(); } return 'fixture-key'; } },
    invoke: async () => { calls++; if (unknown) throw new Error('RESPONSE_LOST'); return { text: JSON.stringify({ candidate: true, summary: '需要核查', citations: [{ triggerId: (await f.service.inspect(f.actor('sales'), f.workspace.id)).triggers[0]!.id }] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }; },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture-meter', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
  });
  const worker = () => new AgentOsWorker({ id: 'evaluation-worker', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.evaluation': runtime.workerHandler() } });
  return { ...f, runtime, quotas, limits, worker, calls: () => calls, disable: () => { enabled = false; }, lose: () => { unknown = true; }, hook: (value: () => Promise<void>) => { hook = value; } };
}

test('无模型只保留未评估事件；观察评估持久计费且不会创建 Goal', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  const empty = new EnterpriseEvaluationRuntime({ operating: f.service, protection: { cas: f.cas, keyProvider: f.keyProvider }, modelFor: () => undefined, secretStore: { async read() { throw new Error('MUST_NOT_READ'); } } });
  assert.equal(await empty.dispatch('tenant'), undefined); assert.equal(f.calls(), 0);
  const attempt = await f.runtime.dispatch('tenant'); assert.ok(attempt);
  assert.equal((await f.worker().pollOnce()).status, 'completed'); assert.equal(f.calls(), 1);
  const data = await f.store.transact('tenant', tx => ({ goals: tx.listProjections('goal'), account: tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'enterprise.workspace_budget'), attempts: tx.listProjections<any>('operating.evaluation') }));
  assert.equal(data.goals.length, 0); assert.equal(data.account.spentTokens, 3); assert.equal(data.account.spentCostMinorUnits, '1');
  assert.equal(data.attempts[0]!.status, 'completed');
  assert.equal((await f.service.inspect(f.actor('sales'), f.workspace.id)).batches[0]!.reasonCode, undefined);
  assert.equal(await f.runtime.dispatch('tenant'), undefined);
});

test('评估中的同主题事件合并为下一批，未知费用保留预留且不能重放', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  const attempt = await f.runtime.dispatch('tenant'); assert.ok(attempt); f.lose();
  await f.port.receive({ expectedCursor: '1', nextCursor: '2', events: [f.event('two'), f.event('three')] });
  assert.equal((await f.service.inspect(f.actor('sales'), f.workspace.id)).batches.length, 2);
  assert.equal((await f.worker().pollOnce()).status, 'needs_reconciliation');
  assert.equal(f.calls(), 1);
  const data = await f.store.transact('tenant', tx => ({ attempts: tx.listProjections<any>('operating.evaluation'), reservations: tx.listProjections<any>('budget.reservation') }));
  assert.equal(data.attempts[0]!.status, 'needs_reconciliation'); assert.equal(data.reservations[0]!.status, 'unknown');
  assert.equal((await f.worker().pollOnce()).status, 'idle'); assert.equal(f.calls(), 1);
});

test('读取模型凭据期间撤权，不调用模型且释放未使用预留', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  await f.runtime.dispatch('tenant');
  f.hook(async () => { await f.permissions.revoke(f.admin, 'revoke-during-key-read', 'role', 'sales-own', 1); });
  assert.equal((await f.worker().pollOnce()).status, 'failed'); assert.equal(f.calls(), 0);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation')[0]!.status), 'released');
});

test('人工请求独立接收并优先派发；取消立即生效，不等待普通评估', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('ordinary')] });
  const manual = await f.service.submit(f.actor('sales'), f.workspace.id, 'manual', { sources: f.input.sources, message: '检查已授权资料', evaluation: f.input.evaluation, validUntil: f.input.validUntil });
  const attempt = await f.runtime.dispatch('tenant'); assert.equal(attempt?.batchId, manual.batchId);
  const current = (await f.service.inspect(f.actor('sales'), f.workspace.id)).batches.find(b => b.id === manual.batchId)!;
  const cancelled = await f.service.cancel(f.actor('sales'), f.workspace.id, manual.batchId, current.streamVersion, 'cancel-manual');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await f.worker().pollOnce()).status, 'cancelled'); assert.equal(f.calls(), 0);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation')[0]!.status), 'released');
});

test('待派发队列按租户轮转，多调度器只能认领一次同一轮次', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  const other = new EnterpriseEvaluationRuntime(f.runtime.options);
  const results = await Promise.all([f.runtime.dispatchFair(['tenant']), other.dispatchFair(['tenant'])]);
  assert.equal(results.filter(Boolean).length, 1);
  const fair = await f.store.transact('tenant', tx => tx.getProjection<any>('operating.fair_queue', 'tenant'));
  assert.equal(fair.sequence, 1);
  assert.equal(await f.runtime.dispatchFair(['tenant']), undefined);
});

test('订阅只关联明确对象并按当前权限投递，不能扩大资料范围', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  const batch = (await f.service.inspect(f.actor('sales'), f.workspace.id)).batches[0]!;
  await f.service.subscribe(f.actor('sales'), f.workspace.id, batch.id, batch.streamVersion, 'subscribe');
  await f.port.receive({ expectedCursor: '1', nextCursor: '2', events: [f.event('two')] });
  assert.equal((await f.service.updates(f.actor('sales'), f.workspace.id, batch.id)).triggerIds.length, 1);
  await f.permissions.revoke(f.admin, 'sub-revoke', 'role', 'sales-own', 1);
  await f.port.receive({ expectedCursor: '2', nextCursor: '3', events: [f.event('three')] });
  await assert.rejects(f.service.updates(f.actor('sales'), f.workspace.id, batch.id), { code: 'OBJECT_ACCESS_DENIED' });
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('operating.subscription')[0]!.triggerIds.length), 1);
});

test('评估日额度和已有动作共享总额，不能通过新事件领取第二份额度', async t => {
  const f = await evaluator(t);
  await f.quotas.configure(f.admin, 'small-quota', f.workspace.id, 1, { ...f.limits, tokens: 10, costMinorUnits: '10' });
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  await f.runtime.dispatch('tenant');
  await f.port.receive({ expectedCursor: '1', nextCursor: '2', events: [f.event('two')] });
  assert.equal(await f.runtime.dispatch('tenant'), undefined);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('operating.evaluation').length), 1);
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).batches.filter(b => b.reasonCode === 'EVALUATION_BUDGET_EXCEEDED').length, 1);
});

test('内置业务事件从独立游标接入，重启后只接收新增事实', async t => {
  const f = await setup(t);
  await f.service.initializeWorkspace('tenant', f.workspace.id);
  await f.service.writePolicy(f.admin, f.workspace.id, 'builtin-policy', { ...f.input, id: 'builtin-policy', sourceIds: ['builtin:' + f.workspace.id] });
  await f.service.controlPolicy(f.actor('sales'), f.workspace.id, 'builtin-policy', 'accept', 1, 'accept-builtin');
  await f.service.ingestBusinessChanges('tenant', f.workspace.id);
  assert.equal((await f.service.inspect(f.admin, f.workspace.id)).triggers.length, 0);
  await f.command({ type: 'opportunity.update', id: 'opportunity', expectedStreamVersion: 1, customer: f.base.customer.reference, title: '新增业务事实' });
  await f.service.ingestBusinessChanges('tenant', f.workspace.id);
  assert.equal((await f.service.inspect(f.actor('sales'), f.workspace.id)).triggers.length, 1);
  const restarted = new EnterpriseOperatingService(f.service.options);
  await restarted.initializeWorkspace('tenant', f.workspace.id); await restarted.ingestBusinessChanges('tenant', f.workspace.id);
  assert.equal((await restarted.inspect(f.actor('sales'), f.workspace.id)).triggers.length, 1);
});

test('投影重建保留入站去重、来源游标、计量和候选，读取仍检查字段权限', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  const attempt = (await f.runtime.dispatch('tenant'))!; await f.worker().pollOnce();
  const before = await f.runtime.view(f.actor('sales'), attempt.id);
  assert.equal(before.result?.candidate, true); assert.equal(before.costNanoMinorUnits, '300000000');
  await f.store.rebuildProjections('tenant');
  assert.deepEqual(await f.runtime.view(f.actor('sales'), attempt.id), before);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  assert.equal(f.calls(), 1); assert.equal(await f.runtime.dispatch('tenant'), undefined);
  await f.permissions.revoke(f.admin, 'view-revoke', 'role', 'sales-own', 1);
  await assert.rejects(f.runtime.view(f.actor('sales'), attempt.id), { code: 'OBJECT_ACCESS_DENIED' });
});

test('加密等待期间评估到期，Job、授权与共享预留一起回滚', async t => {
  const f = await evaluator(t);
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('one')] });
  const put = f.cas.put.bind(f.cas); let once = true;
  f.cas.put = async bytes => { const result = await put(bytes); if (once) { once = false; f.advance('2026-11-02T01:02:00.000Z'); } return result; };
  await assert.rejects(f.runtime.dispatch('tenant'));
  const state = await f.store.transact('tenant', tx => ({ jobs: tx.listProjections('job').length, reservations: tx.listProjections('budget.reservation').length, attempts: tx.listProjections('operating.evaluation').length }));
  assert.deepEqual(state, { jobs: 0, reservations: 0, attempts: 0 });
});

test('持续有任务的租户轮流得到派发机会，预算和对象互相隔离', async t => {
  const f = await evaluator(t);
  await f.identity.provision({ tenantId: 'tenant-b', name: '第二合成企业', issuer: 'https://issuer.test/', maxMembers: 2, administrator: { id: 'admin-b', subject: 'admin-b', displayName: '第二管理员' } });
  const actor = { tenantId: 'tenant-b', principalId: 'admin-b', sessionEpoch: 1 }, workspace = await f.identity.createWorkspace(actor, 'workspace-b', { name: '第二业务主体', mode: 'builtin' });
  await f.permissions.grantRole(actor, 'role-b', { id: 'role-b', workspaceId: workspace.id, principalId: actor.principalId, role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read', 'write'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  const { EnterpriseBusinessService } = await import('../src/enterprise-business.js');
  const business = new EnterpriseBusinessService({ repository: f.repository, now: f.now });
  const customer = await business.execute({ actor, actorKind: 'human', workspaceId: workspace.id, idempotencyKey: 'customer-b', command: { type: 'customer.create', id: 'customer-b', name: '第二客户' } });
  await f.quotas.provision('tenant-b', 'platform-b', 0, f.limits); await f.quotas.configure(actor, 'quota-b', workspace.id, 0, f.limits);
  for (const key of ['first', 'second']) await f.service.submit(f.actor('sales'), f.workspace.id, key, { sources: f.input.sources, message: '人工请求', evaluation: f.input.evaluation, validUntil: f.input.validUntil });
  await f.service.submit(actor, workspace.id, 'request-b', { sources: [{ reference: customer.reference, fields: ['name'] }], message: '第二企业请求', evaluation: f.input.evaluation, validUntil: f.input.validUntil });
  assert.equal((await f.runtime.dispatchFair(['tenant', 'tenant-b']))!.tenantId, 'tenant');
  assert.equal((await f.runtime.dispatchFair(['tenant', 'tenant-b']))!.tenantId, 'tenant-b');
  assert.equal((await f.runtime.dispatchFair(['tenant', 'tenant-b']))!.tenantId, 'tenant');
  await assert.rejects(f.service.submit(actor, workspace.id, 'cross', { sources: f.input.sources, message: '跨企业', evaluation: f.input.evaluation, validUntil: f.input.validUntil }), { code: 'OBJECT_SCOPE_MISMATCH' });
});

test('已接收人工请求重发返回原批次，即使业务版本已推进或原截止时间已过', async t => {
  const f = await setup(t), input = { sources: f.input.sources, message: '检查已有事实', evaluation: f.input.evaluation, validUntil: '2026-11-02T01:01:00.000Z' };
  const first = await f.service.submit(f.actor('sales'), f.workspace.id, 'known-request', input);
  await f.command({ type: 'opportunity.update', id: 'opportunity', expectedStreamVersion: 1, customer: f.base.customer.reference, title: '后续事实' });
  f.advance('2026-11-02T01:02:00.000Z');
  assert.deepEqual(await f.service.submit(f.actor('sales'), f.workspace.id, 'known-request', input), first);
  assert.equal((await f.service.inspect(f.actor('sales'), f.workspace.id)).batches.length, 1);
  await f.permissions.revoke(f.admin, 'known-request-revoke', 'role', 'sales-own', 1);
  await assert.rejects(f.service.submit(f.actor('sales'), f.workspace.id, 'known-request', input), { code: 'OBJECT_ACCESS_DENIED' });
});

test('同名商机以明确对象分别形成批次，不能按标题合并授权', async t => {
  const f = await setup(t);
  const other = await f.command({ type: 'opportunity.create', id: 'other-opportunity', title: '需求', customer: f.base.customer.reference });
  await f.service.writePolicy(f.admin, f.workspace.id, 'other-policy', { ...f.input, id: 'other-policy', sources: [{ reference: other.reference, fields: ['title'] }] });
  await f.service.controlPolicy(f.actor('sales'), f.workspace.id, 'other-policy', 'accept', 1, 'other-accept');
  await f.port.receive({ expectedCursor: null, nextCursor: '1', events: [f.event('first-object'), { ...f.event('second-object'), objectRefs: [other.reference] }] });
  const batches = (await f.service.inspect(f.actor('sales'), f.workspace.id)).batches;
  assert.equal(batches.length, 2); assert.ok(batches.every(b => b.triggerIds.length === 1));
});

test('模型只收到选定字段，在途撤权后的结果不向失权人员披露，已知费用仍结算', async t => {
  const f = await evaluator(t);
  await assert.rejects(f.service.submit(f.actor('viewer'), f.workspace.id, 'price-denied', { sources: [{ reference: f.base.quote.reference, fields: ['totalMinor'] }], message: '尝试读价格', evaluation: f.input.evaluation, validUntil: f.input.validUntil }), { code: 'FIELD_ACCESS_DENIED' });
  await f.service.submit(f.actor('sales'), f.workspace.id, 'inflight', { sources: f.input.sources, message: '检查商机', evaluation: f.input.evaluation, validUntil: f.input.validUntil });
  let calls = 0;
  const runtime = new EnterpriseEvaluationRuntime({ ...f.runtime.options, invoke: async input => {
    calls++; const context = JSON.parse(input.request.messages.at(-1)!.content as string);
    assert.deepEqual(context.sources[0].fields, { title: '需求' }); assert.deepEqual(input.request.availableToolIds, []);
    await f.permissions.revoke(f.admin, 'inflight-revoke', 'role', 'sales-own', 1);
    return { text: JSON.stringify({ candidate: true, summary: '不可披露的合成结果', citations: [{ triggerId: context.triggers[0].id }] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } };
  } });
  const attempt = (await runtime.dispatch('tenant'))!;
  const worker = new AgentOsWorker({ id: 'inflight-worker', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.evaluation': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'failed'); assert.equal(calls, 1);
  await assert.rejects(runtime.view(f.actor('sales'), attempt.id), { code: 'OBJECT_ACCESS_DENIED' });
  const reservation = await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation')[0]!);
  assert.equal(reservation.status, 'settled'); assert.equal(reservation.usage.tokens, 3);
  const events = await f.store.readEvents('tenant', 0, 1000); assert.doesNotMatch(JSON.stringify(events), /不可披露的合成结果|机密合成客户/);
});

test('没有可用人民币计价记录的真实模型保留未评估，不读取凭据或请求模型预检', async t => {
  const f = await evaluator(t);
  await f.service.submit(f.actor('sales'), f.workspace.id, 'unpriced', { sources: f.input.sources, message: '检查资料', evaluation: f.input.evaluation, validUntil: f.input.validUntil });
  let reads = 0, quotes = 0;
  for (const modelId of ['gpt-5', 'unpriced-model']) {
    const runtime = new EnterpriseEvaluationRuntime({ ...f.runtime.options, modelFor: () => ({ id: 'live', version: 1, providerId: 'openai', modelId, mode: 'live', secretRef: 'env://muniu.enterprise/MN_ENTERPRISE_MODEL_TEST' }), secretStore: { async read() { reads++; return 'synthetic-only'; } }, quote: async input => { quotes++; return f.runtime.options.quote!(input); } });
    assert.equal(await runtime.dispatch('tenant'), undefined);
  }
  assert.equal(reads, 0); assert.equal(quotes, 0);
  const state = await f.service.inspect(f.actor('sales'), f.workspace.id);
  assert.equal(state.batches[0]!.reasonCode, 'MODEL_PRICE_UNAVAILABLE');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('budget.reservation').length), 0);
});
