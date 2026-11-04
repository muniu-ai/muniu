// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/business.js';
test('企业业务写入在持久事务中检查对象与字段，管理员不自动取得业务读取权', async t => {
  const f = await fixture(t); const { quote } = await f.base();
  assert.equal(quote.values.totalMinor, 30000);
  const redacted = await f.get('quote_version', 'quote', 'viewer');
  assert.equal(redacted.values.totalMinor, undefined); assert.equal(redacted.values.lines, undefined);
  await assert.rejects(f.get('customer', 'customer', 'admin'), { code: 'OBJECT_ACCESS_DENIED' });
  await assert.rejects(f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }), { code: 'OBJECT_ACCESS_DENIED' });
  const approved = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager', 'approve');
  assert.equal(approved.values.status, 'approved');
  assert.deepEqual(await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager', 'approve'), approved);
  const history = await f.store.readEventHistory('tenant', 0, 1000);
  assert.doesNotMatch(JSON.stringify(history), /机密合成客户|unitPriceMinor|revisionSalt/);
});
test('已提交命令的重放仍检查当前权限，失权后不能读回旧响应', async t => {
  const f = await fixture(t);
  const input = { type: 'customer.create' as const, id: 'customer', name: '机密合成客户' };
  await f.command(input, 'sales', 'create');
  await f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1);
  await assert.rejects(f.command(input, 'sales', 'create'), { code: 'OBJECT_ACCESS_DENIED' });
  const events = await f.repository.read('tenant');
  assert.equal(events.filter(event => event.type === 'enterprise.business.customer.created').length, 1);
});
test('客户接受与合同签署引用本企业已登记证据，不能用伪造或撤回的引用确认', async t => {
  const f = await fixture(t); await f.base();
  const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
  const proof = await f.service.recordEvidence({ actor: f.actor('sales'), actorKind: 'human', workspaceId: f.workspace.id,
    idempotencyKey: 'evidence', subject: quote.reference, attestation: '已核对合成客户书面接受记录。', additionalFieldClasses: [] });
  await assert.rejects(f.command({ type: 'quote.record_acceptance', id: 'quote', expectedStreamVersion: 2, evidence: { ...proof, digest: '0'.repeat(64) } }, 'manager'), { code: 'EVIDENCE_REFERENCE_INVALID' });
  const accepted = await f.command({ type: 'quote.record_acceptance', id: 'quote', expectedStreamVersion: 2, evidence: proof }, 'manager');
  assert.equal(accepted.values.status, 'accepted');
  assert.deepEqual(await f.service.recordEvidence({ actor: f.actor('sales'), actorKind: 'human', workspaceId: f.workspace.id,
    idempotencyKey: 'evidence', subject: quote.reference, attestation: '已核对合成客户书面接受记录。', additionalFieldClasses: [] }), proof);
  const contract = await f.command({ type: 'contract.create', id: 'contract', quote: accepted.reference, title: '合成合同' });
  await assert.rejects(f.command({ type: 'contract.activate', id: 'contract', expectedStreamVersion: 1, evidence: proof }, 'manager'), { code: 'EVIDENCE_SUBJECT_MISMATCH' });
  const signature = await f.service.recordEvidence({ actor: f.actor('sales'), actorKind: 'human', workspaceId: f.workspace.id,
    idempotencyKey: 'signature', subject: contract.reference, attestation: '已核对合成签署记录。', additionalFieldClasses: [] });
  const active = await f.command({ type: 'contract.activate', id: 'contract', expectedStreamVersion: 1, evidence: signature }, 'manager');
  assert.equal(active.values.status, 'active');
});


test('撤回证据立即阻止客户接受，旧引用不能当作新的确认依据', async t => {
  const f = await fixture(t); await f.base();
  const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
  const proof = await f.service.recordEvidence({ actor: f.actor('sales'), actorKind: 'human', workspaceId: f.workspace.id,
    idempotencyKey: 'proof', subject: quote.reference, attestation: '合成证明已核对。', additionalFieldClasses: [] });
  await f.service.withdrawEvidence(f.actor('sales'), f.workspace.id, proof.id, 1, 'withdraw');
  await assert.rejects(f.command({ type: 'quote.record_acceptance', id: 'quote', expectedStreamVersion: 2, evidence: proof }, 'manager'), { code: 'EVIDENCE_REFERENCE_INVALID' });
  assert.equal((await f.get('quote_version', 'quote')).values.status, 'approved');
  await assert.rejects(f.service.getEvidence(f.actor('manager'), f.workspace.id, proof.id), { code: 'EVIDENCE_NOT_FOUND' });
});

test('两个独立服务实例并发激活订单，合同额度只允许一个提交', async t => {
  const f = await fixture(t); await f.base();
  const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
  const evidence = async (subject: typeof quote.reference, idempotencyKey: string) => f.service.recordEvidence({ actor: f.actor('sales'), actorKind: 'human',
    workspaceId: f.workspace.id, idempotencyKey, subject, attestation: '合成确认材料已核对。', additionalFieldClasses: [] });
  const accepted = await f.command({ type: 'quote.record_acceptance', id: 'quote', expectedStreamVersion: 2, evidence: await evidence(quote.reference, 'accepted') }, 'manager');
  const contract = await f.command({ type: 'contract.create', id: 'contract', quote: accepted.reference, title: '合成合同' });
  const active = await f.command({ type: 'contract.activate', id: 'contract', expectedStreamVersion: 1, evidence: await evidence(contract.reference, 'signed') }, 'manager');
  for (const id of ['order-a','order-b']) await f.command({ type: 'order.create', id, contract: active.reference, lines: [{ quoteLineId: 'line-1', quantity: 3 }] });
  const second = f.newService();
  const results = await Promise.allSettled([f.service, second].map((service, index) => service.execute({ actor: f.actor('manager'), actorKind: 'human', workspaceId: f.workspace.id,
    idempotencyKey: 'activate-'+index, command: { type: 'order.activate', id: index ? 'order-b' : 'order-a', expectedStreamVersion: 1 } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'CONTRACT_ALLOCATION_EXCEEDED');
  const orders = await f.service.list(f.actor('manager'), f.workspace.id, 'order');
  assert.equal(orders.filter(order => order.values.status === 'active').length, 1);
  assert.equal(orders.filter(order => order.values.status === 'active').reduce((total, order) => total + Number(order.values.totalMinor), 0), 30000);
  assert.equal((await f.get('contract', 'contract')).reference.streamVersion, 2);
});

test('批准记录查询也要求对应字段读取权，不能仅凭对象范围读取人员信息', async t => {
  const f=await fixture(t); await f.base();
  const quote=await f.command({type:'quote.approve',id:'quote',expectedStreamVersion:1},'manager');
  await f.permissions.revoke(f.admin,'revoke-sales','role','sales-own',1);
  await f.permissions.grantRole(f.admin,'audit-price-only',{id:'audit-price',workspaceId:f.workspace.id,principalId:'sales',role:'auditor',scope:{kind:'workspace'},
    operations:['read'],fieldClasses:['price'],expiresAt:'2027-01-01T00:00:00.000Z'});
  await assert.rejects(f.service.getApproval(f.actor('sales'),f.workspace.id,String(quote.values.approvalId)),{code:'FIELD_ACCESS_DENIED'});
});


test('报价在异步加密期间到期时不提交批准事实', async t => {
  const f=await fixture(t);await f.base();
  const put=f.cas.put.bind(f.cas);let first=true;
  f.cas.put=async bytes=>{const stored=await put(bytes);if(first){first=false;f.advance('2026-12-02T01:00:00.000Z');}return stored;};
  await assert.rejects(f.command({type:'quote.approve',id:'quote',expectedStreamVersion:1},'manager'),{code:'QUOTE_EXPIRED'});
  const quote=await f.get('quote_version','quote');assert.equal(quote.reference.streamVersion,1);assert.equal(quote.values.status,'draft');
  assert.equal((await f.repository.read('tenant')).filter(record=>record.type==='enterprise.business.business_approval.recorded').length,0);
});
