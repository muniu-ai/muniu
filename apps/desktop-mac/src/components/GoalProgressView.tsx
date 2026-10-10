// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2 } from "@mn/contracts";
import { formatTeamCost } from "./GoalPlanView";
import "./team-views.css";

export type GoalProgressAction = "start" | "pause" | "resume" | "cancel" | "decide";
export interface GoalNodeProgress {
  readonly nodeId: string;
  readonly title: string;
  readonly status: string;
  readonly attempts: number;
  readonly blockedReason?: string;
  readonly executionId?: string;
  readonly outputRefs: readonly GoalResourceRefV2[];
}
const actionTitles: Record<GoalProgressAction, string> = { start: "开始", pause: "暂停", resume: "恢复", cancel: "取消", decide: "查看待决定事项" };
const statusTitles: Record<string, string> = {
  pending: "等待前置步骤", blocked: "已阻塞", ready: "可以执行", queued: "等待执行", running: "正在执行",
  waiting_approval: "等待审批", waiting_decision: "等待人工决定", awaiting_decision: "等待人工决定", completed: "已完成", succeeded: "已完成",
  failed: "执行失败", paused: "已暂停", cancelled: "已取消", superseded: "已由新计划替代", needs_reconciliation: "待核对",
};

export function GoalProgressView({ nodes, allowedActions, onAction, onOpenOutput, costs, busy = false }: {
  nodes: readonly GoalNodeProgress[];
  allowedActions: readonly GoalProgressAction[];
  onAction: (action: GoalProgressAction) => void;
  onOpenOutput?: (source: GoalResourceRefV2) => void;
  costs?: readonly { readonly currency: string; readonly costMinorUnits: string | null }[];
  busy?: boolean;
}) {
  return <section className="team-progress-view" aria-label="团队进展" aria-busy={busy}>
    <h3>执行进展</h3>
    <p>暂停会停止派发新步骤，当前步骤完成后暂停。</p>
    {costs && <ul aria-label="执行费用">{costs.map(cost => <li key={cost.currency}>{cost.costMinorUnits === null ? `${cost.currency} 费用待核对` : formatTeamCost(cost.costMinorUnits, cost.currency)}</li>)}</ul>}
    {nodes.length ? <ol className="team-progress-nodes">{nodes.map(node => <li key={node.nodeId}>
      <header><strong>{node.title}</strong><span>{statusTitles[node.status] ?? `状态待确认（${node.status}）`}</span></header>
      <p>已尝试 {node.attempts} 次</p>
      {node.blockedReason && <p>{node.blockedReason}</p>}
      {node.status === "needs_reconciliation" && <p>请先核对已提交操作的结果，再按允许的方式继续。</p>}
      {node.outputRefs.length > 0 && <ul aria-label={`${node.title}的输出`}>{node.outputRefs.map((ref, index) => <li key={`${ref.namespace}:${ref.resourceId}:${ref.streamVersion}`}>
        {onOpenOutput ? <button type="button" className="quiet-button" onClick={() => onOpenOutput(ref)}>{`成果与证据 ${index + 1}`} · 版本 {ref.streamVersion}</button> : <span>已保存成果与证据 {index + 1} · 版本 {ref.streamVersion}</span>}
      </li>)}</ul>}
    </li>)}</ol> : <p>尚无执行步骤。计划确认后显示进展。</p>}
    {allowedActions.length > 0 && <div className="team-progress-actions">{[...new Set(allowedActions)].map(action => <button key={action} type="button" className="secondary-button" disabled={busy} onClick={() => onAction(action)}>{actionTitles[action]}</button>)}</div>}
  </section>;
}
