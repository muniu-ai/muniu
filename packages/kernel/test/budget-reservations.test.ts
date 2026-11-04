// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore, createBudgetAccount, reserveBudget, commitBudgetReservation,
  amendBudgetAccount, markBudgetUnknown, settleBudget, releaseBudget, closeBudgetAccount, replayCoreProjections } from '../src/index.js';
const now = '2026-11-02T01:00:00.000Z', expiry = '2026-11-03T01:00:00.000Z';
async function fixture() {
  const store = new InMemoryKernelStore(Buffer.alloc(32, 42), () => now);
  const kernel = new AgentOsKernel(store, { now: () => now }); await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '预算', viewMode: 'business', pluginIds: ['opc'] });
  const context = { tenantId: 'local', workspaceId: workspace.id, principalId: 'local-owner', occurredAt: now };
  const root = await store.transact('local', tx => createBudgetAccount(tx, { ...context, scope: { namespace: 'tenant-budget', resourceId: 'period' },
    limit: { tokens: 100, costMinorUnits: '100', currency: 'CNY' }, expiresAt: expiry }));
  const child = await store.transact('local', tx => createBudgetAccount(tx, { ...context, parentAccountId: root.id,
    scope: { namespace: 'work-budget', resourceId: 'work-a' }, limit: { tokens: 80, costMinorUnits: '80', currency: 'CNY' }, expiresAt: expiry }));
  return { store, context, root, child };
}

test('子任务共享祖先额度，重复预留不重复扣取，失败事务不留下额度或任务', async () => {
  const f = await fixture();
  const input = { ...f.context, accountId: f.child.id, operationKey: 'node-a', amount: { tokens: 60, costMinorUnits: '60', currency: 'CNY' } };
  const reserve = () => f.store.transact('local', tx => reserveBudget(tx, input));
  const first = await reserve(); assert.deepEqual(await reserve(), first);
  await assert.rejects(f.store.transact('local', tx => reserveBudget(tx, { ...input, operationKey: 'node-b', amount: { tokens: 30, costMinorUnits: '30', currency: 'CNY' } })), { code: 'BUDGET_EXCEEDED' });
  await assert.rejects(f.store.transact('local', tx => { reserveBudget(tx, { ...input, operationKey: 'rollback', amount: { tokens: 10, costMinorUnits: '10', currency: 'CNY' } }); throw new Error('crash'); }), /crash/);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('budget.reservation').length), 1);
  assert.equal((await f.store.transact('local', tx => tx.getProjection<any>('budget.account', f.root.id))).heldCostMinorUnits, '60');
});

test('已经承诺和未知费用不能释放；核对后只结算一次，父子账户同时更新', async () => {
  const f = await fixture();
  const reservation = await f.store.transact('local', tx => reserveBudget(tx, { ...f.context, accountId: f.child.id, operationKey: 'model-call', amount: { tokens: 50, costMinorUnits: '50', currency: 'CNY' } }));
  await f.store.transact('local', tx => commitBudgetReservation(tx, { ...f.context, reservationId: reservation.id, operationKey: 'model-call' }));
  await f.store.transact('local', tx => markBudgetUnknown(tx, { ...f.context, reservationId: reservation.id, operationKey: 'model-call' }));
  await assert.rejects(f.store.transact('local', tx => releaseBudget(tx, { ...f.context, reservationId: reservation.id, operationKey: 'model-call' })), { code: 'BUDGET_RECONCILIATION_REQUIRED' });
  const settled = { ...f.context, reservationId: reservation.id, operationKey: 'model-call', usage: { tokens: 20, costMinorUnits: '25', currency: 'CNY' }, evidenceDigest: 'a'.repeat(64) };
  await f.store.transact('local', tx => settleBudget(tx, settled));
  await f.store.transact('local', tx => settleBudget(tx, settled));
  for (const id of [f.root.id, f.child.id]) {
    const account = await f.store.transact('local', tx => tx.getProjection<any>('budget.account', id));
    assert.equal(account.heldCostMinorUnits, '0'); assert.equal(account.spentCostMinorUnits, '25');
  }
  await assert.rejects(f.store.transact('local', tx => settleBudget(tx, { ...settled, usage: { ...settled.usage, costMinorUnits: '26' } })), { code: 'BUDGET_SETTLEMENT_CONFLICT' });
});

test('实际费用超预留仍如实记录并停止新增调用，不能通过新账户重置同一范围', async () => {
  const f = await fixture();
  const r = await f.store.transact('local', tx => reserveBudget(tx, { ...f.context, accountId: f.child.id, operationKey: 'overrun', amount: { tokens: 10, costMinorUnits: '10', currency: 'CNY' } }));
  await f.store.transact('local', tx => commitBudgetReservation(tx, { ...f.context, reservationId: r.id, operationKey: 'overrun' }));
  await f.store.transact('local', tx => settleBudget(tx, { ...f.context, reservationId: r.id, operationKey: 'overrun', usage: { tokens: 120, costMinorUnits: '120', currency: 'CNY' }, evidenceDigest: 'b'.repeat(64) }));
  await assert.rejects(f.store.transact('local', tx => reserveBudget(tx, { ...f.context, accountId: f.child.id, operationKey: 'another', amount: { tokens: 1, costMinorUnits: '1', currency: 'CNY' } })), { code: 'BUDGET_EXCEEDED' });
  await assert.rejects(f.store.transact('local', tx => createBudgetAccount(tx, { ...f.context, scope: { namespace: 'work-budget', resourceId: 'work-a' }, limit: { tokens: 1000, costMinorUnits: '1000', currency: 'CNY' }, expiresAt: expiry })), { code: 'BUDGET_ACCOUNT_CONFLICT' });
  const history = await f.store.readEvents('local', 0, 1000);
  const replay = replayCoreProjections(history.events, 'local', Buffer.alloc(32, 42));
  assert.equal(replay.records.find(fact => fact.namespace === 'budget.account' && fact.id === f.root.id)?.value?.spentCostMinorUnits, '120');
});

test('其他成员不能承诺他人的预留，关闭账户阻止排队操作开始但保留已知结算', async () => {
  const f = await fixture();
  const r = await f.store.transact('local', tx => reserveBudget(tx, { ...f.context, accountId: f.child.id, operationKey: 'owner-only', amount: { tokens: 10, costMinorUnits: '10', currency: 'CNY' } }));
  await f.store.transact('local', tx => {
    tx.putProjection('principal', 'other', { id: 'other', tenantId: 'local', kind: 'human' });
    tx.putProjection('membership', `${f.context.workspaceId}:other`, { tenantId: 'local', workspaceId: f.context.workspaceId, principalId: 'other', workspaceRole: 'operator' });
  });
  await assert.rejects(f.store.transact('local', tx => commitBudgetReservation(tx, { ...f.context, principalId: 'other', reservationId: r.id, operationKey: 'owner-only' })), { code: 'BUDGET_SCOPE_MISMATCH' });
  const inFlight = await f.store.transact('local', tx => reserveBudget(tx, { ...f.context, accountId: f.child.id, operationKey: 'in-flight', amount: { tokens: 10, costMinorUnits: '10', currency: 'CNY' } }));
  await f.store.transact('local', tx => commitBudgetReservation(tx, { ...f.context, reservationId: inFlight.id, operationKey: 'in-flight' }));
  await f.store.transact('local', tx => closeBudgetAccount(tx, { ...f.context, accountId: f.child.id }));
  await assert.rejects(f.store.transact('local', tx => commitBudgetReservation(tx, { ...f.context, reservationId: r.id, operationKey: 'owner-only' })), { code: 'BUDGET_EXCEEDED' });
  await f.store.transact('local', tx => {
    const member = tx.getProjection<any>('membership', `${f.context.workspaceId}:local-owner`);
    tx.putProjection('membership', member.id, { ...member, removedAt: now });
    settleBudget(tx, { ...f.context, reservationId: inFlight.id, operationKey: 'in-flight', usage: { tokens: 5, costMinorUnits: '5', currency: 'CNY' }, evidenceDigest: 'c'.repeat(64) });
    releaseBudget(tx, { ...f.context, reservationId: r.id, operationKey: 'owner-only' });
  });
  const closed = await f.store.transact('local', tx => tx.getProjection<any>('budget.account', f.child.id));
  assert.equal(closed.status, 'closed'); assert.equal(closed.spentCostMinorUnits, '5'); assert.equal(closed.heldCostMinorUnits, '0');
});


test('明确修订预算保留已用与未知预留，禁止陈旧版本、低于占用和越过父上限', async () => {
  const f = await fixture();
  const reservation = await f.store.transact('local', tx => reserveBudget(tx, { ...f.context, accountId: f.child.id, operationKey: 'held', amount: { tokens: 30, costMinorUnits: '30', currency: 'CNY' } }));
  await f.store.transact('local', tx => commitBudgetReservation(tx, { ...f.context, reservationId: reservation.id, operationKey: 'held' }));
  await f.store.transact('local', tx => markBudgetUnknown(tx, { ...f.context, reservationId: reservation.id, operationKey: 'held' }));
  const current = await f.store.transact('local', tx => tx.getProjection<any>('budget.account', f.child.id));
  const request = { ...f.context, accountId: f.child.id, expectedStreamVersion: current.streamVersion, limit: { tokens: 90, costMinorUnits: '90', currency: 'CNY' }, expiresAt: expiry };
  const changed = await f.store.transact('local', tx => amendBudgetAccount(tx, request));
  assert.equal(changed.heldTokens, 30); assert.equal(changed.spentTokens, 0); assert.equal(changed.limit.tokens, 90);
  await assert.rejects(f.store.transact('local', tx => amendBudgetAccount(tx, request)), { code: 'BUDGET_ACCOUNT_VERSION_CONFLICT' });
  await assert.rejects(f.store.transact('local', tx => amendBudgetAccount(tx, { ...request, expectedStreamVersion: changed.streamVersion, limit: { ...request.limit, tokens: 20 } })), { code: 'BUDGET_BELOW_COMMITTED' });
  await assert.rejects(f.store.transact('local', tx => amendBudgetAccount(tx, { ...request, expectedStreamVersion: changed.streamVersion, limit: { ...request.limit, tokens: 101 } })), { code: 'BUDGET_PARENT_INVALID' });
  await assert.rejects(f.store.transact('local', tx => releaseBudget(tx, { ...f.context, reservationId: reservation.id, operationKey: 'held' })), { code: 'BUDGET_RECONCILIATION_REQUIRED' });
});
