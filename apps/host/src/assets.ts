// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { Asset, JsonObject, Workspace } from "@mn/contracts";
import { KernelError, sha256, type KernelStore } from "@mn/kernel";
import {
  AttachmentValidationError,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  validateAttachments,
  type AttachmentInput,
  type ContentAddressedStorage,
} from "@mn/storage";

interface EncodedAttachment {
  readonly fileName: string;
  readonly mediaType: string;
  readonly contentBase64: string;
}

export interface CreateAssetsOptions {
  readonly store: KernelStore;
  readonly cas: ContentAddressedStorage;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly expectedStreamVersion: number;
  readonly attachments: unknown;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}

interface PreparedAttachment extends AttachmentInput {
  readonly digest: string;
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
    if (Object.keys(record).some((key) => !["fileName", "mediaType", "contentBase64"].includes(key))) {
      throw attachmentError(`attachments[${index}] 包含不支持的字段`);
    }
    return {
      fileName: requiredString(record.fileName, `attachments[${index}].fileName`),
      mediaType: requiredString(record.mediaType, `attachments[${index}].mediaType`),
      contentBase64: stringValue(record.contentBase64, `attachments[${index}].contentBase64`),
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
    return validated.attachments.map((attachment) => ({
      ...attachment,
      digest: createHash("sha256").update(attachment.bytes).digest("hex"),
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
      digest: attachment.digest,
      byteLength: attachment.bytes.byteLength,
    })),
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

  for (const attachment of attachments) {
    const stored = await options.cas.put(attachment.bytes);
    if (stored.digest !== attachment.digest || stored.byteLength !== attachment.bytes.byteLength) {
      throw new Error("CAS returned an invalid object descriptor");
    }
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
    const assets = attachments.map((attachment): Asset => {
      const asset: Asset = {
        id: options.id("asset"),
        tenantId: options.tenantId,
        workspaceId: options.workspaceId,
        digest: attachment.digest,
        mediaType: attachment.mediaType,
        byteLength: attachment.bytes.byteLength,
        fileName: attachment.fileName,
        protected: false,
        streamVersion: 1,
        createdAt,
        updatedAt: createdAt,
      };
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
