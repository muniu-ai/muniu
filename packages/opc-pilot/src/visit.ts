// SPDX-License-Identifier: Apache-2.0

import {
  createBusinessRecord,
  reviseBusinessRecord,
  transitionVisitState,
  verifyBusinessRecord,
  type BusinessRecordEnvelopeV1,
  type BusinessRecordStatusV1,
  type VisitStateV1
} from "@mn/opc";
import type {
  ActionIntentV1,
  AttentionItemV1,
  ConsequenceTierV1,
  OperationRunV1
} from "@mn/operations";
import { canonicalFrozenClone, sha256Digest, type SpecJsonValue } from "@mn/specs";

import {
  digest,
  exactRecord,
  identifier,
  identifiers,
  jsonValue,
  safeInteger,
  text,
  timestamp
} from "./shared.js";
import type {
  CompiledVisitWritebackV1,
  TenantObjectRefV1,
  VisitFindingAuthorityV1,
  VisitFindingV1,
  VisitRecordPayloadV1,
  VisitRecordV1,
  VisitSourceFragmentV1,
  VisitWritebackEffectInputV1
} from "./types.js";

const FINDING_CATEGORIES = new Set(["fact", "inference", "next_action", "commitment"]);
const PROPOSER_KINDS = new Set(["model", "human", "connector"]);
const CONSEQUENCE_TIERS = new Set<ConsequenceTierV1>(["low", "medium", "high", "critical"]);
const REVERSIBILITY = new Set(["reversible", "compensating", "irreversible"]);
const EFFECTS = new Set([
  "dingtalk.todo.create",
  "crm.record.write",
  "external.message.send",
  "external.record.delete"
]);

function visitRecord(value: VisitRecordV1): VisitRecordV1 {
  if (value.kind !== "visit" || value.domainId !== "opc"
    || !verifyBusinessRecord(value as unknown as BusinessRecordEnvelopeV1)) {
    throw new Error("visit record is invalid");
  }
  return value;
}

function revise(
  previous: VisitRecordV1,
  payload: VisitRecordPayloadV1,
  input: { readonly createdAt: string; readonly actor: string },
  status: BusinessRecordStatusV1 = previous.status
): VisitRecordV1 {
  return reviseBusinessRecord(previous as unknown as BusinessRecordEnvelopeV1, {
    status,
    payload: payload as unknown as SpecJsonValue,
    createdAt: timestamp(input.createdAt, "createdAt"),
    createdBy: identifier(input.actor, "actor")
  }) as unknown as VisitRecordV1;
}

export function createVisitRecord(input: {
  readonly tenantId: string;
  readonly id: string;
  readonly accountRef: string;
  readonly createdAt: string;
  readonly createdBy: string;
}): VisitRecordV1 {
  const payload: VisitRecordPayloadV1 = {
    schemaVersion: 1,
    state: "draft",
    accountRef: identifier(input.accountRef, "accountRef"),
    sourceObjects: Object.freeze([]),
    fragments: Object.freeze([]),
    findings: Object.freeze([])
  };
  return createBusinessRecord({
    tenantId: identifier(input.tenantId, "tenantId"),
    kind: "visit",
    id: identifier(input.id, "id"),
    status: "proposed",
    payload: payload as unknown as SpecJsonValue,
    createdAt: timestamp(input.createdAt, "createdAt"),
    createdBy: identifier(input.createdBy, "createdBy")
  }) as unknown as VisitRecordV1;
}

function sourceObject(value: TenantObjectRefV1, tenantId: string): TenantObjectRefV1 {
  const record = exactRecord(value, "source", [
    "schemaVersion", "tenantId", "objectId", "digest", "mediaType", "bytes", "storage", "encryption"
  ]);
  if (record.schemaVersion !== 1 || (record.storage !== "tenant_cas" && record.storage !== "tenant_s3")) {
    throw new TypeError("source must be a V1 tenant content reference");
  }
  if (record.encryption !== "aes-256-gcm" && record.encryption !== "tenant-envelope") {
    throw new TypeError("source encryption mode is invalid");
  }
  if (record.tenantId !== tenantId) throw new Error("source tenant does not match visit tenant");
  const mediaType = text(record.mediaType, "source.mediaType", 255);
  if (!/^(?:audio|text|application)\/[A-Za-z0-9.+-]+$/u.test(mediaType)) {
    throw new TypeError("source.mediaType is invalid");
  }
  return canonicalFrozenClone({
    schemaVersion: 1,
    tenantId,
    objectId: identifier(record.objectId, "source.objectId"),
    digest: digest(record.digest, "source.digest"),
    mediaType,
    bytes: safeInteger(record.bytes, "source.bytes", 1),
    storage: record.storage,
    encryption: record.encryption
  });
}

function locator(value: unknown, field: string) {
  const record = exactRecord(value, field, [], ["startMs", "endMs", "startOffset", "endOffset"]);
  const timeBased = record.startMs !== undefined || record.endMs !== undefined;
  const offsetBased = record.startOffset !== undefined || record.endOffset !== undefined;
  if (timeBased === offsetBased) throw new TypeError(`${field} must use exactly one locator kind`);
  if (timeBased) {
    const startMs = safeInteger(record.startMs, `${field}.startMs`);
    const endMs = safeInteger(record.endMs, `${field}.endMs`);
    if (endMs <= startMs) throw new TypeError(`${field}.endMs must be after startMs`);
    return canonicalFrozenClone({ startMs, endMs });
  }
  const startOffset = safeInteger(record.startOffset, `${field}.startOffset`);
  const endOffset = safeInteger(record.endOffset, `${field}.endOffset`);
  if (endOffset <= startOffset) throw new TypeError(`${field}.endOffset must be after startOffset`);
  return canonicalFrozenClone({ startOffset, endOffset });
}

function fragment(value: VisitSourceFragmentV1, sourceId: string, index: number): VisitSourceFragmentV1 {
  const record = exactRecord(value, `fragments[${index}]`, ["id", "sourceObjectId", "locator", "contentDigest"]);
  if (record.sourceObjectId !== sourceId) throw new Error(`fragments[${index}] does not reference the supplied source`);
  return canonicalFrozenClone({
    id: identifier(record.id, `fragments[${index}].id`),
    sourceObjectId: sourceId,
    locator: locator(record.locator, `fragments[${index}].locator`),
    contentDigest: digest(record.contentDigest, `fragments[${index}].contentDigest`)
  });
}

export function addVisitSource(previousValue: VisitRecordV1, input: {
  readonly source: TenantObjectRefV1;
  readonly fragments: readonly VisitSourceFragmentV1[];
  readonly createdAt: string;
  readonly actor: string;
}): VisitRecordV1 {
  const previous = visitRecord(previousValue);
  if (previous.payload.state !== "in_progress") throw new Error("visit source can only be added in progress");
  if (!Array.isArray(input.fragments) || input.fragments.length === 0) {
    throw new TypeError("fragments must contain at least one source fragment");
  }
  const source = sourceObject(input.source, previous.tenantId);
  if (previous.payload.sourceObjects.some((item) => item.objectId === source.objectId)) {
    throw new Error("source object already exists");
  }
  const fragments = input.fragments.map((item, index) => fragment(item, source.objectId, index));
  const ids = [...previous.payload.fragments.map((item) => item.id), ...fragments.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) throw new Error("source fragment id already exists");
  return revise(previous, {
    ...previous.payload,
    sourceObjects: [...previous.payload.sourceObjects, source],
    fragments: [...previous.payload.fragments, ...fragments]
  }, input);
}

function finding(value: unknown, fragmentIds: ReadonlySet<string>, index: number): VisitFindingV1 {
  const record = exactRecord(value, `findings[${index}]`, [
    "id", "category", "field", "value", "sourceFragmentRefs", "proposedBy", "proposedAt"
  ]);
  if (!FINDING_CATEGORIES.has(String(record.category))) throw new TypeError(`findings[${index}].category is invalid`);
  const proposedBy = exactRecord(record.proposedBy, `findings[${index}].proposedBy`, ["kind", "id"]);
  if (!PROPOSER_KINDS.has(String(proposedBy.kind))) throw new TypeError(`findings[${index}].proposedBy.kind is invalid`);
  const sourceFragmentRefs = identifiers(record.sourceFragmentRefs, `findings[${index}].sourceFragmentRefs`, 1);
  if (sourceFragmentRefs.some((reference) => !fragmentIds.has(reference))) {
    throw new Error(`findings[${index}] references an unknown source fragment`);
  }
  return canonicalFrozenClone({
    id: identifier(record.id, `findings[${index}].id`),
    category: record.category as VisitFindingV1["category"],
    field: identifier(record.field, `findings[${index}].field`),
    value: jsonValue(record.value, `findings[${index}].value`),
    sourceFragmentRefs,
    proposedBy: {
      kind: proposedBy.kind as VisitFindingV1["proposedBy"]["kind"],
      id: identifier(proposedBy.id, `findings[${index}].proposedBy.id`)
    },
    proposedAt: timestamp(record.proposedAt, `findings[${index}].proposedAt`),
    status: "proposed"
  });
}

export function addVisitExtraction(previousValue: VisitRecordV1, input: {
  readonly findings: readonly unknown[];
  readonly createdAt: string;
  readonly actor: string;
}): VisitRecordV1 {
  const previous = visitRecord(previousValue);
  if (previous.payload.state !== "processing") throw new Error("visit extraction requires processing state");
  if (!Array.isArray(input.findings) || input.findings.length === 0) {
    throw new TypeError("findings must contain at least one proposal");
  }
  const fragmentIds = new Set(previous.payload.fragments.map((item) => item.id));
  const findings = input.findings.map((item, index) => finding(item, fragmentIds, index));
  const ids = [...previous.payload.findings.map((item) => item.id), ...findings.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) throw new Error("finding id already exists");
  return revise(previous, {
    ...previous.payload,
    findings: [...previous.payload.findings, ...findings]
  }, input);
}

function authority(value: unknown): VisitFindingAuthorityV1 {
  const record = exactRecord(value, "authority", ["kind", "id", "evidenceRef"]);
  if (record.kind !== "human" && record.kind !== "connector") throw new TypeError("authority.kind is invalid");
  return canonicalFrozenClone({
    kind: record.kind,
    id: identifier(record.id, "authority.id"),
    evidenceRef: identifier(record.evidenceRef, "authority.evidenceRef")
  });
}

export function confirmVisitFindings(previousValue: VisitRecordV1, input: {
  readonly decisions: readonly { readonly findingId: string; readonly decision: "verify" | "reject" }[];
  readonly authority: VisitFindingAuthorityV1;
  readonly createdAt: string;
}): VisitRecordV1 {
  const previous = visitRecord(previousValue);
  if (previous.payload.state !== "review_required") throw new Error("visit findings require review state");
  if (!Array.isArray(input.decisions)) throw new TypeError("decisions must be an array");
  const pending = previous.payload.findings.filter((item) => item.status === "proposed");
  const decisions = new Map<string, "verify" | "reject">();
  for (const [index, value] of input.decisions.entries()) {
    const record = exactRecord(value, `decisions[${index}]`, ["findingId", "decision"]);
    const id = identifier(record.findingId, `decisions[${index}].findingId`);
    if (record.decision !== "verify" && record.decision !== "reject") {
      throw new TypeError(`decisions[${index}].decision is invalid`);
    }
    if (decisions.has(id)) throw new TypeError("decisions contains duplicates");
    decisions.set(id, record.decision);
  }
  if (pending.length !== decisions.size || pending.some((item) => !decisions.has(item.id))) {
    throw new Error("every proposed finding requires one review decision");
  }
  const verifiedBy = authority(input.authority);
  const decidedAt = timestamp(input.createdAt, "createdAt");
  const findings = previous.payload.findings.map((item): VisitFindingV1 => {
    const decision = decisions.get(item.id);
    if (decision === undefined) return item;
    return decision === "verify"
      ? canonicalFrozenClone({ ...item, status: "verified", verifiedBy, verifiedAt: decidedAt })
      : canonicalFrozenClone({ ...item, status: "rejected", rejectedBy: verifiedBy, rejectedAt: decidedAt });
  });
  return revise(previous, { ...previous.payload, findings }, {
    createdAt: decidedAt,
    actor: verifiedBy.id
  });
}

export function transitionVisitRecord(
  previousValue: VisitRecordV1,
  next: VisitStateV1,
  input: { readonly createdAt: string; readonly actor: string }
): VisitRecordV1 {
  const previous = visitRecord(previousValue);
  const state = transitionVisitState(previous.payload.state, next);
  if (state === "review_required" && (
    previous.payload.sourceObjects.length === 0 ||
    previous.payload.fragments.length === 0 ||
    previous.payload.findings.length === 0
  )) {
    throw new Error("review requires source-traced findings");
  }
  if (state === "confirmed") {
    if (previous.payload.findings.some((item) => item.status === "proposed")) {
      throw new Error("confirmed visit cannot contain proposed findings");
    }
    if (!previous.payload.findings.some((item) => item.status === "verified")) {
      throw new Error("confirmed visit requires at least one verified finding");
    }
    const fragmentIds = new Set(previous.payload.fragments.map((item) => item.id));
    if (previous.payload.findings.some((item) => item.status === "verified"
      && (item.sourceFragmentRefs.length === 0 || item.sourceFragmentRefs.some((ref) => !fragmentIds.has(ref))))) {
      throw new Error("every confirmed field must reference an original fragment");
    }
  }
  const status: BusinessRecordStatusV1 = ["confirmed", "writeback_pending", "completed"].includes(state)
    ? "verified"
    : previous.status;
  return revise(previous, { ...previous.payload, state }, input, status);
}

function writebackEffect(value: VisitWritebackEffectInputV1, index: number): VisitWritebackEffectInputV1 {
  const record = exactRecord(value, `effects[${index}]`, [
    "id", "effectId", "targetRef", "protectedInputDigest", "consequenceTier", "reversibility",
    "idempotencyKey", "expiresAt", "eligibleRoles", "dueAt", "estimatedHumanMinutes"
  ], ["compensationRef"]);
  if (!EFFECTS.has(String(record.effectId))) throw new TypeError(`effects[${index}].effectId is not allowed`);
  if (!CONSEQUENCE_TIERS.has(record.consequenceTier as ConsequenceTierV1)) {
    throw new TypeError(`effects[${index}].consequenceTier is invalid`);
  }
  if (!REVERSIBILITY.has(String(record.reversibility))) throw new TypeError(`effects[${index}].reversibility is invalid`);
  if (record.reversibility === "compensating" && record.compensationRef === undefined) {
    throw new TypeError(`effects[${index}].compensationRef is required`);
  }
  return canonicalFrozenClone({
    id: identifier(record.id, `effects[${index}].id`),
    effectId: record.effectId as VisitWritebackEffectInputV1["effectId"],
    targetRef: identifier(record.targetRef, `effects[${index}].targetRef`),
    protectedInputDigest: digest(record.protectedInputDigest, `effects[${index}].protectedInputDigest`),
    consequenceTier: record.consequenceTier as VisitWritebackEffectInputV1["consequenceTier"],
    reversibility: record.reversibility as VisitWritebackEffectInputV1["reversibility"],
    ...(record.compensationRef === undefined ? {} : {
      compensationRef: identifier(record.compensationRef, `effects[${index}].compensationRef`)
    }),
    idempotencyKey: identifier(record.idempotencyKey, `effects[${index}].idempotencyKey`),
    expiresAt: timestamp(record.expiresAt, `effects[${index}].expiresAt`),
    eligibleRoles: identifiers(record.eligibleRoles, `effects[${index}].eligibleRoles`, 1),
    dueAt: timestamp(record.dueAt, `effects[${index}].dueAt`),
    estimatedHumanMinutes: safeInteger(record.estimatedHumanMinutes, `effects[${index}].estimatedHumanMinutes`)
  });
}

export function compileVisitWriteback(
  visitValue: VisitRecordV1,
  run: OperationRunV1,
  input: { readonly effects: readonly VisitWritebackEffectInputV1[]; readonly createdAt: string }
): CompiledVisitWritebackV1 {
  const visit = visitRecord(visitValue);
  if (visit.payload.state !== "confirmed" || visit.status !== "verified") {
    throw new Error("writeback requires a confirmed visit");
  }
  if (
    run.tenantId !== visit.tenantId ||
    run.domainId !== "opc" ||
    run.workflowRef.id !== "opc.visit-assistant" ||
    run.generation < 1
  ) {
    throw new Error("operation run is not bound to the visit tenant and OPC domain");
  }
  if (!Array.isArray(input.effects) || input.effects.length === 0) {
    throw new TypeError("effects must contain at least one external action");
  }
  const createdAt = timestamp(input.createdAt, "createdAt");
  const effects = input.effects.map(writebackEffect);
  if (new Set(effects.map((item) => item.id)).size !== effects.length) throw new Error("effect ids must be unique");
  const commitmentIds = run.subjectRefs
    .filter((ref) => ref.kind === "customer_commitment")
    .map((ref) => ref.id);
  const actions: ActionIntentV1[] = [];
  const attentionItems: AttentionItemV1[] = [];
  for (const effect of effects) {
    if (Date.parse(effect.expiresAt) <= Date.parse(createdAt)) throw new Error("action expiry must follow compilation");
    const inputDigest = sha256Digest({
      visitDigest: visit.digest,
      protectedInputDigest: effect.protectedInputDigest,
      effectId: effect.effectId,
      targetRef: effect.targetRef
    });
    const action: ActionIntentV1 = canonicalFrozenClone({
      schemaVersion: 1,
      id: effect.id,
      tenantId: visit.tenantId,
      runId: run.id,
      generation: run.generation,
      effectId: effect.effectId,
      targetRef: effect.targetRef,
      inputDigest,
      governanceDigest: run.governanceDigest,
      consequenceTier: effect.consequenceTier,
      reversibility: effect.reversibility,
      ...(effect.compensationRef === undefined ? {} : { compensationRef: effect.compensationRef }),
      idempotencyKey: effect.idempotencyKey,
      expiresAt: effect.expiresAt,
      createdAt
    });
    const attention: AttentionItemV1 = canonicalFrozenClone({
      schemaVersion: 1,
      id: `attention.${sha256Digest({ actionId: action.id })}`,
      tenantId: visit.tenantId,
      sourceKind: "approval",
      sourceId: action.id,
      consequenceTier: action.consequenceTier,
      dueAt: effect.dueAt,
      blockedCommitmentIds: commitmentIds,
      estimatedHumanMinutes: effect.estimatedHumanMinutes,
      eligibleRoles: effect.eligibleRoles,
      evidenceRefs: [visit.digest, action.inputDigest],
      inputDigest: action.inputDigest,
      status: "pending",
      createdAt
    });
    actions.push(action);
    attentionItems.push(attention);
  }
  return canonicalFrozenClone({
    visit: transitionVisitRecord(visit, "writeback_pending", {
      createdAt,
      actor: "operation.compiler"
    }),
    actions,
    attentionItems
  });
}
