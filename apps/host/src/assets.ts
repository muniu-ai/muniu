// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { Asset, AssetTombstone, JsonObject, Workspace } from "@mn/contracts";
import { KernelError, sha256, type KernelStore } from "@mn/kernel";
import {
  AttachmentValidationError,
  EnvelopeCipher,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  validateAttachments,
  type AttachmentInput,
  type ContentAddressedStorage,
  type EncryptedEnvelopeV1,
  type KeyProvider,
  type WrappedDataKey,
} from "@mn/storage";

export const PROTECTED_PAYLOAD_KEY_NAMESPACE = "protectedPayloadKey";
export const ASSET_TOMBSTONE_NAMESPACE = "assetTombstone";

interface EncodedAttachment {
  readonly fileName: string;
  readonly mediaType: string;
  readonly contentBase64: string;
  readonly protected: boolean;
}

export interface ProtectedPayloadKeyRecordV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly assetId: string;
  readonly algorithm: "AES-256-GCM";
  readonly nonce: string;
  readonly tag: string;
  readonly context: EncryptedEnvelopeV1["context"];
  readonly wrappedKey: WrappedDataKey;
  readonly createdAt: string;
}

export interface CreateAssetsOptions {
  readonly store: KernelStore;
  readonly cas: ContentAddressedStorage;
  readonly protectedPayloadKeyProvider?: KeyProvider;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly expectedStreamVersion: number;
  readonly attachments: unknown;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}

export interface ReadAssetContentOptions {
  readonly store: KernelStore;
  readonly cas: ContentAddressedStorage;
  readonly protectedPayloadKeyProvider?: KeyProvider;
  readonly tenantId: string;
  readonly asset: Asset;
}

export interface DeleteAssetOptions {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly actorId: string;
  readonly assetId: string;
  readonly idempotencyKey: string;
  readonly expectedStreamVersion: number;
  readonly reason: string;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}

interface PreparedAttachment extends AttachmentInput {
  readonly plaintextDigest: string;
  readonly protected: boolean;
}

interface StoredAttachment {
  readonly attachment: PreparedAttachment;
  readonly assetId: string;
  readonly digest: string;
  readonly protectedPayloadRef?: string;
  readonly keyRecord?: ProtectedPayloadKeyRecordV1;
}

function attachmentError(message: string): KernelError {
  return new KernelError(
    "ATTACHMENT_INVALID",
    message,
    "选择允许的文件类型，并检查文件名、内容和大小",
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw attachmentError(`${field} 必须是非空字符串`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw attachmentError(`${field} 必须是字符串`);
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw attachmentError(`${field} 必须是布尔值`);
  return value;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string") throw attachmentError("contentBase64 必须是字符串");
  const encoded = value;
  if (encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
    throw attachmentError(`单个附件不得超过 ${MAX_ATTACHMENT_BYTES} 字节`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw attachmentError("contentBase64 不是规范的 Base64");
  }
  return Buffer.from(encoded, "base64");
}

function prepareAttachments(input: unknown): readonly PreparedAttachment[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw attachmentError("attachments 必须包含至少一个附件");
  }
  if (input.length > MAX_ATTACHMENT_COUNT) {
    throw attachmentError(`一次最多上传 ${MAX_ATTACHMENT_COUNT} 个附件`);
  }
  const encoded = input.map((value, index): EncodedAttachment => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw attachmentError(`attachments[${index}] 必须是对象`);
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) =>
      !["fileName", "mediaType", "contentBase64", "protected"].includes(key))) {
      throw attachmentError(`attachments[${index}] 包含不支持的字段`);
    }
    return {
      fileName: requiredString(record.fileName, `attachments[${index}].fileName`),
      mediaType: requiredString(record.mediaType, `attachments[${index}].mediaType`),
      contentBase64: stringValue(record.contentBase64, `attachments[${index}].contentBase64`),
      protected: booleanValue(record.protected, `attachments[${index}].protected`),
    };
  });
  const maxEncodedBatchLength = Math.ceil(MAX_ATTACHMENT_BATCH_BYTES / 3) * 4 + encoded.length * 4;
  if (encoded.reduce((total, value) => total + value.contentBase64.length, 0) > maxEncodedBatchLength) {
    throw attachmentError(`附件总大小不得超过 ${MAX_ATTACHMENT_BATCH_BYTES} 字节`);
  }
  const decoded = encoded.map((value): AttachmentInput => ({
    fileName: value.fileName.normalize("NFC"),
    mediaType: value.mediaType,
    bytes: decodeBase64(value.contentBase64),
  }));
  try {
    const validated = validateAttachments(decoded);
    return validated.attachments.map((attachment, index) => ({
      ...attachment,
      plaintextDigest: createHash("sha256").update(attachment.bytes).digest("hex"),
      protected: encoded[index]!.protected,
    }));
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw attachmentError(error.message);
    throw error;
  }
}

function requestProjection(
  workspaceId: string,
  expectedStreamVersion: number,
  attachments: readonly PreparedAttachment[],
): JsonObject {
  return {
    workspaceId,
    expectedStreamVersion,
    attachments: attachments.map((attachment) => ({
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      digest: attachment.plaintextDigest,
      byteLength: attachment.bytes.byteLength,
      protected: attachment.protected,
    })),
  };
}

function verifyStoredObject(
  stored: { readonly digest: string; readonly byteLength: number },
  bytes: Uint8Array,
): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (stored.digest !== digest || stored.byteLength !== bytes.byteLength) {
    throw new Error("CAS returned an invalid object descriptor");
  }
}

async function storeAttachment(
  options: CreateAssetsOptions,
  attachment: PreparedAttachment,
): Promise<StoredAttachment> {
  const assetId = options.id("asset");
  if (!attachment.protected) {
    const stored = await options.cas.put(attachment.bytes);
    verifyStoredObject(stored, attachment.bytes);
    return { attachment, assetId, digest: stored.digest };
  }
  if (!options.protectedPayloadKeyProvider) {
    throw new KernelError(
      "PROTECTED_PAYLOAD_KEY_PROVIDER_UNAVAILABLE",
      "受保护附件暂时无法加密",
      "修复 Keychain 或 Vault/KMS 连接后重试",
      true,
    );
  }
  const protectedPayloadRef = options.id("protected-payload");
  const context = { tenantId: options.tenantId, purpose: `asset:${assetId}` };
  let encrypted: EncryptedEnvelopeV1;
  try {
    encrypted = await new EnvelopeCipher(options.protectedPayloadKeyProvider)
      .encrypt(attachment.bytes, context);
  } finally {
    attachment.bytes.fill(0);
  }
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const stored = await options.cas.put(ciphertext);
  verifyStoredObject(stored, ciphertext);
  return {
    attachment,
    assetId,
    digest: stored.digest,
    protectedPayloadRef,
    keyRecord: {
      version: 1,
      id: protectedPayloadRef,
      workspaceId: options.workspaceId,
      assetId,
      algorithm: encrypted.algorithm,
      nonce: encrypted.nonce,
      tag: encrypted.tag,
      context: encrypted.context,
      wrappedKey: encrypted.wrappedKey,
      createdAt: options.now(),
    },
  };
}

export async function createAssets(options: CreateAssetsOptions): Promise<readonly Asset[]> {
  if (options.expectedStreamVersion !== 0) {
    throw new KernelError(
      "STREAM_VERSION_CONFLICT",
      "新附件的 expectedStreamVersion 必须为 0",
      "将 expectedStreamVersion 设为 0 后重试",
    );
  }
  const attachments = prepareAttachments(options.attachments);
  const request = requestProjection(options.workspaceId, options.expectedStreamVersion, attachments);
  const scope = `asset.create:${options.workspaceId}`;
  const requestDigest = sha256(request);

  const replay = await options.store.transact(options.tenantId, (transaction) => {
    const workspace = transaction.getProjection<Workspace>("workspace", options.workspaceId);
    if (!workspace) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
    const previous = transaction.getIdempotency(scope, options.idempotencyKey);
    if (!previous) return undefined;
    if (previous.requestDigest !== requestDigest) {
      throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
    }
    return previous.response as readonly Asset[];
  });
  if (replay) return replay;

  const storedAttachments: StoredAttachment[] = [];
  for (const attachment of attachments) {
    storedAttachments.push(await storeAttachment(options, attachment));
  }

  return options.store.transact(options.tenantId, (transaction) => {
    const workspace = transaction.getProjection<Workspace>("workspace", options.workspaceId);
    if (!workspace) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
    const raced = transaction.getIdempotency(scope, options.idempotencyKey);
    if (raced) {
      if (raced.requestDigest !== requestDigest) {
        throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
      }
      return raced.response as readonly Asset[];
    }

    const createdAt = options.now();
    const assets = storedAttachments.map((stored): Asset => {
      const asset: Asset = {
        id: stored.assetId,
        tenantId: options.tenantId,
        workspaceId: options.workspaceId,
        digest: stored.digest,
        mediaType: stored.attachment.mediaType,
        byteLength: stored.attachment.bytes.byteLength,
        fileName: stored.attachment.fileName,
        protected: stored.attachment.protected,
        ...(stored.protectedPayloadRef ? { protectedPayloadRef: stored.protectedPayloadRef } : {}),
        streamVersion: 1,
        createdAt,
        updatedAt: createdAt,
      };
      if (stored.keyRecord) {
        transaction.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, stored.keyRecord.id, stored.keyRecord);
      }
      transaction.putProjection("asset", asset.id, asset);
      transaction.appendEvent({
        tenantId: options.tenantId,
        aggregateType: "asset",
        aggregateId: asset.id,
        expectedStreamVersion: 0,
        type: "asset.created",
        actorId: options.actorId,
        generation: 0,
        correlationId: options.id("correlation"),
        publicPayload: {
          workspaceId: options.workspaceId,
          digest: asset.digest,
          mediaType: asset.mediaType,
          byteLength: asset.byteLength,
          fileName: asset.fileName,
          protected: asset.protected,
        },
        ...(asset.protectedPayloadRef ? { protectedPayloadRef: asset.protectedPayloadRef } : {}),
      });
      return asset;
    });
    transaction.putIdempotency({
      tenantId: options.tenantId,
      scope,
      key: options.idempotencyKey,
      requestDigest,
      response: assets,
      createdAt,
    });
    return assets;
  });
}

export async function readAssetContent(options: ReadAssetContentOptions): Promise<Buffer> {
  const stored = await options.cas.get(options.asset.digest);
  verifyStoredObject({ digest: options.asset.digest, byteLength: options.asset.byteLength }, stored);
  if (!options.asset.protected) return Buffer.from(stored);
  if (!options.asset.protectedPayloadRef || !options.protectedPayloadKeyProvider) {
    throw new KernelError(
      "PROTECTED_PAYLOAD_UNAVAILABLE",
      "受保护附件暂时无法读取",
      "检查 Keychain 或 Vault/KMS 连接",
      true,
    );
  }
  const keyRecord = await options.store.transact(options.tenantId, (transaction) =>
    transaction.getProjection<ProtectedPayloadKeyRecordV1>(
      PROTECTED_PAYLOAD_KEY_NAMESPACE,
      options.asset.protectedPayloadRef!,
    ));
  if (!keyRecord || keyRecord.assetId !== options.asset.id
    || keyRecord.workspaceId !== options.asset.workspaceId
    || keyRecord.context.tenantId !== options.tenantId
    || keyRecord.context.purpose !== `asset:${options.asset.id}`) {
    throw new KernelError(
      "PROTECTED_PAYLOAD_DESTROYED",
      "受保护附件的数据密钥已不存在",
      "查看删除审计记录",
    );
  }
  const plaintext = await new EnvelopeCipher(options.protectedPayloadKeyProvider).decrypt({
    version: keyRecord.version,
    algorithm: keyRecord.algorithm,
    nonce: keyRecord.nonce,
    ciphertext: stored.toString("base64"),
    tag: keyRecord.tag,
    context: keyRecord.context,
    wrappedKey: keyRecord.wrappedKey,
  });
  if (plaintext.byteLength !== options.asset.byteLength) {
    plaintext.fill(0);
    throw new Error("Decrypted asset length does not match its descriptor");
  }
  return plaintext;
}

export async function deleteAsset(options: DeleteAssetOptions): Promise<AssetTombstone> {
  const scope = `asset.delete:${options.assetId}`;
  const requestDigest = sha256({
    expectedStreamVersion: options.expectedStreamVersion,
    reason: options.reason,
  });
  return options.store.transact(options.tenantId, (transaction) => {
    const replay = transaction.getIdempotency(scope, options.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
      }
      return replay.response as AssetTombstone;
    }
    const asset = transaction.getProjection<Asset>("asset", options.assetId);
    if (!asset) throw new KernelError("ASSET_NOT_FOUND", "附件不存在", "刷新成果列表");
    if (asset.streamVersion !== options.expectedStreamVersion) {
      throw new KernelError("STREAM_VERSION_CONFLICT", "附件版本已变化", "刷新附件后重试", true);
    }
    const deletedAt = options.now();
    const tombstone: AssetTombstone = {
      id: asset.id,
      tenantId: asset.tenantId,
      workspaceId: asset.workspaceId,
      protected: asset.protected,
      objectDigest: sha256({
        id: asset.id,
        workspaceId: asset.workspaceId,
        digest: asset.digest,
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        fileName: asset.fileName,
        createdAt: asset.createdAt,
      }),
      reasonDigest: sha256(options.reason),
      deletedAt,
      streamVersion: asset.streamVersion + 1,
      createdAt: asset.createdAt,
      updatedAt: deletedAt,
    };
    if (asset.protectedPayloadRef) {
      transaction.deleteProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, asset.protectedPayloadRef);
    }
    transaction.deleteProjection("asset", asset.id);
    transaction.putProjection(ASSET_TOMBSTONE_NAMESPACE, asset.id, tombstone);
    transaction.appendEvent({
      tenantId: options.tenantId,
      aggregateType: "asset",
      aggregateId: asset.id,
      expectedStreamVersion: options.expectedStreamVersion,
      type: "asset.deleted",
      actorId: options.actorId,
      generation: 0,
      correlationId: options.id("correlation"),
      publicPayload: {
        workspaceId: asset.workspaceId,
        objectDigest: tombstone.objectDigest,
        reasonDigest: tombstone.reasonDigest,
        protected: asset.protected,
      },
    });
    transaction.putIdempotency({
      tenantId: options.tenantId,
      scope,
      key: options.idempotencyKey,
      requestDigest,
      response: tombstone,
      createdAt: deletedAt,
    });
    return tombstone;
  });
}
