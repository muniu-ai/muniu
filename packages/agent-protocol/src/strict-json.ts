// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import type { JsonValue } from "./json.js";

export const MAX_PROTOCOL_TEXT_CODE_UNITS = 1_048_576;
export const MAX_PROTOCOL_JSON_DEPTH = 64;
export const MAX_PROTOCOL_JSON_NODES = 100_000;
export const MAX_PROTOCOL_JSON_CODE_UNITS = 1_048_576;

interface JsonSnapshotState {
  codeUnits: number;
  nodes: number;
  readonly ancestors: Set<object>;
}

function addCodeUnits(state: JsonSnapshotState, count: number): void {
  state.codeUnits += count;
  if (state.codeUnits > MAX_PROTOCOL_JSON_CODE_UNITS) {
    throw new RangeError("JSON value exceeds the protocol size limit");
  }
}

function snapshotNode(value: unknown, state: JsonSnapshotState, depth: number): JsonValue {
  if (depth > MAX_PROTOCOL_JSON_DEPTH) {
    throw new RangeError("JSON value exceeds the protocol depth limit");
  }
  state.nodes += 1;
  if (state.nodes > MAX_PROTOCOL_JSON_NODES) {
    throw new RangeError("JSON value exceeds the protocol node limit");
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    addCodeUnits(state, value.length);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    if (Object.is(value, -0)) throw new TypeError("JSON numbers cannot contain negative zero");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError("lossless JSON integers must be safe integers");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`lossless JSON cannot contain ${typeof value}`);
  }
  if (utilTypes.isProxy(value)) throw new TypeError("lossless JSON cannot contain a Proxy");
  if (state.ancestors.has(value)) throw new TypeError("lossless JSON cannot contain a circular reference");

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("lossless JSON arrays must use the intrinsic Array prototype");
      }
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError("lossless JSON arrays must be dense and have no extra properties");
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("lossless JSON arrays must contain enumerable data properties and cannot be sparse");
        }
        output.push(snapshotNode(descriptor.value, state, depth + 1));
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("lossless JSON objects must be plain JSON objects");
    }
    const output: { [key: string]: JsonValue } = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("lossless JSON cannot contain symbol keys");
      addCodeUnits(state, key.length);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError("lossless JSON contains an unsafe object key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("lossless JSON objects must contain only enumerable data properties; accessors are rejected");
      }
      Object.defineProperty(output, key, {
        value: snapshotNode(descriptor.value, state, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

export function snapshotBoundedJsonValue(value: unknown): JsonValue {
  return snapshotNode(value, { codeUnits: 0, nodes: 0, ancestors: new Set<object>() }, 0);
}

export function assertBoundedProtocolText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.length > MAX_PROTOCOL_TEXT_CODE_UNITS) {
    throw new RangeError(`${label} exceeds the protocol size limit`);
  }
}
