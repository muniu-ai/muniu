// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseIdentityService, reduceIdentityEvents, type EnterpriseRepository, type EnterpriseRecord } from '../src/index.js';
function fixture() {
  const records = new Map<string, EnterpriseRecord[]>();
  const repository: EnterpriseRepository = {
    async read(tenantId) { return structuredClone(records.get(tenantId) ?? []); },
    async transact(tenantId, work) {
      const current = structuredClone(records.get(tenantId) ?? []);
      const result = work(current);
      records.set(tenantId, [...current, ...structuredClone(result.events)]);
      return structuredClone(result.value);
    },
  };
  let now = '2026-11-02T01:00:00.000Z';
  const service = new EnterpriseIdentityService({ repository, now: () => now });
  return { service, records, now: (value: string) => { now = value; } };
}
const issuer = 'https://issuer.example.test/';
const provision = (s: EnterpriseIdentityService, tenantId = 'company-a') => s.provision({ tenantId, name: '合成服务企业', issuer,
  administrator: { id: 'admin-a', subject: 'oidc-admin', displayName: '管理员' }, maxMembers: 200 });
const actor = { tenantId: 'company-a', principalId: 'admin-a', sessionEpoch: 1 };

test('人员只能通过显式 issuer/subject 绑定进入企业，外部声明不授予角色', async () => {
  const { service } = fixture(); await provision(service);
  assert.equal((await service.resolveIdentity('company-a', { issuer, subject: 'oidc-admin' })).id, 'admin-a');
  await assert.rejects(service.resolveIdentity('company-a', { issuer, subject: 'unknown' }), /IDENTITY_NOT_BOUND/);
  await assert.rejects(service.resolveIdentity('company-b', { issuer, subject: 'oidc-admin' }), /ORGANIZATION_NOT_FOUND/);
  await assert.rejects(service.resolveIdentity('company-a', { issuer: 'https://other.example.test/', subject: 'oidc-admin' }), /IDENTITY_NOT_BOUND/);
});

test('邀请须由本人接受，幂等重放检查当前权限，不能恢复已移除人员', async () => {
  const { service } = fixture(); await provision(service);
  const input = { id: 'person-b', subject: 'oidc-b', displayName: '销售', organizationAdmin: false };
  const invitation = await service.invite(actor, 'invite-b', input);
  assert.deepEqual(await service.invite(actor, 'invite-b', input), invitation);
  assert.deepEqual(await service.invite(actor, 'invite-b', { organizationAdmin: false, displayName: '销售', subject: 'oidc-b', id: 'person-b' }), invitation);
  const invited = await service.resolveIdentity('company-a', { issuer, subject: 'oidc-b' });
  assert.equal(invited.status, 'invited');
  const person = { tenantId: 'company-a', principalId: invited.id, sessionEpoch: invited.sessionEpoch };
  await assert.rejects(service.acceptInvitation(actor, 'accept-wrong', invitation.id, 1, invitation.token), /INVITATION_IDENTITY_MISMATCH/);
  const accepted = await service.acceptInvitation(person, 'accept-b', invitation.id, 1, invitation.token);
  assert.equal(accepted.status, 'active');
  await assert.rejects(service.invite(person, 'invite-c', { ...input, id: 'person-c', subject: 'oidc-c' }), /ORGANIZATION_ADMIN_REQUIRED/);
  await service.commandMember(actor, 'remove-b', 'person-b', 2, { type: 'remove' });
  await assert.rejects(service.acceptInvitation(person, 'accept-b', invitation.id, 1, invitation.token), /MEMBER_UNAVAILABLE/);
});

test('停用再启用不能绕过本人接受邀请', async () => {
  const { service } = fixture(); await provision(service);
  await service.invite(actor, 'invite-b', { id: 'person-b', subject: 'oidc-b', displayName: '销售', organizationAdmin: false });
  await service.commandMember(actor, 'disable-b', 'person-b', 1, { type: 'disable' });
  await assert.rejects(service.commandMember(actor, 'activate-b', 'person-b', 2, { type: 'activate' }), /MEMBER_STATE_CONFLICT/);
});

test('成员停用和账号重绑使原会话立即失效，旧版本不能覆盖更新', async () => {
  const { service } = fixture(); await provision(service);
  const invite = await service.invite(actor, 'invite-b', { id: 'person-b', subject: 'oidc-b', displayName: '销售', organizationAdmin: false });
  const person = { tenantId: 'company-a', principalId: 'person-b', sessionEpoch: 1 };
  await service.acceptInvitation(person, 'accept-b', invite.id, 1, invite.token);
  await service.commandMember(actor, 'disable-b', 'person-b', 2, { type: 'disable' });
  await assert.rejects(service.assertActor(person), /MEMBER_UNAVAILABLE/);
  await assert.rejects(service.commandMember(actor, 'stale-b', 'person-b', 2, { type: 'activate' }), /STREAM_VERSION_CONFLICT/);
  await service.commandMember(actor, 'activate-b', 'person-b', 3, { type: 'activate' });
  await assert.rejects(service.assertActor(person), /SESSION_REVOKED/);
  await service.commandMember(actor, 'rebind-b', 'person-b', 4, { type: 'rebind', subject: 'new-subject' });
  await assert.rejects(service.resolveIdentity('company-a', { issuer, subject: 'oidc-b' }), /IDENTITY_NOT_BOUND/);
  assert.equal((await service.resolveIdentity('company-a', { issuer, subject: 'new-subject' })).sessionEpoch, 4);
  await service.commandMember(actor, 'rebind-admin', 'admin-a', 1, { type: 'rebind', subject: 'new-admin' });
  await provision(service);
  await assert.rejects(service.resolveIdentity('company-a', { issuer, subject: 'oidc-admin' }), /IDENTITY_NOT_BOUND/);
});

test('事件可重建成员与工作区；最后管理员不能被停用，工作区不能跨租户', async () => {
  const { service, records } = fixture(); await provision(service);
  await assert.rejects(service.commandMember(actor, 'disable-admin', 'admin-a', 1, { type: 'disable' }), /LAST_ADMINISTRATOR/);
  const workspace = await service.createWorkspace(actor, 'workspace', { name: '经营主体', mode: 'builtin' });
  assert.equal(workspace.tenantId, 'company-a');
  assert.deepEqual((await service.listWorkspaces(actor))[0], workspace);
  await assert.rejects(service.listWorkspaces({ ...actor, tenantId: 'company-b' }), /ORGANIZATION_NOT_FOUND/);
  const replay = reduceIdentityEvents(records.get('company-a')!);
  assert.equal(replay.members.get('admin-a')!.subject, 'oidc-admin');
  assert.equal(replay.workspaces.size, 1);
});
