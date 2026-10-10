// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendKernelEvent } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, createKernelAgentTurnHandler, createMcpReadWorkerHandler } from '@mn/worker';
import { createAgentOsHost } from '../src/host.js';
import { createMcpWorkerPorts } from '../src/mcp-resources.js';
import { createMcpTransport } from '../src/mcp-transport.js';
import { validateHostContextSource } from '../src/context-source-validation.js';
import { assertGoalExecutionResources } from '../src/goal-runtime.js';
import { captureOpportunity } from '../src/product-state.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mn-mcp-host-'));
  const store = new SqliteStorage({ databaseFile: join(directory, 'db.sqlite'), hmacKey: Buffer.alloc(32, 33) });
  const cas = new FileCas({ rootDir: join(directory, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 34));
  const secrets = { async save() { return 'keychain://muniu.v2/mcp-model-fixture'; }, async read() { return 'fixture'; } };
  const captured: { method: string; params: any }[] = [];
  const transport = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async input => {
    assert.equal(input.address, '8.8.8.8'); const message = JSON.parse(input.body); captured.push(message);
    assert.equal(message.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    const result = message.method === 'resources/list' ? { resultType: 'complete', resources: [{ uri: 'opaque://granted/a', name: '经营证据' }] }
      : { resultType: 'complete', contents: [{ uri: 'opaque://granted/a', mimeType: 'text/markdown', text: 'MCP私密合成事实：两周交付。', annotations: { audience: ['assistant'] } }] };
    const bytes = Buffer.from(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
    return { status: 200, contentType: 'text/event-stream', remoteAddress: input.address, body: (async function* () { yield bytes.subarray(0, 7); yield bytes.subarray(7); })(), discard() {} };
  } });
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, mcpTransport: transport, secretStore: secrets, goalPollIntervalMs: 60000 });
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: 'MCP模型来源', viewMode: 'business', pluginIds: ['opc'] });
  const path = `/v2/workspaces/${workspace.id}/mcp`;
  const send = async (route: string, body?: unknown, key: string = randomUUID()) => {
    const response = await host.dispatch(new Request(`http://fixture${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as any };
  };
  const created = await send(`${path}/connections`, { expectedStreamVersion: 0, label: '只读证据', endpoint: 'https://mcp.example.com/read', expiresAt: new Date(Date.now() + 600000).toISOString(), uriPrefixes: ['opaque://granted/'], maxRequests: 10 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connection = created.body.data;
  const worker = new AgentOsWorker({ id: 'mcp-http-worker', store, lock: { engineLockDigest: 'x', expectedEngineLockDigest: 'x', pluginLockDigest: 'x', expectedPluginLockDigest: 'x' }, handlers: {
    'mcp.resource.read': createMcpReadWorkerHandler(createMcpWorkerPorts({ store, cas, keyProvider, transport, protectedJournal: true, now: () => new Date().toISOString(), id: () => randomUUID() }))
  } });
  const list = await send(`${path}/connections/${connection.id}/requests`, { expectedStreamVersion: 1, kind: 'resources' }, 'catalog');
  assert.equal(list.status, 202, JSON.stringify(list.body)); assert.equal(captured.length, 0);
  assert.deepEqual((await send(`${path}/connections/${connection.id}/requests`, { expectedStreamVersion: 1, kind: 'resources' }, 'catalog')).body.data, list.body.data);
  await worker.pollOnce(); const catalog = await send(`${path}/requests/${list.body.data.id}`); assert.equal(catalog.body.data.status, 'completed');
  const read = await send(`${path}/connections/${connection.id}/requests`, { expectedStreamVersion: 1, kind: 'read', selection: { catalogRequestId: catalog.body.data.id, uri: catalog.body.data.resources[0].uri } });
  assert.equal(read.status, 202, JSON.stringify(read.body)); await worker.pollOnce();
  const result = await send(`${path}/requests/${read.body.data.id}`); assert.equal(result.body.data.status, 'completed', JSON.stringify(result.body));
  const history = await send(`${path}/requests`); assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.deepEqual(new Set(history.body.data.map((value: any) => value.id)), new Set([list.body.data.id, read.body.data.id]));
  assert.ok(history.body.data.every((value: any) => value.resources === undefined && value.templates === undefined && value.assetRefs === undefined));
  const assetRef = result.body.data.assetRefs[0];
  const disable = () => send(`${path}/connections/${connection.id}/commands`, { expectedStreamVersion: 1, command: 'disable' });
  return { store, cas, keyProvider, host, workspace, send, disable, secrets, assetRef, captured };
}

for (const revokeBeforeInvoke of [false, true]) test(`公开 HTTP、SSE、受保护附件及真实模型来源闭环${revokeBeforeInvoke ? '：调用前撤权' : '：历史拒读'}`, async t => {
  const f = await fixture(t);
  const content = await f.host.dispatch(new Request(`http://fixture/v2/assets/${f.assetRef.resourceId}/content`));
  assert.equal(content.status, 200); assert.match(await content.text(), /MCP私密合成事实/u);
  const thread = await f.host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: f.workspace.id, subject: '整理证据', pluginId: 'opc' });
  const model = await f.host.kernel.saveModelConnection('local', 'local-owner', randomUUID(), { presetId: 'deepseek', displayName: '模型', secretRef: 'keychain://muniu.v2/mcp-model-fixture', defaultModel: 'deepseek-v4-flash', discoveredModels: ['deepseek-v4-flash'] });
  await f.store.transact('local', tx => { tx.putProjection('modelConnection', model.id, { ...model, status: 'ready', streamVersion: 2 }); appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: model.id, expectedStreamVersion: 1, type: 'fixture.ready', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  const goal = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { threadId: thread.id, objective: '核对交付期限', resourceRefs: [f.assetRef], budget: { maxTokens: 20000, maxCostMinorUnits: '100', currency: 'CNY', maxDurationMs: 60000 }, deliverables: [{ key: 'report', title: '期限', required: true, criteria: [{ id: 'source', description: '给出来源' }] }] });
  assert.equal(goal.status, 201, JSON.stringify(goal.body)); const path = `/v2/goals/${goal.body.data.goal.id}`;
  const plan = await f.send(`${path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: 1, modelBindingId: model.id }); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const started = await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: plan.body.data.goal.streamVersion, command: 'start', planRevisionId: plan.body.data.plan.id, planDigest: plan.body.data.plan.digest }); assert.equal(started.status, 200, JSON.stringify(started.body));
  let quotes = 0, calls = 0;
  const runner = new AgentOsWorker({ id: 'mcp-model-worker', store: f.store, lock: { engineLockDigest: 'x', expectedEngineLockDigest: 'x', pluginLockDigest: 'x', expectedPluginLockDigest: 'x' }, handlers: { 'agent.execution.run': createKernelAgentTurnHandler({
    store: f.store, secretStore: f.secrets, approvalKernel: f.host.kernel, scopeContext: f.host.context,
    runtimeProtection: { cas: f.cas, keyProvider: f.keyProvider, validateContextSource: validateHostContextSource }, assertExecutionResources: assertGoalExecutionResources,
    modelQuoter: async () => { quotes++; if (revokeBeforeInvoke) assert.equal((await f.disable()).status, 200); return { inputTokenLimit: 10000, maxOutputTokens: 100, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '0', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '0' } }; },
    modelInvoker: async input => { calls++; assert.match(JSON.stringify(input.request.messages), /MCP私密合成事实/u); return { text: '期限为两周，来源为所选资料。', toolCalls: [], usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 20 } }; }
  }) } });
  await runner.pollOnce(); assert.equal(quotes, 1); assert.equal(calls, revokeBeforeInvoke ? 0 : 1);
  if (!revokeBeforeInvoke) assert.equal((await f.disable()).status, 200);
  for (const route of [`/v2/assets/${f.assetRef.resourceId}`, `/v2/assets/${f.assetRef.resourceId}/content`, `/v2/assets/${f.assetRef.resourceId}/extraction`, `/v2/workspaces/${f.workspace.id}/threads/${thread.id}/turns`]) {
    const response = await f.host.dispatch(new Request(`http://fixture${route}`)); assert.ok(response.status >= 400, `${route}: ${response.status}`); assert.doesNotMatch(await response.text(), /MCP私密合成事实/u);
  }
});

for (const revocation of ['connection', 'key'] as const) test(`OPC 多附件读取在末项读取期间撤回前项仍拒绝返回：${revocation}`, async t => {
  const f = await fixture(t);
  const uploaded = await f.send('/v2/assets', { workspaceId: f.workspace.id, expectedStreamVersion: 0, attachments: [{ fileName: 'second.txt', mediaType: 'text/plain', protected: true, contentBase64: Buffer.from('第二项仍有读取授权。').toString('base64') }] });
  assert.equal(uploaded.status, 201); const second = uploaded.body.data[0];
  const opportunity = await captureOpportunity({ store: f.store, tenantId: 'local', workspaceId: f.workspace.id, actorId: 'local-owner', now: () => new Date().toISOString(), id: () => randomUUID(), idempotencyKey: randomUUID(), expectedStreamVersion: 0, input: '合成多来源访谈' });
  await f.store.transact('local', tx => {
    const value = tx.getProjection<any>('opc.opportunity', opportunity.id);
    tx.putProjection('opc.opportunity', value.id, { ...value, streamVersion: value.streamVersion + 1, interviews: [f.assetRef.resourceId, second.id].map((assetId, index) => ({ id: `interview-${index}`, opportunityId: value.id, participantRef: 'fixture', occurredAt: new Date().toISOString(), rawRecordAssetId: assetId, recordedAt: new Date().toISOString(), recordedBy: 'local-owner', annotations: [] })) });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'opc.opportunity', aggregateId: value.id, expectedStreamVersion: value.streamVersion, type: 'fixture.interviews', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const original = f.cas.get.bind(f.cas); let revoked = false;
  f.cas.get = async digest => {
    if (digest === second.digest && !revoked) {
      revoked = true;
      if (revocation === 'connection') assert.equal((await f.disable()).status, 200);
      else assert.equal((await f.host.dispatch(new Request(`http://fixture/v2/assets/${f.assetRef.resourceId}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedStreamVersion: f.assetRef.streamVersion, reason: '撤回前一份资料' }) }))).status, 200);
    }
    return original(digest);
  };
  const response = await f.host.dispatch(new Request(`http://fixture/v2/plugins/opc/opportunities/${opportunity.id}?workspaceId=${f.workspace.id}`));
  assert.equal(revoked, true); assert.ok(response.status >= 400, `撤权后 HTTP ${response.status}`);
  assert.doesNotMatch(await response.text(), /MCP私密合成事实/u);
});
