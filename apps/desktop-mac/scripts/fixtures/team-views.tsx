// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GoalDetailViews, type GoalDetailView } from "../../src/components/GoalDetailViews";
import { TeamSelector } from "../../src/components/TeamSelector";
import { GoalsPage } from "../../src/pages/GoalsPage";
import { TaskComposer } from "../../src/components/TaskComposer";
import { AgentOsApiError, type AgentOsClient } from "../../src/api";
import type { TeamTemplateIdV1, TeamTemplateSummaryV1 } from "@mn/contracts";
import "../../src/styles.css";

function TabsFixture() {
  const [view, setView] = useState<GoalDetailView>("goal");
  return <main style={{ maxWidth: 900, margin: "20px auto", padding: 16 }}>
    <GoalDetailViews value={view} onChange={setView} panels={{
      goal: <label>保留的任务草稿<input aria-label="保留的任务草稿" defaultValue="任务说明" /></label>,
      plan: <p>待确认的固定计划</p>, progress: <p>当前执行步骤</p>, results: <p>待验收的成果</p>,
    }} />
  </main>;
}
const templates: readonly TeamTemplateSummaryV1[] = [
  { id: "research-summary", version: "1", title: "研究汇总", description: "分方向取证、汇总与复核", pluginId: "opc", nodeCount: 4, available: true },
  { id: "business-proposal", version: "1", title: "经营方案", description: "需求整理、方案与独立审阅", pluginId: "opc", nodeCount: 3, available: true },
  { id: "code-delivery", version: "1", title: "代码交付", description: "规格、实现、检查与集成", pluginId: "coding", nodeCount: 5, available: false, unavailableReason: "请先登记代码仓库" },
];
function SelectorFixture() {
  const [value, setValue] = useState<TeamTemplateIdV1 | null>(null);
  const [changes, setChanges] = useState(0), [locked, setLocked] = useState(false), [revoked, setRevoked] = useState(false);
  return <main><TeamSelector value={value} onChange={next => { setValue(next); setChanges(count => count + 1); }}
    templates={templates.map(template => revoked && template.id === value ? { ...template, available: false, unavailableReason: "当前模型连接不可用" } : template)} disabled={locked} />
    <output aria-label="选择次数">{changes}</output><output aria-label="当前策略">{value ?? "single"}</output>
    <button onClick={() => setLocked(true)}>锁定请求</button><button onClick={() => setRevoked(true)}>撤销可用性</button>
  </main>;
}
const calls: { method: string; key?: string; input?: unknown }[] = [];
const budget = { maxTokens: 100000, maxCostMinorUnits: "2000", currency: "CNY", maxDurationMs: 1800000 };
const createdGoal = { goal: { id: "goal", workspaceId: "workspace", threadId: "thread", objective: "任务", streamVersion: 1, budget, deliverables: [], resourceRefs: [], status: "draft" }, plan: null, deliverySet: null };
const composerApi = {
  async modelConnections() { return [{ id: "model-1", displayName: "已计价模型", defaultModel: "test-model", status: "ready", billingCurrency: "CNY" }]; },
  async teamTemplates() { return templates; },
  async createBusinessThread(_workspace: string, _subject: string, key: string) { calls.push({ method: "thread", key }); return { id: "thread" }; },
  async createGoal(_workspace: string, input: unknown, key: string) { calls.push({ method: "goal", input, key }); return createdGoal; },
  async planGoal(_goal: unknown, selection: unknown, key: string) { calls.push({ method: "single", input: selection, key }); return createdGoal; },
  async planTeamGoal(_goal: unknown, selection: unknown, key: string) {
    calls.push({ method: "team", input: selection, key });
    if (calls.filter(call => call.method === "team").length === 1) throw new TypeError("模拟计划响应丢失");
    return { ...createdGoal, plan: { kind: "team-v1", template: selection } };
  },
} as unknown as AgentOsClient;
Object.assign(window, { composerCalls: calls });
function ComposerFixture() {
  const [created, setCreated] = useState(false);
  return <main style={{ maxWidth: 900, margin: "20px auto", padding: 16 }}>{created ? <p>已打开待审阅计划</p> : <TaskComposer api={composerApi}
    workspaceId="workspace" pluginIds={["opc", "coding"]} repositories={[]} onRepository={() => undefined} onRegisterRepository={() => undefined}
    onCreated={() => setCreated(true)} onSettings={() => undefined} visible />}</main>;
}
const teamGoal = { ...createdGoal, runId: "run-1", goal: { ...createdGoal.goal, status: "running", streamVersion: 3, reservation: { status: "unknown" } }, plan: {
  kind: "team-v1", id: "plan-1", revision: 1, digest: "plan-digest", template: { id: "business-proposal", version: "1", digest: "template" },
  budget, resourceRefs: [], deliverables: [], limits: { maxParallelNodes: 3, maxDelegationDepth: 1, maxNodes: 12, maxAttempts: 24, maxReworkRounds: 2 },
  nodes: [{ kind: "human_decision", id: "confirm", title: "确认业务事实", prompt: "请核对客户事实", choices: ["continue", "stop"], dependsOn: [], inputs: [], outputs: [] }],
} };
let paused = false;
let releaseOldNodes: (() => void) | undefined;
const callbacks = new Set<() => void>();
let revoked = false;
const progressFor = (goalId: string) => ({ goalId, planRevisionId: goalId === "goal" ? "plan-1" : "plan-2", runId: "run-1", nodes: [{ nodeId: "confirm", title: "确认业务事实", status: "awaiting_decision", attempts: 0, outputRefs: [] }],
  allowedActions: paused || goalId !== "goal" ? ["resume"] : ["pause", "decide"], attempts: [], decisions: [] });
const goalCalls: unknown[] = [];
const pageApi = { ...composerApi,
  async goals() { return [teamGoal.goal]; }, async threads() { return []; },
  async goal(_workspace: string, goalId: string) {
    if (revoked) throw new AgentOsApiError({ code: "RESOURCE_REVOKED", message: "资料已撤权", action: "请核对权限" }, 403);
    return goalId === "goal" ? teamGoal : { ...teamGoal, goal: { ...teamGoal.goal, id: goalId, objective: "第二团队任务" }, plan: { ...teamGoal.plan, id: "plan-2" } };
  },
  watchWorkspaceEvents(_workspace: string, callback: () => void) { callbacks.add(callback); return () => callbacks.delete(callback); },
  async goalNodes(_workspace: string, goalId: string) {
    if (new URLSearchParams(location.search).has("race") && goalId === "goal" && !releaseOldNodes) {
      const response = progressFor(goalId); await new Promise<void>(resolve => { releaseOldNodes = resolve; }); return response;
    }
    if (revoked) throw new AgentOsApiError({ code: "RESOURCE_REVOKED", message: "资料已撤权", action: "请核对权限" }, 403);
    return progressFor(goalId);
  },
  async commandGoal(detail: typeof teamGoal, action: string, key: string) {
    goalCalls.push({ action, key, version: detail.goal.streamVersion, goalId: detail.goal.id });
    if (goalCalls.length === 1) throw new TypeError("响应丢失");
    if (goalCalls.length === 2 && new URLSearchParams(location.search).has("retryDenied")) throw new AgentOsApiError({ code: "AUTHORIZATION_DENIED", message: "当前授权已撤销", action: "请核对权限" }, 403);
    paused = action === "pause"; return { ...detail, goal: { ...detail.goal, streamVersion: detail.goal.streamVersion + 1 } };
  },
  async decideGoal(detail: typeof teamGoal, nodeId: string, decision: string, key: string) {
    goalCalls.push({ action: "decide", key, version: detail.goal.streamVersion, nodeId, decision }); return teamGoal;
  },
} as unknown as AgentOsClient;
Object.assign(window, { goalCalls, releaseOldProgress: () => releaseOldNodes?.(), revoke: () => { revoked = true; for (const callback of callbacks) callback(); } });
function GoalsFixture() { const [target, setTarget] = useState({ id: "goal", sequence: 1 }); return <><button onClick={() => setTarget({ id: "goal-2", sequence: 2 })}>切换团队目标</button><button onClick={() => setTarget({ id: "goal", sequence: 3 })}>返回原团队目标</button><GoalsPage api={pageApi} workspaceId="workspace" active target={target}
  pluginIds={["opc", "coding"]} repositories={[]} onOpenThread={() => undefined} onRepository={() => undefined}
  onRegisterRepository={() => undefined} onSettings={() => undefined} newTaskRequest={0} onTaskCreated={() => undefined} /></>; }
const fixture = new URLSearchParams(location.search).get("fixture");
createRoot(document.getElementById("root")!).render(fixture === "goals" ? <GoalsFixture /> : fixture === "composer" ? <ComposerFixture /> : fixture === "selector" ? <SelectorFixture /> : <TabsFixture />);
