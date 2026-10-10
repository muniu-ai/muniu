// SPDX-License-Identifier: Apache-2.0
import { ExecutionBudgetExceededError, type Execution } from '@mn/contracts';
import type { RuntimeRecord } from '@mn/agent-runtime';
import { coordinationCounterRemaining, KernelError, reserveCoordinationCounterInTransaction, type KernelTransaction } from '@mn/kernel';

export function remainingCodingRepairs(tx: KernelTransaction, execution: Execution, limit: number, localUsed: number): number {
  return Math.max(0, Math.min(limit - localUsed, coordinationCounterRemaining(tx, execution, 'coding_repair', limit) ?? limit));
}
export function reserveCodingRepairBudget(tx: KernelTransaction, execution: Execution, records: readonly RuntimeRecord[], occurredAt: string): void {
  for (const record of records) if (record.type === 'budget/reserved' && record.payload.kind === 'coding_repair') {
    if (record.executionId !== execution.id || typeof record.payload.id !== 'string' || !Number.isSafeInteger(record.payload.limit)) throw new Error('修复计数记录无效');
    try { reserveCoordinationCounterInTransaction(tx, execution, { kind: 'coding_repair', id: record.payload.id, limit: Number(record.payload.limit) }, occurredAt); }
    catch (error) { if (error instanceof KernelError && error.code === 'COORDINATION_COUNTER_EXCEEDED') throw new ExecutionBudgetExceededError('coding_repair'); throw error; }
  }
}
