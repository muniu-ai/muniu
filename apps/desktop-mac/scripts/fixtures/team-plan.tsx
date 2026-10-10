// SPDX-License-Identifier: Apache-2.0
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalPlanProposalV2, GoalTeamPlanRevisionV2 } from "@mn/contracts";
import { HomePage } from "../../src/pages/CorePages";
import type { GoalV2 } from "@mn/contracts";
import { GoalPlanView } from "../../src/components/GoalPlanView";
import { GoalProgressView, type GoalProgressAction } from "../../src/components/GoalProgressView";

const executor: GoalPlanProposalV2 = {
  domainInputDigest: "input-digest", threadStreamVersion: 1, pluginId: "opc", pluginVersion: "0.2.0",
  agentDefinitionId: "opc.business-assistant", modelBindingId: "model-1", modelConnectionStreamVersion: 1,
  model: "test-model", runnerId: "builtin", toolIds: [], dataScopes: [], autoAllowedEffects: [],
};
const budget = { maxTokens: 3000, maxCostMinorUnits: "1250", currency: "CNY", maxDurationMs: 600000 };
const source = { namespace: "asset", resourceId: "material-1", streamVersion: 3, digest: "source-digest" };
const plan: GoalTeamPlanRevisionV2 = {
  kind: "team-v1", template: { id: "research-summary", version: "1", digest: "template-digest" },
  id: "plan-1", goalId: "goal-1", threadId: "thread-1", revision: 2, inputVersion: 1, criteriaVersion: "criteria-1",
  pluginId: "opc", domainInputDigest: "input-digest", threadStreamVersion: 1, budget, resourceRefs: [source],
  deliverables: [{ key: "report", title: "调研报告", required: true, criteria: [{ id: "sources", description: "结论有来源" }] }],
  limits: { maxParallelNodes: 3, maxDelegationDepth: 1, maxNodes: 12, maxAttempts: 24, maxReworkRounds: 2 },
  deliverableBindings: [{ deliverableKey: "report", nodeId: "join", outputKey: "report" }], digest: "plan-digest", createdAt: "2026-10-10T00:00:00Z",
  nodes: [
    { kind: "agent", id: "research", title: "资料研究", roleId: "研究员", dependsOn: [], inputs: [{ key: "requirements", kind: "goal" }, { key: "evidence", kind: "source", resourceRef: source }],
      outputs: [{ key: "findings", kind: "analysis", description: "有依据的研究发现" }], executor, capabilityRef: { id: "researcher", version: "1", digest: "cap-digest" }, budget },
    { kind: "agent", id: "review", title: "独立复核", roleId: "复核员", dependsOn: ["research"], inputs: [{ key: "review-input", kind: "node_output", nodeId: "research", outputKey: "findings" }],
      outputs: [{ key: "checked", kind: "review", description: "来源与反证检查" }], executor: { ...executor, runnerId: "codex-cli" }, capabilityRef: { id: "reviewer", version: "1", digest: "review-digest" },
      budget: { ...budget, currency: "USD", maxCostMinorUnits: "900719925474099301" }, review: { independent: true, producerNodeIds: ["research"] } },
    { kind: "human_decision", id: "confirm", title: "确认业务事实", dependsOn: ["review"], inputs: [], outputs: [{ key: "decision", kind: "decision", description: "人工决定" }], prompt: "核对客户提供的事实", choices: ["continue", "stop"] },
    { kind: "join", id: "join", title: "整理成果", dependsOn: ["confirm"], inputs: [], outputs: [{ key: "report", kind: "artifact", description: "最终调研报告" }], mappings: [{ outputKey: "report", fromNodeId: "review", fromOutputKey: "checked" }] },
  ],
};
export function teamPlanMarkup() { return renderToStaticMarkup(<GoalPlanView plan={plan} />); }
export function singlePlanMarkup() {
  return renderToStaticMarkup(<GoalPlanView plan={{ ...executor, id: plan.id, goalId: plan.goalId, threadId: plan.threadId, revision: 1, inputVersion: 1,
    criteriaVersion: plan.criteriaVersion, budget, resourceRefs: [source], deliverables: plan.deliverables, digest: "single", createdAt: plan.createdAt }} />);
}
export function progressMarkup(actions: readonly GoalProgressAction[], busy = false) {
  return renderToStaticMarkup(<GoalProgressView nodes={[
    { nodeId: "research", title: "资料研究", status: "needs_reconciliation", attempts: 2, blockedReason: "外部结果未知，等待核对 <script>", outputRefs: [source] },
    { nodeId: "review", title: "独立复核", status: "queued", attempts: 0, outputRefs: [] },
  ]} allowedActions={actions} onAction={() => undefined} busy={busy} />);
}

export function pausedHomeMarkup() {
  return renderToStaticMarkup(<HomePage summary={{ todayActions: [], blockers: [], approvals: [], recentDeliverables: [] }}
    goals={[{ id: "paused", status: "paused", objective: "等待恢复的经营团队", budget }, { id: "pausing", status: "pausing", objective: "正在停止派发的团队", budget }] as unknown as GoalV2[]}
    onGoal={() => undefined} onObject={() => undefined} onNavigate={() => undefined} />);
}
