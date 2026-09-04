import {
  createHash,
  sign,
  verify,
  type KeyLike,
} from "node:crypto";
import { PluginPolicyError } from "./errors.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set<object>());
}

function encodeCanonical(value: unknown, parents: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw canonicalError("规范化 JSON 不接受非有限数字");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw canonicalError("规范化 JSON 只接受 JSON 值");
  }
  if (parents.has(value)) {
    throw canonicalError("规范化 JSON 不接受循环引用");
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw canonicalError("规范化 JSON 不接受稀疏数组");
        }
        encoded.push(encodeCanonical(value[index], parents));
      }
      return `[${encoded.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw canonicalError("规范化 JSON 只接受普通对象");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      return `${JSON.stringify(key)}:${encodeCanonical(record[key], parents)}`;
    }).join(",")}}`;
  } finally {
    parents.delete(value);
  }
}

function canonicalError(message: string): PluginPolicyError {
  return new PluginPolicyError("CANONICAL_JSON_INVALID", message, "移除非 JSON 值后重试");
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (!BASE64URL.test(value)) {
    throw new PluginPolicyError(
      "MANIFEST_SIGNATURE_INVALID",
      `${label} 不是规范 Base64URL`,
      "重新获取签名元数据",
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new PluginPolicyError(
      "MANIFEST_SIGNATURE_INVALID",
      `${label} 编码不规范`,
      "重新获取签名元数据",
    );
  }
  return decoded;
}

export function detachedEd25519Sign(payload: Uint8Array, privateKey: KeyLike): string {
  return sign(null, payload, privateKey).toString("base64url");
}

export function detachedEd25519Verify(
  payload: Uint8Array,
  signature: string,
  publicKey: KeyLike,
): boolean {
  let decoded: Buffer;
  try {
    decoded = decodeCanonicalBase64Url(signature, "Ed25519 签名");
  } catch {
    return false;
  }
  return decoded.byteLength === 64 && verify(null, payload, publicKey, decoded);
}

export function signingPayload(domain: string, value: unknown): Buffer {
  return Buffer.concat([
    Buffer.from(`${domain}\0`, "utf8"),
    Buffer.from(canonicalJson(value), "utf8"),
  ]);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
