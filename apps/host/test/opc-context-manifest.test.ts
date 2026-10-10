// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContextV2, OpportunityAggregate, Thread } from '@mn/contracts';
import { appendKernelEvent } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { assertExecutionContextSources } from '@mn/worker';
import { createAgentOsHost } from '../src/host.js';
import { captureOpportunity } from '../src/product-state.js';
import { createOpcModelContextReader } from '../src/opc-model-context.js';
import { validateHostContextSource } from '../src/context-source-validation.js';

test('机会原文实际读取写入执行来源，删除附件后禁止发送与读取旧上下文', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mn-opc-source-manifest-'));
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: Buffer.alloc(32, 84) });
  const cas = new FileCas({ rootDir: join(root, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 85));
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore: { async save() { return 'keychain://fixture'; }, async read() { return 'fixture'; } } });
  t.after(async () => { await host.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: '机会来源', viewMode: 'business', pluginIds: ['opc'] });
  const response = await host.dispatch(new Request('http://fixture/v2/assets', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ workspaceId: workspace.id, expectedStreamVersion: 0,
    attachments: [{ fileName: '访谈.txt', mediaType: 'text/plain', protected: true, contentBase64: Buffer.from('用户确认的访谈原文。').toString('base64') }] }) }));
  assert.equal(response.status, 201); const asset = (await response.json() as any).data[0];
  const now = () => new Date().toISOString();
  const opportunity = await captureOpportunity({ store, tenantId: 'local', workspaceId: workspace.id, actorId: 'local-owner', now, id: () => randomUUID(), idempotencyKey: randomUUID(), expectedStreamVersion: 0, input: '访谈资料研究' });
  await store.transact('local', tx => {
    const value = tx.getProjection<OpportunityAggregate>('opc.opportunity', opportunity.id)!;
    tx.putProjection('opc.opportunity', value.id, { ...value, streamVersion: value.streamVersion + 1, interviews: [{ id: 'interview', opportunityId: value.id, participantRef: 'participant', occurredAt: now(), rawRecordAssetId: asset.id, recordedAt: now(), recordedBy: 'local-owner', annotations: [] }] });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'opc.opportunity', aggregateId: value.id, expectedStreamVersion: value.streamVersion, type: 'fixture.interview', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const thread = (await store.transact('local', tx => tx.listProjections<Thread>('thread').find(v => v.resourceRef?.resourceId === opportunity.id)))!;
  const execution = await host.kernel.submitTurn('local', 'local-owner', randomUUID(), { workspaceId: workspace.id, threadId: thread.id, expectedStreamVersion: thread.streamVersion, message: '整理访谈', agentDefinitionId: 'opc.opportunity-validator', modelBindingId: 'fixture', executionPrincipalId: 'agent:opc',
    authority: { workspaceId: workspace.id, principalId: 'agent:opc', toolIds: [], dataScopes: [thread.resourceRef!], autoAllowedEffects: [], budget: { maxTokens: 1000, maxCostMinorUnits: '100', currency: 'CNY', maxDurationMs: 60000, maxSubagentDepth: 0, maxSubagents: 0 } } });
  const reader = createOpcModelContextReader({ store, cas, protectedPayloadKeyProvider: keyProvider });
  assert.match((await reader(thread, execution))!, /用户确认的访谈原文/u);
  const manifest = await store.transact('local', tx => tx.getProjection<ExecutionContextV2>('execution.context', execution.id));
  assert.ok(manifest?.sourceRefs.some(ref => ref.namespace === 'asset' && ref.resourceId === asset.id));
  assert.ok(manifest?.sourceRefs.some(ref => ref.namespace === 'opc.opportunity' && ref.resourceId === opportunity.id));
  const revoked = await host.dispatch(new Request(`http://fixture/v2/assets/${asset.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedStreamVersion: asset.streamVersion, reason: '撤回资料' }) }));
  assert.equal(revoked.status, 200);
  await assert.rejects(reader(thread, execution));
  await assert.rejects(store.transact('local', tx => assertExecutionContextSources(tx, execution, validateHostContextSource)), { code: 'CONTEXT_SOURCE_REVOKED' });
});
