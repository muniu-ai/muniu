// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/business.js';
import { EnterpriseOperatingService } from '../src/enterprise-operating.js';
import { EnterpriseWorkflowService } from '../src/enterprise-workflows.js';
import { EnterpriseGoalService } from '../src/enterprise-goals.js';
test('五套流程由管理员发布不可变版本，更新与回退不替换已创建工作的版本', async t => {
  const f = await fixture(t, true, true), base = await f.base(), operating = new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now });
  const workflows = new EnterpriseWorkflowService({ operating }), catalog = await workflows.list(f.admin, f.workspace.id);
  assert.deepEqual(catalog.builtins.map(v => v.flowId).sort(), ['delivery', 'opportunity', 'quote', 'receivable', 'review']);
  const definition = catalog.builtins.find(v => v.flowId === 'opportunity')!;
  await assert.rejects(workflows.publish(f.actor('sales'), f.workspace.id, 0, definition, 'sales-publish'), { code: 'ORGANIZATION_ADMIN_REQUIRED' });
  const first = await workflows.publish(f.admin, f.workspace.id, 0, definition, 'first');
  const selected = await workflows.select(f.admin, f.workspace.id, definition.flowId, first.streamVersion, first.versions[0]!, 'select-first');
  const goals = new EnterpriseGoalService({ operating, modelsFor: () => [] });
  const spec = { workflow: first.versions[0]!, title: '跟进需求', message: '检查缺项', sources: [{ reference: base.opportunity.reference, fields: ['title'] }], acceptanceCriteria: definition.acceptanceCriteria, budget: { maxTokens: 100, maxCostMinor: 10, currency: 'CNY' as const, deadline: '2026-12-01T00:00:00.000Z' }, capabilityIds: ['business.analyze'], modelBindingIds: ['model'] };
  const goal = await goals.create(f.actor('sales'), f.workspace.id, 'goal', spec);
  const second = await workflows.publish(f.admin, f.workspace.id, selected.streamVersion, { ...definition, title: '商机跟进第二版' }, 'second');
  const changed = await workflows.select(f.admin, f.workspace.id, definition.flowId, second.streamVersion, second.versions[1]!, 'select-second');
  assert.deepEqual((await goals.get(f.actor('sales'), goal.id)).spec.workflow, first.versions[0]);
  await assert.rejects(goals.create(f.actor('sales'), f.workspace.id, 'old-new-goal', spec), { code: 'WORKFLOW_NOT_ENABLED' });
  await workflows.select(f.admin, f.workspace.id, definition.flowId, changed.streamVersion, first.versions[0]!, 'rollback');
  assert.equal((await goals.create(f.actor('sales'), f.workspace.id, 'after-rollback', spec)).spec.workflow!.digest, first.versions[0]!.digest);
  await assert.rejects(goals.create(f.actor('sales'), f.workspace.id, 'forged', { ...spec, workflow: { ...spec.workflow, digest: '0'.repeat(64) } }), { code: 'WORKFLOW_VERSION_INVALID' });
  await assert.rejects(workflows.publish(f.admin, f.workspace.id, 0, definition, 'stale'), { code: 'STREAM_VERSION_CONFLICT' });
});
test('流程版本数量达到响应契约上限时先拒绝新写入，不留下无法读取的控制流', async t => {
  const f = await fixture(t, true, true), workflows = new EnterpriseWorkflowService({ operating: new EnterpriseOperatingService({ store: f.store, repository: f.repository, now: f.now }) });
  const definition = (await workflows.list(f.admin, f.workspace.id)).builtins[0]!;
  for (let i = 0; i < 100; i++) await workflows.publish(f.admin, f.workspace.id, i, { ...definition, title: '商机跟进 ' + i }, 'publish-' + i);
  await assert.rejects(workflows.publish(f.admin, f.workspace.id, 100, definition, 'overflow'), { code: 'WORKFLOW_VERSION_LIMIT' });
  const state = (await workflows.list(f.admin, f.workspace.id)).states[0]!;
  assert.equal(state.streamVersion, 100); assert.equal(state.versions.length, 100);
});
