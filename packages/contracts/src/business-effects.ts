// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { canonicalJson } from "./integrity.js";
import type { Approval } from "./models.js";
import {
  BusinessContractError, parseIssueQuotePackageInputV1,
  parseEffectAdmissionRequestV1 as parseAdmissionWire,
  parseBusinessActionV1 as parseActionWire,
} from "./business-effect-validation.js";

export interface BusinessScopeV1 {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly customerId: string;
}

export interface BusinessVersionRefV1 {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface BusinessSourceRefV1 {
  readonly namespace: string;
  readonly resourceId: string;
  readonly digest: string;
  readonly protectedContentRef: string;
}

export interface BusinessObjectSnapshotV1 {
  readonly schemaVersion: "1";
  readonly providerId: "sales";
  readonly objectType: "quote";
  readonly objectId: string;
  readonly version: string;
  readonly digest: string;
  readonly protectedContentRef: string;
  readonly scope: BusinessScopeV1;
  readonly observedAt: string;
  readonly template: BusinessVersionRefV1;
  readonly sourceRefs: readonly BusinessSourceRefV1[];
}

export interface BusinessDecisionV1 {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly scope: BusinessScopeV1;
  readonly snapshotDigest: string;
  readonly snapshotVersion: string;
  readonly actorId: string;
  readonly policyVersion: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly status: "approved" | "revoked";
  readonly revokedAt?: string;
  readonly digest: string;
}

export interface IssueQuotePackageInputV1 {
  readonly schemaVersion: "1";
  readonly action: "issueQuotePackage";
  readonly actionId: string;
  readonly operationKey: string;
  readonly scope: BusinessScopeV1;
  readonly quote: BusinessVersionRefV1;
  readonly businessDecision: { readonly id: string; readonly digest: string };
  readonly template: BusinessVersionRefV1;
  readonly renderVersion: string;
  readonly exportFormat: "pdf";
  readonly issueDate: string;
}

/** Host/Worker supplies this identity after validating the physical Job lease. */
export interface WorkerExecutionIdentityV1 {
  readonly executionId: string;
  readonly generation: number;
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: number;
}

export interface EffectReceiptFileV1 {
  readonly name: string;
  readonly mediaType: "application/pdf";
  readonly sha256: string;
  readonly protectedContentRef: string;
}

export interface EffectReceiptV1 {
  readonly schemaVersion: "1";
  readonly actionId: string;
  readonly operationKey: string;
  readonly status: "accepted" | "completed" | "rejected" | "unknown";
  readonly packageId?: string;
  readonly files: readonly EffectReceiptFileV1[];
  readonly reasonCode?: string;
  readonly observedAt: string;
}

export interface EffectAdmissionV1 {
  readonly schemaVersion: "1";
  readonly actionId: string;
  readonly operationKey: string;
  readonly admissionId: string;
  readonly status: "admitted" | "existing";
  readonly receipt?: EffectReceiptV1;
}

export interface BusinessSnapshotQueryV1 {
  readonly schemaVersion: "1";
  readonly scope: BusinessScopeV1;
  readonly objectId: string;
  readonly version: string;
  readonly templateId: string;
  readonly templateVersion: string;
}

export interface BusinessDecisionQueryV1 {
  readonly schemaVersion: "1";
  readonly scope: BusinessScopeV1;
  readonly decisionId: string;
}

export interface EffectAdmissionRequestV1 {
  readonly schemaVersion: "1";
  readonly action: IssueQuotePackageInputV1;
  readonly identity: WorkerExecutionIdentityV1;
  readonly approvalId: string;
  readonly actionDigest: string;
}

export interface EffectExecutionRequestV1 {
  readonly schemaVersion: "1";
  readonly actionId: string;
  readonly operationKey: string;
  readonly admissionId: string;
  readonly identity: WorkerExecutionIdentityV1;
}

export interface EffectLookupRequestV1 {
  readonly schemaVersion: "1";
  readonly scope: BusinessScopeV1;
  readonly actionId: string;
  readonly operationKey: string;
}

export interface BusinessObjectSnapshotPortV1 {
  read(input: BusinessSnapshotQueryV1): Promise<BusinessObjectSnapshotV1>;
}
export interface BusinessDecisionPortV1 {
  read(input: BusinessDecisionQueryV1): Promise<BusinessDecisionV1>;
}
export interface EffectActionPortV1 {
  admit(input: EffectAdmissionRequestV1): Promise<EffectAdmissionV1>;
  execute(input: EffectExecutionRequestV1): Promise<EffectReceiptV1>;
}
export interface EffectReceiptAndReconciliationPortV1 {
  lookup(input: EffectLookupRequestV1): Promise<EffectReceiptV1 | undefined>;
  reconcile(input: EffectLookupRequestV1): Promise<EffectReceiptV1 | undefined>;
}

export interface CreateBusinessActionV2 {
  readonly schemaVersion: "1";
  readonly action: "issueQuotePackage";
  readonly expectedStreamVersion: 0;
  readonly workspaceId: string;
  readonly customerId: string;
  readonly quoteId: string;
  readonly quoteVersion: string;
  readonly decisionId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly renderVersion: string;
  readonly exportFormat: "pdf";
  readonly issueDate: string;
}

export interface ReconcileBusinessActionV2 {
  readonly expectedStreamVersion: number;
  readonly decision: "mark_completed" | "terminate";
}

export interface BusinessActionV1 {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly jobId: string;
  readonly operationKey: string;
  readonly actionDigest: string;
  readonly action: IssueQuotePackageInputV1;
  readonly status: "queued" | "waiting_approval" | "running" | "completed" | "rejected" | "needs_reconciliation" | "terminated";
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvalId?: string;
  readonly approval?: Approval;
  readonly receipt?: EffectReceiptV1;
}

export * from "./business-effect-validation.js";

/** Server validation includes commitments; browser response validation stays synchronous and portable. */
export function parseEffectAdmissionRequestV1(value: unknown): EffectAdmissionRequestV1 {
  const parsed = parseAdmissionWire(value);
  if (computeBusinessActionDigest(parsed.action) !== parsed.actionDigest
    || computeBusinessOperationKey(parsed.action) !== parsed.action.operationKey) throw new BusinessContractError();
  return parsed;
}

export function parseBusinessActionV1(value: unknown): BusinessActionV1 {
  const parsed = parseActionWire(value);
  if (computeBusinessActionDigest(parsed.action) !== parsed.actionDigest
    || computeBusinessOperationKey(parsed.action) !== parsed.operationKey) throw new BusinessContractError();
  return parsed;
}

/** Stable across approval renewal, Job takeover and a change of requesting principal. */
export function computeBusinessOperationKey(action: IssueQuotePackageInputV1): string {
  const parsed = parseIssueQuotePackageInputV1(action);
  return createHash("sha256").update(canonicalJson({ schemaVersion: parsed.schemaVersion, action: parsed.action,
    tenantId: parsed.scope.tenantId, workspaceId: parsed.scope.workspaceId, customerId: parsed.scope.customerId,
    quote: parsed.quote, template: parsed.template, renderVersion: parsed.renderVersion,
    exportFormat: parsed.exportFormat, issueDate: parsed.issueDate })).digest("hex");
}

/** The precise admission binds business approval separately from stable operation identity. */
export function computeBusinessActionDigest(action: IssueQuotePackageInputV1): string {
  return createHash("sha256").update(canonicalJson(parseIssueQuotePackageInputV1(action))).digest("hex");
}
