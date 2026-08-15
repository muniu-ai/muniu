/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/session/src/json.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 */

/** Lossless-JSON validation and detached snapshots for durable session data. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function hasIntrinsicConstructor(prototype: object, name: "Array" | "Object"): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  const constructor: unknown = descriptor?.value;
  if (typeof constructor !== "function") return false;
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
  } catch {
    return false;
  }
}

function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}

function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
  const objectPrototype: unknown = Object.getPrototypeOf(prototype);
  return typeof objectPrototype === "object"
    && objectPrototype !== null
    && isIntrinsicObjectPrototype(objectPrototype);
}

function hasPlainObjectPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null
    || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
}

function enumerableStringKeys(value: object): string[] | undefined {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    return undefined;
  }
  return keys as string[];
}

type SnapshotDestination =
  | { kind: "root" }
  | { kind: "array"; target: JsonValue[]; index: number }
  | { kind: "object"; target: { [key: string]: JsonValue }; key: string };

type JsonWalkTask =
  | { kind: "visit"; value: unknown; destination?: SnapshotDestination }
  | { kind: "array-item"; source: unknown[]; index: number; target?: JsonValue[] }
  | { kind: "object-property"; source: Record<string, unknown>; key: string; target?: { [key: string]: JsonValue } }
  | { kind: "leave"; source: object };

function walkJsonValue(value: unknown, detach: boolean): JsonValue | true | undefined {
  const ancestors = new Set<object>();
  let root: JsonValue | undefined;
  const assign = (destination: SnapshotDestination | undefined, item: JsonValue): void => {
    if (destination === undefined) return;
    if (destination.kind === "root") {
      root = item;
    } else if (destination.kind === "array") {
      destination.target[destination.index] = item;
    } else {
      Object.defineProperty(destination.target, destination.key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  };

  const tasks: JsonWalkTask[] = [{
    kind: "visit",
    value,
    ...(detach ? { destination: { kind: "root" } as const } : {})
  }];
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === "leave") {
      ancestors.delete(task.source);
      continue;
    }
    if (task.kind === "array-item") {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return undefined;
      tasks.push({
        kind: "visit",
        value: task.source[task.index],
        ...(task.target === undefined ? {} : { destination: { kind: "array", target: task.target, index: task.index } as const })
      });
      continue;
    }
    if (task.kind === "object-property") {
      tasks.push({
        kind: "visit",
        value: task.source[task.key],
        ...(task.target === undefined ? {} : { destination: { kind: "object", target: task.target, key: task.key } as const })
      });
      continue;
    }

    const current = task.value;
    if (current === null) {
      assign(task.destination, null);
      continue;
    }
    if (typeof current === "boolean" || typeof current === "string") {
      assign(task.destination, current);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) return undefined;
      assign(task.destination, current);
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (ancestors.has(current)) return undefined;

    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) return undefined;
      const length = current.length;
      if (Reflect.ownKeys(current).length !== length + 1) return undefined;
      const target = detach ? [] as JsonValue[] : undefined;
      if (target !== undefined) assign(task.destination, target);
      ancestors.add(current);
      tasks.push({ kind: "leave", source: current });
      for (let index = length - 1; index >= 0; index -= 1) {
        tasks.push({ kind: "array-item", source: current, index, ...(target === undefined ? {} : { target }) });
      }
      continue;
    }

    if (!hasPlainObjectPrototype(current)) return undefined;
    const keys = enumerableStringKeys(current);
    if (keys === undefined) return undefined;
    const target = detach ? {} as { [key: string]: JsonValue } : undefined;
    if (target !== undefined) assign(task.destination, target);
    ancestors.add(current);
    tasks.push({ kind: "leave", source: current });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) return undefined;
      tasks.push({ kind: "object-property", source: current as Record<string, unknown>, key, ...(target === undefined ? {} : { target }) });
    }
  }
  return detach ? root : true;
}

export function snapshotJsonValue<T>(value: T): T | undefined {
  return walkJsonValue(value, true) as T | undefined;
}

export function isJsonValue(value: unknown): boolean {
  return walkJsonValue(value, false) === true;
}
