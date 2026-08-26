// SPDX-License-Identifier: Apache-2.0

import type { BusinessRecordEnvelopeV1, PublicationEnvelopeV1, VisitStateV1 } from "@mn/opc";
import type {
  ActionIntentV1,
  AttentionItemV1,
  ConsequenceTierV1,
  ActionReversibilityV1
} from "@mn/operations";
import type { SpecJsonValue } from "@mn/specs";

export interface TenantObjectRefV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly objectId: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly storage: "tenant_cas" | "tenant_s3";
  readonly encryption: "aes-256-gcm" | "tenant-envelope";
}

export interface VisitFragmentLocatorV1 {
  readonly startMs?: number;
  readonly endMs?: number;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

export interface VisitSourceFragmentV1 {
  readonly id: string;
  readonly sourceObjectId: string;
  readonly locator: VisitFragmentLocatorV1;
  readonly contentDigest: string;
}

export type VisitFindingCategoryV1 = "fact" | "inference" | "next_action" | "commitment";
export type VisitFindingStatusV1 = "proposed" | "verified" | "rejected";
export type VisitAuthorityKindV1 = "human" | "connector";

export interface VisitFindingAuthorityV1 {
  readonly kind: VisitAuthorityKindV1;
  readonly id: string;
  readonly evidenceRef: string;
}

export interface VisitFindingV1 {
  readonly id: string;
  readonly category: VisitFindingCategoryV1;
  readonly field: string;
  readonly value: SpecJsonValue;
  readonly sourceFragmentRefs: readonly string[];
  readonly proposedBy: { readonly kind: "model" | "human" | "connector"; readonly id: string };
  readonly proposedAt: string;
  readonly status: VisitFindingStatusV1;
  readonly verifiedBy?: VisitFindingAuthorityV1;
  readonly verifiedAt?: string;
  readonly rejectedBy?: VisitFindingAuthorityV1;
  readonly rejectedAt?: string;
}

export interface VisitRecordPayloadV1 {
  readonly schemaVersion: 1;
  readonly state: VisitStateV1;
  readonly accountRef: string;
  readonly sourceObjects: readonly TenantObjectRefV1[];
  readonly fragments: readonly VisitSourceFragmentV1[];
  readonly findings: readonly VisitFindingV1[];
}

export type VisitRecordV1 = Omit<BusinessRecordEnvelopeV1, "kind" | "payload"> & {
  readonly kind: "visit";
  readonly payload: VisitRecordPayloadV1;
};

export interface VisitWritebackEffectInputV1 {
  readonly id: string;
  readonly effectId:
    | "dingtalk.todo.create"
    | "crm.record.write"
    | "external.message.send"
    | "external.record.delete";
  readonly targetRef: string;
  readonly protectedInputDigest: string;
  readonly consequenceTier: ConsequenceTierV1;
  readonly reversibility: ActionReversibilityV1;
  readonly compensationRef?: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly eligibleRoles: readonly string[];
  readonly dueAt: string;
  readonly estimatedHumanMinutes: number;
}

export interface CompiledVisitWritebackV1 {
  readonly visit: VisitRecordV1;
  readonly actions: readonly ActionIntentV1[];
  readonly attentionItems: readonly AttentionItemV1[];
}

export type DispatchStatusV1 = "dispatching" | "succeeded" | "failed" | "unknown";

export interface EffectReceiptV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly generation: number;
  readonly effectId: string;
  readonly connectorId: string;
  readonly idempotencyKey: string;
  readonly dispatchId: string;
  readonly status: DispatchStatusV1;
  readonly externalRef?: string;
  readonly responseDigest?: string;
  readonly errorDigest?: string;
  readonly attemptedAt: string;
  readonly observedAt: string;
}

export interface EffectConnectorResultV1 {
  readonly status: Exclude<DispatchStatusV1, "dispatching">;
  readonly externalRef?: string;
  readonly responseDigest?: string;
  readonly errorDigest?: string;
}

export interface EffectConnectorV1 {
  readonly id: string;
  readonly idempotency: "strong";
  readonly effectIds: readonly string[];
  execute(intent: ActionIntentV1): Promise<EffectConnectorResultV1>;
}

export interface PublicationReceiptV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceTenantId: string;
  readonly targetTenantId: string;
  readonly publicationId: string;
  readonly sourceDigest: string;
  readonly transportId: string;
  readonly idempotencyKey: string;
  readonly dispatchId: string;
  readonly status: DispatchStatusV1;
  readonly remoteRef?: string;
  readonly responseDigest?: string;
  readonly errorDigest?: string;
  readonly attemptedAt: string;
  readonly observedAt: string;
}

export interface PublicationTransportResultV1 {
  readonly status: Exclude<DispatchStatusV1, "dispatching">;
  readonly remoteRef?: string;
  readonly responseDigest?: string;
  readonly errorDigest?: string;
}

export interface PublicationTransportV1 {
  readonly id: string;
  readonly idempotency: "strong";
  publish(envelope: PublicationEnvelopeV1): Promise<PublicationTransportResultV1>;
}

export interface DingTalkHttpEncryptedEnvelopeV1 {
  readonly msgSignature: string;
  readonly timeStamp: string;
  readonly nonce: string;
  readonly encrypt: string;
}

export interface DingTalkHttpCallbackV1 {
  readonly payload: Readonly<Record<string, SpecJsonValue>>;
  readonly payloadDigest: string;
  readonly idempotencyKey: string;
}
