// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderBinding } from '@mn/contracts';
import { fixture } from './fixtures/business.js';
import { EnterpriseExecutionConfigurationService } from '../src/enterprise-execution-config.js';
import { EnterpriseBuiltinProvider } from '../src/enterprise-builtin-provider.js';
async function setup(t: test.TestContext) {
  const f = await fixture(t, true, true), base = await f.base();
  const binding: ProviderBinding = { tenantId: 'tenant', workspaceId: f.workspace.id, id: 'binding', streamVersion: 1, mode: 'builtin', bindings: ['customer','opportunity','quote_version'].map(objectType => ({ objectType: objectType as 'customer'|'opportunity'|'quote_version', provider: 'builtin', allowedActions: [], supportedPorts: ['readSnapshot','listChanges'] })) };
  const configuration = new EnterpriseExecutionConfigurationService({ repository: f.repository, now: f.now });
  await configuration.registerBinding(f.admin, f.workspace.id, 'bind', 0, binding);
  const provider = (person = 'sales', activeBinding = binding) => new EnterpriseBuiltinProvider({ store: f.store, repository: f.repository, binding: activeBinding, protection: { cas: f.cas, keyProvider: f.keyProvider }, now: f.now, actorFor: async () => f.actor(person) });
  const context = (person = 'sales') => ({ tenantId: 'tenant', workspaceId: f.workspace.id, principalId: person, signal: new AbortController().signal });
  return { ...f, base, binding, provider, context, configuration };
}
test('内置快照保留真实对象版本，内容按当前字段权限读取，身份字符串不能授予权限', async t => {
  const f = await setup(t), sales = f.provider(), viewer = f.provider('viewer');
  const result = await sales.readSnapshot(f.base.quote.reference, f.context()); assert.equal(result.status, 'supported');
  if (result.status !== 'supported') throw new Error('missing snapshot');
  const content = await sales.readContent(result.value.protectedContentRef, f.context());
  assert.deepEqual(content.reference, f.base.quote.reference); assert.equal(content.values.totalMinor, 30000);
  const masked = await viewer.readSnapshot(f.base.quote.reference, f.context('viewer')); if (masked.status !== 'supported') throw new Error('missing snapshot');
  assert.equal((await viewer.readContent(masked.value.protectedContentRef, f.context('viewer'))).values.totalMinor, undefined);
  await assert.rejects(sales.readSnapshot(f.base.quote.reference, f.context('admin')), { code: 'PROVIDER_CONTEXT_MISMATCH' });
  await assert.rejects(viewer.readContent(result.value.protectedContentRef, f.context('viewer')), { code: 'PROVIDER_CONTENT_NOT_FOUND' });
  await f.permissions.revoke(f.admin, 'revoke', 'role', 'sales-own', 1);
  await assert.rejects(sales.readContent(result.value.protectedContentRef, f.context()), { code: 'OBJECT_ACCESS_DENIED' });
});
test('增量游标按原事件定位，重复读取不产生业务变化，跨身份与权限变化不能复用游标', async t => {
  const f = await setup(t), provider = f.provider();
  const first = await provider.listChanges(null, f.context()); if (first.status !== 'supported') throw new Error('missing changes');
  assert.ok(first.value.changes.length > 0);
  const quiet = await provider.listChanges(first.value.nextCursor, f.context()); if (quiet.status !== 'supported') throw new Error('missing changes');
  assert.equal(quiet.value.changes.length, 0);
  const renamed = await f.command({ type: 'customer.rename', id: 'customer', expectedStreamVersion: 1, name: '更新后的客户' });
  const changed = await provider.listChanges(quiet.value.nextCursor, f.context()); if (changed.status !== 'supported') throw new Error('missing changes');
  assert.equal(changed.value.changes.length, 1); assert.deepEqual(changed.value.changes[0]!.snapshot.objectRef, renamed.reference);
  const replay = await provider.listChanges(quiet.value.nextCursor, f.context()); if (replay.status !== 'supported') throw new Error('missing changes');
  assert.deepEqual(replay.value.changes.map(c => c.sourceEventId), changed.value.changes.map(c => c.sourceEventId));
  await assert.rejects(f.provider('viewer').listChanges(first.value.nextCursor, f.context('viewer')), { code: 'PROVIDER_CURSOR_INVALID' });
  await f.permissions.revoke(f.admin, 'revoke-cursor', 'role', 'sales-own', 1);
  await assert.rejects(provider.listChanges(first.value.nextCursor, f.context()), { code: 'PROVIDER_CURSOR_AUTHORIZATION_CHANGED' });
});
test('快照内容入库后的异步撤权阻止返回受保护引用，未实现写入端口明确不可用', async t => {
  const f = await setup(t), provider = f.provider(), put = f.cas.put.bind(f.cas); let revoke = true;
  assert.deepEqual(await provider.prepareAction({ tenantId: 'tenant', workspaceId: f.workspace.id, operationKey: 'unsupported', providerBindingVersion: 1, target: f.base.customer.reference, expiresAt: '2026-12-01T00:00:00.000Z', action: 'create_followup_task', input: { title: '跟进', dueAt: '2026-11-06T00:00:00.000Z' } }, f.context()), { status: 'not_supported', capability: 'prepareAction' });
  await provider.readSnapshot(f.base.quote.reference, f.context());
  f.cas.put = async bytes => { const result = await put(bytes); if (revoke) { revoke = false; await f.permissions.revoke(f.admin, 'async-revoke', 'role', 'sales-own', 1); } return result; };
  await assert.rejects(provider.readSnapshot(f.base.customer.reference, f.context()), { code: 'OBJECT_ACCESS_DENIED' });
});

test('准备阶段固定输入且可重复核对，不提前产生跟进或正式报价事实', async t => {
  const f = await setup(t), binding: ProviderBinding = { ...f.binding, streamVersion: 2, bindings: f.binding.bindings.map(b => ({ ...b, allowedActions: b.objectType === 'quote_version' ? ['issue_quote_package'] : ['create_followup_task', 'update_followup_date'], supportedPorts: ['readSnapshot', 'listChanges', 'prepareAction', 'executeAction', 'getReceipt'] })) };
  await f.configuration.registerBinding(f.admin, f.workspace.id, 'enable-actions', 1, binding);
  const provider = f.provider('sales', binding), request = { tenantId: 'tenant', workspaceId: f.workspace.id, operationKey: 'prepare-only', providerBindingVersion: 2, target: f.base.customer.reference, expiresAt: '2026-11-03T00:00:00.000Z', action: 'create_followup_task' as const, input: { title: '核对需求', dueAt: '2026-11-03T01:00:00.000Z' } };
  const prepared = await provider.prepareAction(request, f.context()); assert.equal(prepared.status, 'supported');
  assert.deepEqual(await provider.prepareAction(request, f.context()), prepared);
  assert.equal((await f.get('customer', 'customer')).reference.streamVersion, 1);
  assert.equal((await f.service.list(f.actor('sales'), f.workspace.id, 'followup_task')).length, 0);
  await assert.rejects(provider.prepareAction({ ...request, input: { ...request.input, title: '更改原请求' } }, f.context()), { code: 'IDEMPOTENCY_KEY_REUSED' });
  await f.permissions.revoke(f.admin, 'revoke-preparation', 'role', 'sales-own', 1);
  await assert.rejects(provider.prepareAction(request, f.context()), { code: 'OBJECT_ACCESS_DENIED' });
});
