// SPDX-License-Identifier: Apache-2.0
import {
  parseBusinessScopeV1, parseIssueQuotePackageInputV1,
  type BusinessScopeV1, type IssueQuotePackageInputV1, type JsonObject,
} from "@mn/contracts";

export type {
  BusinessObjectSnapshotPortV1, BusinessDecisionPortV1,
  EffectActionPortV1, EffectReceiptAndReconciliationPortV1,
} from "@mn/contracts";

export interface BusinessEffectPreparationContextV1 {
  readonly scope: BusinessScopeV1;
  readonly signal: AbortSignal;
}

/** The Host owns execution; plugins cannot supply a competing dispatch function. */
export interface BusinessEffectToolV1 {
  readonly id: string;
  readonly version: string;
  readonly action: "issueQuotePackage";
  readonly effectClass: "external_side_effect";
  prepare(arguments_: JsonObject, context: BusinessEffectPreparationContextV1): Promise<IssueQuotePackageInputV1>;
}

export function defineBusinessEffectToolV1(definition: BusinessEffectToolV1): BusinessEffectToolV1 {
  if (!definition || typeof definition !== "object"
    || Object.keys(definition).some(key => !["id", "version", "action", "effectClass", "prepare"].includes(key))
    || typeof definition.id !== "string" || !definition.id.trim()
    || typeof definition.version !== "string" || !definition.version.trim()
    || definition.action !== "issueQuotePackage" || definition.effectClass !== "external_side_effect"
    || typeof definition.prepare !== "function") throw new TypeError("业务工具定义无效");
  const prepare = definition.prepare.bind(definition);
  return Object.freeze({ id: definition.id, version: definition.version, action: definition.action, effectClass: definition.effectClass,
    async prepare(arguments_: JsonObject, context: BusinessEffectPreparationContextV1): Promise<IssueQuotePackageInputV1> {
      const scope = parseBusinessScopeV1(context.scope);
      context.signal.throwIfAborted();
      const result = parseIssueQuotePackageInputV1(await prepare(structuredClone(arguments_), { scope, signal: context.signal }));
      context.signal.throwIfAborted();
      if (result.scope.tenantId !== scope.tenantId || result.scope.workspaceId !== scope.workspaceId
        || result.scope.principalId !== scope.principalId || result.scope.customerId !== scope.customerId) {
        throw new TypeError("业务工具不能改变调用范围");
      }
      return result;
    },
  });
}
