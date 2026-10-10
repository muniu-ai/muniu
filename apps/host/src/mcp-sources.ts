// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2, McpConnectionV2, Principal, Workspace, WorkspaceMembership } from '@mn/contracts';
import { KernelError, sha256, type KernelTransaction } from '@mn/kernel';
export interface McpScope { readonly tenantId: string; readonly workspaceId: string; readonly principalId: string }
export interface McpSecretScope extends Pick<McpScope, 'tenantId' | 'workspaceId'> { readonly connectionId: string; readonly credentialId: string }
export interface McpSecretStore { save(scope: McpSecretScope, bearerToken: string): Promise<string>; read(scope: McpSecretScope, reference: string): Promise<string> }
export interface McpStoredConnection extends Omit<McpConnectionV2, 'allowedActions' | 'usedRequests' | 'credentialConfigured'> {
  readonly tenantId: string; readonly principalId: string; readonly membershipVersion: number; readonly createdAt: string;
  readonly credentialId?: string; readonly secretRef?: string;
}
export interface McpResourceSnapshot {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: 1; readonly digest: string;
  readonly connectionRef: GoalResourceRefV2; readonly protocolVersion: '2026-07-28'; readonly requestId: string;
  readonly contents: readonly { readonly uri: string; readonly mediaType: string; readonly contentDigest: string }[];
  readonly readAt: string;
}
export function mcpFail(code: string): never { throw new KernelError(code, 'MCP 授权、资源或读取状态无效', '刷新连接并核对授权范围、期限及读取结果'); }
export function assertMcpMember(tx: KernelTransaction, scope: McpScope, write = true): WorkspaceMembership {
  const member = tx.getProjection<WorkspaceMembership>('membership', `${scope.workspaceId}:${scope.principalId}`), principal = tx.getProjection<Principal>('principal', scope.principalId), workspace = tx.getProjection<Workspace>('workspace', scope.workspaceId);
  if (!member || member.tenantId !== scope.tenantId || member.workspaceId !== scope.workspaceId || member.principalId !== scope.principalId || member.removedAt
    || !(write ? ['owner', 'operator'] : ['owner', 'operator', 'reviewer', 'viewer']).includes(member.workspaceRole)
    || !principal || principal.tenantId !== scope.tenantId || principal.disabledAt || !workspace || workspace.tenantId !== scope.tenantId) mcpFail('MCP_ACCESS_DENIED');
  return member;
}
export function mcpConnectionDigest(value: Omit<McpStoredConnection, 'digest'> | McpStoredConnection): string {
  const { digest: _digest, ...body } = value as McpStoredConnection; return sha256(body);
}
export function mcpConnectionRef(connection: McpStoredConnection): GoalResourceRefV2 { return { namespace: 'mcp.connection', resourceId: connection.id, streamVersion: connection.streamVersion, digest: connection.digest }; }
export function assertMcpConnectionCurrent(tx: KernelTransaction, connection: McpStoredConnection, now: string): void {
  if (connection.status !== 'enabled' || !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.parse(now)
    || mcpConnectionDigest(connection) !== connection.digest || assertMcpMember(tx, connection).streamVersion !== connection.membershipVersion) mcpFail('MCP_CONNECTION_STALE');
}
/** Pure leaf validator: safe for memory/skill provenance without importing Host composition. */
export function validateMcpContextSource(tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, ref: GoalResourceRefV2): boolean {
  if (!ref.namespace.startsWith('mcp.')) return false;
  if (!['mcp.connection', 'mcp.resourceSnapshot'].includes(ref.namespace)) mcpFail('MCP_SOURCE_INVALID');
  const value = tx.getProjection<McpStoredConnection | McpResourceSnapshot>(ref.namespace, ref.resourceId);
  if (!value || value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId || value.streamVersion !== ref.streamVersion || !ref.digest || ref.digest !== value.digest) mcpFail('MCP_SOURCE_CHANGED');
  if (ref.namespace === 'mcp.connection') assertMcpConnectionCurrent(tx, value as McpStoredConnection, new Date().toISOString());
  else {
    const snapshot = value as McpResourceSnapshot, { digest, ...body } = snapshot;
    if (sha256(body) !== digest || snapshot.protocolVersion !== '2026-07-28' || snapshot.connectionRef.namespace !== 'mcp.connection') mcpFail('MCP_SOURCE_INVALID');
    validateMcpContextSource(tx, scope, snapshot.connectionRef);
  }
  return true;
}
