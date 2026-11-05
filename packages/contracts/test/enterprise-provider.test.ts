// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnterpriseContract } from '../src/enterprise-contracts.js';
const target = { tenantId: 'tenant', workspaceId: 'workspace', objectType: 'customer', objectId: 'customer', streamVersion: 1, digest: 'a'.repeat(64) };
const common = { tenantId: 'tenant', workspaceId: 'workspace', operationKey: 'operation', providerBindingVersion: 1, target, expiresAt: '2026-12-01T00:00:00.000Z' };
test('提供方准备请求先固定业务输入，不伪造尚未产生的执行批准和预算承诺', () => {
  const input = { ...common, action: 'create_followup_task', input: { title: '跟进需求', dueAt: '2026-11-06T01:00:00.000Z' } };
  assert.deepEqual(parseEnterpriseContract('EnterpriseProviderActionPreparation', input), input);
  for (const extra of [{ executionApprovalRef: 'pretend-approved' }, { authorityRevisionId: 'fake' }, { reservationId: 'fake' }, { status: 'committed' }]) assert.throws(() => parseEnterpriseContract('EnterpriseProviderActionPreparation', { ...input, ...extra }));
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderActionPreparation', { ...input, input: { ...input.input, amountMinor: 100 } }));
});
test('三种动作各有严格输入，报价准备须绑定业务批准，不能提交任意操作或文件路径', () => {
  const followup = { ...common, action: 'update_followup_date', input: { nextFollowupAt: '2026-11-06T01:00:00.000Z' } };
  assert.deepEqual(parseEnterpriseContract('EnterpriseProviderActionPreparation', followup), followup);
  const quote = { ...common, action: 'issue_quote_package', target: { ...target, objectType: 'quote_version' }, input: { format: 'pdf' }, businessApprovalRef: 'approval' };
  assert.deepEqual(parseEnterpriseContract('EnterpriseProviderActionPreparation', quote), quote);
  const { businessApprovalRef: _approval, ...missing } = quote;
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderActionPreparation', missing));
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderActionPreparation', { ...quote, input: { format: 'pdf', path: '/arbitrary' } }));
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderActionPreparation', { ...followup, input: { nextFollowupAt: 'tomorrow' } }));
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderActionPreparation', { ...common, action: 'transfer_funds', input: {} }));
});
test('提供方快照与增量只返回明确版本和受保护引用，不将明文、密钥或总量混入协议', () => {
  const snapshot = { objectRef: target, protectedContentRef: 'protected:snapshot', observedAt: '2026-11-05T00:00:00.000Z' };
  assert.deepEqual(parseEnterpriseContract('EnterpriseProviderSnapshot', snapshot), snapshot);
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderSnapshot', { ...snapshot, apiKey: 'forbidden' }));
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderSnapshot', { ...snapshot, values: { cost: 1 } }));
  const changes = { changes: [{ sourceEventId: 'event', sourceEventType: 'customer.created', sourceOccurredAt: '2026-11-05T00:00:00.000Z', snapshot }], nextCursor: 'cursor' };
  assert.deepEqual(parseEnterpriseContract('EnterpriseProviderChanges', changes), changes);
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderChanges', { ...changes, hiddenTotal: 50 }));
});
test('空游标与停用流程的 null 分支按 schema 接受，不混同字符串或缺失字段', () => {
  assert.deepEqual(parseEnterpriseContract('EnterpriseProviderChangesQuery', { cursor: null }), { cursor: null });
  assert.deepEqual(parseEnterpriseContract('EnterpriseWorkflowSelect', { expectedStreamVersion: 1, reference: null }), { expectedStreamVersion: 1, reference: null });
  assert.throws(() => parseEnterpriseContract('EnterpriseProviderChangesQuery', {}));
  assert.throws(() => parseEnterpriseContract('EnterpriseWorkflowSelect', { expectedStreamVersion: 1, reference: 'null' }));
});
