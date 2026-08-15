import { createHash } from "node:crypto";
import type { SpecRevision } from "./types.js";

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON only supports finite numbers");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError("Canonical JSON does not support circular values");
  }
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON does not support sparse arrays");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("Canonical JSON does not support array accessors");
        }
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
          continue;
        }
        if (
          typeof key === "symbol" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length
        ) {
          throw new TypeError(
            "Canonical JSON arrays cannot contain symbol or named properties"
          );
        }
      }
      return `[${value
        .map((item) => serializeCanonical(item, ancestors))
        .join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only supports plain objects");
    }

    const record = value as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Canonical JSON does not support symbol keys");
    }
    const properties = (ownKeys as string[])
      .map((key) => {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new TypeError(`Canonical JSON forbids dangerous property ${key}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable) {
          throw new TypeError(
            `Canonical JSON does not support non-enumerable property ${key}`
          );
        }
        if (!("value" in descriptor)) {
          throw new TypeError(
            `Canonical JSON does not support accessor property ${key}`
          );
        }
        return [key, descriptor.value] as const;
      })
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
      .map(([key, property]) => {
        if (property === undefined) {
          throw new TypeError(
            `Canonical JSON does not support undefined at property ${key}`
          );
        }
        return `${JSON.stringify(key)}:${serializeCanonical(property, ancestors)}`;
      });
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>());
}

export function deepFreezeJsonValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (descriptor && "value" in descriptor) deepFreezeJsonValue(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

export function canonicalFrozenClone<T>(value: T): T {
  return deepFreezeJsonValue(JSON.parse(canonicalJson(value)) as T);
}

export function sha256Digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function digestSpecRevision(
  revision: SpecRevision | Omit<SpecRevision, "digest">
): string {
  const { digest: _digest, ...unsigned } = revision as SpecRevision;
  return sha256Digest(unsigned);
}
