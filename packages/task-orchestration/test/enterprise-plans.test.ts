// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanRevision, TaskNode } from '@mn/contracts';
import { validateEnterprisePlan, readyEnterpriseNodes, EnterprisePlanError, type EnterprisePlanContext } from '../src/enterprise-plans.js';
const source = { tenantId: 'tenant', workspaceId: 'workspace', objectType: 'customer' as const, objectId: 'customer', streamVersion: 1, digest: 'a'.repeat(64) };
const budget = { maxTokens: 1000, maxCostMinor: 100, currency: 'CNY' as const, deadline: '2026-12-01T00:00:00.000Z' };
const node = (id: string, dependsOn: readonly string[] = []): TaskNode => ({ id, dependsOn, capabilityId: 'business.analyze', capabilityVersion: '1', modelBindingId: 'model', inputRefs: [source], budget: { ...budget, maxTokens: 10, maxCostMinor: 1 }, acceptanceCriteria: ['引用获准来源'], effect: 'read' });
const plan = (nodes: readonly TaskNode[]): PlanRevision => ({ tenantId: 'tenant', workspaceId: 'workspace', id: 'plan', goalId: 'goal', revision: 1, authorityRevisionId: 'authority', reason: '分析已授权业务', nodes, inputRefs: [source], budget, acceptanceCriteria: ['给出风险清单'], createdAt: '2026-11-05T00:00:00.000Z' });
const context = (): EnterprisePlanContext => ({ tenantId: 'tenant', workspaceId: 'workspace', goalId: 'goal', authorityRevisionId: 'authority', inputRefs: [source], budget, acceptanceCriteria: ['给出风险清单'], capabilities: [{ id: 'business.analyze', version: '1', effect: 'read', modelRequired: true }], modelBindingIds: ['model'], now: '2026-11-05T00:00:00.000Z', limits: { parallelNodes: 6, totalNodes: 64, totalAttempts: 128, automaticReplans: 3 }, history: [], attempts: [], automaticReplans: 0, spent: { tokens: 0, costMinorUnits: '0' }, automatic: false });

test('动态任务图采用已配置上限，不受固定团队模板或角色数量限制', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => node('node-' + i, i ? ['node-' + (i - 1)] : []));
  assert.equal(validateEnterprisePlan(plan(nodes), context()).topologicalOrder.length, 40);
  assert.deepEqual(readyEnterpriseNodes(plan(nodes), []), ['node-0']);
  assert.throws(() => validateEnterprisePlan(plan([node('a', ['b']), node('b', ['a'])]), context()), { code: 'PLAN_CYCLE' });
});
test('模型、能力、字段所依附的对象范围及总预算均不得被模型扩大', () => {
  const p = plan([node('a')]);
  for (const changed of [ { ...p, inputRefs: [{ ...source, tenantId: 'other' }] }, { ...p, budget: { ...budget, maxTokens: 2000 } }, { ...p, acceptanceCriteria: ['另一个交付目标'] } ]) {
    assert.throws(() => validateEnterprisePlan(changed, context()), { code: 'PLAN_AUTHORITY_EXPANSION' });
  }
  assert.throws(() => validateEnterprisePlan(plan([{ ...node('a'), modelBindingId: 'unapproved' }]), context()), { code: 'PLAN_MODEL_UNAVAILABLE' });
  assert.throws(() => validateEnterprisePlan(plan([{ ...node('a'), effect: 'formal_action' }]), context()), { code: 'PLAN_CAPABILITY_INVALID' });
  assert.throws(() => validateEnterprisePlan(plan([{ ...node('a'), budget: { ...budget, maxTokens: 999 } }, node('b')]), context()), { code: 'PLAN_BUDGET_EXCEEDED' });
});
test('重规划保留已开始节点及结果，不能换标识重复已开始动作', () => {
  const started = node('started'), ctx = { ...context(), history: [plan([started])], attempts: [{ node: started, status: 'running' as const, executionId: 'execution' }], automatic: true };
  assert.doesNotThrow(() => validateEnterprisePlan({ ...plan([started, node('next', ['started'])]), revision: 2 }, ctx));
  assert.throws(() => validateEnterprisePlan({ ...plan([node('other')]), revision: 2 }, ctx), { code: 'PLAN_STARTED_NODE_CHANGED' });
  assert.throws(() => validateEnterprisePlan({ ...plan([{ ...started, budget: { ...started.budget, maxTokens: 5 } }]), revision: 2 }, ctx), { code: 'PLAN_STARTED_NODE_CHANGED' });
  const action = { ...node('write'), capabilityId: 'business.followup', effect: 'internal_write' as const, modelBindingId: undefined };
  const { modelBindingId: _model, ...withoutModel } = action;
  const actionContext = { ...ctx, capabilities: [...ctx.capabilities, { id: 'business.followup', version: '1', effect: 'internal_write' as const, modelRequired: false }], history: [plan([withoutModel])], attempts: [{ node: withoutModel, status: 'running' as const, executionId: 'action' }] };
  assert.throws(() => validateEnterprisePlan({ ...plan([withoutModel, { ...withoutModel, id: 'duplicate' }]), revision: 2 }, actionContext), { code: 'PLAN_DUPLICATE_ACTION' });
});
test('已花费用、历史节点、累计尝试和自动重规划次数不能通过新计划清零', () => {
  assert.throws(() => validateEnterprisePlan(plan([node('a')]), { ...context(), spent: { tokens: 999, costMinorUnits: '0' } }), { code: 'PLAN_BUDGET_EXCEEDED' });
  assert.throws(() => validateEnterprisePlan({ ...plan([node('next')]), revision: 2 }, { ...context(), limits: { ...context().limits, totalNodes: 1 }, history: [plan([node('old')])] }), { code: 'PLAN_NODE_LIMIT' });
  assert.throws(() => validateEnterprisePlan(plan([node('a')]), { ...context(), automatic: true, automaticReplans: 3 }), { code: 'PLAN_REPLAN_LIMIT' });
  assert.throws(() => validateEnterprisePlan(plan([node('a')]), { ...context(), limits: { ...context().limits, totalAttempts: 1 }, attempts: [{ node: node('old'), status: 'failed', executionId: 'old' }] }), { code: 'PLAN_ATTEMPT_LIMIT' });
});
test('未知结果阻断后续依赖，暂停与等待不产生新的就绪节点', () => {
  const p = plan([node('a'), node('b', ['a'])]);
  assert.deepEqual(readyEnterpriseNodes(p, [{ node: p.nodes[0]!, status: 'needs_reconciliation', executionId: 'a' }]), []);
  assert.deepEqual(readyEnterpriseNodes(p, [{ node: p.nodes[0]!, status: 'completed', executionId: 'a' }]), ['b']);
  assert.deepEqual(readyEnterpriseNodes(p, [], 'paused'), []);
  assert.ok(EnterprisePlanError.prototype instanceof Error);
});

test('模型节点必须有非零调用预算，不能把待配置节点登记为可执行', () => {
  assert.throws(() => validateEnterprisePlan(plan([{ ...node('a'), budget: { ...budget, maxTokens: 0 } }]), context()), { code: 'PLAN_BUDGET_EXCEEDED' });
});

test('自动调整只能新增只读或草稿节点，不能新增业务写入', () => {
  const action = { ...node('write'), capabilityId: 'business.followup', effect: 'internal_write' as const };
  const ctx = { ...context(), automatic: true, capabilities: [...context().capabilities, { id: 'business.followup', version: '1', effect: 'internal_write' as const, modelRequired: true }] };
  assert.throws(() => validateEnterprisePlan(plan([action]), ctx), { code: 'PLAN_AUTHORITY_EXPANSION' });
});
