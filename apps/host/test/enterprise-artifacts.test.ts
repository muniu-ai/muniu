// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseQuotaService } from '@mn/enterprise-services';
import { AgentOsWorker } from '@mn/worker';
import { fixture } from './fixtures/business.js';
import { EnterpriseOperatingService } from '../src/enterprise-operating.js';
import { EnterpriseKnowledgeService } from '../src/enterprise-knowledge.js';
import { EnterpriseGoalService } from '../src/enterprise-goals.js';
import { EnterpriseTaskRuntime } from '../src/enterprise-task-runtime.js';
import { EnterpriseExperienceService } from '../src/enterprise-experience.js';
import { EnterpriseArtifactService } from '../src/enterprise-artifacts.js';
async function setup(t: test.TestContext, knowledgeMode?: 'valid' | 'forged' | 'withdrawn') {
  const f = await fixture(t, true, true), base = await f.base(), operating = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  const knowledge = new EnterpriseKnowledgeService({ operating, protection: { cas: f.cas, keyProvider: f.keyProvider } });
  const material = knowledgeMode ? await knowledge.importDocument(f.actor('sales'), f.workspace.id, 'source', { documentId: 'source', expectedStreamVersion: 0, title: '需求来源', fileName: 'source.txt', mediaType: 'text/plain', contentBase64: Buffer.from('需求记录\n\n需求待核查。').toString('base64'), bindings: [{ reference: base.opportunity.reference, fields: ['title'] }], classification: ['public'], visibility: 'private' }) : undefined;
  const source = material?.reference ?? base.opportunity.reference;
  const quota = new EnterpriseQuotaService({ repository: f.repository, now: f.now }), limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 1000, costMinorUnits: '100', currency: 'CNY' as const, evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '10', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '1', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' };
  await quota.provision('tenant', 'platform', 0, limits); await quota.configure(f.admin, 'quota', f.workspace.id, 0, limits);
  const goals = new EnterpriseGoalService({ operating, modelsFor: () => [{ id: 'model', version: 1, providerId: 'openai', modelId: 'fixture', mode: 'test_fixture', secretRef: 'fixture://enterprise/model' }] });
  const budget = { maxTokens: 100, maxCostMinor: 10, currency: 'CNY' as const, deadline: '2026-12-01T00:00:00.000Z' }, criteria = ['有来源的商机分析'];
  const draft = await goals.create(f.actor('sales'), f.workspace.id, 'goal', { title: '分析商机', message: '提出候选', sources: [{ reference: source, fields: [material ? 'text' : 'title'] }], acceptanceCriteria: criteria, budget, capabilityIds: ['business.analyze'], modelBindingIds: ['model'] });
  const active = await goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  await goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'plan', { reason: '分析', nodes: [{ id: 'analysis', dependsOn: [], capabilityId: 'business.analyze', capabilityVersion: '1', modelBindingId: 'model', inputRefs: [source], budget: { ...budget, maxTokens: 10, maxCostMinor: 1 }, acceptanceCriteria: criteria, effect: 'read' }] });
  const runtime = new EnterpriseTaskRuntime({ goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { return 'fixture-key'; } }, quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }), invoke: async ({ request }) => {
    const input = JSON.parse(request.messages.find(m => m.role === 'user')!.content!);
    const citations = material ? input.sources[0].fields.citations.map((c: any) => knowledgeMode === 'forged' ? { ...c, locator: { page: 999 } } : c) : undefined;
    if (knowledgeMode === 'withdrawn') await knowledge.withdraw(f.actor('sales'), f.workspace.id, 'source', 1, 'withdraw-during-model');
    return { text: JSON.stringify({ status: 'complete', summary: '商机建议', findings: [{ text: '建议核查需求', sources: [source], ...(citations ? { citations } : {}) }], acceptance: criteria.map(criterion => ({ criterion, status: 'satisfied', sources: [source], ...(citations ? { citations } : {}) })), unknown: [] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } };
  } });
  const worker = new AgentOsWorker({ id: 'worker', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  await worker.pollOnce(); const goal = knowledgeMode === 'withdrawn' ? draft : await goals.get(f.actor('sales'), draft.id);
  const artifacts = new EnterpriseArtifactService({ goals, knowledge });
  return { ...f, base, goals, goal, knowledge, operating, artifacts, criteria };
}

test('模型成果先固定为候选，人员按完整验收条件确认后才完成工作', async t => {
  const f = await setup(t), artifact = await f.artifacts.freeze(f.actor('sales'), f.goal.id, f.goal.attempts[0]!.id, 'freeze');
  assert.equal(artifact.status, 'candidate'); assert.equal((await f.goals.get(f.actor('sales'), f.goal.id)).status, 'awaiting_acceptance');
  await assert.rejects(f.artifacts.accept(f.actor('sales'), artifact.id, artifact.streamVersion, f.goal.streamVersion, [], '漏项', 'bad'), { code: 'ACCEPTANCE_CRITERIA_REQUIRED' });
  const accepted = await f.artifacts.accept(f.actor('sales'), artifact.id, artifact.streamVersion, f.goal.streamVersion, f.criteria, '已核对来源和内容', 'accept');
  assert.equal(accepted.status, 'accepted'); assert.equal((await f.goals.get(f.actor('sales'), f.goal.id)).status, 'completed');
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('enterprise-artifact.decision').length), 1);
});
test('成果和确认不会改变业务事实，撤权后不能读取或验收原结果', async t => {
  const f = await setup(t), artifact = await f.artifacts.freeze(f.actor('sales'), f.goal.id, f.goal.attempts[0]!.id, 'freeze');
  assert.equal((await f.get('opportunity', 'opportunity')).reference.streamVersion, 1);
  await f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1);
  await assert.rejects(f.artifacts.get(f.actor('sales'), artifact.id), { code: 'OBJECT_ACCESS_DENIED' });
  await assert.rejects(f.artifacts.accept(f.actor('sales'), artifact.id, artifact.streamVersion, f.goal.streamVersion, f.criteria, '不能批准', 'denied'), { code: 'OBJECT_ACCESS_DENIED' });
});


test('候选经验须管理员明确启用，不能提升为业务事实，原来源撤回后停止检索和使用', async t => {
  const f = await setup(t), artifact = await f.artifacts.freeze(f.actor('sales'), f.goal.id, f.goal.attempts[0]!.id, 'freeze');
  await f.artifacts.accept(f.actor('sales'), artifact.id, artifact.streamVersion, f.goal.streamVersion, f.criteria, '已核对', 'accept');
  const knowledgeState = await f.knowledge.controlState(f.actor('sales'), f.workspace.id, 'artifact:' + artifact.attemptId);
  await f.knowledge.share(f.actor('sales'), artifact.reference, knowledgeState.streamVersion, true, 'share-source');
  const experiences = new EnterpriseExperienceService({ artifacts: f.artifacts, knowledge: f.knowledge });
  const candidate = await experiences.propose(f.actor('sales'), artifact.id, 'proposal', { id: 'lesson', title: '需求核查经验', text: '核查需求时引用原始资料，并保留不确定性。' });
  assert.equal(candidate.status, 'proposed'); assert.equal((await f.knowledge.search(f.actor('sales'), f.workspace.id, '保留不确定性')).hits.length, 0);
  await assert.rejects(experiences.enable(f.actor('manager'), candidate.id, candidate.streamVersion, candidate.reference.digest, 'manager-enable'), { code: 'ORGANIZATION_ADMIN_REQUIRED' });
  await assert.rejects(experiences.enable(f.admin, candidate.id, candidate.streamVersion, candidate.reference.digest, 'admin-without-data'), { code: 'OBJECT_ACCESS_DENIED' });
  await f.permissions.grantRole(f.admin, 'admin-reader', { id: 'admin-reader', workspaceId: f.workspace.id, principalId: 'admin', role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z' });
  const enabled = await experiences.enable(f.admin, candidate.id, candidate.streamVersion, candidate.reference.digest, 'enable');
  assert.equal(enabled.status, 'enabled'); assert.equal((await f.knowledge.search(f.actor('sales'), f.workspace.id, '保留不确定性')).hits.length, 1);
  await assert.rejects(experiences.enable(f.admin, candidate.id, candidate.streamVersion, candidate.reference.digest, 'stale-enable'), { code: 'STREAM_VERSION_CONFLICT' });
  const disabled = await experiences.disable(f.admin, enabled.id, enabled.streamVersion, enabled.reference.digest, 'disable');
  assert.equal((await f.knowledge.search(f.actor('sales'), f.workspace.id, '保留不确定性')).hits.length, 0);
  await assert.rejects(f.operating.readSource(f.actor('sales'), candidate.reference, ['text']), { code: 'EXPERIENCE_NOT_ENABLED' });
  const restored = await experiences.enable(f.admin, disabled.id, disabled.streamVersion, disabled.reference.digest, 'restore');
  assert.deepEqual(restored.reference, candidate.reference);
  const state = await f.knowledge.controlState(f.actor('sales'), f.workspace.id, 'artifact:' + artifact.attemptId);
  await f.knowledge.withdraw(f.actor('sales'), f.workspace.id, 'artifact:' + artifact.attemptId, state.streamVersion, 'withdraw-origin');
  assert.equal((await f.knowledge.search(f.actor('sales'), f.workspace.id, '保留不确定性')).hits.length, 0);
});

test('成果固定使用幂等键绑定请求，重复请求不增加版本，换请求不能沿用旧键', async t => {
  const f = await setup(t), attemptId = f.goal.attempts[0]!.id;
  await assert.rejects(f.artifacts.freeze(f.actor('sales'), f.goal.id, attemptId, ''), { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  const first = await f.artifacts.freeze(f.actor('sales'), f.goal.id, attemptId, 'freeze');
  assert.deepEqual(await f.artifacts.freeze(f.actor('sales'), f.goal.id, attemptId, 'freeze'), first);
  await assert.rejects(f.artifacts.freeze(f.actor('sales'), f.goal.id, 'different', 'freeze'), { code: 'IDEMPOTENCY_KEY_REUSED' });
});
test('人员决定保留批准人、条件与成果版本，未验收候选不能生成决定来源', async t => {
  const f = await setup(t), artifact = await f.artifacts.freeze(f.actor('sales'), f.goal.id, f.goal.attempts[0]!.id, 'freeze');
  await assert.rejects(f.artifacts.decision(f.actor('sales'), artifact.id, 'before'), { code: 'ACCEPTED_ARTIFACT_REQUIRED' });
  await f.artifacts.accept(f.actor('sales'), artifact.id, artifact.streamVersion, f.goal.streamVersion, f.criteria, '已核对原始出处', 'accept');
  const decision = await f.artifacts.decision(f.actor('sales'), artifact.id, 'decision');
  assert.equal(decision.sourceKind, 'human_decision');
  assert.match(decision.extraction.blocks.map(b => b.text).join('\n'), /已核对原始出处/);
  assert.doesNotMatch(decision.extraction.blocks.map(b => b.text).join('\n'), /tenantId|artifactReference|\"digest\"/);
  await f.permissions.revoke(f.admin, 'revoke-decision-source', 'role', 'sales-own', 1);
  await assert.rejects(f.knowledge.get(f.actor('sales'), decision.reference), { code: 'OBJECT_ACCESS_DENIED' });
});

test('真实 Worker 保存资料引用并固定成果，伪造定位的模型响应不能形成完成结果', async t => {
  const valid = await setup(t, 'valid');
  assert.equal(valid.goal.status, 'awaiting_acceptance');
  const result = await valid.goals.result(valid.actor('sales'), valid.goal.id, valid.goal.attempts[0]!.id);
  assert.equal(result.kind, 'task'); if (result.kind !== 'task') throw new Error('unexpected');
  assert.ok(result.content.findings[0]!.citations!.length > 0);
  const artifact = await valid.artifacts.freeze(valid.actor('sales'), valid.goal.id, valid.goal.attempts[0]!.id, 'freeze-citations');
  const text = (await valid.knowledge.get(valid.actor('sales'), artifact.reference)).extraction.blocks.map(b => b.text).join('\n');
  assert.match(text, /需求来源/); assert.match(text, /第[12]段/); assert.doesNotMatch(text, /permissionRef|protectedContentRef|\"digest\"/);
  const forged = await setup(t, 'forged');
  assert.equal(forged.goal.attempts[0]!.status, 'failed');
  assert.equal(forged.goal.attempts[0]!.reasonCode, 'TASK_CITATION_INVALID');
  await assert.rejects(forged.artifacts.freeze(forged.actor('sales'), forged.goal.id, forged.goal.attempts[0]!.id, 'no-artifact'));
});

test('模型在途时撤回来源，已知费用结算但不保存成果或派发后继任务', async t => {
  const f = await setup(t, 'withdrawn');
  const state = await f.store.transact('tenant', tx => {
    const attempt = f.goals.attempts(tx, f.goal.id)[0]!;
    return { attempt, reservation: tx.getProjection<{ status: string; usage?: { tokens: number } }>('budget.reservation', attempt.reservationId), result: tx.getProjection('enterprise-work.result', attempt.id) };
  });
  assert.equal(state.attempt.status, 'failed'); assert.equal(state.result, undefined);
  assert.equal(state.reservation!.status, 'settled'); assert.equal(state.reservation!.usage!.tokens, 3);
  await assert.rejects(f.goals.get(f.actor('sales'), f.goal.id), { code: 'KNOWLEDGE_SOURCE_WITHDRAWN' });
});
