// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { canonicalFrozenClone, canonicalJson } from "@mn/specs";

import { identifier, safeInteger, text } from "./shared.js";
import type { TenantObjectRefV1 } from "./types.js";

const ALGORITHM = "aes-256-gcm" as const;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-/]{0,126}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface TenantEnvelopeBlobBackendV1 {
  putIfAbsent(input: {
    readonly tenantId: string;
    readonly objectId: string;
    readonly content: Uint8Array;
  }): Promise<"created" | "exists">;
  get(tenantId: string, objectId: string): Promise<Uint8Array | undefined>;
}

export interface TenantEnvelopeDataKeyV1 {
  readonly plaintextKey: Uint8Array;
  readonly wrappedKey: string;
  readonly keyRef: string;
}

export interface TenantEnvelopeKeyProviderV1 {
  generateDataKey(tenantId: string): Promise<TenantEnvelopeDataKeyV1>;
  decryptDataKey(tenantId: string, wrappedKey: string, keyRef: string): Promise<Uint8Array>;
}

interface TenantEnvelopeObjectV1 {
  readonly schemaVersion: 1;
  readonly algorithm: typeof ALGORITHM;
  readonly tenantDigest: string;
  readonly objectId: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly keyRef: string;
  readonly wrappedKey: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export class TenantEnvelopeContentStore {
  constructor(
    private readonly backend: TenantEnvelopeBlobBackendV1,
    private readonly keys: TenantEnvelopeKeyProviderV1,
    private readonly maximumBytes = 512 * 1024 * 1024
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new TypeError("maximumBytes must be a positive safe integer");
    }
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
    if (plaintext.byteLength < 1) throw new TypeError("plaintext must not be empty");
    if (plaintext.byteLength > this.maximumBytes) throw new TypeError("plaintext exceeds the content size limit");
    const digest = createHash("sha256").update(plaintext).digest("hex");
    const ref: TenantObjectRefV1 = canonicalFrozenClone({
      schemaVersion: 1,
      tenantId,
      objectId: digest,
      digest,
      mediaType,
      bytes: plaintext.byteLength,
      storage: "tenant_s3",
      encryption: "tenant-envelope"
    });
    const material = await this.keys.generateDataKey(tenantId);
    const key = requireDataKey(material.plaintextKey);
    const keyRef = text(material.keyRef, "envelope.keyRef", 2_048);
    const wrappedKey = text(material.wrappedKey, "envelope.wrappedKey", 32_768);
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(envelopeAad(ref, keyRef, wrappedKey), "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: TenantEnvelopeObjectV1 = {
        schemaVersion: 1,
        algorithm: ALGORITHM,
        tenantDigest: tenantDigest(tenantId),
        objectId: ref.objectId,
        digest: ref.digest,
        mediaType,
        bytes: ref.bytes,
        keyRef,
        wrappedKey,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
      };
      const outcome = await this.backend.putIfAbsent({
        tenantId,
        objectId: ref.objectId,
        content: Buffer.from(`${canonicalJson(envelope)}\n`, "utf8")
      });
      if (outcome !== "created" && outcome !== "exists") {
        throw new Error("tenant envelope backend returned an invalid outcome");
      }
      if (outcome === "exists") {
        const existing = await this.read(ref);
        if (!existing.equals(plaintext)) throw new Error("content address collision or integrity failure");
      }
      return ref;
    } finally {
      key.fill(0);
    }
  }

  async read(refValue: TenantObjectRefV1): Promise<Buffer> {
    const ref = requireEnvelopeRef(refValue);
    const content = await this.backend.get(ref.tenantId, ref.objectId);
    if (content === undefined) throw new Error("tenant content is unavailable for the requested tenant");
    if (!(content instanceof Uint8Array)
      || content.byteLength > Math.ceil(ref.bytes * 1.5) + 65_536) {
      throw new Error("tenant content envelope exceeds its integrity bound");
    }
    const envelope = parseEnvelope(content, ref);
    let key: Buffer;
    try {
      key = requireDataKey(await this.keys.decryptDataKey(
        ref.tenantId,
        envelope.wrappedKey,
        envelope.keyRef
      ));
    } catch (error) {
      throw new Error("tenant envelope key authentication failed", { cause: error });
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, decodeBase64(envelope.iv, 12, "iv"));
      decipher.setAAD(Buffer.from(envelopeAad(ref, envelope.keyRef, envelope.wrappedKey), "utf8"));
      decipher.setAuthTag(decodeBase64(envelope.tag, 16, "tag"));
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64(envelope.ciphertext, ref.bytes, "ciphertext")),
        decipher.final()
      ]);
      if (createHash("sha256").update(plaintext).digest("hex") !== ref.digest) {
        throw new Error("content digest mismatch");
      }
      return plaintext;
    } catch (error) {
      throw new Error("tenant content authentication or integrity check failed", { cause: error });
    } finally {
      key.fill(0);
    }
  }
}

function requireEnvelopeRef(value: TenantObjectRefV1): TenantObjectRefV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tenant content reference must be an object");
  }
  const fields = ["schemaVersion", "tenantId", "objectId", "digest", "mediaType", "bytes", "storage", "encryption"];
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || value.storage !== "tenant_s3" || value.encryption !== "tenant-envelope") {
    throw new TypeError("tenant content reference contract is invalid");
  }
  const digest = requireSha256(value.digest, "content.digest");
  const objectId = requireSha256(value.objectId, "content.objectId");
  if (digest !== objectId) throw new TypeError("content address does not match its digest");
  return canonicalFrozenClone({
    ...value,
    tenantId: identifier(value.tenantId, "content.tenantId"),
    objectId,
    digest,
    mediaType: requireMediaType(value.mediaType),
    bytes: safeInteger(value.bytes, "content.bytes", 1)
  });
}

function parseEnvelope(content: Uint8Array, ref: TenantObjectRefV1): TenantEnvelopeObjectV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("tenant content envelope is not valid JSON", { cause: error });
  }
  const fields = [
    "schemaVersion", "algorithm", "tenantDigest", "objectId", "digest", "mediaType",
    "bytes", "keyRef", "wrappedKey", "iv", "tag", "ciphertext"
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("tenant content envelope integrity check failed");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.algorithm !== ALGORITHM
    || record.tenantDigest !== tenantDigest(ref.tenantId) || record.objectId !== ref.objectId
    || record.digest !== ref.digest || record.mediaType !== ref.mediaType || record.bytes !== ref.bytes) {
    throw new Error("tenant content envelope integrity check failed");
  }
  return {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    tenantDigest: String(record.tenantDigest),
    objectId: ref.objectId,
    digest: ref.digest,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    keyRef: text(record.keyRef, "envelope.keyRef", 2_048),
    wrappedKey: text(record.wrappedKey, "envelope.wrappedKey", 32_768),
    iv: text(record.iv, "envelope.iv", 64),
    tag: text(record.tag, "envelope.tag", 64),
    ciphertext: text(record.ciphertext, "envelope.ciphertext", Math.ceil(ref.bytes * 1.5) + 16)
  };
}

function envelopeAad(ref: TenantObjectRefV1, keyRef: string, wrappedKey: string): string {
  return canonicalJson({
    schemaVersion: 1,
    algorithm: ALGORITHM,
    tenantId: ref.tenantId,
    objectId: ref.objectId,
    digest: ref.digest,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    storage: ref.storage,
    encryption: ref.encryption,
    keyRef,
    wrappedKeyDigest: createHash("sha256").update(wrappedKey, "utf8").digest("hex")
  });
}

function requireDataKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("tenant envelope data key must contain 32 bytes");
  }
  return Buffer.from(value);
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

function tenantDigest(tenantId: string): string {
  return createHash("sha256").update(tenantId, "utf8").digest("hex");
}

function decodeBase64(value: string, expectedBytes: number, field: string): Buffer {
  if (!BASE64.test(value)) throw new Error(`${field} is not canonical base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
    throw new Error(`${field} has an invalid length`);
  }
  return decoded;
}
