// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentOsKernel, appendKernelEvent, beginExternalReadInTransaction, finishExternalReadInTransaction, sha256 } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, assertContextSource, createMcpReadWorkerHandler } from '@mn/worker';
import { configureProductProjectionJournal } from '../src/projection-journal.js';
import { createMcpConnection, commandMcpConnection, createMcpRequest, getMcpRequest, listMcpConnections, listMcpRequests, createMcpWorkerPorts, validateMcpContextSource } from '../src/mcp-resources.js';
import { readAssetContent } from '../src/assets.js';
import type { McpTransport } from '../src/mcp-transport.js';
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mn-mcp-')), store = new SqliteStorage({ databaseFile: join(dir, 'db.sqlite'), hmacKey: Buffer.alloc(32, 3) });
  const cas = new FileCas({ rootDir: join(dir, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 4));
  configureProductProjectionJournal(store, cas, keyProvider);
  const kernel = new AgentOsKernel(store); await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'ws', { name: 'MCP', viewMode: 'business', pluginIds: ['opc'] });
  let calls = 0, clock = Date.now(), onRead = async () => {}, handler: McpTransport = async input => input.method === 'resources/list' ? { resultType: 'complete', resources: [{ uri: 'store://facts/a', name: '资料' }], nextCursor: 'page2' }
    : input.method === 'resources/templates/list' ? { resultType: 'complete', resourceTemplates: [{ uriTemplate: 'store://facts/{id}', name: '按编号' }] }
      : { resultType: 'complete', contents: [{ uri: 'store://facts/a', mimeType: 'text/plain', text: '获准资料事实' }, { uri: 'store://facts/b', mimeType: 'application/json', text: '{"value":2}' }] };
  const values = new Map<string, string>(), secrets = { async save(scope: any, value: string) { const ref = 'fixture:' + JSON.stringify(scope); values.set(ref, value); return ref; }, async read(_scope: any, ref: string) { await onRead(); return values.get(ref)!; } };
  const options = { store, cas, keyProvider, protectedJournal: true, secrets, now: () => new Date(clock).toISOString(), id: (_kind: string) => randomUUID(),
    transport: (async input => { calls++; return handler(input); }) as McpTransport };
  const scope = { tenantId: 'local', workspaceId: workspace.id, principalId: 'local-owner' };
  const connection = await createMcpConnection(options, scope, { expectedStreamVersion: 0, label: '测试连接', endpoint: 'https://mcp.example.com/resources', bearerToken: 'fixture-secret',
    expiresAt: new Date(Date.now() + 60000).toISOString(), uriPrefixes: ['store://facts/'], maxRequests: 10 }, 'connection');
  const worker = new AgentOsWorker({ id: 'mcp-worker', store, lock: { engineLockDigest: 'x', expectedEngineLockDigest: 'x', pluginLockDigest: 'x', expectedPluginLockDigest: 'x' },
    handlers: { 'mcp.resource.read': createMcpReadWorkerHandler(createMcpWorkerPorts(options)) } });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const create = (input: any, key: string = randomUUID()) => createMcpRequest(options, scope, connection.id, { expectedStreamVersion: connection.streamVersion, ...input }, key);
  const get = (id: string) => getMcpRequest(options, scope, id);
  const disable = () => commandMcpConnection(options, scope, connection.id, { expectedStreamVersion: connection.streamVersion, command: 'disable' }, 'disable');
  return { ...options, scope, connection, worker, create, get, disable, calls: () => calls, advance: (ms: number) => { clock += ms; }, setHandler: (next: McpTransport) => { handler = next; }, setSecretRead: (next: () => Promise<void>) => { onRead = next; } };
}
test('真实SQLite只读Job按需发现并原子导入多个受保护Asset，幂等且可重建', async t => {
  const f = await fixture(t), first = await f.create({ kind: 'resources' }, 'resources'); assert.equal(first.status, 'queued'); assert.equal(f.calls(), 0);
  assert.deepEqual(await f.create({ kind: 'resources' }, 'resources'), first);
  assert.equal((await f.worker.pollOnce()).status, 'completed'); const catalog = await f.get(first.id); assert.equal(catalog.resources?.length, 1);
  await assert.rejects(f.create({ kind: 'resources', cursor: 'forged' }));
  const reading = await f.create({ kind: 'read', selection: { catalogRequestId: catalog.id, uri: catalog.resources![0]!.uri } });
  assert.equal((await f.worker.pollOnce()).status, 'completed'); const result = await f.get(reading.id); assert.equal(result.assetRefs?.length, 2);
  const asset = await f.store.transact('local', tx => tx.getProjection<any>('asset', result.assetRefs![0]!.resourceId));
  assert.equal(asset.protected, true); assert.equal(asset.provenance.kind, 'mcp_resource');
  assert.equal((await readAssetContent({ store: f.store, cas: f.cas, protectedPayloadKeyProvider: f.keyProvider, tenantId: 'local', principalId: f.scope.principalId, asset, validateContextSource: validateMcpContextSource })).toString(), '获准资料事实');
  await f.store.rebuildProjections('local'); assert.deepEqual(await f.get(reading.id), result);
  const events = await f.store.readEvents('local', 0, 1000); assert.equal(JSON.stringify(events).includes('fixture-secret'), false); assert.equal(JSON.stringify(events).includes('获准资料事实'), false);
});
test('连接撤回后目录与派生Asset拒读，排队任务不会外发', async t => {
  const f = await fixture(t), list = await f.create({ kind: 'resources' }); await f.worker.pollOnce();
  const read = await f.create({ kind: 'read', selection: { catalogRequestId: list.id, uri: 'store://facts/a' } }); await f.worker.pollOnce();
  const result = await f.get(read.id); await f.create({ kind: 'resources' }); await f.disable();
  const before = f.calls(); await f.worker.pollOnce(); assert.equal(f.calls(), before);
  await assert.rejects(f.get(list.id));
  await assert.rejects(f.store.transact('local', tx => assertContextSource(tx, f.scope, result.assetRefs![0]!, validateMcpContextSource)));
});
test('凭据读取期间撤权阻止实际外发；在途撤权不能提交附件', async t => {
  const f = await fixture(t); await f.create({ kind: 'resources' }); f.setSecretRead(async () => { await f.disable(); });
  await f.worker.pollOnce(); assert.equal(f.calls(), 0);
  assert.equal(await f.store.transact('local', tx => tx.listProjections('asset').length), 0);
});
test('网络结果未知不自动重发，换幂等键也不能绕过原承诺', async t => {
  const f = await fixture(t), operation = await f.create({ kind: 'resources' });
  f.setHandler(async () => { throw new Error('secret network diagnostic'); }); await f.worker.pollOnce();
  const value = await f.get(operation.id); assert.equal(value.status, 'needs_reconciliation'); assert.equal(f.calls(), 1);
  await f.worker.pollOnce(); assert.equal(f.calls(), 1); assert.equal(JSON.stringify(value).includes('secret'), false);
  await assert.rejects(f.create({ kind: 'resources' }, 'new-key'));
  const another = await createMcpConnection(f, f.scope, { expectedStreamVersion: 0, label: '相同远程对象', endpoint: f.connection.endpoint,
    expiresAt: f.connection.expiresAt, uriPrefixes: f.connection.uriPrefixes, maxRequests: 10 }, 'another-connection');
  await assert.rejects(createMcpRequest(f, f.scope, another.id, { expectedStreamVersion: 1, kind: 'resources' }, 'another-key'));
});
test('过期或次数用尽的连接不能重新启用扩大原授权', async t => {
  const f = await fixture(t), disabled = await f.disable(); f.advance(61000);
  assert.equal((await listMcpConnections(f, f.scope))[0]!.allowedActions.enable, false);
  await assert.rejects(commandMcpConnection(f, f.scope, f.connection.id, { expectedStreamVersion: disabled.streamVersion, command: 'enable' }, 'enable'));
  const full = await fixture(t);
  for (let index = 0; index < 10; index++) await full.create({ kind: 'resources' });
  const paused = await full.disable();
  assert.equal((await listMcpConnections(full, full.scope))[0]!.allowedActions.enable, false);
  await assert.rejects(commandMcpConnection(full, full.scope, full.connection.id, { expectedStreamVersion: paused.streamVersion, command: 'enable' }, 'enable'));
});
test('目录分页、模板参数和凭据轮换均绑定原目录版本', async t => {
  const f = await fixture(t), listed = await f.create({ kind: 'resources' }); await f.worker.pollOnce();
  const second = await f.create({ kind: 'resources', cursor: 'page2' }); await f.worker.pollOnce(); assert.equal((await f.get(second.id)).status, 'completed');
  const templates = await f.create({ kind: 'templates' }); await f.worker.pollOnce();
  await assert.rejects(f.create({ kind: 'read', selection: { catalogRequestId: templates.id, uriTemplate: 'store://facts/{id}', variables: { id: 'a', extra: 'b' } } }));
  const selected = await f.create({ kind: 'read', selection: { catalogRequestId: templates.id, uriTemplate: 'store://facts/{id}', variables: { id: 'a/b' } } });
  const stored = await f.store.transact('local', tx => tx.getProjection<any>('mcp.resourceRead', selected.id)); assert.equal(stored.params.uri, 'store://facts/a%2Fb');
  const rotated = await commandMcpConnection(f, f.scope, f.connection.id, { expectedStreamVersion: 1, command: 'rotate_credential', bearerToken: 'rotated-fixture' }, 'rotate');
  assert.equal(rotated.usedRequests, 4); assert.equal(rotated.expiresAt, f.connection.expiresAt); assert.equal(rotated.maxRequests, f.connection.maxRequests);
  const before = f.calls(); await f.worker.pollOnce(); assert.equal(f.calls(), before);
  await assert.rejects(createMcpRequest(f, f.scope, f.connection.id, { expectedStreamVersion: 2, kind: 'read', selection: { catalogRequestId: listed.id, uri: 'store://facts/a' } }, 'stale-catalog'));
});
test('在途撤权或后续内容不合规，不能留下部分可读附件', async t => {
  for (const revoke of [false, true]) {
    const f = await fixture(t), catalog = await f.create({ kind: 'resources' }); await f.worker.pollOnce();
    const read = await f.create({ kind: 'read', selection: { catalogRequestId: catalog.id, uri: 'store://facts/a' } });
    f.setHandler(async () => { if (revoke) await f.disable(); return { resultType: 'complete', contents: [{ uri: 'store://facts/a', text: '第一项' }, { uri: 'store://outside/b', text: '超范围项' }] }; });
    await f.worker.pollOnce();
    assert.equal(await f.store.transact('local', tx => tx.listProjections('asset').length), 0);
    assert.equal(await f.store.transact('local', tx => tx.listProjections('mcp.resourceSnapshot').length), 0);
    assert.equal(await f.store.transact('local', tx => tx.getProjection<any>('kernel.externalRead', read.id).status), 'needs_reconciliation');
  }
});
test('请求历史可恢复全部未知请求，旧授权版本仅展示无正文状态', async t => {
  const f = await fixture(t), request = await f.create({ kind: 'resources' });
  f.setHandler(async () => { throw new Error('unknown'); }); await f.worker.pollOnce();
  assert.deepEqual((await listMcpRequests(f, f.scope)).map(item => item.id), [request.id]);
  await commandMcpConnection(f, f.scope, f.connection.id, { expectedStreamVersion: 1, command: 'rotate_credential', bearerToken: 'next-fixture' }, 'rotate');
  const history = await listMcpRequests(f, f.scope); assert.equal(history.length, 1); assert.equal(history[0]!.status, 'needs_reconciliation');
  assert.equal(history[0]!.resources, undefined); assert.equal(history[0]!.assetRefs, undefined);
  await f.store.rebuildProjections('local'); assert.deepEqual(await listMcpRequests(f, f.scope), history);
  await commandMcpConnection(f, f.scope, f.connection.id, { expectedStreamVersion: 2, command: 'disable' }, 'disable-rotated');
  assert.deepEqual(await listMcpRequests(f, f.scope), history);
  await assert.rejects(f.get(request.id));
  await f.store.transact('local', tx => { const member = tx.getProjection<any>('membership', `${f.scope.workspaceId}:local-owner`); tx.putProjection('membership', member.id, { ...member, removedAt: f.now() }); });
  await assert.rejects(listMcpRequests(f, f.scope));
});
test('完整实际请求在外发前持久化；并发Worker只发送一次', async t => {
  const f = await fixture(t), request = await f.create({ kind: 'resources' });
  f.setHandler(async input => {
    const stored = await f.store.transact('local', tx => tx.getProjection<any>('mcp.resourceRead', request.id));
    assert.equal(input.requestBody, stored.requestBody); assert.equal(typeof stored.requestBody, 'string');
    assert.equal(sha256(stored.requestBody), stored.requestBodyDigest);
    assert.equal(JSON.parse(stored.requestBody).params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    return { resultType: 'complete', resources: [] };
  });
  await Promise.all([f.worker.pollOnce(), f.worker.pollOnce()]);
  assert.equal(f.calls(), 1); assert.equal((await f.get(request.id)).status, 'completed');
});
test('真实租约恢复拒绝已开始请求，陈旧fence不能提交结果', async t => {
  const f = await fixture(t), request = await f.create({ kind: 'resources' });
  const job = (await f.store.claimJob('abandoned', f.now(), { kinds: ['mcp.resource.read'] }))!;
  const boundary = { id: request.id, tenantId: 'local', jobId: job.id, workerId: 'abandoned', fencingToken: job.fencingToken, occurredAt: f.now(), authorityDigest: f.connection.digest };
  await f.store.transact('local', tx => beginExternalReadInTransaction(tx, boundary));
  f.advance(31000);
  const recovered = (await f.store.claimJob('recovered', f.now(), { kinds: ['mcp.resource.read'] }))!;
  assert.ok(recovered.fencingToken > job.fencingToken);
  await assert.rejects(f.store.transact('local', tx => finishExternalReadInTransaction(tx, { ...boundary, occurredAt: f.now(), outcome: 'completed', value: {} })));
  await createMcpWorkerPorts(f).execute(recovered, { workerId: 'recovered', fencingToken: recovered.fencingToken, leaseExpiresAt: recovered.leaseExpiresAt!, signal: new AbortController().signal, now: f.now } as any);
  assert.equal(f.calls(), 0); assert.equal((await f.get(request.id)).status, 'needs_reconciliation');
});
test('崩溃恢复时授权已撤回仍保留原外发未知事实', async t => {
  const f = await fixture(t), request = await f.create({ kind: 'resources' });
  const job = (await f.store.claimJob('abandoned', f.now(), { kinds: ['mcp.resource.read'] }))!;
  await f.store.transact('local', tx => beginExternalReadInTransaction(tx, { id: request.id, tenantId: 'local', jobId: job.id, workerId: 'abandoned', fencingToken: job.fencingToken, occurredAt: f.now(), authorityDigest: f.connection.digest }));
  await f.disable(); f.advance(31000);
  const recovered = (await f.store.claimJob('recovered', f.now(), { kinds: ['mcp.resource.read'] }))!;
  await createMcpWorkerPorts(f).execute(recovered, { workerId: 'recovered', fencingToken: recovered.fencingToken, leaseExpiresAt: recovered.leaseExpiresAt!, signal: new AbortController().signal });
  assert.equal(f.calls(), 0);
  assert.equal(await f.store.transact('local', tx => tx.getProjection<any>('kernel.externalRead', request.id).status), 'needs_reconciliation');
});
test('成员撤权与授权次数上限不能由新幂等键绕过', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) await f.create({ kind: 'resources' });
  await assert.rejects(f.create({ kind: 'resources' }), /MCP/u);
  await f.store.transact('local', tx => { const member = tx.getProjection<any>('membership', `${f.scope.workspaceId}:local-owner`); tx.putProjection('membership', member.id, { ...member, removedAt: new Date().toISOString(), streamVersion: member.streamVersion + 1 }); appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'workspaceMembership', aggregateId: member.id, expectedStreamVersion: member.streamVersion, type: 'fixture.revoked', actorId: 'local-owner', generation: 0, correlationId: 'revoke', publicPayload: {} }); });
  await f.worker.pollOnce(); assert.equal(f.calls(), 0);
});
