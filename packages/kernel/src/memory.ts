import type { MemoryRecord, ShareGrant } from "@mn/contracts";
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
