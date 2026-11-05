// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { businessFixture } from './fixtures/business.js';
import { orderFinancials } from '../src/fulfillment-queries.js';

function setup() {
  const f = businessFixture(); f.advance('2026-11-01T01:00:00.000Z'); f.order();
  f.execute({ type: 'payment_schedule.create', id: 'first', order: f.ref('order', 'order'), amountMinor: 1000000, dueDate: '2026-12-01' }, 'finance-a');
  f.execute({ type: 'payment_schedule.confirm', id: 'first', expectedStreamVersion: 1, evidence: f.proof(f.ref('payment_schedule', 'first')) }, 'finance-b');
  const original = orderFinancials(f.state(), 'order', '2026-11-01');
  f.advance('2026-11-02T01:00:00.000Z');
  f.execute({ type: 'adjustment.prepare', id: 'revise', kind: 'schedule_revision', schedule: f.ref('payment_schedule', 'first'), proposedAmountMinor: 750000, proposedDueDate: '2026-12-01', businessDate: '2026-11-02', reason: '重新安排分期' }, 'finance-a');
  f.execute({ type: 'adjustment.confirm', id: 'revise', expectedStreamVersion: 1, evidence: f.proof(f.ref('adjustment', 'revise')) }, 'finance-b');
  return { ...f, original };
}

test('修订付款期后可在当前日期增加剩余额度，新付款期不能污染更早资金口径', () => {
  const f = setup();
  f.execute({ type: 'payment_schedule.create', id: 'second', order: f.ref('order', 'order'), amountMinor: 250000, dueDate: '2026-12-02' }, 'finance-a');
  f.execute({ type: 'payment_schedule.confirm', id: 'second', expectedStreamVersion: 1, evidence: f.proof(f.ref('payment_schedule', 'second')) }, 'finance-b');
  assert.deepEqual(orderFinancials(f.state(), 'order', '2026-11-01'), f.original);
  const current = orderFinancials(f.state(), 'order', '2026-11-02');
  assert.deepEqual(current.periods.map(period => period.amountMinor).sort((a, b) => a - b), [250000, 750000]);
  assert.equal(current.outstandingMinor, 1000000);
  assert.equal(f.state().objects.get('payment_schedule:second')!.value.businessDate, '2026-11-02');
});

test('明确补录旧日期的付款期仍须通过历史金额校验，拒绝后保留原版本和资金事实', () => {
  const f = setup();
  f.execute({ type: 'payment_schedule.create', id: 'backdated', order: f.ref('order', 'order'), amountMinor: 250000, dueDate: '2026-12-02', businessDate: '2026-11-01' }, 'finance-a');
  const before = structuredClone(f.state()), events = f.events.length;
  assert.throws(() => f.execute({ type: 'payment_schedule.confirm', id: 'backdated', expectedStreamVersion: 1, evidence: f.proof(f.ref('payment_schedule', 'backdated')) }, 'finance-b'), { code: 'PAYMENT_SCHEDULE_EXCEEDED' });
  assert.equal(f.events.length, events); assert.deepEqual(f.state(), before);
  assert.deepEqual(orderFinancials(f.state(), 'order', '2026-11-01'), f.original);
});

test('付款期不得声明尚未发生的生效日期，午夜按北京时间确定默认日期', () => {
  const f = businessFixture(); f.order();
  assert.throws(() => f.execute({ type: 'payment_schedule.create', id: 'future', order: f.ref('order', 'order'), amountMinor: 100, dueDate: '2026-12-01', businessDate: '2026-11-03' }, 'finance-a'), { code: 'BUSINESS_DATE_IN_FUTURE' });
  f.advance('2026-11-02T16:01:00.000Z');
  const period = f.execute({ type: 'payment_schedule.create', id: 'midnight', order: f.ref('order', 'order'), amountMinor: 100, dueDate: '2026-12-01' }, 'finance-a');
  assert.equal(period.value.businessDate, '2026-11-03');
});
