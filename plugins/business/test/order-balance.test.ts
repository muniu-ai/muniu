// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveOrderBalance } from '../src/order-balance.js';
const base = () => ({ orderId: 'order', totalMinor: 1000000, asOfDate: '2026-11-02',
    schedules: [{ id: 'first', orderId: 'order', amountMinor: 400000, dueDate: '2026-11-02' }, { id: 'second', orderId: 'order', amountMinor: 600000, dueDate: '2026-12-02' }],
    receipts: [] as any[], refunds: [] as any[], reversals: [] as any[], writeOffs: [] as any[] });
test('分期部分回款区分本期与整单余额，未分配款不抵扣其他账期', () => {
    const input = base();
    input.receipts.push({ id: 'receipt', orderId: 'order', status: 'confirmed', amountMinor: 100000, allocations: [{ scheduleId: 'first', amountMinor: 100000 }] });
    const result = deriveOrderBalance(input);
    assert.equal(result.periods[0]!.outstandingMinor, 300000);
    assert.equal(result.outstandingMinor, 900000);
    assert.equal(result.dueMinor, 300000);
    input.receipts.push({ id: 'unallocated', orderId: 'order', status: 'confirmed', amountMinor: 50000, allocations: [] });
    const pending = deriveOrderBalance(input);
    assert.equal(pending.unallocatedMinor, 50000);
    assert.equal(pending.outstandingMinor, 900000);
});
test('实际退款与错误入账冲销分别保留，净收款与未核销余额守恒', () => {
    const input = base();
    input.receipts.push({ id: 'receipt', orderId: 'order', status: 'confirmed', amountMinor: 400000, allocations: [{ scheduleId: 'first', amountMinor: 400000 }] });
    input.refunds.push({ id: 'refund', orderId: 'order', receiptId: 'receipt', status: 'confirmed', amountMinor: 100000, releasedAllocations: [{ scheduleId: 'first', amountMinor: 100000 }] });
    const result = deriveOrderBalance(input);
    assert.equal(result.netReceivedMinor, 300000);
    assert.equal(result.outstandingMinor, 700000);
    assert.equal(result.refundedMinor, 100000);
    assert.equal(result.reversedMinor, 0);
    input.reversals.push({ id: 'reverse', orderId: 'order', receiptId: 'receipt', status: 'confirmed', amountMinor: 50000, releasedAllocations: [{ scheduleId: 'first', amountMinor: 50000 }] });
    const corrected = deriveOrderBalance(input);
    assert.equal(corrected.netReceivedMinor, 250000);
    assert.equal(corrected.refundedMinor, 100000);
    assert.equal(corrected.reversedMinor, 50000);
});
test('超额到账只形成待分配款，超分配、跨订单、超退款和重复事实均拒绝', () => {
    const input = base();
    input.receipts.push({ id: 'receipt', orderId: 'order', status: 'confirmed', amountMinor: 1200000, allocations: [{ scheduleId: 'first', amountMinor: 400000 }, { scheduleId: 'second', amountMinor: 600000 }] });
    const result = deriveOrderBalance(input);
    assert.equal(result.outstandingMinor, 0);
    assert.equal(result.unallocatedMinor, 200000);
    const over = structuredClone(input);
    over.receipts[0].allocations[0].amountMinor = 500000;
    assert.throws(() => deriveOrderBalance(over), { code: 'PAYMENT_ALLOCATION_EXCEEDED' });
    const foreign = structuredClone(input);
    foreign.receipts[0].orderId = 'other';
    assert.throws(() => deriveOrderBalance(foreign), { code: 'LEDGER_SCOPE_MISMATCH' });
    const duplicate = structuredClone(input);
    duplicate.receipts.push(duplicate.receipts[0]);
    assert.throws(() => deriveOrderBalance(duplicate), { code: 'DUPLICATE_LEDGER_FACT' });
    input.refunds.push({ id: 'refund', orderId: 'order', receiptId: 'receipt', status: 'confirmed', amountMinor: 1200001, releasedAllocations: [] });
    assert.throws(() => deriveOrderBalance(input), { code: 'RECEIPT_REDUCTION_EXCEEDED' });
});
test('减免减少应收，不伪造退款或现金；草稿不影响正式余额', () => {
    const input = base();
    input.receipts.push({ id: 'draft', orderId: 'order', status: 'draft', amountMinor: 900000, allocations: [{ scheduleId: 'first', amountMinor: 900000 }] });
    input.writeOffs.push({ id: 'waiver', orderId: 'order', status: 'confirmed', scheduleId: 'first', amountMinor: 100000 });
    const result = deriveOrderBalance(input);
    assert.equal(result.outstandingMinor, 900000);
    assert.equal(result.netReceivedMinor, 0);
    assert.equal(result.refundedMinor, 0);
    assert.equal(result.periods[0]!.outstandingMinor, 300000);
    input.writeOffs.push({ id: 'excess', orderId: 'order', status: 'confirmed', scheduleId: 'first', amountMinor: 400000 });
    assert.throws(() => deriveOrderBalance(input), { code: 'PAYMENT_ALLOCATION_EXCEEDED' });
});
