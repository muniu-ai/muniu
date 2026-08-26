// SPDX-License-Identifier: Apache-2.0

import type { SpecJsonValue } from "@mn/specs";

export interface MoneyV1 {
  readonly currency: string;
  readonly minorUnits: string;
}

export type BusinessRecordStatusV1 = "proposed" | "verified" | "superseded" | "void";

export interface BusinessRecordEnvelopeV1<T extends SpecJsonValue = SpecJsonValue> {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly domainId: "opc";
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  readonly status: BusinessRecordStatusV1;
  readonly payload: T;
  readonly payloadDigest: string;
  readonly previousDigest?: string;
  readonly digest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface CustomerCommitmentV1 {
  readonly schemaVersion: 1;
  readonly accountRef: string;
  readonly promisedOutcome: string;
  readonly scope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly price: MoneyV1;
  readonly dueAt: string;
  readonly dataAuthorizationRefs: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly customerResponsibilities: readonly string[];
  readonly providerResponsibilities: readonly string[];
  readonly approverRefs: readonly string[];
}

export interface SettlementRecordV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly commitmentRef: string;
  readonly contracted?: MoneyV1;
  readonly invoiced?: MoneyV1;
  readonly received?: MoneyV1;
  readonly modelCost?: MoneyV1;
  readonly externalCost?: MoneyV1;
  readonly humanMinutes: number;
  readonly sourceRefs: readonly string[];
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface PublicationEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceTenantId: string;
  readonly targetTenantId: string;
  readonly sourceRecordRef: string;
  readonly sourceDigest: string;
  readonly purpose: string;
  readonly allowedFields: readonly string[];
  readonly publishedPayload: Readonly<Record<string, SpecJsonValue>>;
  readonly retentionUntil: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface BusinessPackTransitionV1 {
  readonly from: string;
  readonly to: string;
}

export interface BusinessPackManifestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly domainId: string;
  readonly recordSchemas: readonly string[];
  readonly states: readonly string[];
  readonly transitions: readonly BusinessPackTransitionV1[];
  readonly workflows: readonly string[];
  readonly gates: readonly string[];
  readonly approvalTemplates: readonly string[];
  readonly connectors: readonly string[];
  readonly renderers: readonly string[];
  readonly externalEffects: readonly string[];
  readonly acceptanceCases: readonly string[];
}

export interface BusinessPackRegistryV1 {
  readonly recordSchemas: readonly string[];
  readonly workflows: readonly string[];
  readonly gates: readonly string[];
  readonly connectors: readonly string[];
  readonly renderers: readonly string[];
  readonly externalEffects: readonly string[];
}

export type VisitStateV1 =
  | "draft"
  | "prepared"
  | "in_progress"
  | "processing"
  | "review_required"
  | "confirmed"
  | "writeback_pending"
  | "completed"
  | "failed"
  | "cancelled";
