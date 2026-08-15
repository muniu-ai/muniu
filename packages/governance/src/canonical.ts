import { createHash } from "node:crypto";

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCanonicalValue(
  value: unknown,
  path: string,
  ancestors: Set<object>
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Canonical JSON ${path} must be a finite number`);
    }
    return value;
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new TypeError(
      `Canonical JSON ${path} cannot contain ${typeof value}`
    );
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON ${path} contains an unsupported value`);
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError(`Canonical JSON ${path} must contain only plain objects`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`Canonical JSON ${path} contains a circular reference`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === "symbol")) {
        throw new TypeError(`Canonical JSON ${path} cannot contain symbol keys`);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new TypeError(`Canonical JSON ${path} has an invalid array length`);
      }
      for (const key of keys as string[]) {
        if (key === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
          throw new TypeError(
            `Canonical JSON ${path}.${key} is not a supported array index`
          );
        }
      }
      const normalized: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          throw new TypeError(`Canonical JSON ${path}[${index}] cannot be sparse`);
        }
        if (!("value" in descriptor)) {
          throw new TypeError(
            `Canonical JSON ${path}[${index}] cannot be an accessor`
          );
        }
        if (!descriptor.enumerable) {
          throw new TypeError(
            `Canonical JSON ${path}[${index}] must be enumerable`
          );
        }
        normalized.push(
          normalizeCanonicalValue(
            descriptor.value,
            `${path}[${index}]`,
            ancestors
          )
        );
      }
      return normalized;
    }

    const normalized: Record<string, unknown> = {};
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new TypeError(`Canonical JSON ${path} cannot contain symbol keys`);
    }
    for (const key of (keys as string[]).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`Canonical JSON ${path}.${key} is unsafe`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`Canonical JSON ${path}.${key} cannot be an accessor`);
      }
      if (!descriptor.enumerable) {
        throw new TypeError(`Canonical JSON ${path}.${key} must be enumerable`);
      }
      normalized[key] = normalizeCanonicalValue(
        descriptor.value,
        `${path}.${key}`,
        ancestors
      );
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value, "$", new Set()));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}
