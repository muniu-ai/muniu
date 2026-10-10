// SPDX-License-Identifier: Apache-2.0
import type { GoalPlanProposalV2, GoalTeamPlanProposalV2, GoalCoordinatedPlanProposalV2, GoalCoordinatedPlanV2, GoalV2, ResourceRef,
  TeamAgentCapabilityV1, TeamAgentNodeV1, TeamNodeInputV1, TeamPlanNodeV1, TeamTemplateIdV1, TeamTemplateSummaryV1, ToolEffectClass, Workspace } from "@mn/contracts";
import { findModelPrice, KernelError, PROVIDER_PRESETS, sha256, type KernelTransaction, type ModelConnection } from "@mn/kernel";
import { assertSinglePlan, assertTeamPlan, getTeamTemplate, listTeamTemplates, TEAM_DEFAULT_LIMITS, TeamPlanValidationError } from "@mn/task-orchestration";
import { createHostGoalRuntime, type HostGoalRuntimeOptions } from "./goal-runtime.js";
import { externalGoalRunnerBindingValid } from "./goal-external-rework.js";
import { runnerPluginId, runnerToolId } from "./coding-runners.js";

export interface HostTeamRuntimeOptions extends HostGoalRuntimeOptions { readonly sandboxAvailable?: boolean }

function fail(code: string, message: string): never { throw new KernelError(code, message, "检查团队模板、资料及模型连接后重新规划"); }
export function teamPlanAuthority(plan: Pick<GoalCoordinatedPlanProposalV2, "nodes">): { toolIds: string[]; dataScopes: ResourceRef[]; autoAllowedEffects: ToolEffectClass[] } {
  const agents = plan.nodes.filter((node): node is TeamAgentNodeV1 => node.kind === "agent");
  const scopes = new Map(agents.flatMap(node => node.executor.dataScopes).map(ref => [sha256(ref), ref]));
  return { toolIds: [...new Set(agents.flatMap(node => node.executor.toolIds))], dataScopes: [...scopes.values()],
    autoAllowedEffects: [...new Set(agents.flatMap(node => node.executor.autoAllowedEffects))] };
}

export function currentTeamCapabilities(options: HostTeamRuntimeOptions, tx: KernelTransaction, goal: GoalV2,
  plan: Pick<GoalCoordinatedPlanProposalV2, "nodes"> & { readonly kind?: GoalCoordinatedPlanProposalV2["kind"] }): TeamAgentCapabilityV1[] {
  return plan.nodes.filter((node): node is TeamAgentNodeV1 => node.kind === "agent").map(node => {
    const definition = options.definitions.find(item => item.id === node.executor.pluginId);
    const model = tx.getProjection<ModelConnection>("modelConnection", node.executor.modelBindingId);
    const price = model && findModelPrice(model.presetId, model.defaultModel);
    const workspace = tx.getProjection<Workspace>("workspace", goal.workspaceId);
    if (!workspace?.activePluginIds.includes(node.executor.pluginId) || !definition
      || !definition.contributions.agents.some(agent => agent.id === node.executor.agentDefinitionId)) fail("GOAL_EXECUTOR_UNAVAILABLE", "团队成员所需插件或执行者未启用");
    const externalRunnerId = node.executor.runnerId === "builtin" ? undefined : node.executor.runnerId;
    const external = externalRunnerId !== undefined;
    const runner = externalRunnerId ? options.definitions.find(item => item.id === runnerPluginId(externalRunnerId)) : undefined;
    if (external && (plan.kind !== "single-v2" || plan.nodes.length !== 1 || !externalGoalRunnerBindingValid(tx, goal, node.executor)
      || !runner?.contributions.tools.some(tool => tool.id === runnerToolId(externalRunnerId!) && tool.effectClass === "external_side_effect")))
      fail("GOAL_EXECUTOR_UNAVAILABLE", "返工 CLI 身份或受控工具不可用");
    if (!external && (!model || model.tenantId !== goal.tenantId || model.status !== "ready" || !price || price.rates.currency !== goal.budget.currency))
      fail("GOAL_BUDGET_UNCONTROLLED", "团队首版需要具备同币种费用控制的内置模型");
    if ((!external && (node.executor.modelConnectionStreamVersion !== model!.streamVersion || node.executor.model !== model!.defaultModel))
      || node.executor.pluginVersion !== definition.version || node.executor.pluginPackageSha256 !== definition.manifest?.packageSha256)
      fail("GOAL_PLAN_CHANGED", "团队模型或插件版本已变化");
    if (node.executor.toolIds.some(id => !definition.contributions.tools.some(tool => tool.id === id) && !(external && id === runnerToolId(externalRunnerId!) && runner?.contributions.tools.some(tool => tool.id === id && tool.effectClass === "external_side_effect")))) fail("GOAL_EXECUTOR_UNAVAILABLE", "团队工具已不可用");
    const readOnly = node.executor.pluginId === "opc";
    const body = { id: `team.${node.roleId}`, version: "1", pluginId: node.executor.pluginId,
      agentDefinitionId: plan.kind === "single-v2" ? node.executor.agentDefinitionId : readOnly ? "opc.business-assistant" : "coding.builtin",
      inputKinds: ["goal", "source", "node_output"] as const,
      outputKinds: ["artifact", "analysis", "evidence", "review"] as const,
      toolIds: plan.kind === "single-v2" ? node.executor.toolIds : readOnly ? [] : ["coding.repository.read", "coding.sandbox.write", "coding.gate.verify", "coding.candidate.accept"],
      effectClasses: plan.kind === "single-v2" ? node.executor.autoAllowedEffects : readOnly ? ["local_read"] as const : ["local_read", "local_reversible_write"] as const,
      runnerIds: external ? [node.executor.runnerId] : ["builtin"] as const, isolation: readOnly && !external ? "none" as const : "required_sandbox" as const,
      dataDestinations: [external ? `runner:${node.executor.runnerId}` : PROVIDER_PRESETS.find(preset => preset.id === model!.presetId)?.endpoint ?? `model:${model!.id}`, "workspace:protected-storage"],
      costControl: external ? "unknown" as const : "hard_limit" as const, independentReview: node.roleId === "review", evaluationVersion: "agent-os-v1-unmeasured" };
    return { ...body, digest: sha256({ ...body, pluginVersion: definition.version, pluginPackageSha256: definition.manifest?.packageSha256 ?? null, ...(runner ? { runnerVersion: runner.version, runnerPackageSha256: runner.manifest?.packageSha256 ?? null, runnerBinding: node.executor.runnerBinding } : {}) }) };
  });
}

export function proposeHostTeamPlan(options: HostTeamRuntimeOptions, tx: KernelTransaction, goal: GoalV2,
  templateId: TeamTemplateIdV1, modelBindingId: string): GoalTeamPlanProposalV2 {
  const template = getTeamTemplate(templateId);
  if (template.pluginId === "coding" && goal.deliverables.length !== 1) fail("GOAL_DELIVERABLE_INVALID", "代码候选作为一项完整交付物验收；文档可另设交付任务");
  const base = createHostGoalRuntime(options).proposal(tx, goal, modelBindingId);
  if (base.pluginId !== template.pluginId) fail("GOAL_TEAM_TEMPLATE_UNAVAILABLE", "团队模板与当前任务类型不一致");
  const count = template.nodes.filter(node => node.kind === "agent").length;
  const nodeBudget = { ...goal.budget, maxTokens: Math.floor(goal.budget.maxTokens / count),
    maxCostMinorUnits: (BigInt(goal.budget.maxCostMinorUnits) / BigInt(count)).toString() };
  const nodes: TeamPlanNodeV1[] = template.nodes.map(slot => {
    const dependentInputs: TeamNodeInputV1[] = slot.dependsOn.flatMap(nodeId => {
      const parent = template.nodes.find(node => node.id === nodeId)!;
      return parent.kind === "human_decision" ? [{ key: `${nodeId}.decision`, kind: "node_output", nodeId, outputKey: "decision" }]
        : [{ key: `${nodeId}.result`, kind: "node_output", nodeId, outputKey: "result" }, { key: `${nodeId}.evidence`, kind: "node_output", nodeId, outputKey: "evidence" }];
    });
    const common = { id: slot.id, title: slot.title, dependsOn: slot.dependsOn };
    if (slot.kind === "human_decision") return { ...common, kind: "human_decision", inputs: dependentInputs,
      outputs: [{ key: "decision", kind: "decision", description: "人工核对记录" }], prompt: "核对需求、方案和报价候选中的业务事实后决定是否继续；此决定不登记客户接受、订单生效或收款。", choices: ["continue", "stop"] };
    if (slot.kind === "join") {
      const producer = templateId === "research-summary" ? "synthesis" : templateId === "business-proposal" ? "proposal" : "delivery";
      return { ...common, kind: "join", inputs: [{ key: "delivery", kind: "node_output", nodeId: producer, outputKey: "result" }],
        outputs: goal.deliverables.map(item => ({ key: `delivery.${item.key}`, kind: "artifact" as const, description: item.title })),
        mappings: goal.deliverables.map(item => ({ outputKey: `delivery.${item.key}`, fromNodeId: producer, fromOutputKey: "result" })) };
    }
    const definition = options.definitions.find(item => item.id === slot.pluginId);
    if (!definition) fail("GOAL_EXECUTOR_UNAVAILABLE", "团队模板依赖的插件尚未安装");
    const readOnly = slot.pluginId === "opc";
    const executor: GoalPlanProposalV2 = { ...base, pluginId: slot.pluginId!, pluginVersion: definition.version,
      pluginPackageSha256: definition.manifest?.packageSha256,
      agentDefinitionId: readOnly ? "opc.business-assistant" : "coding.builtin", toolIds: readOnly ? [] : base.toolIds,
      dataScopes: readOnly ? [] : base.dataScopes, autoAllowedEffects: readOnly ? ["local_read"] : base.autoAllowedEffects };
    return { ...common, kind: "agent", roleId: slot.roleId!, executor, budget: nodeBudget,
      capabilityRef: { id: `team.${slot.roleId}`, version: "1", digest: "" },
      inputs: [{ key: "goal", kind: "goal" }, ...goal.resourceRefs.map((resourceRef, index): TeamNodeInputV1 => ({ key: `source.${index}`, kind: "source", resourceRef })), ...dependentInputs],
      outputs: [{ key: "result", kind: slot.id === "review" ? "review" : "artifact", description: slot.title }, { key: "evidence", kind: "evidence", description: "实际来源、成果版本和程序检查" }],
      ...(slot.id === "review" ? { review: { independent: true, producerNodeIds: slot.dependsOn } } : {}) };
  });
  const capabilities = currentTeamCapabilities(options, tx, goal, { nodes });
  const policy = tx.getProjection<{ limits?: { maxParallel?: number; maxNodes?: number; maxAttempts?: number; maxDepth?: number } }>("coordination.workspace-policy", goal.workspaceId)?.limits;
  const plan: GoalTeamPlanProposalV2 = { kind: "team-v1", outputFormat: "items-v1", template: { id: template.id, version: "1", digest: template.digest },
    pluginId: template.pluginId, domainInputDigest: base.domainInputDigest, threadStreamVersion: base.threadStreamVersion,
    nodes: nodes.map(node => {
      if (node.kind !== "agent") return node;
      const capability = capabilities.find(item => item.id === node.capabilityRef.id)!;
      return { ...node, capabilityRef: { id: capability.id, version: capability.version, digest: capability.digest } };
    }),
    deliverableBindings: goal.deliverables.map(item => ({ deliverableKey: item.key, nodeId: "handoff", outputKey: `delivery.${item.key}` })),
    limits: { ...TEAM_DEFAULT_LIMITS, maxParallelNodes: Math.min(TEAM_DEFAULT_LIMITS.maxParallelNodes, policy?.maxParallel ?? Infinity),
      maxNodes: Math.min(TEAM_DEFAULT_LIMITS.maxNodes, policy?.maxNodes ?? Infinity), maxAttempts: Math.min(TEAM_DEFAULT_LIMITS.maxAttempts, policy?.maxAttempts ?? Infinity),
      maxDelegationDepth: Math.min(TEAM_DEFAULT_LIMITS.maxDelegationDepth, policy?.maxDepth ?? Infinity) } };
  assertHostTeamPlan(options, tx, goal, plan);
  return plan;
}

export function assertHostTeamPlan(options: HostTeamRuntimeOptions, tx: KernelTransaction, goal: GoalV2,
  plan: GoalCoordinatedPlanProposalV2 | GoalCoordinatedPlanV2, reusedNodeIds?: readonly string[]): void {
  try {
    const context = { reusedNodeIds, resourceRefs: goal.resourceRefs, deliverables: goal.deliverables, budget: goal.budget,
      capabilities: currentTeamCapabilities(options, tx, goal, plan), authority: teamPlanAuthority(plan), sandboxAvailable: options.sandboxAvailable };
    if (plan.kind === "single-v2") assertSinglePlan(plan, context); else assertTeamPlan(plan, context);
  }
  catch (error) { if (error instanceof TeamPlanValidationError) fail(error.code, error.message); throw error; }
}

export function hostTeamTemplates(options: HostTeamRuntimeOptions, tx: KernelTransaction, tenantId: string, workspaceId: string): TeamTemplateSummaryV1[] {
  const workspace = tx.getProjection<Workspace>("workspace", workspaceId);
  if (!workspace || workspace.tenantId !== tenantId) fail("WORKSPACE_NOT_FOUND", "工作区不存在");
  const pricedModel = tx.listProjections<ModelConnection>("modelConnection").some(model => model.tenantId === tenantId && model.status === "ready" && findModelPrice(model.presetId, model.defaultModel));
  return listTeamTemplates().map(template => {
    const plugins = [...new Set(template.nodes.flatMap(node => node.pluginId ? [node.pluginId] : []))];
    const missing = plugins.filter(id => !workspace.activePluginIds.includes(id) || !options.definitions.some(item => item.id === id));
    const reason = template.pluginId === "coding" && options.sandboxAvailable !== true ? "代码团队需要已验证的沙箱" : missing.length ? `先启用所需能力：${missing.join("、")}` : !pricedModel ? "团队首版需要连接具备费用控制的内置模型" : undefined;
    return { id: template.id, version: "1", title: template.title, description: template.description, pluginId: template.pluginId,
      nodeCount: template.nodes.length, available: !reason, ...(reason ? { unavailableReason: reason } : {}) };
  });
}
