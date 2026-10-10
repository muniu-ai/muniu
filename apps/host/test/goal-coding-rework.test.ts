// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Approval, Thread } from '@mn/contracts';
import { appendKernelEvent } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, createKernelAgentTurnHandler } from '@mn/worker';
import { validateBusinessContextSource } from '../src/business-context.js';
import { assertGoalExecutionResources } from '../src/goal-runtime.js';
import { createAgentOsHost } from '../src/host.js';
import { createOpcModelContextReader } from '../src/opc-model-context.js';
import { captureCodingRepository, captureCodingTask } from '../src/product-state.js';

const originalPatch = 'diff --git a/message.txt b/message.txt\n--- a/message.txt\n+++ b/message.txt\n@@ -1 +1 @@\n-old value\n+new value\n';
const wait = () => new Promise(resolve => setTimeout(resolve, 20));

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mn-goal-coding-rework-'));
  const cas = new FileCas({ rootDir: join(directory, 'cas') });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 85));
  const store = new SqliteStorage({ databaseFile: join(directory, 'state.sqlite'), hmacKey: Buffer.alloc(32, 86) });
  const secretStore = { async save() { return 'keychain://muniu.v2/team-coding'; }, async read() { return 'fixture'; } };
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, goalPollIntervalMs: 100,
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
    budget: { maxTokens: 60000, maxCostMinorUnits: '500', currency: 'CNY', maxDurationMs: 120000 },
    deliverables: [{ key: 'code', title: '消息变更', required: true, criteria: [{ id: 'message', description: '仅将 message.txt 的 old value 改为 new value，通过检查并保留批准证据' }] }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { directory, root, store, host, cas, keyProvider, secretStore, workspace, model, send, task, thread, path: `/v2/goals/${created.body.data.goal.id}` };
}

async function pollWithApproval(f: Awaited<ReturnType<typeof fixture>>, worker: AgentOsWorker): Promise<void> {
  let done = false;
  const stop = new AbortController();
  const polling = worker.pollOnce(stop.signal).finally(() => { done = true; });
  const deadline = Date.now() + 60_000;
  while (!done && Date.now() < deadline) {
    const pending = await f.store.transact('local', tx => tx.listProjections<Approval>('approval').filter(item => item.status === 'pending'));
    for (const approval of pending) await f.host.kernel.decideApproval('local', 'local-owner', `approve:${approval.id}`, approval.id, approval.streamVersion, 'approve_once');
    await wait();
  }
  if (!done) {
    const diagnostic = await f.store.transact('local', tx => ({
      executions: tx.listProjections<any>('execution').map(item => ({ status: item.status, id: item.id })),
      approvals: tx.listProjections<any>('approval').map(item => ({ status: item.status, id: item.id })),
      runs: tx.listProjections<any>('coding.execution').map(item => ({ status: item.status, nextStep: item.result?.nextStep, resultStatus: item.result?.status })),
      runtime: tx.listProjections<any>('agent-runtime').map(item => item.records.map((record: any) => record.type)),
    }));
    stop.abort('测试超时'); await polling;
    assert.fail(`真实沙箱节点未在期限内结束：${JSON.stringify(diagnostic)}`);
  }
  const result = await polling;
  assert.notEqual(result.status, 'failed', JSON.stringify(result));
}

test('Coding 单执行者两轮返工创建新规格与证据，实际模型收到缺陷且累计修复不重置', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), prompts: { round: number; text: string }[] = [];
  let round = 0;
  const callsPerRound = [0, 0, 0], approved = new Set<string>();
  const ok = async (path: string, body?: unknown) => { const result = await f.send(path, body); assert.ok(result.status >= 200 && result.status < 300, JSON.stringify({ path, ...result })); return result.body.data; };
  const read = () => ok(`${f.path}?workspaceId=${f.workspace.id}`);
  const planned = await ok(`${f.path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: 1, modelBindingId: f.model.id });
  assert.equal(planned.plan.kind, undefined);
  await ok(`${f.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: planned.goal.streamVersion, command: 'start', planRevisionId: planned.plan.id, planDigest: planned.plan.digest });
  const worker = new AgentOsWorker({ id: 'goal-coding-rework-worker', store: f.store,
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'agent.execution.run': createKernelAgentTurnHandler({ store: f.store, secretStore: f.secretStore, approvalKernel: f.host.kernel,
      runtimeProtection: { cas: f.cas, keyProvider: f.keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store: f.store, cas: f.cas, protectedPayloadKeyProvider: f.keyProvider }),
      codingSandboxRoot: join(f.directory, 'sandboxes'), approvalPollIntervalMs: 5,
      modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '1000000000', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '1000000000' } }),
      modelInvoker: async input => {
        prompts.push({ round, text: JSON.stringify(input.request.messages) });
        callsPerRound[round] = callsPerRound[round]! + 1;
        const value = `new value${round ? ` ${round + 1}` : ''}${callsPerRound[round] === 1 ? ' ' : ''}`;
        return { text: '修正消息文案', toolCalls: [{ id: `patch-${round}-${callsPerRound[round]}`, toolId: 'coding.sandbox.write', arguments: {
          patch: originalPatch.replace('+new value\n', `+${value}\n`), summary: '仅更新消息文案' } }], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
      },
    }) } });
  const finish = async () => {
    const deadline = Date.now() + 60_000;
    let detail: any;
    while (Date.now() < deadline) {
      await pollWithApproval(f, worker);
      detail = await read();
      if (detail.goal.status === 'awaiting_acceptance') {
        const approvals = await f.store.transact('local', tx => tx.listProjections<Approval>('approval').filter(item => item.status === 'approved_once'));
        for (const approval of approvals) approved.add(approval.id);
        return detail;
      }
      assert.ok(!['failed', 'needs_reconciliation', 'cancelled', 'paused'].includes(detail.goal.status), JSON.stringify(detail));
      await wait();
    }
    const states = await f.store.transact('local', tx => ({
      attempts: tx.listProjections<any>('coordination.attempt').map(item => ({ nodeId: item.nodeId, revisionId: item.revisionId, status: item.status, reservation: item.reservation.status })),
      executions: tx.listProjections<any>('execution').map(item => ({ id: item.id, status: item.status })),
      runs: tx.listProjections<any>('coding.execution').map(item => ({ executionId: item.executionId, status: item.status, resultStatus: item.result?.status, nextStep: item.result?.nextStep })),
    }));
    assert.fail(JSON.stringify({ round, goalStatus: detail?.goal.status, reasonCode: detail?.goal.reasonCode, planId: detail?.plan.id, callsPerRound, states }));
  };
  const initial = await finish();
  const original = await f.store.transact('local', tx => ({ specs: tx.listProjections<any>('coding.spec'), task: tx.getProjection<any>('coding.task', f.task.id), gates: tx.listProjections<any>('coding.gate-result'), evidence: tx.listProjections<any>('coding.code-evidence') }));
  assert.equal(original.specs.length, 1);
  assert.equal(original.gates.filter(item => item.status === 'passed' && item.authoritative).length, 1);
  assert.equal(original.evidence.length, 1);
  assert.match(initial.deliverySet.items[0].preview, /\+new value/u);
  assert.equal(await readFile(join(f.root, 'message.txt'), 'utf8'), 'old value\n');
  let prior = initial, originalDeadline: string | undefined;
  for (round = 1; round <= 2; round++) {
    const instruction = `修正消息中的版本编号，应为 new value ${round + 1}，保持单行且没有尾随空格。`;
    const decided = await ok(`${f.path}/delivery-decisions`, { workspaceId: f.workspace.id, expectedStreamVersion: prior.goal.streamVersion,
      deliverySetId: prior.deliverySet.id, criteriaVersion: prior.goal.criteriaVersion,
      items: [{ key: 'code', digest: prior.deliverySet.items[0].digest, decision: 'request_changes', failedCriterionIds: ['message'], instruction }] });
    const preview = await ok(`${f.path}/rework-previews`, { workspaceId: f.workspace.id, expectedStreamVersion: decided.goal.streamVersion, decisionId: decided.deliveryReview.decisions.at(-1).id });
    assert.equal(preview.plan.kind, 'single-v2');
    originalDeadline ??= preview.deadlineAt;
    assert.equal(preview.deadlineAt, originalDeadline, '返工不能重置原始期限');
    assert.equal(preview.plan.nodes[0].executor.agentDefinitionId, 'coding.builtin');
    assert.equal(preview.plan.nodes[0].executor.runnerId, 'builtin');
    await ok(`${f.path}/reworks`, { workspaceId: f.workspace.id, expectedStreamVersion: decided.goal.streamVersion, previewId: preview.id, previewDigest: preview.digest });
    const next = await finish();
    assert.match(next.deliverySet.items[0].preview, new RegExp(`\\+new value ${round + 1}`));
    const current = await f.store.transact('local', tx => ({ specs: [...tx.listProjections<any>('coding.spec')].sort((a, b) => a.revision - b.revision), task: tx.getProjection<any>('coding.task', f.task.id),
      evidence: tx.listProjections<any>('coding.code-evidence'), gates: tx.listProjections<any>('coding.gate-result'), candidates: tx.listProjections<any>('coding.candidate'), groups: tx.listProjections<any>('coordination.group') }));
    assert.deepEqual(current.specs[0], original.specs[0], '首份 Spec 必须保持不可变');
    assert.equal(current.specs.length, round + 1);
    assert.equal(current.specs[round].supersedesSpecId, current.specs[round - 1].id);
    assert.ok(current.specs[round].body.includes(instruction), '新 Spec 必须包含本次缺陷要求');
    assert.ok(prompts.filter(item => item.round === round).every(item => item.text.includes(instruction)), '实际模型请求必须包含本次缺陷要求');
    assert.equal(current.task.request, original.task.request, '返工通过新 Spec 表达，不能改写原始请求');
    assert.equal(current.evidence.length, round + 1);
    assert.equal(new Set(current.evidence.map(item => item.digest)).size, round + 1);
    assert.equal(current.gates.filter(item => item.status === 'passed' && item.authoritative).length, round + 1);
    assert.ok(current.candidates.every(item => item.sandbox.enforced && !item.sandbox.fallbackUsed));
    assert.equal(current.groups.length, 1);
    const repairs = [...current.groups[0].initialAccounting.counterReservations, ...current.groups[0].counterReservations].filter(item => item.kind === 'coding_repair');
    assert.equal(repairs.length, round + 1, '原单执行者修复加新修订修复使用同一累计限额');
    assert.equal(await readFile(join(f.root, 'message.txt'), 'utf8'), 'old value\n');
    assert.notEqual(next.deliverySet.id, prior.deliverySet.id);
    assert.equal(next.goal.reservation.actual.tokens, (round + 1) * 40);
    prior = next;
  }
  assert.deepEqual(callsPerRound, [2, 2, 2]);
  assert.equal(approved.size, 3, '每轮新候选必须重新获得批准');
  const accepted = await ok(`${f.path}/delivery-decisions`, { workspaceId: f.workspace.id, expectedStreamVersion: prior.goal.streamVersion,
    deliverySetId: prior.deliverySet.id, criteriaVersion: prior.goal.criteriaVersion,
    items: [{ key: 'code', digest: prior.deliverySet.items[0].digest, decision: 'accept', reviewedCriterionIds: ['message'] }] });
  assert.equal(accepted.goal.status, 'accepted');
  assert.equal(accepted.deliveryReview.history.length, 3);
});
