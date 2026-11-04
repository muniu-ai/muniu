// SPDX-License-Identifier: Apache-2.0
import { BusinessDomainError } from './model.js';
export interface PaymentAllocation {
    readonly scheduleId: string;
    readonly amountMinor: number;
}
interface LedgerFact {
    readonly id: string;
    readonly orderId: string;
    readonly status: 'draft' | 'confirmed';
    readonly amountMinor: number;
}
export interface LedgerReceipt extends LedgerFact {
    readonly allocations: readonly PaymentAllocation[];
}
export interface LedgerReduction extends LedgerFact {
    readonly receiptId: string;
    readonly releasedAllocations: readonly PaymentAllocation[];
}
export interface OrderBalanceInput {
    readonly orderId: string;
    readonly totalMinor: number;
    readonly asOfDate: string;
    readonly schedules: readonly {
        readonly id: string;
        readonly orderId: string;
        readonly amountMinor: number;
        readonly dueDate: string;
    }[];
    readonly receipts: readonly LedgerReceipt[];
    readonly refunds: readonly LedgerReduction[];
    readonly reversals: readonly LedgerReduction[];
    readonly writeOffs: readonly (LedgerFact & {
        readonly scheduleId: string;
    })[];
}
function fail(code: string): never { throw new BusinessDomainError(code); }
function amount(value: number, positive = false): bigint {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
        fail('MONEY_OUT_OF_RANGE');
    return BigInt(value);
}
function number(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    fail('MONEY_OUT_OF_RANGE'); return Number(value); }
function date(value: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) || new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) !== value)
        fail('INVALID_BUSINESS_DATE');
}
/** Input is a scoped set of committed business facts, never a client-supplied balance. */
export function deriveOrderBalance(input: OrderBalanceInput) {
    const total = amount(input.totalMinor);
    date(input.asOfDate);
    const ids = new Set<string>();
    const scope = (kind: string, fact: {
        id: string;
        orderId: string;
    }) => {
        if (fact.orderId !== input.orderId)
            fail('LEDGER_SCOPE_MISMATCH');
        if (!fact.id || ids.has(kind + ':' + fact.id))
            fail('DUPLICATE_LEDGER_FACT');
        ids.add(kind + ':' + fact.id);
    };
    const confirmed = (kind: string, fact: LedgerFact) => {
        scope(kind, fact);
        amount(fact.amountMinor, true);
        if (!['draft', 'confirmed'].includes(fact.status))
            fail('INVALID_LEDGER_STATE');
        return fact.status === 'confirmed';
    };
    const schedules = new Map<string, {
        id: string;
        dueDate: string;
        amount: bigint;
        allocated: bigint;
        writeOff: bigint;
    }>(input.schedules.map(schedule => {
        scope('schedule', schedule);
        date(schedule.dueDate);
        return [schedule.id, { id: schedule.id, dueDate: schedule.dueDate, amount: amount(schedule.amountMinor, true), allocated: 0n, writeOff: 0n }] as const;
    }));
    const planned = [...schedules.values()].reduce((sum, period) => sum + period.amount, 0n);
    if (planned > total)
        fail('PAYMENT_SCHEDULE_EXCEEDED');
    const allocations = (entries: readonly PaymentAllocation[]) => {
        const result = new Map<string, bigint>();
        for (const entry of entries) {
            if (!schedules.has(entry.scheduleId))
                fail('LEDGER_SCOPE_MISMATCH');
            if (result.has(entry.scheduleId))
                fail('DUPLICATE_PAYMENT_ALLOCATION');
            result.set(entry.scheduleId, amount(entry.amountMinor, true));
        }
        return result;
    };
    const receipts = new Map<string, {
        amount: bigint;
        remaining: bigint;
        allocations: Map<string, bigint>;
    }>();
    let gross = 0n, refunded = 0n, reversed = 0n, writtenOff = 0n;
    for (const receipt of input.receipts) {
        if (!confirmed('receipt', receipt))
            continue;
        const value = amount(receipt.amountMinor), parts = allocations(receipt.allocations);
        if ([...parts.values()].reduce((sum, value) => sum + value, 0n) > value)
            fail('PAYMENT_ALLOCATION_EXCEEDED');
        receipts.set(receipt.id, { amount: value, remaining: value, allocations: parts });
        gross += value;
    }
    const reduce = (kind: 'refund' | 'reversal', facts: readonly LedgerReduction[]) => {
        let reduced = 0n;
        for (const fact of facts) {
            if (!confirmed(kind, fact))
                continue;
            const receipt = receipts.get(fact.receiptId), value = amount(fact.amountMinor), parts = allocations(fact.releasedAllocations);
            if (!receipt || value > receipt.remaining)
                fail('RECEIPT_REDUCTION_EXCEEDED');
            const released = [...parts.values()].reduce((sum, value) => sum + value, 0n);
            if (released > value)
                fail('RECEIPT_REDUCTION_EXCEEDED');
            for (const [id, part] of parts) {
                const current = receipt.allocations.get(id) ?? 0n;
                if (part > current)
                    fail('RECEIPT_REDUCTION_EXCEEDED');
                receipt.allocations.set(id, current - part);
            }
            receipt.remaining -= value;
            if ([...receipt.allocations.values()].reduce((sum, value) => sum + value, 0n) > receipt.remaining)
                fail('RECEIPT_REDUCTION_EXCEEDED');
            reduced += value;
        }
        return reduced;
    };
    refunded = reduce('refund', input.refunds);
    reversed = reduce('reversal', input.reversals);
    let allocated = 0n;
    for (const receipt of receipts.values())
        for (const [id, value] of receipt.allocations) {
            schedules.get(id)!.allocated += value;
            allocated += value;
        }
    for (const writeOff of input.writeOffs) {
        if (!confirmed('write_off', writeOff))
            continue;
        const period = schedules.get(writeOff.scheduleId);
        if (!period)
            fail('LEDGER_SCOPE_MISMATCH');
        const value = amount(writeOff.amountMinor);
        period.writeOff += value;
        writtenOff += value;
    }
    let due = 0n;
    const periods = [...schedules.values()].map(period => {
        if (period.allocated + period.writeOff > period.amount)
            fail('PAYMENT_ALLOCATION_EXCEEDED');
        const outstanding = period.amount - period.allocated - period.writeOff;
        if (period.dueDate <= input.asOfDate)
            due += outstanding;
        return { id: period.id, dueDate: period.dueDate, amountMinor: number(period.amount), allocatedMinor: number(period.allocated), writtenOffMinor: number(period.writeOff), outstandingMinor: number(outstanding) };
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
    const net = gross - refunded - reversed;
    return { orderId: input.orderId, totalMinor: number(total), grossReceivedMinor: number(gross), refundedMinor: number(refunded), reversedMinor: number(reversed), netReceivedMinor: number(net),
        allocatedMinor: number(allocated), unallocatedMinor: number(net - allocated), writtenOffMinor: number(writtenOff), outstandingMinor: number(total - allocated - writtenOff), dueMinor: number(due), periods };
}
