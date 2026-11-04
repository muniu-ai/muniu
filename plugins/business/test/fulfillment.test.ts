// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { businessFixture } from './fixtures/business.js';
import { projectProgress, orderFinancials } from '../src/fulfillment-queries.js';
test('十项承诺交付六项、客户验收四项时仍余六项；内部接收不等于客户验收', () => {
    const f = businessFixture();
    f.order();
    f.execute({ type: 'project.create', id: 'project', order: f.ref('order', 'order'), title: '项目' }, 'project-owner');
    assert.throws(() => f.execute({ type: 'project.create', id: 'duplicate', order: f.ref('order', 'order'), title: '重复' }, 'project-owner'), { code: 'ORDER_PROJECT_EXISTS' });
    f.execute({ type: 'milestone.create', id: 'milestone', project: f.ref('project', 'project'), title: '阶段一', dueDate: '2026-11-30', lines: [{ lineId: 'line-1', quantity: 10 }] }, 'project-owner');
    f.execute({ type: 'delivery.report', id: 'delivery', milestone: f.ref('milestone', 'milestone'), summary: '已交付六项', lines: [{ lineId: 'line-1', quantity: 6 }] }, 'project-owner');
    f.execute({ type: 'delivery.receive', id: 'delivery', expectedStreamVersion: 1 }, 'project-owner');
    assert.equal(projectProgress(f.state(), 'project').lines[0]!.accepted, 0);
    f.execute({ type: 'acceptance.prepare', id: 'acceptance', delivery: f.ref('delivery_version', 'delivery'), lines: [{ lineId: 'line-1', quantity: 4 }] }, 'project-owner');
    assert.throws(() => f.execute({ type: 'acceptance.confirm', id: 'acceptance', expectedStreamVersion: 1, evidence: f.proof(f.ref('customer_acceptance', 'acceptance')) }, 'project-owner'), { code: 'SEPARATION_OF_DUTIES_REQUIRED' });
    f.execute({ type: 'acceptance.confirm', id: 'acceptance', expectedStreamVersion: 1, evidence: f.proof(f.ref('customer_acceptance', 'acceptance')) }, 'reviewer');
    const progress = projectProgress(f.state(), 'project');
    assert.deepEqual(progress.lines.map(({ promised, delivered, accepted, remaining }) => ({ promised, delivered, accepted, remaining })), [{ promised: 10, delivered: 6, accepted: 4, remaining: 6 }]);
    f.execute({ type: 'acceptance.prepare', id: 'over', delivery: f.ref('delivery_version', 'delivery'), lines: [{ lineId: 'line-1', quantity: 3 }] }, 'project-owner');
    assert.throws(() => f.execute({ type: 'acceptance.confirm', id: 'over', expectedStreamVersion: 1, evidence: f.proof(f.ref('customer_acceptance', 'over')) }, 'reviewer'), { code: 'ACCEPTANCE_QUANTITY_EXCEEDED' });
});
test('付款期、到账、退款和减免独立批准，余额不取模型或客户端汇总', () => {
    const f = businessFixture();
    f.order();
    for (const [id, amountMinor, dueDate] of [['first', 400000, '2026-11-02'], ['second', 600000, '2026-12-02']] as const) {
        f.execute({ type: 'payment_schedule.create', id, order: f.ref('order', 'order'), amountMinor, dueDate }, 'finance-a');
        f.execute({ type: 'payment_schedule.confirm', id, expectedStreamVersion: 1, evidence: f.proof(f.ref('payment_schedule', id)) }, 'finance-b');
    }
    f.execute({ type: 'receipt.prepare', id: 'receipt', order: f.ref('order', 'order'), amountMinor: 100000, businessDate: '2026-11-02', allocations: [{ schedule: f.ref('payment_schedule', 'first'), amountMinor: 100000 }] }, 'finance-a');
    assert.throws(() => f.execute({ type: 'receipt.confirm', id: 'receipt', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'receipt')) }, 'finance-b', 'agent'), { code: 'HUMAN_CONFIRMATION_REQUIRED' });
    f.execute({ type: 'receipt.confirm', id: 'receipt', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'receipt')) }, 'finance-b');
    let balance = orderFinancials(f.state(), 'order', '2026-11-02');
    assert.equal(balance.outstandingMinor, 900000);
    assert.equal(balance.dueMinor, 300000);
    f.execute({ type: 'refund.prepare', id: 'refund', receipt: f.ref('receipt', 'receipt'), amountMinor: 30000, businessDate: '2026-11-02', releasedAllocations: [{ schedule: f.ref('payment_schedule', 'first'), amountMinor: 30000 }] }, 'finance-a');
    f.execute({ type: 'refund.confirm', id: 'refund', expectedStreamVersion: 1, evidence: f.proof(f.ref('refund', 'refund')) }, 'finance-b');
    balance = orderFinancials(f.state(), 'order', '2026-11-02');
    assert.equal(balance.netReceivedMinor, 70000);
    assert.equal(balance.outstandingMinor, 930000);
    f.execute({ type: 'adjustment.prepare', id: 'waiver', kind: 'write_off', order: f.ref('order', 'order'), schedule: f.ref('payment_schedule', 'first'), amountMinor: 20000, businessDate: '2026-11-02', reason: '合成减免' }, 'finance-a');
    f.execute({ type: 'adjustment.confirm', id: 'waiver', expectedStreamVersion: 1, evidence: f.proof(f.ref('adjustment', 'waiver')) }, 'finance-b');
    balance = orderFinancials(f.state(), 'order', '2026-11-02');
    assert.equal(balance.outstandingMinor, 910000);
    assert.equal(balance.refundedMinor, 30000);
    assert.equal(balance.writtenOffMinor, 20000);
});
test('交付和资金命令拒绝不可寻址的标识、无效日期及非安全整数',()=>{
 const f=businessFixture();f.order();
 for(const id of ['.','..','bad\u0000id'])assert.throws(()=>f.execute({type:'project.create',id,order:f.ref('order','order'),title:'项目'},'project-owner'),/企业契约格式无效/);
 for(const amountMinor of [0,-1,0.1,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>f.execute({type:'payment_schedule.create',id:'bad',order:f.ref('order','order'),amountMinor,dueDate:'2026-11-02'},'finance-a'),/企业契约格式无效/);
 assert.throws(()=>f.execute({type:'payment_schedule.create',id:'bad',order:f.ref('order','order'),amountMinor:100,dueDate:'2026-02-30'},'finance-a'),/企业契约格式无效/);
});
