// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseContractTypes as Types } from '@mn/contracts';
import { fixture } from './fixtures/business.js';
import { createTestOidcIssuer } from './fixtures/enterprise-oidc-issuer.js';
import { createEnterpriseHost } from '../src/enterprise-host.js';

async function data<T>(response: Response): Promise<T> {
  const result = await response.json() as { data: T; code?: string };
  assert.equal(response.status, 200, result.code); return result.data;
}
async function setup(t: test.TestContext, observeNow?: () => void) {
  const issuer = await createTestOidcIssuer(); t.after(() => issuer.close());
  const f = await fixture(t, false, true, issuer.issuer), origin = 'https://capabilities.example.test';
  const host = createEnterpriseHost({ repository: f.repository, origin, profile: 'development', providers: { tenant: { issuer: issuer.issuer, clientId: 'muniu-fixture' } }, now: () => { const value = f.now(); observeNow?.(); return value; } });
  t.after(() => host.close());
  const login = async (person: string) => {
    const start = await host.dispatch(new Request(origin + '/v2/auth/login?organizationId=tenant'));
    const callback = await host.dispatch(new Request(issuer.callback(start.headers.get('location')!, person), { headers: { cookie: start.headers.getSetCookie()[0]!.split(';')[0]! } }));
    assert.equal(callback.status, 303);
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-mn-enterprise-session='))!.split(';')[0]!;
    const session = await data<Types['EnterpriseSessionView']>(await host.dispatch(new Request(origin + '/v2/auth/session', { headers: { cookie } })));
    return (path: string, body?: unknown, key?: string, csrf = session.csrfToken) => host.dispatch(new Request(origin + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, ...(key ? { 'idempotency-key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  };
  return { ...f, host, origin, login, prefix: '/v2/workspaces/' + f.workspace.id };
}

async function departmentWriter(f: Awaited<ReturnType<typeof setup>>, expiresAt = '2027-01-01T00:00:00.000Z') {
  await f.permissions.revoke(f.admin, 'remove-owned-customer-write', 'role', 'sales-own', 1);
  const department = await f.permissions.createDepartment(f.admin, 'customer-department', { workspaceId: f.workspace.id, name: '允许办理的销售部' });
  await f.permissions.grantRole(f.admin, 'department-customer-writer', { id: 'department-customer-writer', workspaceId: f.workspace.id,
    principalId: 'sales', role: 'sales', scope: { kind: 'department', departmentId: department.id }, operations: ['read', 'write'],
    fieldClasses: ['public'], expiresAt });
  return department;
}

test('业务对象能力来自当前服务端字段权限，管理员身份不扩大业务权，撤权立即生效', async t => {
  const f = await setup(t), base = await f.base();
  const sales = await f.login('sales'), viewer = await f.login('viewer'), manager = await f.login('manager'), admin = await f.login('admin');
  const path = f.prefix + '/business-capabilities/quote_version/quote';
  const restricted = await data<Types['EnterpriseBusinessCapabilities']>(await viewer(path));
  assert.deepEqual(restricted.reference, base.quote.reference);
  assert.ok(restricted.readableFields.includes('currency'));
  assert.ok(!restricted.readableFields.includes('totalMinor')); assert.ok(!restricted.readableFields.includes('lines'));
  assert.deepEqual(restricted.writableFields, []); assert.deepEqual(restricted.businessApprovalFields, []); assert.equal(restricted.canRecordEvidence, false);
  const writer = await data<Types['EnterpriseBusinessCapabilities']>(await sales(path));
  assert.ok(writer.readableFields.includes('totalMinor')); assert.ok(writer.writableFields.includes('lines'));
  assert.deepEqual(writer.businessApprovalFields, []); assert.equal(writer.canRecordEvidence, true);
  const approver = await data<Types['EnterpriseBusinessCapabilities']>(await manager(path));
  assert.ok(approver.businessApprovalFields.includes('totalMinor'));
  await f.command({ type: 'quote.prepare', id: 'self-quote', opportunity: base.opportunity.reference, lines: [{ service: base.catalog.reference, quantity: 1 }], validUntil: '2026-12-01T00:00:00.000Z' }, 'manager');
  const own = await data<Types['EnterpriseBusinessCapabilities']>(await manager(f.prefix + '/business-capabilities/quote_version/self-quote'));
  assert.ok(own.businessApprovalFields.includes('totalMinor'));
  const selfApproval = { type: 'quote.approve', id: 'self-quote', expectedStreamVersion: 1 };
  const before = await f.repository.read('tenant');
  assert.deepEqual(await data(await manager(f.prefix + '/business-command-checks', selfApproval)), { allowedNow: false, reasonCode: 'SEPARATION_OF_DUTIES_REQUIRED' });
  assert.deepEqual(await f.repository.read('tenant'), before);
  assert.equal((await manager(f.prefix + '/business/commands', selfApproval, 'self-approval')).status, 403);
  assert.equal((await admin(path)).status, 403);
  assert.equal((await sales('/v2/workspaces/foreign/business-capabilities/quote_version/quote')).status, 404);
  assert.doesNotMatch(JSON.stringify(restricted), /30000|机密合成客户|unitPriceMinor/);
  await f.permissions.revoke(f.admin, 'revoke-capabilities', 'role', 'sales-own', 1);
  assert.equal((await sales(path)).status, 403);
});

test('完整命令预检核对关联对象、字段和原版本，建议通过不创建事实或替代正式写入', async t => {
  const f = await setup(t), base = await f.base(), viewer = await f.login('viewer'), sales = await f.login('sales');
  await f.permissions.grantRole(f.admin, 'viewer-write', { id: 'viewer-write', workspaceId: f.workspace.id, principalId: 'viewer', role: 'sales', scope: { kind: 'owned' }, operations: ['read', 'write'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  const path = f.prefix + '/business-command-checks';
  const command = { type: 'opportunity.create' as const, id: 'new-opportunity', customer: base.customer.reference, title: '新商机' };
  const before = await f.repository.read('tenant');
  assert.deepEqual(await data(await viewer(path, command)), { allowedNow: false, reasonCode: 'OBJECT_ACCESS_DENIED' });
  assert.deepEqual(await data(await sales(path, command)), { allowedNow: true });
  assert.deepEqual(await f.repository.read('tenant'), before);
  assert.equal((await sales(path, command, undefined, 'wrong-csrf')).status, 403);
  assert.equal((await sales(path, { ...command, actorId: 'admin' })).status, 400);
  await f.permissions.grantObject(f.admin, 'share-customer', { id: 'share-customer', workspaceId: f.workspace.id, principalId: 'viewer', objectType: 'customer', objectId: 'customer', operations: ['read', 'write'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(await data(await viewer(path, command)), { allowedNow: true });
  const changed = await f.command({ type: 'customer.rename', id: 'customer', expectedStreamVersion: 1, name: '已更新客户' });
  assert.deepEqual(await data(await viewer(path, command)), { allowedNow: false, reasonCode: 'SOURCE_VERSION_CONFLICT' });
  assert.equal((await viewer(f.prefix + '/business/commands', command, 'stale-write')).status, 409);
  const current = { ...command, customer: changed.reference };
  assert.deepEqual(await data(await viewer(path, current)), { allowedNow: true });
  const created = await data<Types['EnterpriseBusinessObjectView']>(await viewer(f.prefix + '/business/commands', current, 'create-opportunity'));
  assert.equal(created.reference.streamVersion, 1);
  const facts = await f.repository.read('tenant');
  assert.deepEqual(await data(await sales(path, { type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 })), { allowedNow: false, reasonCode: 'OBJECT_ACCESS_DENIED' });
  assert.deepEqual(await f.repository.read('tenant'), facts);
  await f.permissions.revoke(f.admin, 'revoke-writer', 'role', 'viewer-write', 1);
  assert.deepEqual(await data(await viewer(path, { ...current, id: 'denied-opportunity' })), { allowedNow: false, reasonCode: 'OBJECT_ACCESS_DENIED' });
  const read = f.repository.read.bind(f.repository); let reads = 0;
  f.repository.read = async tenant => { if (++reads === 2) throw new Error('synthetic-storage-failure'); return read(tenant); };
  const failed = await sales(path, { type: 'customer.create', id: 'unavailable', name: '合成客户' });
  assert.equal(failed.status, 503); assert.equal((await failed.json() as { code: string }).code, 'SERVICE_UNAVAILABLE');
});

test('可读字段上限区分未填写和受限联系方式，隐藏字段不能被补空覆盖', async t => {
  const f = await setup(t), base = await f.base(), sales = await f.login('sales'), viewer = await f.login('viewer');
  await f.command({ type: 'contact.create', id: 'empty-contact', customer: base.customer.reference, name: '未填写联系方式' });
  const empty = await data<Types['EnterpriseBusinessCapabilities']>(await sales(f.prefix + '/business-capabilities/contact/empty-contact'));
  assert.ok(empty.readableFields.includes('email')); assert.ok(empty.readableFields.includes('phone'));
  const emptyView = await data<Types['EnterpriseBusinessObjectView']>(await sales(f.prefix + '/business/contact/empty-contact'));
  assert.equal(Object.hasOwn(emptyView.values, 'email'), false); assert.equal(Object.hasOwn(emptyView.values, 'phone'), false);
  await f.command({ type: 'contact.create', id: 'protected-contact', customer: base.customer.reference, name: '合成联系人', email: 'fixture@example.invalid', phone: 'synthetic-contact-only' });
  await f.permissions.grantRole(f.admin, 'viewer-public-write', { id: 'viewer-public-write', workspaceId: f.workspace.id, principalId: 'viewer', role: 'sales', scope: { kind: 'workspace' }, operations: ['read', 'write'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  const restricted = await data<Types['EnterpriseBusinessCapabilities']>(await viewer(f.prefix + '/business-capabilities/contact/protected-contact'));
  assert.ok(restricted.readableFields.includes('name')); assert.ok(!restricted.readableFields.includes('email')); assert.ok(!restricted.readableFields.includes('phone'));
  const hidden = await data<Types['EnterpriseBusinessObjectView']>(await viewer(f.prefix + '/business/contact/protected-contact'));
  assert.equal(Object.hasOwn(hidden.values, 'email'), false); assert.equal(Object.hasOwn(hidden.values, 'phone'), false);
  const replacement = { type: 'contact.update', id: 'protected-contact', expectedStreamVersion: 1, name: '只改公开名称' };
  assert.deepEqual(await data(await viewer(f.prefix + '/business-command-checks', replacement)), { allowedNow: false, reasonCode: 'FIELD_ACCESS_DENIED' });
  assert.equal((await viewer(f.prefix + '/business/commands', replacement, 'blocked-replacement')).status, 403);
  const intact = await f.get('contact', 'protected-contact');
  assert.equal(intact.reference.streamVersion, 1); assert.equal(intact.values.email, 'fixture@example.invalid'); assert.equal(intact.values.phone, 'synthetic-contact-only');
});

test('已有复盘金额被来源权限过滤时，可读字段上限仍不包含这些字段', async t => {
  const f = await setup(t), order = await f.order();
  await f.permissions.grantRole(f.admin, 'own-review', { id: 'own-review', workspaceId: f.workspace.id, principalId: 'finance-b', role: 'finance', scope: { kind: 'owned' }, operations: ['read', 'write'], fieldClasses: ['public', 'price', 'cost'], expiresAt: '2027-01-01T00:00:00.000Z' });
  const review = await f.command({ type: 'business_review.snapshot', id: 'review', order: order.reference, periodStart: '2026-11-01', periodEnd: '2026-11-02', includeCosts: false }, 'finance-b');
  assert.ok(Object.hasOwn(review.values, 'financialMetrics'));
  await f.permissions.revoke(f.admin, 'revoke-financial-sources', 'role', 'finance-b', 1);
  const finance = await f.login('finance-b');
  const view = await data<Types['EnterpriseBusinessObjectView']>(await finance(f.prefix + '/business/business_review/review'));
  assert.equal(Object.hasOwn(view.values, 'financialMetrics'), false); assert.equal(Object.hasOwn(view.values, 'financialSources'), false);
  const capabilities = await data<Types['EnterpriseBusinessCapabilities']>(await finance(f.prefix + '/business-capabilities/business_review/review'));
  assert.ok(!capabilities.readableFields.includes('financialMetrics')); assert.ok(!capabilities.readableFields.includes('financialSources'));
});

test('对象人员映射仅包含已显示的同租户引用，不泄露其他成员或身份字段，未知成员不补造姓名', async t => {
  const f = await setup(t), base = await f.base();
  const invitation = await f.identity.invite(f.admin, 'invite-named-owner', { id: 'named-owner', subject: 'private-subject-value', displayName: '合成负责人甲', organizationAdmin: false });
  await f.identity.acceptInvitation(f.actor('named-owner'), 'accept-named-owner', 'named-owner', 1, invitation.token);
  await f.permissions.grantRole(f.admin, 'named-owner-role', { id: 'named-owner-role', workspaceId: f.workspace.id, principalId: 'named-owner', role: 'sales', scope: { kind: 'owned' }, operations: ['read', 'write'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  await f.command({ type: 'customer.create', id: 'named-customer', name: '合成客户' }, 'named-owner');
  await f.identity.provision({ tenantId: 'other-tenant', name: '另一企业', issuer: 'https://other.example.test/', maxMembers: 2, administrator: { id: 'named-owner', subject: 'foreign-subject', displayName: '另一个企业的姓名' } });
  const foreign = await f.identity.createWorkspace({ tenantId: 'other-tenant', principalId: 'named-owner', sessionEpoch: 1 }, 'foreign-workspace', { name: '另一主体', mode: 'builtin' });
  const viewer = await f.login('viewer'), path = f.prefix + '/business-capabilities/customer/named-customer';
  const capabilities = await data<Types['EnterpriseBusinessCapabilities']>(await viewer(path));
  assert.deepEqual(capabilities.people, [{ principalId: 'named-owner', displayName: '合成负责人甲' }]);
  assert.doesNotMatch(JSON.stringify(capabilities.people), /private-subject|foreign-subject|issuer|email|另一个企业|manager|viewer/);
  assert.equal((await viewer(path + '?principalId=manager')).status, 400);
  assert.equal((await viewer('/v2/organizations/tenant/members')).status, 403);
  assert.equal((await viewer('/v2/workspaces/' + foreign.id + '/business-capabilities/customer/named-customer')).status, 404);
  const read = f.repository.read.bind(f.repository), snapshot = f.repository.readSnapshot.bind(f.repository);
  f.repository.read = async tenant => (await read(tenant)).filter(record => !(record.type.startsWith('enterprise.member.') && record.aggregateId === 'named-owner'));
  f.repository.readSnapshot = async tenant => { const value = await snapshot(tenant); return { ...value, records: value.records.filter(record => !(record.type.startsWith('enterprise.member.') && record.aggregateId === 'named-owner')) }; };
  try { assert.deepEqual((await data<Types['EnterpriseBusinessCapabilities']>(await viewer(path))).people, []); }
  finally { f.repository.read = read; f.repository.readSnapshot = snapshot; }
  await f.permissions.revoke(f.admin, 'remove-public-read', 'role', 'viewer', 1);
  await f.permissions.grantRole(f.admin, 'price-only-read', { id: 'price-only-read', workspaceId: f.workspace.id, principalId: 'viewer', role: 'sales', scope: { kind: 'workspace' }, operations: ['read'], fieldClasses: ['price'], expiresAt: '2027-01-01T00:00:00.000Z' });
  const priceOnly = await data<Types['EnterpriseBusinessCapabilities']>(await viewer(f.prefix + '/business-capabilities/quote_version/' + base.quote.reference.objectId));
  assert.ok(priceOnly.readableFields.includes('totalMinor')); assert.ok(!priceOnly.readableFields.includes('ownerPrincipalId')); assert.deepEqual(priceOnly.people, []);
  await f.permissions.revoke(f.admin, 'remove-price-read', 'role', 'price-only-read', 1);
  assert.equal((await viewer(path)).status, 403);
});

test('人员姓名保留归属人、真实制单人与接收人的区别，不从批准引用枚举其他人员', async t => {
  const f = await setup(t), order = await f.order(), viewer = await f.login('viewer');
  const project = await f.command({ type: 'project.create', id: 'project', order: order.reference, title: '合成项目' }, 'project');
  const milestone = await f.command({ type: 'milestone.create', id: 'milestone', project: project.reference, title: '合成阶段', dueDate: '2026-11-02', lines: [{ lineId: 'line-1', quantity: 3 }] }, 'project');
  await f.command({ type: 'delivery.report', id: 'delivery', milestone: milestone.reference, summary: '合成交付', lines: [{ lineId: 'line-1', quantity: 1 }] }, 'project');
  await f.command({ type: 'delivery.receive', id: 'delivery', expectedStreamVersion: 1 }, 'reviewer');
  const delivery = await data<Types['EnterpriseBusinessCapabilities']>(await viewer(f.prefix + '/business-capabilities/delivery_version/delivery'));
  assert.deepEqual(delivery.people, [{ principalId: 'project', displayName: 'project' }, { principalId: 'reviewer', displayName: 'reviewer' }]);
  const current = await f.command({ type: 'project.costs.confirm', id: 'project', expectedStreamVersion: 1, evidence: await f.proof('project', 'project', 'finance-b'), expenseRefs: [], zeroCost: true }, 'finance-b');
  const review = await data<Types['EnterpriseBusinessCapabilities']>(await viewer(f.prefix + '/business-capabilities/business_review/' + String(current.values.costReportId)));
  assert.deepEqual(review.people, [{ principalId: 'finance-b', displayName: 'finance-b' }, { principalId: 'project', displayName: 'project' }]);
});

test('另一仓库在加密事件加载期间提交撤权后，能力查询不能从旧快照返回人员姓名', async t => {
  const f = await setup(t); await f.base(); const viewer = await f.login('viewer');
  const { createEnterpriseEventRepository } = await import('../src/enterprise-event-repository.js');
  const { EnterpriseBusinessService } = await import('../src/enterprise-business.js');
  const { EnterprisePermissionService } = await import('@mn/enterprise-services');
  const peerRepository = createEnterpriseEventRepository({ store: f.store, cas: f.cas, keyProvider: f.keyProvider });
  const peerBusiness = new EnterpriseBusinessService({ repository: peerRepository, now: f.now });
  const peerPermissions = new EnterprisePermissionService({ repository: peerRepository, now: f.now });
  const read = f.repository.read.bind(f.repository), get = f.cas.get.bind(f.cas);
  let staged = false, revoked = false, eventContent: string | undefined;
  f.repository.read = async tenant => {
    const records = await read(tenant);
    if (!staged) {
      staged = true;
      await peerBusiness.execute({ actor: f.actor('sales'), actorKind: 'human', workspaceId: f.workspace.id, idempotencyKey: 'stage-capability-read', command: { type: 'customer.rename', id: 'customer', expectedStreamVersion: 1, name: '并发权限检查客户' } });
      const page = await f.store.readEventHistory!('tenant', 0, 1000);
      const event = page.events.find(record => record.type === 'enterprise.business.customer.renamed');
      assert.ok(event?.protectedPayloadRef); eventContent = event.protectedPayloadRef;
    }
    return records;
  };
  f.cas.get = async digest => {
    const bytes = await get(digest);
    if (digest === eventContent && !revoked) {
      revoked = true;
      await peerPermissions.revoke(f.admin, 'revoke-during-capability-read', 'role', 'viewer', 1);
    }
    return bytes;
  };
  let response: Response;
  try { response = await viewer(f.prefix + '/business-capabilities/customer/customer'); }
  finally { f.repository.read = read; f.cas.get = get; }
  assert.ok(staged && revoked, '必须在实际加密事件加载期间通过另一仓库提交撤权');
  assert.equal(response.status, 403);
  const result = await response.json() as { code: string; data?: unknown };
  assert.equal(result.code, 'OBJECT_ACCESS_DENIED'); assert.equal(result.data, undefined);
});

test('字段授权在投影计算后的异步间隙到期时，提交检查点不能返回旧的联系方式权限', async t => {
  let armed = false, scheduled = false, expired = false;
  const f = await setup(t, () => {
    if (armed && !scheduled) {
      scheduled = true;
      queueMicrotask(() => { f.advance('2026-11-02T01:02:00.000Z'); expired = true; });
    }
  });
  const base = await f.base();
  await f.command({ type: 'contact.create', id: 'expiring-contact', customer: base.customer.reference, name: '合成联系人', email: 'fixture@example.invalid', phone: 'synthetic-contact-only' });
  await f.permissions.grantRole(f.admin, 'temporary-contact-read', { id: 'temporary-contact-read', workspaceId: f.workspace.id, principalId: 'viewer', role: 'sales', scope: { kind: 'workspace' }, operations: ['read'], fieldClasses: ['contact'], expiresAt: '2026-11-02T01:01:00.000Z' });
  const viewer = await f.login('viewer');
  const read = f.repository.read.bind(f.repository), readSnapshot = f.repository.readSnapshot.bind(f.repository);
  let reads = 0;
  f.repository.read = async tenant => { const records = await read(tenant); if (++reads === 2) armed = true; return records; };
  f.repository.readSnapshot = async tenant => { const snapshot = await readSnapshot(tenant); armed = true; return snapshot; };
  let response: Response;
  try { response = await viewer(f.prefix + '/business-capabilities/contact/expiring-contact'); }
  finally { f.repository.read = read; f.repository.readSnapshot = readSnapshot; }
  assert.ok(scheduled && expired, '必须在同步权限投影之后实际经过授权到期的异步间隙');
  const capabilities = await data<Types['EnterpriseBusinessCapabilities']>(response);
  assert.ok(capabilities.readableFields.includes('name'));
  assert.ok(!capabilities.readableFields.includes('email')); assert.ok(!capabilities.readableFields.includes('phone'));
});

test('能力查询缺少一致性读取能力时失败关闭，不回退普通仓库读取', async t => {
  const f = await setup(t); await f.base();
  const { EnterpriseBusinessService } = await import('../src/enterprise-business.js');
  const legacy = { read: f.repository.read.bind(f.repository), transact: f.repository.transact.bind(f.repository) };
  const business = new EnterpriseBusinessService({ repository: legacy, now: f.now });
  await assert.rejects(business.capabilities(f.actor('viewer'), f.workspace.id, 'customer', 'customer'), { code: 'CONSISTENT_READ_REQUIRED', status: 503 });
});

test('仅部门范围销售可查询真实客户的归属候选，子部门可选且不泄露无权或其他工作区部门', async t => {
  const f = await setup(t), department = await departmentWriter(f);
  const child = await f.permissions.createDepartment(f.admin, 'child-department', { workspaceId: f.workspace.id, name: '允许办理的下级部门', parentId: department.id });
  const hidden = await f.permissions.createDepartment(f.admin, 'hidden-department', { workspaceId: f.workspace.id, name: '不可见部门名称' });
  await f.identity.provision({ tenantId: 'foreign-tenant', name: '另一合成企业', issuer: 'https://foreign-issuer.example.test/', maxMembers: 5,
    administrator: { id: 'foreign-admin', subject: 'foreign-admin', displayName: '另一企业管理员' } });
  const foreignAdmin = { tenantId: 'foreign-tenant', principalId: 'foreign-admin', sessionEpoch: 1 };
  const otherWorkspace = await f.identity.createWorkspace(foreignAdmin, 'other-workspace', { name: '另一业务主体', mode: 'builtin' });
  const other = await f.permissions.createDepartment(foreignAdmin, 'other-department', { workspaceId: otherWorkspace.id, name: '其他工作区部门名称' });
  const sales = await f.login('sales'), admin = await f.login('admin'), viewer = await f.login('viewer');
  const path = f.prefix + '/customer-creation-departments/queries', input = { type: 'customer.create', id: 'department-customer', name: '用户填写的合成客户' };
  const before = await f.repository.read('tenant');
  const candidates = await data<Types['EnterpriseCustomerCreationDepartments']>(await sales(path, input));
  assert.equal(candidates.allowUnassigned, false);
  assert.deepEqual(candidates.departments, [department, child].map(value => ({ id: value.id, name: value.name })).sort((a, b) => a.id.localeCompare(b.id)));
  assert.doesNotMatch(JSON.stringify(candidates), new RegExp([hidden.id, hidden.name, other.id, other.name, 'principalId', 'parentId'].join('|')));
  assert.deepEqual(await data(await admin(path, input)), { departments: [], allowUnassigned: false });
  assert.deepEqual(await data(await viewer(path, input)), { departments: [], allowUnassigned: false });
  assert.equal((await sales('/v2/workspaces/' + otherWorkspace.id + '/customer-creation-departments/queries', input)).status, 404);
  assert.equal((await sales(path, input, undefined, 'wrong-csrf')).status, 403);
  assert.equal((await sales(path, { ...input, departmentId: hidden.id })).status, 400);
  assert.equal((await sales(path, { ...input, type: 'customer.rename', expectedStreamVersion: 1 })).status, 400);
  assert.deepEqual(await f.repository.read('tenant'), before, '归属查询不得创建事件、审批或客户');
  assert.deepEqual(await data(await sales(f.prefix + '/business-command-checks', input)), { allowedNow: false, reasonCode: 'OBJECT_ACCESS_DENIED' });
  const chosen = { ...input, departmentId: child.id };
  assert.deepEqual(await data(await sales(f.prefix + '/business-command-checks', chosen)), { allowedNow: true });
  const created = await data<Types['EnterpriseBusinessObjectView']>(await sales(f.prefix + '/business/commands', chosen, 'create-department-customer'));
  assert.equal(created.values.name, input.name); assert.equal(created.values.departmentId, child.id);
  assert.deepEqual(await data(await sales(path, input)), { departments: [], allowUnassigned: false }, '已存在的真实客户 ID 不能用探针 ID 掩盖');
});

test('客户归属候选支持不指定部门，撤权后原候选不能替代完整预检或写入检查', async t => {
  const f = await setup(t), sales = await f.login('sales');
  const path = f.prefix + '/customer-creation-departments/queries', input = { type: 'customer.create', id: 'unassigned-customer', name: '无部门合成客户' };
  assert.deepEqual(await data(await sales(path, input)), { departments: [], allowUnassigned: true });
  const department = await departmentWriter(f);
  assert.deepEqual(await data(await sales(path, input)), { departments: [{ id: department.id, name: department.name }], allowUnassigned: false });
  await f.permissions.revoke(f.admin, 'remove-department-write', 'role', 'department-customer-writer', 1);
  assert.deepEqual(await data(await sales(path, input)), { departments: [], allowUnassigned: false });
  assert.deepEqual(await data(await sales(f.prefix + '/business-command-checks', { ...input, departmentId: department.id })), { allowedNow: false, reasonCode: 'OBJECT_ACCESS_DENIED' });
  assert.equal((await sales(f.prefix + '/business/commands', { ...input, departmentId: department.id }, 'revoked-customer-write')).status, 403);
});

test('客户归属查询加载事件期间另一仓库真实撤权，不能返回旧部门候选', async t => {
  const f = await setup(t); await departmentWriter(f); const sales = await f.login('sales');
  const { createEnterpriseEventRepository } = await import('../src/enterprise-event-repository.js');
  const { EnterprisePermissionService } = await import('@mn/enterprise-services');
  const peerRepository = createEnterpriseEventRepository({ store: f.store, cas: f.cas, keyProvider: f.keyProvider });
  const peerPermissions = new EnterprisePermissionService({ repository: peerRepository, now: f.now });
  const readSnapshot = f.repository.readSnapshot.bind(f.repository), get = f.cas.get.bind(f.cas);
  let staged = false, inSnapshot = false, revoked = false, eventContent: string | undefined;
  f.repository.readSnapshot = async tenant => {
    if (!staged) {
      const added = await peerPermissions.createDepartment(f.admin, 'stage-customer-candidate-read', { workspaceId: f.workspace.id, name: '无权并发部门' });
      const page = await f.store.readEventHistory!('tenant', 0, 1000);
      const event = page.events.find(record => record.type === 'enterprise.department.created' && record.aggregateId === added.id);
      assert.ok(event?.protectedPayloadRef); eventContent = event.protectedPayloadRef; staged = true;
    }
    inSnapshot = true;
    try { return await readSnapshot(tenant); } finally { inSnapshot = false; }
  };
  f.cas.get = async digest => {
    const bytes = await get(digest);
    if (inSnapshot && digest === eventContent && !revoked) {
      revoked = true;
      await peerPermissions.revoke(f.admin, 'revoke-during-candidate-load', 'role', 'department-customer-writer', 1);
    }
    return bytes;
  };
  let response: Response;
  try { response = await sales(f.prefix + '/customer-creation-departments/queries', { type: 'customer.create', id: 'concurrent-customer', name: '并发撤权合成客户' }); }
  finally { f.repository.readSnapshot = readSnapshot; f.cas.get = get; }
  assert.ok(staged && revoked, '必须在实际 readCurrent 快照加载中通过第二仓库提交撤权');
  assert.deepEqual(await data(response), { departments: [], allowUnassigned: false });
});

test('客户部门授权在投影后到期时，提交检查点移除旧候选', async t => {
  let armed = false, scheduled = false, expired = false;
  const f = await setup(t, () => {
    if (armed && !scheduled) {
      scheduled = true; queueMicrotask(() => { f.advance('2026-11-02T01:02:00.000Z'); expired = true; });
    }
  });
  await departmentWriter(f, '2026-11-02T01:01:00.000Z'); const sales = await f.login('sales');
  const readSnapshot = f.repository.readSnapshot.bind(f.repository);
  f.repository.readSnapshot = async tenant => { const snapshot = await readSnapshot(tenant); armed = true; return snapshot; };
  let response: Response;
  try { response = await sales(f.prefix + '/customer-creation-departments/queries', { type: 'customer.create', id: 'expiring-customer', name: '授权到期合成客户' }); }
  finally { f.repository.readSnapshot = readSnapshot; }
  assert.ok(scheduled && expired, '必须经过候选投影完成后、提交前的授权到期边界');
  assert.deepEqual(await data(response), { departments: [], allowUnassigned: false });
});

test('客户归属候选判断出现未知异常时失败，不返回成功或空候选掩盖错误', async t => {
  let armed = false, calls = 0;
  const f = await setup(t, () => { if (armed && ++calls === 3) throw new Error('synthetic-customer-candidate-failure'); });
  await departmentWriter(f); const sales = await f.login('sales');
  const readSnapshot = f.repository.readSnapshot.bind(f.repository);
  f.repository.readSnapshot = async tenant => { const snapshot = await readSnapshot(tenant); armed = true; return snapshot; };
  let response: Response;
  try { response = await sales(f.prefix + '/customer-creation-departments/queries', { type: 'customer.create', id: 'failing-customer', name: '故障合成客户' }); }
  finally { f.repository.readSnapshot = readSnapshot; }
  assert.equal(calls, 3, '异常必须发生在实际客户创建权限判定内');
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { code: string }).code, 'SERVICE_UNAVAILABLE');
});
