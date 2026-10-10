// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore } from '../src/index.js';
import { admitExternalReadInTransaction, beginExternalReadInTransaction, finishExternalReadInTransaction } from '../src/external-read.js';
import type { Job } from '@mn/contracts';
const now = '2026-10-10T00:00:00.000Z';
async function fixture() {
  const store = new InMemoryKernelStore(undefined, () => now), kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'ws', { name: '读取', viewMode: 'business', pluginIds: ['opc'] });
  const input = { id: 'read', tenantId: 'local', workspaceId: workspace.id, principalId: 'local-owner', toolId: 'test.read', toolVersion: '1',
    effectClass: 'external_read' as const, resourceRefs: [{ namespace: 'test.connection', resourceId: 'connection', streamVersion: 1, digest: 'a'.repeat(64) }],
    requestDigest: 'b'.repeat(64), authorityDigest: 'c'.repeat(64), expiresAt: '2026-10-10T00:01:00.000Z', now, jobKind: 'test.read' };
  const admit = () => store.transact('local', tx => admitExternalReadInTransaction(tx, input));
  const lease = async () => store.transact('local', tx => { const job = tx.getProjection<Job>('job', 'external-read:read')!; tx.putProjection('job', job.id, { ...job, status: 'leased', fencingToken: 2, leaseOwner: 'worker', leaseExpiresAt: input.expiresAt }); });
  const boundary = { id: input.id, tenantId: input.tenantId, jobId: 'external-read:read', workerId: 'worker', fencingToken: 2, occurredAt: now, authorityDigest: input.authorityDigest };
  return { store, input, admit, lease, boundary };
}
test('只读准入与调用者原子提交，重复请求只有一个Job', async () => {
  const f = await fixture();
  await assert.rejects(f.store.transact('local', tx => { admitExternalReadInTransaction(tx, f.input); throw new Error('crash'); }), /crash/u);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('job').length), 0);
  await Promise.all([f.admit(), f.admit()]);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('job').length), 1);
  await assert.rejects(f.store.transact('local', tx => admitExternalReadInTransaction(tx, { ...f.input, effectClass: 'external_side_effect' as never })), /只读/u);
});
test('外发前固化承诺，陈旧租约、撤权及重复外发被拒绝', async () => {
  const f = await fixture(); await f.admit(); await f.lease();
  await assert.rejects(f.store.transact('local', tx => beginExternalReadInTransaction(tx, { ...f.boundary, fencingToken: 1 })), /lease|租约|owns/u);
  await f.store.transact('local', tx => beginExternalReadInTransaction(tx, f.boundary));
  await assert.rejects(f.store.transact('local', tx => beginExternalReadInTransaction(tx, f.boundary)), /重复|核对/u);
  await f.store.transact('local', tx => { const member = tx.getProjection<any>('membership', `${f.input.workspaceId}:local-owner`); tx.putProjection('membership', member.id, { ...member, removedAt: now }); });
  await assert.rejects(f.store.transact('local', tx => finishExternalReadInTransaction(tx, { ...f.boundary, outcome: 'completed', value: {} })), /授权/u);
});
test('成功结果及Job结算同事务；失败回滚不产生半个附件结果', async () => {
  const f = await fixture(); await f.admit(); await f.lease(); await f.store.transact('local', tx => beginExternalReadInTransaction(tx, f.boundary));
  await assert.rejects(f.store.transact('local', tx => { tx.putProjection('fixture.asset', 'a', { id: 'a' }); finishExternalReadInTransaction(tx, { ...f.boundary, outcome: 'completed', value: { assetId: 'a' } }); throw new Error('crash'); }), /crash/u);
  assert.equal(await f.store.transact('local', tx => tx.getProjection('fixture.asset', 'a')), undefined);
  const receipt = await f.store.transact('local', tx => finishExternalReadInTransaction(tx, { ...f.boundary, outcome: 'completed', value: { assetId: 'a' } }));
  assert.equal(receipt.settled, true);
  assert.equal(await f.store.transact('local', tx => tx.getProjection<Job>('job', f.boundary.jobId)?.status), 'completed');
});
test('结果未知的同源读取不能改标识、授权版本或幂等键重放', async () => {
  const f = await fixture(); await f.admit(); await f.lease(); await f.store.transact('local', tx => beginExternalReadInTransaction(tx, f.boundary));
  await f.store.transact('local', tx => finishExternalReadInTransaction(tx, { ...f.boundary, outcome: 'needs_reconciliation', value: {} }));
  const rotated = { ...f.input, id: 'another', authorityDigest: 'd'.repeat(64), resourceRefs: [{ ...f.input.resourceRefs[0]!, streamVersion: 2, digest: 'e'.repeat(64) }] };
  await assert.rejects(f.store.transact('local', tx => admitExternalReadInTransaction(tx, rotated)), /核对|重放/u);
});
