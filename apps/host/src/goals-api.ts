// SPDX-License-Identifier: Apache-2.0
import { isBusinessContextRef, assertBusinessContextRef } from "./business-context.js";
import { assertAssetReader } from "./asset-context.js";
import { scheduleGoal } from "./goal-scheduling.js";
import type { AgentSchedulingRequestV2 } from "@mn/contracts";
import type { GoalBudgetV2, GoalDeliverableSpecV2, GoalResourceRefV2 } from "@mn/contracts";
import { KernelError } from "@mn/kernel";
import { acceptGoalDelivery, recordExternalGoalUsage, cancelGoal, createGoal, getGoal, getGoalForCoordination, listGoals, replayGoalPlan, proposeGoalPlan, startGoal } from "./goals.js";
import { createHostGoalRuntime, goalThreadResources, type HostGoalRuntimeOptions } from "./goal-runtime.js";
import { readBoundedJsonBody } from "./http-body.js";

export interface GoalRequestOptions extends HostGoalRuntimeOptions { readonly request: Request; readonly tenantId: string; readonly principalId: string; readonly mutationKey?: string }
function invalid(): never { throw new KernelError("GOAL_REQUEST_INVALID", "目标请求字段无效", "按目标接口要求填写字段"); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid(); return value as Record<string, unknown>; }
function text(value: unknown, limit = 200): string { if (typeof value !== "string" || !value.trim() || value.length > limit) invalid(); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number; }
function array(value: unknown, limit = 100): unknown[] { if (!Array.isArray(value) || value.length > limit) invalid(); return value; }
function resources(value: unknown): GoalResourceRefV2[] { return array(value).map(item => { const ref = object(item, ["namespace", "resourceId", "streamVersion", "digest"]); return { namespace: text(ref.namespace), resourceId: text(ref.resourceId), streamVersion: integer(ref.streamVersion), ...(ref.digest === undefined ? {} : { digest: text(ref.digest) }) }; }); }
function budget(value: unknown): GoalBudgetV2 { const input = object(value, ["maxTokens", "maxCostMinorUnits", "currency", "maxDurationMs"]); return { maxTokens: integer(input.maxTokens), maxCostMinorUnits: text(input.maxCostMinorUnits), currency: text(input.currency, 3), maxDurationMs: integer(input.maxDurationMs) }; }
function deliverables(value: unknown): GoalDeliverableSpecV2[] { return array(value, 1).map(item => { const input = object(item, ["key", "title", "required", "criteria"]); if (typeof input.required !== "boolean") invalid(); return { key: text(input.key), title: text(input.title), required: input.required, criteria: array(input.criteria, 20).map(value => { const criterion = object(value, ["id", "description"]); return { id: text(criterion.id), description: text(criterion.description, 2000) }; }) }; }); }
export async function dispatchGoalRequest(options: GoalRequestOptions): Promise<{ readonly data: unknown; readonly status: number } | undefined> {
  const url = new URL(options.request.url);
  const collection = /^\/v2\/workspaces\/([^/]+)\/goals$/u.exec(url.pathname);
  const item = /^\/v2\/goals\/([^/]+)(?:\/(plan-revisions|commands|acceptances))?$/u.exec(url.pathname);
  if (!collection && !item) return undefined;
  const runtime = createHostGoalRuntime(options);
  if (options.request.method === "GET") {
    if (item?.[2]) return undefined;
    if (collection ? url.searchParams.size : url.searchParams.size !== 1 || url.searchParams.getAll("workspaceId").length !== 1) invalid();
    const workspaceId = collection ? text(decodeURIComponent(collection[1]!)) : text(url.searchParams.get("workspaceId"));
    const service = await runtime.service({ tenantId: options.tenantId, principalId: options.principalId, workspaceId });
    return { status: 200, data: collection ? await listGoals(service) : await getGoal({ ...service, goalId: text(decodeURIComponent(item![1]!)) }) };
  }
  if (options.request.method !== "POST" || (!collection && !item?.[2])) return undefined;
  if (url.searchParams.size) invalid();
  const idempotencyKey = options.mutationKey ?? options.request.headers.get("Idempotency-Key") ?? "";
  if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new KernelError("IDEMPOTENCY_KEY_REQUIRED", "目标变更需要幂等键", "为本次操作提供 Idempotency-Key");
  const body = await readBoundedJsonBody(options.request, { maxBytes: 128 * 1024 });
  const workspaceId = collection ? text(decodeURIComponent(collection[1]!)) : text(body.workspaceId);
  const scope = { tenantId: options.tenantId, principalId: options.principalId, workspaceId };
  const service = await runtime.service(scope);
  if (collection) {
    object(body, ["threadId", "objective", "resourceRefs", "budget", "deliverables"]);
    const threadId = text(body.threadId), selected = resources(body.resourceRefs);
    const bound = await options.store.transact(scope.tenantId, tx => goalThreadResources(tx, scope, threadId));
    if (selected.some(ref => ref.namespace !== "asset" && !isBusinessContextRef(ref) && !bound.some(item => item.namespace === ref.namespace && item.resourceId === ref.resourceId))) invalid();
    await options.store.transact(scope.tenantId, tx => {
      for (const ref of selected.filter(item => item.namespace === "asset")) assertAssetReader(tx, scope, ref);
      for (const ref of selected.filter(isBusinessContextRef)) assertBusinessContextRef(tx, scope, ref);
    });
    if (new Set(selected.map(ref => `${ref.namespace}:${ref.resourceId}`)).size !== selected.length) invalid();
    for (const ref of bound) {
      const existing = selected.find(item => item.namespace === ref.namespace && item.resourceId === ref.resourceId);
      if (existing && (existing.streamVersion !== ref.streamVersion || (existing.digest && existing.digest !== ref.digest))) invalid();
      if (existing) selected.splice(selected.indexOf(existing), 1);
      selected.push(ref);
    }
    return { status: 201, data: await createGoal({ ...service, idempotencyKey, threadId, objective: text(body.objective, 16000), resourceRefs: selected, budget: budget(body.budget), deliverables: deliverables(body.deliverables) }) };
  }
  const goalId = text(decodeURIComponent(item![1]!)), expectedStreamVersion = integer(body.expectedStreamVersion);
  const base = { ...service, goalId, expectedStreamVersion, idempotencyKey };
  if (item![2] === "plan-revisions") {
    object(body, ["workspaceId", "expectedStreamVersion", "modelBindingId", "scheduling"]);
    const selection = body.scheduling === undefined ? undefined : scheduling(body.scheduling);
    if ((body.modelBindingId === undefined) === (selection === undefined)) invalid();
    const planRequest = selection ? { scheduling: selection } : { modelBindingId: text(body.modelBindingId) };
    const replay = await replayGoalPlan(base, planRequest);
    if (replay) return { status: 200, data: replay };
    const detail = await getGoal(base);
    const unavailableRunners: string[] = [];
    if (selection) await Promise.all((["codex-cli", "claude-cli"] as const).map(async runnerId => {
      try { if (!options.validateRunner) throw new Error("No trusted runner inspector"); await options.validateRunner(scope.workspaceId, runnerId); }
      catch { unavailableRunners.push(runnerId); }
    }));
    const proposal = await options.store.transact(scope.tenantId, tx => {
      if (!selection) return runtime.proposal(tx, detail.goal, text(body.modelBindingId));
      const decision = scheduleGoal(tx, detail.goal, selection, options.now(), unavailableRunners);
      const chosen = decision.candidates.find(candidate => candidate.id === decision.selectedId)!;
      return { ...runtime.proposal(tx, detail.goal, chosen.modelBindingId, chosen.runnerId), scheduling: decision };
    });
    if (proposal.runnerId !== "builtin") await options.validateRunner?.(scope.workspaceId, proposal.runnerId);
    return { status: 200, data: await proposeGoalPlan({ ...base, proposal, planRequest }) };
  }
  if (item![2] === "commands") {
    const command = text(body.command);
    object(body, command === "record_external_usage" ? ["workspaceId", "expectedStreamVersion", "command", "usage", "source"] : command === "start" ? ["workspaceId", "expectedStreamVersion", "command", "planRevisionId", "planDigest"] : ["workspaceId", "expectedStreamVersion", "command"]);
    const detail = await (command === "start" ? getGoal(base) : getGoalForCoordination(base));
    const prepared = { ...base, ...await runtime.service(scope, (command === "start" || command === "record_external_usage") ? detail : undefined, command === "start") };
    if (command === "record_external_usage") {
      const value = object(body.usage, ["tokens", "costMinorUnits", "currency"]);
      return { status: 200, data: await recordExternalGoalUsage({ ...prepared, usage: { tokens: integer(value.tokens), costMinorUnits: text(value.costMinorUnits), currency: text(value.currency, 3) }, source: text(body.source, 2000) }) };
    }
    if (command === "start") return { status: 200, data: await startGoal({ ...prepared, planRevisionId: text(body.planRevisionId), planDigest: text(body.planDigest) }) };
    if (command === "refresh") return { status: 200, data: await runtime.refresh(prepared) };
    if (command === "cancel") return { status: 200, data: await cancelGoal(prepared) };
    return invalid();
  }
  object(body, ["workspaceId", "expectedStreamVersion", "deliverySetId", "criteriaVersion", "items"]);
  return { status: 200, data: await acceptGoalDelivery({ ...base, deliverySetId: text(body.deliverySetId), criteriaVersion: text(body.criteriaVersion), items: array(body.items, 20).map(value => {
    const item = object(value, ["key", "digest", "reviewedCriterionIds"]);
    return { key: text(item.key), digest: text(item.digest), reviewedCriterionIds: array(item.reviewedCriterionIds, 20).map(value => text(value)) };
  }) }) };
}

function scheduling(value: unknown): AgentSchedulingRequestV2 {
  const input = object(value, ["runnerId", "strategy", "modelBindingId", "expectedValueMinorUnits", "timeCostMinorUnitsPerHour"]);
  if (!["auto", "builtin", "codex-cli", "claude-cli"].includes(String(input.runnerId)) || !["quality", "balanced", "cost"].includes(String(input.strategy))) invalid();
  for (const key of ["expectedValueMinorUnits", "timeCostMinorUnitsPerHour"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !/^(0|[1-9][0-9]{0,17})$/u.test(input[key] as string))) invalid();
  if (input.modelBindingId !== undefined) text(input.modelBindingId);
  return input as unknown as AgentSchedulingRequestV2;
}
