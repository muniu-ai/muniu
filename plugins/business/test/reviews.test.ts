// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { businessFixture } from './fixtures/business.js';
test('经营目标固定期间、负责人和算法版本；复盘区分期内流量与期末余额，迟到事实产生新版本', () => {
    const f = businessFixture();
    f.order();
    const metric = f.execute({ type: 'metric.publish', id: 'net-cash', metric: 'net_received', title: '净到账' }, 'manager');
    const objective = f.execute({ type: 'objective.create', id: 'goal', order: f.ref('order', 'order'), metric: metric.reference, periodStart: '2026-11-02', periodEnd: '2026-11-02', targetMinor: 50000 }, 'manager');
    f.execute({ type: 'receipt.prepare', id: 'prior', order: f.ref('order', 'order'), amountMinor: 10000, businessDate: '2026-11-01', allocations: [] }, 'finance-a');
    f.execute({ type: 'receipt.confirm', id: 'prior', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'prior')) }, 'finance-b');
    f.execute({ type: 'receipt.prepare', id: 'current', order: f.ref('order', 'order'), amountMinor: 20000, businessDate: '2026-11-02', allocations: [] }, 'finance-a');
    f.execute({ type: 'receipt.confirm', id: 'current', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'current')) }, 'finance-b');
    const review = f.execute({ type: 'business_review.snapshot', id: 'review', order: f.ref('order', 'order'), periodStart: '2026-11-02', periodEnd: '2026-11-02', includeCosts: false, objective: objective.reference }, 'finance-b');
    const metrics = review.value.financialMetrics as any;
    assert.equal(metrics.netReceivedMinor, 30000);
    assert.equal(metrics.period.netReceivedMinor, 20000);
    assert.equal((review.value.objectiveResult as any).actualMinor, 20000);
    assert.throws(() => f.execute({ type: 'metric.publish', id: 'bad', metric: 'made_up', title: '模型自定义' }, 'manager'));
    f.execute({ type: 'receipt.prepare', id: 'late', order: f.ref('order', 'order'), amountMinor: 30000, businessDate: '2026-11-02', allocations: [] }, 'finance-a');
    f.execute({ type: 'receipt.confirm', id: 'late', expectedStreamVersion: 1, evidence: f.proof(f.ref('receipt', 'late')) }, 'finance-b');
    assert.deepEqual(f.state().objects.get('business_review:review'), review);
    const next = f.execute({ type: 'business_review.snapshot', id: 'review-new', order: f.ref('order', 'order'), periodStart: '2026-11-02', periodEnd: '2026-11-02', includeCosts: false, objective: objective.reference }, 'finance-b');
    assert.equal((next.value.objectiveResult as any).actualMinor, 50000);
});
test('成本目标和结果仅放入成本字段，不混入公开或价格指标', () => {
    const f = businessFixture();
    f.order();
    const metric = f.execute({ type: 'metric.publish', id: 'cost', metric: 'confirmed_cost', title: '支出' }, 'manager');
    const objective = f.execute({ type: 'objective.create', id: 'cost-goal', order: f.ref('order', 'order'), metric: metric.reference, periodStart: '2026-11-02', periodEnd: '2026-11-02', targetMinor: 500 }, 'finance-b');
    assert.equal(objective.value.targetMinor, undefined);
    assert.equal(objective.value.costTargetMinor, 500);
    assert.throws(() => f.execute({ type: 'business_review.snapshot', id: 'denied', order: f.ref('order', 'order'), periodStart: '2026-11-02', periodEnd: '2026-11-02', includeCosts: false, objective: objective.reference }, 'finance-b'), { code: 'COST_SCOPE_REQUIRED' });
    const review = f.execute({ type: 'business_review.snapshot', id: 'cost-review', order: f.ref('order', 'order'), periodStart: '2026-11-02', periodEnd: '2026-11-02', includeCosts: true, objective: objective.reference }, 'finance-b');
    assert.equal(review.value.objectiveResult, undefined);
    assert.equal((review.value.costMetrics as any).objectiveResult.actualMinor, 0);
    assert.equal((review.value.costMetrics as any).marginMinor, null);
});
