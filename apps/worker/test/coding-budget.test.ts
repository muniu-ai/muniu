// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore } from '@mn/kernel';
import { ExecutionBudgetExceededError } from '@mn/contracts';
import { reserveCodingRepairBudget, remainingCodingRepairs } from '../src/coding-budget.js';

test('修复预留与调用方事务原子提交，累计额度耗尽不再触发修复', async () => {
  const now = '2026-10-10T00:00:00.000Z', store = new InMemoryKernelStore(undefined, () => now), kernel = new AgentOsKernel(store, { now: () => now });
  await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'ws', { name: '代码', viewMode: 'professional', pluginIds: ['coding'] });
  const thread = await kernel.createThread('local', 'local-owner', 'thread', { workspaceId: workspace.id, subject: '修复', pluginId: 'coding' });
  const grant = { toolIds: [], dataScopes: [], autoAllowedEffects: ['local_read'] as const };
  const run = await store.transact('local', tx => kernel.createCoordinationRunInTransaction(tx, 'local', 'local-owner', 'run', {
    id: 'run', workspaceId: workspace.id, threadId: thread.id, aggregateType: 'goal', aggregateId: 'goal', revisionId: 'plan', revisionDigest: 'digest', grant,
    budgets: [{ currency: 'CNY', maxTokens: 100, maxCostMinorUnits: '100' }], nodes: [{ id: 'execute', dependsOn: [], pluginId: 'coding', agentDefinitionId: 'coding.builtin', modelBindingId: 'model', role: grant, budget: { currency: 'CNY', maxTokens: 100, maxCostMinorUnits: '100' } }],
    limits: { maxParallel: 1, maxNodes: 12, maxAttempts: 24, maxDepth: 1 }, deadlineAt: '2026-10-10T01:00:00.000Z',
  }));
  const { execution } = await store.transact('local', tx => kernel.admitCoordinatedTurnInTransaction(tx, 'local', 'local-owner', 'node', { runId: run.id, expectedStreamVersion: 1, nodeId: 'execute', attempt: 1, message: '修复缺陷' }));
  const records = (id: string) => [{ id, executionId: execution.id, sequence: 1, type: 'budget/reserved' as const, occurredAt: now, payload: { kind: 'coding_repair', id, limit: 3 } }];
  await assert.rejects(store.transact('local', tx => { reserveCodingRepairBudget(tx, execution, records('rollback'), now); throw new Error('rollback'); }), /rollback/);
  assert.equal(await store.transact('local', tx => remainingCodingRepairs(tx, execution, 3, 0)), 3);
  for (const id of ['one', 'two', 'three']) await store.transact('local', tx => reserveCodingRepairBudget(tx, execution, records(id), now));
  assert.equal(await store.transact('local', tx => remainingCodingRepairs(tx, execution, 3, 0)), 0);
  await assert.rejects(store.transact('local', tx => reserveCodingRepairBudget(tx, execution, records('four'), now)), ExecutionBudgetExceededError);
});
