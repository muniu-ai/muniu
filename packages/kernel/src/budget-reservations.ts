// SPDX-License-Identifier: Apache-2.0
import type { BudgetAccountV1, BudgetAmountV1, BudgetReservationV1, Principal, WorkspaceMembership } from '@mn/contracts';
import { sha256 } from './canonical.js';
import { KernelError } from './errors.js';
import { appendKernelEvent } from './projections.js';
import type { KernelTransaction } from './store.js';
export interface BudgetContext { readonly tenantId: string; readonly workspaceId: string; readonly principalId: string; readonly occurredAt: string; }
const fail = (code: string): never => {
  const messages: Record<string, string> = {
    BUDGET_EXCEEDED: '可用预算不足、已超额或已到期', BUDGET_RECONCILIATION_REQUIRED: '执行或费用尚未核对，不能释放预留',
    BUDGET_ACCOUNT_CONFLICT: '预算范围已有不同配置，不能重置额度', BUDGET_SETTLEMENT_CONFLICT: '该预留已有不同结算记录',
    BUDGET_COMMITMENT_EXISTS: '该操作已有执行承诺，不能再次执行', BUDGET_AUTHORIZATION_REVOKED: '预算责任人的当前权限已撤销',
    BUDGET_SCOPE_MISMATCH: '预算与当前责任人、范围或币种不一致',
  };
  throw new KernelError(code, messages[code] ?? '预算操作未通过格式、范围或状态检查', '核对当前预算、用量与授权');
};
function amount(value: BudgetAmountV1): void {
  if (!value || !Number.isSafeInteger(value.tokens) || value.tokens < 0 || !/^(0|[1-9]\d{0,29})$/u.test(value.costMinorUnits)
    || !/^[A-Z]{3}$/u.test(value.currency)) fail('BUDGET_INVALID');
}
function time(value: string): void { if (!Number.isFinite(Date.parse(value))) fail('BUDGET_TIME_INVALID'); }
function actor(tx: KernelTransaction, context: BudgetContext): void {
  time(context.occurredAt);
  const principal = tx.getProjection<Principal>('principal', context.principalId);
  const membership = tx.getProjection<WorkspaceMembership>('membership', `${context.workspaceId}:${context.principalId}`);
  if (!principal || principal.tenantId !== context.tenantId || principal.disabledAt || !membership || membership.tenantId !== context.tenantId
    || membership.workspaceId !== context.workspaceId || membership.principalId !== context.principalId || membership.removedAt
    || !['owner', 'operator'].includes(membership.workspaceRole)) fail('BUDGET_AUTHORIZATION_REVOKED');
}
function write(tx: KernelTransaction, namespace: 'budget.account' | 'budget.reservation', value: BudgetAccountV1 | BudgetReservationV1,
  actorId: string, type: string): void {
  tx.putProjection(namespace, value.id, value);
  appendKernelEvent(tx, { tenantId: value.tenantId, aggregateType: namespace, aggregateId: value.id, expectedStreamVersion: value.streamVersion - 1,
    type, actorId, generation: 0, correlationId: value.id, publicPayload: { workspaceId: value.workspaceId } });
}
function account(tx: KernelTransaction, context: BudgetContext, id: string): BudgetAccountV1 {
  const value = tx.getProjection<BudgetAccountV1>('budget.account', id);
  if (!value || value.tenantId !== context.tenantId || value.workspaceId !== context.workspaceId) fail('BUDGET_ACCOUNT_NOT_FOUND');
  return value!;
}
function chain(tx: KernelTransaction, context: BudgetContext, leaf: BudgetAccountV1): BudgetAccountV1[] {
  const result: BudgetAccountV1[] = []; let next: BudgetAccountV1 | undefined = leaf;
  while (next) {
    if (result.length >= 8 || result.some(item => item.id === next!.id) || next.limit.currency !== leaf.limit.currency) fail('BUDGET_ACCOUNT_CHAIN_INVALID');
    result.push(next); next = next.parentAccountId ? account(tx, context, next.parentAccountId) : undefined;
  }
  return result;
}
function tokens(value: number): number { if (!Number.isSafeInteger(value) || value < 0) fail('BUDGET_COUNTER_RANGE'); return value; }
function cost(value: bigint): string { if (value < 0n || value.toString().length > 30) fail('BUDGET_COUNTER_RANGE'); return value.toString(); }
export function createBudgetAccount(tx: KernelTransaction, input: BudgetContext & {
  readonly scope: { readonly namespace: string; readonly resourceId: string }; readonly parentAccountId?: string;
  readonly limit: BudgetAmountV1; readonly expiresAt: string;
}): BudgetAccountV1 {
  actor(tx, input); amount(input.limit); time(input.expiresAt);
  if (input.parentAccountId !== undefined && !input.parentAccountId) fail('BUDGET_PARENT_INVALID');
  if (!input.scope.namespace || !input.scope.resourceId || Date.parse(input.expiresAt) <= Date.parse(input.occurredAt)) fail('BUDGET_INVALID');
  const id = `budget:${sha256({ tenantId: input.tenantId, workspaceId: input.workspaceId, scope: input.scope })}`;
  const configurationDigest = sha256({ scope: input.scope, principalId: input.principalId, limit: input.limit, expiresAt: input.expiresAt, parentAccountId: input.parentAccountId });
  const existing = tx.getProjection<BudgetAccountV1>('budget.account', id);
  if (existing) {
    if (existing.configurationDigest !== configurationDigest) fail('BUDGET_ACCOUNT_CONFLICT');
    return existing;
  }
  if (input.parentAccountId) {
    const parent = account(tx, input, input.parentAccountId);
    if (parent.status !== 'active' || parent.overrun || parent.limit.currency !== input.limit.currency || input.limit.tokens > parent.limit.tokens
      || BigInt(input.limit.costMinorUnits) > BigInt(parent.limit.costMinorUnits) || Date.parse(input.expiresAt) > Date.parse(parent.expiresAt)) fail('BUDGET_PARENT_INVALID');
  }
  const value: BudgetAccountV1 = { id, tenantId: input.tenantId, workspaceId: input.workspaceId, principalId: input.principalId,
    scope: structuredClone(input.scope), ...(input.parentAccountId ? { parentAccountId: input.parentAccountId } : {}), limit: structuredClone(input.limit),
    expiresAt: input.expiresAt, configurationDigest, heldTokens: 0, heldCostMinorUnits: '0', spentTokens: 0, spentCostMinorUnits: '0',
    status: 'active', overrun: false, streamVersion: 1, createdAt: input.occurredAt, updatedAt: input.occurredAt };
  write(tx, 'budget.account', value, input.principalId, 'budget.account_created'); return value;
}
export function reserveBudget(tx: KernelTransaction, input: BudgetContext & { readonly accountId: string; readonly operationKey: string; readonly amount: BudgetAmountV1 }): BudgetReservationV1 {
  actor(tx, input); amount(input.amount);
  if (!input.operationKey || input.operationKey.length > 500) fail('BUDGET_OPERATION_INVALID');
  const leaf = account(tx, input, input.accountId);
  if (leaf.principalId !== input.principalId || leaf.limit.currency !== input.amount.currency) fail('BUDGET_SCOPE_MISMATCH');
  const id = `reservation:${sha256({ accountId: input.accountId, operationKey: input.operationKey })}`;
  const existing = tx.getProjection<BudgetReservationV1>('budget.reservation', id);
  if (existing) {
    if (sha256(existing.amount) !== sha256(input.amount) || existing.accountId !== input.accountId) fail('BUDGET_RESERVATION_CONFLICT');
    return existing;
  }
  const accounts = chain(tx, input, leaf);
  for (const current of accounts) {
    if (current.status !== 'active' || current.overrun || Date.parse(current.expiresAt) <= Date.parse(input.occurredAt)
      || BigInt(current.spentTokens) + BigInt(current.heldTokens) + BigInt(input.amount.tokens) > BigInt(current.limit.tokens)
      || BigInt(current.spentCostMinorUnits) + BigInt(current.heldCostMinorUnits) + BigInt(input.amount.costMinorUnits) > BigInt(current.limit.costMinorUnits)) fail('BUDGET_EXCEEDED');
  }
  for (const current of accounts) write(tx, 'budget.account', { ...current, heldTokens: tokens(current.heldTokens + input.amount.tokens),
    heldCostMinorUnits: cost(BigInt(current.heldCostMinorUnits) + BigInt(input.amount.costMinorUnits)), streamVersion: current.streamVersion + 1,
    updatedAt: input.occurredAt }, input.principalId, 'budget.amount_reserved');
  const value: BudgetReservationV1 = { id, tenantId: input.tenantId, workspaceId: input.workspaceId, accountId: input.accountId,
    accountChain: accounts.map(item => item.id), operationKey: input.operationKey, amount: structuredClone(input.amount), status: 'reserved',
    streamVersion: 1, createdAt: input.occurredAt, updatedAt: input.occurredAt };
  write(tx, 'budget.reservation', value, input.principalId, 'budget.reservation_created'); return value;
}
interface ReservationContext extends BudgetContext { readonly reservationId: string; readonly operationKey: string; }
function reservation(tx: KernelTransaction, input: ReservationContext): BudgetReservationV1 {
  time(input.occurredAt);
  const value = tx.getProjection<BudgetReservationV1>('budget.reservation', input.reservationId);
  if (!value || value.tenantId !== input.tenantId || value.workspaceId !== input.workspaceId || value.operationKey !== input.operationKey) fail('BUDGET_RESERVATION_NOT_FOUND');
  const currentChain = chain(tx, input, account(tx, input, value!.accountId));
  if (sha256(currentChain.map(item => item.id)) !== sha256(value!.accountChain)) fail('BUDGET_ACCOUNT_CHAIN_INVALID');
  return value!;
}
function status(tx: KernelTransaction, current: BudgetReservationV1, input: ReservationContext, next: BudgetReservationV1['status']): BudgetReservationV1 {
  const value = { ...current, status: next, streamVersion: current.streamVersion + 1, updatedAt: input.occurredAt };
  write(tx, 'budget.reservation', value, input.principalId, `budget.reservation_${next}`); return value;
}
export function assertBudgetReservationReady(tx: KernelTransaction, input: ReservationContext): BudgetReservationV1 {
  actor(tx, input); const value = reservation(tx, input);
  if (account(tx, input, value.accountId).principalId !== input.principalId) fail('BUDGET_SCOPE_MISMATCH');
  if (value.status !== 'reserved') fail('BUDGET_COMMITMENT_EXISTS');
  for (const id of value.accountChain) {
    const current = account(tx, input, id);
    if (current.status !== 'active' || current.overrun || Date.parse(current.expiresAt) <= Date.parse(input.occurredAt)) fail('BUDGET_EXCEEDED');
  }
  return value;
}
export function commitBudgetReservation(tx: KernelTransaction, input: ReservationContext): BudgetReservationV1 {
  const value = assertBudgetReservationReady(tx, input);
  return status(tx, value, input, 'committed');
}
/** Internal accounting after a fenced attempt; recording a result never authorizes its disclosure. */
export function markBudgetUnknown(tx: KernelTransaction, input: ReservationContext): BudgetReservationV1 {
  const value = reservation(tx, input);
  if (value.status === 'unknown') return value;
  if (value.status !== 'committed') fail('BUDGET_STATE_CONFLICT');
  return status(tx, value, input, 'unknown');
}
export function settleBudget(tx: KernelTransaction, input: ReservationContext & { readonly usage: BudgetAmountV1; readonly evidenceDigest: string }): BudgetReservationV1 {
  const value = reservation(tx, input); amount(input.usage);
  if (input.usage.currency !== value.amount.currency || !/^[0-9a-f]{64}$/u.test(input.evidenceDigest)) fail('BUDGET_EVIDENCE_INVALID');
  if (value.status === 'settled') {
    if (sha256(value.usage) !== sha256(input.usage) || value.evidenceDigest !== input.evidenceDigest) fail('BUDGET_SETTLEMENT_CONFLICT');
    return value;
  }
  if (!['committed', 'unknown'].includes(value.status)) fail('BUDGET_STATE_CONFLICT');
  for (const id of value.accountChain) {
    const current = account(tx, input, id);
    const heldTokens = tokens(current.heldTokens - value.amount.tokens), spentTokens = tokens(current.spentTokens + input.usage.tokens);
    const heldCostMinorUnits = cost(BigInt(current.heldCostMinorUnits) - BigInt(value.amount.costMinorUnits));
    const spentCostMinorUnits = cost(BigInt(current.spentCostMinorUnits) + BigInt(input.usage.costMinorUnits));
    const overrun = current.overrun || BigInt(heldTokens) + BigInt(spentTokens) > BigInt(current.limit.tokens)
      || BigInt(heldCostMinorUnits) + BigInt(spentCostMinorUnits) > BigInt(current.limit.costMinorUnits)
      || (id === value.accountId && (input.usage.tokens > value.amount.tokens || BigInt(input.usage.costMinorUnits) > BigInt(value.amount.costMinorUnits)));
    write(tx, 'budget.account', { ...current, heldTokens, heldCostMinorUnits, spentTokens, spentCostMinorUnits, overrun,
      streamVersion: current.streamVersion + 1, updatedAt: input.occurredAt }, input.principalId, 'budget.amount_settled');
  }
  const next: BudgetReservationV1 = { ...value, status: 'settled', usage: structuredClone(input.usage), evidenceDigest: input.evidenceDigest,
    streamVersion: value.streamVersion + 1, updatedAt: input.occurredAt };
  write(tx, 'budget.reservation', next, input.principalId, 'budget.reservation_settled'); return next;
}
export function releaseBudget(tx: KernelTransaction, input: ReservationContext): BudgetReservationV1 {
  const value = reservation(tx, input);
  if (value.status === 'released') return value;
  if (value.status !== 'reserved') fail('BUDGET_RECONCILIATION_REQUIRED');
  for (const id of value.accountChain) {
    const current = account(tx, input, id);
    write(tx, 'budget.account', { ...current, heldTokens: tokens(current.heldTokens - value.amount.tokens),
      heldCostMinorUnits: cost(BigInt(current.heldCostMinorUnits) - BigInt(value.amount.costMinorUnits)), streamVersion: current.streamVersion + 1,
      updatedAt: input.occurredAt }, input.principalId, 'budget.amount_released');
  }
  return status(tx, value, input, 'released');
}
export function closeBudgetAccount(tx: KernelTransaction, input: BudgetContext & { readonly accountId: string }): BudgetAccountV1 {
  actor(tx, input); const current = account(tx, input, input.accountId);
  if (current.principalId !== input.principalId) fail('BUDGET_SCOPE_MISMATCH');
  if (current.status === 'closed') return current;
  const next: BudgetAccountV1 = { ...current, status: 'closed', streamVersion: current.streamVersion + 1, updatedAt: input.occurredAt };
  write(tx, 'budget.account', next, input.principalId, 'budget.account_closed'); return next;
}
