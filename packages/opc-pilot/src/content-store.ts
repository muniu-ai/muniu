// SPDX-License-Identifier: Apache-2.0

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalFrozenClone, canonicalJson } from "@mn/specs";

import { identifier, safeInteger, text } from "./shared.js";
import type { TenantObjectRefV1 } from "./types.js";

const ALGORITHM = "aes-256-gcm" as const;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-/]{0,126}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/u;

export interface TenantKeyMaterialV1 {
  readonly key: Uint8Array;
  readonly keyRef: string;
}

export interface TenantKeyProviderV1 {
  keyForTenant(tenantId: string, keyRef?: string): Promise<TenantKeyMaterialV1>;
}

export interface KeychainVaultV1 {
  saveSecret(secret: string): Promise<{ readonly type: string; readonly ref: string }>;
  readSecret(ref: string, type?: "keychain"): Promise<string | undefined>;
  deleteSecret(ref: string, type?: "keychain"): Promise<void>;
}

interface TenantKeyManifestV1 {
  readonly schemaVersion: 1;
  readonly tenantDigest: string;
  readonly keyRef: string;
}

interface EncryptedContentEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly algorithm: typeof ALGORITHM;
  readonly tenantDigest: string;
  readonly objectId: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly keyRef: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export class KeychainTenantKeyProvider implements TenantKeyProviderV1 {
  private readonly pending = new Map<string, Promise<TenantKeyMaterialV1>>();

  constructor(
    private readonly manifestRoot: string,
    private readonly vault: KeychainVaultV1
  ) {}

  keyForTenant(tenantIdValue: string, keyRef?: string): Promise<TenantKeyMaterialV1> {
    const tenantId = identifier(tenantIdValue, "tenantId");
    const cacheKey = `${tenantId}\0${keyRef ?? ""}`;
    const existing = this.pending.get(cacheKey);
    if (existing !== undefined) return existing;
    const pending = this.loadOrCreate(tenantId, keyRef).catch((error: unknown) => {
      this.pending.delete(cacheKey);
      throw error;
    });
    this.pending.set(cacheKey, pending);
    return pending;
  }

  private async loadOrCreate(tenantId: string, requestedKeyRef?: string): Promise<TenantKeyMaterialV1> {
    await ensurePrivateDirectory(this.manifestRoot);
    const tenantDigest = tenantIdDigest(tenantId);
    const manifestPath = join(this.manifestRoot, `${tenantDigest}.json`);
    const manifest = await readOptionalJson(manifestPath);
    if (manifest !== undefined) {
      return this.readManifestKey(parseKeyManifest(manifest, tenantDigest), requestedKeyRef);
    }
    if (requestedKeyRef !== undefined) {
      throw new Error("tenant key reference is unavailable");
    }

    const key = randomBytes(32);
    const secretRef = await this.vault.saveSecret(key.toString("base64"));
    if (secretRef.type !== "keychain") {
      await this.vault.deleteSecret(secretRef.ref, "keychain").catch(() => undefined);
      throw new Error("tenant content keys must be stored in macOS Keychain");
    }
    const created = await writeCreateOnly(manifestPath, canonicalJson({
      schemaVersion: 1,
      tenantDigest,
      keyRef: secretRef.ref
    } satisfies TenantKeyManifestV1));
    if (created) return { key, keyRef: secretRef.ref };

    await this.vault.deleteSecret(secretRef.ref, "keychain");
    const winner = await readOptionalJson(manifestPath);
    if (winner === undefined) throw new Error("tenant key manifest creation was interrupted");
    return this.readManifestKey(parseKeyManifest(winner, tenantDigest));
  }

  private async readManifestKey(
    manifest: TenantKeyManifestV1,
    requestedKeyRef?: string
  ): Promise<TenantKeyMaterialV1> {
    if (requestedKeyRef !== undefined && requestedKeyRef !== manifest.keyRef) {
      throw new Error("tenant key reference does not match the content envelope");
    }
    const encoded = await this.vault.readSecret(manifest.keyRef, "keychain");
    if (encoded === undefined) throw new Error("tenant content key is unavailable from macOS Keychain");
    if (!BASE64_32_BYTES.test(encoded)) throw new Error("tenant content key is invalid");
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
      throw new Error("tenant content key is invalid");
    }
    return { key, keyRef: manifest.keyRef };
  }
}

export class EncryptedTenantContentStore {
  private readonly objectsRoot: string;

  constructor(
    readonly rootDir: string,
    private readonly keyProvider: TenantKeyProviderV1,
    private readonly maximumBytes = DEFAULT_MAX_BYTES
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new TypeError("maximumBytes must be a positive safe integer");
    }
    this.objectsRoot = join(rootDir, "objects");
  }

  async put(input: {
    readonly tenantId: string;
    readonly mediaType: string;
    readonly plaintext: Uint8Array;
  }): Promise<TenantObjectRefV1> {
    const tenantId = identifier(input.tenantId, "tenantId");
    const mediaType = requireMediaType(input.mediaType);
    if (!(input.plaintext instanceof Uint8Array)) throw new TypeError("plaintext must be bytes");
    const plaintext = Buffer.from(input.plaintext);
    const bytes = safeInteger(plaintext.byteLength, "plaintext.bytes", 1);
    if (bytes > this.maximumBytes) throw new TypeError("plaintext exceeds the content size limit");
    const digest = createHash("sha256").update(plaintext).digest("hex");
    const objectId = digest;
    const ref: TenantObjectRefV1 = canonicalFrozenClone({
      schemaVersion: 1,
      tenantId,
      objectId,
      digest,
      mediaType,
      bytes,
      storage: "tenant_cas",
      encryption: ALGORITHM
    });
    const keyMaterial = await requireKeyMaterial(await this.keyProvider.keyForTenant(tenantId));
    const iv = randomBytes(12);
    const aad = contentAad(ref, keyMaterial.keyRef);
    const cipher = createCipheriv(ALGORITHM, keyMaterial.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedContentEnvelopeV1 = {
      schemaVersion: 1,
      algorithm: ALGORITHM,
      tenantDigest: tenantIdDigest(tenantId),
      objectId,
      digest,
      mediaType,
      bytes,
      keyRef: keyMaterial.keyRef,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };

    const path = await this.objectPath(tenantId, objectId);
    const created = await writeCreateOnly(path, canonicalJson(envelope));
    if (!created) {
      const existing = await this.read(ref);
      if (!existing.equals(plaintext)) throw new Error("content address collision or integrity failure");
    }
    return ref;
  }

  async read(refValue: TenantObjectRefV1): Promise<Buffer> {
    const ref = requireTenantObjectRef(refValue);
    const path = await this.objectPath(ref.tenantId, ref.objectId);
    let envelopeValue: unknown;
    try {
      envelopeValue = await readRequiredJson(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new Error("tenant content is unavailable for the requested tenant", { cause: error });
      }
      throw error;
    }
    const envelope = parseContentEnvelope(envelopeValue, ref);
    const keyMaterial = await requireKeyMaterial(
      await this.keyProvider.keyForTenant(ref.tenantId, envelope.keyRef)
    );
    if (keyMaterial.keyRef !== envelope.keyRef) throw new Error("content key reference integrity check failed");
    try {
      const decipher = createDecipheriv(ALGORITHM, keyMaterial.key, decodeBase64(envelope.iv, 12, "iv"));
      decipher.setAAD(Buffer.from(contentAad(ref, envelope.keyRef), "utf8"));
      decipher.setAuthTag(decodeBase64(envelope.tag, 16, "tag"));
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64(envelope.ciphertext, envelope.bytes, "ciphertext")),
        decipher.final()
      ]);
      if (plaintext.byteLength !== ref.bytes
        || createHash("sha256").update(plaintext).digest("hex") !== ref.digest) {
        throw new Error("content integrity digest does not match");
      }
      return plaintext;
    } catch (error) {
      throw new Error("content authentication or integrity check failed", { cause: error });
    }
  }

  private async objectPath(tenantId: string, objectId: string): Promise<string> {
    await ensurePrivateDirectory(this.rootDir);
    await ensurePrivateDirectory(this.objectsRoot);
    const tenantDirectory = join(this.objectsRoot, tenantIdDigest(tenantId));
    await ensurePrivateDirectory(tenantDirectory);
    return join(tenantDirectory, `${objectId}.json`);
  }
}

function contentAad(ref: TenantObjectRefV1, keyRef: string): string {
  return canonicalJson({
    schemaVersion: ref.schemaVersion,
    algorithm: ALGORITHM,
    tenantId: ref.tenantId,
    objectId: ref.objectId,
    digest: ref.digest,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    storage: ref.storage,
    encryption: ref.encryption,
    keyRef
  });
}

function requireTenantObjectRef(value: TenantObjectRefV1): TenantObjectRefV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("content reference must be an object");
  }
  const expected = ["schemaVersion", "tenantId", "objectId", "digest", "mediaType", "bytes", "storage", "encryption"];
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("content reference has missing or unsupported fields");
  }
  if (value.schemaVersion !== 1 || value.storage !== "tenant_cas" || value.encryption !== ALGORITHM) {
    throw new TypeError("content reference storage contract is invalid");
  }
  const tenantId = identifier(value.tenantId, "content.tenantId");
  const objectId = requireSha256(value.objectId, "content.objectId");
  const digest = requireSha256(value.digest, "content.digest");
  if (objectId !== digest) throw new TypeError("content address does not match its digest");
  return canonicalFrozenClone({
    ...value,
    tenantId,
    objectId,
    digest,
    mediaType: requireMediaType(value.mediaType),
    bytes: safeInteger(value.bytes, "content.bytes", 1)
  });
}

function parseContentEnvelope(value: unknown, ref: TenantObjectRefV1): EncryptedContentEnvelopeV1 {
  const fields = [
    "schemaVersion", "algorithm", "tenantDigest", "objectId", "digest", "mediaType",
    "bytes", "keyRef", "iv", "tag", "ciphertext"
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("encrypted content envelope integrity check failed");
  }
  const envelope = value as Record<string, unknown>;
  const matches = envelope.schemaVersion === 1
    && envelope.algorithm === ALGORITHM
    && envelope.tenantDigest === tenantIdDigest(ref.tenantId)
    && envelope.objectId === ref.objectId
    && envelope.digest === ref.digest
    && envelope.mediaType === ref.mediaType
    && envelope.bytes === ref.bytes;
  if (!matches) throw new Error("encrypted content envelope integrity check failed");
  return {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    tenantDigest: String(envelope.tenantDigest),
    objectId: ref.objectId,
    digest: ref.digest,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    keyRef: text(envelope.keyRef, "content.keyRef", 512),
    iv: text(envelope.iv, "content.iv", 64),
    tag: text(envelope.tag, "content.tag", 64),
    ciphertext: typeof envelope.ciphertext === "string" ? envelope.ciphertext : ""
  };
}

function parseKeyManifest(value: unknown, tenantDigest: string): TenantKeyManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tenant key manifest is invalid");
  }
  const record = value as Record<string, unknown>;
  const fields = ["schemaVersion", "tenantDigest", "keyRef"];
  if (Object.keys(record).some((key) => !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(record, key))
    || record.schemaVersion !== 1 || record.tenantDigest !== tenantDigest) {
    throw new Error("tenant key manifest is invalid");
  }
  return { schemaVersion: 1, tenantDigest, keyRef: text(record.keyRef, "keyRef", 512) };
}

async function requireKeyMaterial(value: TenantKeyMaterialV1): Promise<TenantKeyMaterialV1> {
  if (!(value.key instanceof Uint8Array) || value.key.byteLength !== 32) {
    throw new Error("tenant content key must contain 32 bytes");
  }
  return { key: Buffer.from(value.key), keyRef: text(value.keyRef, "keyRef", 512) };
}

function requireMediaType(value: unknown): string {
  if (typeof value !== "string" || !MEDIA_TYPE.test(value)) {
    throw new TypeError("mediaType must be a bounded IANA media type");
  }
  return value;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${field} must be SHA-256`);
  return value;
}

function tenantIdDigest(tenantId: string): string {
  return createHash("sha256").update(tenantId, "utf8").digest("hex");
}

function decodeBase64(value: string, expectedBytes: number, field: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
    throw new Error(`${field} has an invalid length`);
  }
  return decoded;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  let directory;
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch (error) {
    if (isNodeError(error, "ELOOP") || isNodeError(error, "ENOTDIR")) {
      throw new Error(`${path} must be a directory and not a symbolic link`, { cause: error });
    }
    throw error;
  }
  try {
    const status = await directory.stat();
    if (!status.isDirectory()) throw new Error(`${path} must be a directory`);
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
}

async function writeCreateOnly(path: string, value: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await readRequiredJson(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readRequiredJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error(`${path} must be a regular file`);
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
