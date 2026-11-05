// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnterpriseContract } from '../src/enterprise-contracts.js';
import { ENTERPRISE_HTTP_OPERATIONS } from '../src/enterprise-api-schema.js';
import { ENTERPRISE_SCHEMAS } from '../src/enterprise-schema.js';
import * as client from '../src/enterprise-client.js';

test('流程停用接受权威 schema 的 null，不能把字符串或缺失值视为停用', () => {
  assert.deepEqual(parseEnterpriseContract('EnterpriseWorkflowSelect', { expectedStreamVersion: 1, reference: null }), { expectedStreamVersion: 1, reference: null });
  assert.throws(() => parseEnterpriseContract('EnterpriseWorkflowSelect', { expectedStreamVersion: 1, reference: 'null' }));
  assert.throws(() => parseEnterpriseContract('EnterpriseWorkflowSelect', { expectedStreamVersion: 1 }));
});

test('浏览器能力契约区分当前对象字段与完整命令预检，不接受伪造业务结果或泛化创建资格', () => {
  const reference = { tenantId: 'tenant', workspaceId: 'workspace', objectType: 'customer', objectId: 'customer', streamVersion: 1, digest: 'a'.repeat(64) };
  const capabilities = { reference, readableFields: ['name'], writableFields: ['name'], businessApprovalFields: [], canRecordEvidence: true, people: [] };
  assert.deepEqual(parseEnterpriseContract('EnterpriseBusinessCapabilities', capabilities), capabilities);
  assert.throws(() => parseEnterpriseContract('EnterpriseBusinessCapabilities', { ...capabilities, canCreate: true }));
  assert.throws(() => parseEnterpriseContract('EnterpriseBusinessCapabilities', { ...capabilities, readableFields: ['name', 'name'] }));
  assert.throws(() => parseEnterpriseContract('EnterpriseBusinessCapabilities', { ...capabilities, people: [{ principalId: 'owner', displayName: '负责人', subject: 'private-subject' }] }));
  assert.throws(() => parseEnterpriseContract('EnterpriseBusinessCapabilities', { ...capabilities, people: Array.from({ length: 8 }, (_, index) => ({ principalId: 'person-' + index, displayName: '合成人员' })) }));
  assert.deepEqual(parseEnterpriseContract('EnterpriseBusinessCommandCheck', { allowedNow: true }), { allowedNow: true });
  assert.throws(() => parseEnterpriseContract('EnterpriseBusinessCommandCheck', { allowedNow: true, result: reference }));
  assert.deepEqual(parseEnterpriseContract('EnterpriseLoginDirectory', { organizations: [] }), { organizations: [] });
  assert.throws(() => parseEnterpriseContract('EnterpriseLoginDirectory', { organizations: [{ id: 'tenant', name: '企业', issuer: 'https://private.example.test' }] }));
});

test('浏览器安全客户端转导出同一权威操作表与解析器，预检保持读取语义并要求 CSRF', () => {
  assert.ok('ENTERPRISE_HTTP_OPERATIONS' in client && client.ENTERPRISE_HTTP_OPERATIONS === ENTERPRISE_HTTP_OPERATIONS);
  assert.ok('parseEnterpriseContract' in client && client.parseEnterpriseContract === parseEnterpriseContract);
  assert.ok('ENTERPRISE_SCHEMAS' in client && client.ENTERPRISE_SCHEMAS === ENTERPRISE_SCHEMAS);
  const operation = ENTERPRISE_HTTP_OPERATIONS.find(item => item.id === 'checkEnterpriseBusinessCommand');
  assert.equal(operation?.method, 'post'); assert.equal(operation?.mutation, false);
  assert.throws(() => client.enterpriseRequest('checkEnterpriseBusinessCommand', { path: { workspaceId: 'workspace' }, body: { type: 'customer.create', id: 'customer', name: '客户' }, headers: {} } as never));
});

test('客户创建部门查询只接受真实拟建客户字段，归属候选不宣称完整创建资格', () => {
  const input = { type: 'customer.create', id: 'new-customer', name: '实际填写的合成客户' };
  assert.deepEqual(parseEnterpriseContract('EnterpriseCustomerCreationQuery', input), input);
  assert.deepEqual(parseEnterpriseContract('EnterpriseBusinessCommand', input), input);
  for (const invalid of [{ ...input, type: 'opportunity.create' }, { ...input, name: ' ' }, { ...input, id: '..' },
    { ...input, departmentId: 'chosen' }, { ...input, actorId: 'admin' }, { type: 'customer.create', name: input.name }]) {
    assert.throws(() => parseEnterpriseContract('EnterpriseCustomerCreationQuery', invalid));
  }
  const output = { departments: [{ id: 'department', name: '业务部门' }], allowUnassigned: false };
  assert.deepEqual(parseEnterpriseContract('EnterpriseCustomerCreationDepartments', output), output);
  assert.throws(() => parseEnterpriseContract('EnterpriseCustomerCreationDepartments', { ...output, canCreate: true }));
  assert.throws(() => parseEnterpriseContract('EnterpriseCustomerCreationDepartments', { ...output, departments: [{ ...output.departments[0], principalIds: ['manager'] }] }));
  const operation = ENTERPRISE_HTTP_OPERATIONS.find(item => item.id === 'queryEnterpriseCustomerCreationDepartments');
  assert.equal(operation?.method, 'post'); assert.equal(operation?.mutation, false);
  assert.throws(() => client.enterpriseRequest('queryEnterpriseCustomerCreationDepartments', { path: { workspaceId: 'workspace' }, body: input, headers: {} } as never));
});
