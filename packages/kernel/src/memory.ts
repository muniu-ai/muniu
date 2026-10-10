import type { MemoryRecord, ShareGrant, MemoryProvenanceV2 } from "@mn/contracts";
import { KernelError } from "./errors.js";

export function canReadMemory(
  memory: MemoryRecord,
  requestingNamespace: string,
  grants: readonly ShareGrant[],
): boolean {
  if (memory.status !== "accepted") return false;
  if (memory.namespace === requestingNamespace) return true;
  return grants.some(
    (grant) =>
      grant.memoryId === memory.id &&
      grant.tenantId === memory.tenantId &&
      grant.workspaceId === memory.workspaceId &&
      grant.fromNamespace === memory.namespace &&
      grant.toNamespace === requestingNamespace &&
      grant.revokedAt === undefined,
  );
}

export function acceptMemory(memory: MemoryRecord, now: string): MemoryRecord {
  if (memory.status !== "proposed") {
    throw new KernelError("MEMORY_NOT_PROPOSED", "只有待确认记忆可以接受", "刷新记忆状态");
  }
  return { ...memory, status: "accepted", confirmedAt: now, updatedAt: now, streamVersion: memory.streamVersion + 1 };
}

export function rejectMemory(memory: MemoryRecord, now: string): MemoryRecord {
  if (memory.status !== "proposed") {
    throw new KernelError("MEMORY_NOT_PROPOSED", "只有待确认记忆可以拒绝", "刷新记忆状态");
  }
  return { ...memory, status: "rejected", updatedAt: now, streamVersion: memory.streamVersion + 1 };
}

export function invalidateSharedMemory(memory: MemoryRecord, now: string): MemoryRecord {
  if (memory.status === "deleted") return memory;
  return { ...memory, status: "invalidated", updatedAt: now, streamVersion: memory.streamVersion + 1 };
}

export interface MemorySourceScope { readonly tenantId: string; readonly workspaceId: string; readonly principalId: string }
export interface MemorySourceValidationPort {
  assert(tx: import('./store.js').KernelTransaction, scope: MemorySourceScope, provenance: MemoryProvenanceV2,
    purpose: 'propose' | 'accept' | 'derive' | 'share' | 'read'): void;
}
export function assertMemoryProvenance(provenance: MemoryProvenanceV2): void {
  const invalid = () => { throw new KernelError('MEMORY_PROVENANCE_INVALID', '记忆来源无效', '重新选择来源并创建提案'); };
  if (!provenance || provenance.version !== 1 || !['fact','preference'].includes(provenance.kind)
    || !['user','model'].includes(provenance.origin) || !Array.isArray(provenance.sourceRefs) || provenance.sourceRefs.length > 128
    || Object.keys(provenance).some(key => !['version','kind','origin','sourceRefs','sourceExecution'].includes(key))) invalid();
  const keys = new Set<string>();
  for (const ref of provenance.sourceRefs) {
    if (!ref || typeof ref.namespace !== 'string' || !ref.namespace || typeof ref.resourceId !== 'string' || !ref.resourceId
      || !Number.isSafeInteger(ref.streamVersion) || ref.streamVersion < 1 || !ref.digest || !/^[a-f0-9]{64}$/u.test(ref.digest)
      || Object.keys(ref).some(key => !['namespace','resourceId','streamVersion','digest'].includes(key))) invalid();
    const key = `${ref.namespace}:${ref.resourceId}`; if (keys.has(key)) invalid(); keys.add(key);
  }
  if (provenance.origin === 'model' && !provenance.sourceExecution) invalid();
  if (provenance.origin === 'user' && provenance.sourceExecution) invalid();
  if (provenance.sourceExecution && (typeof provenance.sourceExecution.executionId !== 'string' || !provenance.sourceExecution.executionId
    || !Number.isSafeInteger(provenance.sourceExecution.generation) || provenance.sourceExecution.generation < 1
    || Object.keys(provenance.sourceExecution).some(key => !['executionId','generation'].includes(key)))) invalid();
}
