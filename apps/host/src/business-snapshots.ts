// SPDX-License-Identifier: Apache-2.0
import type { BusinessStateV1 } from "@mn/contracts";
import { KernelError, sha256, type KernelTransaction } from "@mn/kernel";

export const BUSINESS_SNAPSHOT_NAMESPACE = "opc.businessSnapshot";
interface BusinessSnapshot {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly streamVersion: number;
  readonly state: BusinessStateV1;
  readonly digest: string;
}
interface Scope { readonly tenantId: string; readonly workspaceId: string }
function invalid(): never {
  throw new KernelError("BUSINESS_SNAPSHOT_INVALID", "业务历史版本不可用", "重新选择当前业务资料，历史记录不得重写");
}

/** Saved with the business command's event and protected projection journal. */
export function recordBusinessSnapshots(tx: KernelTransaction, scope: Scope, before: BusinessStateV1, next: BusinessStateV1): void {
  if (before.workspaceId !== scope.workspaceId || next.workspaceId !== scope.workspaceId
    || next.streamVersion !== before.streamVersion + 1) invalid();
  for (const state of [before, next]) {
    if (state.streamVersion === 0) continue;
    const body = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, streamVersion: state.streamVersion, state };
    const value = { ...body, digest: sha256(body) }, id = `${scope.workspaceId}:${state.streamVersion}`;
    const previous = tx.getProjection<BusinessSnapshot>(BUSINESS_SNAPSHOT_NAMESPACE, id);
    if (previous) {
      const { digest, ...stored } = previous;
      if (sha256(stored) !== digest || digest !== value.digest) invalid();
    } else tx.putProjection(BUSINESS_SNAPSHOT_NAMESPACE, id, value);
  }
}

export function readBusinessSnapshot(tx: KernelTransaction, scope: Scope, version: number): BusinessStateV1 {
  const current = tx.getProjection<BusinessStateV1>("opc.business", scope.workspaceId);
  if (current?.workspaceId === scope.workspaceId && current.streamVersion === version) return current;
  const value = tx.getProjection<BusinessSnapshot>(BUSINESS_SNAPSHOT_NAMESPACE, `${scope.workspaceId}:${version}`);
  if (!value) invalid();
  const { digest, ...body } = value;
  if (value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId || value.streamVersion !== version
    || value.state.workspaceId !== scope.workspaceId || value.state.streamVersion !== version || sha256(body) !== digest) invalid();
  return value.state;
}
