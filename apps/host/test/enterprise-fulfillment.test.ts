// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/business.js';
test('订单授权传递到项目交付和资金；财务不能编辑范围、项目人员不能读取价格', async (t) => {
    const f = await fixture(t), order = await f.order();
    const project = await f.command({ type: 'project.create', id: 'project', order: order.reference, title: '项目' }, 'project');
    assert.equal((await f.get('order', 'order', 'project')).values.totalMinor, undefined);
    const milestone = await f.command({ type: 'milestone.create', id: 'm', project: project.reference, title: '阶段', dueDate: '2026-11-02', lines: [{ lineId: 'line-1', quantity: 3 }] }, 'project');
    await assert.rejects(f.command({ type: 'milestone.create', id: 'foreign', project: project.reference, title: '越权', dueDate: '2026-11-02', lines: [{ lineId: 'line-1', quantity: 1 }] }, 'finance-a'), { code: 'OBJECT_ACCESS_DENIED' });
    await f.command({ type: 'delivery.report', id: 'delivery', milestone: milestone.reference, summary: '两项成果', lines: [{ lineId: 'line-1', quantity: 2 }] }, 'project');
    const delivery = await f.command({ type: 'delivery.receive', id: 'delivery', expectedStreamVersion: 1 }, 'project');
    await f.command({ type: 'acceptance.prepare', id: 'a', delivery: delivery.reference, lines: [{ lineId: 'line-1', quantity: 1 }] }, 'project');
    await f.command({ type: 'acceptance.confirm', id: 'a', expectedStreamVersion: 1, evidence: await f.proof('customer_acceptance', 'a', 'reviewer') }, 'reviewer');
    await f.command({ type: 'payment_schedule.create', id: 's', order: order.reference, amountMinor: 30000, dueDate: '2026-11-02' }, 'finance-a');
    await f.command({ type: 'payment_schedule.confirm', id: 's', expectedStreamVersion: 1, evidence: await f.proof('payment_schedule', 's', 'finance-b') }, 'finance-b');
    const schedule = await f.get('payment_schedule', 's', 'finance-a');
    for (const id of ['r1', 'r2'])
        await f.command({ type: 'receipt.prepare', id, order: order.reference, amountMinor: 20000, businessDate: '2026-11-02', allocations: [{ schedule: schedule.reference, amountMinor: 20000 }] }, 'finance-a');
    const p1 = await f.proof('receipt', 'r1', 'finance-b'), p2 = await f.proof('receipt', 'r2', 'finance-b');
    const results = await Promise.allSettled([f.service, f.newService()].map((service, i) => service.execute({ actor: f.actor('finance-b'), actorKind: 'human', workspaceId: f.workspace.id, idempotencyKey: 'race-' + i, command: { type: 'receipt.confirm', id: i ? 'r2' : 'r1', expectedStreamVersion: 1, evidence: i ? p2 : p1 } })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'PAYMENT_ALLOCATION_EXCEEDED');
    assert.equal((await f.service.list(f.actor('finance-b'), f.workspace.id, 'receipt')).filter(r => r.values.status === 'confirmed').length, 1);
    await f.permissions.revoke(f.admin, 'revoke-project', 'role', 'project', 1);
    await assert.rejects(f.get('delivery_version', 'delivery', 'project'), { code: 'OBJECT_ACCESS_DENIED' });
});
test('财务只读与批准权限可登记成本证据；成本和毛利对无成本权限人员隐藏', async (t) => {
    const f = await fixture(t), order = await f.order();
    await f.command({ type: 'project.create', id: 'project', order: order.reference, title: '项目' }, 'project');
    await f.command({ type: 'project.costs.confirm', id: 'project', expectedStreamVersion: 1, evidence: await f.proof('project', 'project', 'finance-b'), expenseRefs: [], zeroCost: true }, 'finance-b');
    const review = await f.command({ type: 'business_review.snapshot', id: 'review', order: order.reference, periodStart: '2026-11-01', periodEnd: '2026-11-02', includeCosts: true }, 'finance-b');
    assert.equal((review.values.costMetrics as any).marginMinor, 30000);
    assert.equal((await f.get('business_review', 'review', 'viewer')).values.costMetrics, undefined);
    assert.equal((await f.get('business_review', 'review', 'viewer')).values.financialMetrics, undefined);
});
test('复盘读取重验来源权限，失去订单范围后不能从自有复盘读出历史金额', async (t) => {
    const f = await fixture(t), order = await f.order();
    await f.permissions.grantRole(f.admin, 'own-review', { id: 'own-review', workspaceId: f.workspace.id, principalId: 'finance-b', role: 'finance', scope: { kind: 'owned' }, operations: ['read', 'write'], fieldClasses: ['public', 'price', 'cost'], expiresAt: '2027-01-01T00:00:00.000Z' });
    await f.command({ type: 'business_review.snapshot', id: 'review', order: order.reference, periodStart: '2026-11-01', periodEnd: '2026-11-02', includeCosts: false }, 'finance-b');
    await f.permissions.revoke(f.admin, 'revoke-finance', 'role', 'finance-b', 1);
    const view = await f.get('business_review', 'review', 'finance-b');
    assert.equal(view.values.financialMetrics, undefined);
    assert.equal(view.values.financialSources, undefined);
});
test('确认在异步持久化期间权限到期时不落事实，已批准幂等重放仍受撤权约束', async (t) => {
    const f = await fixture(t), order = await f.order();
    await f.command({ type: 'receipt.prepare', id: 'r', order: order.reference, amountMinor: 100, businessDate: '2026-11-02', allocations: [] }, 'finance-a');
    const proof = await f.proof('receipt', 'r', 'finance-b');
    const put = f.cas.put.bind(f.cas);
    let once = true;
    f.cas.put = async (bytes) => { const value = await put(bytes); if (once) {
        once = false;
        f.advance('2027-01-02T01:00:00.000Z');
    } return value; };
    await assert.rejects(f.command({ type: 'receipt.confirm', id: 'r', expectedStreamVersion: 1, evidence: proof }, 'finance-b'), { code: 'OBJECT_ACCESS_DENIED' });
    assert.equal((await f.repository.read('tenant')).filter(e => e.type === 'enterprise.business.receipt.confirmed').length, 0);
    f.cas.put = put;
    f.advance('2026-11-02T01:00:00.000Z');
    const cmd = { type: 'receipt.confirm' as const, id: 'r', expectedStreamVersion: 1, evidence: proof };
    await f.command(cmd, 'finance-b', 'confirmed');
    await f.permissions.revoke(f.admin, 'revoke-b', 'role', 'finance-b', 1);
    await assert.rejects(f.command(cmd, 'finance-b', 'confirmed'), { code: 'OBJECT_ACCESS_DENIED' });
});
test('范围变更商业批准与项目确认使用各自权限，旧订单与旧交付可追溯', async (t) => {
    const f = await fixture(t), order = await f.order();
    const project = await f.command({ type: 'project.create', id: 'project', order: order.reference, title: '项目' }, 'project');
    const milestone = await f.command({ type: 'milestone.create', id: 'm', project: project.reference, title: '阶段', dueDate: '2026-11-30', lines: [{ lineId: 'line-1', quantity: 3 }] }, 'project');
    await f.command({ type: 'change_request.prepare', id: 'change', project: project.reference, description: '追加一项' }, 'project');
    await assert.rejects(f.command({ type: 'change_request.price', id: 'change', expectedStreamVersion: 1, lines: [{ orderLineId: 'line-1', quantity: 4 }] }, 'project'), { code: 'FIELD_ACCESS_DENIED' });
    await f.command({ type: 'change_request.price', id: 'change', expectedStreamVersion: 1, lines: [{ orderLineId: 'line-1', quantity: 4 }] }, 'manager');
    await assert.rejects(f.command({ type: 'change_request.approve', id: 'change', expectedStreamVersion: 2, evidence: await f.proof('change_request', 'change', 'manager') }, 'manager'), { code: 'SEPARATION_OF_DUTIES_REQUIRED' });
    await f.permissions.grantRole(f.admin, 'sales-manager', { id: 'sales-manager', workspaceId: f.workspace.id, principalId: 'sales', role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read', 'business_approve'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z' });
    await f.command({ type: 'change_request.approve', id: 'change', expectedStreamVersion: 2, evidence: await f.proof('change_request', 'change', 'manager') }, 'sales');
    await assert.rejects(f.command({ type: 'change_request.project_confirm', id: 'change', expectedStreamVersion: 3, milestones: [{ milestone: milestone.reference, expectedStreamVersion: 1, lines: [{ lineId: 'line-1', quantity: 4 }] }] }, 'manager'), { code: 'OBJECT_ACCESS_DENIED' });
    await f.command({ type: 'change_request.project_confirm', id: 'change', expectedStreamVersion: 3, milestones: [{ milestone: milestone.reference, expectedStreamVersion: 1, lines: [{ lineId: 'line-1', quantity: 4 }] }] }, 'project');
    assert.equal((await f.service.summary(f.actor('project'), f.workspace.id, 'progress', 'project')).values.lines instanceof Array, true);
    assert.equal((await f.get('order', 'order')).values.totalMinor, 40000);
    assert.equal((await f.service.get(f.actor('sales'), f.workspace.id, 'order', 'order', 2)).values.totalMinor, 30000);
});
test('只有成本许可而无价格许可时不能从复盘毛利反推订单金额',async t=>{
 const f=await fixture(t),order=await f.order();await f.command({type:'project.create',id:'project',order:order.reference,title:'项目'},'project');await f.command({type:'project.costs.confirm',id:'project',expectedStreamVersion:1,evidence:await f.proof('project','project','finance-b'),expenseRefs:[],zeroCost:true},'finance-b');await f.command({type:'business_review.snapshot',id:'review',order:order.reference,periodStart:'2026-11-01',periodEnd:'2026-11-02',includeCosts:true},'finance-b');
 await f.permissions.revoke(f.admin,'price-revoke','role','finance-b',1);await f.permissions.grantRole(f.admin,'cost-only',{id:'cost-only',workspaceId:f.workspace.id,principalId:'finance-b',role:'finance',scope:{kind:'workspace'},operations:['read'],fieldClasses:['public','cost'],expiresAt:'2027-01-01T00:00:00.000Z'});
 const review=await f.get('business_review','review','finance-b');assert.equal(review.values.costMetrics,undefined);await assert.rejects(f.service.summary(f.actor('finance-b'),f.workspace.id,'costs','project'),{code:'FIELD_ACCESS_DENIED'});
});
