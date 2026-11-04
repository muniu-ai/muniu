// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnterpriseContract } from '@mn/contracts';
import { AgentOsWorker } from '@mn/worker';
import { EnterpriseEvaluationRuntime } from '../src/enterprise-evaluation.js';
import { EnterpriseTaskRuntime } from '../src/enterprise-task-runtime.js';
import { EnterpriseQuotaService } from '@mn/enterprise-services';
import { fixture } from './fixtures/business.js';
import { EnterpriseOperatingService } from '../src/enterprise-operating.js';
import { EnterpriseGoalService } from '../src/enterprise-goals.js';

async function setup(t: test.TestContext) {
  const f = await fixture(t, true, true), base = await f.base(), operating = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  const quotas = new EnterpriseQuotaService({ repository: f.repository, now: f.now });
  const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 1000, costMinorUnits: '100', currency: 'CNY' as const, evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '10', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '1', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' };
  await quotas.provision('tenant', 'platform', 0, limits); await quotas.configure(f.admin, 'quota', f.workspace.id, 0, limits);
  const model = { id: 'model', version: 1, providerId: 'openai' as const, modelId: 'fixture-model', secretRef: 'fixture://enterprise/model', mode: 'test_fixture' as const };
  const goals = new EnterpriseGoalService({ operating, modelsFor: () => [model] });
  const budget = { maxTokens: 100, maxCostMinor: 10, currency: 'CNY' as const, deadline: '2026-12-01T00:00:00.000Z' };
  const input = { title: '检查商机', message: '输出有来源的风险清单', sources: [{ reference: base.opportunity.reference, fields: ['title'] }], acceptanceCriteria: ['覆盖已授权商机'], budget, capabilityIds: ['business.analyze', 'business.review'], modelBindingIds: ['model'] };
  const node = (id: string, dependsOn: readonly string[] = []) => ({ id, dependsOn, capabilityId: 'business.analyze', capabilityVersion: '1', modelBindingId: 'model', inputRefs: [base.opportunity.reference], budget: { ...budget, maxTokens: 10, maxCostMinor: 1 }, acceptanceCriteria: ['引用来源'], effect: 'read' as const });
  return { ...f, base, operating, goals, input, node, model, quotas, limits };
}

test('工作先保存范围，再按明确摘要授权；计划和就绪 Job 同事务提交', async t => {
  const f = await setup(t), goal = await f.goals.create(f.actor('sales'), f.workspace.id, 'create', f.input);
  assert.equal(goal.status, 'awaiting_authorization');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('job').length), 0);
  await assert.rejects(f.goals.authorize(f.actor('sales'), goal.id, goal.streamVersion, '0'.repeat(64), 'wrong'), { code: 'GOAL_SCOPE_CONFLICT' });
  const active = await f.goals.authorize(f.actor('sales'), goal.id, goal.streamVersion, goal.scopeDigest, 'authorize');
  const planned = await f.goals.plan(f.actor('sales'), goal.id, active.streamVersion, 'plan', { reason: '先分析，再复核', nodes: [f.node('analysis'), { ...f.node('review', ['analysis']), capabilityId: 'business.review' }] });
  assert.equal(planned.status, 'running'); assert.equal(planned.plan!.revision, 1);
  assert.doesNotThrow(() => parseEnterpriseContract('EnterpriseGoalView', planned));
  const jobs = await f.store.transact('tenant', tx => tx.listProjections<any>('job'));
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.kind, 'enterprise.task');
  const root = await f.store.transact('tenant', tx => tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'enterprise.workspace_budget'));
  assert.equal(root.heldTokens, 10);
});

test('跨对象或能力扩张保留待授权建议，不派发第二个任务', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'create', f.input);
  const active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const other = await f.command({ type: 'opportunity.create', id: 'other', title: '另一个商机', customer: f.base.customer.reference });
  const pending = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'expand', { reason: '要求增加客户范围', nodes: [{ ...f.node('expanded'), inputRefs: [other.reference] }] });
  assert.equal(pending.status, 'awaiting_authorization'); assert.equal(pending.attention!.code, 'PLAN_AUTHORITY_EXPANSION');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('job').length), 0);
});

test('开始的节点保持原执行和输入，替换未开始节点不会重复派发', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'create', f.input);
  const active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const first = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'first', { reason: '初始计划', nodes: [f.node('a'), f.node('b', ['a'])] });
  const claim = await f.store.claimJob('worker', f.now(), { kinds: ['enterprise.task'] }); assert.ok(claim);
  await f.goals.begin('tenant', String(claim.payload.attemptId), { jobId: claim.id, workerId: 'worker', fencingToken: claim.fencingToken, occurredAt: f.now() });
  const current = await f.goals.get(f.actor('sales'), first.id);
  const second = await f.goals.plan(f.actor('sales'), first.id, current.streamVersion, 'replace', { reason: '调整后续分析', nodes: [f.node('a'), f.node('c', ['a'])] });
  assert.equal(second.plan!.revision, 2);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('job').length), 1);
  await assert.rejects(f.goals.plan(f.actor('sales'), first.id, second.streamVersion, 'rewrite-started', { reason: '改变已开始节点', nodes: [{ ...f.node('a'), modelBindingId: 'different' }] }), { code: 'PLAN_STARTED_NODE_CHANGED' });
});

test('异步保护期间撤销或过期的授权不能留下 Job 或预算', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'create', f.input);
  const active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const put = f.cas.put.bind(f.cas); let once = true;
  f.cas.put = async bytes => { const saved = await put(bytes); if (once) { once = false; f.advance('2027-01-02T00:00:00.000Z'); } return saved; };
  await assert.rejects(f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'expired', { reason: '过期计划', nodes: [f.node('a')] }));
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('job').length), 0);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('budget.reservation').length), 0);
});

test('替换未开始但已被领取的节点，在同一事务释放旧预留并拒绝旧租约', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'create', f.input);
  const active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const full = { ...f.node('a'), budget: f.input.budget };
  const first = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'first', { reason: '初始节点', nodes: [full] });
  const lease = (await f.store.claimJob('old-worker', f.now(), { kinds: ['enterprise.task'] }))!;
  const second = await f.goals.plan(f.actor('sales'), draft.id, first.streamVersion, 'replace', { reason: '替换尚未开始的节点', nodes: [{ ...full, id: 'b' }] });
  assert.equal(second.plan!.nodes[0]!.id, 'b');
  await assert.rejects(f.goals.begin('tenant', String(lease.payload.attemptId), { jobId: lease.id, workerId: 'old-worker', fencingToken: lease.fencingToken, occurredAt: f.now() }), { code: 'STALE_FENCING_TOKEN' });
  const facts = await f.store.transact('tenant', tx => ({ reservations: tx.listProjections<any>('budget.reservation'), root: tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'enterprise.workspace_budget') }));
  assert.equal(facts.reservations.filter(r => r.status === 'released').length, 1);
  assert.equal(facts.root.heldTokens, f.input.budget.maxTokens); assert.equal(facts.root.spentTokens, 0);
});

async function runtimeFixture(t: test.TestContext, deadline?: string) {
  const f = await setup(t); let calls = 0, lose = false, hook: (() => Promise<void>) | undefined, modelHook: (() => Promise<void>) | undefined;
  const runtime = new EnterpriseTaskRuntime({ goals: f.goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { const fn = hook; hook = undefined; await fn?.(); return 'fixture-key'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture-rate', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: async input => { calls++; const fn = modelHook; modelHook = undefined; await fn?.(); if (lose) throw new Error('RESPONSE_LOST'); const value = JSON.parse(input.request.messages.at(-1)!.content as string); const refs = value.sources.map((s: any) => s.reference);
      return { text: JSON.stringify({ status: 'complete', summary: '合成分析候选', findings: [{ text: '需要核查', sources: refs }], acceptance: value.node.acceptanceCriteria.map((criterion: string) => ({ criterion, status: 'satisfied', sources: refs })), unknown: [] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }; },
  });
  const worker = () => new AgentOsWorker({ id: 'goal-worker', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  const spec = deadline ? { ...f.input, budget: { ...f.input.budget, deadline } } : f.input;
  const node = (id: string, deps: readonly string[] = []) => ({ ...f.node(id, deps), budget: { ...f.node(id, deps).budget, deadline: spec.budget.deadline } });
  const draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'create', spec), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const goal = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'plan', { reason: '分析并复核', nodes: [node('analysis'), { ...node('review', ['analysis']), capabilityId: 'business.review' }] });
  return { ...f, runtime, worker, goal, modelHook: (fn: () => Promise<void>) => { modelHook = fn; }, calls: () => calls, lose: () => { lose = true; }, hook: (fn: () => Promise<void>) => { hook = fn; } };
}

test('动态节点经原生 Worker 逐项执行，结果、费用与后继 Job 原子保存并可重建', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.worker().pollOnce()).status, 'completed');
  assert.equal((await f.goals.get(f.actor('sales'), f.goal.id)).attempts.length, 2);
  assert.equal((await f.worker().pollOnce()).status, 'completed'); assert.equal(f.calls(), 2);
  const goal = await f.goals.get(f.actor('sales'), f.goal.id); assert.equal(goal.status, 'awaiting_acceptance');
  const root = await f.store.transact('tenant', tx => tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'enterprise.workspace_budget'));
  assert.equal(root.spentTokens, 6); assert.equal(root.heldTokens, 0);
  await f.store.rebuildProjections('tenant'); assert.deepEqual(await f.goals.get(f.actor('sales'), f.goal.id), goal);
  assert.equal((await f.worker().pollOnce()).status, 'idle'); assert.equal(f.calls(), 2);
});

test('模型结果未知时停止后继节点，取消和重启均保留费用及原调用', async t => {
  const f = await runtimeFixture(t); f.lose();
  assert.equal((await f.worker().pollOnce()).status, 'needs_reconciliation');
  const current = await f.goals.get(f.actor('sales'), f.goal.id); assert.equal(current.status, 'needs_reconciliation'); assert.equal(current.attempts.length, 1);
  const cancelled = await f.goals.control(f.actor('sales'), f.goal.id, current.streamVersion, 'cancel', 'cancel');
  assert.equal(cancelled.status, 'needs_reconciliation');
  await f.store.rebuildProjections('tenant'); assert.equal((await f.worker().pollOnce()).status, 'idle'); assert.equal(f.calls(), 1);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation')[0]!.status), 'unknown');
});

test('读取凭据期间撤权，节点不调用模型且释放未用预算', async t => {
  const f = await runtimeFixture(t);
  f.hook(() => f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1).then(() => {}));
  assert.equal((await f.worker().pollOnce()).status, 'failed'); assert.equal(f.calls(), 0);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation')[0]!.status), 'released');
});

test('工作授权前拒绝缺少人民币计价的真实模型，不创建预算账户或执行授权', async t => {
  const f = await setup(t), goals = new EnterpriseGoalService({ operating: f.operating, modelsFor: () => [{ ...f.model, mode: 'live', modelId: 'gpt-5', secretRef: 'env://muniu.enterprise/MN_ENTERPRISE_MODEL_TEST' }] });
  const draft = await goals.create(f.actor('sales'), f.workspace.id, 'unpriced', f.input);
  await assert.rejects(goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize'), { code: 'MODEL_PRICE_UNAVAILABLE' });
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('budget.account').length), 0);
});


test('后继预算暂不可用时仍提交本节点结果和真实费用，不能回滚已发生用量', async t => {
  const f = await runtimeFixture(t);
  await f.quotas.configure(f.admin, 'tight-quota', f.workspace.id, 1, { ...f.limits, tokens: 100, costMinorUnits: '10' });
  f.modelHook(async () => {
    const spec = { ...f.input, budget: { ...f.input.budget, maxTokens: 90, maxCostMinor: 9 } };
    const other = await f.goals.create(f.actor('sales'), f.workspace.id, 'other', spec), active = await f.goals.authorize(f.actor('sales'), other.id, other.streamVersion, other.scopeDigest, 'authorize-other');
    await f.goals.plan(f.actor('sales'), other.id, active.streamVersion, 'plan-other', { reason: '另一项已授权工作', nodes: [{ ...f.node('other'), budget: spec.budget }] });
  });
  assert.equal((await f.worker().pollOnce()).status, 'completed');
  const current = await f.goals.get(f.actor('sales'), f.goal.id);
  assert.equal(current.attempts[0]!.status, 'completed'); assert.equal(current.status, 'waiting_external');
  assert.equal(current.attention!.code, 'WORKSPACE_BUDGET_EXCEEDED');
  const reservations = await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation'));
  assert.equal(reservations.filter(r => r.status === 'settled').length, 1);
  assert.equal(reservations.find(r => r.status === 'settled')!.usage.tokens, 3);
});

test('最终保护期间期限失效时仅结算已知费用，不留下后继任务或可采纳结果', async t => {
  const f = await runtimeFixture(t, '2026-11-02T01:00:01.000Z');
  const attemptId = f.goal.attempts[0]!.id, dispatch = f.goals.dispatchInTransaction.bind(f.goals); let once = true;
  f.goals.dispatchInTransaction = (tx, goal, plan) => {
    dispatch(tx, goal, plan);
    if (once && tx.getProjection('enterprise-work.result', attemptId) && tx.listProjections('job').length === 2) { once = false; f.advance('2026-11-02T01:00:02.000Z'); }
  };
  assert.equal((await f.worker().pollOnce()).status, 'failed');
  const facts = await f.store.transact('tenant', tx => ({ results: tx.listProjections('enterprise-work.result'), jobs: tx.listProjections('job'), reservations: tx.listProjections<any>('budget.reservation') }));
  assert.equal(facts.results.length, 0); assert.equal(facts.jobs.length, 1);
  assert.equal(facts.reservations[0]!.status, 'settled'); assert.equal(facts.reservations[0]!.usage.tokens, 3);
});

test('失去资料权限后仍可取得最小控制状态并取消自己的工作，不返回原范围和内容', async t => {
  const f = await runtimeFixture(t);
  await f.permissions.revoke(f.admin, 'lost-read', 'role', 'sales-own', 1);
  const state = await f.goals.controlState(f.actor('sales'), f.goal.id);
  const result = await f.goals.control(f.actor('sales'), f.goal.id, state.streamVersion, 'cancel', 'cancel-without-read');
  assert.deepEqual(Object.keys(result).sort(), ['cancelRequested', 'goalId', 'paused', 'status', 'streamVersion']);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(await f.goals.control(f.actor('sales'), f.goal.id, state.streamVersion, 'cancel', 'cancel-without-read'), result);
  await assert.rejects(f.goals.get(f.actor('sales'), f.goal.id), { code: 'OBJECT_ACCESS_DENIED' });
});

test('同一节点标识在开始前可以更换允许模型，旧预留释放且新任务只派发一次', async t => {
  const f = await setup(t), secondModel = { ...f.model, id: 'second-model' }, goals = new EnterpriseGoalService({ operating: f.operating, modelsFor: () => [f.model, secondModel] });
  const spec = { ...f.input, modelBindingIds: ['model', 'second-model'] }, draft = await goals.create(f.actor('sales'), f.workspace.id, 'models', spec);
  const active = await goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const first = await goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'plan', { reason: '首个模型', nodes: [f.node('a')] });
  const second = await goals.plan(f.actor('sales'), draft.id, first.streamVersion, 'swap', { reason: '授权内更换模型', nodes: [{ ...f.node('a'), modelBindingId: secondModel.id }] });
  assert.equal(second.attempts.length, 2); assert.equal(second.attempts[0]!.status, 'cancelled'); assert.equal(second.attempts[1]!.status, 'queued');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation').filter(r => r.status === 'reserved').length), 1);
});

test('暂停释放尚未开始的节点，恢复后按原权限重新排队，已开始节点不重复', async t => {
  const f = await runtimeFixture(t), paused = await f.goals.control(f.actor('sales'), f.goal.id, f.goal.streamVersion, 'pause', 'pause');
  assert.equal(paused.paused, true); assert.equal((await f.worker().pollOnce()).status, 'idle');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation')[0]!.status), 'released');
  const resumed = await f.goals.control(f.actor('sales'), f.goal.id, paused.streamVersion, 'resume', 'resume');
  assert.equal(resumed.paused, false); assert.equal((await f.worker().pollOnce()).status, 'completed'); assert.equal(f.calls(), 1);
});

test('停用一个允许模型不会扩大授权，也不阻止选用另一未改变的允许模型', async t => {
  const f = await setup(t), alternative = { ...f.model, id: 'alternative' }; let bindings = [f.model, alternative];
  const goals = new EnterpriseGoalService({ operating: f.operating, modelsFor: () => bindings });
  const draft = await goals.create(f.actor('sales'), f.workspace.id, 'fallback', { ...f.input, modelBindingIds: ['model', 'alternative'] });
  const active = await goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  bindings = [alternative];
  const planned = await goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'alternative-plan', { reason: '改用仍可用的允许模型', nodes: [{ ...f.node('a'), modelBindingId: 'alternative' }] });
  assert.equal(planned.attempts.length, 1);
  await assert.rejects(goals.plan(f.actor('sales'), draft.id, planned.streamVersion, 'bad-plan', { reason: '不能使用已停用模型', nodes: [f.node('b')] }), { code: 'PLAN_MODEL_UNAVAILABLE' });
});

test('工作元数据不能绕过不可变授权范围改变字段', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'sealed', f.input);
  const active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const modified = await f.operating.bridge.store.transact('tenant', tx => f.goals.record(tx, f.goals.require(tx, active.id), { spec: { ...f.input, sources: [{ ...f.input.sources[0]!, fields: ['title', 'customer'] }] } }, 'fixture.invalid_scope_change'));
  await assert.rejects(f.goals.plan(f.actor('sales'), active.id, modified.streamVersion, 'must-reject', { reason: '必须重新授权字段变化', nodes: [f.node('a')] }), { code: 'GOAL_AUTHORITY_INVALID' });
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('job').length), 0);
});

test('模型规划只产生候选图，经共同校验后入队，规划费用计入同一工作预算', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'planned', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const planned = await f.goals.requestPlan(f.actor('sales'), draft.id, active.streamVersion, 'ask-planner');
  assert.equal(planned.attempts.length, 1); assert.equal(planned.attempts[0]!.kind, 'planning');
  let calls = 0;
  const runtime = new EnterpriseTaskRuntime({ goals: f.goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { return 'fixture-key'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: async input => { calls++; const body = JSON.parse(input.request.messages.at(-1)!.content as string); assert.equal(body.kind, 'planning'); assert.equal(body.sourceIndex[0].id, 's0'); assert.equal(body.sourceIndex[0].fields[0], 'title');
      return { text: JSON.stringify({ reason: '先分析已授权商机', nodes: [{ ...f.node('a'), inputRefs: undefined, sourceIds: ['s0'] }] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }; },
  });
  const worker = new AgentOsWorker({ id: 'planner', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'completed'); assert.equal(calls, 1);
  const result = await f.goals.get(f.actor('sales'), draft.id); assert.equal(result.plan!.nodes[0]!.id, 'a'); assert.equal(result.attempts.length, 2);
  const account = await f.store.transact('tenant', tx => tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'goal'));
  assert.equal(account.spentTokens, 3); assert.equal(account.heldTokens, 10);
});

test('一个节点费用未知时，其他节点的失败不能覆盖工作待核对状态', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'parallel', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const goal = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'parallel-plan', { reason: '两个独立分析', nodes: [f.node('a'), f.node('b')] });
  let calls = 0;
  const runtime = new EnterpriseTaskRuntime({ goals: f.goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { return 'fixture-key'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }), invoke: async () => { calls++; throw new Error('RESPONSE_LOST'); } });
  const worker = new AgentOsWorker({ id: 'parallel', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'needs_reconciliation');
  assert.equal((await worker.pollOnce()).status, 'failed'); assert.equal(calls, 1);
  assert.equal((await f.goals.get(f.actor('sales'), goal.id)).status, 'needs_reconciliation');
});

test('持续十五分钟无持久进展时只允许一次预算内只读诊断，心跳不冒充成果进展', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'supervised', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const goal = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'plan', { reason: '分析商机', nodes: [f.node('a')] });
  const lease = (await f.store.claimJob('stalled-worker', f.now(), { kinds: ['enterprise.task'] }))!;
  await f.goals.begin('tenant', String(lease.payload.attemptId), { jobId: lease.id, workerId: 'stalled-worker', fencingToken: lease.fencingToken, occurredAt: f.now() });
  assert.equal(await f.goals.supervise('tenant', goal.id), undefined);
  const start = Date.parse(f.now());
  for (let step = 1; step <= 46; step++) { f.advance(new Date(start + step * 20_000).toISOString()); await f.store.renewJobLease(lease.id, 'stalled-worker', lease.fencingToken, f.now()); }
  const diagnosis = await f.goals.supervise('tenant', goal.id); assert.ok(diagnosis); assert.equal(diagnosis.kind, 'diagnostic');
  assert.equal(await f.goals.supervise('tenant', goal.id), undefined);
  let calls = 0;
  const runtime = new EnterpriseTaskRuntime({ goals: f.goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { return 'fixture-key'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: async input => { calls++; const body = JSON.parse(input.request.messages.at(-1)!.content as string); assert.equal(body.kind, 'diagnostic'); assert.equal(body.progress.leaseActive, true); assert.equal(body.progress.waitingApproval, false); assert.equal(body.sources, undefined);
      return { text: JSON.stringify({ summary: '需要人工检查当前等待', recommendation: 'request_review', progressDigest: body.progressDigest }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }; },
  });
  const worker = new AgentOsWorker({ id: 'diagnostic', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'completed'); assert.equal(calls, 1);
  const after = await f.goals.get(f.actor('sales'), goal.id); assert.equal(after.plan!.revision, 1); assert.equal(after.attempts.length, 2); assert.equal(after.attention!.code, 'DIAGNOSTIC_REVIEW_SUGGESTED');
  assert.equal(await f.goals.supervise('tenant', goal.id), undefined);
});

test('后继额度等待不会占用 Worker，额度释放后可推进且没有变化时不重复派发', async t => {
  const f = await runtimeFixture(t);
  await f.quotas.configure(f.admin, 'limited', f.workspace.id, 1, { ...f.limits, tokens: 100, costMinorUnits: '10' });
  let otherId = '';
  f.modelHook(async () => { const spec = { ...f.input, budget: { ...f.input.budget, maxTokens: 90, maxCostMinor: 9 } }; const other = await f.goals.create(f.actor('sales'), f.workspace.id, 'other-wait', spec); otherId = other.id; const authorized = await f.goals.authorize(f.actor('sales'), other.id, other.streamVersion, other.scopeDigest, 'authorize-other'); await f.goals.plan(f.actor('sales'), other.id, authorized.streamVersion, 'other-plan', { reason: '其他工作预留', nodes: [{ ...f.node('other'), budget: spec.budget }] }); });
  await f.worker().pollOnce();
  const waiting = await f.goals.get(f.actor('sales'), f.goal.id);
  await f.goals.advance('tenant', f.goal.id);
  assert.equal((await f.goals.get(f.actor('sales'), f.goal.id)).streamVersion, waiting.streamVersion);
  const control = await f.goals.controlState(f.actor('sales'), otherId); await f.goals.control(f.actor('sales'), otherId, control.streamVersion, 'cancel', 'release-other');
  await f.goals.advance('tenant', f.goal.id);
  const current = await f.goals.get(f.actor('sales'), f.goal.id); assert.equal(current.status, 'running'); assert.equal(current.attempts.length, 2);
  await f.goals.advance('tenant', f.goal.id); assert.equal((await f.goals.get(f.actor('sales'), f.goal.id)).attempts.length, 2);
});

test('范围或预算改变必须重新确认摘要，已用费用和历史成果不能清零', async t => {
  const f = await runtimeFixture(t); await f.worker().pollOnce(); await f.worker().pollOnce();
  const finished = await f.goals.get(f.actor('sales'), f.goal.id);
  const revised = await f.goals.revise(f.actor('sales'), f.goal.id, finished.streamVersion, 'revise', { ...f.input, message: '补充新的复核目标', budget: { ...f.input.budget, maxTokens: 150, maxCostMinor: 15 } });
  assert.equal(revised.status, 'awaiting_authorization'); assert.equal(revised.plan, undefined); assert.notEqual(revised.scopeDigest, finished.scopeDigest);
  await assert.rejects(f.goals.authorize(f.actor('sales'), f.goal.id, revised.streamVersion, finished.scopeDigest, 'old-digest'), { code: 'GOAL_SCOPE_CONFLICT' });
  const authorized = await f.goals.authorize(f.actor('sales'), f.goal.id, revised.streamVersion, revised.scopeDigest, 'new-authority');
  const next = await f.goals.plan(f.actor('sales'), f.goal.id, authorized.streamVersion, 'new-plan', { reason: '新增已明确授权的复核', nodes: [f.node('analysis')] });
  assert.equal(next.attempts.length, 3);
  const account = await f.store.transact('tenant', tx => tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'goal'));
  assert.equal(account.spentTokens, 6); assert.equal(account.heldTokens, 10); assert.equal(account.limit.tokens, 150);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('enterprise-work.result').length), 2);
});

test('未核对结果不能通过修改工作范围重置授权和预算', async t => {
  const f = await runtimeFixture(t); f.lose(); await f.worker().pollOnce();
  const current = await f.goals.get(f.actor('sales'), f.goal.id);
  await assert.rejects(f.goals.revise(f.actor('sales'), f.goal.id, current.streamVersion, 'must-not-reset', { ...f.input, budget: { ...f.input.budget, maxTokens: 200 } }), { code: 'GOAL_RECONCILIATION_REQUIRED' });
});

test('已知无业务副作用的失败可在新计划中重试，历史费用不清零', async t => {
  const f = await runtimeFixture(t);
  const bad = new EnterpriseTaskRuntime({ ...f.runtime.options, invoke: async () => ({ text: 'invalid-json', toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }) });
  const worker = new AgentOsWorker({ id: 'known-failure', store: bad.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': bad.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'failed');
  const current = await f.goals.get(f.actor('sales'), f.goal.id);
  const retried = await f.goals.plan(f.actor('sales'), f.goal.id, current.streamVersion, 'retry-plan', { reason: '重做格式错误的只读结果', nodes: [f.node('analysis')] });
  assert.equal(retried.attempts.length, 2); assert.equal(retried.attempts[1]!.status, 'queued');
  assert.equal((await f.worker().pollOnce()).status, 'completed');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'goal').spentTokens), 6);
});

test('自动重规划次数在请求入队时计数，取消或无效结果不能重置次数', async t => {
  const f = await setup(t); await f.quotas.configure(f.admin, 'one-replan', f.workspace.id, 1, { ...f.limits, automaticReplans: 1 });
  const draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'replans', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const plan = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'first', { reason: '初始计划', nodes: [f.node('a')] });
  const request = await f.goals.requestPlan(f.actor('sales'), draft.id, plan.streamVersion, 'first-replan');
  const paused = await f.goals.control(f.actor('sales'), draft.id, request.streamVersion, 'pause', 'pause');
  const resumed = await f.goals.control(f.actor('sales'), draft.id, paused.streamVersion, 'resume', 'resume');
  await assert.rejects(f.goals.requestPlan(f.actor('sales'), draft.id, resumed.streamVersion, 'second-replan'), { code: 'PLAN_REPLAN_LIMIT' });
});


test('入站评估接单只关联一次费用，工作额度包含已发生评估而不再次扣取', async t => {
  const f = await setup(t);
  await f.operating.submit(f.actor('sales'), f.workspace.id, 'intake', { sources: f.input.sources, message: f.input.message, evaluation: { tokens: 10, costMinorUnits: '1', currency: 'CNY' }, validUntil: f.input.budget.deadline });
  const evaluation = new EnterpriseEvaluationRuntime({ operating: f.operating, protection: { cas: f.cas, keyProvider: f.keyProvider }, modelFor: () => f.model, secretStore: { async read() { return 'fixture-key'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: async input => { const body = JSON.parse(input.request.messages.at(-1)!.content as string); return { text: JSON.stringify({ candidate: true, summary: '值得检查', citations: [{ triggerId: body.triggers[0].id }] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }; },
  });
  const attempt = (await evaluation.dispatch('tenant'))!;
  const worker = new AgentOsWorker({ id: 'intake', store: evaluation.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.evaluation': evaluation.workerHandler() } });
  await worker.pollOnce();
  const draft = await f.goals.adopt(f.actor('sales'), attempt.id, 'adopt', f.input);
  assert.equal(draft.initialEvaluation!.tokens, 3);
  const repeated = await f.goals.adopt(f.actor('sales'), attempt.id, 'adopt-again', f.input); assert.equal(repeated.id, draft.id);
  const active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'plan', { reason: '接单分析', nodes: [f.node('a')] });
  const budgets = await f.store.transact('tenant', tx => tx.listProjections<any>('budget.account'));
  assert.equal(budgets.find(a => a.scope.namespace === 'enterprise.workspace_budget').spentTokens, 3);
  const goal = budgets.find(a => a.scope.namespace === 'goal'); assert.equal(goal.limit.tokens, 97); assert.equal(goal.limit.costMinorUnits, '9'); assert.equal(goal.spentTokens, 0);
});

for (const mode of ['observe', 'execute', 'unconfigured'] as const) test(`持续规则接单：${mode} 模式按明确工作授权处理候选`, async t => {
  const f = await setup(t), source = { id: 'policy-source', tenantId: 'tenant', workspaceId: f.workspace.id, kind: 'internal' as const };
  await f.operating.registerSource(f.admin, 'source', source);
  await f.operating.writePolicy(f.admin, f.workspace.id, 'policy', { id: 'work', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', sourceIds: [source.id], eventTypes: ['business.changed'], sources: f.input.sources, mode: mode === 'observe' ? 'observe' : 'execute', validUntil: f.input.budget.deadline, evaluation: { tokens: 10, costMinorUnits: '1', currency: 'CNY' }, notification: 'none', work: mode === 'unconfigured' ? { ...f.input, modelBindingIds: ['unavailable-model'] } : f.input });
  await f.operating.controlPolicy(f.actor('sales'), f.workspace.id, 'work', 'accept', 1, 'accept');
  await f.operating.ingress(source).receive({ expectedCursor: null, nextCursor: '1', events: [{ id: 'change', type: 'business.changed', objectRefs: [f.base.opportunity.reference], origin: 'external' }] });
  const evaluation = new EnterpriseEvaluationRuntime({ operating: f.operating, protection: { cas: f.cas, keyProvider: f.keyProvider }, modelFor: () => f.model, secretStore: { async read() { return 'fixture-key'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: async input => { const body = JSON.parse(input.request.messages.at(-1)!.content as string); return { text: JSON.stringify({ candidate: true, summary: '候选', citations: [{ triggerId: body.triggers[0].id }] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }; },
  });
  await evaluation.dispatch('tenant');
  const worker = new AgentOsWorker({ id: 'policy-evaluation', store: evaluation.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.evaluation': evaluation.workerHandler() } });
  await worker.pollOnce(); await f.goals.adoptPolicies('tenant'); await f.goals.adoptPolicies('tenant');
  const goals = await f.goals.list(f.actor('sales'), f.workspace.id);
  assert.equal(goals.goals.length, mode === 'execute' ? 1 : 0);
  if (mode === 'execute') { assert.equal(goals.goals[0]!.status, 'running'); assert.ok(goals.goals[0]!.authorityRevisionId); assert.equal(goals.goals[0]!.initialEvaluation!.tokens, 3); }
});

test('Worker 拆解请求只保存建议，由同一协调服务进行后续规划', async t => {
  const f = await runtimeFixture(t);
  const runtime = new EnterpriseTaskRuntime({ ...f.runtime.options, invoke: async input => {
    const body = JSON.parse(input.request.messages.at(-1)!.content as string), refs = body.sources.map((s: any) => s.reference);
    return { text: JSON.stringify({ status: 'complete', summary: '已分析，建议补充整理', findings: [{ text: '原始来源', sources: refs }], acceptance: body.node.acceptanceCriteria.map((criterion: string) => ({ criterion, status: 'satisfied', sources: refs })), unknown: [], decomposition: { reason: '补充只读整理', nodes: [{ ...f.node('extra'), inputRefs: undefined, sourceIds: ['s0'] }] } }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } };
  } });
  const worker = new AgentOsWorker({ id: 'decompose', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'completed');
  const current = await f.goals.get(f.actor('sales'), f.goal.id); assert.equal(current.plan!.revision, 1); assert.equal(current.plan!.nodes.some(n => n.id === 'extra'), false);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('enterprise-work.decomposition').length), 1);
  await f.goals.runTenant('tenant');
  const next = await f.goals.get(f.actor('sales'), f.goal.id); assert.equal(next.attempts.filter(a => a.kind === 'planning').length, 1);
  await f.goals.runTenant('tenant'); assert.equal((await f.goals.get(f.actor('sales'), f.goal.id)).attempts.filter(a => a.kind === 'planning').length, 1);
});

test('已接单主题的后续事件进入原工作订阅，不重复创建评估和工作', async t => {
  const f = await setup(t), source = { id: 'linked', tenantId: 'tenant', workspaceId: f.workspace.id, kind: 'internal' as const };
  await f.operating.registerSource(f.admin, 'source', source);
  await f.operating.writePolicy(f.admin, f.workspace.id, 'policy', { id: 'linked', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', sourceIds: [source.id], eventTypes: ['business.changed'], sources: f.input.sources, mode: 'execute', validUntil: f.input.budget.deadline, evaluation: { tokens: 10, costMinorUnits: '1', currency: 'CNY' }, notification: 'none', work: f.input });
  await f.operating.controlPolicy(f.actor('sales'), f.workspace.id, 'linked', 'accept', 1, 'accept');
  const port = f.operating.ingress(source), event = (id: string) => ({ id, type: 'business.changed', objectRefs: [f.base.opportunity.reference], origin: 'external' as const });
  await port.receive({ expectedCursor: null, nextCursor: '1', events: [event('one')] });
  const draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'active-work', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const batch = (await f.operating.inspect(f.actor('sales'), f.workspace.id)).batches[0]!;
  await f.goals.bindSubscription(f.actor('sales'), active.id, batch.id, batch.streamVersion, 'bind');
  await port.receive({ expectedCursor: '1', nextCursor: '2', events: [event('two')] });
  const state = await f.operating.inspect(f.actor('sales'), f.workspace.id);
  assert.equal(state.batches.length, 1);
  assert.equal((await f.operating.updates(f.actor('sales'), f.workspace.id, batch.id)).triggerIds.length, 1);
  await f.operating.controlPolicy(f.actor('sales'), f.workspace.id, 'linked', 'close', 2, 'close-rule');
  await port.receive({ expectedCursor: '2', nextCursor: '3', events: [event('three')] });
  assert.equal((await f.operating.updates(f.actor('sales'), f.workspace.id, batch.id)).triggerIds.length, 2);
});

test('诊断开始前已有新进展时取消过时诊断，不调用模型也不阻断原工作', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'progress', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const goal = await f.goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'plan', { reason: '分析', nodes: [f.node('a')] });
  const lease = (await f.store.claimJob('original', f.now(), { kinds: ['enterprise.task'] }))!;
  await f.goals.begin('tenant', String(lease.payload.attemptId), { jobId: lease.id, workerId: 'original', fencingToken: lease.fencingToken, occurredAt: f.now() });
  const start = Date.parse(f.now()); for (let i = 1; i <= 46; i++) { f.advance(new Date(start + i * 20_000).toISOString()); await f.store.renewJobLease(lease.id, 'original', lease.fencingToken, f.now()); }
  assert.ok(await f.goals.supervise('tenant', goal.id)); let calls = 0;
  const runtime = new EnterpriseTaskRuntime({ goals: f.goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() {
    await f.operating.bridge.store.transact('tenant', tx => { const current = tx.getProjection<any>('enterprise-work.attempt', String(lease.payload.attemptId))!; f.operating.record(tx, 'enterprise-work.attempt', { ...current, streamVersion: current.streamVersion + 1, updatedAt: f.now() }, 'fixture', 'fixture.progress_recorded'); }); return 'fixture-key';
  } }, invoke: async () => { calls++; throw new Error('MUST_NOT_CALL'); } });
  const worker = new AgentOsWorker({ id: 'diagnostic', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'cancelled'); assert.equal(calls, 0);
  assert.equal((await f.goals.get(f.actor('sales'), goal.id)).status, 'running');
});

test('人工提交计划会撤销尚未开始的自动规划，不让过时规划阻断新计划', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'manual-first', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  const requested = await f.goals.requestPlan(f.actor('sales'), draft.id, active.streamVersion, 'planner');
  const committed = await f.goals.plan(f.actor('sales'), draft.id, requested.streamVersion, 'manual', { reason: '人员已确定计划', nodes: [f.node('a')] });
  assert.equal(committed.attempts.find(a => a.kind === 'planning')!.status, 'cancelled');
  assert.equal(committed.attempts.find(a => a.kind === 'task')!.status, 'queued');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.reservation').filter(r => r.status === 'reserved').length), 1);
});

test('人工计划取代在途规划时，旧规划仅结算费用，不能覆盖或阻断新计划', async t => {
  const f = await setup(t), draft = await f.goals.create(f.actor('sales'), f.workspace.id, 'inflight-plan', f.input), active = await f.goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  await f.goals.requestPlan(f.actor('sales'), draft.id, active.streamVersion, 'planner');
  const runtime = new EnterpriseTaskRuntime({ goals: f.goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { return 'fixture-key'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: async () => { const current = await f.goals.get(f.actor('sales'), draft.id); await f.goals.plan(f.actor('sales'), draft.id, current.streamVersion, 'manual', { reason: '人员确定新计划', nodes: [f.node('manual')] }); return { text: JSON.stringify({ reason: '旧候选', nodes: [{ ...f.node('obsolete'), inputRefs: undefined, sourceIds: ['s0'] }] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }; },
  });
  const worker = new AgentOsWorker({ id: 'planner', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'cancelled');
  const result = await f.goals.get(f.actor('sales'), draft.id); assert.equal(result.status, 'running'); assert.equal(result.plan!.nodes[0]!.id, 'manual'); assert.equal(result.attempts.length, 2);
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections<any>('budget.account').find(a => a.scope.namespace === 'goal').spentTokens), 3);
});
