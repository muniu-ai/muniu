// SPDX-License-Identifier: Apache-2.0
import type { GoalBudgetV2, GoalPlanV2, GoalResourceRefV2, TeamNodeInputV1, TeamPlanNodeV1, TeamTemplateIdV1 } from "@mn/contracts";
import { runnerLabel } from "./AgentScheduling";
import "./team-views.css";

const templateTitles: Record<TeamTemplateIdV1, string> = { "research-summary": "研究汇总", "business-proposal": "经营方案", "code-delivery": "代码交付" };

export function formatTeamCost(minorUnits: string, currency: string): string {
  const digits = new Intl.NumberFormat("zh-CN", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const amount = BigInt(minorUnits), divisor = 10n ** BigInt(digits);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${absolute / divisor}${digits ? `.${String(absolute % divisor).padStart(digits, "0")}` : ""} ${currency}`;
}

function Budget({ value }: { value: GoalBudgetV2 }) {
  return <span>{formatTeamCost(value.maxCostMinorUnits, value.currency)} · {value.maxTokens} tokens · {Math.ceil(value.maxDurationMs / 60_000)} 分钟</span>;
}

export function GoalPlanView({ plan, onOpenSource }: {
  plan: GoalPlanV2;
  onOpenSource?: (source: GoalResourceRefV2) => void;
}) {
  const team = "kind" in plan && (plan.kind === "team-v1" || plan.kind === "single-v2") ? plan : null;
  function source(ref: GoalResourceRefV2) {
    const text = `${ref.resourceId} · 版本 ${ref.streamVersion}`;
    return onOpenSource ? <button type="button" className="quiet-button" onClick={() => onOpenSource(ref)}>{text}</button> : <span>{text}</span>;
  }
  function nodeTitle(id: string) { return team?.nodes.find(node => node.id === id)?.title ?? id; }
  function input(value: TeamNodeInputV1) {
    if (value.kind === "goal") return "目标与验收要求";
    if (value.kind === "source") return source(value.resourceRef);
    const upstream = team?.nodes.find(node => node.id === value.nodeId);
    return `${nodeTitle(value.nodeId)} → ${upstream?.outputs.find(output => output.key === value.outputKey)?.description ?? value.outputKey}`;
  }
  function step(node: TeamPlanNodeV1, index: number) {
    return <li key={node.id} data-node-kind={node.kind} className="team-plan-step">
      <h4>{index + 1}. {node.title}</h4>
      <dl>
        <div><dt>依赖</dt><dd>{node.dependsOn.length ? node.dependsOn.map(nodeTitle).join("、") : "无前置步骤"}</dd></div>
        {node.kind === "agent" && <>
          <div><dt>成员</dt><dd>{node.roleId === node.id ? node.title : node.roleId} · {runnerLabel(node.executor.runnerId)} · {node.executor.model}</dd></div>
          <div><dt>执行额度</dt><dd><Budget value={node.budget} /></dd></div>
          {node.review && <div><dt>独立审阅</dt><dd>核对 {node.review.producerNodeIds.map(nodeTitle).join("、")} 的要求、成果及证据，不默认接收生成者的自评分。</dd></div>}
        </>}
        {node.kind === "human_decision" && <div><dt>人工决定</dt><dd>{node.prompt}</dd></div>}
        {node.kind === "join" && <div><dt>结果汇合</dt><dd>{node.mappings.map(mapping => `${nodeTitle(mapping.fromNodeId)} → ${node.outputs.find(output => output.key === mapping.outputKey)?.description ?? mapping.outputKey}`).join("；")}</dd></div>}
        <div><dt>输入</dt><dd>{node.inputs.length ? <ul>{node.inputs.map(value => <li key={value.key}>{input(value)}</li>)}</ul> : "按前置步骤的完成条件继续"}</dd></div>
        <div><dt>输出</dt><dd><ul>{node.outputs.map(output => <li key={output.key}>{output.description}</li>)}</ul></dd></div>
      </dl>
    </li>;
  }
  return <section className="team-plan-view" aria-label="执行计划">
    <header><h3>{team?.kind === "team-v1" ? templateTitles[team.template.id] : "单 Agent"}</h3><p>计划修订 {plan.revision}{team?.kind === "team-v1" && ` · 模板版本 ${team.template.version}`}</p></header>
    <p>总执行额度：<Budget value={plan.budget} /></p>
    {team ? <>
      <p className="team-plan-limits">并行 {team.limits.maxParallelNodes} 个步骤 · 委派深度 {team.limits.maxDelegationDepth} 层 · 累计节点 {team.limits.maxNodes} 个 · 累计尝试 {team.limits.maxAttempts} 次 · 返工上限 {team.limits.maxReworkRounds} 轮</p>
      <ol className="team-plan-steps">{team.nodes.map(step)}</ol>
    </> : "runnerId" in plan && <p>{runnerLabel(plan.runnerId)} · {plan.model}，按目标与验收要求提交成果。</p>}
    <div className="team-plan-deliverables"><h4>交付要求</h4><ul>{plan.deliverables.map(deliverable => <li key={deliverable.key}>
      <strong>{deliverable.title}{deliverable.required ? "（必需）" : "（可选）"}</strong>
      <ul>{deliverable.criteria.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul>
    </li>)}</ul></div>
  </section>;
}
