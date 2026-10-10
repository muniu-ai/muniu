// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { appendKernelEvent } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { createAgentOsHost } from '../src/host.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mn-authenticated-principal-'));
  const store = new SqliteStorage({ databaseFile: join(directory, 'db.sqlite'), hmacKey: Buffer.alloc(32, 54) });
  const cas = new FileCas({ rootDir: join(directory, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 55));
  let principalId = 'oidc-owner';
  const host = await createAgentOsHost({ profile: 'enterprise', store, cas, protectedPayloadKeyProvider: keyProvider,
    secretStore: { async save() { return 'vault://fixture/model'; }, async read() { return 'fixture'; } },
    identityResolver: () => ({ tenantId: 'enterprise', principalId, organizationRoles: ['organization_admin'] }) });
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const send = async (path: string, body?: unknown) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as any };
  };
  return { store, host, send, databaseFile: join(directory, 'db.sqlite'), principal: (id: string) => { principalId = id; } };
}
test('可信企业身份首次访问即登记人员事实，重复并发不增加权限或事件', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.send('/v2/workspaces')));
  assert.ok(responses.every(r => r.status === 200));
  const person = await f.store.transact('enterprise', tx => tx.getProjection<any>('principal', 'oidc-owner'));
  assert.equal(person?.kind, 'human'); assert.equal(person.streamVersion, 1);
  assert.equal(await f.store.transact('enterprise', tx => tx.listProjections('membership').length), 0);
  const events = await f.store.readEvents('enterprise', 0, 100);
  assert.equal(events.events.filter(event => event.type === 'principal.authenticated').length, 1);
  await f.store.rebuildProjections('enterprise'); assert.deepEqual(await f.store.transact('enterprise', tx => tx.getProjection('principal', 'oidc-owner')), person);
  const raw = new DatabaseSync(f.databaseFile);
  try { raw.prepare('delete from projections where tenant_id = ? and namespace = ? and projection_key = ?').run('enterprise', 'principal', 'oidc-owner'); }
  finally { raw.close(); }
  assert.ok((await f.send('/v2/workspaces')).status >= 400);
  assert.equal(await f.store.transact('enterprise', tx => tx.getProjection('principal', 'oidc-owner')), undefined);
  await f.store.rebuildProjections('enterprise');
  assert.deepEqual(await f.store.transact('enterprise', tx => tx.getProjection('principal', 'oidc-owner')), person);
});
test('企业首次身份可创建工作区、目标、MCP连接及受保护资料', async t => {
  const f = await fixture(t);
  const created = await f.send('/v2/workspaces', { name: '企业资料', viewMode: 'business', pluginIds: ['opc'] }); assert.equal(created.status, 201, JSON.stringify(created.body));
  const workspace = created.body.data;
  const thread = await f.host.kernel.createThread('enterprise', 'oidc-owner', randomUUID(), { workspaceId: workspace.id, pluginId: 'opc', subject: '交付研究' });
  const asset = await f.send('/v2/assets', { workspaceId: workspace.id, expectedStreamVersion: 0, attachments: [{ fileName: 'scope.txt', mediaType: 'text/plain', protected: true, contentBase64: Buffer.from('企业获准事实').toString('base64') }] });
  assert.equal(asset.status, 201); const material = asset.body.data[0];
  assert.equal((await f.send(`/v2/assets/${material.id}`)).status, 200);
  const goal = await f.send(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: '整理已授权资料', resourceRefs: [{ namespace: 'asset', resourceId: material.id, streamVersion: material.streamVersion, digest: material.digest }], budget: { maxTokens: 1000, maxCostMinorUnits: '10', currency: 'CNY', maxDurationMs: 60000 }, deliverables: [{ key: 'report', title: '报告', required: true, criteria: [{ id: 'source', description: '引用资料' }] }] });
  assert.equal(goal.status, 201, JSON.stringify(goal.body));
  const connection = await f.send(`/v2/workspaces/${workspace.id}/mcp/connections`, { expectedStreamVersion: 0, label: '资料', endpoint: 'https://mcp.example.com/read', uriPrefixes: ['store://facts/'], maxRequests: 10, expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(connection.status, 201, JSON.stringify(connection.body));
  f.principal('oidc-other'); assert.ok((await f.send(`/v2/assets/${material.id}`)).status >= 400);
  assert.equal(await f.store.transact('enterprise', tx => tx.getProjection('membership', `${workspace.id}:oidc-other`)), undefined);
});
test('旧身份不能复活停用人员，也不覆盖既有主体类型或租户', async t => {
  const f = await fixture(t); await f.send('/v2/workspaces');
  for (const change of [{ disabledAt: new Date().toISOString() }, { kind: 'service' }, { tenantId: 'other' }]) {
    await f.store.transact('enterprise', tx => {
      const value = tx.getProjection<any>('principal', 'oidc-owner');
      tx.putProjection('principal', value.id, { ...value, disabledAt: undefined, kind: 'human', tenantId: 'enterprise', ...change, streamVersion: value.streamVersion + 1 });
      appendKernelEvent(tx, { tenantId: 'enterprise', aggregateType: 'principal', aggregateId: value.id, expectedStreamVersion: value.streamVersion, type: 'fixture.principal_changed', actorId: 'administrator', generation: 0, correlationId: randomUUID(), publicPayload: {} });
    });
    assert.ok((await f.send('/v2/workspaces')).status >= 400);
  }
  f.principal('x'.repeat(201)); assert.ok((await f.send('/v2/workspaces')).status >= 400);
});
