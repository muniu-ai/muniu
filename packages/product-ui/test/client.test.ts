// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseBrowserClient, EnterpriseApiFailure } from '../src/client.js';
import { WorkspaceResource } from '../src/workspace-resource.js';

const session = { tenantId: 'tenant', principalId: 'sales', displayName: '销售人员', status: 'active' as const, organizationAdmin: false, csrfToken: 'session-csrf', expiresAt: '2026-12-01T00:00:00.000Z', profile: 'development' as const };
const reference = { tenantId: 'tenant', workspaceId: 'workspace-a', objectType: 'customer' as const, objectId: 'customer', streamVersion: 1, digest: 'a'.repeat(64) };
const response = (data: unknown) => new Response(JSON.stringify({ data, traceId: 'trace' }), { headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string) => new Response(JSON.stringify({ code, message: '请求未完成', action: '核对当前数据', fieldIssues: [], traceId: 'trace', retryable: false }), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('会话只使用同源 Cookie，所有读取禁止缓存，不把凭据写入业务请求正文', async () => {
  const seen: Request[] = [];
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async (input, init) => { seen.push(new Request(input, init)); return response(session); } });
  assert.deepEqual(await api.loadSession(), session);
  assert.equal(seen[0]!.credentials, 'same-origin'); assert.equal(seen[0]!.cache, 'no-store');
  assert.equal(seen[0]!.url, 'https://muniu.test/v2/auth/session');
  assert.equal(seen[0]!.headers.get('authorization'), null); assert.equal(seen[0]!.headers.get('x-csrf-token'), null);
  assert.equal(await seen[0]!.text(), '');
});

test('准备业务写入固定原输入与同一幂等键，网络结果未知时重放不换键', async () => {
  const writes: Request[] = []; let attempt = 0;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), randomId: () => 'stable-operation', fetch: async (input, init) => {
    const request = new Request(input, init); if (request.method === 'GET') return response(session);
    writes.push(request.clone()); if (++attempt === 1) throw new TypeError('synthetic response loss');
    return response({ reference, values: { name: '原客户名称' } });
  } });
  await api.loadSession();
  const body = { type: 'customer.rename' as const, id: 'customer', expectedStreamVersion: 1, name: '原客户名称' };
  const ticket = api.prepareMutation('executeBusinessCommand', { path: { workspaceId: 'workspace-a' }, body });
  body.name = '后来编辑的内容';
  await assert.rejects(api.executeMutation(ticket), error => error instanceof EnterpriseApiFailure && error.unknownOutcome === true);
  assert.equal((await api.executeMutation(ticket)).values.name, '原客户名称');
  for (const request of writes) {
    assert.equal(request.headers.get('idempotency-key'), 'stable-operation'); assert.equal(request.headers.get('x-csrf-token'), session.csrfToken);
    assert.deepEqual(await request.json(), { type: 'customer.rename', id: 'customer', expectedStreamVersion: 1, name: '原客户名称' });
  }
  assert.equal(writes.length, 2);
});

test('只读 POST 携带 CSRF 而不产生幂等写入键', async () => {
  let seen: Request | undefined;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async (input, init) => {
    const request = new Request(input, init); if (request.method === 'GET') return response(session); seen = request; return response({ hits: [] });
  } });
  await api.loadSession();
  await api.query('searchEnterpriseKnowledge', { path: { workspaceId: 'workspace-a' }, body: { query: '需求' } });
  assert.equal(seen!.headers.get('x-csrf-token'), session.csrfToken); assert.equal(seen!.headers.get('idempotency-key'), null);
});

test('客户归属候选按本次真实ID和名称查询，不读取管理员部门目录', async () => {
  const seen: Request[] = [];
  const choices = { departments: [{ id: 'sales-department', name: '销售部' }], allowUnassigned: false };
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async (input, init) => {
    const request = new Request(input, init); seen.push(request.clone());
    return response(request.url.endsWith('/session') ? session : choices);
  } });
  await api.loadSession();
  assert.deepEqual(await api.query('queryEnterpriseCustomerCreationDepartments', { path: { workspaceId: 'workspace-a' }, body: { type: 'customer.create', id: 'actual-new-customer', name: '本次客户' } }), choices);
  assert.equal(seen.length, 2);
  const request = seen[1]!;
  assert.equal(request.url, 'https://muniu.test/v2/workspaces/workspace-a/customer-creation-departments/queries');
  assert.equal(request.method, 'POST'); assert.equal(request.headers.get('x-csrf-token'), session.csrfToken);
  assert.equal(request.headers.get('idempotency-key'), null);
  assert.deepEqual(await request.json(), { type: 'customer.create', id: 'actual-new-customer', name: '本次客户' });
});

test('会话撤销清除客户端身份，过期会话和跨会话旧写入不继续发出', async () => {
  let selected = session, writes = 0, invalidated = 0, deny = false;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), onSessionInvalid: () => { invalidated++; }, fetch: async (input, init) => {
    const request = new Request(input, init); if (request.url.endsWith('/session')) return response(selected);
    if (request.method === 'POST') writes++; return deny ? failure(401, 'SESSION_REVOKED') : response([]);
  } });
  await api.loadSession();
  const ticket = api.prepareMutation('createEnterpriseWorkspace', { body: { name: '新主体', mode: 'builtin' } });
  selected = { ...session, principalId: 'another-person', csrfToken: 'another-session' }; await api.loadSession();
  await assert.rejects(api.executeMutation(ticket), { code: 'SESSION_CHANGED' }); assert.equal(writes, 0);
  deny = true; await assert.rejects(api.query('listEnterpriseWorkspaces', {}), { code: 'SESSION_REVOKED' });
  assert.equal(api.session, undefined); assert.equal(invalidated, 1);
  selected = { ...session, expiresAt: '2026-11-01T00:00:00.000Z' };
  await assert.rejects(api.loadSession(), { code: 'SESSION_EXPIRED' }); assert.equal(api.session, undefined);
});

test('退出经 Host 撤销会话，204 响应不按 JSON 解析', async () => {
  let logout: Request | undefined;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async (input, init) => {
    const request = new Request(input, init); if (request.method === 'GET') return response(session); logout = request; return new Response(null, { status: 204 });
  } });
  await api.loadSession(); await api.logout();
  assert.equal(logout!.url, 'https://muniu.test/v2/auth/logout'); assert.equal(logout!.headers.get('x-csrf-token'), session.csrfToken);
  assert.equal(api.session, undefined);
});

test('先发请求的迟到401不能撤销后取得的新会话', async () => {
  const older = deferred<Response>(), newer = deferred<Response>(); let calls = 0;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async () => (++calls === 1 ? older : newer).promise });
  const oldRequest = api.loadSession(), newRequest = api.loadSession();
  const nextSession = { ...session, principalId: 'new-person', csrfToken: 'new-session' };
  newer.resolve(response(nextSession)); await newRequest;
  older.resolve(failure(401, 'SESSION_REVOKED'));
  await assert.rejects(oldRequest, { code: 'STALE_RESPONSE' });
  assert.deepEqual(api.session, nextSession);
});

test('旧401的响应体迟到时，不能在解析后撤销新会话', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const started = deferred<void>(), delayed = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { status: 401 });
  const parse = delayed.json.bind(delayed); delayed.json = async () => { started.resolve(); return parse(); };
  let calls = 0;
  const nextSession = { ...session, principalId: 'new-person', csrfToken: 'new-session' };
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async () => ++calls === 1 ? delayed : response(nextSession) });
  const oldRequest = api.loadSession(); await started.promise;
  await api.loadSession();
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 'SESSION_REVOKED', message: '旧会话已失效', action: '重新登录', fieldIssues: [], traceId: 'old-trace', retryable: false }))); controller.close();
  await assert.rejects(oldRequest, { code: 'STALE_RESPONSE' }); assert.deepEqual(api.session, nextSession);
});

test('旧成功响应体不能返回给身份已经变化的调用方', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, selected = session;
  const started = deferred<void>(), delayed = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  const parse = delayed.json.bind(delayed); delayed.json = async () => { started.resolve(); return parse(); };
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async input => String(input).endsWith('/session') ? response(selected) : delayed });
  await api.loadSession(); const oldRequest = api.query('listBusinessObjects', { path: { workspaceId: 'workspace-a', objectType: 'customer' } }); await started.promise;
  selected = { ...session, principalId: 'next-person', csrfToken: 'next-session' }; await api.loadSession();
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ reference, values: { name: '旧身份的合成客户' } }], traceId: 'old-data' }))); controller.close();
  await assert.rejects(oldRequest, { code: 'STALE_RESPONSE' }); assert.deepEqual(api.session, selected);
});

test('工作区切换立即清空资料，旧成功或撤权响应都不能覆盖新工作区', async () => {
  const resource = new WorkspaceResource<string>(), first = deferred<string>(), second = deferred<string>();
  let oldSignal: AbortSignal | undefined;
  const old = resource.load('workspace-a', signal => { oldSignal = signal; return first.promise; });
  assert.equal(resource.snapshot().status, 'loading');
  const current = resource.load('workspace-b', () => second.promise);
  assert.equal(oldSignal!.aborted, true); assert.equal(resource.snapshot().data, undefined);
  second.resolve('新工作区资料'); await current; first.resolve('旧机密资料'); await old;
  assert.equal(resource.snapshot().data, '新工作区资料'); assert.equal(resource.snapshot().workspaceId, 'workspace-b');
  const stale = deferred<string>(), replacement = deferred<string>();
  const staleRequest = resource.load('workspace-a', () => stale.promise), replacementRequest = resource.load('workspace-b', () => replacement.promise);
  replacement.resolve('仍是新资料'); await replacementRequest;
  stale.reject(new EnterpriseApiFailure({ status: 403, code: 'OBJECT_ACCESS_DENIED' })); await staleRequest;
  assert.equal(resource.snapshot().data, '仍是新资料'); assert.equal(resource.snapshot().status, 'ready');
  await resource.load('workspace-b', async () => { throw new EnterpriseApiFailure({ status: 403, code: 'OBJECT_ACCESS_DENIED' }); });
  assert.equal(resource.snapshot().data, undefined); assert.equal(resource.snapshot().status, 'error'); resource.clear();
  assert.equal(resource.snapshot().data, undefined);
});
