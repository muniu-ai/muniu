// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseContractTypes } from '@mn/contracts';
import { decideBuiltinProviderAction, decideBusinessCommand, reduceBusinessEvents, type BusinessCommandContext } from '../src/index.js';
import { businessFixture } from './fixtures/business.js';
const context = (allow = () => {}): BusinessCommandContext & { assertExecutionAllowed: () => void } => ({ tenantId: 'tenant', workspaceId: 'workspace', actorId: 'maker', actorKind: 'service', now: '2026-11-02T01:00:00.000Z', revisionSalt: 'c'.repeat(64), assertCurrent: () => {}, assertEvidence: () => {}, assertExecutionAllowed: allow });
test('跟进任务独立成流，同时固定客户下一步；并发旧版本不能再次改变业务', () => {
  const f = businessFixture(), customer = f.execute({ type: 'customer.create', id: 'customer', name: '合成客户' });
  const request: EnterpriseContractTypes['EnterpriseProviderActionPreparation'] = { tenantId: 'tenant', workspaceId: 'workspace', operationKey: 'followup', providerBindingVersion: 1, target: customer.reference, expiresAt: '2026-12-01T00:00:00.000Z', action: 'create_followup_task', input: { title: '核对需求', dueAt: '2026-11-03T01:00:00.000Z' } };
  const change = decideBuiltinProviderAction(f.state(), request, context());
  f.events.push(...change.events); const state = reduceBusinessEvents(f.events);
  const task = [...state.objects.values()].find(o => o.reference.objectType === 'followup_task')!;
  assert.equal(task.reference.streamVersion, 1); assert.equal(task.value.title, '核对需求'); assert.equal(task.value.ownerPrincipalId, 'maker');
  assert.equal(f.ref('customer', 'customer').streamVersion, 2); assert.equal(state.objects.get('customer:customer')!.value.nextFollowupAt, request.input.dueAt);
  assert.throws(() => decideBuiltinProviderAction(state, request, context()), { code: 'SOURCE_VERSION_CONFLICT' });
});
test('提供方写入必须核对可信执行许可，模型和普通业务命令不能伪造出包', () => {
  const f = businessFixture(); f.order(); const quote = f.state().objects.get('quote_version:quote')!;
  const request: EnterpriseContractTypes['EnterpriseProviderActionPreparation'] = { tenantId: 'tenant', workspaceId: 'workspace', operationKey: 'package', providerBindingVersion: 1, target: quote.reference, expiresAt: '2026-11-03T00:00:00.000Z', action: 'issue_quote_package', businessApprovalRef: String(quote.value.approvalId), input: { format: 'pdf' } };
  const document = { protectedContentRef: 'protected:package', digest: 'd'.repeat(64), mediaType: 'application/pdf' };
  assert.throws(() => decideBuiltinProviderAction(f.state(), request, context(() => { throw new Error('execution-denied'); }), document), /execution-denied/);
  assert.throws(() => decideBuiltinProviderAction(f.state(), request, context((() => Promise.resolve()) as never), document), { code: 'EXECUTION_VERIFIER_INVALID' });
  assert.throws(() => decideBuiltinProviderAction(f.state(), { ...request, businessApprovalRef: 'fake' }, context(), document), { code: 'BUSINESS_APPROVAL_REQUIRED' });
  assert.throws(() => decideBusinessCommand(f.state(), { type: 'quote.issue_package', id: 'quote' } as never, context()));
  const result = decideBuiltinProviderAction(f.state(), request, context(), document); f.events.push(...result.events);
  const updated = f.state().objects.get('quote_version:quote')!;
  assert.equal(updated.value.totalMinor, quote.value.totalMinor); assert.equal(updated.value.status, quote.value.status);
  assert.equal(updated.reference.streamVersion, quote.reference.streamVersion + 1);
  assert.equal((updated.value.packageRefs as any[]).length, 1);
});
