// SPDX-License-Identifier: Apache-2.0

import { basename, extname } from "node:path";
import { TextDecoder } from "node:util";

export const MAX_ATTACHMENT_COUNT = 20;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BATCH_BYTES = 100 * 1024 * 1024;

export interface AttachmentInput {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface AttachmentValidationResult {
  readonly attachments: readonly AttachmentInput[];
  readonly totalBytes: number;
}

export class AttachmentValidationError extends Error {
  readonly code = "ATTACHMENT_INVALID";

  constructor(message: string, readonly fileName?: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "text/plain": [".txt"],
  "text/markdown": [".md", ".markdown"],
  "application/json": [".json"],
  "text/csv": [".csv"],
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"]
};

const TEXT_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "application/json", "text/csv"]);

function beginsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function assertMediaSignature(attachment: AttachmentInput): void {
  const { bytes, mediaType, fileName } = attachment;
  let matches = true;
  switch (mediaType) {
    case "application/pdf":
      matches = beginsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
      break;
    case "image/png":
      matches = beginsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      break;
    case "image/jpeg":
      matches = beginsWith(bytes, [0xff, 0xd8, 0xff]);
      break;
    case "image/webp":
      matches = beginsWith(bytes, [0x52, 0x49, 0x46, 0x46])
        && beginsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]);
      break;
  }
  if (!matches) {
    throw new AttachmentValidationError(`${fileName} content does not match ${mediaType}`, fileName);
  }
}

function assertText(attachment: AttachmentInput): void {
  if (!TEXT_MEDIA_TYPES.has(attachment.mediaType)) return;
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes);
  } catch {
    throw new AttachmentValidationError(`${attachment.fileName} must contain valid UTF-8`, attachment.fileName);
  }
  if (value.includes("\0")) {
    throw new AttachmentValidationError(`${attachment.fileName} contains binary data`, attachment.fileName);
  }
  if (attachment.mediaType === "application/json") {
    try {
      JSON.parse(value);
    } catch {
      throw new AttachmentValidationError(`${attachment.fileName} must contain valid JSON`, attachment.fileName);
    }
  }
}

export function validateAttachments(
  attachments: readonly AttachmentInput[],
  limits: {
    readonly maxCount?: number;
    readonly maxFileBytes?: number;
    readonly maxBatchBytes?: number;
  } = {}
): AttachmentValidationResult {
  const maxCount = limits.maxCount ?? MAX_ATTACHMENT_COUNT;
  const maxFileBytes = limits.maxFileBytes ?? MAX_ATTACHMENT_BYTES;
  const maxBatchBytes = limits.maxBatchBytes ?? MAX_ATTACHMENT_BATCH_BYTES;
  if (attachments.length > maxCount) {
    throw new AttachmentValidationError(`At most ${maxCount} attachments are allowed`);
  }
  let totalBytes = 0;
  for (const attachment of attachments) {
    const fileName = attachment.fileName.normalize("NFC");
    if (
      fileName.length === 0
      || fileName === "."
      || fileName === ".."
      || basename(fileName) !== fileName
      || fileName.includes("/")
      || fileName.includes("\\")
      || /[\u0000-\u001f\u007f]/.test(fileName)
    ) {
      throw new AttachmentValidationError("Attachment file name must not contain a path", attachment.fileName);
    }
    const allowedExtensions = EXTENSIONS[attachment.mediaType];
    if (!allowedExtensions) {
      throw new AttachmentValidationError(`Unsupported attachment MIME type ${attachment.mediaType}`, fileName);
    }
    if (!allowedExtensions.includes(extname(fileName).toLowerCase())) {
      throw new AttachmentValidationError(`${fileName} extension does not match ${attachment.mediaType}`, fileName);
    }
    if (attachment.bytes.byteLength > maxFileBytes) {
      throw new AttachmentValidationError(`${fileName} exceeds ${maxFileBytes} bytes`, fileName);
    }
    totalBytes += attachment.bytes.byteLength;
    if (totalBytes > maxBatchBytes) {
      throw new AttachmentValidationError(`Attachment batch exceeds ${maxBatchBytes} bytes`);
    }
    assertText(attachment);
    assertMediaSignature(attachment);
  }
  return { attachments, totalBytes };
}
