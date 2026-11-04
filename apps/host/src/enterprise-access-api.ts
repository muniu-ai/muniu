// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
import { canonicalJson } from '@mn/contracts';
import { EnterpriseError, opaqueHash, type EnterpriseActor, type EnterpriseQuotaService, type EnterprisePermissionService } from '@mn/enterprise-services';
export async function dispatchEnterpriseAccess(options: {
  operationId: string; params: Readonly<Record<string, string>>; input: unknown; actor: EnterpriseActor; key?: string; permissions: EnterprisePermissionService; quotas: EnterpriseQuotaService;
}): Promise<{ handled: true; value: unknown } | { handled: false }> {
  const { operationId, params, input, actor, key, permissions, quotas } = options;
  if (!['getQuotaConfiguration', 'configureWorkspaceQuota', 'getAccessConfiguration', 'createDepartment', 'grantBusinessRole', 'grantBusinessObject', 'revokeBusinessRole', 'revokeBusinessObject'].includes(operationId)) return { handled: false };
  const workspaceId = params.workspaceId!;
  let value: unknown;
  if (operationId === 'getQuotaConfiguration') value = await quotas.configuration(actor, workspaceId);
  else if (operationId === 'configureWorkspaceQuota') {
    const { expectedStreamVersion, ...limits } = input as EnterpriseContractTypes['EnterpriseQuotaConfigure'];
    value = await quotas.configure(actor, key!, workspaceId, expectedStreamVersion, limits);
  }
  else if (operationId === 'getAccessConfiguration') value = await permissions.configuration(actor, workspaceId);
  else if (operationId === 'createDepartment') value = await permissions.createDepartment(actor, key!, { ...input as EnterpriseContractTypes['EnterpriseDepartmentCreate'], workspaceId });
  else if (operationId === 'grantBusinessRole') value = await permissions.grantRole(actor, key!, { ...input as EnterpriseContractTypes['BusinessRoleGrantCreate'], workspaceId,
    id: opaqueHash(canonicalJson(['role', workspaceId, actor.principalId, key])) });
  else if (operationId === 'grantBusinessObject') value = await permissions.grantObject(actor, key!, { ...input as EnterpriseContractTypes['BusinessObjectGrantCreate'], workspaceId,
    id: opaqueHash(canonicalJson(['object-grant', workspaceId, actor.principalId, key])) });
  else {
    const configuration = await permissions.configuration(actor, workspaceId);
    const kind = operationId === 'revokeBusinessRole' ? 'role' : 'object';
    if (!(kind === 'role' ? configuration.roles : configuration.grants).some(grant => grant.id === params.grantId)) throw new EnterpriseError('ACCESS_GRANT_NOT_FOUND', 404);
    value = await permissions.revoke(actor, key!, kind, params.grantId!, (input as EnterpriseContractTypes['EnterpriseAccessRevoke']).expectedStreamVersion, workspaceId);
  }
  return { handled: true, value };
}
