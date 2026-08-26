// SPDX-License-Identifier: Apache-2.0

import type { SpecJsonValue } from "@mn/specs";

import type { BusinessRecordEnvelopeV1, PublicationEnvelopeV1 } from "./types.js";
import { verifyBusinessRecord } from "./records.js";
import {
  canonicalFrozenClone,
  requireIdentifier,
  requireStrings,
  requireText,
  requireTimestamp
} from "./shared.js";

export interface CreatePublicationEnvelopeInput {
  readonly id: string;
  readonly targetTenantId: string;
  readonly purpose: string;
  readonly allowedFields: readonly string[];
  readonly retentionUntil: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export function createPublicationEnvelope(
  source: BusinessRecordEnvelopeV1,
  input: CreatePublicationEnvelopeInput
): PublicationEnvelopeV1 {
  if (!verifyBusinessRecord(source)) throw new Error("source business record digest is invalid");
  if (source.payload === null || typeof source.payload !== "object" || Array.isArray(source.payload)) {
    throw new TypeError("publication source payload must be a record");
  }
  const fields = requireStrings(input.allowedFields, "allowedFields", 1, true);
  const sourcePayload = source.payload as Readonly<Record<string, SpecJsonValue>>;
  const publishedPayload: Record<string, SpecJsonValue> = {};
  for (const field of fields) {
    if (!Object.hasOwn(sourcePayload, field)) throw new TypeError(`allowed field is absent from source: ${field}`);
    publishedPayload[field] = sourcePayload[field]!;
  }
  const createdAt = requireTimestamp(input.createdAt, "createdAt");
  const retentionUntil = requireTimestamp(input.retentionUntil, "retentionUntil");
  if (Date.parse(retentionUntil) <= Date.parse(createdAt)) {
    throw new TypeError("retentionUntil must be after createdAt");
  }
  return canonicalFrozenClone({
    schemaVersion: 1,
    id: requireIdentifier(input.id, "id"),
    sourceTenantId: source.tenantId,
    targetTenantId: requireIdentifier(input.targetTenantId, "targetTenantId"),
    sourceRecordRef: `${source.kind}:${source.id}:${source.revision}`,
    sourceDigest: source.digest,
    purpose: requireText(input.purpose, "purpose"),
    allowedFields: fields,
    publishedPayload,
    retentionUntil,
    idempotencyKey: requireIdentifier(input.idempotencyKey, "idempotencyKey"),
    createdAt,
    createdBy: requireIdentifier(input.createdBy, "createdBy")
  });
}
