// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsWorker } from '@mn/worker';
import { EnterpriseQuotaService } from '@mn/enterprise-services';
import { BUSINESS_WORKFLOWS } from '@mn/plugin-business';
import { fixture } from './fixtures/business.js';
import { EnterpriseOperatingService } from '../src/enterprise-operating.js';
import { EnterpriseWorkflowService } from '../src/enterprise-workflows.js';
import { EnterpriseGoalService } from '../src/enterprise-goals.js';
import { EnterpriseTaskRuntime } from '../src/enterprise-task-runtime.js';
import { EnterpriseKnowledgeService } from '../src/enterprise-knowledge.js';
import { EnterpriseArtifactService } from '../src/enterprise-artifacts.js';
test('五套流程使用同一持久 Worker、额度和人工成果验收，建议不改写已确认业务事实', async t => {
  for (const definition of BUSINESS_WORKFLOWS) await t.test(definition.flowId, async t => {
    const f = await fixture(t, true, true), order = await f.order();
    const project = await f.command({ type: 'project.create', id: 'project', order: order.reference, title: '交付项目' }, 'project');
    const schedule = await f.command({ type: 'payment_schedule.create', id: 'schedule', order: order.reference, amountMinor: 30000, dueDate: '2026-11-02' }, 'finance-a');
    const review = await f.command({ type: 'business_review.snapshot', id: 'review', order: order.reference, periodStart: '2026-11-01', periodEnd: '2026-11-02', includeCosts: false }, 'finance-b');
    const source = definition.flowId === 'opportunity' ? await f.get('opportunity', 'opportunity', 'manager') : definition.flowId === 'quote' ? await f.get('quote_version', 'quote', 'manager') : definition.flowId === 'delivery' ? project : definition.flowId === 'receivable' ? schedule : review;
    const owner = f.actor(definition.flowId === 'delivery' ? 'project' : definition.flowId === 'receivable' ? 'finance-a' : definition.flowId === 'review' ? 'finance-b' : 'manager');
    const field = ({ opportunity: 'title', quote: 'totalMinor', delivery: 'title', receivable: 'amountMinor', review: 'financialMetrics' } as const)[definition.flowId];
    const operating = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now }), workflows = new EnterpriseWorkflowService({ operating });
    const published = await workflows.publish(f.admin, f.workspace.id, 0, definition, 'publish'); await workflows.select(f.admin, f.workspace.id, definition.flowId, 1, published.versions[0]!, 'select');
    const quota = new EnterpriseQuotaService({ repository: f.repository, now: f.now }), limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 1000, costMinorUnits: '100', currency: 'CNY' as const, evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '10', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '1', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' };
    await quota.provision('tenant', 'platform', 0, limits); await quota.configure(f.admin, 'quota', f.workspace.id, 0, limits);
    const goals = new EnterpriseGoalService({ operating, modelsFor: () => [{ id: 'model', version: 1, providerId: 'openai', modelId: 'fixture', mode: 'test_fixture', secretRef: 'fixture://enterprise/model' }] });
    const budget = { maxTokens: 100, maxCostMinor: 10, currency: 'CNY' as const, deadline: '2026-12-01T00:00:00.000Z' };
    let goal = await goals.create(owner, f.workspace.id, 'goal', { workflow: published.versions[0], title: definition.title, message: '复核来源并提出候选', sources: [{ reference: source.reference, fields: [field] }], acceptanceCriteria: definition.acceptanceCriteria, budget, capabilityIds: ['business.analyze'], modelBindingIds: ['model'] });
    goal = await goals.authorize(owner, goal.id, goal.streamVersion, goal.scopeDigest, 'authorize');
    await goals.plan(owner, goal.id, goal.streamVersion, 'plan', { reason: '只读核查', nodes: [{ id: 'analysis', dependsOn: [], capabilityId: 'business.analyze', capabilityVersion: '1', modelBindingId: 'model', inputRefs: [source.reference], budget: { ...budget, maxTokens: 10, maxCostMinor: 1 }, acceptanceCriteria: definition.acceptanceCriteria, effect: 'read' }] });
    const runtime = new EnterpriseTaskRuntime({ goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { return 'synthetic-only'; } }, quote: async () => ({ inputTokenLimit: 4, maxOutputTokens: 6, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '100000000', cachedInputNanoMinorUnitsPerToken: '100000000', outputNanoMinorUnitsPerToken: '100000000' } }), invoke: async ({ request }) => {
      const input = JSON.parse(request.messages.find(m => m.role === 'user')!.content!);
      assert.equal(input.workflow.flowId, definition.flowId); assert.deepEqual(input.sources[0].fields[field], source.values[field]);
      if (['quote', 'receivable'].includes(definition.flowId)) assert.equal(input.sources[0].fields[field], 30000);
      return { text: JSON.stringify({ status: 'complete', summary: '合成候选', findings: [{ text: '待人员核对', sources: [source.reference] }], acceptance: definition.acceptanceCriteria.map(criterion => ({ criterion, status: 'satisfied', sources: [source.reference] })), unknown: [] }), toolCalls: [], usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } };
    } });
    const worker = new AgentOsWorker({ id: 'workflow-worker', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
    assert.equal((await worker.pollOnce()).status, 'completed'); goal = await goals.get(owner, goal.id);
    const knowledge = new EnterpriseKnowledgeService({ operating, protection: { cas: f.cas, keyProvider: f.keyProvider } }), artifacts = new EnterpriseArtifactService({ goals, knowledge });
    const artifact = await artifacts.freeze(owner, goal.id, goal.attempts[0]!.id, 'freeze');
    await artifacts.accept(owner, artifact.id, artifact.streamVersion, goal.streamVersion, definition.acceptanceCriteria, '已核对合成数据', 'accept');
    assert.equal((await goals.get(owner, goal.id)).status, 'completed');
    assert.deepEqual((await f.get(source.reference.objectType, source.reference.objectId, owner.principalId)).values, source.values);
  });
});
