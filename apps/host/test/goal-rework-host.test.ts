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

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mn-rework-host-'));
  let store = new SqliteStorage({ databaseFile: join(directory, 'state.sqlite'), hmacKey: Buffer.alloc(32, 61) });
  const cas = new FileCas({ rootDir: join(directory, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 62));
  const secretStore = { async save() { return 'keychain://muniu.v2/rework'; }, async read() { return 'fixture'; } };
  const options = () => ({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, goalPollIntervalMs: 10 });
  let host = await createAgentOsHost(options());
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: '返工恢复', viewMode: 'business', pluginIds: ['opc'] });
  const model = await host.kernel.saveModelConnection('local', 'local-owner', randomUUID(), { presetId: 'deepseek', displayName: '合成模型', secretRef: 'keychain://muniu.v2/rework', defaultModel: 'deepseek-v4-flash', discoveredModels: ['deepseek-v4-flash'] });
  await store.transact('local', tx => { tx.putProjection('modelConnection', model.id, { ...model, status: 'ready', streamVersion: 2 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: model.id, expectedStreamVersion: 1, type: 'fixture.ready', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  const send = async (path: string, body?: unknown, key: string = randomUUID()) => { const result = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) })); return { status: result.status, body: await result.json() as any }; };
  const ok = async (path: string, body?: unknown, key?: string) => { const result = await send(path, body, key); assert.ok(result.status >= 200 && result.status < 300, JSON.stringify({ path, ...result })); return result.body.data; };
  let round = 0, rejectedReview = false, malformed = false;
  const calls: string[] = [];
  const worker = () => new AgentOsWorker({ id: 'rework-worker', store, lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: {
    'agent.execution.run': createKernelAgentTurnHandler({ store, approvalKernel: host.kernel, secretStore, runtimeProtection: { cas, keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store, cas, protectedPayloadKeyProvider: keyProvider }), codingSandboxRoot: join(directory, 'sandboxes'),
      modelInvoker: async ({ request }) => {
        const message = request.messages.map(item => item.content).join('\n');
        const role = /当前职责：([^\n]+)/u.exec(message)?.[1] ?? 'single'; calls.push(role);
        const text = role === '独立复核' ? JSON.stringify({ decision: rejectedReview ? 'needs_revision' : 'pass', findings: rejectedReview ? ['第二项缺少结论'] : [] })
          : ['主要方向取证', '反证取证'].includes(role) ? '合成证据：来源明确，仍需用户确认。'
          : malformed ? '格式不完整的多成果' : JSON.stringify({ format: 'muniu.goal-delivery.v1', items: (round ? ['two'] : ['one', 'two']).map(key => ({ key, text: `${key} 内容修订 ${round}`, proposals: [] })) });
        return { text, toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
      },
      modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '1000000000', cachedInputNanoMinorUnitsPerToken: '1000000000', outputNanoMinorUnitsPerToken: '1000000000' } }),
    }),
  } });
  const read = (path: string) => ok(`${path}?workspaceId=${workspace.id}`);
  const finish = async (path: string, expected = 'awaiting_acceptance', noSet = false) => {
    let current: any;
    for (const deadline = Date.now() + 25000; Date.now() < deadline;) {
      await worker().pollOnce(); current = await read(path);
      if (current.goal.status === expected && (noSet || current.deliverySet)) return current;
      assert.ok(!['cancelled', 'needs_reconciliation', ...(expected === 'failed' ? [] : ['failed'])].includes(current.goal.status), JSON.stringify(current));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(JSON.stringify({ current, calls }));
  };
  const start = async (team: boolean) => {
    const thread = await host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: workspace.id, subject: '保留通过项并修改缺陷', pluginId: 'opc' });
    const created = await ok(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: '生成两项可分别验收的内容', resourceRefs: [], budget: { maxTokens: 60000, maxCostMinorUnits: '1000', currency: 'CNY', maxDurationMs: 120000 },
      deliverables: ['one', 'two'].map(key => ({ key, title: key, required: true, criteria: [{ id: 'complete', description: '内容完整' }] })) });
    const path = `/v2/goals/${created.goal.id}`;
    const planned = await ok(`${path}/plan-revisions`, { workspaceId: workspace.id, expectedStreamVersion: created.goal.streamVersion, modelBindingId: model.id, ...(team ? { kind: 'team-v1', templateId: 'research-summary', templateVersion: '1' } : {}) });
    await ok(`${path}/commands`, { workspaceId: workspace.id, expectedStreamVersion: planned.goal.streamVersion, command: 'start', planRevisionId: planned.plan.id, planDigest: planned.plan.digest });
    return path;
  };
  const requestChanges = async (path: string, acceptFirst = true) => {
    const detail = await read(path);
    return ok(`${path}/delivery-decisions`, { workspaceId: workspace.id, expectedStreamVersion: detail.goal.streamVersion, deliverySetId: detail.deliverySet.id, criteriaVersion: detail.goal.criteriaVersion,
      items: detail.deliverySet.items.map((item: any) => item.key === 'one' && acceptFirst ? { key: item.key, digest: item.digest, decision: 'accept', reviewedCriterionIds: ['complete'] }
        : item.key === 'one' ? { key: item.key, digest: item.digest, decision: 'defer' }
        : { key: item.key, digest: item.digest, decision: 'request_changes', failedCriterionIds: ['complete'], instruction: '仅补充第二项的结论' }) });
  };
  const rework = async (path: string, restart = false) => {
    const decided = await requestChanges(path), decision = decided.deliveryReview.decisions.at(-1);
    const preview = await ok(`${path}/rework-previews`, { workspaceId: workspace.id, expectedStreamVersion: decided.goal.streamVersion, decisionId: decision.id });
    round++;
    const input = { workspaceId: workspace.id, expectedStreamVersion: decided.goal.streamVersion, previewId: preview.id, previewDigest: preview.digest }, key = randomUUID();
    const result = await ok(`${path}/reworks`, input, key);
    assert.deepEqual(await ok(`${path}/reworks`, input, key), result);
    if (restart) { await host.close(); store = new SqliteStorage({ databaseFile: join(directory, 'state.sqlite'), hmacKey: Buffer.alloc(32, 61) }); host = await createAgentOsHost(options()); await store.rebuildProjections('local'); }
    return { preview, result, ready: await finish(path) };
  };
  return { store, workspace, calls, ok, send, read, start, finish, requestChanges, rework, rejectReview(value: boolean) { rejectedReview = value; }, malformedOutput() { malformed = true; } };
}

for (const team of [false, true]) test(`${team ? '团队' : '单执行者'}两轮真实返工保留成果、累计预算并从事件恢复`, async t => {
  const f = await fixture(t), path = await f.start(team), initial = await f.finish(path), retained = initial.deliverySet.items.find((item: any) => item.key === 'one');
  const first = await f.rework(path, true);
  assert.equal(first.preview.plan.kind, team ? 'team-v1' : 'single-v2');
  assert.deepEqual(first.ready.deliverySet.items.find((item: any) => item.key === 'one'), retained);
  assert.equal(first.ready.deliverySet.items.find((item: any) => item.key === 'two').preview, 'two 内容修订 1');
  assert.equal(first.ready.deliveryReview.history.length, 2);
  assert.ok(first.ready.goal.reservation.actual.tokens > initial.goal.reservation.actual.tokens);
  const second = await f.rework(path);
  assert.equal(second.preview.deadlineAt, first.preview.deadlineAt);
  assert.deepEqual(second.ready.deliverySet.items.find((item: any) => item.key === 'one'), retained);
  assert.equal(second.ready.deliverySet.items.find((item: any) => item.key === 'two').preview, 'two 内容修订 2');
  assert.equal(f.calls.length, team ? 8 : 3, JSON.stringify(f.calls));
  assert.equal(second.ready.goal.reservation.actual.costMinorUnits, String(f.calls.length * 20));
  const decision = await f.requestChanges(path), denied = await f.send(`${path}/rework-previews`, { workspaceId: f.workspace.id, expectedStreamVersion: decision.goal.streamVersion, decisionId: decision.deliveryReview.decisions.at(-1).id });
  assert.equal(denied.body.code, 'GOAL_REWORK_LIMIT');
});

test('独立复核拒绝仍提供原成果和问题证据，不能将其接收为通过', async t => {
  const f = await fixture(t); f.rejectReview(true);
  const path = await f.start(true), result = await f.finish(path, 'failed');
  assert.equal(result.goal.reasonCode, 'GOAL_REVIEW_REJECTED');
  assert.ok(result.deliverySet.items.every((item: any) => item.checks.some((check: any) => check.status === 'failed')));
  const rejected = await f.send(`${path}/delivery-decisions`, { workspaceId: f.workspace.id, expectedStreamVersion: result.goal.streamVersion, deliverySetId: result.deliverySet.id, criteriaVersion: result.goal.criteriaVersion,
    items: [{ key: 'one', digest: result.deliverySet.items[0].digest, decision: 'accept', reviewedCriterionIds: ['complete'] }] });
  assert.ok(rejected.status >= 400);
  assert.equal((await f.requestChanges(path, false)).goal.status, 'failed');
});

for (const team of [false, true]) test(`${team ? '团队' : '单执行者'}多成果格式错误固定为失败并结算用量`, async t => {
  const f = await fixture(t); f.malformedOutput();
  const path = await f.start(team), result = await f.finish(path, 'failed', true);
  assert.equal(result.goal.reasonCode, 'GOAL_OUTPUT_INVALID');
  assert.equal(result.deliverySet, null);
  assert.equal(result.goal.reservation.status, 'settled');
  assert.equal(result.goal.reservation.actual.costMinorUnits, String(f.calls.length * 20));
});
