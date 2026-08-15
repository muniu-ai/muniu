import { createHash } from "node:crypto";
import { canonicalJson, isStrictTimestamp } from "@mn/specs";

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function declarativeClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a non-empty printable identifier`);
  }
  return value;
}

export function requireTimestamp(value: unknown, field: string): string {
  if (!isStrictTimestamp(value)) throw new TypeError(`${field} must be strict RFC3339`);
  return value;
}

export function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function requirePositiveRevision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

export function exactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  path: string
): void {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`${path}.${field} is unsupported`);
  }
}

export function uniqueIdentifiers(values: unknown, field: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  const result = values.map((value, index) =>
    requireIdentifier(value, `${field}[${index}]`)
  );
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${field} must not contain duplicates`);
  }
  return result.sort(compareCodeUnits);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
