// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserAuthService, EnterpriseIdentityService, type EnterpriseRepository, type EnterpriseRecord } from '../src/index.js';
function fixture() {
  const events = new Map<string, EnterpriseRecord[]>();
  const repository: EnterpriseRepository = { async read(id) { return events.get(id) ?? []; }, async transact(id, work) {
    const result = work(events.get(id) ?? []); events.set(id, [...(events.get(id) ?? []), ...result.events]); return result.value;
  } };
  let time = '2026-11-02T01:00:00.000Z';
  const options = { repository, now: () => time };
  return { identity: new EnterpriseIdentityService(options), auth: new BrowserAuthService(options), advance: () => { time = '2026-11-03T01:00:00.000Z'; } };
}
const setup = (identity: EnterpriseIdentityService) => identity.provision({ tenantId: 'tenant', name: '合成企业', issuer: 'https://issuer.test/', maxMembers: 200,
  administrator: { id: 'admin', subject: 'admin-subject', displayName: '管理员' } });

test('登录承诺绑定浏览器、state 和期限，领取一次后不能重新兑换授权码', async () => {
  const f = fixture(); await setup(f.identity);
  const login = await f.auth.startLogin('tenant', '/');
  await assert.rejects(f.auth.claimLogin('tenant', login.id, 'other-browser', login.state), /LOGIN_ATTEMPT_INVALID/);
  await assert.rejects(f.auth.claimLogin('tenant', login.id, login.browserSecret, 'other-state'), /LOGIN_ATTEMPT_INVALID/);
  const claim = await f.auth.claimLogin('tenant', login.id, login.browserSecret, login.state);
  assert.equal(claim.codeVerifier, login.codeVerifier);
  await assert.rejects(f.auth.claimLogin('tenant', login.id, login.browserSecret, login.state), /LOGIN_ATTEMPT_INVALID/);
  const expired = await f.auth.startLogin('tenant', '/'); f.advance();
  await assert.rejects(f.auth.claimLogin('tenant', expired.id, expired.browserSecret, expired.state), /LOGIN_ATTEMPT_INVALID/);
});

test('会话不接受其他租户、伪造主体或旧绑定；注销可持久重放', async () => {
  const f = fixture(); await setup(f.identity);
  await assert.rejects(f.auth.createSession('tenant', { issuer: 'https://issuer.test/', subject: 'unknown' }), /IDENTITY_NOT_BOUND/);
  const session = await f.auth.createSession('tenant', { issuer: 'https://issuer.test/', subject: 'admin-subject' });
  const resolved = await f.auth.resolveSession('tenant', session.token);
  assert.equal(resolved.actor.principalId, 'admin');
  await assert.rejects(f.auth.resolveSession('other', session.token), /AUTHENTICATION_REQUIRED/);
  await f.identity.commandMember(resolved.actor, 'rebind', 'admin', 1, { type: 'rebind', subject: 'new-admin' });
  await assert.rejects(f.auth.resolveSession('tenant', session.token), /SESSION_REVOKED/);
  const fresh = await f.auth.createSession('tenant', { issuer: 'https://issuer.test/', subject: 'new-admin' });
  await f.auth.logout('tenant', fresh.token);
  await assert.rejects(f.auth.resolveSession('tenant', fresh.token), /AUTHENTICATION_REQUIRED/);
});
