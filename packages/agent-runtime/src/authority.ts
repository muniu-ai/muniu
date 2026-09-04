// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type {
  ExecutionBudget,
  RequestedSubagentAuthority,
  ResourceRef,
  RuntimeAuthority,
  ToolEffectClass,
} from "./types.js";

export class AuthorityAttenuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityAttenuationError";
  }
}

export class SubagentAuthorityAllocator {
  readonly #parent: RuntimeAuthority;
  #issued = 0;
  #reservedTokens = 0;
  #reservedCost = 0n;

  constructor(parent: RuntimeAuthority) {
    validateBudget(parent.budget, "父 Agent");
    this.#parent = snapshotRuntimeAuthority(parent);
  }

  allocate(request: RequestedSubagentAuthority): RuntimeAuthority {
    validateBudget(request.budget, "子 Agent");
    assertSubset(request.toolIds, this.#parent.toolIds, "子 Agent 工具权限超出父 Agent");
    assertDataSubset(request.dataScopes, this.#parent.dataScopes);
    assertSubset(request.effectClasses, this.#parent.effectClasses, "子 Agent 副作用权限超出父 Agent");
    assertBudgetAttenuated(request.budget, this.#parent.budget);

    if (this.#issued + 1 > this.#parent.budget.maxSubagents) {
      throw new AuthorityAttenuationError("子 Agent 累计数量超出父预算");
    }
    if (this.#reservedTokens + request.budget.maxTokens > this.#parent.budget.maxTokens) {
      throw new AuthorityAttenuationError("子 Agent 累计 token 超出父预算");
    }
    const requestedCost = BigInt(request.budget.maxCostMinorUnits);
    if (this.#reservedCost + requestedCost > BigInt(this.#parent.budget.maxCostMinorUnits)) {
      throw new AuthorityAttenuationError("子 Agent 累计费用超出父预算");
    }

    const material = {
      parentCommitment: this.#parent.commitment,
      ordinal: this.#issued + 1,
      toolIds: [...request.toolIds].sort(),
      dataScopes: [...request.dataScopes].sort(compareResource),
      effectClasses: [...request.effectClasses].sort(),
      budget: request.budget,
    };
    const child = snapshotRuntimeAuthority({
      commitment: createHash("sha256").update(canonicalJson(material)).digest("hex"),
      toolIds: [...request.toolIds],
      dataScopes: request.dataScopes.map((scope) => ({ ...scope })),
      effectClasses: [...request.effectClasses],
      budget: { ...request.budget },
    });
    this.#issued += 1;
    this.#reservedTokens += request.budget.maxTokens;
    this.#reservedCost += requestedCost;
    return child;
  }
}

export function snapshotRuntimeAuthority(authority: RuntimeAuthority): RuntimeAuthority {
  const toolIds = Object.freeze([...authority.toolIds]);
  const dataScopes = Object.freeze(authority.dataScopes.map((scope) => Object.freeze({ ...scope })));
  const effectClasses = Object.freeze([...authority.effectClasses]);
  const budget = Object.freeze({ ...authority.budget });
  return Object.freeze({
    commitment: authority.commitment,
    toolIds,
    dataScopes,
    effectClasses,
    budget,
  });
}

export function assertToolAuthority(
  authority: RuntimeAuthority,
  toolId: string,
  effectClass: ToolEffectClass,
  resourceRefs: readonly ResourceRef[],
): void {
  if (!authority.toolIds.includes(toolId)) {
    throw new AuthorityAttenuationError(`工具 ${toolId} 未获执行权限`);
  }
  if (!authority.effectClasses.includes(effectClass)) {
    throw new AuthorityAttenuationError(`副作用类型 ${effectClass} 未获执行权限`);
  }
  assertDataSubset(resourceRefs, authority.dataScopes);
}

function assertBudgetAttenuated(child: ExecutionBudget, parent: ExecutionBudget): void {
  if (child.maxSubagentDepth > Math.max(0, parent.maxSubagentDepth - 1)) {
    throw new AuthorityAttenuationError("子 Agent 深度未衰减");
  }
  if (child.maxSubagents > Math.max(0, parent.maxSubagents - 1)) {
    throw new AuthorityAttenuationError("子 Agent 数量未衰减");
  }
  if (child.maxTokens > parent.maxTokens) {
    throw new AuthorityAttenuationError("子 Agent token 超出父预算");
  }
  if (BigInt(child.maxCostMinorUnits) > BigInt(parent.maxCostMinorUnits)) {
    throw new AuthorityAttenuationError("子 Agent 费用超出父预算");
  }
  if (child.currency !== parent.currency) {
    throw new AuthorityAttenuationError("子 Agent 费用币种必须与父 Agent 相同");
  }
  if (child.maxDurationMs > parent.maxDurationMs) {
    throw new AuthorityAttenuationError("子 Agent 时间超出父预算");
  }
}

function validateBudget(budget: ExecutionBudget, owner: string): void {
  for (const [name, value] of [
    ["maxSubagentDepth", budget.maxSubagentDepth],
    ["maxSubagents", budget.maxSubagents],
    ["maxTokens", budget.maxTokens],
    ["maxDurationMs", budget.maxDurationMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AuthorityAttenuationError(`${owner} ${name} 无效`);
    }
  }
  if (!/^\d+$/u.test(budget.maxCostMinorUnits)) {
    throw new AuthorityAttenuationError(`${owner}费用无效`);
  }
}

function assertSubset<T>(child: readonly T[], parent: readonly T[], message: string): void {
  const allowed = new Set(parent);
  if (new Set(child).size !== child.length || child.some((item) => !allowed.has(item))) {
    throw new AuthorityAttenuationError(message);
  }
}

function assertDataSubset(child: readonly ResourceRef[], parent: readonly ResourceRef[]): void {
  const allowed = (candidate: ResourceRef): boolean => parent.some((scope) =>
    scope.namespace === candidate.namespace &&
    (scope.resourceId === "*" || scope.resourceId === candidate.resourceId) &&
    (scope.digest === undefined || scope.digest === candidate.digest));
  if (child.some((scope) => !allowed(scope))) {
    throw new AuthorityAttenuationError("子 Agent 数据范围超出父 Agent");
  }
}

function compareResource(left: ResourceRef, right: ResourceRef): number {
  return `${left.namespace}\u0000${left.resourceId}\u0000${left.digest ?? ""}`
    .localeCompare(`${right.namespace}\u0000${right.resourceId}\u0000${right.digest ?? ""}`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
