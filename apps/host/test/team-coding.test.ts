// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Approval, CoordinationAttemptV2, Execution, ExecutionAuthority, Thread } from '@mn/contracts';
import { appendKernelEvent } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, createKernelAgentTurnHandler } from '@mn/worker';
import { validateBusinessContextSource } from '../src/business-context.js';
import { assertGoalExecutionResources } from '../src/goal-runtime.js';
import { createAgentOsHost } from '../src/host.js';
import { createOpcModelContextReader } from '../src/opc-model-context.js';
import { captureCodingRepository, captureCodingTask } from '../src/product-state.js';

const patch = 'diff --git a/message.txt b/message.txt\n--- a/message.txt\n+++ b/message.txt\n@@ -1 +1 @@\n-old value\n+new value\n';
const wait = () => new Promise(resolve => setTimeout(resolve, 10));

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mn-team-coding-'));
  const cas = new FileCas({ rootDir: join(directory, 'cas') });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 85));
  const store = new SqliteStorage({ databaseFile: join(directory, 'state.sqlite'), hmacKey: Buffer.alloc(32, 86) });
  const secretStore = { async save() { return 'keychain://muniu.v2/team-coding'; }, async read() { return 'fixture'; } };
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, goalPollIntervalMs: 10,
    agentRuntimeReadiness: () => ({ worker: 'available', sandbox: 'available' }) });
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: '代码团队验收', viewMode: 'professional', pluginIds: ['opc', 'coding'] });
  const model = await host.kernel.saveModelConnection('local', 'local-owner', randomUUID(), { presetId: 'deepseek', displayName: '测试模型',
    secretRef: 'keychain://muniu.v2/team-coding', defaultModel: 'deepseek-v4-flash', discoveredModels: ['deepseek-v4-flash'] });
  await store.transact('local', tx => {
    tx.putProjection('modelConnection', model.id, { ...model, status: 'ready', streamVersion: 2 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: model.id, expectedStreamVersion: 1,
      type: 'fixture.model_ready', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const root = join(directory, 'repository');
  await mkdir(root); await writeFile(join(root, 'message.txt'), 'old value\n');
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']]) execFileSync('git', args, { cwd: root });
  const mutation = { store, tenantId: 'local', workspaceId: workspace.id, actorId: 'local-owner', now: () => new Date().toISOString(),
    id: (kind: string) => `${kind}-${randomUUID()}`, expectedStreamVersion: 0 };
  const repository = await captureCodingRepository({ ...mutation, idempotencyKey: 'repository', input: await realpath(root) });
  const task = await captureCodingTask({ ...mutation, idempotencyKey: 'task', repositoryId: repository.id, input: '将 message.txt 中的 old value 改为 new value' });
  const thread = (await store.transact('local', tx => tx.listProjections<Thread>('thread').find(item => item.resourceRef?.resourceId === task.id)))!;
  const send = async (path: string, body?: unknown) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() as any };
  };
  const created = await send(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: '只更新 message.txt 的消息并完成检查', resourceRefs: [],
    budget: { maxTokens: 20000, maxCostMinorUnits: '500', currency: 'CNY', maxDurationMs: 60000 },
    deliverables: [{ key: 'code', title: '消息变更', required: true, criteria: [{ id: 'message', description: '仅将 message.txt 的 old value 改为 new value，通过检查并保留批准证据' }] }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { directory, root, store, host, cas, keyProvider, secretStore, workspace, model, send, path: `/v2/goals/${created.body.data.goal.id}` };
}

async function pollWithApproval(f: Awaited<ReturnType<typeof fixture>>, worker: AgentOsWorker): Promise<void> {
  let done = false;
  const polling = worker.pollOnce().finally(() => { done = true; });
  const deadline = Date.now() + 15_000;
  while (!done && Date.now() < deadline) {
    const pending = await f.store.transact('local', tx => tx.listProjections<Approval>('approval').filter(item => item.status === 'pending'));
    for (const approval of pending) await f.host.kernel.decideApproval('local', 'local-owner', `approve:${approval.id}`, approval.id, approval.streamVersion, 'approve_once');
    await wait();
  }
  assert.ok(done, '真实沙箱节点未在期限内结束');
  const result = await polling;
  assert.notEqual(result.status, 'failed', JSON.stringify(result));
}

test('代码团队经过真实沙箱、人工批准与只读复核，验收重新拒绝已改变的候选和 Gate', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), reviewerPrompts: string[] = [];
  const catalog = await f.send(`/v2/workspaces/${f.workspace.id}/team-templates`);
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.data.find((item: any) => item.id === 'code-delivery').available, true);
  const planned = await f.send(`${f.path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: 1,
    kind: 'team-v1', templateId: 'code-delivery', templateVersion: '1', modelBindingId: f.model.id });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const plan = planned.body.data.plan;
  assert.equal(plan.nodes.find((node: any) => node.id === 'delivery').executor.agentDefinitionId, 'coding.builtin');
  assert.equal(plan.nodes.find((node: any) => node.id === 'review').executor.agentDefinitionId, 'opc.business-assistant');
  const started = await f.send(`${f.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion,
    command: 'start', planRevisionId: plan.id, planDigest: plan.digest });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const worker = new AgentOsWorker({ id: 'team-coding-worker', store: f.store,
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'agent.execution.run': createKernelAgentTurnHandler({ store: f.store, secretStore: f.secretStore, approvalKernel: f.host.kernel,
      runtimeProtection: { cas: f.cas, keyProvider: f.keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store: f.store, cas: f.cas, protectedPayloadKeyProvider: f.keyProvider }),
      codingSandboxRoot: join(f.directory, 'sandboxes'), approvalPollIntervalMs: 5,
      modelQuoter: async () => ({ inputTokenLimit: 2000, maxOutputTokens: 500, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '0', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '0' } }),
      modelInvoker: async input => {
        const prompt = JSON.stringify(input.request.messages);
        if (prompt.includes('当前职责：独立复核')) {
          reviewerPrompts.push(prompt);
          return { text: JSON.stringify({ decision: 'pass', findings: [] }), toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
        }
        return { text: '更新消息文案', toolCalls: [{ id: 'patch', toolId: 'coding.sandbox.write', arguments: { patch, summary: '仅更新消息文案' } }],
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
      },
    }) } });
  const deadline = Date.now() + 30_000;
  let detail: any;
  while (Date.now() < deadline) {
    await pollWithApproval(f, worker);
    const latest = await f.send(`${f.path}?workspaceId=${f.workspace.id}`);
    assert.equal(latest.status, 200, JSON.stringify(latest.body));
    detail = latest.body.data;
    if (detail.goal.status === 'awaiting_acceptance') break;
    assert.notEqual(detail.goal.status, 'failed', JSON.stringify(detail.goal));
    await wait();
  }
  assert.equal(detail?.goal.status, 'awaiting_acceptance', JSON.stringify(detail?.goal));
  assert.match(detail.deliverySet.items[0].preview, /\+new value/u);
  assert.equal(await readFile(join(f.root, 'message.txt'), 'utf8'), 'old value\n');
  assert.equal(reviewerPrompts.length, 1);
  assert.match(reviewerPrompts[0]!, /coding.authoritative-evidence/u);
  assert.match(reviewerPrompts[0]!, /\+new value/u);
  const evidence = await f.store.transact('local', tx => {
    const attempts = tx.listProjections<CoordinationAttemptV2>('coordination.attempt');
    const review = attempts.find(item => item.nodeId === 'review')!;
    const execution = tx.getProjection<Execution>('execution', review.executionId)!;
    return { attempts, authority: tx.getProjection<ExecutionAuthority>('authority', execution.authorityId)!,
      reviewThread: tx.getProjection<Thread>('thread', review.threadId)!, candidate: tx.listProjections<any>('coding.candidate')[0],
      gate: tx.listProjections<any>('coding.gate-result')[0] };
  });
  assert.equal(evidence.attempts.length, 2);
  assert.equal(new Set(evidence.attempts.map(item => item.threadId)).size, 2);
  assert.equal(evidence.reviewThread.resourceRef, undefined);
  assert.deepEqual(evidence.authority.toolIds, []);
  assert.deepEqual(evidence.authority.dataScopes, []);
  assert.equal(evidence.candidate.sandbox.enforced, true);
  assert.equal(evidence.candidate.sandbox.fallbackUsed, false);
  assert.equal(evidence.gate.status, 'passed');
  assert.equal(evidence.gate.authoritative, true);
  const acceptance = { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, deliverySetId: detail.deliverySet.id,
    criteriaVersion: detail.goal.criteriaVersion, items: [{ key: 'code', digest: detail.deliverySet.items[0].digest, reviewedCriterionIds: ['message'] }] };
  for (const [namespace, original, changed] of [
    ['coding.candidate', evidence.candidate, { ...evidence.candidate, diff: `${evidence.candidate.diff}tampered` }],
    ['coding.gate-result', evidence.gate, { ...evidence.gate, status: 'failed', authoritative: false }],
  ] as const) {
    const resourceId = namespace === 'coding.gate-result' ? original.candidateId : original.id;
    const replace = async (value: unknown, version: number) => f.store.transact('local', tx => {
      tx.putProjection(namespace, resourceId, value);
      appendKernelEvent(tx, { tenantId: 'local', aggregateType: `fixture.${namespace}`, aggregateId: resourceId, expectedStreamVersion: version,
        type: version === 0 ? 'fixture.tampered' : 'fixture.restored', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
    });
    await replace(changed, 0);
    const rejected = await f.send(`${f.path}/acceptances`, acceptance);
    assert.ok(rejected.status >= 400, `${namespace} 已改变，不能沿用固定成果通过验收：${JSON.stringify({ status: rejected.status, code: rejected.body.code, goalStatus: rejected.body.data?.goal.status })}`);
    assert.equal(rejected.body.code, 'GOAL_EVIDENCE_INVALID');
    const hidden = await f.send(`${f.path}?workspaceId=${f.workspace.id}`);
    assert.ok(hidden.status >= 400, `${namespace} 已改变，公开读取必须重新核验`);
    await replace(original, 1);
  }
  const accepted = await f.send(`${f.path}/acceptances`, acceptance);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.goal.status, 'accepted');
  assert.equal((await f.store.transact('local', tx => tx.listProjections('coordination.attempt'))).length, 2);
});
