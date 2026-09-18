// SPDX-License-Identifier: Apache-2.0
import type {
  BusinessScopeV1, WorkerExecutionIdentityV1, BusinessObjectSnapshotV1, BusinessDecisionV1, IssueQuotePackageInputV1, EffectReceiptV1, EffectAdmissionV1, BusinessSnapshotQueryV1, BusinessDecisionQueryV1, EffectAdmissionRequestV1, EffectExecutionRequestV1, EffectLookupRequestV1, CreateBusinessActionV2, ReconcileBusinessActionV2, BusinessActionV1
} from "./business-effects.js";

export class BusinessContractError extends TypeError {
  constructor() {
    super("业务契约无效");
    this.name = "BusinessContractError";
  }
}

type RecordValue = Record<string, unknown>;
function fail(): never { throw new BusinessContractError(); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const result = value as RecordValue;
  if (required.some(key => !Object.hasOwn(result, key))
    || Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return result;
}
function string(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) fail();
}
function literal(value: unknown, allowed: readonly unknown[]): void { if (!allowed.includes(value)) fail(); }
function digest(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function integer(value: unknown, minimum: number): void { if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(); }
function instant(value: unknown): void {
  string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail();
  const date = value.slice(0, 10);
  calendarDate(date);
}
function calendarDate(value: unknown): void {
  string(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) fail();
}
function scope(value: unknown): BusinessScopeV1 {
  const item = record(value, ["tenantId", "workspaceId", "principalId", "customerId"]);
  for (const field of Object.values(item)) string(field);
  return value as BusinessScopeV1;
}
function protectedRef(value: unknown, tenantId?: string): void {
  string(value);
  const match = /^sales:\/\/([^/@:?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/u.exec(value);
  if (!match) fail();
  try {
    const parts = match.slice(1).map(part => decodeURIComponent(part));
    if (parts.some(part => !part || part === "." || part === ".." || /[\/@:?#\u0000-\u0020]/u.test(part))) fail();
    if (tenantId !== undefined && parts[0] !== tenantId) fail();
  } catch { fail(); }
}
function versionRef(value: unknown): void {
  const item = record(value, ["id", "version", "digest"]);
  string(item.id); string(item.version); digest(item.digest);
}
function identity(value: unknown): void {
  const item = record(value, ["executionId", "generation", "jobId", "workerId", "fencingToken"]);
  string(item.executionId); string(item.jobId); string(item.workerId);
  integer(item.generation, 1); integer(item.fencingToken, 1);
}
function copy<T>(value: unknown): T { return structuredClone(value) as T; }

export function parseBusinessScopeV1(value: unknown): BusinessScopeV1 { return copy(scope(value)); }
export function parseWorkerExecutionIdentityV1(value: unknown): WorkerExecutionIdentityV1 { identity(value); return copy(value); }

export function parseBusinessObjectSnapshotV1(value: unknown): BusinessObjectSnapshotV1 {
  const item = record(value, ["schemaVersion", "providerId", "objectType", "objectId", "version", "digest", "protectedContentRef", "scope", "observedAt", "template", "sourceRefs"]);
  literal(item.schemaVersion, ["1"]); literal(item.providerId, ["sales"]); literal(item.objectType, ["quote"]);
  string(item.objectId); string(item.version); digest(item.digest); instant(item.observedAt);
  const scoped = scope(item.scope); protectedRef(item.protectedContentRef, scoped.tenantId); versionRef(item.template);
  if (!Array.isArray(item.sourceRefs)) fail();
  for (const source of item.sourceRefs) {
    const ref = record(source, ["namespace", "resourceId", "digest", "protectedContentRef"]);
    string(ref.namespace); string(ref.resourceId); digest(ref.digest); protectedRef(ref.protectedContentRef, scoped.tenantId);
  }
  return copy(value);
}

export function parseBusinessDecisionV1(value: unknown): BusinessDecisionV1 {
  const item = record(value, ["schemaVersion", "id", "scope", "snapshotDigest", "snapshotVersion", "actorId", "policyVersion", "approvedAt", "expiresAt", "status", "digest"], ["revokedAt"]);
  literal(item.schemaVersion, ["1"]); scope(item.scope); string(item.id); digest(item.snapshotDigest);
  string(item.snapshotVersion); string(item.actorId); string(item.policyVersion); digest(item.digest);
  instant(item.approvedAt); instant(item.expiresAt);
  if (Date.parse(item.expiresAt as string) <= Date.parse(item.approvedAt as string)) fail();
  literal(item.status, ["approved", "revoked"]);
  if (item.status === "revoked") {
    instant(item.revokedAt);
    if (Date.parse(item.revokedAt as string) < Date.parse(item.approvedAt as string)) fail();
  } else if (Object.hasOwn(item, "revokedAt")) fail();
  return copy(value);
}

export function parseIssueQuotePackageInputV1(value: unknown): IssueQuotePackageInputV1 {
  const item = record(value, ["schemaVersion", "action", "actionId", "operationKey", "scope", "quote", "businessDecision", "template", "renderVersion", "exportFormat", "issueDate"]);
  literal(item.schemaVersion, ["1"]); literal(item.action, ["issueQuotePackage"]);
  string(item.actionId); string(item.operationKey); scope(item.scope); versionRef(item.quote); versionRef(item.template);
  const decision = record(item.businessDecision, ["id", "digest"]); string(decision.id); digest(decision.digest);
  string(item.renderVersion); literal(item.exportFormat, ["pdf"]); calendarDate(item.issueDate);
  return copy(value);
}

export function parseEffectReceiptV1(value: unknown, expectedScope?: BusinessScopeV1): EffectReceiptV1 {
  const item = record(value, ["schemaVersion", "actionId", "operationKey", "status", "files", "observedAt"], ["packageId", "reasonCode"]);
  literal(item.schemaVersion, ["1"]); string(item.actionId); string(item.operationKey); instant(item.observedAt);
  literal(item.status, ["accepted", "completed", "rejected", "unknown"]);
  if (item.reasonCode !== undefined) { string(item.reasonCode); if (!/^[A-Z][A-Z0-9_]*$/u.test(item.reasonCode)) fail(); }
  if (!Array.isArray(item.files)) fail();
  if (item.status === "completed") { string(item.packageId); if (item.files.length === 0) fail(); }
  else if (item.files.length > 0 || Object.hasOwn(item, "packageId")) fail();
  for (const value of item.files) {
    const file = record(value, ["name", "mediaType", "sha256", "protectedContentRef"]);
    string(file.name); if (/[\/\\]/u.test(file.name) || file.name === "." || file.name === "..") fail();
    literal(file.mediaType, ["application/pdf"]); digest(file.sha256); protectedRef(file.protectedContentRef, expectedScope?.tenantId);
  }
  return copy(value);
}

export function parseEffectAdmissionV1(value: unknown): EffectAdmissionV1 {
  const item = record(value, ["schemaVersion", "actionId", "operationKey", "admissionId", "status"], ["receipt"]);
  literal(item.schemaVersion, ["1"]); string(item.actionId); string(item.operationKey); string(item.admissionId);
  literal(item.status, ["admitted", "existing"]);
  if (item.receipt !== undefined) {
    const receipt = parseEffectReceiptV1(item.receipt);
    if (receipt.actionId !== item.actionId || receipt.operationKey !== item.operationKey) fail();
  }
  if (item.status === "existing" && item.receipt === undefined) fail();
  return copy(value);
}

export function parseBusinessSnapshotQueryV1(value: unknown): BusinessSnapshotQueryV1 {
  const item = record(value, ["schemaVersion", "scope", "objectId", "version", "templateId", "templateVersion"]);
  literal(item.schemaVersion, ["1"]); scope(item.scope);
  for (const key of ["objectId", "version", "templateId", "templateVersion"]) string(item[key]);
  return copy(value);
}
export function parseBusinessDecisionQueryV1(value: unknown): BusinessDecisionQueryV1 {
  const item = record(value, ["schemaVersion", "scope", "decisionId"]);
  literal(item.schemaVersion, ["1"]); scope(item.scope); string(item.decisionId); return copy(value);
}
export function parseEffectAdmissionRequestV1(value: unknown): EffectAdmissionRequestV1 {
  const item = record(value, ["schemaVersion", "action", "identity", "approvalId", "actionDigest"]);
  literal(item.schemaVersion, ["1"]); const action = parseIssueQuotePackageInputV1(item.action);
  identity(item.identity); string(item.approvalId); digest(item.actionDigest);
  return copy(value);
}
export function parseEffectExecutionRequestV1(value: unknown): EffectExecutionRequestV1 {
  const item = record(value, ["schemaVersion", "actionId", "operationKey", "admissionId", "identity"]);
  literal(item.schemaVersion, ["1"]); string(item.actionId); string(item.operationKey); string(item.admissionId); identity(item.identity);
  return copy(value);
}
export function parseEffectLookupRequestV1(value: unknown): EffectLookupRequestV1 {
  const item = record(value, ["schemaVersion", "scope", "actionId", "operationKey"]);
  literal(item.schemaVersion, ["1"]); scope(item.scope); string(item.actionId); string(item.operationKey); return copy(value);
}

export function parseCreateBusinessActionV2(value: unknown): CreateBusinessActionV2 {
  const item = record(value, ["schemaVersion", "action", "expectedStreamVersion", "workspaceId", "customerId", "quoteId", "quoteVersion", "decisionId", "templateId", "templateVersion", "renderVersion", "exportFormat", "issueDate"]);
  literal(item.schemaVersion, ["1"]); literal(item.action, ["issueQuotePackage"]); literal(item.expectedStreamVersion, [0]);
  for (const key of ["workspaceId", "customerId", "quoteId", "quoteVersion", "decisionId", "templateId", "templateVersion", "renderVersion"]) string(item[key]);
  literal(item.exportFormat, ["pdf"]); calendarDate(item.issueDate); return copy(value);
}
export function parseReconcileBusinessActionV2(value: unknown): ReconcileBusinessActionV2 {
  const item = record(value, ["expectedStreamVersion", "decision"]);
  integer(item.expectedStreamVersion, 1); literal(item.decision, ["mark_completed", "terminate"]); return copy(value);
}
export function parseBusinessActionV1(value: unknown): BusinessActionV1 {
  const item = record(value, ["schemaVersion", "id", "tenantId", "workspaceId", "executionId", "jobId", "operationKey", "actionDigest", "action", "status", "streamVersion", "createdAt", "updatedAt"], ["approvalId", "approval", "receipt"]);
  literal(item.schemaVersion, ["1"]);
  for (const key of ["id", "tenantId", "workspaceId", "executionId", "jobId", "operationKey"]) string(item[key]);
  digest(item.actionDigest); integer(item.streamVersion, 1); instant(item.createdAt); instant(item.updatedAt);
  literal(item.status, ["queued", "waiting_approval", "running", "completed", "rejected", "needs_reconciliation", "terminated"]);
  if (item.approvalId !== undefined) string(item.approvalId);
  if (item.approval !== undefined) {
    const approval = record(item.approval, ["id", "tenantId", "streamVersion", "createdAt", "updatedAt", "workspaceId", "executionId", "toolCallId", "effectClass", "intent", "resourceRefs", "authorityCommitment", "expiresAt", "status"], ["decidedBy", "decidedAt"]);
    for (const key of ["id", "tenantId", "workspaceId", "executionId", "toolCallId", "intent", "authorityCommitment"]) string(approval[key]);
    integer(approval.streamVersion, 1); instant(approval.createdAt); instant(approval.updatedAt); instant(approval.expiresAt);
    literal(approval.effectClass, ["external_side_effect"]); literal(approval.status, ["pending", "approved_once", "denied", "expired"]);
    if (approval.decidedBy !== undefined) string(approval.decidedBy);
    if (approval.decidedAt !== undefined) instant(approval.decidedAt);
    if (!Array.isArray(approval.resourceRefs)) fail();
    for (const value of approval.resourceRefs) {
      const ref = record(value, ["namespace", "resourceId"], ["digest"]); string(ref.namespace); string(ref.resourceId);
      if (ref.digest !== undefined) string(ref.digest);
    }
    if (approval.id !== item.approvalId || approval.tenantId !== item.tenantId
      || approval.workspaceId !== item.workspaceId || approval.executionId !== item.executionId) fail();
  }
  const action = parseIssueQuotePackageInputV1(item.action);
  if (action.actionId !== item.id || action.operationKey !== item.operationKey || action.scope.tenantId !== item.tenantId
    || action.scope.workspaceId !== item.workspaceId) fail();
  if (item.receipt !== undefined) {
    const receipt = parseEffectReceiptV1(item.receipt, action.scope);
    if (receipt.actionId !== item.id || receipt.operationKey !== item.operationKey
      || (item.status === "completed" && receipt.status !== "completed")) fail();
  } else if (item.status === "completed") fail();
  return copy(value);
}
