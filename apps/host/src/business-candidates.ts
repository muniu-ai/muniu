// SPDX-License-Identifier: Apache-2.0
import { randomUUID, timingSafeEqual } from "node:crypto";
import { parseBusinessScopeV1, parseRfqModelOutputV1, parseSalesInquirySnapshotV1,
  type BusinessCandidateContentV1, type BusinessCandidateV1, type BusinessInquirySourcePortV1,
  type BusinessScopeV1, type CreateBusinessCandidateV2, type JsonObject, type RfqCandidateV1 } from "@mn/contracts";
import { BusinessCandidateLedger, assertBusinessCandidateMember, findModelPrice, KernelError, PROTECTED_PAYLOAD_KEY_NAMESPACE, sha256,
  type BusinessCandidateState, type KernelStore, type ModelConnection } from "@mn/kernel";
import { readProtectedJson, storeProtectedJson, type ContentAddressedStorage, type KeyProvider, type ProtectedJsonKeyRecordV1 } from "@mn/storage";

export interface BusinessCandidateHostOptions {
  readonly store: KernelStore;
  readonly cas: ContentAddressedStorage;
  readonly keyProvider: KeyProvider;
  readonly now?: () => string;
}
export function publicBusinessCandidate(state: BusinessCandidateState): BusinessCandidateV1 {
  const { sourceProtectedPayloadRef: _source, candidateProtectedPayloadRef: _result,
    modelConnectionId: _model, modelConnectionVersion: _modelVersion, budget: _budget, ...visible } = state;
  return visible;
}

export async function createBusinessCandidate(input: CreateBusinessCandidateV2, scope: BusinessScopeV1, idempotencyKey: string,
  options: BusinessCandidateHostOptions & { readonly sourcePort: BusinessInquirySourcePortV1 }): Promise<BusinessCandidateState> {
  if (input.workspaceId !== scope.workspaceId || input.customerId !== scope.customerId) throw new KernelError("BUSINESS_SCOPE_MISMATCH", "候选输入范围不匹配", "重新选择当前客户与工作区");
  const model = await options.store.transact(scope.tenantId, tx => {
    assertBusinessCandidateMember(tx, { scope });
    const models = tx.listProjections<ModelConnection>("modelConnection").filter(item => item.tenantId === scope.tenantId && item.status === "ready");
    return models.find(item => item.defaultForNewExecutions) ?? models[0];
  });
  if (!model) throw new KernelError("MODEL_CONNECTION_REQUIRED", "尚未连接可用模型", "连接自有模型后再生成询价候选");
  const price = findModelPrice(model.presetId, model.defaultModel);
  if (!price) throw new KernelError("MODEL_PRICE_REQUIRED", "当前模型缺少可核对的费用规则", "选择已支持预算预检的模型");
  const source = parseSalesInquirySnapshotV1(await options.sourcePort.read({ schemaVersion: "1", scope,
    objectId: input.inquiryId, revision: input.inquiryRevision }));
  if (sha256(source.scope) !== sha256(scope) || source.inquiryId !== input.inquiryId || source.inquiryRevision !== input.inquiryRevision)
    throw new KernelError("BUSINESS_SOURCE_MISMATCH", "业务服务返回了不同范围或版本的询价", "刷新当前询价后重试");
  const id = `candidate-${randomUUID()}`;
  const protectedSource = await storeProtectedJson({ ...options, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    ownerType: "business-candidate-source", ownerId: id, protectedPayloadRef: `candidate-source-${randomUUID()}`,
    value: source as unknown as JsonObject, createdAt: options.now?.() ?? new Date().toISOString() });
  return new BusinessCandidateLedger(options.store, { ...(options.now ? { now: options.now } : {}) }).create({
    id, scope, inquiryId: source.inquiryId, inquiryRevision: source.inquiryRevision, sourceDigest: source.digest,
    sourceProtectedPayloadRef: protectedSource.protectedPayloadRef, sourceKeyRecord: protectedSource.keyRecord as unknown as JsonObject,
    modelConnectionId: model.id, modelConnectionVersion: model.streamVersion,
    budget: { maxTokens: 50_000, maxCostMinorUnits: "100", currency: price.rates.currency,
      maxDurationMs: 180_000, maxSubagentDepth: 0, maxSubagents: 0 },
  }, idempotencyKey);
}

async function readPayload(state: BusinessCandidateState, ref: string, ownerType: string, options: BusinessCandidateHostOptions): Promise<JsonObject> {
  const keyRecord = await options.store.transact(state.tenantId, tx => tx.getProjection<ProtectedJsonKeyRecordV1>(PROTECTED_PAYLOAD_KEY_NAMESPACE, ref));
  if (!keyRecord) throw new KernelError("BUSINESS_CANDIDATE_UNAVAILABLE", "候选保护密钥不可用", "检查受保护存储");
  return readProtectedJson({ ...options, tenantId: state.tenantId, workspaceId: state.workspaceId, ownerType,
    ownerId: state.id, protectedPayloadRef: ref, keyRecord });
}

export async function businessCandidateContentResponse(request: Request, candidateId: string, options: BusinessCandidateHostOptions & {
  readonly tokenResolver?: () => Promise<string>;
  readonly allowedScopes?: readonly { readonly tenantId: string; readonly workspaceId: string }[];
}): Promise<BusinessCandidateContentV1> {
  let expected: string | undefined;
  try { expected = await options.tokenResolver?.(); } catch { expected = undefined; }
  const actual = /^Bearer ([^\r\n]+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!expected || !actual || Buffer.byteLength(expected) !== Buffer.byteLength(actual)
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    throw new KernelError("AUTHENTICATION_REQUIRED", "候选业务服务身份校验失败", "检查专用业务服务凭据");
  }
  const query = new URL(request.url).searchParams;
  const scope = parseBusinessScopeV1({ tenantId: query.get("tenantId"), workspaceId: query.get("workspaceId"),
    principalId: query.get("principalId"), customerId: query.get("customerId") });
  if (!options.allowedScopes?.some(item => item.tenantId === scope.tenantId && item.workspaceId === scope.workspaceId))
    throw new KernelError("BUSINESS_CANDIDATE_NOT_FOUND", "询价候选不可访问", "检查工作区启用配置");
  const state = await new BusinessCandidateLedger(options.store).get(scope.tenantId, candidateId);
  if (!state || sha256(state.scope) !== sha256(scope)) throw new KernelError("BUSINESS_CANDIDATE_NOT_FOUND", "询价候选不可访问", "检查当前客户与执行身份");
  await options.store.transact(scope.tenantId, tx => assertBusinessCandidateMember(tx, state));
  if (state.status !== "completed" || !state.candidateDigest || !state.candidateProtectedPayloadRef)
    throw new KernelError("BUSINESS_CANDIDATE_NOT_READY", "候选尚无可采纳成果", "等待任务完成或处理失败原因");
  const candidate = await readPayload(state, state.candidateProtectedPayloadRef, "business-candidate", options) as unknown as RfqCandidateV1;
  if (sha256(candidate) !== state.candidateDigest || candidate.schemaVersion !== "1" || candidate.inquiryId !== state.inquiryId
    || candidate.inquiryRevision !== state.inquiryRevision || candidate.sourceDigest !== state.sourceDigest)
    throw new KernelError("BUSINESS_CANDIDATE_INTEGRITY", "候选摘要与来源不一致", "停止采纳并检查受保护成果");
  const source = parseSalesInquirySnapshotV1(await readPayload(state, state.sourceProtectedPayloadRef, "business-candidate-source", options));
  parseRfqModelOutputV1({ requirements: candidate.requirements, facts: candidate.facts, suggestions: candidate.suggestions,
    unknown: candidate.unknown, conflicts: candidate.conflicts }, source);
  return { schemaVersion: "1", id: state.id, scope: state.scope, digest: state.candidateDigest, candidate };
}
