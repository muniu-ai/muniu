// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseIdentityService, EnterprisePermissionService, type EnterpriseRepository, type EnterpriseRecord, type ObjectAccessDescriptor } from '../src/index.js';
async function fixture() {
  const events = new Map<string, EnterpriseRecord[]>();
  const repository: EnterpriseRepository = { async read(tenant) { return structuredClone(events.get(tenant) ?? []); }, async transact(tenant, work) {
    const result = work(structuredClone(events.get(tenant) ?? [])); events.set(tenant, [...(events.get(tenant) ?? []), ...structuredClone(result.events)]); return result.value;
  } };
  let clock = '2026-11-02T01:00:00.000Z'; const now = () => clock;
  const identity = new EnterpriseIdentityService({ repository, now });
  await identity.provision({ tenantId: 'tenant', name: '合成企业', issuer: 'https://issuer.test/', maxMembers: 200, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
  const admin = { tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 };
  const workspace = await identity.createWorkspace(admin, 'workspace', { name: '主体', mode: 'builtin' });
  for (const id of ['sales-a', 'sales-b', 'manager', 'project', 'finance', 'auditor', 'named-finance-agent']) {
    const invite = await identity.invite(admin, `invite-${id}`, { id, subject: id, displayName: id === 'named-finance-agent' ? '财务 Agent' : id, organizationAdmin: false });
    await identity.acceptInvitation({ ...admin, principalId: id }, `accept-${id}`, id, 1, invite.token);
  }
  const permissions = new EnterprisePermissionService({ repository, now });
  const actor = (principalId: string) => ({ ...admin, principalId });
  const ref = (objectType: string, objectId: string): ObjectAccessDescriptor => ({ tenantId: 'tenant', workspaceId: workspace.id, objectType, objectId,
    ownerPrincipalId: 'sales-a', fieldClasses: { name: 'public', amountMinor: 'price', costMinor: 'cost', phone: 'contact' }, approvalFields: ['amountMinor'] });
  const grant = (id: string, role: string, scope: unknown, fieldClasses = ['public']) => permissions.grantRole(admin, `grant-${id}`, {
    id: `role-${id}`, workspaceId: workspace.id, principalId: id, role, scope, fieldClasses,
    operations: ['read', 'draft', 'write', 'business_approve', 'execution_approve', 'audit'], expiresAt: '2027-01-01T00:00:00.000Z' } as never);
  return { repository, identity, permissions, admin, actor, workspace, ref, grant, advance: (value: string) => { clock = value; } };
}
test('管理员与同名 Agent 不自动取得业务资格；销售只访问本人或明确共享对象', async () => {
  const f = await fixture(); const object = f.ref('customer', 'customer-a');
  await assert.rejects(f.permissions.assertAccess(f.admin, object, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  await assert.rejects(f.permissions.assertAccess(f.actor('named-finance-agent'), object, 'business_approve'), { code: 'OBJECT_ACCESS_DENIED' });
  await f.grant('sales-a', 'sales', { kind: 'owned' }, ['public', 'price', 'contact']);
  await f.grant('sales-b', 'sales', { kind: 'owned' }, ['public', 'price', 'contact']);
  const view = await f.permissions.filterFields(f.actor('sales-a'), object, { name: '客户甲', amountMinor: 100, costMinor: 50, phone: 'fixture-phone', unclassified: 'must-not-leak' });
  assert.deepEqual(view, { name: '客户甲', amountMinor: 100, phone: 'fixture-phone' });
  await assert.rejects(f.permissions.assertAccess(f.actor('sales-b'), object, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  const share = await f.permissions.grantObject(f.admin, 'share', { id: 'share-a', workspaceId: f.workspace.id, principalId: 'sales-b', objectType: 'customer', objectId: 'customer-a',
    operations: ['read'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(await f.permissions.filterFields(f.actor('sales-b'), object, { name: '客户甲', phone: 'hidden' }), { name: '客户甲' });
  await f.permissions.revoke(f.admin, 'revoke-share', 'object', share.id, 1);
  await assert.rejects(f.permissions.assertAccess(f.actor('sales-b'), object, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
});
test('没有关键字段读取权限不能盲批，缺少审批字段定义也不得放行', async () => {
  const f = await fixture();
  await f.grant('manager', 'sales_manager', { kind: 'workspace' }, ['public']);
  await assert.rejects(f.permissions.assertBusinessDecision(f.actor('manager'), f.ref('quote_version', 'quote'), 'sales-a'), { code: 'FIELD_ACCESS_DENIED' });
  await f.grant('finance', 'finance', { kind: 'workspace' }, ['public', 'price', 'cost']);
  await assert.rejects(f.permissions.assertBusinessDecision(f.actor('finance'), { ...f.ref('receipt', 'receipt'), approvalFields: undefined }, 'sales-a'), { code: 'APPROVAL_FIELDS_REQUIRED' });
});
test('部门、项目和订单范围分别判断，字段权限和制单批准分离不能被角色名称替代', async () => {
  const f = await fixture();
  const parent = await f.permissions.createDepartment(f.admin, 'parent', { workspaceId: f.workspace.id, name: '销售' });
  const child = await f.permissions.createDepartment(f.admin, 'child', { workspaceId: f.workspace.id, name: '项目组', parentId: parent.id });
  await f.grant('manager', 'sales_manager', { kind: 'department', departmentId: parent.id }, ['public', 'price']);
  const customer = { ...f.ref('customer', 'customer-a'), departmentId: child.id };
  await f.permissions.assertAccess(f.actor('manager'), customer, 'read');
  await assert.rejects(f.permissions.assertAccess(f.actor('manager'), { ...customer, departmentId: 'other' }, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  await f.grant('project', 'project_owner', { kind: 'objects', objects: [{ objectType: 'project', objectId: 'project-a' }] });
  await f.permissions.assertAccess(f.actor('project'), { ...f.ref('milestone', 'm1'), projectId: 'project-a' }, 'write');
  await assert.rejects(f.permissions.assertAccess(f.actor('project'), { ...f.ref('milestone', 'm2'), projectId: 'project-b' }, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  await f.grant('finance', 'finance', { kind: 'objects', objects: [{ objectType: 'order', objectId: 'order-a' }] }, ['public', 'price', 'cost']);
  const receipt = { ...f.ref('receipt', 'receipt-a'), orderId: 'order-a' };
  await assert.rejects(f.permissions.assertBusinessDecision(f.actor('finance'), receipt, 'finance'), { code: 'SEPARATION_OF_DUTIES_REQUIRED' });
  await f.permissions.assertBusinessDecision(f.actor('finance'), receipt, 'sales-a');
  await assert.rejects(f.permissions.assertBusinessDecision(f.admin, receipt, 'sales-a'), { code: 'OBJECT_ACCESS_DENIED' });
  await assert.rejects(f.permissions.assertAccess(f.actor('finance'), { ...receipt, orderId: 'order-b' }, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
});
test('跨租户、停用成员与撤销角色即时拒绝；审计员只读证据', async () => {
  const f = await fixture(); const role = await f.grant('auditor', 'auditor', { kind: 'workspace' });
  const evidence = f.ref('evidence_ref', 'evidence');
  await f.permissions.assertAccess(f.actor('auditor'), evidence, 'audit');
  await assert.rejects(f.permissions.assertAccess(f.actor('auditor'), evidence, 'write'), { code: 'OBJECT_ACCESS_DENIED' });
  await assert.rejects(f.permissions.assertAccess(f.actor('auditor'), { ...evidence, tenantId: 'foreign' }, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  await f.permissions.revoke(f.admin, 'revoke-auditor', 'role', role.id, 1);
  await assert.rejects(f.permissions.assertAccess(f.actor('auditor'), evidence, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  await f.grant('sales-a', 'sales', { kind: 'owned' });
  await f.identity.commandMember(f.admin, 'disable-sales', 'sales-a', 2, { type: 'disable' });
  await assert.rejects(f.permissions.assertAccess(f.actor('sales-a'), f.ref('customer', 'c'), 'read'), { code: 'MEMBER_UNAVAILABLE' });
});


test('角色或共享到期后不能继续读取，修改旧查询结果不能扩大权限', async () => {
  const f = await fixture();
  await f.grant('sales-a', 'sales', { kind: 'owned' }, ['public', 'contact']);
  await f.grant('sales-b', 'sales', { kind: 'owned' }, ['public', 'contact']);
  const object = f.ref('customer', 'customer-a');
  await f.permissions.grantObject(f.admin, 'short-share', { id: 'short-share', workspaceId: f.workspace.id, principalId: 'sales-b', objectType: 'customer', objectId: 'customer-a',
    operations: ['read'], fieldClasses: ['public'], expiresAt: '2026-11-03T00:00:00.000Z' });
  await f.permissions.assertAccess(f.actor('sales-b'), object, 'read');
  const view = await f.permissions.configuration(f.admin, f.workspace.id);
  (view.grants[0] as unknown as { fieldClasses: string[] }).fieldClasses.push('contact');
  await assert.rejects(f.permissions.assertAccess(f.actor('sales-b'), object, 'read', ['phone']), { code: 'FIELD_ACCESS_DENIED' });
  f.advance('2026-11-03T00:00:00.000Z');
  await assert.rejects(f.permissions.assertAccess(f.actor('sales-b'), object, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  f.advance('2027-01-01T00:00:00.000Z');
  await assert.rejects(f.permissions.assertAccess(f.actor('sales-a'), object, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
});

test('批准操作的字段类别不代替读取许可，审批前必须能读取关键字段', async () => {
  const f = await fixture();
  await f.permissions.grantRole(f.admin, 'approve-without-read', { id: 'approve-only', workspaceId: f.workspace.id, principalId: 'manager', role: 'sales_manager',
    scope: { kind: 'workspace' }, operations: ['business_approve'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z' });
  await assert.rejects(f.permissions.assertBusinessDecision(f.actor('manager'), f.ref('quote_version', 'quote'), 'sales-a'), { code: 'OBJECT_ACCESS_DENIED' });
  await f.permissions.grantRole(f.admin, 'read-public-only', { id: 'read-only', workspaceId: f.workspace.id, principalId: 'manager', role: 'sales_manager',
    scope: { kind: 'workspace' }, operations: ['read'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  await assert.rejects(f.permissions.assertBusinessDecision(f.actor('manager'), f.ref('quote_version', 'quote'), 'sales-a'), { code: 'FIELD_ACCESS_DENIED' });
});

test('服务价格版本由获准销售经理维护，销售只能读取获准价格字段', async () => {
  const f = await fixture();
  await f.grant('manager', 'sales_manager', { kind: 'workspace' }, ['public', 'price']);
  await f.grant('sales-a', 'sales', { kind: 'workspace' }, ['public', 'price']);
  const service = { ...f.ref('service_version', 'service-v1'), fieldClasses: { title: 'public' as const, unitPriceMinor: 'price' as const } };
  await f.permissions.assertAccess(f.actor('sales-a'), service, 'read', ['unitPriceMinor']);
  await assert.rejects(f.permissions.assertAccess(f.actor('sales-a'), service, 'write', ['unitPriceMinor']), { code: 'OBJECT_ACCESS_DENIED' });
  await f.permissions.assertAccess(f.actor('manager'), service, 'write', ['unitPriceMinor']);
});
