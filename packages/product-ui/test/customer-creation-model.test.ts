// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseBrowserClient } from '../src/client.js';
import { CustomerCreationModel } from '../src/customer-creation-model.js';

const session = { tenantId: 'tenant', principalId: 'department-sales', displayName: '部门销售', status: 'active' as const, organizationAdmin: false, csrfToken: 'session-csrf', expiresAt: '2026-12-01T00:00:00.000Z', profile: 'development' as const };
const draft = { tenantId: 'tenant', workspaceId: 'workspace-a', recordId: 'actual-customer', name: '本次客户' };
const choices = { departments: [{ id: 'department-sales', name: '销售部' }], allowUnassigned: false };
const response = (data: unknown) => new Response(JSON.stringify({ data, traceId: 'trace' }), { headers: { 'content-type': 'application/json' } });
const denied = () => new Response(JSON.stringify({ code: 'OBJECT_ACCESS_DENIED', message: '无业务权限', action: '核对权限', fieldIssues: [], traceId: 'trace', retryable: false }), { status: 403, headers: { 'content-type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('部门客户创建须明确选择本次候选，再用同一客户ID完成完整预检和写入', async () => {
  const seen: Request[] = [];
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), randomId: () => 'create-customer-operation', fetch: async (input, init) => {
    const request = new Request(input, init); seen.push(request.clone());
    if (request.url.endsWith('/session')) return response(session);
    if (request.url.endsWith('/customer-creation-departments/queries')) return response(choices);
    if (request.url.endsWith('/business-command-checks')) return response({ allowedNow: true });
    return response({ reference: { tenantId: draft.tenantId, workspaceId: draft.workspaceId, objectType: 'customer', objectId: draft.recordId, streamVersion: 1, digest: 'a'.repeat(64) }, values: { name: draft.name, departmentId: 'department-sales' } });
  } });
  await api.loadSession(); const model = new CustomerCreationModel(api); await model.load(draft);
  assert.equal(model.snapshot().selectedDepartmentId, undefined);
  assert.throws(() => model.build(draft), /选择.*部门/u);
  assert.throws(() => model.selectDepartment('unlisted-department'), /部门/u);
  model.selectDepartment('department-sales');
  const command = model.build(draft);
  const expected: Extract<EnterpriseContractTypes['EnterpriseBusinessCommand'], { type: 'customer.create' }> = { type: 'customer.create', id: draft.recordId, name: draft.name, departmentId: 'department-sales' };
  assert.deepEqual(command, expected);
  assert.deepEqual(await api.query('checkEnterpriseBusinessCommand', { path: { workspaceId: draft.workspaceId }, body: command }), { allowedNow: true });
  const ticket = api.prepareMutation('executeBusinessCommand', { path: { workspaceId: draft.workspaceId }, body: command });
  assert.equal((await api.executeMutation(ticket)).reference.objectId, draft.recordId);
  assert.equal(seen.length, 4); assert.deepEqual(await seen[1]!.json(), { type: 'customer.create', id: draft.recordId, name: draft.name });
  assert.deepEqual(await seen[2]!.json(), command); assert.deepEqual(await seen[3]!.json(), command);
  assert.equal(seen[2]!.headers.get('idempotency-key'), null); assert.equal(seen[3]!.headers.get('idempotency-key'), ticket.key);
});

test('无归属资格时阻止命令生成，只有Host明确允许时才能创建未归属客户', async () => {
  let allowUnassigned = false;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async input => response(String(input).endsWith('/session') ? session : { departments: [], allowUnassigned }) });
  await api.loadSession(); const model = new CustomerCreationModel(api); await model.load(draft);
  assert.throws(() => model.build(draft), /业务权限/u);
  allowUnassigned = true; await model.load(draft);
  assert.deepEqual(model.build(draft), { type: 'customer.create', id: draft.recordId, name: draft.name });
});

test('客户草稿或工作区改变立即清除原选择，迟到候选和撤权响应不能覆盖当前草稿', async () => {
  const oldName = deferred<Response>(), newName = deferred<Response>(), oldWorkspace = deferred<Response>(), newWorkspace = deferred<Response>();
  const waiting = [oldName, newName, oldWorkspace, newWorkspace]; let calls = 0;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async input => String(input).endsWith('/session') ? response(session) : calls++ === 0 ? response(choices) : waiting.shift()!.promise });
  await api.loadSession(); const model = new CustomerCreationModel(api); await model.load(draft); model.selectDepartment('department-sales');
  const changedName = { ...draft, name: '修改后的客户' };
  assert.throws(() => model.build(changedName), /重新核对/u);
  const oldLoad = model.load(draft), currentLoad = model.load(changedName);
  assert.equal(model.snapshot().data, undefined); assert.equal(model.snapshot().selectedDepartmentId, undefined);
  assert.throws(() => model.build(changedName), /核对/u);
  newName.resolve(response(choices)); await currentLoad; model.selectDepartment('department-sales');
  oldName.resolve(response({ departments: [{ id: 'old-only', name: '原候选' }], allowUnassigned: true })); await oldLoad;
  assert.equal(model.build(changedName).departmentId, 'department-sales');
  const changedWorkspace = { ...changedName, workspaceId: 'workspace-b', recordId: 'another-customer' };
  const oldWorkspaceLoad = model.load(changedName), newWorkspaceLoad = model.load(changedWorkspace);
  assert.equal(model.snapshot().selectedDepartmentId, undefined); assert.equal(model.snapshot().data, undefined);
  newWorkspace.resolve(response({ departments: [{ id: 'new-department', name: '新经营主体部门' }], allowUnassigned: false })); await newWorkspaceLoad;
  model.selectDepartment('new-department'); oldWorkspace.resolve(denied()); await oldWorkspaceLoad;
  assert.deepEqual(model.build(changedWorkspace), { type: 'customer.create', id: changedWorkspace.recordId, name: changedWorkspace.name, departmentId: 'new-department' });
  assert.throws(() => model.build(changedName), /重新核对/u);
});

test('当前候选查询撤权后不能沿用旧部门，空名称清空候选且不发查询', async () => {
  let revoke = false, queries = 0;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async input => {
    if (String(input).endsWith('/session')) return response(session);
    queries++; return revoke ? denied() : response(choices);
  } });
  await api.loadSession(); const model = new CustomerCreationModel(api); await model.load(draft); model.selectDepartment('department-sales');
  revoke = true; await model.load(draft);
  assert.equal(model.snapshot().status, 'error'); assert.equal(model.snapshot().data, undefined); assert.equal(model.snapshot().selectedDepartmentId, undefined);
  assert.throws(() => model.build(draft), /核对/u);
  await model.load({ ...draft, name: '   ' }); assert.equal(queries, 2); assert.equal(model.snapshot().status, 'idle');
  assert.throws(() => model.build({ ...draft, name: '   ' }), /名称/u);
});

test('身份变化和跨租户草稿不能复用此前候选生成新客户命令', async () => {
  let currentSession = session, queries = 0;
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async input => {
    if (String(input).endsWith('/session')) return response(currentSession); queries++; return response(choices);
  } });
  await api.loadSession(); const model = new CustomerCreationModel(api); await model.load(draft); model.selectDepartment('department-sales');
  currentSession = { ...session, principalId: 'other-person', csrfToken: 'other-session' }; await api.loadSession();
  assert.throws(() => model.build(draft), /重新核对/u);
  await model.load({ ...draft, tenantId: 'another-tenant' });
  assert.equal(queries, 1); assert.equal(model.snapshot().status, 'error'); assert.equal(model.snapshot().data, undefined);
});
