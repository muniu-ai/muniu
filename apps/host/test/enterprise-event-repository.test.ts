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
