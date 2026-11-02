// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Approval, Execution, ToolCallIntent } from '@mn/contracts';
import { assertApprovalUsable, assertCurrentExecutionAuthorization, InMemoryKernelStore } from '../src/index.js';
const now = '2026-11-02T01:00:00.000Z';
const intent: ToolCallIntent = { id: 'call', executionId: 'execution', generation: 1, toolId: 'provider.followup', toolVersion: '1',
  effectClass: 'external_side_effect', intent: '创建内部跟进', normalizedArguments: { value: 'fixed' }, argumentsDigest: 'args',
  resourceRefs: [{ namespace: 'provider.object', resourceId: 'object', digest: 'digest' }], resourcesDigest: 'resources',
  authorityCommitment: 'authority', expiresAt: '2026-11-03T01:00:00.000Z' };
const approval: Approval = { id: 'approval', tenantId: 'tenant', workspaceId: 'workspace', executionId: intent.executionId,
  toolCallId: intent.id, effectClass: intent.effectClass, intent: intent.intent, resourceRefs: intent.resourceRefs,
  authorityCommitment: intent.authorityCommitment, expiresAt: intent.expiresAt, status: 'approved_once', decidedBy: 'reviewer',
  decidedAt: now, streamVersion: 2, createdAt: now, updatedAt: now };
test('批准必须对应同一调用、执行、授权、资源和期限，不能借用另一条批准', () => {
  assert.doesNotThrow(() => assertApprovalUsable(approval, intent, intent, now));
  for (const patch of [
    { toolCallId: 'other' }, { executionId: 'other' }, { authorityCommitment: 'other' },
    { expiresAt: '2026-11-04T01:00:00.000Z' }, { resourceRefs: [{ namespace: 'provider.object', resourceId: 'other' }] },
    { effectClass: 'local_read' as const },
  ]) assert.throws(() => assertApprovalUsable({ ...approval, ...patch }, intent, intent, now), { code: 'STALE_APPROVAL' });
});
test('全局停用人员后，残留工作区成员记录也不能授权执行', async () => {
  const store = new InMemoryKernelStore();
  const execution = { id: 'execution', tenantId: 'tenant', workspaceId: 'workspace', initiatedBy: 'owner' } as Execution;
  await store.transact('tenant', tx => {
    tx.putProjection('principal', 'owner', { id: 'owner', tenantId: 'tenant', kind: 'human', disabledAt: now });
    tx.putProjection('membership', 'workspace:owner', { tenantId: 'tenant', workspaceId: 'workspace', principalId: 'owner', workspaceRole: 'owner' });
  });
  await assert.rejects(store.transact('tenant', tx => assertCurrentExecutionAuthorization(tx, execution)), { code: 'EXECUTION_AUTHORIZATION_REVOKED' });
});
