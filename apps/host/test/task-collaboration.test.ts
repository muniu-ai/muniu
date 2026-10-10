// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendKernelEvent } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { createAgentOsHost } from '../src/host.js';
import { recoverTaskNotifications } from '../src/task-collaboration.js';
import type { GoalV2 } from '@mn/contracts';

async function fixture(t: test.TestContext, material = false) {
  const root = await mkdtemp(join(tmpdir(), 'mn-task-collaboration-'));
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: Buffer.alloc(32, 81) });
  const cas = new FileCas({ rootDir: join(root, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 82));
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, goalPollIntervalMs: 10,
    secretStore: { async save() { return 'keychain://muniu.v2/task-collaboration'; }, async read() { return 'fixture'; } },
    identityResolver: request => ({ tenantId: 'local', principalId: request.headers.get('x-fixture-principal') ?? 'local-owner' }) });
  t.after(async () => { await host.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (path: string, method = 'GET', body?: unknown, principal = 'local-owner', key = randomUUID()) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, { method,
      headers: { 'x-fixture-principal': principal, ...(body === undefined ? {} : { 'content-type': 'application/json', 'Idempotency-Key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (...args: Parameters<typeof request>) => { const r = await request(...args); assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body.data; };
  const workspace = await ok('/v2/workspaces', 'POST', { name: '交付协作', viewMode: 'business', pluginIds: ['opc'] });
  await store.transact('local', tx => {
    for (const id of ['colleague', 'viewer', 'outsider']) {
      const now = new Date().toISOString();
      tx.putProjection('principal', id, { id, tenantId: 'local', kind: 'human', displayName: id === 'colleague' ? '合作者' : id, streamVersion: 1, createdAt: now, updatedAt: now });
      appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'principal', aggregateId: id, expectedStreamVersion: 0, type: 'fixture.principal', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
    }
  });
  for (const [principal, role] of [['colleague', 'operator'], ['viewer', 'viewer']] as const) await ok(`/v2/workspaces/${workspace.id}/members/${principal}`, 'PUT', { expectedStreamVersion: 0, workspaceRole: role });
  const thread = await host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: workspace.id, pluginId: 'opc', subject: '共同整理交付资料' });
  const asset = material ? (await ok('/v2/assets', 'POST', { workspaceId: workspace.id, expectedStreamVersion: 0,
    attachments: [{ fileName: 'source.txt', mediaType: 'text/plain', protected: true, contentBase64: Buffer.from('任务受保护资料').toString('base64') }] }))[0] : undefined;
  const resourceRefs = asset ? [{ namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest }] : [];
  const { goal } = await ok(`/v2/workspaces/${workspace.id}/goals`, 'POST', { threadId: thread.id, objective: '整理交付资料', resourceRefs,
    budget: { maxTokens: 1000, maxCostMinorUnits: '100', currency: 'CNY', maxDurationMs: 60000 },
    deliverables: [{ key: 'report', title: '交付报告', required: true, criteria: [{ id: 'source', description: '说明依据' }] }] });
  const path = `/v2/goals/${goal.id}/assignment`, query = `?workspaceId=${workspace.id}`;
  const input = { workspaceId: workspace.id, expectedStreamVersion: 0, responsiblePrincipalId: 'colleague' };
  return { root, store, host, workspace, asset, goal, path, query, input, request, ok };
}

test('责任分配独立版本、幂等和竞争校验，不改目标身份、授权或业务版本', async t => {
  const f = await fixture(t), initial = await f.ok(f.path + f.query);
  assert.equal(initial.assignment.streamVersion, 0); assert.equal(initial.assignment.responsiblePrincipalId, null);
  assert.equal(initial.members.find((m: any) => m.principalId === 'viewer').available, false);
  const key = randomUUID(), assigned = await f.ok(f.path, 'PUT', f.input, 'local-owner', key);
  assert.equal(assigned.assignment.streamVersion, 1); assert.equal(assigned.assignment.responsiblePrincipalId, 'colleague');
  assert.deepEqual((await f.ok(f.path, 'PUT', f.input, 'local-owner', key)).assignment, assigned.assignment);
  assert.equal((await f.request(f.path, 'PUT', { ...f.input, responsiblePrincipalId: null }, 'local-owner', key)).status, 409);
  assert.equal((await f.request(f.path, 'PUT', { ...f.input, responsiblePrincipalId: 'local-owner' })).status, 409);
  const detail = await f.ok(`/v2/goals/${f.goal.id}${f.query}`);
  assert.equal(detail.goal.principalId, 'local-owner'); assert.equal(detail.goal.streamVersion, f.goal.streamVersion); assert.equal(detail.goal.authorization, undefined);
  const list = await f.ok(`/v2/workspaces/${f.workspace.id}/goals`);
  assert.equal(list[0].assignment.responsible.displayName, '合作者');
  const cleared = await f.ok(f.path, 'PUT', { ...f.input, expectedStreamVersion: 1, responsiblePrincipalId: null });
  assert.equal(cleared.assignment.responsiblePrincipalId, null); assert.equal(cleared.assignment.streamVersion, 2);
});

test('只允许当前可访问任务的成员负责，撤权立即拒绝读取与旧请求', async t => {
  const f = await fixture(t);
  for (const principal of ['viewer', 'outsider']) assert.equal((await f.request(f.path, 'PUT', { ...f.input, responsiblePrincipalId: principal })).status, 403);
  assert.equal((await f.request(f.path, 'PUT', f.input, 'viewer')).status, 403);
  const key = randomUUID(); await f.ok(f.path, 'PUT', f.input, 'colleague', key);
  await f.ok(`/v2/workspaces/${f.workspace.id}/members/colleague`, 'DELETE', { expectedStreamVersion: 1 });
  assert.equal((await f.request(f.path + f.query, 'GET', undefined, 'colleague')).status, 403);
  assert.equal((await f.request(f.path, 'PUT', f.input, 'colleague', key)).status, 403);
  const list = await f.ok(`/v2/workspaces/${f.workspace.id}/goals`);
  assert.equal(list[0].assignment.responsible.available, false);
  assert.match(list[0].assignment.responsible.unavailableReason, /移除/u);
  const notices = await f.ok(`/v2/inbox${f.query}`, 'GET');
  assert.equal(notices.some((n: any) => n.noticeType === 'assignment'), false);
});

test('分配通知只发给负责人，已读有独立版本且不会改变任务验收', async t => {
  const f = await fixture(t); await f.ok(f.path, 'PUT', f.input);
  const items = await f.ok(`/v2/inbox${f.query}`, 'GET', undefined, 'colleague');
  const item = items.find((n: any) => n.noticeType === 'assignment'); assert.ok(item);
  assert.equal(item.readState, 'unread'); assert.equal(item.navigation.resourceRef.resourceId, f.goal.id);
  assert.equal((await f.ok(`/v2/inbox${f.query}`)).some((n: any) => n.id === item.id), false);
  const path = `/v2/notifications/${item.id}/commands`, body = { workspaceId: f.workspace.id, expectedStreamVersion: item.streamVersion, command: 'mark_read' };
  assert.equal((await f.request(path, 'POST', body)).status, 404);
  const key = randomUUID(), read = await f.ok(path, 'POST', body, 'colleague', key);
  assert.equal(read.readState, 'read'); assert.equal(read.streamVersion, item.streamVersion + 1);
  assert.equal((await f.ok(path, 'POST', body, 'colleague', key)).streamVersion, read.streamVersion);
  assert.equal((await f.request(path, 'POST', { ...body, command: 'mark_unread' }, 'colleague')).status, 409);
  const unread = await f.ok(path, 'POST', { ...body, expectedStreamVersion: read.streamVersion, command: 'mark_unread' }, 'colleague');
  assert.equal(unread.readState, 'unread');
  assert.equal((await f.ok(`/v2/goals/${f.goal.id}${f.query}`)).goal.streamVersion, f.goal.streamVersion);
});

test('事件重建保留责任与通知已读，重新分配使旧收件人通知失效', async t => {
  const f = await fixture(t); await f.ok(f.path, 'PUT', f.input);
  const item = (await f.ok(`/v2/inbox${f.query}`, 'GET', undefined, 'colleague')).find((n: any) => n.noticeType === 'assignment');
  await f.ok(`/v2/notifications/${item.id}/commands`, 'POST', { workspaceId: f.workspace.id, expectedStreamVersion: item.streamVersion, command: 'mark_read' }, 'colleague');
  await f.store.rebuildProjections('local');
  assert.equal((await f.ok(f.path + f.query)).assignment.responsiblePrincipalId, 'colleague');
  assert.equal((await f.ok(`/v2/inbox${f.query}`, 'GET', undefined, 'colleague')).find((n: any) => n.id === item.id).readState, 'read');
  await f.ok(f.path, 'PUT', { ...f.input, expectedStreamVersion: 1, responsiblePrincipalId: 'local-owner' });
  assert.equal((await f.ok(`/v2/inbox${f.query}`, 'GET', undefined, 'colleague')).some((n: any) => n.id === item.id), false);
  assert.equal((await f.ok(`/v2/inbox${f.query}`)).filter((n: any) => n.noticeType === 'assignment').length, 1);
});


test('并发分配仅有一个版本胜出，跨工作区和未知字段不能变更责任', async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    f.request(f.path, 'PUT', f.input),
    f.request(f.path, 'PUT', { ...f.input, responsiblePrincipalId: 'local-owner' }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.ok(f.path + f.query)).assignment.streamVersion, 1);
  const other = await f.ok('/v2/workspaces', 'POST', { name: '其他工作区', viewMode: 'business', pluginIds: ['opc'] });
  assert.equal((await f.request(f.path + `?workspaceId=${other.id}`)).status, 404);
  assert.equal((await f.request(f.path, 'PUT', { ...f.input, workspaceId: other.id, expectedStreamVersion: 1 })).status, 404);
  assert.equal((await f.request(f.path, 'PUT', { ...f.input, expectedStreamVersion: 1, authority: {} })).status, 422);
  assert.equal((await f.request(f.path + f.query + '&workspaceId=other')).status, 422);
});

test('后台成果通知从事件恢复且不重复，状态改变后隐藏旧通知', async t => {
  const f = await fixture(t); await f.ok(f.path, 'PUT', f.input);
  const observe = () => recoverTaskNotifications({ store: f.store, protectedJournal: true, tenantId: 'local', now: () => new Date().toISOString(), id: () => randomUUID() });
  const transition = async (status: GoalV2['status']) => f.store.transact('local', tx => {
    const value = tx.getProjection<GoalV2>('goal.state', f.goal.id)!;
    tx.putProjection('goal.state', value.id, { ...value, status, streamVersion: value.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'goal', aggregateId: value.id, expectedStreamVersion: value.streamVersion,
      type: 'fixture.delivery_state', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  await transition('awaiting_acceptance'); await observe(); await observe();
  const inbox = () => f.ok(`/v2/inbox${f.query}`, 'GET', undefined, 'colleague');
  const first = (await inbox()).filter((n: any) => n.noticeType === 'delivery'); assert.equal(first.length, 1);
  assert.equal(first[0].title, '负责的任务已有成果');
  await f.store.rebuildProjections('local'); await observe();
  assert.equal((await inbox()).filter((n: any) => n.noticeType === 'delivery').length, 1);
  await transition('accepted'); await observe();
  assert.equal((await inbox()).some((n: any) => n.id === first[0].id), false);
  assert.equal((await f.request(`/v2/notifications/${first[0].id}/commands`, 'POST', { workspaceId: f.workspace.id,
    expectedStreamVersion: 0, command: 'mark_read' }, 'colleague')).status, 404);
});


test('通知不暴露来源撤回后的任务入口，旧已读命令也失效', async t => {
  const f = await fixture(t, true); await f.ok(f.path, 'PUT', f.input);
  const item = (await f.ok(`/v2/inbox${f.query}`, 'GET', undefined, 'colleague')).find((n: any) => n.noticeType === 'assignment'); assert.ok(item);
  await f.ok(`/v2/assets/${f.asset.id}`, 'DELETE', { expectedStreamVersion: f.asset.streamVersion, reason: '撤回任务资料' });
  assert.equal((await f.ok(`/v2/inbox${f.query}`, 'GET', undefined, 'colleague')).some((n: any) => n.id === item.id), false);
  assert.equal((await f.request(`/v2/notifications/${item.id}/commands`, 'POST', { workspaceId: f.workspace.id,
    expectedStreamVersion: 0, command: 'mark_read' }, 'colleague')).status, 404);
});
