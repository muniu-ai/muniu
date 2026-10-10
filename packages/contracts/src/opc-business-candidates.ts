// SPDX-License-Identifier: Apache-2.0
import { parseBusinessCommand, type BusinessCommandV1 } from "./business-management.js";
import type { GoalResourceRefV2 } from "./goals.js";
import type { JsonValue } from "./json.js";

export type OpcBusinessCandidateCommandV2 = Extract<BusinessCommandV1, { readonly type: "quote.create" | "delivery.record" | "review.record" }>;
export interface OpcBusinessCandidateOriginV2 {
  readonly goalId: string; readonly planRevisionId: string; readonly deliverySetId: string;
  readonly outputKey: string; readonly outputDigest: string;
}
export interface OpcBusinessProposalV2 {
  readonly key: string; readonly title: string; readonly rationale: string;
  readonly command: OpcBusinessCandidateCommandV2;
  readonly evidenceRefs: readonly GoalResourceRefV2[];
}
export interface CreateOpcBusinessCandidateV2 {
  readonly workspaceId: string; readonly expectedStreamVersion: 0;
  readonly origin: OpcBusinessCandidateOriginV2; readonly proposalKey: string;
}
export interface DecideOpcBusinessCandidateV2 {
  readonly workspaceId: string; readonly expectedStreamVersion: number; readonly expectedBusinessStreamVersion: number;
  readonly candidateDigest: string; readonly previewDigest: string; readonly decision: "apply" | "reject";
}
export interface OpcBusinessCandidateChangeV2 {
  readonly path: string; readonly label: string; readonly before: JsonValue; readonly after: JsonValue;
}
export interface OpcBusinessCandidateImpactV2 {
  readonly currency: "CNY"; readonly quoteTotalMinor?: string;
  readonly contractedDeltaMinor: string; readonly outstandingDeltaMinor: string; readonly cashReceivedDeltaMinor: string;
}
export interface OpcBusinessCandidateV2 {
  readonly schemaVersion: "1"; readonly id: string; readonly tenantId: string; readonly workspaceId: string;
  readonly origin: OpcBusinessCandidateOriginV2; readonly proposal: OpcBusinessProposalV2;
  readonly sourceRefs: readonly GoalResourceRefV2[]; readonly businessStreamVersion: number;
  readonly changes: readonly OpcBusinessCandidateChangeV2[]; readonly impact: OpcBusinessCandidateImpactV2;
  readonly previewDigest: string; readonly digest: string; readonly createdAt: string; readonly createdBy: string;
}
export interface OpcBusinessCandidateDecisionV2 {
  readonly candidateId: string; readonly candidateDigest: string; readonly decision: "apply" | "reject";
  readonly decidedBy: string; readonly decidedAt: string; readonly businessStreamVersion: number;
}
export interface OpcBusinessCandidateDetailV2 {
  readonly candidate: OpcBusinessCandidateV2; readonly streamVersion: number;
  readonly decision: OpcBusinessCandidateDecisionV2 | null;
  readonly availability: { readonly apply: boolean; readonly reject: boolean; readonly staleReasons: readonly string[] };
}
export interface OpcBusinessCandidateListV2 { readonly items: readonly OpcBusinessCandidateDetailV2[] }

function fail(): never { throw new TypeError("经营候选字段、命令或来源无效"); }
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) fail();
  const item = value as Record<string, unknown>;
  if (Object.getOwnPropertyNames(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) fail();
  return item;
}
function text(value: unknown, maximum = 200): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail();
}
function digest(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function integer(value: unknown, minimum: number): void { if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(); }
function origin(value: unknown): void {
  const item = shape(value, ["goalId", "planRevisionId", "deliverySetId", "outputKey", "outputDigest"]);
  for (const key of ["goalId", "planRevisionId", "deliverySetId", "outputKey"]) text(item[key]);
  digest(item.outputDigest);
}
export function parseOpcBusinessProposalV2(value: unknown): OpcBusinessProposalV2 {
  const item = shape(value, ["key", "title", "rationale", "command", "evidenceRefs"]);
  text(item.key, 100); text(item.title); text(item.rationale, 4000);
  const command = parseBusinessCommand(item.command);
  if (!["quote.create", "delivery.record", "review.record"].includes(command.type)) fail();
  if (!Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length || item.evidenceRefs.length > 20) fail();
  const seen = new Set<string>();
  for (const value of item.evidenceRefs) {
    const ref = shape(value, ["namespace", "resourceId", "streamVersion", "digest"]);
    text(ref.namespace); text(ref.resourceId); integer(ref.streamVersion, 1); digest(ref.digest);
    const key = `${ref.namespace}:${ref.resourceId}`;
    if (seen.has(key)) fail(); seen.add(key);
  }
  return structuredClone(value) as OpcBusinessProposalV2;
}
export function parseCreateOpcBusinessCandidateV2(value: unknown): CreateOpcBusinessCandidateV2 {
  const item = shape(value, ["workspaceId", "expectedStreamVersion", "origin", "proposalKey"]);
  text(item.workspaceId); text(item.proposalKey, 100); origin(item.origin);
  if (item.expectedStreamVersion !== 0) fail();
  return structuredClone(value) as CreateOpcBusinessCandidateV2;
}
export function parseDecideOpcBusinessCandidateV2(value: unknown): DecideOpcBusinessCandidateV2 {
  const item = shape(value, ["workspaceId", "expectedStreamVersion", "expectedBusinessStreamVersion", "candidateDigest", "previewDigest", "decision"]);
  text(item.workspaceId); integer(item.expectedStreamVersion, 1); integer(item.expectedBusinessStreamVersion, 0);
  digest(item.candidateDigest); digest(item.previewDigest);
  if (item.decision !== "apply" && item.decision !== "reject") fail();
  return structuredClone(value) as DecideOpcBusinessCandidateV2;
}
