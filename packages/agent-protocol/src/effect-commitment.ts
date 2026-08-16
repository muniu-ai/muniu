// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import { canonicalJson } from "./canonical.js";
import { deepFreeze } from "./freeze.js";
import type { CandidateId, Digest, RunId, SessionId } from "./ids.js";
import type { JsonValue } from "./json.js";
import {
  createProtectedJsonViewV1,
  createProtectedTextV1,
  isProtectedJsonViewV1,
  isProtectedTextV1,
  type ProtectedJsonViewV1,
  type ProtectedTextV1
} from "./protection.js";
import {
  assertSafePublicControlIdV1,
  assertSafePublicControlStringV1,
  isSafePublicControlIdV1,
  isSafePublicControlStringV1
} from "./public-control.js";
import { assertBoundedProtocolText, snapshotBoundedJsonValue } from "./strict-json.js";

export type EffectRawInputV1 =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "json"; readonly value: JsonValue };

export interface EffectPolicyBindingV1 {
  readonly governanceDigest: Digest;
  readonly harnessDigest: Digest;
}

export interface EffectCommitmentBindingV1 {
  readonly effectKind: string;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly candidateId: CandidateId;
  readonly turn: number;
  readonly step: number;
  readonly internalEffectId: string;
  /** Exact protected view of `raw`; arbitrary caller-supplied digests are not accepted. */
  readonly protectedInput: ProtectedTextV1 | ProtectedJsonViewV1;
  readonly raw: EffectRawInputV1;
}

/**
 * A process-memory execution gate commitment. It is intentionally not a
 * restart-verifiable audit proof: the 256-bit HMAC key never leaves its binder.
 */
export interface EffectCommitmentV1 {
  readonly schemaVersion: 1;
  readonly scope: "runtime-gate";
  readonly algorithm: "HMAC-SHA-256";
  readonly keyId: string;
  readonly nonce: string;
  readonly tag: string;
  readonly rawKind: "text" | "json";
  readonly effectKind: string;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly candidateId: CandidateId;
  readonly turn: number;
  readonly step: number;
  readonly internalEffectId: string;
  readonly protectedInputDigest: Digest;
  readonly protectionPolicyDigest: Digest;
  /** Binder-keyed opaque policy binding; structural validation does not prove governance provenance. */
  readonly policyDigest: Digest;
}

/** Opaque, process-local capability. JSON serialization exposes only the safe commitment. */
export interface EffectCommitmentHandleV1 {
  readonly commitment: EffectCommitmentV1;
}

export interface RuntimeEffectCommitmentBinderV1 {
  readonly bind: (input: EffectCommitmentBindingV1) => EffectCommitmentHandleV1;
  readonly verifyAndConsume: (handle: EffectCommitmentHandleV1, candidate: EffectRawInputV1) => boolean;
  readonly release: (handle: EffectCommitmentHandleV1) => void;
  readonly dispose: () => void;
}

interface CanonicalRaw {
  readonly kind: "text" | "json";
  readonly bytes: Buffer;
}

interface ProtectedInputReceipt {
  readonly kind: "protected-text" | "protected-json-view";
  readonly digest: Digest;
  readonly policyDigest: Digest;
}

interface CommitmentState {
  readonly owner: object;
  readonly ownerHandles: Set<EffectCommitmentHandleV1>;
  readonly commitment: EffectCommitmentV1;
  consumed: boolean;
}

const COMMITMENT_KEYS = [
  "schemaVersion",
  "scope",
  "algorithm",
  "keyId",
  "nonce",
  "tag",
  "rawKind",
  "effectKind",
  "sessionId",
  "runId",
  "candidateId",
  "turn",
  "step",
  "internalEffectId",
  "protectedInputDigest",
  "protectionPolicyDigest",
  "policyDigest"
] as const;
const BINDING_KEYS = [
  "effectKind",
  "sessionId",
  "runId",
  "candidateId",
  "turn",
  "step",
  "internalEffectId",
  "protectedInput",
  "raw"
] as const;
const POLICY_BINDING_KEYS = ["governanceDigest", "harnessDigest"] as const;
const EFFECT_KIND_PATTERN = /^[a-z][a-z0-9.-]{0,63}(?:\/[a-z][a-z0-9.-]{0,63}){0,3}$/u;
const KEY_ID_PATTERN = /^kid_[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TAG_PATTERN = /^[0-9a-f]{64}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const handleStates = new WeakMap<object, CommitmentState>();

function createSafeKeyId(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `kid_${randomBytes(32).toString("hex")}`;
    if (isSafePublicControlStringV1(candidate, KEY_ID_PATTERN, 68)) return candidate;
  }
  throw new Error("unable to create a safe runtime effect commitment key identifier");
}

function exactDataRecord(value: unknown, exactKeys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new TypeError(`${label} must be an exact plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be an exact plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== exactKeys.length || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))) {
    throw new TypeError(`${label} must contain exactly the documented fields`);
  }
  const output: Record<string, unknown> = {};
  for (const key of exactKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property; accessors are rejected`);
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function validControlId(value: unknown): value is string {
  return isSafePublicControlIdV1(value);
}

function validEffectKind(value: unknown): value is string {
  return isSafePublicControlStringV1(value, EFFECT_KIND_PATTERN, 260);
}

function validKeyId(value: unknown): value is string {
  return isSafePublicControlStringV1(value, KEY_ID_PATTERN, 68);
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function snapshotPolicyBinding(value: unknown): EffectPolicyBindingV1 {
  const record = exactDataRecord(value, POLICY_BINDING_KEYS, "effect policy binding");
  if (!validDigest(record.governanceDigest) || !validDigest(record.harnessDigest)) {
    throw new TypeError("effect policy binding digests are invalid");
  }
  return {
    governanceDigest: record.governanceDigest,
    harnessDigest: record.harnessDigest
  };
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function snapshotRawInput(value: unknown): EffectRawInputV1 {
  const record = exactDataRecord(value, ["kind", "value"], "effect raw input");
  if (record.kind === "text") {
    assertBoundedProtocolText(record.value, "effect raw text");
    return { kind: "text", value: record.value };
  }
  if (record.kind === "json") {
    return { kind: "json", value: snapshotBoundedJsonValue(record.value) };
  }
  throw new TypeError("effect raw input kind must be text or json");
}

function snapshotProtectedInput(value: unknown): ProtectedInputReceipt {
  if (isProtectedTextV1(value)) {
    return { kind: value.kind, digest: value.digest, policyDigest: value.policyDigest };
  }
  if (isProtectedJsonViewV1(value)) {
    return { kind: value.kind, digest: value.digest, policyDigest: value.policyDigest };
  }
  throw new TypeError("effect commitment binding protectedInput must be an exact protected DTO");
}

function expectedProtectedInput(raw: EffectRawInputV1): ProtectedInputReceipt {
  const protectedInput = raw.kind === "text"
    ? createProtectedTextV1(raw.value)
    : createProtectedJsonViewV1(raw.value);
  return {
    kind: protectedInput.kind,
    digest: protectedInput.digest,
    policyDigest: protectedInput.policyDigest
  };
}

function snapshotBinding(value: unknown): {
  readonly effectKind: string;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly candidateId: CandidateId;
  readonly turn: number;
  readonly step: number;
  readonly internalEffectId: string;
  readonly protectedInputDigest: Digest;
  readonly protectionPolicyDigest: Digest;
  readonly raw: EffectRawInputV1;
} {
  const record = exactDataRecord(value, BINDING_KEYS, "effect commitment binding");
  assertSafePublicControlStringV1(
    record.effectKind,
    "effect commitment binding effectKind",
    EFFECT_KIND_PATTERN,
    260
  );
  assertSafePublicControlIdV1(record.sessionId, "effect commitment binding session identifier");
  assertSafePublicControlIdV1(record.runId, "effect commitment binding run identifier");
  assertSafePublicControlIdV1(record.candidateId, "effect commitment binding candidate identifier");
  if (!positiveSafeInteger(record.turn)) throw new TypeError("effect commitment binding turn must be a positive safe integer");
  if (!positiveSafeInteger(record.step)) throw new TypeError("effect commitment binding step must be a positive safe integer");
  assertSafePublicControlIdV1(record.internalEffectId, "effect commitment binding internal effect identifier");
  const raw = snapshotRawInput(record.raw);
  const protectedInput = snapshotProtectedInput(record.protectedInput);
  const expected = expectedProtectedInput(raw);
  if (protectedInput.kind !== expected.kind
    || protectedInput.digest !== expected.digest
    || protectedInput.policyDigest !== expected.policyDigest) {
    throw new TypeError("effect commitment binding protectedInput does not match raw");
  }
  return {
    effectKind: record.effectKind,
    sessionId: record.sessionId as SessionId,
    runId: record.runId as RunId,
    candidateId: record.candidateId as CandidateId,
    turn: record.turn,
    step: record.step,
    internalEffectId: record.internalEffectId,
    protectedInputDigest: protectedInput.digest,
    protectionPolicyDigest: protectedInput.policyDigest,
    raw
  };
}

function canonicalizeRaw(value: unknown): CanonicalRaw {
  const snapshot = snapshotRawInput(value);
  return snapshot.kind === "text"
    ? { kind: "text", bytes: Buffer.from(canonicalJson(snapshot.value), "utf8") }
    : { kind: "json", bytes: Buffer.from(canonicalJson(snapshot.value), "utf8") };
}

function hmacTag(key: Buffer, commitment: Omit<EffectCommitmentV1, "tag">, raw: CanonicalRaw): string {
  const domain: JsonValue = {
    schemaVersion: commitment.schemaVersion,
    scope: commitment.scope,
    algorithm: commitment.algorithm,
    keyId: commitment.keyId,
    nonce: commitment.nonce,
    rawKind: commitment.rawKind,
    effectKind: commitment.effectKind,
    sessionId: commitment.sessionId,
    runId: commitment.runId,
    candidateId: commitment.candidateId,
    turn: commitment.turn,
    step: commitment.step,
    internalEffectId: commitment.internalEffectId,
    protectedInputDigest: commitment.protectedInputDigest,
    protectionPolicyDigest: commitment.protectionPolicyDigest,
    policyDigest: commitment.policyDigest
  };
  const hmac = createHmac("sha256", key);
  hmac.update("muniu:runtime-effect-gate:v1\0", "utf8");
  hmac.update(canonicalJson(domain), "utf8");
  hmac.update("\0", "utf8");
  hmac.update(String(raw.bytes.byteLength), "utf8");
  hmac.update("\0", "utf8");
  hmac.update(raw.bytes);
  return hmac.digest("hex");
}

function opaquePolicyBindingDigest(
  key: Buffer,
  keyId: string,
  policyBinding: EffectPolicyBindingV1
): Digest {
  const canonical = Buffer.from(canonicalJson({
    schemaVersion: 1,
    scope: "runtime-gate",
    keyId,
    governanceDigest: policyBinding.governanceDigest,
    harnessDigest: policyBinding.harnessDigest
  }), "utf8");
  try {
    const hmac = createHmac("sha256", key);
    hmac.update("muniu:runtime-effect-policy-binding:v1\0", "utf8");
    hmac.update(canonical);
    return hmac.digest("hex") as Digest;
  } finally {
    canonical.fill(0);
  }
}

function canonicalNonce(value: unknown): value is string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === 16 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function commitmentRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    return exactDataRecord(value, COMMITMENT_KEYS, "EffectCommitmentV1");
  } catch {
    return undefined;
  }
}

/** Structural DTO check only; authenticity requires the issuing binder's opaque handle. */
export function isEffectCommitmentV1(value: unknown): value is EffectCommitmentV1 {
  const record = commitmentRecord(value);
  return record !== undefined
    && record.schemaVersion === 1
    && record.scope === "runtime-gate"
    && record.algorithm === "HMAC-SHA-256"
    && validKeyId(record.keyId)
    && canonicalNonce(record.nonce)
    && typeof record.tag === "string"
    && TAG_PATTERN.test(record.tag)
    && (record.rawKind === "text" || record.rawKind === "json")
    && validEffectKind(record.effectKind)
    && validControlId(record.sessionId)
    && validControlId(record.runId)
    && validControlId(record.candidateId)
    && positiveSafeInteger(record.turn)
    && positiveSafeInteger(record.step)
    && validControlId(record.internalEffectId)
    && validDigest(record.protectedInputDigest)
    && validDigest(record.protectionPolicyDigest)
    && validDigest(record.policyDigest);
}

/** Structural DTO assertion only; it does not provide restart or audit verification. */
export function assertEffectCommitmentV1(value: unknown): asserts value is EffectCommitmentV1 {
  if (!isEffectCommitmentV1(value)) throw new TypeError("value does not match EffectCommitmentV1");
  deepFreeze(value);
}

function consumeHandle(handle: unknown): CommitmentState | undefined {
  if (handle === null || typeof handle !== "object") return undefined;
  const state = handleStates.get(handle);
  if (state === undefined || state.consumed) return undefined;
  state.consumed = true;
  state.ownerHandles.delete(handle as EffectCommitmentHandleV1);
  handleStates.delete(handle);
  return state;
}

export function createRuntimeEffectCommitmentBinderV1(
  policyBinding: EffectPolicyBindingV1
): RuntimeEffectCommitmentBinderV1 {
  const fixedPolicyBinding = snapshotPolicyBinding(policyBinding);
  const key = randomBytes(32);
  let keyId: string;
  let fixedPolicyDigest: Digest;
  try {
    keyId = createSafeKeyId();
    fixedPolicyDigest = opaquePolicyBindingDigest(key, keyId, fixedPolicyBinding);
  } catch (error) {
    key.fill(0);
    throw error;
  }
  const owner = Object.freeze({});
  const activeHandles = new Set<EffectCommitmentHandleV1>();
  let disposed = false;

  const bind = (input: EffectCommitmentBindingV1): EffectCommitmentHandleV1 => {
    if (disposed) throw new Error("runtime effect commitment binder is disposed");
    const snapshot = snapshotBinding(input);
    const raw = canonicalizeRaw(snapshot.raw);
    try {
      const unsigned = {
        schemaVersion: 1 as const,
        scope: "runtime-gate" as const,
        algorithm: "HMAC-SHA-256" as const,
        keyId,
        nonce: randomBytes(16).toString("base64url"),
        rawKind: raw.kind,
        effectKind: snapshot.effectKind,
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        candidateId: snapshot.candidateId,
        turn: snapshot.turn,
        step: snapshot.step,
        internalEffectId: snapshot.internalEffectId,
        protectedInputDigest: snapshot.protectedInputDigest,
        protectionPolicyDigest: snapshot.protectionPolicyDigest,
        policyDigest: fixedPolicyDigest
      };
      const commitment = deepFreeze({ ...unsigned, tag: hmacTag(key, unsigned, raw) });
      const handle = deepFreeze({ commitment });
      const state: CommitmentState = {
        owner,
        ownerHandles: activeHandles,
        commitment,
        consumed: false
      };
      activeHandles.add(handle);
      handleStates.set(handle, state);
      return handle;
    } finally {
      raw.bytes.fill(0);
    }
  };

  const verifyAndConsume = (handle: EffectCommitmentHandleV1, candidate: EffectRawInputV1): boolean => {
    const state = consumeHandle(handle);
    if (state === undefined || disposed || state.owner !== owner) return false;
    let raw: CanonicalRaw | undefined;
    let actual: Buffer | undefined;
    let expected: Buffer | undefined;
    try {
      raw = canonicalizeRaw(candidate);
      if (raw.kind !== state.commitment.rawKind) return false;
      const { tag, ...unsigned } = state.commitment;
      actual = Buffer.from(hmacTag(key, unsigned, raw), "hex");
      expected = Buffer.from(tag, "hex");
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    } catch {
      return false;
    } finally {
      raw?.bytes.fill(0);
      actual?.fill(0);
      expected?.fill(0);
    }
  };

  const release = (handle: EffectCommitmentHandleV1): void => {
    consumeHandle(handle);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const handle of activeHandles) {
      const state = handleStates.get(handle);
      if (state !== undefined) state.consumed = true;
      handleStates.delete(handle);
    }
    activeHandles.clear();
    key.fill(0);
  };

  return Object.freeze({ bind, verifyAndConsume, release, dispose });
}
