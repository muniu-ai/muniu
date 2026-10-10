// SPDX-License-Identifier: Apache-2.0
import { recordTeamExternalGoalUsage } from './team-goals.js';
import { isBusinessContextRef, assertBusinessContextRef } from "./business-context.js";
import { assertAssetReader } from "./asset-context.js";
import { scheduleGoal } from "./goal-scheduling.js";
import { isCoordinatedGoalDetail, parseTeamSkillRefV2, type AgentSchedulingRequestV2, type TeamTemplateIdV1 } from "@mn/contracts";
import type { GoalBudgetV2, GoalDeliverableSpecV2, GoalDeliveryItemDecisionV2, GoalResourceRefV2 } from "@mn/contracts";
import { KernelError } from "@mn/kernel";
import { acceptGoalDelivery, recordExternalGoalUsage, cancelGoal, createGoal, getGoal, getGoalForCoordination, listGoals, replayGoalPlan, proposeGoalPlan, startGoal } from "./goals.js";
import { createHostGoalRuntime, goalThreadResources, type HostGoalRuntimeOptions } from "./goal-runtime.js";
import { createHostTeamRuntime } from "./team-runtime.js";
import { proposeHostTeamPlan } from "./team-planning.js";
import { acceptTeamGoalDelivery, commandTeamGoal, getTeamGoal, proposeTeamGoalPlan, replayTeamGoalPlan, startTeamGoal } from "./team-goals.js";
import { createGoalDeliveryService } from "./goal-delivery-runtime.js";
import { getGoalDeliveryReview, decideGoalDelivery, previewGoalRework, confirmGoalRework } from "./goal-delivery-service.js";
import { validateHistoricalHostContextSource } from "./context-source-validation.js";
import { readBoundedJsonBody } from "./http-body.js";

export interface GoalRequestOptions extends HostGoalRuntimeOptions { readonly request: Request; readonly tenantId: string; readonly principalId: string; readonly mutationKey?: string; readonly teamSandboxAvailable?: (workspaceId: string) => Promise<boolean> }
function invalid(): never { throw new KernelError("GOAL_REQUEST_INVALID", "目标请求字段无效", "按目标接口要求填写字段"); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid(); return value as Record<string, unknown>; }
function text(value: unknown, limit = 200): string { if (typeof value !== "string" || !value.trim() || value.length > limit) invalid(); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number; }
function array(value: unknown, limit = 100): unknown[] { if (!Array.isArray(value) || value.length > limit) invalid(); return value; }
function resources(value: unknown): GoalResourceRefV2[] { return array(value).map(item => { const ref = object(item, ["namespace", "resourceId", "streamVersion", "digest"]); return { namespace: text(ref.namespace), resourceId: text(ref.resourceId), streamVersion: integer(ref.streamVersion), ...(ref.digest === undefined ? {} : { digest: text(ref.digest) }) }; }); }
function budget(value: unknown): GoalBudgetV2 { const input = object(value, ["maxTokens", "maxCostMinorUnits", "currency", "maxDurationMs"]); return { maxTokens: integer(input.maxTokens), maxCostMinorUnits: text(input.maxCostMinorUnits), currency: text(input.currency, 3), maxDurationMs: integer(input.maxDurationMs) }; }
function deliverables(value: unknown): GoalDeliverableSpecV2[] { return array(value, 20).map(item => { const input = object(item, ["key", "title", "required", "criteria"]); if (typeof input.required !== "boolean") invalid(); return { key: text(input.key), title: text(input.title), required: input.required, criteria: array(input.criteria, 20).map(value => { const criterion = object(value, ["id", "description"]); return { id: text(criterion.id), description: text(criterion.description, 2000) }; }) }; }); }
export async function dispatchGoalRequest(options: GoalRequestOptions): Promise<{ readonly data: unknown; readonly status: number } | undefined> {
  const url = new URL(options.request.url);
  const collection = /^\/v2\/workspaces\/([^/]+)\/goals$/u.exec(url.pathname);
  const templates = /^\/v2\/workspaces\/([^/]+)\/team-templates$/u.exec(url.pathname);
  const item = /^\/v2\/goals\/([^/]+)(?:\/(plan-revisions|commands|acceptances|nodes|delivery-decisions|rework-previews|reworks))?$/u.exec(url.pathname);
  if (!collection && !item && !templates) return undefined;
  const runtime = createHostGoalRuntime(options);
  if (options.request.method === "GET") {
    if (item?.[2] && item[2] !== "nodes") return undefined;
    if ((collection || templates) ? url.searchParams.size : url.searchParams.size !== 1 || url.searchParams.getAll("workspaceId").length !== 1) invalid();
    const workspaceId = (collection || templates) ? text(decodeURIComponent((collection || templates)![1]!)) : text(url.searchParams.get("workspaceId"));
    const scope = { tenantId: options.tenantId, principalId: options.principalId, workspaceId };
    const readOptions = { ...options, validateContextSource: validateHistoricalHostContextSource };
    const teamOptions = { ...readOptions, sandboxAvailable: await options.teamSandboxAvailable?.(workspaceId) ?? false };
    const teamRuntime = createHostTeamRuntime(teamOptions);
    if (templates) return { status: 200, data: await teamRuntime.templates(scope) };
    const service = await createHostGoalRuntime(readOptions).service(scope);
    if (collection) return { status: 200, data: await listGoals(service) };
    const goalId = text(decodeURIComponent(item![1]!));
    if (item![2] === "nodes") return { status: 200, data: await teamRuntime.progress(scope, goalId) };
    const detail = await getGoalForCoordination({ ...service, goalId });
    if (isCoordinatedGoalDetail(detail)) await getTeamGoal({ ...await teamRuntime.service(scope), goalId }); else await getGoal({ ...service, goalId });
    return { status: 200, data: await getGoalDeliveryReview({ ...await createGoalDeliveryService(teamOptions, scope), goalId }) };
  }
  if (options.request.method !== "POST" || templates || (!collection && (!item?.[2] || item[2] === "nodes"))) return undefined;
  if (url.searchParams.size) invalid();
  const idempotencyKey = options.mutationKey ?? options.request.headers.get("Idempotency-Key") ?? "";
  if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new KernelError("IDEMPOTENCY_KEY_REQUIRED", "目标变更需要幂等键", "为本次操作提供 Idempotency-Key");
  const body = await readBoundedJsonBody(options.request, { maxBytes: 128 * 1024 });
  const workspaceId = collection ? text(decodeURIComponent(collection[1]!)) : text(body.workspaceId);
  const scope = { tenantId: options.tenantId, principalId: options.principalId, workspaceId };
  const teamOptions = { ...options, sandboxAvailable: await options.teamSandboxAvailable?.(workspaceId) ?? false };
  const teamRuntime = createHostTeamRuntime(teamOptions);
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
  if (["delivery-decisions", "rework-previews", "reworks"].includes(item![2]!)) {
    const delivery = { ...await createGoalDeliveryService(teamOptions, scope), goalId, expectedStreamVersion, idempotencyKey };
    if (item![2] === "delivery-decisions") {
      object(body, ["workspaceId", "expectedStreamVersion", "deliverySetId", "criteriaVersion", "items"]);
      const items: GoalDeliveryItemDecisionV2[] = array(body.items, 20).map(value => {
        const input = object(value, ["key", "digest", "decision", "reviewedCriterionIds", "failedCriterionIds", "instruction", "reason"]);
        const shared = { key: text(input.key), digest: text(input.digest) };
        if (input.decision === "accept") {
          object(input, ["key", "digest", "decision", "reviewedCriterionIds"]);
          return { ...shared, decision: "accept", reviewedCriterionIds: array(input.reviewedCriterionIds, 20).map(value => text(value)) };
        }
        if (input.decision === "request_changes") {
          object(input, ["key", "digest", "decision", "failedCriterionIds", "instruction"]);
          return { ...shared, decision: "request_changes", failedCriterionIds: array(input.failedCriterionIds, 20).map(value => text(value)), instruction: text(input.instruction, 4000) };
        }
        if (input.decision !== "defer") invalid();
        object(input, ["key", "digest", "decision", "reason"]);
        return { ...shared, decision: "defer", ...(input.reason === undefined ? {} : { reason: text(input.reason, 4000) }) };
      });
      return { status: 200, data: await decideGoalDelivery({ ...delivery, deliverySetId: text(body.deliverySetId), criteriaVersion: text(body.criteriaVersion), items }) };
    }
    if (item![2] === "rework-previews") {
      object(body, ["workspaceId", "expectedStreamVersion", "decisionId"]);
      return { status: 200, data: await previewGoalRework({ ...delivery, decisionId: text(body.decisionId) }) };
    }
    object(body, ["workspaceId", "expectedStreamVersion", "previewId", "previewDigest"]);
    return { status: 200, data: await confirmGoalRework({ ...delivery, previewId: text(body.previewId), previewDigest: text(body.previewDigest) }) };
  }
  if (item![2] === "plan-revisions") {
    if (body.kind !== undefined) {
      object(body, ["workspaceId", "expectedStreamVersion", "kind", "templateId", "templateVersion", "modelBindingId", "skillRef"]);
      if (body.kind !== "team-v1" || body.templateVersion !== "1" || !["research-summary", "business-proposal", "code-delivery"].includes(String(body.templateId))) invalid();
      const planRequest = { kind: "team-v1" as const, templateId: body.templateId as TeamTemplateIdV1, templateVersion: "1" as const, modelBindingId: text(body.modelBindingId), ...(body.skillRef === undefined ? {} : { skillRef: parseTeamSkillRefV2(body.skillRef) }) };
      const teamService = await teamRuntime.service(scope), teamBase = { ...base, ...teamService };
      const replay = await replayTeamGoalPlan(teamBase, planRequest);
      if (replay) return { status: 200, data: replay };
      const detail = await getGoalForCoordination(base);
      const proposal = await options.store.transact(scope.tenantId, tx => proposeHostTeamPlan(teamOptions, tx, detail.goal, planRequest.templateId, planRequest.modelBindingId, planRequest.skillRef));
      return { status: 200, data: await proposeTeamGoalPlan({ ...teamBase, proposal, planRequest }) };
    }
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
    object(body, command === "record_external_usage" ? ["workspaceId", "expectedStreamVersion", "command", "usage", "source"] : command === "start" ? ["workspaceId", "expectedStreamVersion", "command", "planRevisionId", "planDigest"]
      : command === "decide" ? ["workspaceId", "expectedStreamVersion", "command", "nodeId", "decision"] : ["workspaceId", "expectedStreamVersion", "command"]);
    const current = await getGoalForCoordination(base);
    if (isCoordinatedGoalDetail(current)) {
      if (command === "record_external_usage") {
        const value = object(body.usage, ["tokens", "costMinorUnits", "currency"]);
        let prepared, accountingOnly = false;
        try { prepared = await teamRuntime.service(scope, current); }
        catch { accountingOnly = true; prepared = await teamRuntime.service(scope, current, true); }
        return { status: 200, data: await recordTeamExternalGoalUsage({ ...base, ...prepared, accountingOnly,
          usage: { tokens: integer(value.tokens), costMinorUnits: text(value.costMinorUnits), currency: text(value.currency, 3) }, source: text(body.source, 2000) }) };
      }
      if (!["start", "refresh", "cancel", "pause", "resume", "decide"].includes(command)) invalid();
      if (command === "refresh") return { status: 200, data: await teamRuntime.refresh({ ...base, ...await teamRuntime.service(scope) }) };
      const prepared = { ...base, ...await teamRuntime.service(scope, current, command === "cancel" || command === "pause") };
      if (command === "start") return { status: 200, data: await startTeamGoal({ ...prepared, planRevisionId: text(body.planRevisionId), planDigest: text(body.planDigest) }) };
      if (command === "decide") {
        if (body.decision !== "continue" && body.decision !== "stop") invalid();
        return { status: 200, data: await commandTeamGoal({ ...prepared, command, nodeId: text(body.nodeId), decision: body.decision }) };
      }
      if (command === "pause" || command === "resume" || command === "cancel") return { status: 200, data: await commandTeamGoal({ ...prepared, command }) };
      return invalid();
    }
    if (command === "decide" || command === "pause" || command === "resume") invalid();
    const detail = command === "start" ? await getGoal(base) : current;
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
  const acceptance = { deliverySetId: text(body.deliverySetId), criteriaVersion: text(body.criteriaVersion), items: array(body.items, 20).map(value => {
    const item = object(value, ["key", "digest", "reviewedCriterionIds"]);
    return { key: text(item.key), digest: text(item.digest), reviewedCriterionIds: array(item.reviewedCriterionIds, 20).map(value => text(value)) };
  }) };
  const detail = await getGoalForCoordination(base);
  return { status: 200, data: isCoordinatedGoalDetail(detail) ? await acceptTeamGoalDelivery({ ...base, ...await teamRuntime.service(scope, detail), ...acceptance }) : await acceptGoalDelivery({ ...base, ...acceptance }) };
}

function scheduling(value: unknown): AgentSchedulingRequestV2 {
  const input = object(value, ["runnerId", "strategy", "modelBindingId", "expectedValueMinorUnits", "timeCostMinorUnitsPerHour"]);
  if (!["auto", "builtin", "codex-cli", "claude-cli"].includes(String(input.runnerId)) || !["quality", "balanced", "cost"].includes(String(input.strategy))) invalid();
  for (const key of ["expectedValueMinorUnits", "timeCostMinorUnitsPerHour"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !/^(0|[1-9][0-9]{0,17})$/u.test(input[key] as string))) invalid();
  if (input.modelBindingId !== undefined) text(input.modelBindingId);
  return input as unknown as AgentSchedulingRequestV2;
}
