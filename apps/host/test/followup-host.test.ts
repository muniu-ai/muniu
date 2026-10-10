// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendKernelEvent } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, createKernelAgentTurnHandler } from '@mn/worker';
import { createAgentOsHost } from '../src/host.js';
import { assertGoalExecutionResources } from '../src/goal-runtime.js';
import { validateBusinessContextSource } from '../src/business-context.js';
import { createOpcModelContextReader } from '../src/opc-model-context.js';
import { recoverFollowups } from '../src/followup-runtime.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mn-followup-host-'));
  const storageOptions = { databaseFile: join(directory, 'state.sqlite'), hmacKey: Buffer.alloc(32, 67) };
  let store = new SqliteStorage(storageOptions);
  const cas = new FileCas({ rootDir: join(directory, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 68));
  const secretStore = { async save() { return 'keychain://muniu.v2/followup'; }, async read() { return 'fixture'; } };
  let host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, goalPollIntervalMs: 10 });
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: '受控跟进', viewMode: 'business', pluginIds: ['opc'] });
  const model = await host.kernel.saveModelConnection('local', 'local-owner', randomUUID(), { presetId: 'deepseek', displayName: '合成模型', secretRef: 'keychain://muniu.v2/followup', defaultModel: 'deepseek-v4-flash', discoveredModels: ['deepseek-v4-flash'] });
  await store.transact('local', tx => { tx.putProjection('modelConnection', model.id, { ...model, status: 'ready', streamVersion: 2 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: model.id, expectedStreamVersion: 1, type: 'fixture.ready', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  const send = async (path: string, body?: unknown, key: string = randomUUID()) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (path: string, body?: unknown, key?: string) => { const r = await send(path, body, key); assert.ok(r.status >= 200 && r.status < 300, JSON.stringify({ path, ...r })); return r.body.data; };
  let calls = 0, failNextModel = false;
  const worker = () => new AgentOsWorker({ id: 'followup-worker', store, lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: {
    'agent.execution.run': createKernelAgentTurnHandler({ store, approvalKernel: host.kernel, secretStore,
      runtimeProtection: { cas, keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store, cas, protectedPayloadKeyProvider: keyProvider }),
      modelInvoker: async ({ request }) => { calls++; assert.equal(request.availableToolIds.length, 0); if (failNextModel) { failNextModel = false; throw new Error('synthetic transport outcome unknown'); } return { text: '已根据获准客户需求完成分析。', toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } }; },
      modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '1000000000', cachedInputNanoMinorUnitsPerToken: '1000000000', outputNanoMinorUnitsPerToken: '1000000000' } }),
    }),
  } });
  const wait = async <T,>(read: () => Promise<T>, condition: (value: T) => boolean, execute = true): Promise<T> => {
    let last: T | undefined;
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      if (execute) await worker().pollOnce(); last = await read(); if (condition(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(JSON.stringify(last));
  };
  const business = async (name: string, id = 'customer') => {
    const state = await ok(`/v2/plugins/opc/business?workspaceId=${workspace.id}`);
    return ok('/v2/plugins/opc/business/commands', { workspaceId: workspace.id, expectedStreamVersion: state.state.streamVersion,
      command: { type: 'customer.record', customerId: id, name, source: '合成资料', need: '需要新的交付方案' } });
  };
  await business('初始客户');
  const source = await ok(`/v2/workspaces/${workspace.id}/business-context/customer/customer`);
  const thread = await host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: workspace.id, subject: '客户方案', pluginId: 'opc' });
  const budget = { maxTokens: 60000, maxCostMinorUnits: '1000', currency: 'CNY', maxDurationMs: 120000 };
  const created = await ok(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: '分析客户需求并提出方案', resourceRefs: [source.sourceRef], budget,
    deliverables: [{ key: 'report', title: '方案', required: true, criteria: [{ id: 'complete', description: '说明需求和方案依据' }] }] });
  const goalPath = `/v2/goals/${created.goal.id}`;
  const planned = await ok(`${goalPath}/plan-revisions`, { workspaceId: workspace.id, expectedStreamVersion: created.goal.streamVersion, modelBindingId: model.id });
  await ok(`${goalPath}/commands`, { workspaceId: workspace.id, expectedStreamVersion: planned.goal.streamVersion, command: 'start', planRevisionId: planned.plan.id, planDigest: planned.plan.digest });
  const parent = await wait(() => ok(`${goalPath}?workspaceId=${workspace.id}`), value => value.goal.status === 'awaiting_acceptance');
  const path = `/v2/workspaces/${workspace.id}/followups`;
  const input = { expectedStreamVersion: 0, parentGoalId: parent.goal.id, expectedGoalStreamVersion: parent.goal.streamVersion,
    parentPlanDigest: parent.plan.digest, title: '客户需求跟进', instruction: '客户需求变化后重新整理影响和下一步，等待用户验收。', enabled: true,
    trigger: { kind: 'business_changed', sourceRef: source.sourceRef }, resourceRefs: [source.sourceRef], modelBindingId: model.id,
    perRunBudget: budget, periodBudget: { periodMs: 86400000, maxRuns: 2, maxTokens: 120000, maxCostMinorUnits: '2000', currency: 'CNY' },
    maxRuns: 3, expiresAt: new Date(Date.now() + 86400000 * 7).toISOString() };
  return { get store() { return store; }, get host() { return host; }, workspace, path, input, parent, goalPath, ok, send, business, wait, worker, calls: () => calls,
    failNext() { failNextModel = true; },
    recoverAt: (now: string) => recoverFollowups({ store, kernel: host.kernel, cas, keyProvider, protectedJournal: true, tenantId: 'local', now: () => now, id: kind => `${kind}-${randomUUID()}`, definitions: [host.plugins.definition('opc')!] }),
    recover: () => recoverFollowups({ store, kernel: host.kernel, cas, keyProvider, protectedJournal: true, tenantId: 'local', now: () => new Date().toISOString(), id: kind => `${kind}-${randomUUID()}`, definitions: [host.plugins.definition('opc')!] }),
    async restart() { await host.close(); store = new SqliteStorage(storageOptions); host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, goalPollIntervalMs: 10 }); await store.rebuildProjections('local'); } };
}

test('业务变化跟进显式启用，无变化不调用模型，重复观察与重启不重复派发', async t => {
  const f = await fixture(t), key = randomUUID();
  const created = await f.ok(f.path, f.input, key);
  assert.equal(created.policy.status, 'active');
  assert.equal((await f.ok(f.path, f.input, key)).policy.id, created.policy.id);
  const path = `${f.path}/${created.policy.id}`;
  await f.business('其他客户', 'unrelated');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await f.ok(path)).runs.length, 0);
  assert.equal(f.calls(), 1);
  await f.business('修改需求的客户');
  const result = await f.wait(() => f.ok(path), detail => detail.runs[0]?.status === 'awaiting_acceptance');
  assert.equal(result.runs.length, 1); assert.equal(f.calls(), 2);
  assert.notEqual(result.runs[0].goalId, f.parent.goal.id);
  assert.deepEqual(result.runs[0].actual, { tokens: 20, costMinorUnits: '20', currency: 'CNY' });
  const notices = (await f.ok(`/v2/inbox?workspaceId=${f.workspace.id}`)).filter((item: any) => item.kind === 'notice');
  assert.equal(notices.length, 1); assert.equal(notices[0].navigation.resourceRef.resourceId, result.runs[0].goalId);
  await f.restart(); await new Promise(resolve => setTimeout(resolve, 100)); await f.worker().pollOnce();
  assert.equal((await f.ok(path)).runs.length, 1); assert.equal(f.calls(), 2);
  assert.equal((await f.ok(`/v2/inbox?workspaceId=${f.workspace.id}`)).filter((item: any) => item.kind === 'notice').length, 1);
});

test('暂停不派发，恢复保留累计额度，父目标关闭使跟进停止', async t => {
  const f = await fixture(t), created = await f.ok(f.path, f.input), path = `${f.path}/${created.policy.id}`;
  const paused = await f.ok(`${path}/commands`, { expectedStreamVersion: created.policy.streamVersion, command: 'pause' });
  await f.business('暂停期间变化'); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await f.ok(path)).runs.length, 0); assert.equal(f.calls(), 1);
  await f.ok(`${path}/commands`, { expectedStreamVersion: paused.policy.streamVersion, command: 'resume' });
  const result = await f.wait(() => f.ok(path), detail => detail.runs[0]?.status === 'awaiting_acceptance');
  assert.equal(result.currentPeriod.runCount, 1);
  const parent = await f.ok(`${f.goalPath}?workspaceId=${f.workspace.id}`);
  await f.ok(`${f.goalPath}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: parent.goal.streamVersion, command: 'cancel' });
  await f.business('关闭后变化');
  const stopped = await f.wait(() => f.ok(path), detail => detail.policy.status === 'invalidated');
  assert.equal(stopped.runs.length, 1); assert.equal(f.calls(), 2);
});

test('跟进拒绝隐式启用、扩大资料范围以及不匹配的费用币种', async t => {
  const f = await fixture(t);
  for (const input of [{ ...f.input, enabled: false }, { ...f.input, resourceRefs: [] },
    { ...f.input, periodBudget: { ...f.input.periodBudget, currency: 'USD' } },
    { ...f.input, perRunBudget: { ...f.input.perRunBudget, currency: 'USD' }, periodBudget: { ...f.input.periodBudget, currency: 'USD' } }]) {
    assert.ok((await f.send(f.path, input)).status >= 400);
  }
  assert.deepEqual(await f.ok(f.path), []); assert.equal(f.calls(), 1);
});


test('周期额度包含待验收任务的剩余预留，暂停恢复和新变化不能重置额度', async t => {
  const f = await fixture(t), created = await f.ok(f.path, { ...f.input, periodBudget: { ...f.input.periodBudget, maxRuns: 1 } }), path = `${f.path}/${created.policy.id}`;
  await f.business('第一轮变化');
  const first = await f.wait(() => f.ok(path), detail => detail.runs[0]?.status === 'awaiting_acceptance');
  assert.equal(first.currentPeriod.settled.costMinorUnits, '20');
  assert.equal(first.currentPeriod.reserved.costMinorUnits, '980');
  await f.business('第二轮变化'); await f.recover();
  const paused = await f.ok(`${path}/commands`, { expectedStreamVersion: first.policy.streamVersion, command: 'pause' });
  await f.ok(`${path}/commands`, { expectedStreamVersion: paused.policy.streamVersion, command: 'resume' });
  await f.recover(); await f.worker().pollOnce();
  const result = await f.ok(path); assert.equal(result.runs.length, 1); assert.equal(result.currentPeriod.runCount, 1); assert.equal(f.calls(), 2);
  const notices = (await f.ok(`/v2/inbox?workspaceId=${f.workspace.id}`)).filter((item: any) => item.kind === 'notice');
  assert.equal(notices.length, 2);
});

test('竞争派发只创建一次目标和执行，手动开始不能绕过跟进调度', async t => {
  const f = await fixture(t), created = await f.ok(f.path, f.input), path = `${f.path}/${created.policy.id}`;
  await f.business('并发变化'); await Promise.all([f.recover(), f.recover(), f.recover()]);
  const detail = await f.wait(() => f.ok(path), value => value.runs[0]?.status === 'awaiting_acceptance');
  assert.equal(detail.runs.length, 1); assert.equal(f.calls(), 2); assert.equal(detail.policy.status, 'active');
  const executions = await f.store.transact('local', tx => tx.listProjections<any>('execution').filter(execution => execution.id === detail.runs[0].executionId));
  assert.equal(executions.length, 1);
  const thread = await f.store.transact('local', tx => tx.getProjection<any>('thread', executions[0].threadId)!);
  await f.host.kernel.submitTurn('local', 'local-owner', randomUUID(), { workspaceId: f.workspace.id, threadId: thread.id, expectedStreamVersion: thread.streamVersion,
    message: '尝试绕过跟进再次执行', agentDefinitionId: 'opc.business-assistant', modelBindingId: f.input.modelBindingId, executionPrincipalId: 'local-owner',
    authority: { workspaceId: f.workspace.id, principalId: 'local-owner', toolIds: [], dataScopes: [], autoAllowedEffects: [], budget: { ...f.input.perRunBudget, maxSubagents: 0, maxSubagentDepth: 0 } } });
  await f.worker().pollOnce(); assert.equal(f.calls(), 2);
});

test('派发后停止在模型调用前重新检查跟进授权', async t => {
  const f = await fixture(t), created = await f.ok(f.path, f.input), path = `${f.path}/${created.policy.id}`;
  await f.business('排队后停止');
  const queued = await f.wait(() => f.ok(path), value => value.runs[0]?.status === 'running', false);
  await f.ok(`${path}/commands`, { expectedStreamVersion: queued.policy.streamVersion, command: 'stop' });
  await f.worker().pollOnce(); await f.recover();
  assert.equal(f.calls(), 1); assert.equal((await f.ok(path)).policy.status, 'stopped');
});

test('模型结果未知保留额度并阻止新变化触发重放', async t => {
  const f = await fixture(t), created = await f.ok(f.path, f.input), path = `${f.path}/${created.policy.id}`;
  f.failNext(); await f.business('未知结果变化');
  const unknown = await f.wait(() => f.ok(path), value => value.runs[0]?.status === 'needs_reconciliation');
  assert.equal(unknown.currentPeriod.unknown.costMinorUnits, '1000');
  assert.equal(unknown.runs[0].actual, undefined);
  const child = await f.ok(`/v2/goals/${unknown.runs[0].goalId}?workspaceId=${f.workspace.id}`);
  await f.ok(`/v2/goals/${child.goal.id}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: child.goal.streamVersion, command: 'cancel' });
  await f.recover(); assert.equal((await f.ok(path)).currentPeriod.unknown.costMinorUnits, '1000');
  await f.business('未知结果后又变化'); await f.recover(); await f.worker().pollOnce();
  assert.equal((await f.ok(path)).runs.length, 1); assert.equal(f.calls(), 2);
});

test('跟进启用后执行者配置变化使订阅失效，排队任务不能继续', async t => {
  const f = await fixture(t), created = await f.ok(f.path, f.input), path = `${f.path}/${created.policy.id}`;
  await f.business('执行者配置将变化');
  await f.wait(() => f.ok(path), value => value.runs[0]?.status === 'running', false);
  await f.store.transact('local', tx => {
    const model = tx.getProjection<any>('modelConnection', f.input.modelBindingId)!;
    tx.putProjection('modelConnection', model.id, { ...model, status: 'invalid', streamVersion: model.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: model.id, expectedStreamVersion: model.streamVersion, type: 'fixture.invalidated', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  await f.recover(); await f.worker().pollOnce();
  assert.equal((await f.ok(path)).policy.status, 'invalidated'); assert.equal(f.calls(), 1);
});


test('到期停止未派发工作，不能通过继续跟进延长旧授权', async t => {
  const f = await fixture(t), created = await f.ok(f.path, f.input), path = `${f.path}/${created.policy.id}`;
  await f.recoverAt(new Date(Date.parse(f.input.expiresAt) + 1).toISOString());
  const expired = await f.ok(path); assert.equal(expired.policy.status, 'expired');
  assert.ok((await f.send(`${path}/commands`, { expectedStreamVersion: expired.policy.streamVersion, command: 'resume' })).status >= 400);
  await f.business('到期后变化'); await f.recover(); await f.worker().pollOnce();
  assert.equal((await f.ok(path)).runs.length, 0); assert.equal(f.calls(), 1);
});

test('重用创建幂等键不得扩大额度，同一跟进命令需要版本比较', async t => {
  const f = await fixture(t), key = randomUUID(), created = await f.ok(f.path, f.input, key), path = `${f.path}/${created.policy.id}`;
  assert.ok((await f.send(f.path, { ...f.input, maxRuns: 4 }, key)).status >= 400);
  const paused = await f.ok(`${path}/commands`, { expectedStreamVersion: created.policy.streamVersion, command: 'pause' }, 'pause-once');
  assert.equal((await f.ok(`${path}/commands`, { expectedStreamVersion: created.policy.streamVersion, command: 'pause' }, 'pause-once')).policy.streamVersion, paused.policy.streamVersion);
  assert.ok((await f.send(`${path}/commands`, { expectedStreamVersion: created.policy.streamVersion, command: 'resume' })).status >= 400);
});

for (const phase of ['preview', 'queued', 'active']) test(`跟进返工授权与累计费用：${phase}`, async t => {
  const queued = phase !== 'preview';
  const f = await fixture(t), created = await f.ok(f.path, f.input), path = `${f.path}/${created.policy.id}`;
  await f.business('需要返工的变化');
  const first = await f.wait(() => f.ok(path), value => value.runs[0]?.status === 'awaiting_acceptance');
  const goalPath = `/v2/goals/${first.runs[0].goalId}`;
  let detail = await f.ok(`${goalPath}?workspaceId=${f.workspace.id}`);
  detail = await f.ok(`${goalPath}/delivery-decisions`, { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion,
    deliverySetId: detail.deliverySet.id, criteriaVersion: detail.goal.criteriaVersion,
    items: [{ key: 'followup', digest: detail.deliverySet.items[0].digest, decision: 'request_changes', failedCriterionIds: ['source'], instruction: '补充变化来源' }] });
  const previewInput = { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, decisionId: detail.deliveryReview.decisions.at(-1).id };
  if (queued) {
    const preview = await f.ok(`${goalPath}/rework-previews`, previewInput);
    const revised = await f.ok(`${goalPath}/reworks`, { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, previewId: preview.id, previewDigest: preview.digest });
    await f.wait(() => f.store.transact('local', tx => tx.listProjections<any>('coordination.attempt').filter(item => item.runId === revised.goal.coordinationRef.runId)), value => value.length > 0, false);
  }
  if (phase === 'active') {
    await f.wait(() => f.ok(`${goalPath}?workspaceId=${f.workspace.id}`), value => value.goal.status === 'awaiting_acceptance');
    await f.recover();
    const completed = await f.ok(path);
    assert.equal(f.calls(), 3);
    assert.deepEqual(completed.runs[0].actual, { tokens: 40, costMinorUnits: '40', currency: 'CNY' });
    assert.equal(completed.currentPeriod.reserved.costMinorUnits, '960');
    return;
  }
  const latest = await f.ok(path);
  await f.ok(`${path}/commands`, { expectedStreamVersion: latest.policy.streamVersion, command: 'stop' });
  if (!queued) assert.ok((await f.send(`${goalPath}/rework-previews`, previewInput)).status >= 400, '停止的跟进不能创建返工计划');
  else { await f.worker().pollOnce(); assert.equal(f.calls(), 2, '子会话的返工执行必须重新检查跟进授权'); }
});
