// SPDX-License-Identifier: Apache-2.0
import { loadBusinessProviderConfiguration, createBusinessActionWorkerHandler,
  createBusinessCandidateWorkerHandler } from "@mn/worker";

export const BUSINESS_KINDS = Object.freeze(["business.action.execute", "business.candidate.extract"]);

export async function loadEnterpriseBusinessConfiguration({ kinds, workerEnabled = true, fixtureMode = false }) {
  const business = await loadBusinessProviderConfiguration("enterprise");
  if (!business) {
    if (kinds.some(kind => BUSINESS_KINDS.includes(kind))) throw new Error("BUSINESS_PROVIDER_REQUIRED：工业任务需要受信 Sales 配置");
    return undefined;
  }
  if (fixtureMode) throw new Error("BUSINESS_FIXTURE_FORBIDDEN：企业 fixture 不能接入工业业务服务");
  if (workerEnabled && BUSINESS_KINDS.some(kind => !kinds.includes(kind))) {
    throw new Error("BUSINESS_WORKER_CAPABILITY_MISSING：企业工业组合需要候选和动作处理器");
  }
  const workspaces = new Set();
  for (const scope of business.businessWorkspaceScopes) {
    if (scope.tenantId.trim() !== scope.tenantId || scope.workspaceId.trim() !== scope.workspaceId
      || workspaces.has(scope.workspaceId)) throw new Error("BUSINESS_SCOPE_AMBIGUOUS：工作区必须唯一绑定租户");
    workspaces.add(scope.workspaceId);
  }
  const authority = await business.businessAuthorityTokenResolver();
  if (/[\r\n]/u.test(authority)) throw new Error("业务执行授权凭据无效");
  return business;
}

export function createEnterpriseBusinessHandlers(business, context) {
  if (!business) return {};
  if (context.fixtureMode) throw new Error("BUSINESS_FIXTURE_FORBIDDEN：企业 fixture 不能接入工业业务服务");
  if (!context.composition?.context || context.composition.context.get("agentOsKernel") !== context.composition.kernel
    || !context.store?.transact || !context.store?.readEvents) throw new Error("企业工业 Worker 必须使用 Host 组合根和事务存储");
  if (!context.cas || !context.protectedPayloadKeyProvider || !context.secretStore?.read
    || !business.businessProvider.inquiries) throw new Error("企业工业 Worker 需要 CAS、Vault 和当前 Sales 资料端口");
  return Object.freeze({
    "business.action.execute": createBusinessActionWorkerHandler({
      store: context.store, kernel: context.composition.kernel, ports: business.businessProvider,
    }),
    "business.candidate.extract": createBusinessCandidateWorkerHandler({
      store: context.store, sourcePort: business.businessProvider.inquiries,
      runtimeProtection: { cas: context.cas, keyProvider: context.protectedPayloadKeyProvider },
      secretStore: context.secretStore,
      acceptsSecretReference: reference => /^vault:\/\/muniu\/v2\/models\/[a-zA-Z0-9._-]+$/u.test(reference),
      modelMode: "live",
    }),
  });
}
