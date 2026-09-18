// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { canonicalJson } from "./integrity.js";
import { parseBusinessScopeV1, type BusinessScopeV1, type BusinessSourceRefV1 } from "./business-effects.js";

export interface SalesInquiryPageV1 {
  readonly sourceId: string;
  readonly pageNumber: number;
  readonly text: string;
  readonly digest: string;
}
export interface SalesInquirySnapshotV1 {
  readonly schemaVersion: "1";
  readonly scope: BusinessScopeV1;
  readonly inquiryId: string;
  readonly inquiryRevision: string;
  readonly digest: string;
  readonly sourceRefs: readonly BusinessSourceRefV1[];
  readonly pages: readonly SalesInquiryPageV1[];
  readonly completeness: { readonly status: "complete" | "incomplete"; readonly missing: readonly string[] };
  readonly requirements: readonly string[];
}
export interface BusinessInquiryQueryV1 {
  readonly schemaVersion: "1";
  readonly scope: BusinessScopeV1;
  readonly objectId: string;
  readonly revision: string;
}
export interface BusinessInquirySourcePortV1 {
  read(input: BusinessInquiryQueryV1): Promise<SalesInquirySnapshotV1>;
}
export interface RfqCitationV1 {
  readonly sourceId: string;
  readonly pageNumber: number;
  /** Offsets count Unicode code points, not UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}
export interface RfqCandidateItemV1 {
  readonly text: string;
  readonly citations: readonly RfqCitationV1[];
}
export interface RfqModelOutputV1 {
  readonly requirements: readonly RfqCandidateItemV1[];
  readonly facts: readonly RfqCandidateItemV1[];
  readonly suggestions: readonly RfqCandidateItemV1[];
  readonly unknown: readonly RfqCandidateItemV1[];
  readonly conflicts: readonly RfqCandidateItemV1[];
}
export interface RfqCandidateV1 extends RfqModelOutputV1 {
  readonly schemaVersion: "1";
  readonly inquiryId: string;
  readonly inquiryRevision: string;
  readonly sourceDigest: string;
  readonly modelProvenance: {
    readonly providerId: string;
    readonly modelId: string;
    readonly mode: "live" | "test_fixture";
  };
}
export interface CreateBusinessCandidateV2 {
  readonly expectedStreamVersion: 0;
  readonly workspaceId: string;
  readonly customerId: string;
  readonly inquiryId: string;
  readonly inquiryRevision: string;
}
export interface BusinessCandidateV1 {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly scope: BusinessScopeV1;
  readonly inquiryId: string;
  readonly inquiryRevision: string;
  readonly sourceDigest: string;
  readonly executionId: string;
  readonly jobId: string;
  readonly workflowVersion: "1";
  readonly status: "queued" | "running" | "completed" | "failed" | "needs_reconciliation";
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly candidateDigest?: string;
  readonly counts?: { readonly requirements: number; readonly facts: number; readonly suggestions: number; readonly unknown: number; readonly conflicts: number };
  readonly reasonCode?: string;
}
export interface BusinessCandidateContentV1 {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly scope: BusinessScopeV1;
  readonly digest: string;
  readonly candidate: RfqCandidateV1;
}

function fail(): never { throw new TypeError("询价候选契约无效"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) fail();
  return result;
}
function text(value: unknown, max = 16384): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail();
}
function digest(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function integer(value: unknown, min: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min) fail();
}
function strings(value: unknown): void {
  if (!Array.isArray(value) || value.length > 1000) fail();
  value.forEach(value => text(value));
}
export function computeInquirySnapshotDigest(snapshot: Omit<SalesInquirySnapshotV1, "digest"> | SalesInquirySnapshotV1): string {
  return createHash("sha256").update(canonicalJson({ inquiryId: snapshot.inquiryId, inquiryRevision: snapshot.inquiryRevision,
    sourceRefs: snapshot.sourceRefs, pages: snapshot.pages, completeness: snapshot.completeness, requirements: snapshot.requirements })).digest("hex");
}
export function parseSalesInquirySnapshotV1(value: unknown): SalesInquirySnapshotV1 {
  const item = object(value, ["schemaVersion", "scope", "inquiryId", "inquiryRevision", "digest", "sourceRefs", "pages", "completeness", "requirements"]);
  if (item.schemaVersion !== "1") fail();
  const scope = parseBusinessScopeV1(item.scope);
  text(item.inquiryId, 256); text(item.inquiryRevision, 256); digest(item.digest); strings(item.requirements);
  if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0 || item.sourceRefs.length > 200) fail();
  const sources = new Set<string>();
  for (const value of item.sourceRefs) {
    const ref = object(value, ["namespace", "resourceId", "digest", "protectedContentRef"]);
    text(ref.namespace, 256); text(ref.resourceId, 256); digest(ref.digest); text(ref.protectedContentRef, 2048);
    if (!ref.protectedContentRef.startsWith(`sales://${encodeURIComponent(scope.tenantId)}/`)
      || /[@?#\s]/u.test(ref.protectedContentRef) || sources.has(ref.resourceId)) fail();
    sources.add(ref.resourceId);
  }
  if (!Array.isArray(item.pages) || item.pages.length === 0 || item.pages.length > 200) fail();
  const pages = new Set<string>();
  let characters = 0;
  for (const value of item.pages) {
    const page = object(value, ["sourceId", "pageNumber", "text", "digest"]);
    text(page.sourceId, 256); integer(page.pageNumber, 1); text(page.text, 100_000); digest(page.digest);
    const key = `${page.sourceId}:${page.pageNumber}`;
    if (!sources.has(page.sourceId) || pages.has(key)
      || createHash("sha256").update(page.text).digest("hex") !== page.digest) fail();
    pages.add(key); characters += page.text.length;
  }
  if (characters > 200_000) fail();
  const completeness = object(item.completeness, ["status", "missing"]); strings(completeness.missing);
  if (!["complete", "incomplete"].includes(String(completeness.status))
    || (completeness.status === "complete" && (completeness.missing as unknown[]).length !== 0)) fail();
  const result = structuredClone(value) as SalesInquirySnapshotV1;
  if (computeInquirySnapshotDigest(result) !== item.digest) fail();
  return result;
}
export function parseRfqModelOutputV1(value: unknown, source: SalesInquirySnapshotV1): RfqModelOutputV1 {
  const item = object(value, ["requirements", "facts", "suggestions", "unknown", "conflicts"]);
  for (const category of Object.values(item)) {
    if (!Array.isArray(category) || category.length > 100) fail();
    for (const value of category) {
      const claim = object(value, ["text", "citations"]); text(claim.text, 4000);
      if (!Array.isArray(claim.citations) || claim.citations.length === 0 || claim.citations.length > 20) fail();
      for (const value of claim.citations) {
        const citation = object(value, ["sourceId", "pageNumber", "start", "end", "quote"]);
        text(citation.sourceId, 256); integer(citation.pageNumber, 1); integer(citation.start, 0); integer(citation.end, 1); text(citation.quote, 4000);
        const page = source.pages.find(page => page.sourceId === citation.sourceId && page.pageNumber === citation.pageNumber);
        if (!page || citation.end <= citation.start || citation.end > Array.from(page.text).length
          || Array.from(page.text).slice(citation.start, citation.end).join("") !== citation.quote) fail();
      }
    }
  }
  return structuredClone(value) as RfqModelOutputV1;
}
export function parseCreateBusinessCandidateV2(value: unknown): CreateBusinessCandidateV2 {
  const item = object(value, ["expectedStreamVersion", "workspaceId", "customerId", "inquiryId", "inquiryRevision"]);
  if (item.expectedStreamVersion !== 0) fail();
  for (const key of ["workspaceId", "customerId", "inquiryId", "inquiryRevision"]) text(item[key], 256);
  return structuredClone(value) as CreateBusinessCandidateV2;
}
