// SPDX-License-Identifier: Apache-2.0
import type { Asset, AssetProvenanceV2, Principal, WorkspaceMembership } from '@mn/contracts';
import { KernelError, type KernelTransaction } from '@mn/kernel';
import { assertContextSource, type ContextSourceValidator } from '@mn/worker';
export interface AssetAccessScope { readonly tenantId: string; readonly workspaceId: string; readonly principalId: string }
export function assertAssetMembership(tx: KernelTransaction, scope: AssetAccessScope, write = false): void {
  const member = tx.getProjection<WorkspaceMembership>('membership', `${scope.workspaceId}:${scope.principalId}`);
  const principal = tx.getProjection<Principal>('principal', scope.principalId);
  if (!principal || principal.id !== scope.principalId || principal.tenantId !== scope.tenantId || principal.disabledAt
    || !member || member.tenantId !== scope.tenantId || member.workspaceId !== scope.workspaceId || member.principalId !== scope.principalId
    || member.removedAt || !(write ? ['owner','operator'] : ['owner','operator','reviewer','viewer']).includes(member.workspaceRole))
    throw new KernelError('WORKSPACE_ACCESS_DENIED', '无权访问工作区资料', '联系工作区所有者');
}
export function assertDerivedAssetProvenance(tx: KernelTransaction, scope: {tenantId:string;workspaceId:string}, asset: Asset,
  validateSource?: ContextSourceValidator): void {
  assertContextSource(tx, scope, {namespace:'asset',resourceId:asset.id,streamVersion:asset.streamVersion,digest:asset.digest}, validateSource);
}
export function validateAssetProvenanceInput(value: AssetProvenanceV2, assetId: string): void {
  if (!value || value.version !== 1 || !['goal_export','mcp_resource'].includes(value.kind)
    || value.producer?.namespace !== (value.kind === 'goal_export' ? 'goal.export' : 'mcp.resourceRead')
    || typeof value.producer.resourceId !== 'string' || !value.producer.resourceId || value.producer.resourceId.length > 200
    || !Array.isArray(value.sourceRefs) || !value.sourceRefs.length || value.sourceRefs.length > 256
    || value.sourceRefs.some(ref => ref.namespace === 'asset' && ref.resourceId === assetId)
    || new Set(value.sourceRefs.map(ref => JSON.stringify(ref))).size !== value.sourceRefs.length)
    throw new KernelError('ASSET_PROVENANCE_INVALID', '派生资料来源无效', '选择已授权的原始资料');
}
