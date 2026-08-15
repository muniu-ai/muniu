import { createHash } from "node:crypto";

const OBJECT_TAG = "[object Object]";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertDataShape(value: object, path: string): PropertyDescriptorMap {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must not contain symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new TypeError(`${path}.${key} is unsafe`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
  }
  return descriptors;
}

function normalize(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must be a safe integer`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError(`${path} contains a non-canonical value`);
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`${path} must not contain symbol keys`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== value.length) throw new TypeError(`${path} must be dense`);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${path} must be dense`);
        }
        result.push(normalize(descriptor.value, `${path}[${index}]`, seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      Object.prototype.toString.call(value) !== OBJECT_TAG ||
      (prototype !== Object.prototype && prototype !== null)
    ) {
      throw new TypeError(`${path} must be a plain object`);
    }
    const descriptors = assertDataShape(value, path);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(descriptors).sort(compareCodeUnits)) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
        throw new TypeError(`${path}.${key} must be defined`);
      }
      result[key] = normalize(descriptor.value, `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$", new Set<object>()));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(cloneCanonical(value));
}

export function assertExactObject(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  path: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const descriptors = assertDataShape(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) throw new TypeError(`${path}.${key} is not allowed`);
  }
  for (const key of requiredKeys) {
    if (!(key in descriptors)) throw new TypeError(`${path}.${key} is required`);
  }
}

export function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}

export function optionalOwnValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}
