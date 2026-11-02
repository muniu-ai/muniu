// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { createEnterpriseEventRepository } from '../src/enterprise-event-repository.js';
import { createEnterpriseHost } from '../src/enterprise-host.js';
import { createTestOidcIssuer } from './fixtures/enterprise-oidc-issuer.js';
const origin = 'https://workbench.example.test';
const cookie = (response: Response, prefix: string) => response.headers.getSetCookie().find(value => value.startsWith(prefix + '='))!.split(';')[0]!;
async function fixture(t: test.TestContext) {
  const issuer = await createTestOidcIssuer();
  const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-browser-'));
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: randomBytes(32) });
  const repository = createEnterpriseEventRepository({ store, cas: new FileCas({ rootDir: join(root, 'cas') }), keyProvider: new InMemoryKeyProvider(randomBytes(32)) });
  const host = createEnterpriseHost({ repository, origin, profile: 'development', providers: { 'tenant-a': { issuer: issuer.issuer, clientId: 'muniu-fixture' }, 'tenant-b': { issuer: issuer.issuer, clientId: 'muniu-fixture' } } });
  await host.identity.provision({ tenantId: 'tenant-a', name: '合成公司', issuer: issuer.issuer, maxMembers: 200,
    administrator: { id: 'admin', subject: 'admin-subject', displayName: '管理员' } });
  await host.identity.provision({ tenantId: 'tenant-b', name: '另一个合成企业', issuer: issuer.issuer, maxMembers: 200,
    administrator: { id: 'admin-b', subject: 'admin-b-subject', displayName: '另一管理员' } });
  await host.identity.createWorkspace({ tenantId: 'tenant-b', principalId: 'admin-b', sessionEpoch: 1 }, 'workspace-b', { name: '仅属于企业 B', mode: 'builtin' });
  t.after(async () => { await host.close(); await store.close(); await issuer.close(); await rm(root, { recursive: true, force: true }); });
  const login = async (subject = 'admin-subject', mode = 'normal', tenantId = 'tenant-a') => {
    const start = await host.dispatch(new Request(`${origin}/v2/auth/login?organizationId=${tenantId}`));
    assert.equal(start.status, 302, await start.clone().text());
    const loginCookie = cookie(start, '__Host-mn-enterprise-login');
    const callbackUrl = issuer.callback(start.headers.get('location')!, subject, mode);
    const response = await host.dispatch(new Request(callbackUrl, { headers: { cookie: loginCookie } }));
    return { response, loginCookie, callbackUrl };
  };
  return { host, issuer, store, login };
}

test('真实 OIDC PKCE 和签名校验建立 HttpOnly 会话，租户与角色只取服务端映射', async t => {
  const f = await fixture(t); const result = await f.login();
  assert.equal(result.response.status, 303, await result.response.clone().text());
  const setCookie = result.response.headers.getSetCookie().find(value => value.startsWith('__Host-mn-enterprise-session='))!;
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Lax/); assert.doesNotMatch(setCookie, /Domain=/);
  const sessionCookie = cookie(result.response, '__Host-mn-enterprise-session');
  const session = await f.host.dispatch(new Request(`${origin}/v2/auth/session`, { headers: { cookie: sessionCookie } }));
  const view = (await session.json() as any).data;
  assert.equal(view.tenantId, 'tenant-a'); assert.equal(view.principalId, 'admin'); assert.ok(view.csrfToken);
  assert.equal((await f.host.dispatch(new Request(`${origin}/v2/organizations/attacker-tenant/members`, { headers: { cookie: sessionCookie } }))).status, 404);
  const repeated = await f.host.dispatch(new Request(result.callbackUrl, { headers: { cookie: result.loginCookie } }));
  assert.equal(repeated.status, 401); assert.equal(f.issuer.exchanges(), 1);
  const history = await f.store.readEventHistory('tenant-a', 0, 1000);
  assert.doesNotMatch(JSON.stringify(history), /admin-subject|csrfToken|codeVerifier|access_token/);
});

test('拒绝签名、nonce、受众、期限错误和未绑定人员，不把 IdP 管理员声明当作权限', async t => {
  const f = await fixture(t);
  for (const mode of ['bad-signature', 'wrong-nonce', 'wrong-audience', 'expired']) assert.equal((await f.login('admin-subject', mode)).response.status, 401, mode);
  assert.equal((await f.login('unknown-person')).response.status, 401);
  assert.equal((await f.host.dispatch(new Request(`${origin}/v2/workspaces`, { headers: { authorization: 'Bearer forged' } }))).status, 401);
});

test('写入同时要求同源、CSRF 和幂等；重绑后原会话立即拒绝', async t => {
  const f = await fixture(t); const logged = await f.login();
  assert.equal(logged.response.status, 303, await logged.response.clone().text());
  const sessionCookie = cookie(logged.response, '__Host-mn-enterprise-session');
  const view = (await (await f.host.dispatch(new Request(`${origin}/v2/auth/session`, { headers: { cookie: sessionCookie } }))).json() as any).data;
  const send = (headers: Record<string,string>) => f.host.dispatch(new Request(`${origin}/v2/workspaces`, { method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: '经营主体', mode: 'builtin' }) }));
  assert.equal((await send({ origin: 'https://other.test', 'x-csrf-token': view.csrfToken, 'idempotency-key': 'workspace' })).status, 403);
  assert.equal((await send({ origin, 'idempotency-key': 'workspace' })).status, 403);
  assert.equal((await send({ origin, 'x-csrf-token': view.csrfToken })).status, 400);
  const headers = { origin, 'x-csrf-token': view.csrfToken, 'idempotency-key': 'workspace' };
  const created = await send(headers); assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual((await (await send(headers)).json() as any).data, (await created.json() as any).data);
  await f.host.identity.commandMember({ tenantId: 'tenant-a', principalId: 'admin', sessionEpoch: 1 }, 'rebind', 'admin', 1, { type: 'rebind', subject: 'changed-subject' });
  assert.equal((await f.host.dispatch(new Request(`${origin}/v2/auth/session`, { headers: { cookie: sessionCookie } }))).status, 401);
});

test('邀请在 HTTP 路径幂等，由绑定人员接受；非管理员即使持 IdP 管理员声明也不能邀请', async t => {
  const f = await fixture(t);
  const adminLogin = await f.login();
  const adminCookie = cookie(adminLogin.response, '__Host-mn-enterprise-session');
  const sessionView = async (value: string) => (await (await f.host.dispatch(new Request(`${origin}/v2/auth/session`, { headers: { cookie: value } }))).json() as any).data;
  const adminSession = await sessionView(adminCookie);
  const post = (path: string, value: unknown, browserCookie: string, csrfToken: string, key: string) => f.host.dispatch(new Request(`${origin}${path}`, {
    method: 'POST', headers: { cookie: browserCookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken, 'idempotency-key': key }, body: JSON.stringify(value) }));
  const invitationBody = { subject: 'sales-subject', displayName: '销售', organizationAdmin: false };
  const invitationResponse = await post('/v2/organizations/tenant-a/invitations', invitationBody, adminCookie, adminSession.csrfToken, 'invite');
  assert.equal(invitationResponse.status, 201);
  const invitation = (await invitationResponse.json() as any).data;
  assert.deepEqual((await (await post('/v2/organizations/tenant-a/invitations', invitationBody, adminCookie, adminSession.csrfToken, 'invite')).json() as any).data, invitation);
  const salesLogin = await f.login('sales-subject'); assert.equal(salesLogin.response.status, 303);
  const salesCookie = cookie(salesLogin.response, '__Host-mn-enterprise-session'), salesSession = await sessionView(salesCookie);
  assert.equal(salesSession.organizationAdmin, false); assert.equal(salesSession.status, 'invited');
  const accepted = await post(`/v2/organizations/tenant-a/invitations/${invitation.id}/accept`, { expectedStreamVersion: 1, token: invitation.token }, salesCookie, salesSession.csrfToken, 'accept');
  assert.equal(accepted.status, 200);
  assert.equal((await post('/v2/organizations/tenant-a/invitations', { ...invitationBody, subject: 'third-person' }, salesCookie, salesSession.csrfToken, 'third')).status, 403);
  const disabled = await post(`/v2/organizations/tenant-a/members/${invitation.id}/commands`, { expectedStreamVersion: 2, type: 'disable' }, adminCookie, adminSession.csrfToken, 'disable');
  assert.equal(disabled.status, 200);
  assert.equal((await f.host.dispatch(new Request(`${origin}/v2/auth/session`, { headers: { cookie: salesCookie } }))).status, 403);
});

test('并发回调只兑换一次，注销后旧 cookie 不可继续读取', async t => {
  const f = await fixture(t);
  const start = await f.host.dispatch(new Request(`${origin}/v2/auth/login?organizationId=tenant-a`));
  const loginCookie = cookie(start, '__Host-mn-enterprise-login');
  const url = f.issuer.callback(start.headers.get('location')!);
  const responses = await Promise.all([1, 2].map(() => f.host.dispatch(new Request(url, { headers: { cookie: loginCookie } }))));
  assert.deepEqual(responses.map(r => r.status).sort(), [303, 401]); assert.equal(f.issuer.exchanges(), 1);
  const active = responses.find(r => r.status === 303)!;
  const sessionCookie = cookie(active, '__Host-mn-enterprise-session');
  const view = (await (await f.host.dispatch(new Request(`${origin}/v2/auth/session`, { headers: { cookie: sessionCookie } }))).json() as any).data;
  const logout = await f.host.dispatch(new Request(`${origin}/v2/auth/logout`, { method: 'POST', headers: { cookie: sessionCookie, origin, 'x-csrf-token': view.csrfToken } }));
  assert.equal(logout.status, 204); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await f.host.dispatch(new Request(`${origin}/v2/auth/session`, { headers: { cookie: sessionCookie } }))).status, 401);
});

test('两个已开通企业保持独立会话，篡改 cookie 中的租户标识不能取得另一企业权限', async t => {
  const f = await fixture(t);
  const a = await f.login(), b = await f.login('admin-b-subject', 'normal', 'tenant-b');
  assert.equal(a.response.status, 303); assert.equal(b.response.status, 303);
  const cookieA = cookie(a.response, '__Host-mn-enterprise-session'), cookieB = cookie(b.response, '__Host-mn-enterprise-session');
  const read = (path: string, value: string) => f.host.dispatch(new Request(`${origin}${path}`, { headers: { cookie: value } }));
  assert.deepEqual((await (await read('/v2/workspaces', cookieA)).json() as any).data, []);
  assert.equal((await (await read('/v2/workspaces', cookieB)).json() as any).data[0].name, '仅属于企业 B');
  assert.equal((await read('/v2/organizations/tenant-b/members', cookieA)).status, 404);
  const decoded = JSON.parse(Buffer.from(cookieA.split('=')[1]!, 'base64url').toString('utf8'));
  const forged = `__Host-mn-enterprise-session=${Buffer.from(JSON.stringify({ ...decoded, tenantId: 'tenant-b' })).toString('base64url')}`;
  assert.equal((await read('/v2/workspaces', forged)).status, 401);
  assert.equal((await f.login('admin-subject', 'normal', 'tenant-b')).response.status, 401);
});
