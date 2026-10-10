// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentScope } from '@mn/agent-runtime';
import type { CoordinationRunV2 } from '@mn/contracts';
import { AgentOsKernel, coordinationThreadId } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage, storeProtectedJson } from '@mn/storage';
import { AgentOsWorker, createKernelAgentTurnHandler, createProtectedRuntimeStore, saveExecutionContext } from '../src/index.js';

for (const change of ['cancel', 'supersede', 'source-revoke', 'source-revoke-inflight'] as const) test(`团队 ${change} 时阻断后续资料传播并保留计量`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muniu-team-context-'));
  const now = '2026-10-10T00:00:00.000Z';
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite3'), hmacKey: Buffer.alloc(32, 7), now: () => new Date(now) });
  const owner = AgentScope.tenant('team-context-fixture');
  await owner.ready;
  t.after(async () => { await owner.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal('init');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '团队', viewMode: 'business', pluginIds: ['opc'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: workspace.id, pluginId: 'opc', subject: '研究' });
  const policy = { toolIds: [], dataScopes: [{ namespace: 'asset', resourceId: 'asset' }], autoAllowedEffects: [] };
  const protection = { cas: new FileCas({ rootDir: join(root, 'cas') }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 3)) };
  const preparedMessage = await storeProtectedJson({ ...protection, tenantId: 'local', workspaceId: workspace.id, ownerType: 'thread',
    ownerId: coordinationThreadId('run', 'node', 1), protectedPayloadRef: 'team-input', value: { message: '受保护资料中的交付要求' }, createdAt: now });
  const runInput = {
    id: 'run', workspaceId: workspace.id, threadId: thread.id, aggregateType: 'test', aggregateId: 'test', revisionId: 'revision', revisionDigest: 'digest', grant: policy,
    budgets: [{ currency: 'CNY', maxTokens: 10000, maxCostMinorUnits: '100' }], limits: { maxParallel: 3, maxNodes: 12, maxAttempts: 24, maxDepth: 1 },
    deadlineAt: '2026-10-10T01:00:00.000Z', nodes: [{ id: 'node', dependsOn: [], pluginId: 'opc', agentDefinitionId: 'opc.business-assistant', modelBindingId: 'model', role: policy,
      budget: { currency: 'CNY', maxTokens: 10000, maxCostMinorUnits: '100' } }],
  };
  await store.transact('local', tx => {
    tx.putProjection('modelConnection', 'model', { id: 'model', tenantId: 'local', presetId: 'deepseek', secretRef: 'keychain://muniu.v2/model', defaultModel: 'deepseek-chat', status: 'ready' });
    tx.putProjection('asset', 'asset', { id: 'asset', tenantId: 'local', workspaceId: workspace.id, streamVersion: 1, digest: 'asset-digest', protected: true, protectedPayloadRef: 'asset-key' });
    tx.putProjection('protectedPayloadKey', 'asset-key', { id: 'asset-key' });
    kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run', runInput);
  });
  const admitted = await store.transact('local', tx => {
    const result = kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'admit', {
      runId: 'run', expectedStreamVersion: 1, nodeId: 'node', attempt: 1, message: '研究资料', preparedMessage,
    });
    saveExecutionContext(tx, result.execution, { sourceRefs: [{ namespace: 'asset', resourceId: 'asset', streamVersion: 1, digest: 'asset-digest' }], materials: [], inheritedExecutionIds: [] });
    return result;
  });
  let quotes = 0, calls = 0, credentialReads = 0;
  const handler = createKernelAgentTurnHandler({ store, scopeContext: owner.context, now: () => now,
    runtimeProtection: protection,
    secretStore: { read: async () => {
      credentialReads++;
      await store.transact('local', tx => {
        if (change === 'supersede') kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'next', { ...runInput, id: 'next', revisionId: 'next' });
        else if (change === 'source-revoke') tx.deleteProjection('protectedPayloadKey', 'asset-key');
        else if (change === 'cancel') {
          const run = tx.getProjection<CoordinationRunV2>('coordination.run', 'run')!;
          kernel.commandCoordinationRunInTransaction(tx, 'local', 'local-owner', 'cancel', { runId: run.id, expectedStreamVersion: run.streamVersion, status: 'cancelled' });
        }
      });
      return 'fixture';
    } },
    modelQuoter: async () => { quotes++; return { inputTokenLimit: 100, maxOutputTokens: 100,
      rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '0', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '0' } }; },
    modelInvoker: async input => {
      calls++;
      assert.ok(input.request.messages.some(message => message.content.includes('受保护资料中的交付要求')));
      if (change === 'source-revoke-inflight') await store.transact('local', tx => tx.deleteProjection('protectedPayloadKey', 'asset-key'));
      return { text: '来源派生答复不得继续传播', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
    },
  });
  const worker = new AgentOsWorker({ id: 'worker', store, now: () => new Date(now),
    lock: { engineLockDigest: 'test', expectedEngineLockDigest: 'test', pluginLockDigest: 'test', expectedPluginLockDigest: 'test' },
    handlers: { 'agent.execution.run': handler } });
  await worker.pollOnce();
  assert.equal(credentialReads, 1);
  assert.equal(quotes, change === 'source-revoke-inflight' ? 1 : 0);
  assert.equal(calls, change === 'source-revoke-inflight' ? 1 : 0);
  if (change.startsWith('source-revoke')) {
    const reader = createProtectedRuntimeStore({ ...protection, tenantId: 'local', workspaceId: workspace.id, store });
    await assert.rejects(reader.readExecution(admitted.execution.id), /撤权/u);
    assert.ok(reader.readSettlementRecords);
    const accounting = await reader.readSettlementRecords(admitted.execution.id);
    assert.equal(accounting.filter(record => record.type === 'model/settled').length, change === 'source-revoke-inflight' ? 1 : 0);
    assert.equal(JSON.stringify(accounting).includes('来源派生答复'), false);
  }
});
