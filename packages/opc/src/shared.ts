// SPDX-License-Identifier: Apache-2.0

import { canonicalFrozenClone, isStrictTimestamp, sha256Digest } from "@mn/specs";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export { canonicalFrozenClone, sha256Digest };

export function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a printable identifier`);
  }
  return value;
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
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

export function requireStrings(
  value: unknown,
  field: string,
  minimum: number,
  identifiers = false
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new TypeError(`${field} must contain at least ${minimum} item(s)`);
  }
  const result = value.map((item, index) => identifiers
    ? requireIdentifier(item, `${field}[${index}]`)
    : requireText(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} contains duplicates`);
  return Object.freeze(result);
}
