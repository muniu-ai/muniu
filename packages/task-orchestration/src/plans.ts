// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, type GoalBudgetV2, type GoalDeliverableSpecV2, type GoalResourceRefV2, type GoalTeamPlanProposalV2,
  type GoalCoordinatedPlanProposalV2, type GoalSinglePlanProposalV2, type ResourceRef, type TeamAgentCapabilityV1, type TeamAgentNodeV1, type TeamPlanLimitsV1, type TeamPlanNodeV1, type ToolEffectClass } from "@mn/contracts";
import { validateGoalBudget } from "./goal-rules.js";
import { getTeamTemplate, TEAM_DEFAULT_LIMITS } from "./templates.js";

export class TeamPlanValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TeamPlanValidationError"; }
}
export interface TeamPlanValidationContext {
  readonly resourceRefs: readonly GoalResourceRefV2[];
  readonly budget: GoalBudgetV2;
  readonly deliverables: readonly GoalDeliverableSpecV2[];
  readonly capabilities: readonly TeamAgentCapabilityV1[];
  readonly authority: { readonly toolIds: readonly string[]; readonly dataScopes: readonly ResourceRef[]; readonly autoAllowedEffects: readonly ToolEffectClass[] };
  readonly workspaceLimits?: Partial<TeamPlanLimitsV1>;
  readonly cumulative?: { readonly nodes: number; readonly nodeIds?: readonly string[]; readonly attempts: number; readonly reworkRounds: number; readonly delegationDepth: number };
  readonly reusedNodeIds?: readonly string[];
  readonly sandboxAvailable?: boolean;
}
function fail(code: string, message: string): never { throw new TeamPlanValidationError(code, message); }
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(key) && new Set(value).size === value.length;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const subset = <T>(values: readonly T[], allowed: readonly T[]): boolean => values.every(value => allowed.includes(value));
function scopeWithin(scope: ResourceRef, parent: ResourceRef): boolean {
  return scope?.namespace === parent.namespace && (parent.resourceId === "*" || scope.resourceId === parent.resourceId)
    && (!parent.digest || scope.digest === parent.digest);
}
function graph(nodes: readonly TeamPlanNodeV1[]): { nodes: Map<string, TeamPlanNodeV1>; order: string[] } {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > TEAM_DEFAULT_LIMITS.maxNodes) fail("TEAM_DAG_INVALID", "计划节点数量无效");
  const map = new Map<string, TeamPlanNodeV1>();
  for (const node of nodes) {
    if (!node || !key(node.id) || map.has(node.id) || !strings(node.dependsOn) || node.dependsOn.includes(node.id)) fail("TEAM_DAG_INVALID", "节点标识或依赖无效");
    map.set(node.id, node);
  }
  if (nodes.some(node => node.dependsOn.some((id: string) => !map.has(id)))) fail("TEAM_DAG_INVALID", "依赖节点不存在");
  const order: string[] = [], completed = new Set<string>();
  while (order.length < nodes.length) {
    const ready = nodes.filter(node => !completed.has(node.id) && node.dependsOn.every((id: string) => completed.has(id)));
    if (!ready.length) fail("TEAM_DAG_INVALID", "计划依赖存在循环");
    for (const node of ready) { completed.add(node.id); order.push(node.id); }
  }
  return { nodes: map, order };
}
function limits(plan: GoalCoordinatedPlanProposalV2, context: TeamPlanValidationContext): void {
  for (const name of Object.keys(TEAM_DEFAULT_LIMITS) as (keyof TeamPlanLimitsV1)[]) {
    const workspace = context.workspaceLimits?.[name] ?? TEAM_DEFAULT_LIMITS[name], value = plan.limits?.[name];
    if (!integer(workspace) || !integer(value, ["maxDelegationDepth", "maxReworkRounds"].includes(name) ? 0 : 1)
      || value > Math.min(workspace, TEAM_DEFAULT_LIMITS[name])) fail("TEAM_LIMIT_EXCEEDED", "计划超过工作区执行上限");
  }
  const used = context.cumulative ?? { nodes: 0, attempts: 0, reworkRounds: 0, delegationDepth: 1 };
  if (context.reusedNodeIds && (new Set(context.reusedNodeIds).size !== context.reusedNodeIds.length
    || context.reusedNodeIds.some(id => !plan.nodes.some(node => node.id === id && node.kind === 'agent')))) fail('TEAM_REUSE_INVALID', '只能显式沿用已核验的执行节点');
  if ([used.nodes, used.attempts, used.reworkRounds, used.delegationDepth].some(value => !integer(value))
    || used.nodes + plan.nodes.filter(node => !context.reusedNodeIds?.includes(node.id)).length > plan.limits.maxNodes
    || used.attempts + plan.nodes.filter(node => node.kind === "agent" && !context.reusedNodeIds?.includes(node.id)).length > plan.limits.maxAttempts
    || used.reworkRounds > plan.limits.maxReworkRounds || used.delegationDepth > plan.limits.maxDelegationDepth) fail("TEAM_LIMIT_EXCEEDED", "累计节点、尝试或返工已超过上限");
}
function inputs(node: TeamPlanNodeV1, nodes: Map<string, TeamPlanNodeV1>, context: TeamPlanValidationContext): void {
  if (!Array.isArray(node.inputs) || node.inputs.length > 100 || new Set(node.inputs.map(input => input?.key)).size !== node.inputs.length) fail("TEAM_INPUT_DENIED", "节点输入重复或过多");
  for (const input of node.inputs) {
    if (!input || !key(input.key)) fail("TEAM_INPUT_DENIED", "节点输入标识无效");
    if (input.kind === "goal") continue;
    if (input.kind === "source") {
      if (!input.resourceRef || !context.resourceRefs.some(ref => same(ref, input.resourceRef))) fail("TEAM_INPUT_DENIED", "节点资料不属于当前授权版本");
    } else if (input.kind === "node_output") {
      if (!node.dependsOn.includes(input.nodeId) || !nodes.get(input.nodeId)?.outputs.some(output => output.key === input.outputKey)) fail("TEAM_INPUT_DENIED", "节点只能读取已声明依赖的指定成果");
    } else fail("TEAM_INPUT_DENIED", "节点输入类型无效");
  }
  if (node.kind === "agent" && node.id !== "review" && node.dependsOn.some(dependency => !node.inputs.some(input => input.kind === "node_output" && input.nodeId === dependency))) fail("TEAM_INPUT_DENIED", "节点缺少前置成果输入");
}
function executor(node: TeamAgentNodeV1, plan: GoalCoordinatedPlanProposalV2, context: TeamPlanValidationContext): TeamAgentCapabilityV1 {
  const value = node.executor;
  if (!value || value.domainInputDigest !== plan.domainInputDigest || value.threadStreamVersion !== plan.threadStreamVersion
    || !key(value.pluginVersion) || !key(value.agentDefinitionId) || !key(value.modelBindingId) || typeof value.model !== "string" || !value.model.trim()
    || !integer(value.modelConnectionStreamVersion, 1) || !strings(value.toolIds) || !strings(value.autoAllowedEffects) || !Array.isArray(value.dataScopes)
    || value.dataScopes.length > 100 || (value.pluginPackageSha256 !== undefined && !digest(value.pluginPackageSha256))) fail("TEAM_EXECUTOR_INVALID", "节点执行配置与固定输入不一致");
  const matches = context.capabilities.filter(capability => capability.id === node.capabilityRef?.id && capability.version === node.capabilityRef.version && capability.digest === node.capabilityRef.digest);
  if (matches.length !== 1) fail("TEAM_CAPABILITY_DENIED", "节点能力声明不存在或已变化");
  const capability = matches[0]!;
  if (!digest(capability.digest) || !capability.evaluationVersion || capability.pluginId !== value.pluginId || capability.agentDefinitionId !== value.agentDefinitionId
    || !capability.runnerIds.includes(value.runnerId) || !subset(value.toolIds, capability.toolIds) || !subset(value.autoAllowedEffects, capability.effectClasses)
    || !subset(node.inputs.map(input => input.kind), capability.inputKinds) || !subset(node.outputs.map(output => output.kind), capability.outputKinds)
    || (capability.isolation === "required_sandbox" && context.sandboxAvailable !== true)) fail("TEAM_CAPABILITY_DENIED", "节点超出能力声明或隔离条件");
  if (!subset(value.toolIds, context.authority.toolIds) || !subset(value.autoAllowedEffects, context.authority.autoAllowedEffects)
    || value.dataScopes.some(scope => !scope?.namespace || !scope.resourceId || !context.authority.dataScopes.some(parent => scopeWithin(scope, parent)))) fail("TEAM_AUTHORITY_DENIED", "子节点权限不能超出父授权");
  if (plan.kind === 'team-v1' && capability.costControl !== "hard_limit") fail("TEAM_BUDGET_UNCONTROLLED", "此计划需要可强制控制费用的执行者");
  return capability;
}
function review(node: TeamAgentNodeV1, nodes: Map<string, TeamPlanNodeV1>, capability: TeamAgentCapabilityV1): void {
  if (node.id !== "review") { if (node.review) fail("TEAM_REVIEW_INVALID", "只有固定复核节点可声明独立复核"); return; }
  if (node.review?.independent !== true || !same(node.review.producerNodeIds, node.dependsOn) || !capability.independentReview
    || !node.inputs.some(input => input.kind === "goal") || !node.outputs.some(output => output.kind === "review")
    || !subset(capability.effectClasses, ["local_read", "external_read"]) || !subset(node.executor.autoAllowedEffects, ["local_read", "external_read"])) fail("TEAM_REVIEW_INVALID", "独立复核必须读取原始要求并保持只读");
  for (const producerId of node.review.producerNodeIds) {
    const kinds = node.inputs.filter(input => input.kind === "node_output" && input.nodeId === producerId)
      .map(input => input.kind === "node_output" ? nodes.get(producerId)!.outputs.find(output => output.key === input.outputKey)!.kind : undefined);
    if (!kinds.some(kind => kind === "artifact" || kind === "analysis") || !kinds.includes("evidence")) fail("TEAM_REVIEW_INVALID", "独立复核必须读取生成成果及来源证据");
  }
  if (node.inputs.some(input => input.kind === "node_output" && nodes.get(input.nodeId)!.outputs.find(output => output.key === input.outputKey)?.kind === "self_assessment")) fail("TEAM_REVIEW_INVALID", "独立复核不能接收生成者自评分");
}
function deliveries(plan: GoalTeamPlanProposalV2, nodes: Map<string, TeamPlanNodeV1>, context: TeamPlanValidationContext): void {
  for (const node of plan.nodes) if (node.kind === "join") {
    if (!Array.isArray(node.mappings) || node.mappings.length !== node.outputs.length || new Set(node.mappings.map(mapping => mapping?.outputKey)).size !== node.mappings.length) fail("TEAM_DELIVERY_INVALID", "成果汇合映射重复或缺失");
    for (const mapping of node.mappings) {
      const output = node.outputs.find(output => output.key === mapping.outputKey), source = nodes.get(mapping.fromNodeId)?.outputs.find(output => output.key === mapping.fromOutputKey);
      if (!output || !source || output.kind !== source.kind || !node.dependsOn.includes(mapping.fromNodeId)
        || !node.inputs.some(input => input.kind === "node_output" && input.nodeId === mapping.fromNodeId && input.outputKey === mapping.fromOutputKey)) fail("TEAM_DELIVERY_INVALID", "成果汇合必须绑定已声明的输入版本");
    }
  }
  if (!Array.isArray(plan.deliverableBindings) || plan.deliverableBindings.length > 20
    || new Set(plan.deliverableBindings.map(binding => binding?.deliverableKey)).size !== plan.deliverableBindings.length
    || context.deliverables.filter(item => item.required).some(item => !plan.deliverableBindings.some(binding => binding.deliverableKey === item.key))) fail("TEAM_DELIVERY_INVALID", "计划缺少必需交付项或存在重复绑定");
  for (const binding of plan.deliverableBindings) {
    const node = nodes.get(binding.nodeId);
    if (!context.deliverables.some(item => item.key === binding.deliverableKey) || node?.id !== "handoff" || node.kind !== "join"
      || !node.outputs.some(output => output.key === binding.outputKey && ["artifact", "analysis"].includes(output.kind))) fail("TEAM_DELIVERY_INVALID", "交付项必须来自经过复核的汇合成果");
  }
}
/** Admission is pure. Host still checks live grants, capability provenance and source versions at each dispatch. */
export function assertTeamPlan(plan: GoalTeamPlanProposalV2, context: TeamPlanValidationContext): { readonly topologicalOrder: readonly string[] } {
  if (!plan || plan.kind !== "team-v1" || !digest(plan.domainInputDigest) || !integer(plan.threadStreamVersion, 1)) fail("TEAM_TEMPLATE_INVALID", "团队计划版本或输入摘要无效");
  const { nodes, order } = graph(plan.nodes);
  let template;
  try { template = getTeamTemplate(plan.template?.id); } catch { return fail("TEAM_TEMPLATE_INVALID", "团队模板不存在"); }
  if (plan.template.version !== template.version || plan.template.digest !== template.digest || plan.pluginId !== template.pluginId || nodes.size !== template.nodes.length) fail("TEAM_TEMPLATE_INVALID", "团队模板版本或节点已改变");
  for (const fixed of template.nodes) {
    const node = nodes.get(fixed.id);
    if (!node || node.kind !== fixed.kind || !same(node.dependsOn, fixed.dependsOn) || (node.kind === "agent" && (node.roleId !== fixed.roleId
      || node.executor?.pluginId !== fixed.pluginId || (fixed.agentDefinitionId && node.executor?.agentDefinitionId !== fixed.agentDefinitionId)))) fail("TEAM_TEMPLATE_INVALID", "首版仅允许固定团队角色与依赖");
    if (typeof node.title !== "string" || !node.title.trim() || node.title.length > 200 || !Array.isArray(node.outputs) || !node.outputs.length || node.outputs.length > 20
      || new Set(node.outputs.map(output => output?.key)).size !== node.outputs.length || node.outputs.some(output => !output || !key(output.key)
        || !["analysis", "artifact", "evidence", "self_assessment", "review", "decision"].includes(output.kind) || typeof output.description !== "string" || !output.description.trim() || output.description.length > 2000)) fail("TEAM_DELIVERY_INVALID", "节点输出声明无效");
    if (node.kind === "human_decision" && (typeof node.prompt !== "string" || !node.prompt.trim() || node.prompt.length > 2000 || !same(node.choices, ["continue", "stop"]))) fail("TEAM_TEMPLATE_INVALID", "人工决定必须明确继续或停止");
  }
  limits(plan, context);
  let totalTokens = 0n, totalCost = 0n;
  try { validateGoalBudget(context.budget); } catch { fail("TEAM_BUDGET_INVALID", "目标预算无效"); }
  for (const node of plan.nodes) {
    inputs(node, nodes, context);
    if (node.kind !== "agent") continue;
    const capability = executor(node, plan, context); review(node, nodes, capability);
    try { validateGoalBudget(node.budget); } catch { fail("TEAM_BUDGET_INVALID", "节点预算无效"); }
    // V1 execution uses the remaining shared deadline; no separate per-node timer is promised.
    if (node.budget.currency !== context.budget.currency || node.budget.maxDurationMs !== context.budget.maxDurationMs) fail("TEAM_BUDGET_INVALID", "节点必须使用目标预算币种和统一期限");
    if (!context.reusedNodeIds?.includes(node.id)) { totalTokens += BigInt(node.budget.maxTokens); totalCost += BigInt(node.budget.maxCostMinorUnits); }
  }
  if (totalTokens > BigInt(context.budget.maxTokens) || totalCost > BigInt(context.budget.maxCostMinorUnits)) fail("TEAM_BUDGET_INVALID", "节点预算总额超过目标预算");
  deliveries(plan, nodes, context);
  return { topologicalOrder: Object.freeze(order) };
}
/** One original executor; Host verifies the prior plan, current runner identity and remaining aggregate allowance. */
export function assertSinglePlan(plan: GoalSinglePlanProposalV2, context: TeamPlanValidationContext): { readonly topologicalOrder: readonly string[] } {
  if (plan.kind !== 'single-v2' || !digest(plan.domainInputDigest) || !integer(plan.threadStreamVersion, 1)
    || plan.nodes.length !== 1 || plan.nodes[0]!.id !== 'execute' || plan.nodes[0]!.kind !== 'agent'
    || plan.nodes[0]!.dependsOn.length || plan.nodes[0]!.review) fail('GOAL_SINGLE_PLAN_INVALID', '单执行者返工只能包含原执行者节点');
  const node = plan.nodes[0]! as TeamAgentNodeV1, map = graph(plan.nodes).nodes;
  limits(plan, context); inputs(node, map, context); executor(node, plan, context);
  validateGoalBudget(context.budget); validateGoalBudget(node.budget);
  if (node.executor.pluginId !== plan.pluginId || node.budget.currency !== context.budget.currency || node.budget.maxTokens > context.budget.maxTokens
    || BigInt(node.budget.maxCostMinorUnits) > BigInt(context.budget.maxCostMinorUnits) || node.budget.maxDurationMs !== context.budget.maxDurationMs
    || !node.outputs.length || new Set(node.outputs.map(output => output.key)).size !== node.outputs.length
    || plan.deliverableBindings.length > 20 || new Set(plan.deliverableBindings.map(binding => binding.deliverableKey)).size !== plan.deliverableBindings.length
    || context.deliverables.filter(spec => spec.required).some(spec => !plan.deliverableBindings.some(binding => binding.deliverableKey === spec.key))
    || plan.deliverableBindings.some(binding => binding.nodeId !== 'execute' || !context.deliverables.some(spec => spec.key === binding.deliverableKey)
      || !node.outputs.some(output => output.key === binding.outputKey && ['artifact', 'analysis'].includes(output.kind)))) fail('GOAL_SINGLE_PLAN_INVALID', '单执行者返工的成果或预算无效');
  return { topologicalOrder: ['execute'] };
}
export type TeamNodeProgress = "pending" | "running" | "completed" | "failed" | "cancelled" | "needs_reconciliation";
/** Completed means a current, verified result; unknown results can never become retry candidates here. */
export function readyTeamNodes(plan: GoalCoordinatedPlanProposalV2, states: Readonly<Record<string, TeamNodeProgress>>, control: "running" | "paused" | "cancelled" = "running"): readonly TeamPlanNodeV1[] {
  if (control !== "running" || plan.nodes.some(node => !states[node.id] || ["failed", "cancelled", "needs_reconciliation"].includes(states[node.id]!))) return [];
  let slots = plan.limits.maxParallelNodes - plan.nodes.filter(node => node.kind === "agent" && states[node.id] === "running").length;
  return plan.nodes.filter(node => {
    if (states[node.id] !== "pending" || !node.dependsOn.every(id => states[id] === "completed")) return false;
    if (node.kind === "agent") return slots-- > 0;
    return true;
  });
}
