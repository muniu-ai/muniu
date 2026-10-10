// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Execution, ExecutionContextV2, GoalResourceRefV2 } from '@mn/contracts';
import { InMemoryKernelStore, sha256 } from '@mn/kernel';
import { assertContextSource, assertExecutionContextSources, saveExecutionContext } from '../src/execution-context.js';

const prior = { id: 'prior', tenantId: 'local', workspaceId: 'workspace', generation: 1, initiatedBy: 'owner' } as Execution;
const current = { ...prior, id: 'current' };
const run = { executionId: prior.id, generation: 1, streamVersion: 4, result: { status: 'completed' } };
const ref: GoalResourceRefV2 = { namespace: 'coding.execution', resourceId: prior.id, streamVersion: 4, digest: sha256(run) };

test('Coding 旧成果按真实 Execution 校验范围，返工继承并重查原资料权限', async () => {
  const store = new InMemoryKernelStore();
  await store.transact('local', tx => {
    tx.putProjection('execution', prior.id, prior);
    tx.putProjection('coding.execution', prior.id, run);
    const asset = { tenantId: 'local', workspaceId: 'workspace', streamVersion: 1, digest: 'a'.repeat(64), protected: true, protectedPayloadRef: 'source-key' };
    tx.putProjection('asset', 'source', asset);
    tx.putProjection('protectedPayloadKey', 'source-key', { id: 'source-key' });
    saveExecutionContext(tx, prior, { sourceRefs: [{ namespace: 'asset', resourceId: 'source', streamVersion: 1, digest: asset.digest }], materials: [], inheritedExecutionIds: [] });
    saveExecutionContext(tx, current, { sourceRefs: [ref], materials: [], inheritedExecutionIds: [prior.id] });
    assert.equal(assertExecutionContextSources(tx, current)?.sourceRefs[0]?.resourceId, prior.id);
    tx.deleteProjection('protectedPayloadKey', 'source-key');
    assert.throws(() => assertExecutionContextSources(tx, current), (error: any) => error.code === 'CONTEXT_SOURCE_REVOKED');
  });
});

test('Coding 来源不能跨区、伪造执行或跳过循环来源检查', async () => {
  const store = new InMemoryKernelStore();
  await store.transact('local', tx => {
    tx.putProjection('execution', prior.id, prior);
    tx.putProjection('coding.execution', prior.id, run);
    assertContextSource(tx, current, ref);
    for (const changed of [{ ...prior, tenantId: 'other' }, { ...prior, workspaceId: 'other' }, { ...prior, generation: 2 }]) {
      tx.putProjection('execution', prior.id, changed);
      assert.throws(() => assertContextSource(tx, current, ref), (error: any) => error.code === 'CONTEXT_SOURCE_CHANGED');
    }
    tx.putProjection('execution', prior.id, prior);
    tx.putProjection('coding.execution', prior.id, { ...run, executionId: 'different' });
    assert.throws(() => assertContextSource(tx, current, ref), (error: any) => error.code === 'CONTEXT_SOURCE_CHANGED');
    tx.putProjection('coding.execution', prior.id, run);
    assert.throws(() => assertContextSource(tx, current, { ...ref, digest: '0'.repeat(64) }), (error: any) => error.code === 'CONTEXT_SOURCE_CHANGED');
    const body = { version: 1 as const, executionId: prior.id, tenantId: prior.tenantId, workspaceId: prior.workspaceId, streamVersion: 1, sourceRefs: [ref], materials: [], inheritedExecutionIds: [] };
    tx.putProjection('execution.context', prior.id, { ...body, digest: sha256(body) } satisfies ExecutionContextV2);
    assert.throws(() => assertContextSource(tx, current, ref), (error: any) => error.code === 'CONTEXT_INVALID');
  });
});
