// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/business.js';

test('付款期发生日期持久保存，重建服务后新增分期不改变旧日余额，旧版本仍可追溯', async t => {
  const f = await fixture(t), order = await f.order();
  await f.command({ type: 'payment_schedule.create', id: 'first', order: order.reference, amountMinor: 30000, dueDate: '2026-12-01' }, 'finance-a');
  const original = await f.command({ type: 'payment_schedule.confirm', id: 'first', expectedStreamVersion: 1, evidence: await f.proof('payment_schedule', 'first', 'finance-b') }, 'finance-b');
  assert.equal(original.values.businessDate, '2026-11-02');
  const previous = await f.service.summary(f.actor('finance-b'), f.workspace.id, 'balance', 'order', '2026-11-02');
  f.advance('2026-11-03T01:00:00.000Z');
  await f.command({ type: 'adjustment.prepare', id: 'revise', kind: 'schedule_revision', schedule: original.reference, proposedAmountMinor: 22500, proposedDueDate: '2026-12-01', businessDate: '2026-11-03', reason: '调整分期' }, 'finance-a');
  await f.command({ type: 'adjustment.confirm', id: 'revise', expectedStreamVersion: 1, evidence: await f.proof('adjustment', 'revise', 'finance-b') }, 'finance-b');
  await f.command({ type: 'payment_schedule.create', id: 'second', order: order.reference, amountMinor: 7500, dueDate: '2026-12-02' }, 'finance-a');
  const confirm = { type: 'payment_schedule.confirm' as const, id: 'second', expectedStreamVersion: 1, evidence: await f.proof('payment_schedule', 'second', 'finance-b') };
  const second = await f.command(confirm, 'finance-b', 'confirm-second');
  const restarted = f.newService();
  assert.deepEqual((await restarted.summary(f.actor('finance-b'), f.workspace.id, 'balance', 'order', '2026-11-02')).values, previous.values);
  assert.equal((await restarted.summary(f.actor('finance-b'), f.workspace.id, 'balance', 'order', '2026-11-03')).values.outstandingMinor, 30000);
  assert.deepEqual(await restarted.get(f.actor('finance-b'), f.workspace.id, 'payment_schedule', 'first', 2), original);
  assert.deepEqual(await restarted.execute({ actor: f.actor('finance-b'), actorKind: 'human', workspaceId: f.workspace.id, idempotencyKey: 'confirm-second', command: confirm }), second);
  await f.permissions.revoke(f.admin, 'revoke-period-reader', 'role', 'finance-b', 1);
  await assert.rejects(restarted.get(f.actor('finance-b'), f.workspace.id, 'payment_schedule', 'second'), { code: 'OBJECT_ACCESS_DENIED' });
});
