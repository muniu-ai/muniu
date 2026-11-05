// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendKernelEvent } from '@mn/kernel';
import { EnterpriseError } from '@mn/enterprise-services';
import { fixture } from './fixtures/business.js';
test('提供方事实与回执提交前重验同一事务中的执行状态，异步保护期间的撤销不能被旧快照绕过', async t => {
  const f = await fixture(t, true, true);
  const permit = async (active: boolean, version: number) => f.store.transact('tenant', tx => {
    tx.putProjection('provider-test.permit', 'permit', { active, streamVersion: version });
    appendKernelEvent(tx, { tenantId: 'tenant', aggregateType: 'provider-test.permit', aggregateId: 'permit', expectedStreamVersion: version - 1, type: 'provider.permit_changed', actorId: 'admin', generation: 0, correlationId: 'permit', publicPayload: {} });
  });
  await permit(true, 1);
  const put = f.cas.put.bind(f.cas); let revoke = true;
  f.cas.put = async bytes => { const result = await put(bytes); if (revoke) { revoke = false; await permit(false, 2); } return result; };
  await assert.rejects(f.repository.transact('tenant', () => ({
    events: [{ type: 'enterprise.provider.test_committed', aggregateType: 'enterprise.provider.test', aggregateId: 'action', expectedStreamVersion: 0, actorId: 'admin', occurredAt: f.now(), payload: { effect: 'must-not-commit' } }],
    value: 'success',
  }), tx => { if (!tx.getProjection<{ active: boolean }>('provider-test.permit', 'permit')?.active) throw new EnterpriseError('PROVIDER_EXECUTION_REVOKED'); }), { code: 'PROVIDER_EXECUTION_REVOKED' });
  assert.equal((await f.repository.read('tenant')).some(r => r.type === 'enterprise.provider.test_committed'), false);
});
test('提供方提交校验不接受未等待的异步批准', async t => {
  const f = await fixture(t, true, true);
  await assert.rejects(f.repository.transact('tenant', () => ({
    events: [{ type: 'enterprise.provider.test_committed', aggregateType: 'enterprise.provider.test', aggregateId: 'async', expectedStreamVersion: 0, actorId: 'admin', occurredAt: f.now(), payload: {} }], value: 'success',
  }), (() => Promise.resolve()) as never), { code: 'COMMIT_GUARD_INVALID' });
});
