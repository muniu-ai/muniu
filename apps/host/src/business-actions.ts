// SPDX-License-Identifier: Apache-2.0
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  computeBusinessOperationKey, parseBusinessDecisionV1, parseBusinessObjectSnapshotV1,
  type BusinessActionV1, type BusinessScopeV1, type CreateBusinessActionV2, type IssueQuotePackageInputV1,
} from "@mn/contracts";
import { BusinessActionLedger, KernelError, sha256, type BusinessActionState, type KernelStore } from "@mn/kernel";
import { assertBusinessAuthorityCurrent, type BusinessProviderPorts } from "@mn/worker";
export { createSalesBusinessProvider, businessAuthorityTokenResolver, loadBusinessProviderConfiguration } from "@mn/worker";

export function publicBusinessAction(action: BusinessActionState): BusinessActionV1 {
  const { dispatchStartedAt: _dispatch, admissionId: _admission, ...result } = action;
  return result;
}

export async function prepareBusinessAction(input: CreateBusinessActionV2, scope: BusinessScopeV1,
  ports: BusinessProviderPorts, now: string): Promise<IssueQuotePackageInputV1> {
  const snapshot = parseBusinessObjectSnapshotV1(await ports.snapshots.read({ schemaVersion: "1", scope,
    objectId: input.quoteId, version: input.quoteVersion, templateId: input.templateId, templateVersion: input.templateVersion }));
  const decision = parseBusinessDecisionV1(await ports.decisions.read({ schemaVersion: "1", scope, decisionId: input.decisionId }));
  if (snapshot.objectId !== input.quoteId || snapshot.version !== input.quoteVersion
    || snapshot.template.id !== input.templateId || snapshot.template.version !== input.templateVersion
    || sha256(snapshot.scope) !== sha256(scope) || sha256(decision.scope) !== sha256(scope)) {
    throw new KernelError("BUSINESS_SCOPE_MISMATCH", "业务系统返回了不同范围或版本的资料", "核对业务系统身份映射");
  }
  const draft: IssueQuotePackageInputV1 = {
    schemaVersion: "1", action: "issueQuotePackage", actionId: `action-${randomUUID()}`, operationKey: "pending", scope,
    quote: { id: snapshot.objectId, version: snapshot.version, digest: snapshot.digest },
    businessDecision: { id: decision.id, digest: decision.digest }, template: snapshot.template,
    renderVersion: input.renderVersion, exportFormat: input.exportFormat, issueDate: input.issueDate,
  };
  const action = { ...draft, operationKey: computeBusinessOperationKey(draft) };
  await assertBusinessAuthorityCurrent(ports, action, now);
  return action;
}

export async function businessExecutionAuthorityResponse(request: Request, actionId: string, options: {
  readonly store: KernelStore;
  readonly tokenResolver?: () => Promise<string>;
  readonly allowedScopes?: readonly { tenantId: string; workspaceId: string }[];
  readonly now?: () => string;
}): Promise<unknown> {
  let expected: string | undefined;
  try { expected = await options.tokenResolver?.(); } catch { expected = undefined; }
  const actual = request.headers.get("authorization")?.match(/^Bearer ([^\r\n]+)$/u)?.[1];
  if (!expected || !actual || Buffer.byteLength(expected) !== Buffer.byteLength(actual)
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual)))
    throw new KernelError("AUTHENTICATION_REQUIRED", "业务服务身份校验失败", "检查业务服务凭据");
  const query = new URL(request.url).searchParams;
  const tenantId = query.get("tenantId") ?? "";
  const ledger = new BusinessActionLedger(options.store, { ...(options.now ? { now: options.now } : {}) });
  const action = await ledger.get(tenantId, actionId);
  if (!action || !options.allowedScopes?.some(scope => scope.tenantId === tenantId && scope.workspaceId === action.workspaceId))
    throw new KernelError("BUSINESS_ACTION_NOT_FOUND", "业务动作不可访问", "检查工作区启用配置");
  const generation = Number(query.get("generation"));
  const fencingToken = Number(query.get("fencingToken"));
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(fencingToken) || fencingToken < 1)
    throw new KernelError("INVALID_BODY", "执行代次或租约标识无效", "使用Worker当前执行身份");
  const result = await ledger.authorizeExternal(tenantId, actionId, { executionId: query.get("executionId") ?? "", generation,
    jobId: query.get("jobId") ?? "", workerId: query.get("workerId") ?? "", fencingToken });
  return { ...result, actionId, operationKey: action.operationKey };
}
