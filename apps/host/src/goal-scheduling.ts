// SPDX-License-Identifier: Apache-2.0
import { CODING_RUNNER_CONFIGURATION_NAMESPACE, type AgentSchedulingDecisionV2, type AgentSchedulingRequestV2, type CodingRunnerConfigurationV1, type GoalPlanRevisionV2, type GoalV2, type Thread, type Workspace } from "@mn/contracts";
import { findModelPrice, sha256, type KernelTransaction, type ModelConnection } from "@mn/kernel";
import { chooseAgent, type SchedulingCandidate } from "./agent-scheduler.js";
import { runnerPluginId } from "./coding-runners.js";

export function taskClass(goal: GoalV2, pluginId: string): string {
  const size = Buffer.byteLength(goal.objective) + goal.resourceRefs.length * 4000 + goal.deliverables.flatMap(item => item.criteria).length * 500;
  return `${pluginId}:${size < 4000 ? "small" : size < 16000 ? "medium" : "large"}`;
}
export function scheduleGoal(tx: KernelTransaction, goal: GoalV2, request: AgentSchedulingRequestV2, now: string, unavailableRunners: readonly string[] = []): AgentSchedulingDecisionV2 {
  const thread = tx.getProjection<Thread>("thread", goal.threadId)!;
  const workspace = tx.getProjection<Workspace>("workspace", goal.workspaceId)!;
  const category = taskClass(goal, thread.pluginId);
  const samples = tx.listProjections<GoalV2>("goal.state").filter(item => item.tenantId === goal.tenantId && item.workspaceId === goal.workspaceId
    && item.id !== goal.id && ["accepted", "failed"].includes(item.status) && item.reservation?.status === "settled"
    && Date.parse(item.updatedAt) >= Date.parse(now) - 90 * 86400000 && Date.parse(item.updatedAt) <= Date.parse(now));
  const evidenceIds: string[] = [];
  const estimate = (base: Omit<SchedulingCandidate, "samples" | "accepted">): SchedulingCandidate => {
    const history = samples.filter(item => {
      const plan = item.planRevisionId ? tx.getProjection<GoalPlanRevisionV2>("goal.plan", item.planRevisionId) : undefined;
      const selected = plan?.scheduling?.candidates.find(candidate => candidate.id === plan.scheduling!.selectedId);
      return plan && plan.scheduling?.taskClass === category && selected?.fingerprint === base.fingerprint && item.budget.currency === goal.budget.currency;
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 100);
    evidenceIds.push(...history.map(item => `${item.id}:${item.streamVersion}`));
    const costs = history.map(item => BigInt(item.reservation!.actual!.costMinorUnits)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const durations = history.map(item => {
      const execution = item.executionRef && tx.getProjection<{ createdAt: string; updatedAt: string }>("execution", item.executionRef.executionId);
      return execution ? Math.max(1, Date.parse(execution.updatedAt) - Date.parse(execution.createdAt)) : base.expectedDurationMs;
    }).filter(Number.isSafeInteger).sort((a, b) => a - b);
    return { ...base, samples: history.length, accepted: history.filter(item => item.status === "accepted").length,
      ...(costs.length >= 5 ? { expectedCostMinorUnits: costs[Math.ceil(costs.length * 0.8) - 1]!.toString() } : {}),
      ...(durations.length >= 5 ? { expectedDurationMs: durations[Math.ceil(durations.length * 0.8) - 1]! } : {}) };
  };
  const candidates: SchedulingCandidate[] = tx.listProjections<ModelConnection>("modelConnection").filter(model => model.tenantId === goal.tenantId).map(model => {
    const price = findModelPrice(model.presetId, model.defaultModel);
    const input = BigInt(Math.min(goal.budget.maxTokens, Buffer.byteLength(goal.objective) + goal.resourceRefs.length * 4000 + 2000));
    const output = BigInt(Math.min(goal.budget.maxTokens, thread.pluginId === "coding" ? 8000 : 3000));
    const estimateCost = price ? ((input * BigInt(price.rates.inputNanoMinorUnitsPerToken) + output * BigInt(price.rates.outputNanoMinorUnitsPerToken) + 999999999n) / 1000000000n).toString() : undefined;
    return estimate({ id: `builtin:${model.id}`, runnerId: "builtin", modelBindingId: model.id, label: `${model.displayName} · ${model.defaultModel}`,
      fingerprint: sha256({ plugin: thread.pluginId, model: model.id, version: model.streamVersion, price: price?.rates ?? null }), currency: price?.rates.currency ?? goal.budget.currency,
      ...(estimateCost !== undefined ? { expectedCostMinorUnits: estimateCost } : {}), expectedDurationMs: thread.pluginId === "coding" ? 120000 : 30000,
      reasons: [...(model.status !== "ready" ? ["模型连接未就绪"] : []), ...(!price ? ["模型价格不可用"] : [])] });
  });
  for (const runnerId of ["codex-cli", "claude-cli"] as const) {
    const config = tx.getProjection<CodingRunnerConfigurationV1>(CODING_RUNNER_CONFIGURATION_NAMESPACE, `${goal.workspaceId}:${runnerId}`);
    const confirmed = config?.tenantId === goal.tenantId && config.status === "confirmed" && config.identityDigest === sha256(config.identity);
    candidates.push(estimate({ id: runnerId, runnerId, modelBindingId: `runner:${runnerId}`, label: runnerId === "codex-cli" ? "Codex CLI" : "Claude Code CLI",
      fingerprint: sha256({ plugin: thread.pluginId, runnerId, identity: confirmed ? config.identityDigest : null, configurationVersion: confirmed ? config.streamVersion : null }), currency: goal.budget.currency,
      expectedDurationMs: thread.pluginId === "coding" ? 120000 : 30000,
      reasons: [...(unavailableRunners.includes(runnerId) ? ["CLI 安装、插件或运行环境检查未通过"] : []), ...(!workspace.activePluginIds.includes(runnerPluginId(runnerId)) ? ["Runner 插件未启用"] : []), ...(!confirmed ? ["CLI 身份未确认"] : [])] }));
  }
  const decision = chooseAgent(candidates, request, goal.budget);
  return { algorithm: "quality-roi-v1", request, ...decision, taskClass: category, evidenceDigest: sha256([...new Set(evidenceIds)].sort()) };
}
