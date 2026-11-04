// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { businessFixture } from './fixtures/business.js';
import { projectCosts, projectProgress, orderFinancials } from '../src/fulfillment-queries.js';
const project = () => { const f = businessFixture(); f.order(); f.execute({ type: 'project.create', id: 'project', order: f.ref('order', 'order'), title: '项目' }, 'project-owner'); f.execute({ type: 'milestone.create', id: 'm', project: f.ref('project', 'project'), title: '阶段', dueDate: '2026-12-01', lines: [{ lineId: 'line-1', quantity: 10 }] }, 'project-owner'); return f; };
test('变更先商业批准再项目确认，保留旧交付和原条目编号', () => {
    const f = project();
    f.execute({ type: 'delivery.report', id: 'd', milestone: f.ref('milestone', 'm'), summary: '交付', lines: [{ lineId: 'line-1', quantity: 4 }] }, 'project-owner');
    f.execute({ type: 'delivery.receive', id: 'd', expectedStreamVersion: 1 }, 'project-owner');
    f.execute({ type: 'change_request.prepare', id: 'c', project: f.ref('project', 'project'), description: '追加两项' }, 'project-owner');
    f.execute({ type: 'change_request.price', id: 'c', expectedStreamVersion: 1, lines: [{ orderLineId: 'line-1', quantity: 12 }] }, 'maker');
    assert.throws(() => f.execute({ type: 'change_request.approve', id: 'c', expectedStreamVersion: 2, evidence: f.proof(f.ref('change_request', 'c')) }, 'maker'), { code: 'SEPARATION_OF_DUTIES_REQUIRED' });
    f.execute({ type: 'change_request.approve', id: 'c', expectedStreamVersion: 2, evidence: f.proof(f.ref('change_request', 'c')) }, 'manager');
    assert.equal(f.state().objects.get('order:order')!.value.totalMinor, 1200000);
    assert.throws(() => f.execute({ type: 'delivery.report', id: 'blocked', milestone: f.ref('milestone', 'm'), summary: '待确认', lines: [{ lineId: 'line-1', quantity: 1 }] }, 'project-owner'), { code: 'PROJECT_SCOPE_PENDING' });
    f.execute({ type: 'change_request.project_confirm', id: 'c', expectedStreamVersion: 3, milestones: [{ milestone: f.ref('milestone', 'm'), expectedStreamVersion: 1, lines: [{ lineId: 'line-1', quantity: 12 }] }] }, 'project-owner');
    assert.deepEqual(projectProgress(f.state(), 'project').lines.map(l => [l.promised, l.delivered]), [[12, 4]]);
    f.execute({ type: 'change_request.prepare', id: 'shrink', project: f.ref('project', 'project'), description: '不足已交付数量' }, 'project-owner');
    assert.throws(() => f.execute({ type: 'change_request.price', id: 'shrink', expectedStreamVersion: 1, lines: [{ orderLineId: 'line-1', quantity: 3 }] }, 'maker'), { code: 'DELIVERY_QUANTITY_EXCEEDED' });
});
test('成本未确认不显示毛利，新增费用立即使完整性失效；复盘保留当时事实', () => {
    const f = project();
    assert.equal(projectCosts(f.state(), 'project').marginMinor, null);
    f.execute({ type: 'expense.prepare', id: 'expense', project: f.ref('project', 'project'), amountMinor: 300000, businessDate: '2026-11-02', description: '合成支出' }, 'finance-a');
    f.execute({ type: 'expense.confirm', id: 'expense', expectedStreamVersion: 1, evidence: f.proof(f.ref('expense', 'expense')) }, 'finance-b');
    f.execute({ type: 'project.costs.confirm', id: 'project', expectedStreamVersion: 1, evidence: f.proof(f.ref('project', 'project')), expenseRefs: [f.ref('expense', 'expense')], zeroCost: false }, 'finance-b');
    assert.equal(projectCosts(f.state(), 'project').marginMinor, 700000);
    const review = f.execute({ type: 'business_review.snapshot', id: 'review', order: f.ref('order', 'order'), periodStart: '2026-11-01', periodEnd: '2026-11-02', includeCosts: true }, 'finance-b');
    f.execute({ type: 'expense.prepare', id: 'late', project: f.ref('project', 'project'), amountMinor: 100, businessDate: '2026-11-01', description: '补录' }, 'finance-a');
    assert.equal(projectCosts(f.state(), 'project').marginMinor, null);
    assert.deepEqual(f.state().objects.get('business_review:review'), review);
});
test('付款期修订须独立批准且不得低于已分配资金；冲销不算实际退款', () => {
    const f = project();
    f.execute({ type: 'payment_schedule.create', id: 's', order: f.ref('order', 'order'), amountMinor: 1000000, dueDate: '2026-11-02' }, 'finance-a');
    f.execute({ type: 'payment_schedule.confirm', id: 's', expectedStreamVersion: 1, evidence: f.proof(f.ref('payment_schedule', 's')) }, 'finance-b');
    f.execute({ type: 'receipt.prepare', id: 'r', order: f.ref('order', 'order'), amountMinor: 100000, businessDate: '2026-11-02', allocations: [{ schedule: f.ref('payment_schedule', 's'), amountMinor: 100000 }] }, 'finance-a');
    f.execute({ type: 'receipt.confirm', id: 'r', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'r')) }, 'finance-b');
    f.execute({ type: 'adjustment.prepare', id: 'bad', kind: 'schedule_revision', schedule: f.ref('payment_schedule', 's'), proposedAmountMinor: 50000, proposedDueDate: '2026-12-01', businessDate: '2026-11-02', reason: '修订' }, 'finance-a');
    assert.throws(() => f.execute({ type: 'adjustment.confirm', id: 'bad', expectedStreamVersion: 1, evidence: f.proof(f.ref('adjustment', 'bad')) }, 'finance-b'), { code: 'PAYMENT_ALLOCATION_EXCEEDED' });
    f.execute({ type: 'adjustment.prepare', id: 'reverse', kind: 'receipt_reversal', receipt: f.ref('receipt', 'r'), amountMinor: 100000, businessDate: '2026-11-02', reason: '误登记', releasedAllocations: [{ schedule: f.ref('payment_schedule', 's'), amountMinor: 100000 }] }, 'finance-a');
    f.execute({ type: 'adjustment.confirm', id: 'reverse', expectedStreamVersion: 1, evidence: f.proof(f.ref('adjustment', 'reverse')) }, 'finance-b');
    const b = orderFinancials(f.state(), 'order', '2026-11-02');
    assert.equal(b.reversedMinor, 100000);
    assert.equal(b.refundedMinor, 0);
    assert.equal(b.outstandingMinor, 1000000);
});
test('补录减免不能让较早日期的已分配金额超额；付款期修订保留旧金额口径', () => {
    const f = project();
    f.execute({ type: 'payment_schedule.create', id: 's', order: f.ref('order', 'order'), amountMinor: 1000000, dueDate: '2026-11-01' }, 'finance-a');
    f.execute({ type: 'payment_schedule.confirm', id: 's', expectedStreamVersion: 1, evidence: f.proof(f.ref('payment_schedule', 's')) }, 'finance-b');
    f.execute({ type: 'receipt.prepare', id: 'r', order: f.ref('order', 'order'), amountMinor: 1000000, businessDate: '2026-11-01', allocations: [{ schedule: f.ref('payment_schedule', 's'), amountMinor: 1000000 }] }, 'finance-a');
    f.execute({ type: 'receipt.confirm', id: 'r', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'r')) }, 'finance-b');
    f.execute({ type: 'refund.prepare', id: 'refund', receipt: f.ref('receipt', 'r'), amountMinor: 1000000, businessDate: '2026-11-02', releasedAllocations: [{ schedule: f.ref('payment_schedule', 's'), amountMinor: 1000000 }] }, 'finance-a');
    f.execute({ type: 'refund.confirm', id: 'refund', expectedStreamVersion: 1, evidence: f.proof(f.ref('refund', 'refund')) }, 'finance-b');
    f.execute({ type: 'adjustment.prepare', id: 'bad', kind: 'write_off', order: f.ref('order', 'order'), schedule: f.ref('payment_schedule', 's'), amountMinor: 1000000, businessDate: '2026-11-01', reason: '补录' }, 'finance-a');
    assert.throws(() => f.execute({ type: 'adjustment.confirm', id: 'bad', expectedStreamVersion: 1, evidence: f.proof(f.ref('adjustment', 'bad')) }, 'finance-b'), { code: 'PAYMENT_ALLOCATION_EXCEEDED' });
    f.execute({ type: 'adjustment.prepare', id: 'revise', kind: 'schedule_revision', schedule: f.ref('payment_schedule', 's'), proposedAmountMinor: 500000, proposedDueDate: '2026-12-01', businessDate: '2026-11-02', reason: '分期调整' }, 'finance-a');
    f.execute({ type: 'adjustment.confirm', id: 'revise', expectedStreamVersion: 1, evidence: f.proof(f.ref('adjustment', 'revise')) }, 'finance-b');
    assert.equal(orderFinancials(f.state(), 'order', '2026-11-01').periods[0]!.amountMinor, 1000000);
    assert.equal(orderFinancials(f.state(), 'order', '2026-11-02').periods[0]!.amountMinor, 500000);
});
test('资金关联拒绝陈旧来源、其他订单付款期和退款早于到账日期', () => {
    const f = project();
    f.execute({ type: 'payment_schedule.create', id: 's', order: f.ref('order', 'order'), amountMinor: 1000000, dueDate: '2026-11-02' }, 'finance-a');
    const old = f.ref('payment_schedule', 's');
    f.execute({ type: 'payment_schedule.confirm', id: 's', expectedStreamVersion: 1, evidence: f.proof(old) }, 'finance-b');
    assert.throws(() => f.execute({ type: 'receipt.prepare', id: 'stale', order: f.ref('order', 'order'), amountMinor: 100, businessDate: '2026-11-02', allocations: [{ schedule: old, amountMinor: 100 }] }, 'finance-a'), { code: 'SOURCE_VERSION_CONFLICT' });
    assert.throws(() => f.execute({ type: 'receipt.prepare', id: 'foreign', order: { ...f.ref('order', 'order'), tenantId: 'other' }, amountMinor: 100, businessDate: '2026-11-02', allocations: [] }, 'finance-a'), { code: 'OBJECT_SCOPE_MISMATCH' });
    f.execute({ type: 'receipt.prepare', id: 'r', order: f.ref('order', 'order'), amountMinor: 100, businessDate: '2026-11-02', allocations: [] }, 'finance-a');
    f.execute({ type: 'receipt.confirm', id: 'r', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'r')) }, 'finance-b');
    assert.throws(() => f.execute({ type: 'refund.prepare', id: 'bad', receipt: f.ref('receipt', 'r'), amountMinor: 100, businessDate: '2026-11-01', releasedAllocations: [] }, 'finance-a'), { code: 'REDUCTION_DATE_INVALID' });
    assert.throws(() => f.execute({ type: 'receipt.cancel', id: 'r', expectedStreamVersion: 2 }, 'finance-a'), { code: 'BUSINESS_STATE_CONFLICT' });
});
test('已批准变更不能取消；并发陈旧版本不能重新确认或覆盖项目范围', () => {
    const f = project();
    f.execute({ type: 'change_request.prepare', id: 'c', project: f.ref('project', 'project'), description: '变更' }, 'project-owner');
    f.execute({ type: 'change_request.price', id: 'c', expectedStreamVersion: 1, lines: [{ orderLineId: 'line-1', quantity: 11 }] }, 'maker');
    f.execute({ type: 'change_request.approve', id: 'c', expectedStreamVersion: 2, evidence: f.proof(f.ref('change_request', 'c')) }, 'manager');
    assert.throws(() => f.execute({ type: 'change_request.cancel', id: 'c', expectedStreamVersion: 3 }, 'project-owner'), { code: 'BUSINESS_STATE_CONFLICT' });
    assert.throws(() => f.execute({ type: 'change_request.project_confirm', id: 'c', expectedStreamVersion: 2, milestones: [] }, 'project-owner'), { code: 'STREAM_VERSION_CONFLICT' });
    assert.throws(() => f.execute({ type: 'change_request.project_confirm', id: 'c', expectedStreamVersion: 3, milestones: [{milestone:f.ref('milestone','m'),expectedStreamVersion:1,lines:[{lineId:'line-1',quantity:12}]}] }, 'project-owner'), { code: 'MILESTONE_QUANTITY_EXCEEDED' });
});
test('日期查询保留变更前承诺与金额；当前成本确认不改历史毛利口径',()=>{
 const f=project();f.execute({type:'project.costs.confirm',id:'project',expectedStreamVersion:1,evidence:f.proof(f.ref('project','project')),expenseRefs:[],zeroCost:true},'finance-b');
 f.execute({type:'change_request.prepare',id:'c',project:f.ref('project','project'),description:'增加数量'},'project-owner');f.execute({type:'change_request.price',id:'c',expectedStreamVersion:1,lines:[{orderLineId:'line-1',quantity:12}]},'maker');f.execute({type:'change_request.approve',id:'c',expectedStreamVersion:2,evidence:f.proof(f.ref('change_request','c'))},'manager');f.execute({type:'change_request.project_confirm',id:'c',expectedStreamVersion:3,milestones:[{milestone:f.ref('milestone','m'),expectedStreamVersion:1,lines:[{lineId:'line-1',quantity:12}]}]},'project-owner');
 f.execute({type:'project.costs.confirm',id:'project',expectedStreamVersion:4,evidence:f.proof(f.ref('project','project')),expenseRefs:[],zeroCost:true},'finance-b');
 assert.equal(projectProgress(f.state(),'project','2026-11-01').lines[0]!.promised,10);assert.equal(orderFinancials(f.state(),'order','2026-11-01').totalMinor,1000000);assert.equal(projectCosts(f.state(),'project','2026-11-01').marginMinor,1000000);assert.equal(projectCosts(f.state(),'project').marginMinor,1200000);
});
test('待分配现金须单独批准分配，不产生第二次到账或跨订单抵扣',()=>{
 const f=project();f.execute({type:'receipt.prepare',id:'r',order:f.ref('order','order'),amountMinor:200000,businessDate:'2026-11-02',allocations:[]},'finance-a');f.execute({type:'receipt.confirm',id:'r',expectedStreamVersion:1,evidence:f.proof(f.ref('receipt','r'))},'finance-b');
 f.execute({type:'payment_schedule.create',id:'s',order:f.ref('order','order'),amountMinor:1000000,dueDate:'2026-11-02'},'finance-a');f.execute({type:'payment_schedule.confirm',id:'s',expectedStreamVersion:1,evidence:f.proof(f.ref('payment_schedule','s'))},'finance-b');
 for(const [id,amountMinor] of [['allocate',150000],['excess',100000]] as const){f.execute({type:'adjustment.prepare',id,kind:'receipt_allocation',receipt:f.ref('receipt','r'),schedule:f.ref('payment_schedule','s'),amountMinor,businessDate:'2026-11-02',reason:'分配到账'},'finance-a');if(id==='allocate')f.execute({type:'adjustment.confirm',id,expectedStreamVersion:1,evidence:f.proof(f.ref('adjustment',id))},'finance-b');else assert.throws(()=>f.execute({type:'adjustment.confirm',id,expectedStreamVersion:1,evidence:f.proof(f.ref('adjustment',id))},'finance-b'),{code:'PAYMENT_ALLOCATION_EXCEEDED'});}
 const balance=orderFinancials(f.state(),'order','2026-11-02');assert.equal(balance.grossReceivedMinor,200000);assert.equal(balance.unallocatedMinor,50000);assert.equal(balance.outstandingMinor,850000);
});
