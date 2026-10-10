// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { parseCreateOpcBusinessCandidateV2, parseDecideOpcBusinessCandidateV2, parseOpcBusinessProposalV2,
  type BusinessStateV1, type CreateOpcBusinessCandidateV2, type DecideOpcBusinessCandidateV2, type GoalResourceRefV2, type JsonValue,
  type OpcBusinessCandidateChangeV2, type OpcBusinessCandidateDecisionV2, type OpcBusinessCandidateDetailV2, type OpcBusinessCandidateImpactV2,
  type OpcBusinessCandidateListV2, type OpcBusinessCandidateOriginV2, type OpcBusinessCandidateV2, type OpcBusinessProposalV2 } from "@mn/contracts";
import { appendKernelEvent, KernelError, sha256, type KernelTransaction } from "@mn/kernel";
import { applyBusinessCommand, calculateBusinessSummary } from "@mn/plugin-opc";
import { assertBusinessAccess, commandOpcBusinessInTransaction, currentOpcBusiness, type BusinessOptions, type BusinessScope } from "./business-management.js";

export const OPC_BUSINESS_CANDIDATE_NAMESPACE = "opc.businessCandidate";
export const OPC_BUSINESS_CANDIDATE_DECISION_NAMESPACE = "opc.businessCandidateDecision";
export interface OpcBusinessCandidateOutputProof {
  readonly origin: OpcBusinessCandidateOriginV2; readonly sourceRefs: readonly GoalResourceRefV2[];
  readonly proposals: readonly OpcBusinessProposalV2[]; readonly accepted: boolean;
}
export interface OpcBusinessCandidateOptions extends BusinessOptions {
  readonly ports: {
    readOutput(tx: KernelTransaction, scope: BusinessScope, origin: OpcBusinessCandidateOriginV2,
      purpose: "create" | "read" | "apply"): OpcBusinessCandidateOutputProof;
  };
}
function fail(code: string, message: string): never { throw new KernelError(code, message, "重新核对成果、资料版本和经营候选"); }
const eventType = "opc.business_candidate";
function matchScope(options: BusinessScope, workspaceId: string): void {
  if (options.workspaceId !== workspaceId) fail("BUSINESS_SCOPE_MISMATCH", "候选工作区不匹配");
}
export function opcBusinessCandidateArtifactRef(origin: OpcBusinessCandidateOriginV2): string {
  return `goal-output://${encodeURIComponent(origin.goalId)}/${encodeURIComponent(origin.deliverySetId)}/${encodeURIComponent(origin.outputKey)}?sha256=${origin.outputDigest}`;
}
function selectedProposal(proof: OpcBusinessCandidateOutputProof, origin: OpcBusinessCandidateOriginV2, key: string): OpcBusinessProposalV2 {
  if (sha256(proof.origin) !== sha256(origin) || !Array.isArray(proof.proposals) || proof.proposals.length > 20
    || !Array.isArray(proof.sourceRefs) || !proof.sourceRefs.length || proof.sourceRefs.length > 100)
    fail("OPC_CANDIDATE_PROOF_INVALID", "候选成果依据无效");
  const values = proof.proposals.map(parseOpcBusinessProposalV2);
  if (new Set(values.map(item => item.key)).size !== values.length) fail("OPC_CANDIDATE_PROOF_INVALID", "成果包含重复的提议标识");
  const proposal = values.find(item => item.key === key);
  if (!proposal) fail("OPC_CANDIDATE_PROPOSAL_NOT_FOUND", "成果中没有所选提议");
  for (const ref of proposal.evidenceRefs) if (!proof.sourceRefs.some(source => sha256(source) === sha256(ref)))
    fail("OPC_CANDIDATE_SOURCE_INVALID", "提议引用了未获授权的来源");
  if (proposal.command.type === "delivery.record") {
    const artifactRef = opcBusinessCandidateArtifactRef(origin);
    if (!["current-goal-output", artifactRef].includes(proposal.command.artifactRef))
      fail("OPC_CANDIDATE_SOURCE_INVALID", "交付提议必须绑定本项成果");
    return { ...proposal, command: { ...proposal.command, artifactRef } };
  }
  return proposal;
}
function assertCommandScope(state: BusinessStateV1, proposal: OpcBusinessProposalV2): void {
  const has = (kind: string, id: string) => proposal.evidenceRefs.some(ref => ref.namespace === `opc.business.${kind}` && ref.resourceId === id);
  const command = proposal.command;
  if (command.type === "quote.create") {
    if (!has("customer", command.customerId) || !has("service", command.serviceId)
      || state.services.filter(item => item.id === command.serviceId).at(-1)?.version !== command.serviceVersion)
      fail("OPC_CANDIDATE_SOURCE_INVALID", "报价提议需引用当前客户和产品服务版本");
  } else if (command.type === "delivery.record") {
    if (!has("order", command.orderId)) fail("OPC_CANDIDATE_SOURCE_INVALID", "交付提议需引用本订单");
  } else if (!proposal.evidenceRefs.some(ref => ref.namespace.startsWith("opc.business.")))
    fail("OPC_CANDIDATE_SOURCE_INVALID", "经营复盘需引用获准的经营事实");
}
const labels: Readonly<Record<string, string>> = {
  id: "记录标识", customerId: "客户", customerVersion: "客户版本", serviceId: "产品服务", serviceVersion: "产品服务版本", quantity: "数量",
  discountMinor: "优惠金额（分）", totalMinor: "报价金额（分）", validUntil: "报价有效期", dueOn: "付款期限", notes: "备注",
  orderId: "订单", title: "标题", deliveredOn: "交付日期", artifactRef: "成果版本", progressPercent: "本次交付比例",
  period: "复盘期间", sourceStreamVersion: "事实版本", summary: "确定性经营汇总", explanation: "事实解释", nextDecisions: "后续决定",
};
function preview(state: BusinessStateV1, proposal: OpcBusinessProposalV2, options: BusinessScope & { now: () => string }): {
  changes: readonly OpcBusinessCandidateChangeV2[]; impact: OpcBusinessCandidateImpactV2; previewDigest: string;
} {
  assertCommandScope(state, proposal);
  const next = applyBusinessCommand(state, proposal.command, { principalId: options.principalId, occurredAt: options.now() });
  const collection = proposal.command.type === "quote.create" ? "quotes" : proposal.command.type === "delivery.record" ? "deliveries" : "reviews";
  const record = next[collection].at(-1)!;
  const changes = Object.entries(record).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).filter(([field]) => !["recordedAt", "recordedBy"].includes(field)).map(([field, value]) => ({
    path: `${collection}/${record.id}/${field}`, label: labels[field] ?? field, before: null, after: value as JsonValue,
  }));
  const before = calculateBusinessSummary(state), after = calculateBusinessSummary(next);
  const impact: OpcBusinessCandidateImpactV2 = { currency: "CNY",
    ...(proposal.command.type === "quote.create" ? { quoteTotalMinor: next.quotes.at(-1)!.totalMinor } : {}),
    contractedDeltaMinor: String(BigInt(after.contractedMinor) - BigInt(before.contractedMinor)),
    outstandingDeltaMinor: String(BigInt(after.outstandingMinor) - BigInt(before.outstandingMinor)),
    cashReceivedDeltaMinor: String(BigInt(after.cashReceivedMinor) - BigInt(before.cashReceivedMinor)) };
  return { changes, impact, previewDigest: sha256({ businessStreamVersion: state.streamVersion, command: proposal.command, changes, impact }) };
}
function stored(tx: KernelTransaction, options: BusinessScope, candidateId: string): OpcBusinessCandidateV2 {
  const candidate = tx.getProjection<OpcBusinessCandidateV2>(OPC_BUSINESS_CANDIDATE_NAMESPACE, candidateId);
  if (!candidate || candidate.tenantId !== options.tenantId || candidate.workspaceId !== options.workspaceId)
    fail("OPC_CANDIDATE_NOT_FOUND", "经营候选不存在");
  const { digest, ...body } = candidate;
  if (candidate.schemaVersion !== "1" || sha256(body) !== digest) fail("OPC_CANDIDATE_INTEGRITY", "经营候选摘要不匹配");
  return candidate;
}
function prove(tx: KernelTransaction, options: OpcBusinessCandidateOptions, candidate: OpcBusinessCandidateV2, purpose: "read" | "apply") {
  const proof = options.ports.readOutput(tx, options, candidate.origin, purpose);
  if (sha256(selectedProposal(proof, candidate.origin, candidate.proposal.key)) !== sha256(candidate.proposal)
    || sha256(proof.sourceRefs) !== sha256(candidate.sourceRefs)) fail("OPC_CANDIDATE_PROOF_INVALID", "候选与固定成果或来源不一致");
  return proof;
}
function detail(tx: KernelTransaction, options: OpcBusinessCandidateOptions, candidate: OpcBusinessCandidateV2): OpcBusinessCandidateDetailV2 {
  const proof = prove(tx, options, candidate, "read");
  const decision = tx.getProjection<OpcBusinessCandidateDecisionV2>(OPC_BUSINESS_CANDIDATE_DECISION_NAMESPACE, candidate.id) ?? null;
  if (decision && (decision.candidateId !== candidate.id || decision.candidateDigest !== candidate.digest))
    fail("OPC_CANDIDATE_INTEGRITY", "候选决定与固定内容不一致");
  const state = currentOpcBusiness(tx, options.workspaceId), reasons: string[] = [];
  if (!decision) {
    if (state.streamVersion !== candidate.businessStreamVersion) reasons.push("BUSINESS_VERSION_CHANGED");
    if (candidate.proposal.command.type === "delivery.record" && !proof.accepted) reasons.push("GOAL_ACCEPTANCE_REQUIRED");
    if (!reasons.length) try { prove(tx, options, candidate, "apply"); }
    catch (error) { if (error instanceof KernelError) reasons.push(error.code); else throw error; }
    if (!reasons.length) try {
      if (preview(state, candidate.proposal, options).previewDigest !== candidate.previewDigest) reasons.push("PREVIEW_CHANGED");
    } catch { reasons.push("BUSINESS_RULE_CHANGED"); }
  }
  let canWrite = true;
  try { assertBusinessAccess(tx, options, true); } catch { canWrite = false; }
  return { candidate, streamVersion: decision ? 2 : 1, decision,
    availability: { apply: !decision && canWrite && !reasons.length, reject: !decision && canWrite, staleReasons: reasons } };
}
function event(tx: KernelTransaction, options: BusinessOptions, candidateId: string, version: number, action: string, key: string): void {
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: OPC_BUSINESS_CANDIDATE_NAMESPACE, aggregateId: candidateId,
    expectedStreamVersion: version, type: `${eventType}.${action}`, actorId: options.principalId, generation: 0,
    correlationId: sha256([candidateId, key]), publicPayload: { workspaceId: options.workspaceId, candidateId, action } });
}
export async function createOpcBusinessCandidate(options: OpcBusinessCandidateOptions, value: CreateOpcBusinessCandidateV2, key: string): Promise<OpcBusinessCandidateDetailV2> {
  const input = parseCreateOpcBusinessCandidateV2(value); matchScope(options, input.workspaceId);
  const scope = `${OPC_BUSINESS_CANDIDATE_NAMESPACE}:create:${options.workspaceId}`;
  const requestDigest = sha256({ input, principalId: options.principalId });
  return options.store.transact(options.tenantId, tx => {
    assertBusinessAccess(tx, options, true);
    const previous = tx.getIdempotency(scope, key);
    if (previous) {
      if (previous.requestDigest !== requestDigest) fail("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同候选");
      const response = previous.response as OpcBusinessCandidateDetailV2;
      prove(tx, options, stored(tx, options, response.candidate.id), "read");
      return response;
    }
    const state = currentOpcBusiness(tx, options.workspaceId);
    const proof = options.ports.readOutput(tx, options, input.origin, "create");
    const proposal = selectedProposal(proof, input.origin, input.proposalKey);
    if (proof.sourceRefs.some(ref => ref.namespace.startsWith("opc.business.") && ref.streamVersion !== state.streamVersion))
      fail("OPC_CANDIDATE_STALE", "经营来源版本已变化");
    if (proposal.command.type === "delivery.record" && !proof.accepted) fail("GOAL_ACCEPTANCE_REQUIRED", "先接收明确的成果版本再登记交付");
    if (tx.listProjections<OpcBusinessCandidateV2>(OPC_BUSINESS_CANDIDATE_NAMESPACE).filter(item => item.workspaceId === options.workspaceId).length >= 1000)
      fail("BUSINESS_LIMIT_EXCEEDED", "工作区经营候选已达到上限");
    const body = { schemaVersion: "1" as const, id: `opc-candidate-${randomUUID()}`, tenantId: options.tenantId, workspaceId: options.workspaceId,
      origin: input.origin, proposal, sourceRefs: proof.sourceRefs, businessStreamVersion: state.streamVersion,
      ...preview(state, proposal, options), createdAt: options.now(), createdBy: options.principalId };
    const candidate: OpcBusinessCandidateV2 = { ...body, digest: sha256(body) };
    tx.putProjection(OPC_BUSINESS_CANDIDATE_NAMESPACE, candidate.id, candidate);
    event(tx, options, candidate.id, 0, "created", key);
    const response = detail(tx, options, candidate);
    tx.putIdempotency({ tenantId: options.tenantId, scope, key, requestDigest, response, createdAt: options.now() });
    return response;
  });
}
export async function getOpcBusinessCandidate(options: OpcBusinessCandidateOptions, candidateId: string): Promise<OpcBusinessCandidateDetailV2> {
  return options.store.transact(options.tenantId, tx => { assertBusinessAccess(tx, options, false); return detail(tx, options, stored(tx, options, candidateId)); });
}
export async function listOpcBusinessCandidates(options: OpcBusinessCandidateOptions, goalId?: string): Promise<OpcBusinessCandidateListV2> {
  return options.store.transact(options.tenantId, tx => {
    assertBusinessAccess(tx, options, false);
    return { items: tx.listProjections<OpcBusinessCandidateV2>(OPC_BUSINESS_CANDIDATE_NAMESPACE)
      .filter(item => item.tenantId === options.tenantId && item.workspaceId === options.workspaceId && (!goalId || item.origin.goalId === goalId))
      .map(item => detail(tx, options, stored(tx, options, item.id))) };
  });
}
export async function decideOpcBusinessCandidate(options: OpcBusinessCandidateOptions, candidateId: string, value: DecideOpcBusinessCandidateV2, key: string): Promise<OpcBusinessCandidateDetailV2> {
  const input = parseDecideOpcBusinessCandidateV2(value); matchScope(options, input.workspaceId);
  const scope = `${OPC_BUSINESS_CANDIDATE_NAMESPACE}:decide:${candidateId}`;
  const requestDigest = sha256({ input, principalId: options.principalId, workspaceId: options.workspaceId });
  return options.store.transact(options.tenantId, tx => {
    assertBusinessAccess(tx, options, true);
    const candidate = stored(tx, options, candidateId);
    prove(tx, options, candidate, "read");
    const previous = tx.getIdempotency(scope, key);
    if (previous) {
      if (previous.requestDigest !== requestDigest) fail("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同候选决定");
      return previous.response as OpcBusinessCandidateDetailV2;
    }
    if (input.candidateDigest !== candidate.digest || input.previewDigest !== candidate.previewDigest)
      fail("OPC_CANDIDATE_INTEGRITY", "候选内容或预览已变化");
    if (input.expectedStreamVersion !== 1 || tx.getProjection(OPC_BUSINESS_CANDIDATE_DECISION_NAMESPACE, candidateId))
      fail("STREAM_VERSION_CONFLICT", "候选已有决定或版本已变化");
    const state = currentOpcBusiness(tx, options.workspaceId);
    if (input.decision === "apply") {
      if (input.expectedBusinessStreamVersion !== state.streamVersion || state.streamVersion !== candidate.businessStreamVersion)
        fail("OPC_CANDIDATE_STALE", "经营事实已变化，不能直接采纳旧候选");
      const proof = prove(tx, options, candidate, "apply");
      if (candidate.proposal.command.type === "delivery.record" && !proof.accepted) fail("GOAL_ACCEPTANCE_REQUIRED", "成果接收状态已变化");
      let refreshed: ReturnType<typeof preview>;
      try { refreshed = preview(state, candidate.proposal, options); }
      catch { return fail("OPC_CANDIDATE_STALE", "当前经营规则或期限不再允许此候选"); }
      if (refreshed.previewDigest !== candidate.previewDigest) fail("OPC_CANDIDATE_STALE", "经营候选预览已变化");
      commandOpcBusinessInTransaction(tx, { ...options, expectedStreamVersion: state.streamVersion, command: candidate.proposal.command,
        correlationId: sha256([candidateId, key]) });
    } else if (input.expectedBusinessStreamVersion !== candidate.businessStreamVersion) fail("STREAM_VERSION_CONFLICT", "拒绝决定需引用该候选的事实版本");
    const decision: OpcBusinessCandidateDecisionV2 = { candidateId, candidateDigest: candidate.digest, decision: input.decision,
      decidedBy: options.principalId, decidedAt: options.now(), businessStreamVersion: state.streamVersion + (input.decision === "apply" ? 1 : 0) };
    tx.putProjection(OPC_BUSINESS_CANDIDATE_DECISION_NAMESPACE, candidateId, decision);
    event(tx, options, candidateId, 1, "decided", key);
    const response = detail(tx, options, candidate);
    tx.putIdempotency({ tenantId: options.tenantId, scope, key, requestDigest, response, createdAt: options.now() });
    return response;
  });
}
