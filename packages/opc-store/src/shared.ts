// SPDX-License-Identifier: Apache-2.0

import {
  canonicalFrozenClone,
  isStrictTimestamp,
  sha256Digest,
  type SpecJsonValue
} from "@mn/specs";

import type { OpcAggregateKind, OpcAppendInput, OpcStoredEntry } from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const AGGREGATE_KINDS = new Set<OpcAggregateKind>([
  "record",
  "operation_run",
  "operation_event",
  "attention_item",
  "action_intent",
  "authority_decision",
  "effect_receipt",
  "settlement_record",
  "publication_outbox",
  "publication_receipt",
  "business_pack_binding"
]);

export function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return value;
}

export function aggregateKind(value: unknown): OpcAggregateKind {
  if (!AGGREGATE_KINDS.has(value as OpcAggregateKind)) {
    throw new TypeError("kind must be a supported OPC aggregate");
  }
  return value as OpcAggregateKind;
}

export function timestamp(value: unknown, field: string): string {
  if (!isStrictTimestamp(value)) throw new TypeError(`${field} must be strict RFC3339`);
  return value;
}

export function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer");
  }
  return Number(value);
}

export function normalizeAppendInput<T extends SpecJsonValue>(input: OpcAppendInput<T>): OpcAppendInput<T> {
  return canonicalFrozenClone({
    tenantId: identifier(input.tenantId, "tenantId"),
    kind: aggregateKind(input.kind),
    id: identifier(input.id, "id"),
    expectedRevision: expectedRevision(input.expectedRevision),
    requestId: identifier(input.requestId, "requestId"),
    value: input.value,
    createdAt: timestamp(input.createdAt, "createdAt")
  });
}

export function normalizeAppendBatch(
  values: readonly OpcAppendInput[]
): readonly OpcAppendInput[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 256) {
    throw new TypeError("append batch must contain between 1 and 256 entries");
  }
  const inputs = values.map(normalizeAppendInput);
  const tenantId = inputs[0]!.tenantId;
  if (inputs.some((input) => input.tenantId !== tenantId)) {
    throw new TypeError("append batch must belong to one tenant");
  }
  if (new Set(inputs.map((input) => input.requestId)).size !== inputs.length) {
    throw new TypeError("append batch requestId values must be unique");
  }
  return Object.freeze(inputs);
}

export function requestDigest(input: OpcAppendInput): string {
  return sha256Digest(input);
}

export function createEntry<T extends SpecJsonValue>(
  input: OpcAppendInput<T>,
  revision: number,
  previous?: OpcStoredEntry
): OpcStoredEntry<T> {
  const value = canonicalFrozenClone(input.value);
  const unsigned = {
    schemaVersion: 1 as const,
    tenantId: input.tenantId,
    kind: input.kind,
    id: input.id,
    revision,
    requestId: input.requestId,
    value,
    valueDigest: sha256Digest(value),
    ...(previous === undefined ? {} : { previousDigest: previous.digest }),
    createdAt: input.createdAt
  };
  return canonicalFrozenClone({ ...unsigned, digest: sha256Digest(unsigned) });
}

export function entryKey(tenantId: string, kind: string, id: string): string {
  return JSON.stringify([tenantId, kind, id]);
}

export function requestKey(tenantId: string, requestId: string): string {
  return JSON.stringify([tenantId, requestId]);
}
