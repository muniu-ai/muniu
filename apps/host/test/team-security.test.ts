// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Asset, CoordinationAttemptV2, Execution, GoalV2, WorkspaceMembership } from '@mn/contracts';
import { appendKernelEvent, type ModelConnection } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, createKernelAgentTurnHandler, createProtectedRuntimeStore, type ByokModelInvoker } from '@mn/worker';
import { createAgentOsHost } from '../src/host.js';
import { assertGoalExecutionResources } from '../src/goal-runtime.js';
import { validateBusinessContextSource } from '../src/business-context.js';
import { createOpcModelContextReader } from '../src/opc-model-context.js';

const usage = { inputTokens: 20, cachedInputTokens: 0, outputTokens: 20 };
const privateText = '受保护团队资料：合成交付暗号松柏，要求两周完成。';

async function fixture(t: test.TestContext, withMaterial = false) {
  const directory = await mkdtemp(join(tmpdir(), 'mn-team-security-'));
  const cas = new FileCas({ rootDir: join(directory, 'cas') });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 81));
  const storageOptions = { databaseFile: join(directory, 'state.sqlite'), hmacKey: Buffer.alloc(32, 82) };
  const open = async (store: SqliteStorage) => createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, goalPollIntervalMs: 10,
    secretStore: { async save() { return 'keychain://muniu.v2/team-security'; }, async read() { return 'fixture'; } } });
  let store = new SqliteStorage(storageOptions), host = await open(store);
  t.after(async () => { await host.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: '团队安全测试', viewMode: 'business', pluginIds: ['opc'] });
  const thread = await host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: workspace.id, subject: '研究资料', pluginId: 'opc' });
  const model = await host.kernel.saveModelConnection('local', 'local-owner', randomUUID(), {
    presetId: 'deepseek', displayName: '测试模型', secretRef: 'keychain://muniu.v2/team-security', defaultModel: 'deepseek-v4-flash', discoveredModels: ['deepseek-v4-flash'],
  });
  await store.transact('local', tx => {
    tx.putProjection('modelConnection', model.id, { ...model, status: 'ready', streamVersion: 2 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: model.id, expectedStreamVersion: 1,
      type: 'fixture.model_ready', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const send = async (path: string, body?: unknown, method = 'POST') => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : {
      method, headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() as any };
  };
  let asset: Asset | undefined;
  if (withMaterial) {
    const uploaded = await send('/v2/assets', { workspaceId: workspace.id, expectedStreamVersion: 0,
      attachments: [{ fileName: 'requirements.md', mediaType: 'text/markdown', contentBase64: Buffer.from(privateText).toString('base64'), protected: true }] });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    asset = uploaded.body.data[0];
  }
  const created = await send(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: '整理资料、来源与反证',
    resourceRefs: asset ? [{ namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest }] : [],
    budget: { maxTokens: 20000, maxCostMinorUnits: '500', currency: 'CNY', maxDurationMs: 120000 },
    deliverables: [{ key: 'report', title: '研究报告', required: true, criteria: [{ id: 'sources', description: '结论可追溯并说明反证' }] }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const goalId = created.body.data.goal.id as string, path = `/v2/goals/${goalId}`;
  const result = {
    directory, cas, keyProvider, workspace, thread, model, asset, goalId, path, send,
    get store() { return store; }, get host() { return host; },
    async restart() { await host.close(); store.close(); store = new SqliteStorage(storageOptions); host = await open(store); },
    attempts: () => store.transact('local', tx => tx.listProjections<CoordinationAttemptV2>('coordination.attempt')),
    goal: () => store.transact('local', tx => tx.getProjection<GoalV2>('goal.state', goalId)!),
    async start() {
      const planned = await send(`${path}/plan-revisions`, { workspaceId: workspace.id, expectedStreamVersion: 1, kind: 'team-v1',
        templateId: 'research-summary', templateVersion: '1', modelBindingId: model.id });
      assert.equal(planned.status, 200, JSON.stringify(planned.body));
      const started = await send(`${path}/commands`, { workspaceId: workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion,
        command: 'start', planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      await until('两项研究节点已持久派发', async () => (await result.attempts()).length === 2);
    },
  };
  return result;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function worker(f: Fixture, modelInvoker: ByokModelInvoker, onQuote = () => {}) {
  return new AgentOsWorker({ id: `worker-${randomUUID()}`, store: f.store,
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'agent.execution.run': createKernelAgentTurnHandler({ store: f.store, approvalKernel: f.host.kernel, scopeContext: f.host.context,
      secretStore: { async read() { return 'fixture'; } }, controlPollIntervalMs: 60000,
      runtimeProtection: { cas: f.cas, keyProvider: f.keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store: f.store, cas: f.cas, protectedPayloadKeyProvider: f.keyProvider }), modelInvoker,
      modelQuoter: async () => { onQuote(); return { inputTokenLimit: 100, maxOutputTokens: 100, rates: { id: 'fixture', currency: 'CNY',
        inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }; },
    }) } });
}
async function until(label: string, done: () => Promise<boolean>, timeoutMs = 5000, diagnose?: () => Promise<unknown>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${label}${diagnose ? `：${JSON.stringify(await diagnose())}` : ''}`);
}
const state = (f: Fixture) => f.store.transact('local', tx => ({
  attempts: tx.listProjections<CoordinationAttemptV2>('coordination.attempt').map(attempt => ({ nodeId: attempt.nodeId, status: attempt.status,
    reservation: attempt.reservation, executionStatus: tx.getProjection<Execution>('execution', attempt.executionId)?.status })),
  goalStatus: tx.getProjection<GoalV2>('goal.state', f.goalId)?.status,
  reservation: tx.getProjection<GoalV2>('goal.state', f.goalId)?.reservation,
}));

test('团队节点派发后模型版本变化，Worker 不计数或外发', async t => {
  const f = await fixture(t); await f.start();
  await f.store.transact('local', tx => {
    const current = tx.getProjection<ModelConnection>('modelConnection', f.model.id)!;
    tx.putProjection('modelConnection', current.id, { ...current, streamVersion: current.streamVersion + 1, secretRef: 'keychain://muniu.v2/reconfigured' });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: current.id, expectedStreamVersion: current.streamVersion,
      type: 'fixture.model_changed', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  let quotes = 0, calls = 0;
  const runner = worker(f, async () => { calls++; return { text: '禁止发送', toolCalls: [], usage }; }, () => quotes++);
  await runner.pollOnce(); await runner.pollOnce();
  assert.equal(quotes, 0); assert.equal(calls, 0);
  assert.equal((await f.attempts()).length, 2);
  assert.equal((await f.store.transact('local', tx => tx.listProjections('goal.teamOutput'))).length, 0);
});

for (const revoked of ['membership', 'asset'] as const) test(`团队模型在途撤销 ${revoked}：已知费用后台结算，正文和后继均受阻`, async t => {
  const f = await fixture(t, true); await f.start();
  if (revoked === 'membership') await f.host.kernel.setWorkspaceMembership('local', 'local-owner', randomUUID(), f.workspace.id, 'recovery-owner', 0, 'owner');
  let calls = 0;
  const runner = worker(f, async input => {
    calls++;
    assert.ok(input.request.messages.some(message => message.content.includes(privateText)));
    if (revoked === 'asset') {
      const deleted = await f.send(`/v2/assets/${f.asset!.id}`, { expectedStreamVersion: f.asset!.streamVersion, reason: '撤销来源授权' }, 'DELETE');
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    } else {
      const member = await f.store.transact('local', tx => tx.getProjection<WorkspaceMembership>('membership', `${f.workspace.id}:local-owner`)!);
      await f.host.kernel.removeWorkspaceMembership('local', 'recovery-owner', randomUUID(), f.workspace.id, 'local-owner', member.streamVersion);
    }
    return { text: '合成的私密派生结论，不得在撤权后传播', toolCalls: [], usage };
  });
  await runner.pollOnce(); await runner.pollOnce();
  assert.equal(calls, 1);
  await until('撤权后已知费用仍应后台结算', async () => (await f.attempts()).every(attempt => attempt.reservation.status === 'settled'), 5000, () => state(f));
  const attempts = await f.attempts();
  assert.equal(attempts.length, 2);
  assert.equal(attempts.reduce((sum, attempt) => sum + attempt.reservation.usage!.tokens, 0), 40);
  assert.equal(attempts.reduce((sum, attempt) => sum + BigInt(attempt.reservation.usage!.costMinorUnits ?? '0'), 0n), 4n);
  const goal = await f.goal();
  assert.equal(goal.reservation?.actual?.tokens, 40);
  assert.equal(goal.reservation?.actual?.costMinorUnits, '4');
  assert.equal((await f.store.transact('local', tx => tx.listProjections('goal.teamOutput'))).length, 0);
  for (const path of [f.path + `?workspaceId=${f.workspace.id}`, ...attempts.map(attempt => `/v2/workspaces/${f.workspace.id}/threads/${attempt.threadId}/turns`)]) {
    const read = await f.send(path);
    assert.ok(read.status >= 400);
    assert.equal(JSON.stringify(read.body).includes('私密派生结论'), false);
    assert.equal(JSON.stringify(read.body).includes(privateText), false);
  }
  if (revoked === 'asset') {
    const reader = createProtectedRuntimeStore({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, tenantId: 'local', workspaceId: f.workspace.id });
    await assert.rejects(reader.readExecution(attempts[0]!.executionId), { code: 'CONTEXT_SOURCE_REVOKED' });
  }
});

test('首个节点终结后重启 Host 和 SQLite，恢复汇合且不重复节点或费用', async t => {
  const f = await fixture(t); await f.start();
  const executions: string[] = [];
  const model: ByokModelInvoker = async input => {
    executions.push(input.request.executionId);
    return { text: JSON.stringify(input.request.messages).includes('当前职责：独立复核') ? JSON.stringify({ decision: 'pass', findings: [] }) : '合成结论：证据不足，需继续验证。', toolCalls: [], usage };
  };
  assert.equal((await worker(f, model).pollOnce()).status, 'completed');
  await until('首个节点费用已持久结算', async () => (await f.attempts()).some(attempt => attempt.reservation.status === 'settled'));
  const firstId = executions[0]!;
  await f.restart();
  const runner = worker(f, model);
  await until('重启后继续完成后继并汇合交付', async () => {
    await runner.pollOnce();
    return (await f.goal()).status === 'awaiting_acceptance';
  }, 15000, () => state(f));
  const attempts = await f.attempts();
  assert.equal(attempts.length, 4);
  assert.equal(new Set(attempts.map(attempt => attempt.nodeId)).size, 4);
  assert.equal(executions.filter(id => id === firstId).length, 1);
  assert.equal(executions.length, 4);
  assert.equal((await f.goal()).reservation?.actual?.tokens, 160);
  assert.equal((await f.goal()).reservation?.actual?.costMinorUnits, '16');
  assert.equal((await f.store.transact('local', tx => tx.listProjections<Execution>('execution'))).length, 4);
});
