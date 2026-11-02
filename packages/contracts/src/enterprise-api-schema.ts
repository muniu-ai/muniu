// SPDX-License-Identifier: Apache-2.0
import { ENTERPRISE_SCHEMAS } from './enterprise-schema.js';
import type { JsonObject } from './json.js';
export const ENTERPRISE_HTTP_OPERATIONS = [
  { id: 'enterpriseHealth', method: 'get', path: '/v2/health', response: 'EnterpriseHealthView', mutation: false },
  { id: 'enterpriseSession', method: 'get', path: '/v2/auth/session', response: 'EnterpriseSessionView', mutation: false },
  { id: 'listOrganizations', method: 'get', path: '/v2/organizations', response: 'OrganizationList', mutation: false },
  { id: 'listEnterpriseWorkspaces', method: 'get', path: '/v2/workspaces', response: 'EnterpriseWorkspaceList', mutation: false },
  { id: 'createEnterpriseWorkspace', method: 'post', path: '/v2/workspaces', body: 'EnterpriseWorkspaceCreate', response: 'EnterpriseWorkspaceView', mutation: true },
  { id: 'listOrganizationMembers', method: 'get', path: '/v2/organizations/{organizationId}/members', response: 'OrganizationMemberList', mutation: false },
  { id: 'inviteOrganizationMember', method: 'post', path: '/v2/organizations/{organizationId}/invitations', body: 'OrganizationInvitationCreate', response: 'OrganizationInvitationView', mutation: true },
  { id: 'acceptOrganizationInvitation', method: 'post', path: '/v2/organizations/{organizationId}/invitations/{memberId}/accept', body: 'OrganizationInvitationAccept', response: 'OrganizationMemberView', mutation: true },
  { id: 'commandOrganizationMember', method: 'post', path: '/v2/organizations/{organizationId}/members/{memberId}/commands', body: 'OrganizationMemberCommand', response: 'OrganizationMemberView', mutation: true },
] as const;
export function createEnterpriseOpenApiDocument(): JsonObject {
  const paths: Record<string, Record<string, JsonObject>> = {};
  const failure = (description: string): JsonObject => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/EnterpriseApiError' } } } });
  for (const op of ENTERPRISE_HTTP_OPERATIONS) {
    const parameters: JsonObject[] = [...op.path.matchAll(/\{([^}]+)\}/gu)].map(match => ({ in: 'path', name: match[1]!, required: true, schema: { type: 'string', minLength: 1 } }));
    if (op.mutation) for (const name of ['Idempotency-Key', 'X-CSRF-Token']) parameters.push({ in: 'header', name, required: true, schema: { type: 'string', minLength: 1 } });
    const status = op.id === 'createEnterpriseWorkspace' || op.id === 'inviteOrganizationMember' ? '201' : '200';
    paths[op.path] ??= {};
    paths[op.path]![op.method] = { operationId: op.id, parameters,
      ...('body' in op ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${op.body}` } } } } } : {}),
      responses: { [status]: { description: '成功', content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
        required: ['data', 'traceId'], properties: { data: { $ref: `#/components/schemas/${op.response}` }, traceId: { type: 'string' } } } } } },
        '400': failure('请求格式无效'), '401': failure('登录或会话无效'), '403': failure('当前权限或跨站防护拒绝'),
        '404': failure('当前作用域不存在该对象'), '409': failure('版本或幂等键冲突'), '413': failure('请求过大'), '415': failure('正文类型无效'), '503': failure('服务不可用') } };
  }
  paths['/v2/auth/login'] = { get: { operationId: 'enterpriseLogin', parameters: [
    { name: 'organizationId', in: 'query', required: true, schema: { type: 'string' } },
    { name: 'returnTo', in: 'query', required: false, schema: { type: 'string' } }], responses: { '302': { description: '跳转至已配置 OIDC 提供方' } } } };
  paths['/v2/auth/callback'] = { get: { operationId: 'enterpriseLoginCallback', description: 'state、nonce、PKCE 和单次浏览器绑定校验；不接受业务命令',
    responses: { '303': { description: '设置 HttpOnly 会话并返回工作台' }, '401': { description: '登录校验失败' } } } };
  paths['/v2/auth/logout'] = { post: { operationId: 'enterpriseLogout', parameters: [{ in: 'header', name: 'X-CSRF-Token', required: true, schema: { type: 'string' } }],
    responses: { '204': { description: '会话已撤销' }, '403': { description: '跨站防护拒绝' } } } };
  return { openapi: '3.1.0', info: { title: 'Muniu Enterprise API', version: '0.2.0' }, paths, components: { schemas: ENTERPRISE_SCHEMAS as JsonObject } };
}
