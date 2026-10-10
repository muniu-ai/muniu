// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentOsKernel, recordToolAdmission } from '@mn/kernel';
import type { CoordinationAttemptV2, Execution } from '@mn/contracts';
import { SqliteStorage } from '@mn/storage';
import { AgentOsWorker, AgentExecutionCancelledError, AgentExecutionInterruptedError, UnknownExternalSideEffectError } from '../src/index.js';

for (const scenario of ['completed', 'failed', 'interrupted', 'cancelled', 'needs_reconciliation', 'lease-sweep'] as const) test(`协调节点 ${scenario} 的物理任务、节点事实和唤醒同事务提交`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muniu-coordination-'));
  const now = '2026-10-10T00:00:00.000Z';
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite3'), hmacKey: Buffer.alloc(32, 7), now: () => new Date(now) });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal('init');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '团队', viewMode: 'business', pluginIds: ['opc'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: workspace.id, pluginId: 'opc', subject: '研究' });
  const policy = { toolIds: [], dataScopes: [], autoAllowedEffects: [] };
  await store.transact('local', tx => kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run', {
    id: 'run', workspaceId: workspace.id, threadId: thread.id, aggregateType: 'test', aggregateId: 'test', revisionId: 'revision', revisionDigest: 'digest', grant: policy,
    budgets: [{ currency: 'CNY', maxTokens: 100, maxCostMinorUnits: '100' }], limits: { maxParallel: 3, maxNodes: 12, maxAttempts: 24, maxDepth: 1 },
    deadlineAt: '2026-10-10T01:00:00.000Z', nodes: [{ id: 'node', dependsOn: [], pluginId: 'opc', agentDefinitionId: 'opc.business-assistant', modelBindingId: 'model', role: policy,
      budget: { currency: 'CNY', maxTokens: 50, maxCostMinorUnits: '50' } }],
  }));
  const admitted = await store.transact('local', tx => kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'admit', {
    runId: 'run', expectedStreamVersion: 1, nodeId: 'node', attempt: 1, message: '研究资料',
  }));
  const worker = new AgentOsWorker({ id: 'worker', store, now: () => new Date(now),
    lock: { engineLockDigest: 'test', expectedEngineLockDigest: 'test', pluginLockDigest: 'test', expectedPluginLockDigest: 'test' },
    handlers: { 'agent.execution.run': async () => {
      if (scenario === 'failed') throw new Error('protected-result-must-not-be-settlement');
      if (scenario === 'interrupted') throw new AgentExecutionInterruptedError(admitted.execution.id);
      if (scenario === 'needs_reconciliation') throw new UnknownExternalSideEffectError(admitted.execution.id);
      if (scenario === 'cancelled') {
        const execution = await store.transact('local', tx => tx.getProjection<Execution>('execution', admitted.execution.id)!);
        await kernel.commandExecution('local', 'local-owner', 'cancel', execution.id, execution.streamVersion, 'cancel');
        throw new AgentExecutionCancelledError(admitted.execution.id);
      }
      return { text: 'protected-result-must-not-be-settlement' };
    } } });
  if (scenario === 'lease-sweep') {
    const claimed = await store.claimJob('crashed-worker', now);
    assert.ok(claimed);
    const execution = await store.transact('local', tx => {
      const current = tx.getProjection<Execution>('execution', admitted.execution.id)!;
      recordToolAdmission(tx, current, 'unknown-effect', 'started', now); return current;
    });
    await kernel.commandExecution('local', 'local-owner', 'cancel-unknown', execution.id, execution.streamVersion, 'cancel');
    assert.equal(await store.claimJob('new-worker', '2026-10-10T00:01:00.000Z'), undefined);
    await store.transact('local', tx => (kernel as any).reconcileCoordinationAttemptInTransaction(tx, 'local', 'local-owner', {
      attemptId: admitted.attempt.id, expectedStreamVersion: 1, occurredAt: '2026-10-10T00:01:00.000Z',
    }));
    assert.equal((await worker.pollOnce()).status, 'idle');
  } else assert.equal((await worker.pollOnce()).status, scenario);
  const attempt = await store.transact('local', tx => tx.getProjection<CoordinationAttemptV2>('coordination.attempt', admitted.attempt.id)!);
  assert.equal(attempt.status, scenario === 'lease-sweep' ? 'needs_reconciliation' : scenario);
  assert.equal(attempt.reservation.status, 'reserved');
  assert.equal((await store.getJob(admitted.attempt.jobId))?.status, scenario === 'completed' ? 'completed' : 'failed');
  const events = await store.readEvents('local', 0, 200);
  assert.ok(events.events.some(event => event.type === 'coordination.wake_requested'));
  assert.equal(JSON.stringify(await store.getJob(admitted.attempt.jobId)).includes('protected-result-must-not-be-settlement'), false);
});
