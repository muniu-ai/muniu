// SPDX-License-Identifier: Apache-2.0

import { canonicalFrozenClone, isStrictTimestamp, sha256Digest } from "@mn/specs";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export { canonicalFrozenClone, sha256Digest };

export function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a printable identifier`);
  }
  return value;
}

export function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function requireTimestamp(value: unknown, field: string): string {
  if (!isStrictTimestamp(value)) throw new TypeError(`${field} must be strict RFC3339`);
  return value;
}

export function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

export function requireUniqueIdentifiers(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const result = value.map((item, index) => requireIdentifier(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} contains duplicates`);
  return Object.freeze(result);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
