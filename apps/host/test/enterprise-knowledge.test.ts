// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/business.js';
import { EnterpriseOperatingService } from '../src/enterprise-operating.js';
import { extractDocument } from '../src/document-extraction.js';
import { EnterpriseKnowledgeService } from '../src/enterprise-knowledge.js';
async function setup(t: test.TestContext) {
  const f = await fixture(t, true, true), base = await f.base();
  const operating = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  const knowledge = new EnterpriseKnowledgeService({ operating, protection: { cas: f.cas, keyProvider: f.keyProvider } });
  const input = { documentId: 'requirements', expectedStreamVersion: 0, title: '客户需求', fileName: 'requirements.md', mediaType: 'text/markdown', contentBase64: Buffer.from('项目需求\n\n机密价格为 30000 分。\n\n验收报告需包含交付清单。').toString('base64'), bindings: [{ reference: base.quote.reference, fields: ['totalMinor'] }], classification: ['price'] as const, visibility: 'business_scope' as const };
  return { ...f, base, operating, knowledge, input };
}
test('权限过滤先于检索与计数，不能通过标题、摘要或金额字段泄露资料', async t => {
  const f = await setup(t), material = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'import', f.input);
  assert.equal(material.revision, 1); assert.equal(material.extraction.status, 'complete');
  assert.deepEqual(material.sources, f.input.bindings);
  const own = await f.knowledge.search(f.actor('sales'), f.workspace.id, '机密价格'); assert.equal(own.hits.length, 1);
  assert.ok('paragraph' in own.hits[0]!.citation.locator); assert.equal(own.hits[0]!.citation.locator.paragraph, '2'); assert.match(own.hits[0]!.text, /30000/);
  assert.deepEqual((await f.knowledge.search(f.actor('viewer'), f.workspace.id, '机密价格')).hits, []);
  await assert.rejects(f.knowledge.get(f.actor('viewer'), material.reference), { code: 'FIELD_ACCESS_DENIED' });
  await assert.rejects(f.knowledge.get({ ...f.actor('sales'), tenantId: 'other' }, material.reference));
});
test('资料版本不可变，引用精确定位原文，来源撤回阻止旧引用与后续传播', async t => {
  const f = await setup(t), first = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'first', f.input);
  const hit = (await f.knowledge.search(f.actor('sales'), f.workspace.id, '机密价格')).hits[0]!;
  assert.equal((await f.knowledge.cite(f.actor('sales'), hit.citation)).text, hit.text);
  await assert.rejects(f.knowledge.cite(f.actor('sales'), { ...hit.citation, digest: '0'.repeat(64) }), { code: 'CITATION_INVALID' });
  const second = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'second', { ...f.input, expectedStreamVersion: 1, contentBase64: Buffer.from('第二版需求').toString('base64') });
  assert.equal(second.revision, 2); assert.match((await f.knowledge.get(f.actor('sales'), first.reference)).extraction.blocks[1]!.text, /30000/);
  await f.knowledge.withdraw(f.actor('sales'), f.workspace.id, f.input.documentId, 2, 'withdraw');
  await assert.rejects(f.knowledge.cite(f.actor('sales'), hit.citation), { code: 'KNOWLEDGE_SOURCE_WITHDRAWN' });
  assert.deepEqual((await f.knowledge.search(f.actor('sales'), f.workspace.id, '需求')).hits, []);
});
test('异步提取后的权限变化不留下资料版本或可检索内容', async t => {
  const f = await setup(t);
  const knowledge = new EnterpriseKnowledgeService({ operating: new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now }), protection: { cas: f.cas, keyProvider: f.keyProvider }, extract: async input => { const value = await extractDocument(input); await f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1); return value; } });
  await assert.rejects(knowledge.importDocument(f.actor('sales'), f.workspace.id, 'revoked-import', f.input), { code: 'OBJECT_ACCESS_DENIED' });
  assert.equal(await f.store.transact('tenant', tx => tx.listProjections('enterprise-knowledge.version').length), 0);
});

test('知识引用可作为工作输入，撤回后阻止排队节点向模型发送正文', async t => {
  const f = await setup(t), material = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'import', f.input);
  const { EnterpriseGoalService } = await import('../src/enterprise-goals.js');
  const { EnterpriseTaskRuntime } = await import('../src/enterprise-task-runtime.js');
  const { AgentOsWorker } = await import('@mn/worker');
  const { EnterpriseQuotaService } = await import('@mn/enterprise-services');
  const quota = new EnterpriseQuotaService({ repository: f.repository, now: f.now }), limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20, tokens: 1000, costMinorUnits: '100', currency: 'CNY' as const, evaluationDailyTokens: 100, evaluationDailyCostMinorUnits: '10', singleEvaluationTokens: 10, singleEvaluationCostMinorUnits: '1', validFrom: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' };
  await quota.provision('tenant', 'platform', 0, limits); await quota.configure(f.admin, 'quota', f.workspace.id, 0, limits);
  const model = { id: 'model', version: 1, providerId: 'openai' as const, modelId: 'fixture', mode: 'test_fixture' as const, secretRef: 'fixture://enterprise/model' };
  const goals = new EnterpriseGoalService({ operating: f.operating, modelsFor: () => [model] }), budget = { maxTokens: 100, maxCostMinor: 10, currency: 'CNY' as const, deadline: '2026-12-01T00:00:00.000Z' };
  const draft = await goals.create(f.actor('sales'), f.workspace.id, 'goal', { title: '检查资料', message: '查验机密价格来源', sources: [{ reference: material.reference, fields: ['text'] }], acceptanceCriteria: ['有引用'], budget, capabilityIds: ['business.analyze'], modelBindingIds: ['model'] });
  const active = await goals.authorize(f.actor('sales'), draft.id, draft.streamVersion, draft.scopeDigest, 'authorize');
  await goals.plan(f.actor('sales'), draft.id, active.streamVersion, 'plan', { reason: '提取证据', nodes: [{ id: 'a', dependsOn: [], capabilityId: 'business.analyze', capabilityVersion: '1', modelBindingId: 'model', inputRefs: [material.reference], budget: { ...budget, maxTokens: 10, maxCostMinor: 1 }, acceptanceCriteria: ['有引用'], effect: 'read' }] });
  await f.knowledge.withdraw(f.actor('sales'), f.workspace.id, f.input.documentId, 1, 'withdraw-before-model'); let calls = 0;
  const runtime = new EnterpriseTaskRuntime({ goals, protection: { cas: f.cas, keyProvider: f.keyProvider }, secretStore: { async read() { calls++; throw new Error('MUST_NOT_READ'); } } });
  const worker = new AgentOsWorker({ id: 'knowledge-worker', store: runtime.workerStore(f.store), now: () => new Date(f.now()), lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' }, handlers: { 'enterprise.task': runtime.workerHandler() } });
  assert.equal((await worker.pollOnce()).status, 'failed'); assert.equal(calls, 0);
});

test('派生资料继承原始来源保护，不能靠另存文本降低字段等级或绕过撤回', async t => {
  const f = await setup(t), original = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'original', f.input);
  const derived = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'derived', { ...f.input, documentId: 'summary', title: '资料摘要', contentBase64: Buffer.from('价格结论引用原始需求。').toString('base64'), bindings: [{ reference: original.reference, fields: ['text'] }], classification: ['public'] });
  assert.ok(derived.classification.includes('price'));
  await assert.rejects(f.knowledge.get(f.actor('viewer'), derived.reference), { code: 'FIELD_ACCESS_DENIED' });
  await f.knowledge.withdraw(f.actor('sales'), f.workspace.id, f.input.documentId, 1, 'withdraw-origin');
  await assert.rejects(f.knowledge.get(f.actor('sales'), derived.reference), { code: 'KNOWLEDGE_SOURCE_WITHDRAWN' });
  assert.deepEqual((await f.knowledge.search(f.actor('sales'), f.workspace.id, '价格')).hits, []);
});


test('经营复盘作为资料来源时继续检查原始资金对象权限，不能从快照绕过字段隔离', async t => {
  const f = await fixture(t, true, true), order = await f.order();
  const review = await f.command({ type: 'business_review.snapshot', id: 'review', order: order.reference, periodStart: '2026-11-01', periodEnd: '2026-11-02', includeCosts: false }, 'finance-b');
  await f.permissions.grantRole(f.admin, 'review-only', { id: 'review-only', workspaceId: f.workspace.id, principalId: 'viewer', role: 'sales', scope: { kind: 'objects', objects: [{ objectType: 'business_review', objectId: 'review' }] }, operations: ['read'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z' });
  assert.equal((await f.get('business_review', 'review', 'viewer')).values.financialMetrics, undefined);
  const operating = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  await assert.rejects(operating.readSource(f.actor('viewer'), review.reference, ['financialMetrics']), { code: 'FIELD_ACCESS_DENIED' });
});

test('导出再次检查原始来源，私有资料不能通过导出或知识共享扩大可见范围', async t => {
  const f = await setup(t), material = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'private', { ...f.input, visibility: 'private' });
  await assert.rejects(f.knowledge.exportDocument(f.actor('manager'), material.reference, 'docx'), { code: 'KNOWLEDGE_NOT_FOUND' });
  const exported = await f.knowledge.exportDocument(f.actor('sales'), material.reference, 'docx');
  assert.equal(exported.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); assert.ok(exported.bytesBase64.length > 100);
  await f.knowledge.withdraw(f.actor('sales'), f.workspace.id, f.input.documentId, 1, 'withdraw');
  await assert.rejects(f.knowledge.exportDocument(f.actor('sales'), material.reference, 'docx'), { code: 'KNOWLEDGE_SOURCE_WITHDRAWN' });
});

test('资料所有者可按版本共享，当前字段权限仍限制接收人，撤销共享立即生效', async t => {
  const f = await setup(t), source = await f.knowledge.importDocument(f.actor('sales'), f.workspace.id, 'private', { ...f.input, visibility: 'private' });
  await assert.rejects(f.knowledge.get(f.actor('manager'), source.reference), { code: 'KNOWLEDGE_NOT_FOUND' });
  await f.knowledge.share(f.actor('sales'), source.reference, 1, true, 'share');
  assert.equal((await f.knowledge.get(f.actor('manager'), source.reference)).title, source.title);
  await assert.rejects(f.knowledge.get(f.actor('viewer'), source.reference), { code: 'FIELD_ACCESS_DENIED' });
  await f.knowledge.share(f.actor('sales'), source.reference, 2, false, 'unshare');
  await assert.rejects(f.knowledge.get(f.actor('manager'), source.reference), { code: 'KNOWLEDGE_NOT_FOUND' });
});
test('业务事实快照只从受权字段生成，模型文本不能声明业务事实来源', async t => {
  const f = await setup(t);
  const material = await f.knowledge.snapshotBusiness(f.actor('sales'), f.workspace.id, 'snapshot', { reference: f.base.quote.reference, fields: ['totalMinor'] });
  assert.equal(material.sourceKind, 'business_fact'); assert.ok(material.classification.includes('price'));
  assert.match(material.extraction.blocks.map(b => b.text).join('\n'), /totalMinor/);
  await assert.rejects(f.knowledge.snapshotBusiness(f.actor('viewer'), f.workspace.id, 'denied', { reference: f.base.quote.reference, fields: ['totalMinor'] }), { code: 'FIELD_ACCESS_DENIED' });
});
