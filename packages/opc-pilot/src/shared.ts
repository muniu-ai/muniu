// SPDX-License-Identifier: Apache-2.0

import { canonicalFrozenClone, canonicalJson, isStrictTimestamp, type SpecJsonValue } from "@mn/specs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export { canonicalFrozenClone };

export function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return value;
}

export function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function timestamp(value: unknown, field: string): string {
  if (!isStrictTimestamp(value)) throw new TypeError(`${field} must be strict RFC3339`);
  return value;
}

export function text(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

export function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${field} must be a safe integer of at least ${minimum}`);
  }
  return Number(value);
}

export function identifiers(value: unknown, field: string, minimum = 0): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new TypeError(`${field} must contain at least ${minimum} item(s)`);
  }
  const result = value.map((item, index) => identifier(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} contains duplicates`);
  return Object.freeze(result);
}

export function exactRecord(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = []
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.some((key) => typeof key === "symbol") ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    ownKeys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TypeError(`${field} has missing or unsupported fields`);
  }
  return record;
}

export function jsonValue(value: unknown, field: string): SpecJsonValue {
  try {
    const serialized = canonicalJson(value);
    if (Buffer.byteLength(serialized, "utf8") > 65_536) {
      throw new TypeError(`${field} exceeds the 64 KiB business-field limit`);
    }
    return canonicalFrozenClone(value) as SpecJsonValue;
  } catch (error) {
    throw new TypeError(`${field} must be canonical JSON`, { cause: error });
  }
}
