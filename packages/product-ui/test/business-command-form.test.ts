// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { commandDefinition, buildBusinessCommand, lineOptions } from '../src/business-command-model.js';

const reference = { tenantId: 'tenant', workspaceId: 'workspace', objectType: 'quote_version' as const, objectId: 'quote-current', streamVersion: 2, digest: 'a'.repeat(64) };
test('对象业务批准固定 Host 当前ID和版本，表单不能覆盖控制字段', () => {
  const definition = commandDefinition('quote.approve'); assert.ok(definition);
  const result = buildBusinessCommand(definition, { id: 'foreign', expectedStreamVersion: 100, type: 'order.activate' }, { tenantId: 'tenant', workspaceId: 'workspace', object: { reference, values: { status: 'prepared' } }, recordId: 'unused' });
  assert.deepEqual(result, { type: 'quote.approve', id: 'quote-current', expectedStreamVersion: 2 });
});
test('业务表单白名单不开放 Agent 计划、执行授权或任意操作', () => {
  for (const name of ['commitOperatingPlan', 'authorizeOperatingGoal', 'execute_arbitrary', 'provider.execute']) assert.equal(commandDefinition(name), undefined);
});
test('引用保留真实来源版本，跨工作区或未知字段不能送入正式写入', () => {
  const definition = commandDefinition('contact.create'); assert.ok(definition);
  const customer = { ...reference, objectType: 'customer' as const };
  const context = { tenantId: 'tenant', workspaceId: 'workspace', recordId: 'contact-new' };
  const result = buildBusinessCommand(definition, { customer, name: '联系人' }, context);
  assert.deepEqual(result, { type: 'contact.create', id: 'contact-new', customer, name: '联系人' });
  assert.throws(() => buildBusinessCommand(definition, { customer: { ...customer, workspaceId: 'other' }, name: '联系人' }, context));
  assert.throws(() => buildBusinessCommand(definition, { customer, name: '联系人', hiddenSalary: 100 }, context));
});
test('业务明细选择只显示可见说明，不用技术ID或隐藏价格充当名称', () => {
  const options = lineOptions({ reference, values: { lines: [{ id: 'private-line-id', description: '咨询服务', unitPriceMinor: 990000, privateCost: 'secret-cost' }] } });
  assert.equal(options[0]?.label, '咨询服务'); assert.equal(options[0]?.value, 'private-line-id');
  assert.doesNotMatch(options.map(item => item.label).join(' '), /private-line|990000|secret-cost/u);
});
