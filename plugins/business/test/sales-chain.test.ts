// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideBusinessCommand, reduceBusinessEvents, type BusinessCommand, type BusinessEvent } from '../src/index.js';
const now = '2026-11-02T01:00:00.000Z';
function fixture() {
  const events: BusinessEvent[] = [], checks: unknown[] = [];
  const execute = (command: BusinessCommand, actorId = 'sales', kind: 'human' | 'agent' = 'human') => {
    const change = decideBusinessCommand(reduceBusinessEvents(events), command, { tenantId: 'tenant', workspaceId: 'workspace', actorId, actorKind: kind,
      now, revisionSalt: 'a'.repeat(64), assertEvidence: () => {}, assertCurrent: requirement => { checks.push(requirement); } });
    events.push(...change.events); return reduceBusinessEvents(events).objects.get(change.primaryObjectKey)!;
  };
  const ref = (type: string, id: string) => reduceBusinessEvents(events).objects.get(`${type}:${id}`)!.reference;
  const base = () => {
    execute({ type: 'customer.create', id: 'customer', name: '合成客户' });
    execute({ type: 'opportunity.create', id: 'opportunity', customer: ref('customer', 'customer'), title: '合成服务需求' });
    execute({ type: 'service.publish', id: 'service-v1', serviceCode: 'consulting', title: '咨询服务', unit: '次', unitPriceMinor: 10000,
      scope: '完成一次需求评估', acceptanceCriteria: ['提交评估报告'], validFrom: now, validUntil: '2027-01-01T00:00:00.000Z' }, 'manager');
    return execute({ type: 'quote.prepare', id: 'quote-v1', opportunity: ref('opportunity', 'opportunity'),
      lines: [{ service: ref('service_version', 'service-v1'), quantity: 3 }], validUntil: '2026-12-01T00:00:00.000Z' });
  };
  const evidence = { id: 'customer-evidence', tenantId: 'tenant', workspaceId: 'workspace', sourceKind: 'human_decision' as const,
    protectedContentRef: 'protected-test-evidence', sourceVersion: '1', digest: 'b'.repeat(64), permissionRef: 'permission', locator: { paragraph: 'signed-document' } };
  return { execute, ref, base, events, checks, evidence };
}
test('报价到合同和多个订单使用独立版本，数量与金额由领域规则守恒', () => {
  const f = fixture(), quote = f.base();
  assert.equal(quote.value.totalMinor, 30000);
  assert.equal((quote.value.lines as any[])[0].scope, '完成一次需求评估');
  assert.deepEqual((quote.value.lines as any[])[0].acceptanceCriteria, ['提交评估报告']);
  f.execute({ type: 'quote.approve', id: 'quote-v1', expectedStreamVersion: 1 }, 'manager');
  f.execute({ type: 'quote.record_acceptance', id: 'quote-v1', expectedStreamVersion: 2, evidence: f.evidence }, 'manager');
  f.execute({ type: 'contract.create', id: 'contract', quote: f.ref('quote_version', 'quote-v1'), title: '咨询服务合同' });
  f.execute({ type: 'contract.activate', id: 'contract', expectedStreamVersion: 1, evidence: f.evidence }, 'manager');
  const contract = f.ref('contract', 'contract');
  for (const [id, quantity] of [['order-a', 1], ['order-b', 2]] as const) {
    f.execute({ type: 'order.create', id, contract, lines: [{ quoteLineId: 'line-1', quantity }] });
    f.execute({ type: 'order.activate', id, expectedStreamVersion: 1 }, 'manager');
  }
  const state = reduceBusinessEvents(f.events);
  assert.equal(state.objects.get('order:order-a')!.value.totalMinor, 10000);
  assert.equal((state.objects.get('order:order-a')!.value.lines as any[])[0].scope, '完成一次需求评估');
  assert.equal(state.objects.get('order:order-b')!.value.totalMinor, 20000);
  assert.equal(f.ref('customer', 'customer').streamVersion, 1);
  assert.equal(f.ref('contract', 'contract').streamVersion, 2);
  f.execute({ type: 'order.create', id: 'over', contract, lines: [{ quoteLineId: 'line-1', quantity: 1 }] });
  assert.throws(() => f.execute({ type: 'order.activate', id: 'over', expectedStreamVersion: 1 }, 'manager'), { code: 'CONTRACT_ALLOCATION_EXCEEDED' });
  const corrupted = structuredClone(f.events); corrupted[0] = { ...corrupted[0]!, expectedStreamVersion: 99 };
  assert.throws(() => reduceBusinessEvents(corrupted), { code: 'BUSINESS_EVENT_HISTORY_INVALID' });
});
test('内部批准、客户接受、合同生效和订单生效不能互相替代，Agent 不能确认正式事实', () => {
  const f = fixture(); f.base();
  assert.throws(() => f.execute({ type: 'quote.approve', id: 'quote-v1', expectedStreamVersion: 1 }), { code: 'SEPARATION_OF_DUTIES_REQUIRED' });
  assert.throws(() => f.execute({ type: 'quote.approve', id: 'quote-v1', expectedStreamVersion: 1 }, 'agent', 'agent'), { code: 'HUMAN_CONFIRMATION_REQUIRED' });
  f.execute({ type: 'quote.approve', id: 'quote-v1', expectedStreamVersion: 1 }, 'manager');
  assert.throws(() => f.execute({ type: 'contract.create', id: 'early', quote: f.ref('quote_version', 'quote-v1'), title: '过早生效' }), { code: 'CUSTOMER_ACCEPTANCE_REQUIRED' });
  assert.throws(() => f.execute({ type: 'quote.record_acceptance', id: 'quote-v1', expectedStreamVersion: 1, evidence: f.evidence }, 'manager'), { code: 'STREAM_VERSION_CONFLICT' });
  assert.throws(() => f.execute({ type: 'quote.record_acceptance', id: 'quote-v1', expectedStreamVersion: 2, evidence: { ...f.evidence, tenantId: 'foreign' } }, 'manager'), { code: 'EVIDENCE_SCOPE_MISMATCH' });
});
test('版本和来源摘要在提交时重验，原服务版本停用后不能批准陈旧报价', () => {
  const f = fixture(); f.base();
  f.execute({ type: 'service.publish', id: 'service-v2', serviceCode: 'consulting', title: '新版咨询', unit: '次', unitPriceMinor: 12000,
    scope: '新服务范围', acceptanceCriteria: ['报告'], validFrom: now, validUntil: '2027-01-01T00:00:00.000Z', supersedes: { id: 'service-v1', expectedStreamVersion: 1 } }, 'manager');
  assert.throws(() => f.execute({ type: 'quote.approve', id: 'quote-v1', expectedStreamVersion: 1 }, 'manager'), { code: 'SOURCE_VERSION_CONFLICT' });
  assert.throws(() => f.execute({ type: 'opportunity.create', id: 'bad', customer: { ...f.ref('customer', 'customer'), digest: '0'.repeat(64) }, title: '伪造引用' }), { code: 'SOURCE_VERSION_CONFLICT' });
  assert.throws(() => f.execute({ type: 'opportunity.create', id: 'foreign', customer: { ...f.ref('customer', 'customer'), tenantId: 'foreign' }, title: '跨企业' }), { code: 'OBJECT_SCOPE_MISMATCH' });
});

test('正式决定有独立批准流，公开引用摘要不能枚举隐藏价格，金额溢出拒绝', () => {
  const f = fixture(); const quote = f.base();
  f.execute({ type: 'quote.approve', id: 'quote-v1', expectedStreamVersion: 1 }, 'manager');
  const state = reduceBusinessEvents(f.events);
  assert.equal(state.approvals.size, 1);
  const approval = [...state.approvals.values()][0]!;
  assert.deepEqual(approval.subjectRef, quote.reference);
  assert.equal(approval.approvedByPrincipalId, 'manager');
  assert.equal(approval.preparedByPrincipalId, 'sales');
  const otherSalt = f.events.map(event => ({ ...event, revisionSalt: 'c'.repeat(64) }));
  assert.notEqual(reduceBusinessEvents(otherSalt).objects.get('service_version:service-v1')!.reference.digest, state.objects.get('service_version:service-v1')!.reference.digest);
  assert.throws(() => f.execute({ type: 'quote.prepare', id: 'overflow', opportunity: f.ref('opportunity', 'opportunity'),
    lines: [{ service: f.ref('service_version', 'service-v1'), quantity: Number.MAX_SAFE_INTEGER }], validUntil: '2026-12-01T00:00:00.000Z' }), { code: 'MONEY_OUT_OF_RANGE' });
});
test('业务检查与证据核验必须同步拒绝，不能把 false 或异步返回当作授权', () => {
  const f = fixture(); f.base();
  const context = { tenantId: 'tenant', workspaceId: 'workspace', actorId: 'manager', actorKind: 'human' as const, now, revisionSalt: 'a'.repeat(64), assertEvidence: () => {} };
  const command = { type: 'quote.approve' as const, id: 'quote-v1', expectedStreamVersion: 1 };
  assert.throws(() => decideBusinessCommand(reduceBusinessEvents(f.events), command, { ...context, assertCurrent: () => false }), { code: 'BUSINESS_POLICY_INVALID' });
  assert.throws(() => decideBusinessCommand(reduceBusinessEvents(f.events), command, { ...context, assertCurrent: async () => {} }), { code: 'BUSINESS_POLICY_INVALID' });
  f.execute(command, 'manager');
  assert.throws(() => decideBusinessCommand(reduceBusinessEvents(f.events), { type: 'quote.record_acceptance', id: 'quote-v1', expectedStreamVersion: 2, evidence: f.evidence },
    { ...context, assertCurrent: () => {}, assertEvidence: () => false }), { code: 'EVIDENCE_VERIFIER_INVALID' });
});

test('审批人可只有读取与批准权限，不必取得制单写权限', () => {
  const f = fixture(); f.base();
  const result = decideBusinessCommand(reduceBusinessEvents(f.events), { type: 'quote.approve', id: 'quote-v1', expectedStreamVersion: 1 }, {
    tenantId: 'tenant', workspaceId: 'workspace', actorId: 'manager', actorKind: 'human', now, revisionSalt: 'a'.repeat(64), assertEvidence: () => {},
    assertCurrent: requirement => { assert.notEqual(requirement.operation, 'write'); },
  });
  assert.ok(result.events.some(event => event.type === 'quote_version.approved'));
});

test('商机改关联客户时同步部门，旧部门不能沿用原范围', () => {
  const f = fixture();
  f.execute({ type: 'customer.create', id: 'a', name: '甲', departmentId: 'department-a' });
  f.execute({ type: 'customer.create', id: 'b', name: '乙', departmentId: 'department-b' });
  f.execute({ type: 'opportunity.create', id: 'deal', customer: f.ref('customer', 'a'), title: '需求' });
  const updated = f.execute({ type: 'opportunity.update', id: 'deal', expectedStreamVersion: 1, customer: f.ref('customer', 'b'), title: '调整后的需求' });
  assert.equal(updated.value.departmentId, 'department-b');
  f.execute({ type: 'customer.create', id: 'c', name: '丙' });
  assert.equal(f.execute({ type: 'opportunity.update', id: 'deal', expectedStreamVersion: 2, customer: f.ref('customer', 'c'), title: '新需求' }).value.departmentId, undefined);
});

test('客户来源版本变化使未批准报价失效，不能仅凭商机版本继续批准', () => {
  const f=fixture(); f.base();
  f.execute({type:'customer.rename',id:'customer',expectedStreamVersion:1,name:'更新后的合成客户'});
  assert.throws(()=>f.execute({type:'quote.approve',id:'quote-v1',expectedStreamVersion:1},'manager'),{code:'SOURCE_VERSION_CONFLICT'});
  assert.throws(()=>f.execute({type:'quote.prepare',id:'quote-v2',opportunity:f.ref('opportunity','opportunity'),lines:[{service:f.ref('service_version','service-v1'),quantity:1}],validUntil:'2026-12-01T00:00:00.000Z'}),{code:'SOURCE_VERSION_CONFLICT'});
});
