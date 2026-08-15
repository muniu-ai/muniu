// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import {
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER,
  PRIVATE_KEY_MARKER,
  UNSAFE_MARKER,
  protectJsonValue,
  protectText,
  type ProtectedJsonValue
} from "@mn/data-policy";

import { digestJson } from "./canonical.js";
import { deepFreeze } from "./freeze.js";
import { Digest, type Digest as DigestValue } from "./ids.js";
import type { JsonValue } from "./json.js";
import {
  MAX_PROTOCOL_JSON_CODE_UNITS,
  MAX_PROTOCOL_JSON_DEPTH,
  MAX_PROTOCOL_JSON_NODES,
  MAX_PROTOCOL_TEXT_CODE_UNITS,
  snapshotBoundedJsonValue
} from "./strict-json.js";

export const PROTECTION_POLICY_DIGEST_V1 = Digest(digestJson({
  businessData: ["phone", "prc-resident-identity"],
  credentials: "always-protected",
  policy: "muniu-protected-dto-v1"
}));

export interface ProtectedTextV1 {
  readonly schemaVersion: 1;
  readonly kind: "protected-text";
  readonly text: string;
  readonly policyDigest: DigestValue;
  readonly digest: DigestValue;
}

export interface ProtectedJsonEntryV1 {
  readonly key: ProtectedTextV1;
  readonly value: ProtectedJsonNodeV1;
}

export type ProtectedJsonNodeV1 =
  | { readonly type: "null" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "string"; readonly value: ProtectedTextV1 }
  | { readonly type: "array"; readonly items: readonly ProtectedJsonNodeV1[] }
  | { readonly type: "object"; readonly entries: readonly ProtectedJsonEntryV1[] };

export interface ProtectedJsonViewV1 {
  readonly schemaVersion: 1;
  readonly kind: "protected-json-view";
  readonly root: ProtectedJsonNodeV1;
  readonly policyDigest: DigestValue;
  readonly digest: DigestValue;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PROTECTED_KEY_MARKERS = new Set([
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER,
  PRIVATE_KEY_MARKER,
  UNSAFE_MARKER
]);

interface ViewValidationState {
  codeUnits: number;
  nodes: number;
}

function ownDataRecord(value: unknown, exactKeys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== exactKeys.length || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const key of exactKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function buildProtectedText(text: string): ProtectedTextV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "protected-text" as const,
    text,
    policyDigest: PROTECTION_POLICY_DIGEST_V1
  };
  return deepFreeze({ ...envelope, digest: digestJson(envelope) });
}

export function createProtectedTextV1(value: string): ProtectedTextV1 {
  if (typeof value !== "string") throw new TypeError("ProtectedTextV1 input must be a string");
  return buildProtectedText(protectText(value));
}

function validateProtectedText(value: unknown, state?: ViewValidationState): value is ProtectedTextV1 {
  const record = ownDataRecord(value, ["schemaVersion", "kind", "text", "policyDigest", "digest"]);
  if (record === undefined
    || record.schemaVersion !== 1
    || record.kind !== "protected-text"
    || typeof record.text !== "string"
    || record.text.length > MAX_PROTOCOL_TEXT_CODE_UNITS
    || record.policyDigest !== PROTECTION_POLICY_DIGEST_V1
    || typeof record.digest !== "string"
    || !DIGEST_PATTERN.test(record.digest)) return false;
  if (state !== undefined) {
    state.codeUnits += record.text.length;
    if (state.codeUnits > MAX_PROTOCOL_JSON_CODE_UNITS) return false;
  }
  try {
    if (protectText(record.text) !== record.text) return false;
    const { digest: _digest, ...envelope } = record;
    return digestJson(envelope) === record.digest;
  } catch {
    return false;
  }
}

export function isProtectedTextV1(value: unknown): value is ProtectedTextV1 {
  return validateProtectedText(value);
}

export function assertProtectedTextV1(value: unknown): asserts value is ProtectedTextV1 {
  if (!validateProtectedText(value)) throw new TypeError("value does not match ProtectedTextV1");
  deepFreeze(value);
}

function scalarProbe(value: JsonValue): ProtectedJsonValue {
  if (Array.isArray(value)) return [];
  if (value !== null && typeof value === "object") return {};
  return value;
}

function propertyRequiresCredentialMarker(key: string, value: JsonValue): boolean {
  const probe: Record<string, ProtectedJsonValue> = {};
  Object.defineProperty(probe, key, {
    value: scalarProbe(value),
    enumerable: true,
    configurable: true,
    writable: true
  });
  const protectedProbe = protectJsonValue(probe);
  return protectedProbe !== null
    && typeof protectedProbe === "object"
    && !Array.isArray(protectedProbe)
    && protectedProbe[key] === CREDENTIAL_MARKER;
}

function protectedStringNode(value: string): ProtectedJsonNodeV1 {
  return { type: "string", value: buildProtectedText(protectText(value)) };
}

function buildProtectedNode(value: JsonValue): ProtectedJsonNodeV1 {
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return protectedStringNode(value);
  if (typeof value === "number") {
    const protectedValue = protectJsonValue(value);
    return typeof protectedValue === "string"
      ? protectedStringNode(protectedValue)
      : { type: "number", value };
  }
  if (Array.isArray(value)) {
    return { type: "array", items: value.map((item) => buildProtectedNode(item)) };
  }
  const entries: ProtectedJsonEntryV1[] = [];
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) throw new TypeError("lossless JSON object is missing an own value");
    entries.push({
      key: buildProtectedText(protectText(key)),
      value: propertyRequiresCredentialMarker(key, child)
        ? protectedStringNode(CREDENTIAL_MARKER)
        : buildProtectedNode(child)
    });
  }
  return { type: "object", entries };
}

export function createProtectedJsonViewV1(value: unknown): ProtectedJsonViewV1 {
  const snapshot = snapshotBoundedJsonValue(value);
  const root = buildProtectedNode(snapshot);
  const envelope = {
    schemaVersion: 1 as const,
    kind: "protected-json-view" as const,
    root,
    policyDigest: PROTECTION_POLICY_DIGEST_V1
  };
  const view = { ...envelope, digest: digestJson(envelope) };
  if (!isProtectedJsonViewV1(view)) {
    throw new RangeError("protected JSON view exceeds its assertion size limit");
  }
  return deepFreeze(view);
}

function validateArray(value: unknown): value is readonly unknown[] {
  if (value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function validateProtectedNode(value: unknown, state: ViewValidationState, depth: number): value is ProtectedJsonNodeV1 {
  if (depth > MAX_PROTOCOL_JSON_DEPTH) return false;
  state.nodes += 1;
  if (state.nodes > MAX_PROTOCOL_JSON_NODES) return false;

  const typeRecord = ownDataRecord(value, ["type"]);
  if (typeRecord !== undefined) return typeRecord.type === "null";

  const scalarRecord = ownDataRecord(value, ["type", "value"]);
  if (scalarRecord !== undefined) {
    if (scalarRecord.type === "boolean") return typeof scalarRecord.value === "boolean";
    if (scalarRecord.type === "number") {
      const number = scalarRecord.value;
      const validNumber = typeof number === "number"
        && Number.isFinite(number)
        && !Object.is(number, -0)
        && (!Number.isInteger(number) || Number.isSafeInteger(number));
      if (!validNumber) return false;
      try {
        return protectJsonValue(number) === number;
      } catch {
        return false;
      }
    }
    return scalarRecord.type === "string" && validateProtectedText(scalarRecord.value, state);
  }

  const arrayRecord = ownDataRecord(value, ["type", "items"]);
  if (arrayRecord !== undefined && arrayRecord.type === "array" && validateArray(arrayRecord.items)) {
    return arrayRecord.items.every((item) => validateProtectedNode(item, state, depth + 1));
  }

  const objectRecord = ownDataRecord(value, ["type", "entries"]);
  if (objectRecord === undefined || objectRecord.type !== "object" || !validateArray(objectRecord.entries)) return false;
  let previousOrdinaryKey: string | undefined;
  for (const entry of objectRecord.entries) {
    const entryRecord = ownDataRecord(entry, ["key", "value"]);
    if (entryRecord === undefined
      || !validateProtectedText(entryRecord.key, state)
      || !validateProtectedNode(entryRecord.value, state, depth + 1)) return false;
    const key = entryRecord.key;
    const child = entryRecord.value;
    if (!PROTECTED_KEY_MARKERS.has(key.text)) {
      if (previousOrdinaryKey !== undefined && key.text <= previousOrdinaryKey) return false;
      previousOrdinaryKey = key.text;
    }
    if (propertyRequiresCredentialMarker(key.text, protectedNodeProbe(child))
      && !isCredentialMarkerNode(child)) return false;
  }
  return true;
}

function protectedNodeProbe(value: ProtectedJsonNodeV1): JsonValue {
  if (value.type === "null") return null;
  if (value.type === "boolean" || value.type === "number") return value.value;
  if (value.type === "string") return value.value.text;
  return value.type === "array" ? [] : {};
}

function isCredentialMarkerNode(value: ProtectedJsonNodeV1): boolean {
  return value.type === "string" && value.value.text === CREDENTIAL_MARKER;
}

export function isProtectedJsonViewV1(value: unknown): value is ProtectedJsonViewV1 {
  const record = ownDataRecord(value, ["schemaVersion", "kind", "root", "policyDigest", "digest"]);
  if (record === undefined
    || record.schemaVersion !== 1
    || record.kind !== "protected-json-view"
    || record.policyDigest !== PROTECTION_POLICY_DIGEST_V1
    || typeof record.digest !== "string"
    || !DIGEST_PATTERN.test(record.digest)) return false;
  const state: ViewValidationState = { codeUnits: 0, nodes: 0 };
  try {
    if (!validateProtectedNode(record.root, state, 0)) return false;
    const { digest: _digest, ...envelope } = record;
    return digestJson(envelope) === record.digest;
  } catch {
    return false;
  }
}

export function assertProtectedJsonViewV1(value: unknown): asserts value is ProtectedJsonViewV1 {
  if (!isProtectedJsonViewV1(value)) throw new TypeError("value does not match ProtectedJsonViewV1");
  deepFreeze(value);
}
