// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, MemoryRecord } from "@mn/contracts";
import {
  KernelError,
  PROTECTED_PAYLOAD_KEY_NAMESPACE,
  type KernelStore,
  type PreparedMemoryPayload,
} from "@mn/kernel";
import {
  readProtectedJson,
  storeProtectedJson,
  type ContentAddressedStorage,
  type KeyProvider,
  type ProtectedJsonKeyRecordV1,
} from "@mn/storage";

export interface MemoryProtectionOptions {
  readonly store: KernelStore;
  readonly cas?: ContentAddressedStorage;
  readonly keyProvider?: KeyProvider;
}

export interface PrepareMemoryPayloadOptions extends MemoryProtectionOptions {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly protectedPayloadRef: string;
  readonly value: JsonObject;
  readonly createdAt: string;
}

function requireProtection(options: MemoryProtectionOptions): {
  readonly cas: ContentAddressedStorage;
  readonly keyProvider: KeyProvider;
} {
  if (!options.cas || !options.keyProvider) {
    throw new KernelError(
      "PROTECTED_PAYLOAD_UNAVAILABLE",
      "记忆暂时无法加密或读取",
      "检查对象存储和 Keychain 或 Vault/KMS 连接",
      true,
    );
  }
  return { cas: options.cas, keyProvider: options.keyProvider };
}

export async function prepareMemoryPayload(
  options: PrepareMemoryPayloadOptions,
): Promise<PreparedMemoryPayload> {
  const protection = requireProtection(options);
  const stored = await storeProtectedJson({
    tenantId: options.tenantId,
    workspaceId: options.workspaceId,
    ownerType: "memory",
    ownerId: options.memoryId,
    protectedPayloadRef: options.protectedPayloadRef,
    value: options.value,
    cas: protection.cas,
    keyProvider: protection.keyProvider,
    createdAt: options.createdAt,
  });
  return {
    memoryId: options.memoryId,
    protectedPayloadRef: stored.protectedPayloadRef,
    plaintextDigest: stored.plaintextDigest,
    keyRecord: stored.keyRecord,
  };
}

export async function readMemoryValue(
  options: MemoryProtectionOptions & {
    readonly tenantId: string;
    readonly memory: MemoryRecord;
  },
): Promise<JsonObject> {
  const protection = requireProtection(options);
  if (!options.memory.protectedPayloadRef) {
    throw new KernelError(
      "PROTECTED_PAYLOAD_DESTROYED",
      "记忆的数据密钥已不存在",
      "查看删除审计记录",
    );
  }
  const keyRecord = await options.store.transact(options.tenantId, (transaction) =>
    transaction.getProjection<ProtectedJsonKeyRecordV1>(
      PROTECTED_PAYLOAD_KEY_NAMESPACE,
      options.memory.protectedPayloadRef!,
    ));
  if (!keyRecord) {
    throw new KernelError(
      "PROTECTED_PAYLOAD_DESTROYED",
      "记忆的数据密钥已不存在",
      "查看删除审计记录",
    );
  }
  try {
    return await readProtectedJson({
      tenantId: options.tenantId,
      workspaceId: options.memory.workspaceId,
      ownerType: "memory",
      ownerId: options.memory.id,
      protectedPayloadRef: options.memory.protectedPayloadRef,
      keyRecord,
      cas: protection.cas,
      keyProvider: protection.keyProvider,
    });
  } catch (error) {
    if (error instanceof KernelError) throw error;
    throw new KernelError(
      "PROTECTED_PAYLOAD_UNAVAILABLE",
      "记忆暂时无法解密",
      "检查对象存储和 Keychain 或 Vault/KMS 连接",
      true,
    );
  }
}

export function publicMemory(
  memory: MemoryRecord,
  value: JsonObject,
): Omit<MemoryRecord, "protectedPayloadRef"> & { readonly value: JsonObject } {
  const { protectedPayloadRef: _protectedPayloadRef, ...metadata } = memory;
  return { ...metadata, value };
}
