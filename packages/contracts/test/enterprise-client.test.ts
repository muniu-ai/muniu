// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { enterpriseRequest, parseEnterpriseResponse } from '../src/enterprise-client.js';
import { createEnterpriseOpenApiDocument } from '../src/enterprise-api-schema.js';
test('企业生成客户端绑定路径、严格命令与写入头，不接受客户端租户注入', () => {
  const headers = { 'Idempotency-Key': 'create-workspace', 'X-CSRF-Token': 'csrf-fixture' };
  assert.deepEqual(enterpriseRequest('createEnterpriseWorkspace', { body: { name: '公司', mode: 'builtin' }, headers }),
    { path: '/v2/workspaces', method: 'POST', body: { name: '公司', mode: 'builtin' }, headers });
  assert.equal(enterpriseRequest('listOrganizationMembers', { path: { organizationId: 'a/b' } }).path, '/v2/organizations/a%2Fb/members');
  assert.throws(() => enterpriseRequest('createEnterpriseWorkspace', { body: { name: '公司', mode: 'builtin', tenantId: 'other' }, headers } as never));
  assert.throws(() => enterpriseRequest('createEnterpriseWorkspace', { body: { name: '公司', mode: 'builtin' }, headers: {} } as never));
});
test('会话响应拒绝密钥字段、继承的信封字段与错误角色类型', () => {
  const data = { tenantId: 'tenant', principalId: 'person', displayName: '成员', status: 'active' as const, organizationAdmin: false,
    csrfToken: 'csrf', expiresAt: '2026-11-02T12:00:00.000Z', profile: 'development' as const };
  assert.deepEqual(parseEnterpriseResponse('enterpriseSession', { data, traceId: 'trace' }), data);
  assert.throws(() => parseEnterpriseResponse('enterpriseSession', { data: { ...data, accessToken: 'must-not-return' }, traceId: 'trace' }));
  assert.throws(() => parseEnterpriseResponse('enterpriseSession', Object.assign(Object.create({ traceId: 'inherited' }), { data })));
  assert.throws(() => parseEnterpriseResponse('enterpriseSession', { data: { ...data, organizationAdmin: 'true' }, traceId: 'trace' }));
});
test('企业 OpenAPI 公布已实现入口，认证回调不要求业务幂等键', () => {
  const document = createEnterpriseOpenApiDocument() as any;
  assert.equal(document.paths['/v2/auth/callback'].get.parameters, undefined);
  assert.equal(document.paths['/v2/workspaces'].post.parameters.find((p: any) => p.name === 'Idempotency-Key').required, true);
  assert.equal(document.paths['/v2/workspaces/{workspaceId}/goals'].post.operationId, 'createOperatingGoal');
  assert.equal(document.paths['/v2/goals/{goalId}/authorizations'].post.parameters.find((p: any) => p.name === 'Idempotency-Key').required, true);
  assert.equal(document.paths['/v2/knowledge/search'], undefined);
});
