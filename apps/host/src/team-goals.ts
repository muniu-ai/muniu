// SPDX-License-Identifier: Apache-2.0
import { recordCoordinatedExternalUsage } from './goal-external-rework.js';
import type { CoordinationAttemptV2, CoordinationRunV2, Execution, GoalDeliveryAcceptanceV2, GoalDeliverySetV2, GoalOutputRefV2, GoalPlanV2,
  GoalResourceRefV2, GoalCoordinatedDetailV2, GoalTeamPlanProposalV2, GoalCoordinatedPlanV2, GoalUsageV2, GoalV2, Principal, Thread, Workspace, WorkspaceMembership } from "@mn/contracts";
import { appendKernelEvent, KernelError, sha256, type KernelStore, type KernelTransaction } from "@mn/kernel";
import type { ContentAddressedStorage, KeyProvider } from "@mn/storage";
import { GoalRuleError, validateGoalUsage } from "@mn/task-orchestration";
import type { GoalReworkAdmission } from "./goal-delivery-service.js";
import type { GoalScope } from "./goals.js";

export interface TeamGoalContext { readonly goal: GoalV2; readonly plan: GoalCoordinatedPlanV2; readonly reusedNodeIds?: readonly string[] }
export interface TeamGoalRunContext extends TeamGoalContext { readonly run: CoordinationRunV2 }
export interface TeamGoalObservation {
  readonly status: GoalV2["status"];
  readonly usage?: GoalUsageV2;
  readonly outputs?: readonly GoalOutputRefV2[];
  readonly reasonCode?: string;
}
export type TeamGoalCommand = "pause" | "resume" | "cancel" | "decide";
export interface TeamGoalCommandInput { readonly nodeId?: string; readonly decision?: "continue" | "stop" }
export interface TeamGoalApplicationPorts {
  assertResources(transaction: KernelTransaction, scope: GoalScope, refs: readonly GoalResourceRefV2[]): void;
  assertPlan(transaction: KernelTransaction, context: TeamGoalContext): void;
  start(transaction: KernelTransaction, context: TeamGoalContext & { readonly reworkAdmission?: GoalReworkAdmission }): CoordinationRunV2;
  advance(transaction: KernelTransaction, context: TeamGoalRunContext & { readonly accountingOnly?: boolean }): TeamGoalObservation;
  command(transaction: KernelTransaction, context: TeamGoalRunContext, command: TeamGoalCommand, input: TeamGoalCommandInput): CoordinationRunV2;
  assertAcceptance(transaction: KernelTransaction, context: TeamGoalContext & { readonly deliverySet: GoalDeliverySetV2 }): void;
}
export interface TeamGoalServiceOptions extends GoalScope {
  readonly store: KernelStore; readonly cas: ContentAddressedStorage; readonly keyProvider: KeyProvider;
  readonly protectedJournal: boolean; readonly ports: TeamGoalApplicationPorts;
  readonly now: () => string; readonly id: (kind: string) => string;
}
export interface TeamGoalMutationOptions extends TeamGoalServiceOptions {
  readonly goalId: string; readonly expectedStreamVersion: number; readonly idempotencyKey: string;
}
const GOAL = "goal.state", PLAN = "goal.plan", DELIVERY = "goal.deliverySet", ACCEPTANCE = "goal.deliveryAcceptance", RUN = "coordination.run";
function fail(code: string, message: string): never { throw new KernelError(code, message, "刷新目标、计划和权限后重试"); }
function protect(options: TeamGoalServiceOptions): void {
  if (!options.cas || !options.keyProvider || !options.protectedJournal) fail("PROTECTED_PAYLOAD_UNAVAILABLE", "团队目标需要受保护的事件存储");
}
function copy<T>(input: T): T {
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { return fail("GOAL_INPUT_INVALID", "目标输入必须是 JSON 数据"); }
  if (!encoded || Buffer.byteLength(encoded) > 512 * 1024) fail("GOAL_INPUT_INVALID", "目标输入过大");
  return JSON.parse(encoded) as T;
}
function integer(value: number, min = 0): boolean { return Number.isSafeInteger(value) && value >= min; }
function budgetIdentity(value: { readonly maxTokens: number; readonly maxCostMinorUnits: string; readonly currency: string }): string {
  return sha256({ maxTokens: value.maxTokens, maxCostMinorUnits: value.maxCostMinorUnits, currency: value.currency });
}
function usage(value: GoalUsageV2): void {
  try { validateGoalUsage(value); } catch (error) { if (error instanceof GoalRuleError) fail(error.code, error.message); throw error; }
}
function accountingObservation(value: TeamGoalObservation): TeamGoalObservation {
  return copy({ status: value.status, ...(value.usage ? { usage: value.usage } : {}), ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}) });
}
function member(tx: KernelTransaction, options: GoalScope): WorkspaceMembership {
  const workspace = tx.getProjection<Workspace>("workspace", options.workspaceId), principal = tx.getProjection<Principal>("principal", options.principalId);
  const value = tx.getProjection<WorkspaceMembership>("membership", `${options.workspaceId}:${options.principalId}`);
  if (!workspace || workspace.tenantId !== options.tenantId || !principal || principal.tenantId !== options.tenantId || principal.disabledAt
    || !value || value.tenantId !== options.tenantId || value.workspaceId !== options.workspaceId || value.principalId !== options.principalId
    || value.removedAt || !["owner", "operator"].includes(value.workspaceRole)) fail("WORKSPACE_ACCESS_DENIED", "无权访问此工作区目标");
  return value;
}
function resources(tx: KernelTransaction, options: TeamGoalServiceOptions, refs: readonly GoalResourceRefV2[]): void {
  if (!Array.isArray(refs) || refs.length > 100 || refs.some(ref => !ref || !ref.namespace || !ref.resourceId || !integer(ref.streamVersion, 1))) fail("GOAL_RESOURCE_DENIED", "目标资料引用无效");
  options.ports.assertResources(tx, options, refs);
}
function current(tx: KernelTransaction, options: GoalScope & { readonly goalId: string }, checkMembership = true): { goal: GoalV2; plan: GoalPlanV2 | null; deliverySet: GoalDeliverySetV2 | null } {
  if (checkMembership) member(tx, options);
  const goal = tx.getProjection<GoalV2>(GOAL, options.goalId);
  if (!goal || goal.tenantId !== options.tenantId || goal.workspaceId !== options.workspaceId) fail("GOAL_NOT_FOUND", "目标不存在");
  const plan = goal.planRevisionId ? tx.getProjection<GoalPlanV2>(PLAN, goal.planRevisionId) : undefined;
  if (goal.planRevisionId && (!plan || plan.goalId !== goal.id || plan.threadId !== goal.threadId)) fail("GOAL_PLAN_INVALID", "计划引用无效");
  if (plan) { const { digest, ...body } = plan; if (sha256(body) !== digest) fail("GOAL_PLAN_INVALID", "计划摘要无效"); }
  const deliverySet = goal.deliverySetId ? tx.getProjection<GoalDeliverySetV2>(DELIVERY, goal.deliverySetId) : undefined;
  if (goal.deliverySetId && (!deliverySet || deliverySet.goalId !== goal.id || deliverySet.planRevisionId !== plan?.id)) fail("GOAL_DELIVERY_INVALID", "交付集合引用无效");
  return { goal, plan: plan ?? null, deliverySet: deliverySet ?? null };
}
function team(detail: ReturnType<typeof current>): GoalCoordinatedDetailV2 {
  if (!detail.plan || !("kind" in detail.plan) || (detail.plan.kind !== "team-v1" && detail.plan.kind !== "single-v2")) fail("GOAL_TEAM_PLAN_REQUIRED", "此目标没有团队计划");
  return { ...detail, plan: detail.plan, ...(detail.goal.coordinationRef ? { runId: detail.goal.coordinationRef.runId } : {}) };
}
function runAt(tx: KernelTransaction, detail: TeamGoalContext): CoordinationRunV2 {
  const ref = detail.goal.coordinationRef, run = ref && tx.getProjection<CoordinationRunV2>(RUN, ref.runId);
  if (!ref || ref.planRevisionId !== detail.plan.id || !run || run.tenantId !== detail.goal.tenantId || run.workspaceId !== detail.goal.workspaceId
    || run.aggregateType !== "goal" || run.aggregateId !== detail.goal.id || run.threadId !== detail.goal.threadId
    || run.revisionId !== detail.plan.id || run.revisionDigest !== detail.plan.digest || run.initiatedBy !== detail.goal.principalId) fail("GOAL_EXECUTION_INVALID", "团队执行与固定计划版本不一致");
  return run;
}
function authorization(tx: KernelTransaction, options: TeamGoalServiceOptions, { goal, plan }: TeamGoalContext): void {
  const grant = goal.authorization, currentMember = member(tx, options);
  if (!grant || grant.principalId !== options.principalId || grant.membershipStreamVersion !== currentMember.streamVersion || grant.planDigest !== plan.digest) fail("GOAL_AUTHORIZATION_STALE", "计划授权已失效");
  resources(tx, options, goal.resourceRefs);
}
function outputs(tx: KernelTransaction, options: TeamGoalServiceOptions, goal: GoalV2, items: readonly GoalOutputRefV2[]): boolean {
  if (!Array.isArray(items) || items.length > 20 || new Set(items.map(item => item?.key)).size !== items.length) fail("GOAL_OUTPUT_INVALID", "交付项重复或无效");
  for (const item of items) {
    if (!item || !goal.deliverables.some(spec => spec.key === item.key) || typeof item.preview !== "string" || !item.preview.trim()
      || typeof item.digest !== "string" || !/^[a-f0-9]{64}$/u.test(item.digest) || item.resourceRef?.digest !== item.digest) fail("GOAL_OUTPUT_INVALID", "交付资源或摘要无效");
    if (item.criteriaVersion !== goal.criteriaVersion) fail("GOAL_CRITERIA_CHANGED", "交付引用了不同的验收标准");
    if (!Array.isArray(item.sourceRefs) || !Array.isArray(item.checks) || !item.checks.length || new Set(item.checks.map((check: GoalOutputRefV2["checks"][number]) => check?.checkId)).size !== item.checks.length) fail("GOAL_OUTPUT_INVALID", "交付缺少独立的程序检查证据");
    resources(tx, options, [item.resourceRef, ...item.sourceRefs]);
    for (const check of item.checks) {
      if (!check || typeof check.checkId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(check.checkId)
        || !["passed", "failed"].includes(check.status) || !Array.isArray(check.evidenceRefs) || !check.evidenceRefs.length) fail("GOAL_OUTPUT_INVALID", "程序检查证据无效");
      resources(tx, options, check.evidenceRefs);
    }
  }
  return goal.deliverables.filter(spec => spec.required).every(spec => items.some(item => item.key === spec.key)) && items.every(item => item.checks.every((check: GoalOutputRefV2["checks"][number]) => check.status === "passed"));
}
function readable(tx: KernelTransaction, options: TeamGoalServiceOptions, detail: GoalCoordinatedDetailV2): GoalCoordinatedDetailV2 {
  resources(tx, options, detail.goal.resourceRefs);
  if (detail.deliverySet) { outputs(tx, options, detail.goal, detail.deliverySet.items); options.ports.assertAcceptance(tx, { ...detail, deliverySet: detail.deliverySet }); }
  return detail;
}
function response(tx: KernelTransaction, options: TeamGoalServiceOptions, detail: GoalCoordinatedDetailV2, redacted: boolean): GoalCoordinatedDetailV2 {
  if (!redacted) return readable(tx, options, detail);
  try { return readable(tx, options, detail); } catch { return { ...detail, deliverySet: null }; }
}
function write(tx: KernelTransaction, options: TeamGoalServiceOptions, previous: GoalV2, value: GoalV2, operation: string): GoalV2 {
  const next = { ...value, streamVersion: previous.streamVersion + 1, updatedAt: options.now() };
  tx.putProjection(GOAL, next.id, next);
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: "goal", aggregateId: next.id, expectedStreamVersion: previous.streamVersion,
    type: `goal.${operation}`, actorId: options.principalId, generation: 0, correlationId: options.id("goal-event"),
    publicPayload: { workspaceId: next.workspaceId, goalId: next.id, status: next.status, ...(next.planRevisionId ? { planRevisionId: next.planRevisionId } : {}) } });
  return next;
}
function open(goal: GoalV2): void { if (["accepted", "cancelled"].includes(goal.status)) fail("GOAL_CLOSED", "目标已结束"); }
function creator(goal: GoalV2, options: GoalScope): void { if (goal.principalId !== options.principalId) fail("GOAL_CONTROLLER_REQUIRED", "只有目标创建者可以决定团队执行与成果验收"); }
async function mutate(options: TeamGoalMutationOptions, operation: string, input: unknown,
  change: (tx: KernelTransaction, detail: ReturnType<typeof current>) => GoalV2, redacted = false): Promise<GoalCoordinatedDetailV2> {
  protect(options);
  if (typeof options.idempotencyKey !== "string" || !options.idempotencyKey.trim() || options.idempotencyKey.length > 200) fail("IDEMPOTENCY_KEY_REQUIRED", "目标变更需要有效幂等键");
  if (!integer(options.expectedStreamVersion, 1)) fail("STREAM_VERSION_CONFLICT", "目标版本无效");
  const scope = `goal.team.${operation}:${options.workspaceId}:${options.principalId}:${options.goalId}`, digest = sha256({ input: copy(input), expectedStreamVersion: options.expectedStreamVersion });
  return options.store.transact(options.tenantId, tx => {
    const detail = current(tx, options), previous = tx.getIdempotency(scope, options.idempotencyKey);
    if (operation === "external_usage_recorded" && (member(tx, options).workspaceRole !== "owner"
      || tx.getProjection<Principal>("principal", options.principalId)?.kind !== "human")) fail("FORBIDDEN", "仅工作区所有者可以核对外部用量");
    if (previous) {
      if (previous.requestDigest !== digest) fail("IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他请求");
      return response(tx, options, previous.response as GoalCoordinatedDetailV2, redacted);
    }
    if (detail.goal.streamVersion !== options.expectedStreamVersion) fail("STREAM_VERSION_CONFLICT", "目标版本已变化");
    const next = change(tx, detail);
    if (sha256(next) !== sha256(detail.goal)) write(tx, options, detail.goal, next, `team_${operation}`);
    else appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: "goal.receipt", aggregateId: `goal-receipt-${sha256([scope, options.idempotencyKey])}`,
      expectedStreamVersion: 0, type: "goal.observation_reused", actorId: options.principalId, generation: 0, correlationId: options.id("goal-receipt"), publicPayload: { workspaceId: options.workspaceId, goalId: detail.goal.id } });
    const result = team(current(tx, options));
    tx.putIdempotency({ tenantId: options.tenantId, scope, key: options.idempotencyKey, requestDigest: digest, response: result, createdAt: options.now() });
    return response(tx, options, result, redacted);
  });
}
export async function getTeamGoal(options: TeamGoalServiceOptions & { readonly goalId: string }): Promise<GoalCoordinatedDetailV2> {
  protect(options); return options.store.transact(options.tenantId, tx => readable(tx, options, team(current(tx, options))));
}
/** Internal control read omits output text; never expose this function as a public read endpoint. */
export async function getTeamGoalForCoordination(options: TeamGoalServiceOptions & { readonly goalId: string }): Promise<GoalCoordinatedDetailV2> {
  protect(options); return options.store.transact(options.tenantId, tx => ({ ...team(current(tx, options)), deliverySet: null }));
}
export async function replayTeamGoalPlan(options: TeamGoalMutationOptions, input: unknown): Promise<GoalCoordinatedDetailV2 | undefined> {
  protect(options);
  return options.store.transact(options.tenantId, tx => {
    current(tx, options);
    const scope = `goal.team.plan_proposed:${options.workspaceId}:${options.principalId}:${options.goalId}`, prior = tx.getIdempotency(scope, options.idempotencyKey);
    if (!prior) return undefined;
    if (prior.requestDigest !== sha256({ input: copy(input), expectedStreamVersion: options.expectedStreamVersion })) fail("IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他请求");
    return readable(tx, options, prior.response as GoalCoordinatedDetailV2);
  });
}
export async function proposeTeamGoalPlan(options: TeamGoalMutationOptions & { readonly proposal: GoalTeamPlanProposalV2; readonly planRequest?: unknown }): Promise<GoalCoordinatedDetailV2> {
  const proposal = copy(options.proposal);
  if (options.planRequest) {
    const request = options.planRequest as Record<string, unknown>;
    if (request.kind !== "team-v1" || request.templateId !== proposal.template.id || request.templateVersion !== proposal.template.version
      || typeof request.modelBindingId !== "string" || proposal.nodes.some(node => node.kind === "agent" && node.executor.modelBindingId !== request.modelBindingId)) fail("GOAL_PLAN_INVALID", "团队请求与固定执行配置不一致");
  }
  return mutate(options, "plan_proposed", options.planRequest ?? proposal, (tx, detail) => {
    const { goal } = detail; open(goal); creator(goal, options);
    if (goal.executionRef || goal.coordinationRef || goal.reservation) fail("GOAL_PLAN_IN_PROGRESS", "已派发计划不能替换");
    const thread = tx.getProjection<Thread>("thread", goal.threadId);
    if (!thread || thread.tenantId !== goal.tenantId || thread.workspaceId !== goal.workspaceId || thread.streamVersion !== proposal.threadStreamVersion
      || thread.pluginId !== proposal.pluginId || proposal.kind !== "team-v1") fail("GOAL_PLAN_INVALID", "团队计划与当前会话不一致");
    resources(tx, options, goal.resourceRefs);
    const body = { ...proposal, id: options.id("goal-plan"), goalId: goal.id, threadId: goal.threadId, revision: (detail.plan?.revision ?? 0) + 1,
      inputVersion: goal.inputVersion, criteriaVersion: goal.criteriaVersion, budget: goal.budget, resourceRefs: goal.resourceRefs, deliverables: goal.deliverables, createdAt: options.now() };
    const plan: GoalCoordinatedPlanV2 = { ...body, digest: sha256(body) };
    options.ports.assertPlan(tx, { goal, plan }); tx.putProjection(PLAN, plan.id, plan);
    return { ...goal, status: "awaiting_authorization", planRevisionId: plan.id };
  });
}
export async function startTeamGoal(options: TeamGoalMutationOptions & { readonly planRevisionId: string; readonly planDigest: string }): Promise<GoalCoordinatedDetailV2> {
  return mutate(options, "started", { planRevisionId: options.planRevisionId, planDigest: options.planDigest }, (tx, initial) => {
    const detail = team(initial), { goal, plan } = detail; open(goal); creator(goal, options);
    if (plan.id !== options.planRevisionId || plan.digest !== options.planDigest) fail("GOAL_PLAN_CHANGED", "只能授权当前计划的确切版本");
    if (goal.status !== "awaiting_authorization" || goal.executionRef || goal.coordinationRef || goal.reservation) fail("GOAL_PLAN_IN_PROGRESS", "此目标已经派发");
    const thread = tx.getProjection<Thread>("thread", goal.threadId);
    if (!thread || thread.streamVersion !== plan.threadStreamVersion) fail("GOAL_PLAN_CHANGED", "会话已变化，请重新生成计划");
    if (tx.listProjections<Execution>("execution").some(execution => execution.threadId === goal.threadId && !["completed", "failed", "cancelled"].includes(execution.status))
      || tx.listProjections<GoalV2>(GOAL).some(other => other.id !== goal.id && other.threadId === goal.threadId && (other.executionRef || other.coordinationRef) && other.reservation?.status !== "settled")) fail("GOAL_THREAD_BUSY", "会话仍有活动执行或待核实用量");
    resources(tx, options, goal.resourceRefs); options.ports.assertPlan(tx, detail);
    const next: GoalV2 = { ...goal, status: "running", reservation: { status: "reserved" }, authorization: {
      planDigest: plan.digest, principalId: options.principalId, membershipStreamVersion: member(tx, options).streamVersion } };
    const run = options.ports.start(tx, { goal: next, plan });
    const started = { ...next, coordinationRef: { runId: run.id, planRevisionId: plan.id } };
    const stored = runAt(tx, { goal: started, plan });
    if (sha256(stored) !== sha256(run) || run.status !== "active" || run.membershipStreamVersion !== next.authorization!.membershipStreamVersion
      || run.budgets.length !== 1 || budgetIdentity(run.budgets[0]!) !== budgetIdentity(plan.budget)
      || !Number.isFinite(Date.parse(run.deadlineAt)) || Date.parse(run.deadlineAt) <= Date.parse(options.now()) || Date.parse(run.deadlineAt) > Date.parse(options.now()) + plan.budget.maxDurationMs
      || run.limits.maxParallel > plan.limits.maxParallelNodes || run.limits.maxNodes > plan.limits.maxNodes || run.limits.maxAttempts > plan.limits.maxAttempts || run.limits.maxDepth > plan.limits.maxDelegationDepth
      || run.nodes.length !== plan.nodes.length || plan.nodes.some(node => !run.nodes.some(actual => actual.id === node.id && (actual.kind ?? "agent") === node.kind && sha256(actual.dependsOn) === sha256(node.dependsOn)
        && (node.kind !== "agent" || (actual.pluginId === node.executor.pluginId && actual.agentDefinitionId === node.executor.agentDefinitionId && actual.modelBindingId === node.executor.modelBindingId
          && (actual.runnerId ?? "builtin") === node.executor.runnerId && actual.pluginPackageSha256 === node.executor.pluginPackageSha256 && budgetIdentity(actual.budget) === budgetIdentity(node.budget)
          && sha256(actual.role) === sha256({ toolIds: node.executor.toolIds, dataScopes: node.executor.dataScopes, autoAllowedEffects: node.executor.autoAllowedEffects })))))) fail("GOAL_EXECUTION_INVALID", "持久团队执行未绑定固定节点配置");
    return started;
  });
}
function observe(tx: KernelTransaction, options: TeamGoalServiceOptions, detail: GoalCoordinatedDetailV2): GoalV2 {
  const { goal, plan } = detail;
  if (goal.status === "accepted") fail("GOAL_CLOSED", "目标已接受");
  if (!goal.cancellationRequestedAt) authorization(tx, options, detail);
  const run = runAt(tx, detail), observed = options.ports.advance(tx, { goal, plan, run, ...(goal.cancellationRequestedAt ? { accountingOnly: true } : {}) });
  const value = goal.cancellationRequestedAt ? accountingObservation(observed) : copy(observed);
  if (!["running", "waiting_approval", "pausing", "paused", "needs_reconciliation", "failed", "awaiting_acceptance", "cancelled"].includes(value.status)) fail("GOAL_EXECUTION_INVALID", "团队观察状态无效");
  const terminal = ["awaiting_acceptance", "failed", "cancelled"].includes(value.status);
  let next: GoalV2 = { ...goal, status: value.status, reasonCode: value.reasonCode };
  if (value.usage) {
    usage(value.usage);
    if (value.usage.currency !== goal.budget.currency) fail("GOAL_BUDGET_CURRENCY_MISMATCH", "用量币种与目标预算不同");
    if (goal.reservation?.status === "settled" && sha256(goal.reservation.actual) !== sha256(value.usage)) fail("GOAL_USAGE_CONFLICT", "已结算用量不能覆盖");
    if (terminal) next = { ...next, reservation: { status: "settled", actual: value.usage } };
    if (value.usage.tokens > goal.budget.maxTokens || BigInt(value.usage.costMinorUnits) > BigInt(goal.budget.maxCostMinorUnits)) return { ...next, status: "needs_reconciliation", reasonCode: "GOAL_BUDGET_OVERRUN" };
  } else if (terminal && goal.reservation?.status !== "settled") next = { ...next, reservation: { status: "unknown" } };
  if (goal.cancellationRequestedAt) return { ...next, status: terminal && next.reservation?.status === "settled" ? "cancelled" : "needs_reconciliation",
    reasonCode: next.reservation?.status !== "settled" ? "GOAL_USAGE_UNKNOWN" : terminal ? undefined : "GOAL_CANCELLATION_PENDING" };
  if (terminal && next.reservation?.status !== "settled") return { ...next, status: "needs_reconciliation", reasonCode: "GOAL_USAGE_UNKNOWN" };
  if (value.status === "awaiting_acceptance" || (value.status === "failed" && value.outputs?.length)) {
    const valid = outputs(tx, options, goal, value.outputs ?? []);
    if (value.status === "awaiting_acceptance" && !valid) return { ...next, status: "failed", reasonCode: "GOAL_DELIVERY_INCOMPLETE" };
    const body = { goalId: goal.id, planRevisionId: plan.id, criteriaVersion: goal.criteriaVersion, items: value.outputs! }, digest = sha256(body), id = `goal-delivery-${digest}`;
    if (goal.deliverySetId && goal.deliverySetId !== id) fail("GOAL_OUTPUT_INVALID", "已登记交付集合不能覆盖");
    const deliverySet: GoalDeliverySetV2 = { ...body, id, digest, createdAt: options.now() };
    options.ports.assertAcceptance(tx, { goal, plan, deliverySet });
    if (!tx.getProjection(DELIVERY, id)) tx.putProjection(DELIVERY, id, deliverySet);
    next = { ...next, deliverySetId: id };
  }
  return next;
}
export async function recordTeamExternalGoalUsage(options: TeamGoalMutationOptions & { readonly usage: GoalUsageV2; readonly source: string; readonly accountingOnly?: boolean }): Promise<GoalCoordinatedDetailV2> {
  usage(options.usage);
  return mutate(options, "external_usage_recorded", { usage: options.usage, source: options.source }, (tx, raw) => {
    const detail = team(raw);
    let accountingOnly = options.accountingOnly === true;
    if (!accountingOnly) try { authorization(tx, options, detail); } catch { accountingOnly = true; }
    recordCoordinatedExternalUsage(tx, { ...options, goal: detail.goal, plan: detail.plan });
    if (!accountingOnly) return observe(tx, options, detail);
    const value = accountingObservation(options.ports.advance(tx, { ...detail, run: runAt(tx, detail), accountingOnly: true }));
    if (!value.usage || !["failed", "cancelled", "awaiting_acceptance"].includes(value.status)) fail("GOAL_USAGE_UNKNOWN", "外部执行仍有待核对用量");
    usage(value.usage);
    if (value.usage.currency !== detail.goal.budget.currency) fail("GOAL_BUDGET_CURRENCY_MISMATCH", "账单币种与目标预算不同");
    const overrun = value.usage.tokens > detail.goal.budget.maxTokens || BigInt(value.usage.costMinorUnits) > BigInt(detail.goal.budget.maxCostMinorUnits);
    return { ...detail.goal, reservation: { status: "settled", actual: value.usage },
      status: overrun ? "needs_reconciliation" : detail.goal.cancellationRequestedAt ? "cancelled" : "failed",
      reasonCode: overrun ? "GOAL_BUDGET_OVERRUN" : "GOAL_AUTHORIZATION_STALE" };
  }, true);
}
export async function advanceTeamGoal(options: TeamGoalMutationOptions): Promise<GoalCoordinatedDetailV2> {
  return mutate(options, "observed", {}, (tx, detail) => observe(tx, options, team(detail)), true);
}
export async function observeTeamGoalInBackground(options: TeamGoalServiceOptions & { readonly goalId: string }): Promise<void> {
  protect(options); await options.store.transact(options.tenantId, tx => {
    const detail = team(current(tx, options));
    if (detail.goal.status === "accepted" || !detail.goal.coordinationRef) return;
    const next = observe(tx, options, detail);
    if (sha256(next) !== sha256(detail.goal)) write(tx, options, detail.goal, next, "team_observed");
  });
}
/** Internal accounting path: it neither dispatches nodes nor registers or returns deliverable content. */
export async function reconcileTeamGoalUsage(options: TeamGoalServiceOptions & { readonly goalId: string }): Promise<void> {
  protect(options); await options.store.transact(options.tenantId, tx => {
    const detail = team(current(tx, options, false)), { goal, plan } = detail;
    if (goal.status === "accepted" || !goal.coordinationRef) return;
    const run = runAt(tx, detail), value = accountingObservation(options.ports.advance(tx, { goal, plan, run, accountingOnly: true }));
    const terminal = ["awaiting_acceptance", "failed", "cancelled"].includes(value.status);
    let next = goal;
    if (terminal && value.usage) {
      usage(value.usage);
      if (value.usage.currency !== goal.budget.currency) fail("GOAL_BUDGET_CURRENCY_MISMATCH", "用量币种与目标预算不同");
      if (goal.reservation?.status === "settled" && sha256(goal.reservation.actual) !== sha256(value.usage)) fail("GOAL_USAGE_CONFLICT", "已结算用量不能覆盖");
      next = { ...next, reservation: { status: "settled", actual: value.usage } };
    } else if (terminal && goal.reservation?.status !== "settled") next = { ...next, reservation: { status: "unknown" } };
    let authorized = true;
    try { authorization(tx, options, detail); } catch { authorized = false; }
    const actual = next.reservation?.actual;
    if (goal.cancellationRequestedAt) next = { ...next, status: terminal && next.reservation?.status === "settled" ? "cancelled" : "needs_reconciliation",
      reasonCode: !terminal ? "GOAL_CANCELLATION_PENDING" : next.reservation?.status !== "settled" ? "GOAL_USAGE_UNKNOWN" : undefined };
    else if (!authorized) next = { ...next, status: "needs_reconciliation", reasonCode: "GOAL_AUTHORIZATION_STALE" };
    else if (actual && (actual.tokens > goal.budget.maxTokens || BigInt(actual.costMinorUnits) > BigInt(goal.budget.maxCostMinorUnits))) next = { ...next, status: "needs_reconciliation", reasonCode: "GOAL_BUDGET_OVERRUN" };
    else if (terminal && next.reservation?.status !== "settled") next = { ...next, status: "needs_reconciliation", reasonCode: "GOAL_USAGE_UNKNOWN" };
    else if (["failed", "cancelled"].includes(value.status)) next = { ...next, status: "failed", reasonCode: value.reasonCode ?? "GOAL_EXECUTION_FAILED" };
    if (sha256(next) !== sha256(goal)) write(tx, options, goal, next, "team_usage_reconciled");
  });
}
export async function commandTeamGoal(options: TeamGoalMutationOptions & TeamGoalCommandInput & { readonly command: TeamGoalCommand }): Promise<GoalCoordinatedDetailV2> {
  const input = { command: options.command, ...(options.nodeId ? { nodeId: options.nodeId } : {}), ...(options.decision ? { decision: options.decision } : {}) };
  return mutate(options, `command_${options.command}`, input, (tx, initial) => {
    const detail = team(initial), { goal } = detail; open(goal); creator(goal, options);
    if (!["pause", "resume", "cancel", "decide"].includes(options.command)) fail("GOAL_INPUT_INVALID", "团队控制操作无效");
    if (options.command === "cancel" && goal.cancellationRequestedAt) return goal;
    if (options.command === "resume" && (goal.cancellationRequestedAt || !["paused", "pausing"].includes(goal.status))) fail("GOAL_RESUME_INVALID", "只有暂停的团队可以继续");
    if (options.command === "decide" && (!detail.plan.nodes.some(node => node.id === options.nodeId && node.kind === "human_decision") || !["continue", "stop"].includes(options.decision ?? ""))) fail("GOAL_DECISION_INVALID", "人工决定节点或选项无效");
    if (options.command !== "cancel" && options.command !== "pause") { authorization(tx, options, detail); options.ports.assertPlan(tx, detail); }
    if (!goal.coordinationRef && options.command === "cancel") return { ...goal, status: "cancelled", cancellationRequestedAt: options.now() };
    const run = runAt(tx, detail), changed = options.ports.command(tx, { ...detail, run }, options.command, input);
    if (changed.id !== run.id || changed.revisionId !== run.revisionId || sha256(changed) !== sha256(runAt(tx, detail))) fail("GOAL_EXECUTION_INVALID", "控制操作不能切换执行版本且必须持久保存");
    if (options.command === "cancel" || (options.command === "decide" && options.decision === "stop")) {
      if (changed.status !== "cancelled") fail("GOAL_EXECUTION_INVALID", "停止决定尚未阻止后续派发");
      return { ...goal, cancellationRequestedAt: goal.cancellationRequestedAt ?? options.now(),
      status: goal.reservation?.status === "settled" ? "cancelled" : "needs_reconciliation", reasonCode: goal.reservation?.status === "settled" ? undefined : "GOAL_USAGE_UNKNOWN" };
    }
    if (options.command === "pause") {
      if (changed.status !== "paused") fail("GOAL_EXECUTION_INVALID", "暂停操作尚未阻止后续派发");
      const active = tx.listProjections<CoordinationAttemptV2>("coordination.attempt").filter(attempt => attempt.runId === run.id)
        .some(attempt => { const execution = tx.getProjection<Execution>("execution", attempt.executionId); return !execution || !["completed", "failed", "cancelled", "paused"].includes(execution.status); });
      return { ...goal, status: active ? "pausing" : "paused", reasonCode: undefined };
    }
    if (changed.status !== "active") fail("GOAL_EXECUTION_INVALID", "团队尚不能继续推进");
    return { ...goal, status: "running", reasonCode: undefined };
  }, options.command === "cancel" || options.command === "pause");
}
export async function acceptTeamGoalDelivery(options: TeamGoalMutationOptions & { readonly deliverySetId: string; readonly criteriaVersion: string;
  readonly items: readonly { readonly key: string; readonly digest: string; readonly reviewedCriterionIds: readonly string[] }[] }): Promise<GoalCoordinatedDetailV2> {
  const input = copy({ deliverySetId: options.deliverySetId, criteriaVersion: options.criteriaVersion, items: options.items });
  return mutate(options, "accepted", input, (tx, initial) => {
    const detail = team(initial), { goal, plan, deliverySet } = detail; open(goal); creator(goal, options);
    if (input.criteriaVersion !== goal.criteriaVersion) fail("GOAL_CRITERIA_CHANGED", "验收标准版本已变化");
    if (goal.status !== "awaiting_acceptance" || !deliverySet || deliverySet.id !== input.deliverySetId) fail("GOAL_DELIVERY_NOT_READY", "目标尚无对应的可验收成果");
    authorization(tx, options, detail);
    const { id: _id, digest, createdAt: _time, ...body } = deliverySet;
    if (sha256(body) !== digest || deliverySet.id !== `goal-delivery-${digest}` || deliverySet.criteriaVersion !== goal.criteriaVersion || !outputs(tx, options, goal, deliverySet.items)) fail("GOAL_DELIVERY_INVALID", "交付集合或检查证据已失效");
    if (!Array.isArray(input.items) || input.items.length !== deliverySet.items.length || new Set(input.items.map(item => item?.key)).size !== input.items.length) fail("GOAL_DELIVERY_INCOMPLETE", "请逐项接受整套交付清单");
    for (const output of deliverySet.items) {
      const accepted = input.items.find(item => item.key === output.key), spec = goal.deliverables.find(item => item.key === output.key)!;
      if (!accepted || accepted.digest !== output.digest) fail("GOAL_DELIVERY_INCOMPLETE", "接受的成果版本不一致");
      if (!Array.isArray(accepted.reviewedCriterionIds) || accepted.reviewedCriterionIds.length !== spec.criteria.length || new Set(accepted.reviewedCriterionIds).size !== spec.criteria.length
        || spec.criteria.some(criterion => !accepted.reviewedCriterionIds.includes(criterion.id))) fail("GOAL_CRITERIA_NOT_REVIEWED", "请逐条复核并确认所有验收标准");
    }
    options.ports.assertAcceptance(tx, { goal, plan, deliverySet });
    const id = options.id("goal-acceptance"), acceptance: GoalDeliveryAcceptanceV2 = { id, goalId: goal.id, deliverySetId: deliverySet.id,
      criteriaVersion: goal.criteriaVersion, principalId: options.principalId, acceptedAt: options.now(), items: input.items };
    tx.putProjection(ACCEPTANCE, id, acceptance); return { ...goal, status: "accepted", acceptanceId: id };
  });
}
