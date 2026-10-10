// SPDX-License-Identifier: Apache-2.0
import type { Execution, ExecutionAuthority, GoalBudgetV2, GoalDeliverableSpecV2, GoalDeliveryAcceptanceV2, GoalDeliverySetV2, GoalDetailV2, GoalExecutionObservationV2, GoalOutputRefV2, GoalPlanProposalV2, GoalPlanRevisionV2, GoalResourceRefV2, GoalUsageV2, GoalV2, Job, Principal, Thread, Workspace, WorkspaceMembership } from "@mn/contracts";
import { appendKernelEvent, hasUnsettledToolCalls, KernelError, sha256, type KernelStore, type KernelTransaction } from "@mn/kernel";
import type { ContentAddressedStorage, KeyProvider } from "@mn/storage";

export interface GoalScope { readonly tenantId: string; readonly workspaceId: string; readonly principalId: string }
export interface GoalPlanContext { readonly goal: GoalV2; readonly plan: GoalPlanRevisionV2 }
export interface GoalApplicationPorts {
  assertResources(transaction: KernelTransaction, scope: GoalScope, refs: readonly GoalResourceRefV2[]): void;
  assertPlan(transaction: KernelTransaction, context: GoalPlanContext): void;
  start(transaction: KernelTransaction, context: GoalPlanContext): Execution;
  observe(transaction: KernelTransaction, context: GoalPlanContext & { readonly execution: Execution; readonly accountingOnly?: boolean }): GoalExecutionObservationV2;
  assertAcceptance(transaction: KernelTransaction, context: GoalPlanContext & { readonly deliverySet: GoalDeliverySetV2 }): void;
  cancel(transaction: KernelTransaction, context: GoalPlanContext & { readonly execution: Execution }): void;
}
export interface GoalServiceOptions extends GoalScope {
  readonly store: KernelStore;
  readonly cas: ContentAddressedStorage;
  readonly keyProvider: KeyProvider;
  readonly protectedJournal: boolean;
  readonly ports: GoalApplicationPorts;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}
export interface GoalMutationOptions extends GoalServiceOptions {
  readonly goalId: string;
  readonly expectedStreamVersion: number;
  readonly idempotencyKey: string;
}
export const GOAL_NAMESPACE = "goal.state";
export const GOAL_PLAN_NAMESPACE = "goal.plan";
export const GOAL_DELIVERY_SET_NAMESPACE = "goal.deliverySet";
export const GOAL_DELIVERY_ACCEPTANCE_NAMESPACE = "goal.deliveryAcceptance";
function fail(code: string, message: string): never { throw new KernelError(code, message, "刷新目标、计划和权限后重试"); }
function protect(options: GoalServiceOptions): void {
  if (!options.cas || !options.keyProvider || !options.protectedJournal) fail("PROTECTED_PAYLOAD_UNAVAILABLE", "目标需要受保护的事件存储");
}
function copy<T>(input: T): T {
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { return fail("GOAL_INPUT_INVALID", "目标输入必须是 JSON 数据"); }
  if (!encoded || Buffer.byteLength(encoded) > 128 * 1024) fail("GOAL_INPUT_INVALID", "目标输入过大");
  return JSON.parse(encoded) as T;
}
function key(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)) fail("GOAL_INPUT_INVALID", "目标标识无效");
}
function mutationKey(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200) fail("IDEMPOTENCY_KEY_REQUIRED", "目标变更需要有效幂等键");
}
function integer(value: number, minimum = 0): boolean { return Number.isSafeInteger(value) && value >= minimum; }
function usage(value: GoalUsageV2): void {
  if (!value || !integer(value.tokens) || typeof value.costMinorUnits !== "string" || !/^(0|[1-9][0-9]{0,23})$/u.test(value.costMinorUnits)
    || typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) fail("GOAL_BUDGET_INVALID", "预算与用量必须是非负整数及有效币种");
}
function authorized(tx: KernelTransaction, options: GoalScope): WorkspaceMembership {
  const workspace = tx.getProjection<Workspace>("workspace", options.workspaceId);
  const member = tx.getProjection<WorkspaceMembership>("membership", `${options.workspaceId}:${options.principalId}`);
  const principal = tx.getProjection<Principal>("principal", options.principalId);
  if (!workspace || workspace.tenantId !== options.tenantId || !member || member.tenantId !== options.tenantId
    || member.workspaceId !== options.workspaceId || member.principalId !== options.principalId || member.removedAt
    || !principal || principal.disabledAt || !["owner", "operator"].includes(member.workspaceRole)) fail("WORKSPACE_ACCESS_DENIED", "无权访问此工作区目标");
  return member;
}
function resources(tx: KernelTransaction, options: GoalServiceOptions, refs: readonly GoalResourceRefV2[]): void {
  if (!Array.isArray(refs) || refs.length > 100 || refs.some(ref => !ref || !ref.namespace || !ref.resourceId || !integer(ref.streamVersion, 1))) fail("GOAL_RESOURCE_DENIED", "目标资料引用无效");
  options.ports.assertResources(tx, options, refs);
}
function current(tx: KernelTransaction, options: GoalScope & { readonly goalId: string }, checkMembership = true): GoalDetailV2 {
  if (checkMembership) authorized(tx, options);
  const goal = tx.getProjection<GoalV2>(GOAL_NAMESPACE, options.goalId);
  if (!goal || goal.tenantId !== options.tenantId || goal.workspaceId !== options.workspaceId) fail("GOAL_NOT_FOUND", "目标不存在");
  const plan = goal.planRevisionId ? tx.getProjection<GoalPlanRevisionV2>(GOAL_PLAN_NAMESPACE, goal.planRevisionId) : undefined;
  if (goal.planRevisionId && (!plan || plan.goalId !== goal.id || plan.threadId !== goal.threadId)) fail("GOAL_PLAN_INVALID", "计划引用无效");
  if (plan) { const { digest, ...body } = plan; if (sha256(body) !== digest) fail("GOAL_PLAN_INVALID", "计划摘要无效"); }
  const deliverySet = goal.deliverySetId ? tx.getProjection<GoalDeliverySetV2>(GOAL_DELIVERY_SET_NAMESPACE, goal.deliverySetId) : undefined;
  if (goal.deliverySetId && (!deliverySet || deliverySet.goalId !== goal.id || deliverySet.planRevisionId !== plan?.id)) fail("GOAL_DELIVERY_INVALID", "交付集合引用无效");
  return { goal, plan: plan ?? null, deliverySet: deliverySet ?? null };
}
function result(tx: KernelTransaction, goal: GoalV2): GoalDetailV2 {
  return { goal, plan: goal.planRevisionId ? tx.getProjection<GoalPlanRevisionV2>(GOAL_PLAN_NAMESPACE, goal.planRevisionId)! : null,
    deliverySet: goal.deliverySetId ? tx.getProjection<GoalDeliverySetV2>(GOAL_DELIVERY_SET_NAMESPACE, goal.deliverySetId)! : null };
}
function readable(tx: KernelTransaction, options: GoalServiceOptions, detail: GoalDetailV2): GoalDetailV2 {
  resources(tx, options, detail.goal.resourceRefs);
  if (detail.deliverySet && detail.plan) {
    checkOutputs(tx, options, detail.goal, detail.deliverySet.items);
    options.ports.assertAcceptance(tx, { goal: detail.goal, plan: detail.plan, deliverySet: detail.deliverySet });
  }
  return detail;
}
function mutationResponse(tx: KernelTransaction, options: GoalServiceOptions, operation: string, detail: GoalDetailV2): GoalDetailV2 {
  if (!["observed", "cancelled"].includes(operation)) return readable(tx, options, detail);
  try { return readable(tx, options, detail); } catch { return { ...detail, deliverySet: null }; }
}
function write(tx: KernelTransaction, options: GoalServiceOptions, previous: GoalV2 | undefined, value: GoalV2, operation: string): GoalV2 {
  const next = { ...value, streamVersion: (previous?.streamVersion ?? 0) + 1, updatedAt: options.now() };
  tx.putProjection(GOAL_NAMESPACE, next.id, next);
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: "goal", aggregateId: next.id,
    expectedStreamVersion: previous?.streamVersion ?? 0, type: `goal.${operation}`, actorId: options.principalId,
    generation: next.executionRef?.generation ?? 0, correlationId: options.id("goal-event"), publicPayload: {
      workspaceId: next.workspaceId, goalId: next.id, status: next.status, ...(next.planRevisionId ? { planRevisionId: next.planRevisionId } : {}),
      ...(next.executionRef ? { executionId: next.executionRef.executionId } : {}) } });
  return next;
}
function prior(tx: KernelTransaction, scope: string, idempotencyKey: string, digest: string): GoalDetailV2 | undefined {
  const known = tx.getIdempotency(scope, idempotencyKey);
  if (!known) return undefined;
  if (known.requestDigest !== digest) fail("IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他请求");
  return known.response as GoalDetailV2;
}
function receipt(tx: KernelTransaction, options: GoalServiceOptions & { readonly idempotencyKey: string }, scope: string, digest: string, response: GoalDetailV2): void {
  tx.putIdempotency({ tenantId: options.tenantId, scope, key: options.idempotencyKey, requestDigest: digest, response, createdAt: options.now() });
}
async function mutate(options: GoalMutationOptions, operation: string, input: unknown,
  change: (tx: KernelTransaction, detail: GoalDetailV2) => GoalV2): Promise<GoalDetailV2> {
  protect(options); mutationKey(options.idempotencyKey);
  if (!integer(options.expectedStreamVersion, 1)) fail("STREAM_VERSION_CONFLICT", "目标版本无效");
  const scope = `goal.${operation}:${options.workspaceId}:${options.principalId}:${options.goalId}`;
  const digest = sha256({ input, expectedStreamVersion: options.expectedStreamVersion });
  return options.store.transact(options.tenantId, tx => {
    const detail = current(tx, options), replay = prior(tx, scope, options.idempotencyKey, digest);
    if (replay) return mutationResponse(tx, options, operation, replay);
    if (detail.goal.streamVersion !== options.expectedStreamVersion) fail("STREAM_VERSION_CONFLICT", "目标版本已变化");
    const changed = change(tx, detail);
    const unchanged = sha256(changed) === sha256(detail.goal);
    if (unchanged) appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: "goal.receipt",
      aggregateId: `goal-receipt-${sha256([scope, options.idempotencyKey])}`, expectedStreamVersion: 0,
      type: "goal.observation_reused", actorId: options.principalId, generation: 0, correlationId: options.id("goal-receipt"),
      publicPayload: { workspaceId: options.workspaceId, goalId: detail.goal.id } });
    const next = result(tx, unchanged ? detail.goal : write(tx, options, detail.goal, changed, operation));
    receipt(tx, options, scope, digest, next); return mutationResponse(tx, options, operation, next);
  });
}
function open(goal: GoalV2): void { if (["accepted", "cancelled"].includes(goal.status)) fail("GOAL_CLOSED", "目标已结束"); }
function planRequired(detail: GoalDetailV2): GoalPlanRevisionV2 {
  if (!detail.plan) fail("GOAL_PLAN_REQUIRED", "目标尚无计划");
  return detail.plan;
}
function validAuthorization(tx: KernelTransaction, options: GoalServiceOptions, goal: GoalV2, plan: GoalPlanRevisionV2): void {
  const membership = authorized(tx, options), grant = goal.authorization;
  if (!grant || grant.principalId !== options.principalId || grant.membershipStreamVersion !== membership.streamVersion
    || grant.planDigest !== plan.digest) fail("GOAL_AUTHORIZATION_STALE", "计划授权已失效");
  resources(tx, options, goal.resourceRefs);
}
function executionAt(tx: KernelTransaction, goal: GoalV2, plan: GoalPlanRevisionV2): Execution {
  const ref = goal.executionRef, execution = ref && tx.getProjection<Execution>("execution", ref.executionId);
  if (!ref || ref.planRevisionId !== plan.id || !execution || execution.tenantId !== goal.tenantId || execution.workspaceId !== goal.workspaceId
    || execution.threadId !== goal.threadId || execution.pluginId !== plan.pluginId || execution.agentDefinitionId !== plan.agentDefinitionId
    || execution.modelBindingId !== plan.modelBindingId || execution.generation !== ref.generation
    || (execution.runnerId ?? "builtin") !== plan.runnerId || execution.pluginPackageSha256 !== plan.pluginPackageSha256) fail("GOAL_EXECUTION_INVALID", "执行与固定计划版本不一致");
  return execution;
}

export async function createGoal(options: GoalServiceOptions & { readonly threadId: string; readonly objective: string;
  readonly resourceRefs: readonly GoalResourceRefV2[]; readonly budget: GoalBudgetV2;
  readonly deliverables: readonly GoalDeliverableSpecV2[]; readonly idempotencyKey: string }): Promise<GoalDetailV2> {
  protect(options); mutationKey(options.idempotencyKey);
  const input = copy({ threadId: options.threadId, objective: options.objective, resourceRefs: options.resourceRefs, budget: options.budget, deliverables: options.deliverables });
  if (!input.objective?.trim() || input.objective.length > 16000 || !input.threadId?.trim()) fail("GOAL_INPUT_INVALID", "请填写目标并选择会话");
  usage({ tokens: input.budget?.maxTokens, costMinorUnits: input.budget?.maxCostMinorUnits, currency: input.budget?.currency });
  if (!integer(input.budget.maxDurationMs, 1)) fail("GOAL_BUDGET_INVALID", "执行期限必须是正整数");
  if (!Array.isArray(input.deliverables) || !input.deliverables.length || input.deliverables.length > 20
    || !input.deliverables.some(item => item.required) || new Set(input.deliverables.map(item => item.key)).size !== input.deliverables.length) fail("GOAL_INPUT_INVALID", "目标需要唯一且明确的必需交付项");
  for (const item of input.deliverables) {
    key(item.key);
    if (!item.title?.trim() || item.title.length > 200 || typeof item.required !== "boolean" || !Array.isArray(item.criteria)
      || !item.criteria.length || item.criteria.length > 20 || new Set(item.criteria.map((criterion: GoalDeliverableSpecV2["criteria"][number]) => criterion.id)).size !== item.criteria.length) fail("GOAL_INPUT_INVALID", "交付项需要明确验收标准");
    for (const criterion of item.criteria) { key(criterion.id); if (!criterion.description?.trim() || criterion.description.length > 2000) fail("GOAL_INPUT_INVALID", "验收标准无效"); }
  }
  const scope = `goal.create:${options.workspaceId}:${options.principalId}`, digest = sha256(input);
  return options.store.transact(options.tenantId, tx => {
    authorized(tx, options);
    const replay = prior(tx, scope, options.idempotencyKey, digest); if (replay) return readable(tx, options, replay);
    const thread = tx.getProjection<Thread>("thread", input.threadId);
    if (!thread || thread.tenantId !== options.tenantId || thread.workspaceId !== options.workspaceId || !["opc", "coding"].includes(thread.pluginId)) fail("GOAL_THREAD_INVALID", "目标必须绑定当前工作区的 OPC 或 Coding 会话");
    resources(tx, options, input.resourceRefs);
    const goal: GoalV2 = { ...input, id: options.id("goal"), tenantId: options.tenantId, workspaceId: options.workspaceId,
      principalId: options.principalId, inputVersion: 1, criteriaVersion: sha256(input.deliverables), status: "draft", streamVersion: 0, createdAt: options.now(), updatedAt: options.now() };
    const created = result(tx, write(tx, options, undefined, goal, "created")); receipt(tx, options, scope, digest, created); return created;
  });
}
export async function getGoal(options: GoalServiceOptions & { readonly goalId: string }): Promise<GoalDetailV2> {
  protect(options); return options.store.transact(options.tenantId, tx => readable(tx, options, current(tx, options)));
}
/** Host coordination receives no deliverable text and cannot use this as a public read endpoint. */
export async function getGoalForCoordination(options: GoalServiceOptions & { readonly goalId: string }): Promise<GoalDetailV2> {
  protect(options); return options.store.transact(options.tenantId, tx => ({ ...current(tx, options), deliverySet: null }));
}
/** Trusted Host accounting only. Never expose this read through a public route. */
export async function readGoalForAccounting(options: { readonly store: KernelStore; readonly tenantId: string; readonly goalId: string }): Promise<GoalDetailV2> {
  return options.store.transact(options.tenantId, tx => {
    const goal = tx.getProjection<GoalV2>(GOAL_NAMESPACE, options.goalId);
    if (!goal || goal.tenantId !== options.tenantId) fail("GOAL_NOT_FOUND", "目标不存在");
    return { ...current(tx, { tenantId: goal.tenantId, workspaceId: goal.workspaceId,
      principalId: goal.authorization?.principalId ?? goal.principalId, goalId: goal.id }, false), deliverySet: null };
  });
}
export async function reconcileGoalUsage(options: Pick<GoalServiceOptions, "store" | "cas" | "keyProvider" | "protectedJournal" | "ports" | "now" | "id" | "tenantId"> & { readonly goalId: string }): Promise<void> {
  if (!options.cas || !options.keyProvider || !options.protectedJournal) fail("PROTECTED_PAYLOAD_UNAVAILABLE", "费用核对需要受保护的事件存储");
  await options.store.transact(options.tenantId, tx => {
    const goal = tx.getProjection<GoalV2>(GOAL_NAMESPACE, options.goalId);
    if (!goal || goal.tenantId !== options.tenantId || !goal.executionRef || goal.status === "accepted") return;
    const scope: GoalServiceOptions = { ...options, workspaceId: goal.workspaceId, principalId: goal.authorization?.principalId ?? goal.principalId };
    const detail = current(tx, { ...scope, goalId: goal.id }, false), plan = planRequired(detail), execution = executionAt(tx, goal, plan);
    const observed = copy(options.ports.observe(tx, { goal, plan, execution, accountingOnly: true }));
    if (observed.executionStreamVersion !== execution.streamVersion || observed.generation !== execution.generation) fail("GOAL_EXECUTION_CHANGED", "计量观察不属于当前执行版本");
    const terminal = ["completed", "failed", "cancelled"].includes(execution.status);
    let next = goal;
    if (terminal && observed.usage) {
      usage(observed.usage);
      if (observed.usage.currency !== goal.budget.currency) fail("GOAL_BUDGET_CURRENCY_MISMATCH", "用量币种与目标预算不同");
      if (goal.reservation?.status === "settled" && sha256(goal.reservation.actual) !== sha256(observed.usage)) fail("GOAL_USAGE_CONFLICT", "同一执行已有不同的用量结算");
      next = { ...next, reservation: { status: "settled", actual: observed.usage } };
    } else if (terminal && goal.reservation?.status !== "settled") next = { ...next, reservation: { status: "unknown" } };
    if (goal.cancellationRequestedAt) next = { ...next,
      status: terminal && next.reservation?.status === "settled" ? "cancelled" : "needs_reconciliation",
      reasonCode: !terminal ? "GOAL_CANCELLATION_PENDING" : next.reservation?.status !== "settled" ? "GOAL_USAGE_UNKNOWN" : undefined };
    else {
      let authorized = true;
      try { validAuthorization(tx, scope, goal, plan); } catch { authorized = false; }
      const actual = next.reservation?.actual;
      if (!authorized) next = { ...next, status: "needs_reconciliation", reasonCode: "GOAL_AUTHORIZATION_STALE" };
      else if (actual && (actual.tokens > goal.budget.maxTokens || BigInt(actual.costMinorUnits) > BigInt(goal.budget.maxCostMinorUnits))) next = { ...next, status: "needs_reconciliation", reasonCode: "GOAL_BUDGET_OVERRUN" };
      else if (terminal && next.reservation?.status !== "settled") next = { ...next, status: "needs_reconciliation", reasonCode: "GOAL_USAGE_UNKNOWN" };
      else if (["failed", "cancelled"].includes(execution.status)) next = { ...next, status: "failed", reasonCode: "GOAL_EXECUTION_FAILED" };
    }
    if (sha256(next) !== sha256(goal)) write(tx, scope, goal, next, "usage_reconciled");
  });
}
export async function listGoals(options: GoalServiceOptions): Promise<readonly GoalV2[]> {
  protect(options); return options.store.transact(options.tenantId, tx => {
    authorized(tx, options); return tx.listProjections<GoalV2>(GOAL_NAMESPACE).filter(goal => goal.tenantId === options.tenantId && goal.workspaceId === options.workspaceId);
  });
}
export async function replayGoalPlan(options: GoalMutationOptions, input: unknown): Promise<GoalDetailV2 | undefined> {
  protect(options); mutationKey(options.idempotencyKey);
  return options.store.transact(options.tenantId, tx => {
    current(tx, options);
    const saved = prior(tx, `goal.plan_proposed:${options.workspaceId}:${options.principalId}:${options.goalId}`, options.idempotencyKey, sha256({ input, expectedStreamVersion: options.expectedStreamVersion }));
    return saved ? mutationResponse(tx, options, "plan_proposed", saved) : undefined;
  });
}

export async function proposeGoalPlan(options: GoalMutationOptions & { readonly proposal: GoalPlanProposalV2;
  /** Host-derived public intent; execution configuration remains authoritative in proposal. */
  readonly planRequest?: { readonly modelBindingId?: string; readonly scheduling?: import("@mn/contracts").AgentSchedulingRequestV2 } }): Promise<GoalDetailV2> {
  const proposal = copy(options.proposal);
  const planRequest = options.planRequest ? copy(options.planRequest) : undefined;
  if (planRequest?.modelBindingId && !planRequest.scheduling && planRequest.modelBindingId !== proposal.modelBindingId) fail("GOAL_PLAN_INVALID", "计划请求与执行配置不一致");
  return mutate(options, "plan_proposed", planRequest ?? proposal, (tx, detail) => {
    const { goal } = detail; open(goal);
    if (goal.executionRef || goal.reservation) fail("GOAL_PLAN_IN_PROGRESS", "已派发计划不能替换");
    const thread = tx.getProjection<Thread>("thread", goal.threadId);
    if (!thread || thread.streamVersion !== proposal.threadStreamVersion || thread.pluginId !== proposal.pluginId
      || !["opc", "coding"].includes(proposal.pluginId) || !["builtin", "codex-cli", "claude-cli"].includes(proposal.runnerId) || !proposal.agentDefinitionId?.trim()
      || !proposal.pluginVersion?.trim() || !proposal.modelBindingId?.trim() || !proposal.model?.trim() || !integer(proposal.modelConnectionStreamVersion, 1)
      || !/^[a-f0-9]{64}$/u.test(proposal.domainInputDigest)
      || !Array.isArray(proposal.toolIds) || !Array.isArray(proposal.dataScopes) || !Array.isArray(proposal.autoAllowedEffects)) fail("GOAL_PLAN_INVALID", "计划执行配置无效或会话已变化");
    resources(tx, options, goal.resourceRefs);
    const body = { ...proposal, id: options.id("goal-plan"), goalId: goal.id, threadId: goal.threadId, revision: (detail.plan?.revision ?? 0) + 1,
      inputVersion: goal.inputVersion, criteriaVersion: goal.criteriaVersion, budget: goal.budget, resourceRefs: goal.resourceRefs, deliverables: goal.deliverables, createdAt: options.now() };
    const plan: GoalPlanRevisionV2 = { ...body, digest: sha256(body) };
    options.ports.assertPlan(tx, { goal, plan });
    tx.putProjection(GOAL_PLAN_NAMESPACE, plan.id, plan);
    return { ...goal, status: "awaiting_authorization", planRevisionId: plan.id };
  });
}
export async function startGoal(options: GoalMutationOptions & { readonly planRevisionId: string; readonly planDigest: string }): Promise<GoalDetailV2> {
  return mutate(options, "started", { planRevisionId: options.planRevisionId, planDigest: options.planDigest }, (tx, detail) => {
    const { goal } = detail, plan = planRequired(detail); open(goal);
    if (goal.principalId !== options.principalId) fail("GOAL_CONTROLLER_REQUIRED", "只有目标创建者可以授权启动");
    if (plan.id !== options.planRevisionId || plan.digest !== options.planDigest) fail("GOAL_PLAN_CHANGED", "只能授权当前计划的确切版本");
    if (goal.status !== "awaiting_authorization" || goal.executionRef) fail("GOAL_PLAN_IN_PROGRESS", "此目标已经派发");
    const thread = tx.getProjection<Thread>("thread", goal.threadId);
    if (!thread || thread.streamVersion !== plan.threadStreamVersion) fail("GOAL_PLAN_CHANGED", "会话已变化，请重新生成计划");
    if (tx.listProjections<Execution>("execution").some(execution => execution.threadId === goal.threadId
      && !["completed", "failed", "cancelled"].includes(execution.status))
      || tx.listProjections<GoalV2>(GOAL_NAMESPACE).some(other => other.id !== goal.id && other.threadId === goal.threadId
        && other.executionRef && other.reservation?.status !== "settled")) fail("GOAL_THREAD_BUSY", "会话仍有活动执行或待核实用量");
    resources(tx, options, goal.resourceRefs); options.ports.assertPlan(tx, { goal, plan });
    const next: GoalV2 = { ...goal, status: "running", reservation: { status: "reserved" }, authorization: {
      planDigest: plan.digest, principalId: options.principalId, membershipStreamVersion: authorized(tx, options).streamVersion } };
    const execution = options.ports.start(tx, { goal: next, plan });
    const withExecution: GoalV2 = { ...next, executionRef: { executionId: execution.id, threadId: goal.threadId, planRevisionId: plan.id, generation: execution.generation } };
    executionAt(tx, withExecution, plan);
    const authority = tx.getProjection<ExecutionAuthority>("authority", execution.authorityId);
    if (execution.status !== "queued" || execution.generation !== 1 || execution.initiatedBy !== options.principalId
      || !authority || sha256(authority.toolIds) !== sha256(plan.toolIds) || sha256(authority.dataScopes) !== sha256(plan.dataScopes)
      || sha256(authority.autoAllowedEffects) !== sha256(plan.autoAllowedEffects)
      || sha256(authority.budget) !== sha256({ ...plan.budget, maxSubagents: 0, maxSubagentDepth: 0 })
      || !tx.listProjections<Job>("job").some(job => job.tenantId === goal.tenantId && job.workspaceId === goal.workspaceId
        && job.kind === "agent.execution.run" && job.payload.executionId === execution.id && job.status === "available")) fail("GOAL_EXECUTION_INVALID", "派发缺少匹配的权限、执行或持久 Job");
    return withExecution;
  });
}
function checkOutputs(tx: KernelTransaction, options: GoalServiceOptions, goal: GoalV2, outputs: readonly GoalOutputRefV2[]): boolean {
  if (!Array.isArray(outputs) || outputs.length > 20 || new Set(outputs.map(output => output.key)).size !== outputs.length) fail("GOAL_OUTPUT_INVALID", "交付项重复或无效");
  for (const output of outputs) {
    if (!goal.deliverables.some(item => item.key === output.key) || typeof output.preview !== "string" || !output.preview.trim()
      || typeof output.digest !== "string" || !/^[a-f0-9]{64}$/u.test(output.digest)
      || output.resourceRef?.digest !== output.digest) fail("GOAL_OUTPUT_INVALID", "交付资源或摘要无效");
    if (output.criteriaVersion !== goal.criteriaVersion) fail("GOAL_CRITERIA_CHANGED", "交付引用了不同的验收标准");
    if (!Array.isArray(output.checks) || !output.checks.length || new Set(output.checks.map((check: GoalOutputRefV2["checks"][number]) => check.checkId)).size !== output.checks.length) fail("GOAL_OUTPUT_INVALID", "交付缺少独立的程序检查证据");
    resources(tx, options, [output.resourceRef, ...output.sourceRefs]);
    for (const check of output.checks) {
      key(check.checkId);
      if (!["passed", "failed"].includes(check.status) || !Array.isArray(check.evidenceRefs) || !check.evidenceRefs.length) fail("GOAL_OUTPUT_INVALID", "程序检查证据无效");
      resources(tx, options, check.evidenceRefs);
    }
  }
  return goal.deliverables.filter(item => item.required).every(item => outputs.some(output => output.key === item.key))
    && outputs.every(output => output.checks.every((check: GoalOutputRefV2["checks"][number]) => check.status === "passed"));
}
export async function recordExternalGoalUsage(options: GoalMutationOptions & { readonly usage: GoalUsageV2; readonly source: string }): Promise<GoalDetailV2> {
  usage(options.usage);
  if (!options.source?.trim() || options.source.length > 2000) fail("GOAL_USAGE_SOURCE_REQUIRED", "填写账单或订阅分摊依据");
  return mutate(options, "external_usage_recorded", { usage: options.usage, source: options.source }, (tx, detail) => {
    const plan = planRequired(detail), goal = detail.goal;
    if (authorized(tx, options).workspaceRole !== "owner") fail("FORBIDDEN", "仅工作区所有者可以核对外部用量");
    if (plan.runnerId === "builtin" || !goal.executionRef) fail("GOAL_EXTERNAL_USAGE_INVALID", "此目标没有外部 CLI 执行");
    const execution = executionAt(tx, goal, plan);
    if (!["completed", "failed", "cancelled"].includes(execution.status) || hasUnsettledToolCalls(tx, execution.id)) fail("GOAL_EXECUTION_PENDING", "先核对外部执行结果，再登记用量");
    if (options.usage.currency !== goal.budget.currency) fail("GOAL_BUDGET_CURRENCY_MISMATCH", "账单币种与目标预算不一致");
    if (tx.getProjection("goal.externalUsage", execution.id) || goal.reservation?.status === "settled") fail("GOAL_USAGE_CONFLICT", "本次执行的用量已固定，不能覆盖");
    tx.putProjection("goal.externalUsage", execution.id, { executionId: execution.id, goalId: goal.id, tenantId: options.tenantId, workspaceId: options.workspaceId,
      usage: options.usage, source: options.source, recordedBy: options.principalId, createdAt: options.now(), streamVersion: 1 });
    appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: "goal.externalUsage", aggregateId: execution.id, expectedStreamVersion: 0,
      type: "goal.external_usage_recorded", actorId: options.principalId, generation: execution.generation, correlationId: options.id("goal-usage"), publicPayload: { workspaceId: options.workspaceId, goalId: goal.id } });
    return observeState(tx, options, detail);
  });
}

export async function advanceGoal(options: GoalMutationOptions): Promise<GoalDetailV2> {
  return mutate(options, "observed", {}, (tx, detail) => observeState(tx, options, detail));
}
function observeState(tx: KernelTransaction, options: GoalServiceOptions, detail: GoalDetailV2): GoalV2 {
  const { goal } = detail, plan = planRequired(detail);
  if (goal.status === "accepted") fail("GOAL_CLOSED", "目标已接受");
  if (!goal.executionRef) fail("GOAL_EXECUTION_REQUIRED", "目标尚未派发");
  if (!goal.cancellationRequestedAt) validAuthorization(tx, options, goal, plan);
  const execution = executionAt(tx, goal, plan), observed = copy(options.ports.observe(tx, { goal, plan, execution,
    ...(goal.cancellationRequestedAt ? { accountingOnly: true } : {}) }));
  if (observed.generation !== execution.generation || observed.executionStreamVersion !== execution.streamVersion) fail("GOAL_EXECUTION_CHANGED", "观察结果不属于当前执行版本");
  let next = goal;
  const terminal = ["completed", "failed", "cancelled"].includes(execution.status);
  if (terminal) {
    if (observed.usage) {
      usage(observed.usage);
      if (observed.usage.currency !== goal.budget.currency) fail("GOAL_BUDGET_CURRENCY_MISMATCH", "用量币种与目标预算不同");
      if (goal.reservation?.status === "settled" && sha256(goal.reservation.actual) !== sha256(observed.usage)) fail("GOAL_USAGE_CONFLICT", "同一执行已有不同的用量结算");
      next = { ...next, reservation: { status: "settled", actual: observed.usage } };
    } else if (goal.reservation?.status !== "settled") next = { ...next, reservation: { status: "unknown" } };
  }
  if (goal.cancellationRequestedAt) return { ...next, status: terminal && next.reservation?.status === "settled" ? "cancelled" : "needs_reconciliation",
    reasonCode: !terminal ? "GOAL_CANCELLATION_PENDING" : next.reservation?.status !== "settled" ? "GOAL_USAGE_UNKNOWN" : undefined };
  const actual = next.reservation?.actual;
  if (actual && (actual.tokens > goal.budget.maxTokens || BigInt(actual.costMinorUnits) > BigInt(goal.budget.maxCostMinorUnits))) return { ...next, status: "needs_reconciliation", reasonCode: "GOAL_BUDGET_OVERRUN" };
  if (terminal && next.reservation?.status !== "settled") return { ...next, status: "needs_reconciliation", reasonCode: "GOAL_USAGE_UNKNOWN" };
  if (["failed", "cancelled"].includes(execution.status)) return { ...next, status: "failed", reasonCode: "GOAL_EXECUTION_FAILED" };
  if (execution.status === "completed") {
    const outputs = observed.outputs ?? [];
    if (!checkOutputs(tx, options, goal, outputs)) return { ...next, status: "failed", reasonCode: "GOAL_DELIVERY_INCOMPLETE" };
    const body = { goalId: goal.id, planRevisionId: plan.id, criteriaVersion: goal.criteriaVersion, items: outputs };
    const digest = sha256(body), id = `goal-delivery-${digest}`;
    if (goal.deliverySetId && goal.deliverySetId !== id) fail("GOAL_OUTPUT_INVALID", "已登记的交付集合不可覆盖");
    const deliverySet: GoalDeliverySetV2 = { ...body, id, digest, createdAt: options.now() };
    options.ports.assertAcceptance(tx, { goal: next, plan, deliverySet });
    if (!tx.getProjection(GOAL_DELIVERY_SET_NAMESPACE, id)) tx.putProjection(GOAL_DELIVERY_SET_NAMESPACE, id, deliverySet);
    const { reasonCode: _reason, ...clean } = next;
    return { ...clean, status: "awaiting_acceptance", deliverySetId: id };
  }
  if (execution.status === "waiting_approval") return { ...next, status: "waiting_approval" };
  if (["needs_reconciliation", "paused", "interrupted"].includes(execution.status)) return { ...next, status: "needs_reconciliation", reasonCode: "GOAL_EXECUTION_PENDING" };
  const { reasonCode: _reason, ...clean } = next; return { ...clean, status: "running" };
}
/** Host-only polling; unchanged observations do not create facts or mutation receipts. */
export async function observeGoalInBackground(options: GoalServiceOptions & { readonly goalId: string }): Promise<void> {
  protect(options);
  await options.store.transact(options.tenantId, tx => {
    const detail = current(tx, options);
    if (detail.goal.status === "accepted" || !detail.goal.executionRef) return;
    const next = observeState(tx, options, detail);
    if (sha256(next) !== sha256(detail.goal)) write(tx, options, detail.goal, next, "observed");
  });
}
export async function cancelGoal(options: GoalMutationOptions): Promise<GoalDetailV2> {
  return mutate(options, "cancelled", {}, (tx, detail) => {
    open(detail.goal);
    if (detail.goal.executionRef) {
      const plan = planRequired(detail), execution = executionAt(tx, detail.goal, plan);
      options.ports.cancel(tx, { goal: detail.goal, plan, execution });
      const cancelled = tx.getProjection<Execution>("execution", execution.id);
      if (!cancelled || !["completed", "failed", "cancelled", "needs_reconciliation"].includes(cancelled.status)) fail("GOAL_CANCELLATION_PENDING", "原执行尚未停止，取消事务未提交");
      if (cancelled.status === "needs_reconciliation") return { ...detail.goal, status: "needs_reconciliation",
        cancellationRequestedAt: detail.goal.cancellationRequestedAt ?? options.now(), reasonCode: "GOAL_CANCELLATION_PENDING" };
    }
    return { ...detail.goal, status: detail.goal.executionRef && detail.goal.reservation?.status !== "settled" ? "needs_reconciliation" : "cancelled",
      cancellationRequestedAt: detail.goal.cancellationRequestedAt ?? options.now(),
      ...(detail.goal.executionRef && detail.goal.reservation?.status !== "settled" ? { reasonCode: "GOAL_USAGE_UNKNOWN" } : {}) };
  });
}
export async function acceptGoalDelivery(options: GoalMutationOptions & { readonly deliverySetId: string; readonly criteriaVersion: string;
  readonly items: readonly { readonly key: string; readonly digest: string; readonly reviewedCriterionIds: readonly string[] }[] }): Promise<GoalDetailV2> {
  const input = copy({ deliverySetId: options.deliverySetId, criteriaVersion: options.criteriaVersion, items: options.items });
  return mutate(options, "accepted", input, (tx, detail) => {
    const { goal, deliverySet } = detail, plan = planRequired(detail); open(goal);
    if (goal.principalId !== options.principalId) fail("GOAL_CONTROLLER_REQUIRED", "只有目标创建者可以接收成果");
    if (input.criteriaVersion !== goal.criteriaVersion) fail("GOAL_CRITERIA_CHANGED", "验收标准版本已变化");
    if (goal.status !== "awaiting_acceptance" || !deliverySet || deliverySet.id !== input.deliverySetId) fail("GOAL_DELIVERY_NOT_READY", "目标尚无对应的可验收成果");
    validAuthorization(tx, options, goal, plan);
    const { id: _id, digest, createdAt: _time, ...body } = deliverySet;
    if (sha256(body) !== digest || deliverySet.id !== `goal-delivery-${digest}` || deliverySet.criteriaVersion !== goal.criteriaVersion
      || !checkOutputs(tx, options, goal, deliverySet.items)) fail("GOAL_DELIVERY_INVALID", "交付集合或检查证据已失效");
    if (!Array.isArray(input.items) || input.items.length !== deliverySet.items.length || new Set(input.items.map(item => item.key)).size !== input.items.length) fail("GOAL_DELIVERY_INCOMPLETE", "请逐项接受整套交付清单");
    for (const output of deliverySet.items) {
      const accepted = input.items.find(item => item.key === output.key), spec = goal.deliverables.find(item => item.key === output.key)!;
      if (!accepted || accepted.digest !== output.digest) fail("GOAL_DELIVERY_INCOMPLETE", "接受的成果版本不一致");
      if (!Array.isArray(accepted.reviewedCriterionIds) || accepted.reviewedCriterionIds.length !== spec.criteria.length
        || new Set(accepted.reviewedCriterionIds).size !== spec.criteria.length || spec.criteria.some(criterion => !accepted.reviewedCriterionIds.includes(criterion.id))) fail("GOAL_CRITERIA_NOT_REVIEWED", "请逐条复核并确认所有验收标准");
    }
    options.ports.assertAcceptance(tx, { goal, plan, deliverySet });
    const id = options.id("goal-acceptance");
    const acceptance: GoalDeliveryAcceptanceV2 = { id, goalId: goal.id, deliverySetId: deliverySet.id, criteriaVersion: goal.criteriaVersion,
      principalId: options.principalId, acceptedAt: options.now(), items: input.items };
    tx.putProjection(GOAL_DELIVERY_ACCEPTANCE_NAMESPACE, id, acceptance);
    return { ...goal, status: "accepted", acceptanceId: id };
  });
}
