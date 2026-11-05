// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryKeyProvider } from '@mn/storage';
import { AgentOsWorker } from '@mn/worker';
import { EnterpriseIdentityService, EnterprisePermissionService, EnterpriseQuotaService } from '@mn/enterprise-services';
import { createEnterpriseEventRepository } from '../../apps/host/dist/enterprise-event-repository.js';
import { EnterpriseBusinessService } from '../../apps/host/dist/enterprise-business.js';
import { EnterpriseOperatingService } from '../../apps/host/dist/enterprise-operating.js';
import { EnterpriseGoalService } from '../../apps/host/dist/enterprise-goals.js';
import { EnterpriseTaskRuntime } from '../../apps/host/dist/enterprise-task-runtime.js';
export function goalsRuntime({ store, cas, key, modelUrl, now = () => new Date().toISOString(), invoke, secretHook }) {
  const keyProvider = new InMemoryKeyProvider(Buffer.from(key, 'hex')), repository = createEnterpriseEventRepository({ store, cas, keyProvider, allowExecutionEvents: true });
  const operating = new EnterpriseOperatingService({ store, repository, now });
  const model = { id: 'model', version: 1, providerId: 'openai', modelId: 'fixture', mode: 'test_fixture', secretRef: 'fixture://enterprise/model' };
  const goals = new EnterpriseGoalService({ operating, modelsFor: () => [model] });
  const runtime = new EnterpriseTaskRuntime({ goals, protection: { cas, keyProvider }, secretStore: { async read() { await secretHook?.(); return 'synthetic-only'; } },
    quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture-rate', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: invoke ?? (async input => { const response = await fetch(modelUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.request), signal: input.signal }); return response.json(); }),
  });
  const worker = id => new AgentOsWorker({ id, store: runtime.workerStore(store), tenantId: 'enterprise-goals', now: () => new Date(now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  return { repository, operating, goals, runtime, worker };
}
export async function verifyEnterpriseGoals({ store, cas, key, pool, rebuild, config, root, connect, registerChild }) {
  const tenantId = 'enterprise-goals'; let offset = 0, child, hook;
  const now = () => new Date(Date.now() + offset).toISOString(), deadline = new Date(Date.now() + 3600000).toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString();
  await pool.query('create table fixture_provider.goal_model_calls(execution_id text primary key, calls integer not null)');
  const server = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), context = JSON.parse(input.messages.at(-1).content);
    await pool.query('insert into fixture_provider.goal_model_calls values($1,1) on conflict(execution_id) do update set calls=fixture_provider.goal_model_calls.calls+1', [input.executionId]);
    const value = context.kind === 'planning' ? { reason: '合成规划', nodes: [{ id: 'analysis', dependsOn: [], capabilityId: 'business.analyze', capabilityVersion: '1', modelBindingId: 'model', sourceIds: ['s0'], budget: { maxTokens: 10, maxCostMinor: 1, currency: 'CNY', deadline }, acceptanceCriteria: ['引用来源'], effect: 'read' }] }
      : { status: 'complete', summary: '合成报告', findings: [{ text: '待核查', sources: context.sources.map(s => s.reference) }], acceptance: context.node.acceptanceCriteria.map(criterion => ({ criterion, status: 'satisfied', sources: context.sources.map(s => s.reference) })), unknown: [] };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ text: JSON.stringify(value), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }));
  })().catch(() => response.writeHead(500).end()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    let f = goalsRuntime({ store, cas, key, modelUrl, now, secretHook: async () => { const fn = hook; hook = undefined; await fn?.(); } });
    const identity = new EnterpriseIdentityService({ repository: f.repository, now }), permissions = new EnterprisePermissionService({ repository: f.repository, now }), quotas = new EnterpriseQuotaService({ repository: f.repository, now }), business = new EnterpriseBusinessService({ repository: f.repository, now });
    await identity.provision({ tenantId, name: '合成协作企业', issuer: 'https://issuer.test/', maxMembers: 2, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
    const actor = { tenantId, principalId: 'admin', sessionEpoch: 1 }, workspace = await identity.createWorkspace(actor, 'workspace', { name: '协作', mode: 'builtin' });
    const role = { id: 'business', workspaceId: workspace.id, principalId: actor.principalId, role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read', 'write'], fieldClasses: ['public'], expiresAt };
    await permissions.grantRole(actor, 'role', role);
    const customer = await business.execute({ actor, actorKind: 'human', workspaceId: workspace.id, idempotencyKey: 'customer', command: { type: 'customer.create', id: 'customer', name: 'CONFIDENTIAL-customer' } });
    const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 2000, costMinorUnits: '200', currency: 'CNY', evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '20', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '2', validFrom: new Date(Date.now() - 10000).toISOString(), expiresAt };
    await quotas.provision(tenantId, 'platform', 0, limits); await quotas.configure(actor, 'quota', workspace.id, 0, limits);
    const budget = { maxTokens: 200, maxCostMinor: 20, currency: 'CNY', deadline }, spec = { title: '企业工作', message: 'CONFIDENTIAL-request', sources: [{ reference: customer.reference, fields: ['name'] }], acceptanceCriteria: ['完成检查'], budget, capabilityIds: ['business.analyze', 'business.review'], modelBindingIds: ['model'] };
    const node = id => ({ id, dependsOn: [], capabilityId: 'business.analyze', capabilityVersion: '1', modelBindingId: 'model', inputRefs: [customer.reference], budget: { ...budget, maxTokens: 10, maxCostMinor: 1 }, acceptanceCriteria: ['引用来源'], effect: 'read' });
    const authorize = async key => { const draft = await f.goals.create(actor, workspace.id, key, spec); return f.goals.authorize(actor, draft.id, draft.streamVersion, draft.scopeDigest, 'authorize-' + key); };
    let goal = await authorize('success'); goal = await f.goals.plan(actor, goal.id, goal.streamVersion, 'plan-success', { reason: '两个节点', nodes: [node('a'), { ...node('b'), dependsOn: ['a'] }] });
    const raced = await Promise.all([f.worker('goal-a').pollOnce(), f.worker('goal-b').pollOnce()]);
    assert.ok(raced.some(r => r.status === 'completed')); await f.worker('goal-a').pollOnce();
    const completed = await f.goals.get(actor, goal.id); assert.equal(completed.status, 'awaiting_acceptance');
    await rebuild(tenantId); f = goalsRuntime({ store, cas, key, modelUrl, now, secretHook: async () => { const fn = hook; hook = undefined; await fn?.(); } });
    assert.deepEqual(await f.goals.get(actor, goal.id), completed);
    const planned = await authorize('planner'); await f.goals.requestPlan(actor, planned.id, planned.streamVersion, 'request-plan');
    assert.equal((await f.worker('planner').pollOnce()).status, 'completed'); assert.equal((await f.goals.get(actor, planned.id)).plan.nodes.length, 1);
    await f.worker('analysis').pollOnce();
    let queued = await authorize('replace'); queued = await f.goals.plan(actor, queued.id, queued.streamVersion, 'replace-one', { reason: '原节点', nodes: [node('old')] });
    const lease = await store.claimJob('stale', now(), { tenantId, kinds: ['enterprise.task'] });
    const changed = await f.goals.plan(actor, queued.id, queued.streamVersion, 'replace-two', { reason: '替换未开始节点', nodes: [node('new')] });
    await assert.rejects(f.goals.begin(tenantId, lease.payload.attemptId, { jobId: lease.id, workerId: 'stale', fencingToken: lease.fencingToken, occurredAt: now() }), { code: 'STALE_FENCING_TOKEN' });
    await f.goals.control(actor, changed.id, changed.streamVersion, 'cancel', 'cancel-replacement');
    let revoked = await authorize('revoked'); revoked = await f.goals.plan(actor, revoked.id, revoked.streamVersion, 'revoked-plan', { reason: '撤权边界', nodes: [node('revoked')] });
    hook = () => permissions.revoke(actor, 'revoke', 'role', role.id, 1); assert.equal((await f.worker('revoked').pollOnce()).status, 'failed');
    await assert.rejects(f.goals.get(actor, revoked.id), { code: 'OBJECT_ACCESS_DENIED' });
    await permissions.grantRole(actor, 'restored', { ...role, id: 'restored' });
    let crash = await authorize('crash'); crash = await f.goals.plan(actor, crash.id, crash.streamVersion, 'crash-plan', { reason: '已提交调用后崩溃', nodes: [node('crash')] });
    const file = join(root, 'goals-child.json'); await writeFile(file, JSON.stringify({ ...config, modelUrl }), { mode: 0o600 });
    child = fork(new URL('../enterprise-goals-child.mjs', import.meta.url), [file], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=128' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    registerChild?.(child);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('GOAL_CHILD_TIMEOUT')), 20000); child.once('message', value => { clearTimeout(timer); assert.equal(value.status, 'committed'); resolve(); }); child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error('GOAL_CHILD_EXITED')); }); });
    const closed = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await closed; child = undefined;
    offset = 31000; const connection = await connect({ offset });
    const recovered = goalsRuntime({ store: connection.store, cas: connection.cas, key, modelUrl, now });
    assert.equal((await recovered.worker('recovered').pollOnce()).status, 'needs_reconciliation');
    assert.equal((await recovered.goals.get(actor, crash.id)).status, 'needs_reconciliation');
    assert.equal((await pool.query('select count(*)::int as count from fixture_provider.goal_model_calls where execution_id=$1', [crash.attempts[0].executionId])).rows[0].count, 0);
    assert.equal((await pool.query('select count(*)::int as count from fixture_provider.goal_model_calls where calls<>1')).rows[0].count, 0);
    const raw = await pool.query('select public_payload::text from mn_enterprise_v1.events where tenant_id=$1', [tenantId]); assert.doesNotMatch(JSON.stringify(raw.rows), /CONFIDENTIAL|permissionDigest|secretRef/);
    process.stdout.write('E4.2 PostgreSQL：动态计划、模型规划、双 Worker、节点替换与旧租约、撤权、SIGKILL、费用保留及重建通过。\n');
  } finally { child?.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
