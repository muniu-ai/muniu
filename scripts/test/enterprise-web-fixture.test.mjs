// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startEnterpriseWebFixture } from '../lib/enterprise-web-fixture.mjs';

async function web(t) {
  const root = await mkdtemp(join(tmpdir(), 'mn-web-fixture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, 'web'); await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><body>synthetic-fixture-page</body></html>');
  return { root, webRoot };
}
const cookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0];
async function beginLogin(fixture) {
  const response = await fetch(fixture.origin + '/v2/auth/login?organizationId=' + encodeURIComponent(fixture.tenantId), { redirect: 'manual' });
  assert.equal(response.status, 302);
  const loginCookie = cookie(response, 'mn-enterprise-dev-login'); assert.ok(loginCookie);
  const authorization = new URL(response.headers.get('location'));
  assert.equal(authorization.searchParams.get('response_type'), 'code'); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const selector = await fetch(authorization, { redirect: 'manual' });
  assert.equal(selector.status, 200);
  const text = await selector.text(), ticket = /name="request" value="([A-Za-z0-9_-]+)"/u.exec(text)?.[1];
  assert.ok(ticket); assert.doesNotMatch(text, /access_token|id_token|Bearer /u);
  const selectionCookie = cookie(selector, 'mn-test-oidc-login'); assert.ok(selectionCookie);
  return { authorization, loginCookie, selectionCookie, ticket, referrerPolicy: selector.headers.get('referrer-policy'), contentPolicy: selector.headers.get('content-security-policy') };
}
async function choose(fixture, start, subject) {
  const selected = await fetch(new URL('/authorize', start.authorization), { method: 'POST', redirect: 'manual',
    headers: { origin: start.authorization.origin, cookie: start.selectionCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: start.ticket, subject }) });
  assert.equal(selected.status, 303);
  const callback = new URL(selected.headers.get('location')); assert.equal(callback.origin, fixture.origin); assert.equal(callback.pathname, '/v2/auth/callback');
  return callback;
}
async function finish(fixture, start, callback) {
  const response = await fetch(callback, { redirect: 'manual', headers: { cookie: start.loginCookie } });
  assert.equal(response.status, 303);
  const sessionCookie = cookie(response, 'mn-enterprise-dev-session'); assert.ok(sessionCookie);
  const sessionResponse = await fetch(fixture.origin + '/v2/auth/session', { headers: { cookie: sessionCookie } });
  assert.equal(sessionResponse.status, 200);
  const session = (await sessionResponse.json()).data;
  const call = (path, body, key) => fetch(fixture.origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { origin: fixture.origin, cookie: sessionCookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { session, call };
}
async function login(fixture, subject) { const start = await beginLogin(fixture); return finish(fixture, start, await choose(fixture, start, subject)); }
async function data(response, status = 200) {
  const envelope = await response.json(); assert.equal(response.status, status, envelope.code); return envelope.data;
}

test('合成账号选择页保留表单来源，不把浏览器的空来源作为可信来源', async t => {
  const { webRoot } = await web(t), fixture = await startEnterpriseWebFixture({ webRoot, mode: 'uninitialized' }); t.after(() => fixture.close());
  const start = await beginLogin(fixture);
  assert.equal(start.referrerPolicy, 'strict-origin', 'no-referrer causes a browser navigation POST to carry Origin null');
  assert.ok(start.contentPolicy.includes("form-action 'self' " + start.authorization.searchParams.get('redirect_uri')), 'the registered callback must be allowed after the form POST redirect');
  const refused = await fetch(new URL('/authorize', start.authorization), { method: 'POST', redirect: 'manual',
    headers: { origin: 'null', cookie: start.selectionCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: start.ticket, subject: 'sales' }) });
  assert.equal(refused.status, 400);
});

test('隔离夹具支持真实 Code+PKCE 登录、无工作区初始化和纯组织管理员，关闭后清理自有状态', async t => {
  const { webRoot } = await web(t), fixture = await startEnterpriseWebFixture({ webRoot, mode: 'uninitialized' }); t.after(() => fixture.close());
  assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
  assert.equal((await fetch(fixture.origin + '/')).status, 200);
  assert.deepEqual((await data(await fetch(fixture.origin + '/v2/auth/organizations'))).organizations.map(item => item.id), [fixture.tenantId]);
  const admin = await login(fixture, 'admin');
  assert.equal(admin.session.principalId, 'admin'); assert.equal(admin.session.organizationAdmin, true);
  assert.deepEqual(await data(await admin.call('/v2/workspaces')), []);
  const workspace = await data(await admin.call('/v2/workspaces', { name: '首次经营主体', mode: 'builtin' }, 'initialize-workspace'), 201);
  assert.deepEqual(await data(await admin.call('/v2/workspaces/' + workspace.id + '/business/customer')), []);
  assert.deepEqual(await data(await admin.call('/v2/workspaces/' + workspace.id + '/business-command-checks', { type: 'customer.create', id: 'not-granted', name: '不得自动授权' })), { allowedNow: false, reasonCode: 'OBJECT_ACCESS_DENIED' });
  const unbound = await beginLogin(fixture), unboundCallback = await choose(fixture, unbound, fixture.invitationSubject);
  assert.equal((await fetch(unboundCallback, { redirect: 'manual', headers: { cookie: unbound.loginCookie } })).status, 401);
  const invitation = await data(await admin.call('/v2/organizations/' + fixture.tenantId + '/invitations', { subject: fixture.invitationSubject, displayName: '合成待邀请成员', organizationAdmin: false }, 'invite-browser-member'), 201);
  const invited = await login(fixture, fixture.invitationSubject); assert.equal(invited.session.status, 'invited'); assert.equal(invited.session.organizationAdmin, false);
  const accepted = await data(await invited.call('/v2/organizations/' + fixture.tenantId + '/invitations/' + invitation.id + '/accept', { expectedStreamVersion: invitation.member.streamVersion, token: invitation.token }, 'accept-browser-invitation'));
  assert.equal(accepted.status, 'active'); assert.equal(fixture.hooks.protocol().tokenExchanges, 3);
  const stateRoot = fixture.stateRoot; await access(stateRoot);
  await fixture.close(); await fixture.close();
  await assert.rejects(access(stateRoot), { code: 'ENOENT' });
  await assert.rejects(fetch(fixture.origin + '/v2/health', { signal: AbortSignal.timeout(1000) }));
});

test('合成发行方限制回调和账号，错误 PKCE 不能兑换，重复回调不产生第二次登录', async t => {
  const { webRoot } = await web(t), fixture = await startEnterpriseWebFixture({ webRoot, mode: 'empty' }); t.after(() => fixture.close());
  const start = await beginLogin(fixture);
  const foreign = new URL(start.authorization); foreign.searchParams.set('redirect_uri', 'http://127.0.0.1:1/foreign');
  assert.equal((await fetch(foreign, { redirect: 'manual' })).status, 400);
  const badAccount = await fetch(new URL('/authorize', start.authorization), { method: 'POST', redirect: 'manual',
    headers: { origin: start.authorization.origin, cookie: start.selectionCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request: start.ticket, subject: 'unregistered' }) });
  assert.equal(badAccount.status, 400);
  const callback = await choose(fixture, start, 'sales');
  const wrongPkce = await fetch(new URL('/token', start.authorization), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'muniu-fixture', code: callback.searchParams.get('code'), redirect_uri: start.authorization.searchParams.get('redirect_uri'), code_verifier: 'x'.repeat(43) }) });
  assert.equal(wrongPkce.status, 400);
  const browser = await finish(fixture, start, callback);
  assert.equal(browser.session.principalId, 'sales'); assert.equal(browser.session.tenantId, fixture.tenantId); assert.equal(browser.session.organizationAdmin, false);
  assert.deepEqual(await data(await browser.call('/v2/workspaces/' + fixture.workspaceId + '/business/customer')), []);
  const exchanges = fixture.hooks.protocol().tokenExchanges;
  assert.equal((await fetch(callback, { redirect: 'manual', headers: { cookie: start.loginCookie } })).status, 401);
  assert.equal(fixture.hooks.protocol().tokenExchanges, exchanges);
});

test('业务种子通过真实命令和独立批准生成，资料与字段隔离、版本冲突和撤权可用于浏览器验收', async t => {
  const { webRoot } = await web(t), fixture = await startEnterpriseWebFixture({ webRoot }); t.after(() => fixture.close());
  const sales = await login(fixture, 'sales'), reader = await login(fixture, 'reader'), manager = await login(fixture, 'manager');
  const prefix = '/v2/workspaces/' + fixture.workspaceId;
  const quotePath = prefix + '/business/quote_version/' + fixture.references.quoteDraft.objectId;
  assert.ok(Object.hasOwn((await data(await sales.call(quotePath))).values, 'totalMinor'));
  assert.equal(Object.hasOwn((await data(await reader.call(quotePath))).values, 'totalMinor'), false);
  const order = await data(await manager.call(prefix + '/business/order/' + fixture.references.order.objectId));
  assert.equal(order.values.status, 'active');
  const knowledge = await data(await sales.call(prefix + '/knowledge/search', { query: '合成验收资料' }));
  assert.ok(knowledge.hits.length > 0);
  const original = fixture.references.versionCustomer;
  const changed = await fixture.hooks.changeCustomerVersion(); assert.equal(changed.streamVersion, original.streamVersion + 1);
  const stale = await sales.call(prefix + '/business/commands', { type: 'customer.rename', id: original.objectId, expectedStreamVersion: original.streamVersion, name: '不得覆盖新版本' }, 'stale-browser-write');
  assert.equal(stale.status, 409);
  await fixture.hooks.revokeAccount('sales');
  assert.equal((await sales.call(prefix + '/business/customer/' + fixture.references.customer.objectId)).status, 403);
  await assert.rejects(fixture.hooks.revokeAccount('outside-fixture'), /FIXTURE_ACCOUNT_INVALID/);
});

test('CLI 只输出合成 URL 与状态，SIGTERM 清理自己的临时目录并保留旁边文件', async t => {
  const { root, webRoot } = await web(t), temporary = join(root, 'child-temporary'); await mkdir(temporary);
  await writeFile(join(temporary, 'preserve.txt'), 'unrelated-sentinel');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../enterprise-web-fixture.mjs', import.meta.url)), '--web-root', webRoot, '--mode', 'empty'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, TMPDIR: temporary, NODE_OPTIONS: '--max-old-space-size=256' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', () => {});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const ready = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('FIXTURE_START_TIMEOUT')), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('FIXTURE_EXITED_BEFORE_READY')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 4096) { clearTimeout(timer); reject(new Error('FIXTURE_OUTPUT_LIMIT')); return; }
      const line = output.split('\n')[0];
      if (!output.includes('\n')) return;
      try { const message = JSON.parse(line); clearTimeout(timer); resolve(message); } catch { clearTimeout(timer); reject(new Error('FIXTURE_OUTPUT_INVALID')); }
    });
  });
  assert.deepEqual(Object.keys(ready).sort(), ['mode', 'origin', 'status', 'synthetic']);
  assert.equal(ready.status, 'ready'); assert.equal(ready.synthetic, true); assert.equal(ready.mode, 'empty');
  assert.equal((await fetch(ready.origin + '/v2/health')).status, 200);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.deepEqual(await readdir(temporary), ['preserve.txt']);
});
