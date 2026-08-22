// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  createSafeRandomPublicControlIdV1,
  deepFreeze,
  type AgentAttachmentDescriptorV1
} from "@mn/agent-protocol";
import { Transformer, type Metadata } from "@napi-rs/image";

import type { S3CompatibleArtifactStore } from "./artifactRemoteStore.js";

const DEFAULT_MAX_IMAGE_BYTES = 3_670_016;
const DEFAULT_MAX_DIMENSION = 2_000;
const DEFAULT_MAX_PIXELS = 40_000_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface AgentAttachmentLimits {
  readonly maxImageBytes?: number;
  readonly maxDimension?: number;
  readonly maxPixels?: number;
}

interface NormalizedAttachmentLimits {
  readonly maxImageBytes: number;
  readonly maxDimension: number;
  readonly maxPixels: number;
}

export type { AgentAttachmentDescriptorV1 } from "@mn/agent-protocol";

export interface AgentAttachmentPutInput {
  readonly tenantId?: string;
  readonly sessionId: string;
  readonly contentType: string;
  readonly bytes: Buffer | Uint8Array;
  readonly claimedSha256?: string;
  readonly claimedByteLength?: number;
}

export interface AgentAttachmentGetInput {
  readonly tenantId?: string;
  readonly sessionId: string;
  readonly descriptor: AgentAttachmentDescriptorV1;
}

export interface AgentAttachmentStore {
  put(input: AgentAttachmentPutInput): Promise<AgentAttachmentDescriptorV1>;
  get(input: AgentAttachmentGetInput): Promise<Buffer>;
}

export class AgentAttachmentIntegrityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentAttachmentIntegrityError";
  }
}

interface ValidatedImage {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: AgentAttachmentDescriptorV1["contentType"];
  readonly width: number;
  readonly height: number;
}

export interface LocalAgentAttachmentStoreOptions {
  readonly rootDir: string;
  readonly limits?: AgentAttachmentLimits;
}

export class LocalAgentAttachmentStore implements AgentAttachmentStore {
  private readonly rootDir: string;
  private readonly objectsDir: string;
  private readonly limits: NormalizedAttachmentLimits;

  constructor(options: LocalAgentAttachmentStoreOptions) {
    if (!options.rootDir || options.rootDir.includes("\0")) {
      throw new TypeError("local attachment root is invalid");
    }
    this.rootDir = resolve(options.rootDir);
    this.objectsDir = join(this.rootDir, "objects", "v1");
    this.limits = normalizeLimits(options.limits);
  }

  async put(input: AgentAttachmentPutInput): Promise<AgentAttachmentDescriptorV1> {
    const sessionId = normalizeScope(input.sessionId, "session");
    const image = await validateImage(input, this.limits);
    await this.ensureStorageRoot();
    const destination = this.objectPath(image.sha256);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await assertDirectoryNoSymlink(dirname(destination));
    try {
      const handle = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(image.bytes);
        await handle.sync();
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readRegularFileNoFollow(destination);
      assertBytesMatch(image, existing, "existing local attachment object");
    }
    return descriptor(sessionId, image);
  }

  async get(input: AgentAttachmentGetInput): Promise<Buffer> {
    const sessionId = normalizeScope(input.sessionId, "session");
    const fixed = inspectDescriptor(input.descriptor);
    if (fixed.sessionId !== sessionId || fixed.tenantBinding !== undefined) {
      throw new AgentAttachmentIntegrityError("attachment descriptor does not belong to this session");
    }
    const bytes = await readRegularFileNoFollow(this.objectPath(fixed.sha256));
    assertDescriptorBytes(fixed, bytes);
    return bytes;
  }

  objectPathForTest(sha256: string): string {
    if (!DIGEST_PATTERN.test(sha256)) throw new TypeError("attachment digest is invalid");
    return this.objectPath(sha256);
  }

  private objectPath(sha256: string): string {
    return join(this.objectsDir, sha256.slice(0, 2), sha256);
  }

  private async ensureStorageRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await assertDirectoryNoSymlink(this.rootDir);
    await chmod(this.rootDir, 0o700);
    await mkdir(this.objectsDir, { recursive: true, mode: 0o700 });
    await assertDirectoryNoSymlink(this.objectsDir);
    const canonicalRoot = await realpath(this.rootDir);
    const canonicalObjects = await realpath(this.objectsDir);
    if (!canonicalObjects.startsWith(`${canonicalRoot}/`)) {
      throw new AgentAttachmentIntegrityError("attachment object directory escapes its root");
    }
  }
}

export interface EnterpriseAgentObjectStoreOptions {
  readonly store: S3CompatibleArtifactStore;
  readonly keySecret: Buffer | Uint8Array | string;
  readonly prefix?: string;
  readonly limits?: AgentAttachmentLimits;
}

export class EnterpriseAgentObjectStore implements AgentAttachmentStore {
  private readonly store: S3CompatibleArtifactStore;
  private readonly keySecret: Buffer;
  private readonly prefix: string;
  private readonly limits: NormalizedAttachmentLimits;

  constructor(options: EnterpriseAgentObjectStoreOptions) {
    this.store = options.store;
    this.keySecret = toBuffer(options.keySecret);
    if (this.keySecret.byteLength < 16) {
      throw new TypeError("enterprise attachment object key secret is too short");
    }
    this.prefix = normalizePrefix(options.prefix);
    this.limits = normalizeLimits(options.limits);
  }

  async put(input: AgentAttachmentPutInput): Promise<AgentAttachmentDescriptorV1> {
    const tenantId = normalizeScope(input.tenantId, "tenant");
    const sessionId = normalizeScope(input.sessionId, "session");
    const image = await validateImage(input, this.limits);
    const tenantBinding = this.scopeHmac("binding", tenantId, sessionId);
    const objectKey = this.objectKey(tenantId, sessionId, image.sha256);
    const metadata = {
      "mn-sha256": image.sha256,
      "mn-byte-length": String(image.byteLength),
      "mn-content-type": image.contentType,
      "mn-tenant-binding": tenantBinding,
      "mn-schema-version": "1"
    };
    const stored = await this.store.putObject(objectKey, image.bytes, {
      contentType: image.contentType,
      metadata,
      ifNoneMatch: "*"
    });
    if (stored.sha256 !== image.sha256 || stored.bytes !== image.byteLength) {
      throw new AgentAttachmentIntegrityError("enterprise attachment write verification failed");
    }
    const head = await this.store.headObject(objectKey);
    if (head === undefined
      || head.bytes !== image.byteLength
      || head.contentType !== image.contentType
      || head.metadata["mn-sha256"] !== image.sha256
      || head.metadata["mn-byte-length"] !== String(image.byteLength)
      || head.metadata["mn-content-type"] !== image.contentType
      || head.metadata["mn-tenant-binding"] !== tenantBinding
      || head.metadata["mn-schema-version"] !== "1") {
      throw new AgentAttachmentIntegrityError("enterprise attachment object is missing or failed HEAD verification");
    }
    const persisted = await this.store.getObject(objectKey);
    if (persisted === undefined) {
      throw new AgentAttachmentIntegrityError("enterprise attachment object is missing after write");
    }
    assertBytesMatch(image, persisted, "enterprise attachment object");
    return descriptor(sessionId, image, tenantBinding);
  }

  async get(input: AgentAttachmentGetInput): Promise<Buffer> {
    const tenantId = normalizeScope(input.tenantId, "tenant");
    const sessionId = normalizeScope(input.sessionId, "session");
    const fixed = inspectDescriptor(input.descriptor);
    const tenantBinding = this.scopeHmac("binding", tenantId, sessionId);
    if (fixed.sessionId !== sessionId || fixed.tenantBinding !== tenantBinding) {
      throw new AgentAttachmentIntegrityError("attachment descriptor tenant or session binding mismatch");
    }
    const bytes = await this.store.getObject(this.objectKey(tenantId, sessionId, fixed.sha256));
    if (bytes === undefined) throw new AgentAttachmentIntegrityError("enterprise attachment object is missing");
    assertDescriptorBytes(fixed, bytes);
    return bytes;
  }

  private objectKey(tenantId: string, sessionId: string, sha256: string): string {
    const scoped = this.scopeHmac("object", tenantId, sessionId, sha256);
    const suffix = `agent-attachments/v1/${scoped.slice(0, 2)}/${scoped}`;
    return this.prefix ? `${this.prefix}/${suffix}` : suffix;
  }

  private scopeHmac(...parts: string[]): string {
    const hmac = createHmac("sha256", this.keySecret);
    for (const part of parts) hmac.update(part).update("\0");
    return hmac.digest("hex");
  }
}

async function validateImage(
  input: AgentAttachmentPutInput,
  limits: NormalizedAttachmentLimits
): Promise<ValidatedImage> {
  const contentType = normalizeContentType(input.contentType);
  const bytes = toBuffer(input.bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxImageBytes) {
    throw new AgentAttachmentIntegrityError("attachment image size exceeds the configured limit");
  }
  if (input.claimedByteLength !== undefined && input.claimedByteLength !== bytes.byteLength) {
    throw new AgentAttachmentIntegrityError("attachment byte length does not match its claim");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.claimedSha256 !== undefined
    && (!DIGEST_PATTERN.test(input.claimedSha256) || input.claimedSha256 !== sha256)) {
    throw new AgentAttachmentIntegrityError("attachment digest does not match its claim");
  }
  rejectAnimatedImage(contentType, bytes);
  let metadata: Metadata;
  try {
    const image = new Transformer(bytes);
    metadata = await image.metadata();
    const expectedFormat = contentType === "image/jpeg" ? "jpeg" : contentType.slice("image/".length);
    if (metadata.format !== expectedFormat) {
      throw new AgentAttachmentIntegrityError("attachment content type does not match the decoded image format");
    }
    if (metadata.width <= 0 || metadata.height <= 0
      || metadata.width > limits.maxDimension || metadata.height > limits.maxDimension
      || metadata.width * metadata.height > limits.maxPixels) {
      throw new AgentAttachmentIntegrityError("attachment image dimensions exceed the configured limit");
    }
    await image.rawPixels();
  } catch (error: unknown) {
    if (error instanceof AgentAttachmentIntegrityError) throw error;
    throw new AgentAttachmentIntegrityError("attachment image could not be completely decoded", error);
  }
  return Object.freeze({
    bytes,
    sha256,
    byteLength: bytes.byteLength,
    contentType,
    width: metadata.width as number,
    height: metadata.height as number
  });
}

function rejectAnimatedImage(
  contentType: AgentAttachmentDescriptorV1["contentType"],
  bytes: Buffer
): void {
  if (contentType === "image/png" && isAnimatedPng(bytes)
    || contentType === "image/webp" && isAnimatedWebp(bytes)) {
    throw new AgentAttachmentIntegrityError("animated images are not supported");
  }
}

function isAnimatedPng(bytes: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < signature.byteLength || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) return false;
    if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") return true;
    offset = end;
  }
  return false;
}

function isAnimatedWebp(bytes: Buffer): boolean {
  if (bytes.byteLength < 12
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP") return false;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) return false;
    if (type === "ANIM" || type === "ANMF"
      || type === "VP8X" && length > 0 && (bytes[dataOffset]! & 0x02) !== 0) return true;
    offset = end + (length & 1);
  }
  return false;
}

function descriptor(
  sessionId: string,
  image: ValidatedImage,
  tenantBinding?: string
): AgentAttachmentDescriptorV1 {
  return deepFreeze({
    schemaVersion: 1,
    kind: "agent-attachment-descriptor",
    attachmentId: createSafeRandomPublicControlIdV1("attachment"),
    sessionId,
    sha256: image.sha256,
    byteLength: image.byteLength,
    contentType: image.contentType,
    width: image.width,
    height: image.height,
    ...(tenantBinding === undefined ? {} : { tenantBinding })
  });
}

function inspectDescriptor(value: AgentAttachmentDescriptorV1): AgentAttachmentDescriptorV1 {
  const keys = [
    "schemaVersion",
    "kind",
    "attachmentId",
    "sessionId",
    "sha256",
    "byteLength",
    "contentType",
    "width",
    "height",
    "tenantBinding"
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    || value.schemaVersion !== 1
    || value.kind !== "agent-attachment-descriptor"
    || !value.attachmentId.startsWith("attachment-")
    || !DIGEST_PATTERN.test(value.sha256)
    || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0
    || !CONTENT_TYPES.has(value.contentType)
    || !Number.isSafeInteger(value.width) || value.width <= 0
    || !Number.isSafeInteger(value.height) || value.height <= 0
    || (value.tenantBinding !== undefined && !DIGEST_PATTERN.test(value.tenantBinding))) {
    throw new AgentAttachmentIntegrityError("attachment descriptor is invalid");
  }
  normalizeScope(value.sessionId, "session");
  return value;
}

function assertBytesMatch(image: ValidatedImage, bytes: Buffer, label: string): void {
  if (bytes.byteLength !== image.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== image.sha256) {
    throw new AgentAttachmentIntegrityError(`${label} failed digest or length verification`);
  }
}

function assertDescriptorBytes(descriptor: AgentAttachmentDescriptorV1, bytes: Buffer): void {
  if (bytes.byteLength !== descriptor.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
    throw new AgentAttachmentIntegrityError("attachment object failed digest or length verification");
  }
}

async function readRegularFileNoFollow(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentAttachmentIntegrityError("attachment object is missing");
    }
    throw new AgentAttachmentIntegrityError("attachment object cannot be opened safely", error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new AgentAttachmentIntegrityError("attachment object is not a private regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertDirectoryNoSymlink(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AgentAttachmentIntegrityError("attachment storage path is not a real directory");
  }
}

function normalizeScope(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || value !== value.trim() || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`attachment ${label} scope is invalid`);
  }
  return value;
}

function normalizeContentType(value: string): AgentAttachmentDescriptorV1["contentType"] {
  if (!CONTENT_TYPES.has(value)) throw new TypeError("attachment content type is unsupported");
  return value as AgentAttachmentDescriptorV1["contentType"];
}

function normalizeLimits(value: AgentAttachmentLimits | undefined): NormalizedAttachmentLimits {
  const maxImageBytes = value?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxDimension = value?.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxPixels = value?.maxPixels ?? DEFAULT_MAX_PIXELS;
  for (const [label, limit] of [
    ["maxImageBytes", maxImageBytes],
    ["maxDimension", maxDimension],
    ["maxPixels", maxPixels]
  ] as const) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError(`attachment ${label} must be a positive safe integer`);
    }
  }
  return Object.freeze({ maxImageBytes, maxDimension, maxPixels });
}

function normalizePrefix(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return "";
  const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
  if (!/^[A-Za-z0-9._/-]+$/u.test(normalized)
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError("enterprise attachment object prefix is invalid");
  }
  return normalized;
}

function toBuffer(value: Buffer | Uint8Array | string): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(value);
}
