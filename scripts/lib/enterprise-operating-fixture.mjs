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
import { EnterpriseEvaluationRuntime } from '../../apps/host/dist/enterprise-evaluation.js';
export function operatingRuntime({ store, cas, key, now = () => new Date().toISOString(), modelUrl, invoke, secretHook }) {
  const keyProvider = new InMemoryKeyProvider(Buffer.from(key, 'hex'));
  const repository = createEnterpriseEventRepository({ store, cas, keyProvider, allowExecutionEvents: true });
  const operating = new EnterpriseOperatingService({ store, repository, now });
  const runtime = new EnterpriseEvaluationRuntime({ operating, protection: { cas, keyProvider }, modelFor: () => ({ id: 'fixture-evaluation', version: 1, providerId: 'openai', modelId: 'gpt-4.1-mini', mode: 'test_fixture', secretRef: 'fixture://enterprise/model' }),
    secretStore: { async read() { await secretHook?.(); return 'synthetic-only'; } },
    quote: async () => ({ inputTokenLimit: 8, maxOutputTokens: 2, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }),
    invoke: invoke ?? (async input => { const response = await fetch(modelUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.request), signal: input.signal }); return response.json(); }),
  });
  const worker = id => new AgentOsWorker({ id, store: runtime.workerStore(store), tenantId: 'enterprise-operating', now: () => new Date(now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.evaluation': runtime.workerHandler() } });
  return { repository, operating, runtime, worker };
}
export async function verifyEnterpriseOperating({ store, cas, key, pool, rebuild, config, root, connect }) {
  const tenantId = 'enterprise-operating'; let offset = 0, lose = false, hook, child;
  const now = () => new Date(Date.now() + offset).toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString();
  await pool.query('create table fixture_provider.model_calls(execution_id text primary key, calls integer not null)');
  const server = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), context = JSON.parse(input.messages.at(-1).content);
    await pool.query('insert into fixture_provider.model_calls values($1,1) on conflict(execution_id) do update set calls=fixture_provider.model_calls.calls+1', [input.executionId]);
    if (lose) { request.socket.destroy(); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ text: JSON.stringify({ candidate: true, summary: '需要核查', citations: [{ triggerId: context.triggers[0].id }] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } }));
  })().catch(() => response.writeHead(500).end()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    let f = operatingRuntime({ store, cas, key, now, modelUrl, secretHook: async () => { const fn = hook; hook = undefined; await fn?.(); } });
    const identity = new EnterpriseIdentityService({ repository: f.repository, now }), permissions = new EnterprisePermissionService({ repository: f.repository, now }), quotas = new EnterpriseQuotaService({ repository: f.repository, now }), business = new EnterpriseBusinessService({ repository: f.repository, now });
    await identity.provision({ tenantId, name: '合成持续经营企业', issuer: 'https://issuer.test/', maxMembers: 2, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
    const actor = { tenantId, principalId: 'admin', sessionEpoch: 1 }, workspace = await identity.createWorkspace(actor, 'workspace', { name: '合成主体', mode: 'builtin' });
    const role = { id: 'business', workspaceId: workspace.id, principalId: actor.principalId, role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read', 'write'], fieldClasses: ['public'], expiresAt };
    await permissions.grantRole(actor, 'role', role);
    const customer = await business.execute({ actor, actorKind: 'human', workspaceId: workspace.id, idempotencyKey: 'customer', command: { type: 'customer.create', id: 'customer', name: 'CONFIDENTIAL-synthetic-customer' } });
    const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 100, costMinorUnits: '100', currency: 'CNY', evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '100', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '10', validFrom: new Date(Date.now() - 10000).toISOString(), expiresAt };
    await quotas.provision(tenantId, 'platform', 0, limits); await quotas.configure(actor, 'quota', workspace.id, 0, limits);
    const source = { id: 'internal', tenantId, workspaceId: workspace.id, kind: 'internal' }, sources = [{ reference: customer.reference, fields: ['name'] }], evaluation = { tokens: 10, costMinorUnits: '10', currency: 'CNY' };
    await f.operating.registerSource(actor, 'source', source);
    await f.operating.writePolicy(actor, workspace.id, 'policy', { id: 'observe', expectedStreamVersion: 0, responsiblePrincipalId: actor.principalId, sourceIds: [source.id], eventTypes: ['business.changed'], sources, mode: 'observe', evaluation, notification: 'source', validUntil: expiresAt });
    await f.operating.controlPolicy(actor, workspace.id, 'observe', 'accept', 1, 'accept');
    const receive = () => f.operating.ingress(source).receive({ expectedCursor: null, nextCursor: '1', events: [{ id: 'first', type: 'business.changed', objectRefs: [customer.reference], origin: 'external' }] });
    await Promise.all([receive(), receive()]);
    assert.equal((await f.operating.inspect(actor, workspace.id)).triggers.length, 1);
    const first = await f.runtime.dispatchFair([tenantId]); assert.ok(first);
    const outcomes = await Promise.all([f.worker('evaluate-a').pollOnce(), f.worker('evaluate-b').pollOnce()]);
    assert.equal(outcomes.filter(r => r.status === 'completed').length, 1);
    assert.equal((await f.runtime.view(actor, first.id)).mode, 'observe');
    assert.equal(await store.transact(tenantId, tx => tx.listProjections('goal').length), 0);
    const manual = key => f.operating.submit(actor, workspace.id, key, { sources, message: 'CONFIDENTIAL-synthetic-request', evaluation, validUntil: expiresAt });
    await manual('lost'); lose = true; const lost = await f.runtime.dispatch(tenantId);
    assert.equal((await f.worker('evaluate-a').pollOnce()).status, 'needs_reconciliation'); lose = false;
    const pending = (await f.operating.inspect(actor, workspace.id)).batches.find(b => b.id === lost.batchId);
    assert.equal((await f.operating.cancel(actor, workspace.id, pending.id, pending.streamVersion, 'cancel-unknown')).status, 'needs_reconciliation');
    await rebuild(tenantId);
    f = operatingRuntime({ store, cas, key, now, modelUrl, secretHook: async () => { const fn = hook; hook = undefined; await fn?.(); } });
    assert.equal((await f.worker('restart').pollOnce()).status, 'idle'); await receive();
    assert.equal((await f.runtime.view(actor, first.id)).costNanoMinorUnits, '300000000');
    await manual('revoked'); await f.runtime.dispatch(tenantId);
    hook = () => permissions.revoke(actor, 'revoke', 'role', role.id, 1);
    assert.equal((await f.worker('revoked').pollOnce()).status, 'failed');
    await assert.rejects(f.runtime.view(actor, first.id), { code: 'OBJECT_ACCESS_DENIED' });
    await permissions.grantRole(actor, 'restored-role', { ...role, id: 'restored-role' });
    await manual('crash'); const crash = await f.runtime.dispatch(tenantId);
    const file = join(root, 'evaluation-child.json'); await writeFile(file, JSON.stringify({ ...config, modelUrl }), { mode: 0o600 });
    child = fork(new URL('../enterprise-operating-child.mjs', import.meta.url), [file], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=128' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('EVALUATION_CHILD_TIMEOUT')), 20000); child.once('message', value => { clearTimeout(timer); assert.equal(value.status, 'committed'); resolve(); }); child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error('EVALUATION_CHILD_EXITED')); }); });
    const closed = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await closed; child = undefined;
    offset = 31000; const connection = await connect({ offset });
    const recovered = operatingRuntime({ store: connection.store, cas: connection.cas, key, now, modelUrl });
    assert.equal((await recovered.worker('recovered').pollOnce()).status, 'needs_reconciliation');
    assert.equal((await pool.query('select count(*)::int as count from fixture_provider.model_calls where execution_id=$1', [crash.executionId])).rows[0].count, 0);
    assert.equal((await recovered.runtime.view(actor, crash.id)).status, 'needs_reconciliation');
    const rootAccount = await store.transact(tenantId, tx => tx.listProjections('budget.account').find(a => a.scope.namespace === 'enterprise.workspace_budget'));
    assert.equal(rootAccount.spentCostMinorUnits, '1'); assert.equal(rootAccount.heldCostMinorUnits, '20');
    assert.equal((await pool.query('select count(*)::int as count from fixture_provider.model_calls where calls<>1')).rows[0].count, 0);
    const raw = await pool.query('select public_payload::text from mn_enterprise_v1.events where tenant_id=$1', [tenantId]);
    assert.doesNotMatch(JSON.stringify(raw.rows), /CONFIDENTIAL|permissionDigest|costNanoMinorUnits/);
    process.stdout.write('E4.1 PostgreSQL：原子游标、双 Worker、观察计费、未知费用、撤权、SIGKILL、重建和禁止重放通过。\n');
  } finally { child?.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
