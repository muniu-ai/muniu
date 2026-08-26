// SPDX-License-Identifier: Apache-2.0

import type { SpecJsonValue } from "@mn/specs";

import type { BusinessRecordEnvelopeV1, BusinessRecordStatusV1 } from "./types.js";
import {
  canonicalFrozenClone,
  requireIdentifier,
  requireTimestamp,
  sha256Digest
} from "./shared.js";

const STATUSES = new Set<BusinessRecordStatusV1>(["proposed", "verified", "superseded", "void"]);

export interface CreateBusinessRecordInput<T extends SpecJsonValue> {
  readonly tenantId: string;
  readonly kind: string;
  readonly id: string;
  readonly status: BusinessRecordStatusV1;
  readonly payload: T;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ReviseBusinessRecordInput<T extends SpecJsonValue> {
  readonly status: BusinessRecordStatusV1;
  readonly payload: T;
  readonly createdAt: string;
  readonly createdBy: string;
}

function unsignedRecord<T extends SpecJsonValue>(record: BusinessRecordEnvelopeV1<T>): Omit<BusinessRecordEnvelopeV1<T>, "digest"> {
  const { digest: _digest, ...unsigned } = record;
  return unsigned;
}

export function verifyBusinessRecord(record: BusinessRecordEnvelopeV1): boolean {
  return sha256Digest(record.payload) === record.payloadDigest
    && sha256Digest(unsignedRecord(record)) === record.digest;
}

function buildRecord<T extends SpecJsonValue>(input: {
  tenantId: string;
  kind: string;
  id: string;
  revision: number;
  status: BusinessRecordStatusV1;
  payload: T;
  previousDigest?: string;
  createdAt: string;
  createdBy: string;
}): BusinessRecordEnvelopeV1<T> {
  if (!STATUSES.has(input.status)) throw new TypeError("business record status is invalid");
  const payload = canonicalFrozenClone(input.payload);
  const unsigned = {
    schemaVersion: 1 as const,
    tenantId: requireIdentifier(input.tenantId, "tenantId"),
    domainId: "opc" as const,
    kind: requireIdentifier(input.kind, "kind"),
    id: requireIdentifier(input.id, "id"),
    revision: input.revision,
    status: input.status,
    payload,
    payloadDigest: sha256Digest(payload),
    ...(input.previousDigest === undefined ? {} : { previousDigest: input.previousDigest }),
    createdAt: requireTimestamp(input.createdAt, "createdAt"),
    createdBy: requireIdentifier(input.createdBy, "createdBy")
  };
  return canonicalFrozenClone({ ...unsigned, digest: sha256Digest(unsigned) });
}

export function createBusinessRecord<T extends SpecJsonValue>(
  input: CreateBusinessRecordInput<T>
): BusinessRecordEnvelopeV1<T> {
  return buildRecord({ ...input, revision: 1 });
}

export function reviseBusinessRecord<T extends SpecJsonValue>(
  previous: BusinessRecordEnvelopeV1,
  input: ReviseBusinessRecordInput<T>
): BusinessRecordEnvelopeV1<T> {
  if (!verifyBusinessRecord(previous)) throw new Error("previous business record digest is invalid");
  if (previous.revision >= Number.MAX_SAFE_INTEGER) throw new RangeError("business record revision cannot overflow");
  if (Date.parse(input.createdAt) < Date.parse(previous.createdAt)) {
    throw new TypeError("business record revision cannot precede its predecessor");
  }
  return buildRecord({
    tenantId: previous.tenantId,
    kind: previous.kind,
    id: previous.id,
    revision: previous.revision + 1,
    status: input.status,
    payload: input.payload,
    previousDigest: previous.digest,
    createdAt: input.createdAt,
    createdBy: input.createdBy
  });
}
