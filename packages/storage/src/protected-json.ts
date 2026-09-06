// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { JsonObject } from "@mn/contracts";

import type { ContentAddressedStorage } from "./cas.js";
import {
  EnvelopeCipher,
  type EncryptedEnvelopeV1,
  type KeyProvider,
  type WrappedDataKey,
} from "./encryption.js";
import { canonicalJson } from "./integrity.js";

export interface ProtectedJsonKeyRecordV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly algorithm: "AES-256-GCM";
  readonly nonce: string;
  readonly tag: string;
  readonly context: EncryptedEnvelopeV1["context"];
  readonly wrappedKey: WrappedDataKey;
  readonly ciphertextDigest: string;
  readonly ciphertextByteLength: number;
  readonly createdAt: string;
}

export interface StoredProtectedJson {
  readonly protectedPayloadRef: string;
  readonly plaintextDigest: string;
  readonly keyRecord: ProtectedJsonKeyRecordV1;
}

export interface StoreProtectedJsonOptions {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly protectedPayloadRef: string;
  readonly value: JsonObject;
  readonly cas: ContentAddressedStorage;
  readonly keyProvider: KeyProvider;
  readonly createdAt: string;
}

export interface ReadProtectedJsonOptions {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly protectedPayloadRef: string;
  readonly keyRecord: ProtectedJsonKeyRecordV1;
  readonly cas: ContentAddressedStorage;
  readonly keyProvider: KeyProvider;
}

function purpose(ownerType: string, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

function verifyStoredObject(
  stored: { readonly digest: string; readonly byteLength: number },
  bytes: Uint8Array,
): void {
  const expected = digestBytes(bytes);
  if (stored.digest !== expected || stored.byteLength !== bytes.byteLength) {
    throw new Error("CAS returned an invalid object descriptor");
  }
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function storeProtectedJson(
  options: StoreProtectedJsonOptions,
): Promise<StoredProtectedJson> {
  if (!options.protectedPayloadRef.trim()) throw new TypeError("protected payload ref 不能为空");
  if (!options.ownerType.trim() || !options.ownerId.trim()) {
    throw new TypeError("protected payload owner 不能为空");
  }
  const plaintext = Buffer.from(canonicalJson(options.value), "utf8");
  const plaintextDigest = digestBytes(plaintext);
  const context = {
    tenantId: options.tenantId,
    purpose: purpose(options.ownerType, options.ownerId),
  };
  let encrypted: EncryptedEnvelopeV1;
  try {
    encrypted = await new EnvelopeCipher(options.keyProvider).encrypt(plaintext, context);
  } finally {
    plaintext.fill(0);
  }
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const stored = await options.cas.put(ciphertext);
  verifyStoredObject(stored, ciphertext);
  return {
    protectedPayloadRef: options.protectedPayloadRef,
    plaintextDigest,
    keyRecord: {
      version: 1,
      id: options.protectedPayloadRef,
      workspaceId: options.workspaceId,
      ownerType: options.ownerType,
      ownerId: options.ownerId,
      algorithm: encrypted.algorithm,
      nonce: encrypted.nonce,
      tag: encrypted.tag,
      context: encrypted.context,
      wrappedKey: encrypted.wrappedKey,
      ciphertextDigest: stored.digest,
      ciphertextByteLength: stored.byteLength,
      createdAt: options.createdAt,
    },
  };
}

export async function readProtectedJson(options: ReadProtectedJsonOptions): Promise<JsonObject> {
  const record = options.keyRecord;
  if (record.id !== options.protectedPayloadRef
    || record.workspaceId !== options.workspaceId
    || record.ownerType !== options.ownerType
    || record.ownerId !== options.ownerId
    || record.context.tenantId !== options.tenantId
    || record.context.purpose !== purpose(options.ownerType, options.ownerId)) {
    throw new Error("Protected payload key record does not match its owner");
  }
  const ciphertext = await options.cas.get(record.ciphertextDigest);
  if (ciphertext.byteLength !== record.ciphertextByteLength
    || digestBytes(ciphertext) !== record.ciphertextDigest) {
    throw new Error("Protected payload ciphertext does not match its descriptor");
  }
  const plaintext = await new EnvelopeCipher(options.keyProvider).decrypt({
    version: record.version,
    algorithm: record.algorithm,
    nonce: record.nonce,
    ciphertext: ciphertext.toString("base64"),
    tag: record.tag,
    context: record.context,
    wrappedKey: record.wrappedKey,
  });
  try {
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Protected JSON payload is not an object");
    }
    return parsed as JsonObject;
  } finally {
    plaintext.fill(0);
  }
}
