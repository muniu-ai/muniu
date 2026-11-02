// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserAuthService, EnterpriseIdentityService } from '@mn/enterprise-services';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { createEnterpriseEventRepository } from '../src/enterprise-event-repository.js';

test('企业领域事实加密持久化，清空查询投影仍可重建，两个服务实例并发邀请只提交一次', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite');
  const hmacKey = randomBytes(32), keyProvider = new InMemoryKeyProvider(randomBytes(32)), cas = new FileCas({ rootDir: join(root, 'cas') });
  const store = new SqliteStorage({ databaseFile: path, hmacKey });
  const makeRepository = () => createEnterpriseEventRepository({ store, cas, keyProvider });
  const make = () => new EnterpriseIdentityService({ repository: makeRepository() });
  const first = make(), second = make();
  await first.provision({ tenantId: 'tenant-a', name: '不得写入明文的企业名称', issuer: 'https://issuer.test/', maxMembers: 200,
    administrator: { id: 'admin', subject: 'protected-oidc-subject', displayName: '管理员' } });
  const actor = { tenantId: 'tenant-a', principalId: 'admin', sessionEpoch: 1 };
  const input = { id: 'member', subject: 'protected-invited-subject', displayName: '成员', organizationAdmin: false };
  const results = await Promise.all([first.invite(actor, 'same-key', input), second.invite(actor, 'same-key', input)]);
  assert.deepEqual(results[0], results[1]);
  const history = await store.readEventHistory('tenant-a', 0, 1000);
  assert.equal(history.events.filter(event => event.type === 'enterprise.member.invited').length, 1);
  assert.doesNotMatch(JSON.stringify(history), /不得写入明文|protected-oidc|protected-invited/);
  await store.transact('tenant-a', tx => { tx.putProjection('enterprise.member', 'admin', { id: 'admin', status: 'disabled', streamVersion: 999 }); });
  assert.equal((await make().listMembers(actor)).find(member => member.id === 'admin')!.status, 'active');
  await store.transact('tenant-a', tx => { for (const item of tx.listProjections<{id:string}>('enterprise.member')) tx.deleteProjection('enterprise.member', item.id); });
  assert.equal((await make().listMembers(actor)).length, 2);
  const session = await new BrowserAuthService({ repository: makeRepository() }).createSession('tenant-a', { issuer: 'https://issuer.test/', subject: 'protected-oidc-subject' });
  await store.close();
  const reopened = new SqliteStorage({ databaseFile: path, hmacKey });
  const restoredRepository = createEnterpriseEventRepository({ store: reopened, cas, keyProvider });
  const restored = new EnterpriseIdentityService({ repository: restoredRepository });
  assert.equal((await restored.listMembers(actor)).length, 2);
  assert.equal((await new BrowserAuthService({ repository: restoredRepository }).resolveSession('tenant-a', session.token)).actor.principalId, 'admin');
  await reopened.close();
  assert.equal((await readFile(path)).includes(Buffer.from('protected-invited-subject')), false);
  assert.equal((await readFile(path)).includes(Buffer.from(session.session.csrfToken)), false);
});

test('权限与额度从加密事件重放，两个实例并发撤销仅接受当前版本', async t => {
  const { EnterprisePermissionService, EnterpriseQuotaService } = await import('@mn/enterprise-services');
  const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite'), hmacKey = randomBytes(32), keyProvider = new InMemoryKeyProvider(randomBytes(32));
  const cas = new FileCas({ rootDir: join(root, 'cas') }); let store = new SqliteStorage({ databaseFile: path, hmacKey });
  t.after(() => store.close());
  const repository = () => createEnterpriseEventRepository({ store, cas, keyProvider });
  const identity = new EnterpriseIdentityService({ repository: repository() });
  await identity.provision({ tenantId: 'tenant', name: '合成权限企业', issuer: 'https://issuer.test/', maxMembers: 20,
    administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
  const actor = { tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 };
  const workspace = await identity.createWorkspace(actor, 'workspace', { name: '经营主体', mode: 'builtin' });
  const first = new EnterprisePermissionService({ repository: repository() }), second = new EnterprisePermissionService({ repository: repository() });
  const grant = await first.grantRole(actor, 'grant', { id: 'role', workspaceId: workspace.id, principalId: 'admin', role: 'finance', scope: { kind: 'workspace' },
    operations: ['read', 'business_approve'], fieldClasses: ['public', 'price'], expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20,
    tokens: 10000, costMinorUnits: '500', evaluationDailyTokens: 1000, evaluationDailyCostMinorUnits: '50', singleEvaluationTokens: 200,
    singleEvaluationCostMinorUnits: '10', currency: 'CNY' as const, validFrom: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const quotas = new EnterpriseQuotaService({ repository: repository() });
  await quotas.provision('tenant', 'platform', 0, limits); await quotas.configure(actor, 'workspace-quota', workspace.id, 0, limits);
  const outcomes = await Promise.allSettled([first.revoke(actor, 'revoke-a', 'role', grant.id, 1), second.revoke(actor, 'revoke-b', 'role', grant.id, 1)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'STREAM_VERSION_CONFLICT');
  const history = await store.readEventHistory('tenant', 0, 1000);
  assert.doesNotMatch(JSON.stringify(history), /costMinorUnits|fieldClasses|business_approve/);
  await store.close(); store = new SqliteStorage({ databaseFile: path, hmacKey });
  const restored = new EnterprisePermissionService({ repository: repository() });
  assert.equal((await restored.configuration(actor, workspace.id)).roles[0]!.streamVersion, 2);
  await assert.rejects(restored.assertAccess(actor, { tenantId: 'tenant', workspaceId: workspace.id, objectType: 'order', objectId: 'order', fieldClasses: { amount: 'price' } }, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  assert.equal((await new EnterpriseQuotaService({ repository: repository() }).configuration(actor, workspace.id)).workspace!.tokens, 10000);
});
