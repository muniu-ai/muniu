// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Execution, ExecutionContextV2, Deliverable } from '@mn/contracts';
import { InMemoryKernelStore, sha256 } from '@mn/kernel';
import { createCodingTask } from '@mn/plugin-coding';
import { createAgentOsHost } from '../src/index.js';

test('资料撤权后，研发列表、首页和成果列表均不返回衍生正文', async t => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store,
    secretStore: { async save() { throw new Error('unused'); }, async read() { throw new Error('unused'); } } });
  t.after(() => host.close());
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', 'workspace', {
    name: '来源保护', viewMode: 'business', pluginIds: ['coding'],
  });
  await store.transact('local', tx => {
    tx.putProjection('asset', 'source', { id: 'source', tenantId: 'local', workspaceId: workspace.id,
      streamVersion: 1, digest: 'source-digest', protected: true, protectedPayloadRef: 'source-key' });
    tx.putProjection('protectedPayloadKey', 'source-key', { id: 'source-key' });
    tx.putProjection('execution', 'execution', { id: 'execution', tenantId: 'local', workspaceId: workspace.id } as Execution);
    const body = { version: 1 as const, executionId: 'execution', tenantId: 'local', workspaceId: workspace.id,
      streamVersion: 1, sourceRefs: [{ namespace: 'asset', resourceId: 'source', streamVersion: 1, digest: 'source-digest' }],
      materials: [], inheritedExecutionIds: [] };
    tx.putProjection<ExecutionContextV2>('execution.context', 'execution', { ...body, digest: sha256(body) });
    const task = createCodingTask({ id: 'task', workspaceId: workspace.id, repositoryId: 'repository',
      title: '用户输入', request: '用户要求', createdAt: '2026-10-10T00:00:00.000Z' });
    tx.putProjection('coding.task', task.id, task);
    tx.putProjection('coding.execution', 'execution', { executionId: 'execution', taskId: task.id, updatedAt: task.updatedAt,
      result: { task, candidates: [{ id: 'candidate', summary: 'SOURCE_DERIVED_SUMMARY' }], gates: [],
        limits: { maxRepairAttempts: 3, maxDurationMs: 1000 }, nextStep: 'SOURCE_DERIVED_NEXT' } });
    tx.putProjection('coding.candidate', 'candidate', { id: 'candidate', taskId: task.id, workspaceId: workspace.id,
      executionId: 'execution', diff: 'SOURCE_DERIVED_DIFF' });
    tx.putProjection<Deliverable>('deliverable', 'delivery', { id: 'delivery', tenantId: 'local', workspaceId: workspace.id,
      pluginId: 'coding', threadId: 'thread', executionId: 'execution', kind: 'code', title: 'SOURCE_DERIVED_TITLE',
      summary: 'SOURCE_DERIVED_RESULT', nextAction: 'SOURCE_DERIVED_NEXT', assetIds: [], streamVersion: 1,
      createdAt: task.createdAt, updatedAt: task.updatedAt });
  });
  const paths = [`/v2/plugins/coding/tasks?workspaceId=${workspace.id}`, `/v2/workspaces/${workspace.id}/home`,
    `/v2/deliverables?workspaceId=${workspace.id}`, '/v2/deliverables'];
  const get = async (path: string) => {
    const response = await host.dispatch(new Request(`http://host.test${path}`));
    assert.equal(response.status, 200, path);
    return (await response.json()).data;
  };
  for (const path of paths) assert.match(JSON.stringify(await get(path)), /SOURCE_DERIVED/);
  await store.transact('local', tx => tx.deleteProjection('protectedPayloadKey', 'source-key'));
  for (const path of paths) {
    const body = JSON.stringify(await get(path));
    assert.doesNotMatch(body, /SOURCE_DERIVED/, path);
    assert.match(body, /来源/, path);
  }
});
