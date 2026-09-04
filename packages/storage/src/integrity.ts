// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { JsonValue, KernelEventV1 } from "@mn/contracts";

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (typeof value === "object") {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      normalized[key] = normalize(entry);
    }
    return normalized;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function computeEventDigest(event: Omit<KernelEventV1, "digest" | "hmac"> | KernelEventV1): string {
  const { digest: _digest, hmac: _hmac, ...unsigned } = event as KernelEventV1;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

export function computeEventHmac(digest: string, key: Uint8Array): string {
  if (key.byteLength < 32) throw new TypeError("Event HMAC key must contain at least 32 bytes");
  return createHmac("sha256", key).update(digest).digest("hex");
}

export function verifyEventIntegrity(event: KernelEventV1, key: Uint8Array): boolean {
  const digest = computeEventDigest(event);
  if (digest !== event.digest) return false;
  const expected = Buffer.from(computeEventHmac(event.digest, key), "hex");
  const actual = Buffer.from(event.hmac, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
