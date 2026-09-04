import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, CircleDashed, Code2, FileDiff, FlaskConical, SearchCheck, Target, UserCheck } from "lucide-react";
import type { AgentOsClient } from "../api";
import { EmptyState, ErrorState, Loading } from "../components/Status";
import type { CodingTaskSummary, OpportunitySummary, ViewMode } from "../types";
import { PageTitle, PanelHeading } from "./CorePages";
import { OpcDetailPage } from "./OpcDetailPage";

const stages = ["captured", "framed", "researching", "interviewing", "evaluating", "offer_ready", "decided"];
const stageLabels: Record<string, string> = {
  captured: "已捕获", framed: "已界定", researching: "研究中", interviewing: "访谈中",
  evaluating: "评估中", offer_ready: "方案就绪", decided: "已决策", paused: "已暂停", abandoned: "已放弃",
};

export function OpcPage({ api, workspaceId, items, selectedId, onSelect, loading, error, viewMode, onRetry, onChanged }: {
  readonly api: AgentOsClient;
  readonly workspaceId: string;
  readonly items: readonly OpportunitySummary[];
  readonly selectedId?: string;
  readonly onSelect: (id: string | undefined) => void;
  readonly loading: boolean;
  readonly error?: string;
  readonly viewMode: ViewMode;
  readonly onRetry: () => void;
  readonly onChanged: () => Promise<void>;
}) {
  if (selectedId) return <OpcDetailPage api={api} workspaceId={workspaceId} opportunityId={selectedId} viewMode={viewMode} onBack={() => onSelect(undefined)} onChanged={onChanged} />;
  return <div className="page-stack"><PageTitle eyebrow="机会验证" title="OPC" detail="把想法推进到证据、反证、最小收费方案和人工决策。" />
    {loading && <Loading label="正在读取机会" />}{error && <ErrorState title="OPC 已降级" detail={error} action="核心页面和 Coding 不受影响" onRetry={onRetry} />}
    {!loading && !error && items.length === 0 && <EmptyState title="还没有机会" detail="在顶部快速捕获中写下一句话，木牛会生成可审阅机会" />}
    {!loading && !error && items.map((opportunity) => <article className="opportunity-card" key={opportunity.id}>
      <header><div><span className={`evidence-level ${opportunity.evidenceLevel}`}>{evidenceLabel(opportunity.evidenceLevel)}</span><h2>{opportunity.title}</h2><p>{opportunity.targetCustomer} · {opportunity.problem}</p></div><button className="quiet-button" onClick={() => onSelect(opportunity.id)}>查看档案<ArrowRight size={15} /></button></header>
      <div className="stage-track">{stages.map((stage, index) => { const current = Math.max(stages.indexOf(opportunity.status), 0); return <div key={stage} className={index < current ? "done" : index === current ? "current" : ""}><span>{index < current ? <CheckCircle2 size={14} /> : index + 1}</span><small>{stageLabels[stage]}</small></div>; })}</div>
      <section className="hypothesis"><Target size={18} /><div><strong>可证伪假设</strong><p>{opportunity.falsifiableHypothesis || "尚未界定"}</p></div></section>
      <div className="evidence-board">
        <EvidenceColumn title="支持证据" tone="support" items={opportunity.evidence.filter((item) => item.stance === "supporting")} />
        <EvidenceColumn title="反证" tone="oppose" items={opportunity.evidence.filter((item) => item.stance === "opposing")} />
        <section className="evidence-column gap"><header><CircleDashed size={16} /><strong>证据缺口</strong><span>{opportunity.gaps.length}</span></header>{opportunity.gaps.map((gap) => <p key={gap}>{gap}</p>)}</section>
      </div>
      <footer className="next-action"><span><ArrowRight size={16} />下一步</span><strong>{opportunity.nextAction}</strong></footer>
      {viewMode === "professional" && <details className="technical-details"><summary>事件与执行详情<ChevronDown size={15} /></summary><dl><div><dt>机会 ID</dt><dd>{opportunity.id}</dd></div><div><dt>事件版本</dt><dd>{opportunity.streamVersion}</dd></div><div><dt>内部状态</dt><dd>{opportunity.status}</dd></div></dl></details>}
    </article>)}
  </div>;
}

function evidenceLabel(level: OpportunitySummary["evidenceLevel"]) {
  return ({ none: "方案待验证", interest: "已有兴趣信号", commitment: "已有承诺证据", paid: "已有付费证据" })[level];
}

function EvidenceColumn({ title, tone, items }: { readonly title: string; readonly tone: string; readonly items: OpportunitySummary["evidence"] }) {
  return <section className={`evidence-column ${tone}`}><header>{tone === "support" ? <SearchCheck size={16} /> : <AlertTriangle size={16} />}<strong>{title}</strong><span>{items.length}</span></header>{items.map((item) => <article key={item.id}><p>{item.summary}</p><small>{item.source} · {new Date(item.capturedAt).toLocaleDateString("zh-CN")}{item.humanConfirmed ? " · 人工确认" : ""}</small></article>)}</section>;
}

export function CodingPage({ items, selectedId, onSelect, loading, error, viewMode, onRetry }: { readonly items: readonly CodingTaskSummary[]; readonly selectedId?: string; readonly onSelect: (id: string | undefined) => void; readonly loading: boolean; readonly error?: string; readonly viewMode: ViewMode; readonly onRetry: () => void }) {
  const selected = items.find((task) => task.id === selectedId);
  if (selected) return <CodingDetailPage task={selected} viewMode={viewMode} onBack={() => onSelect(undefined)} />;
  return <div className="page-stack"><PageTitle eyebrow="受治理研发" title="Coding" detail="从任务、差异和检查结果做决定，技术执行细节按需展开。" />
    {loading && <Loading label="正在读取 Coding 任务" />}{error && <ErrorState title="Coding 已降级" detail={error} action="核心页面和 OPC 不受影响" onRetry={onRetry} />}
    {!loading && !error && items.length === 0 && <EmptyState title="还没有 Coding 任务" detail="在顶部快速捕获中描述要修改的仓库与目标" />}
    {!loading && !error && items.map((task) => <article className="coding-card" key={task.id}>
      <header><span className="coding-icon"><Code2 size={19} /></span><div><span className="pill">{task.status}</span><h2>{task.title}</h2><p>{task.repository}</p></div><button className="quiet-button" onClick={() => onSelect(task.id)}>打开任务<ArrowRight size={15} /></button></header>
      <CodingResults task={task} />
      <footer className="next-action"><span><ArrowRight size={16} />下一步</span><strong>{task.nextAction}</strong></footer>
      {viewMode === "professional" && task.advanced && <details className="technical-details"><summary>高级执行设置<ChevronDown size={15} /></summary><dl><div><dt>Harness 摘要</dt><dd>{task.advanced.harnessDigest}</dd></div><div><dt>候选数</dt><dd>{task.advanced.candidateCount}</dd></div><div><dt>剩余预算</dt><dd>{task.advanced.remainingBudget}</dd></div></dl></details>}
    </article>)}
  </div>;
}

function CodingDetailPage({ task, viewMode, onBack }: { readonly task: CodingTaskSummary; readonly viewMode: ViewMode; readonly onBack: () => void }) {
  return <div className="page-stack coding-detail">
    <button type="button" className="quiet-button opc-back" onClick={onBack}><ArrowLeft size={15} />返回任务列表</button>
    <header className="opc-detail-hero coding-detail-hero">
      <div><p className="eyebrow">Coding 任务</p><h1>{task.title}</h1><p>{task.repository}</p></div>
      <span className="pill">{task.status}</span>
    </header>
    <section className="coding-detail-next" aria-label="任务下一步">
      <span><ArrowRight size={17} />下一步</span><strong>{task.nextAction}</strong>
    </section>
    <CodingResults task={task} />
    {viewMode === "professional" && task.advanced && <dl className="opc-professional-meta" aria-label="Coding 技术信息"><div><dt>任务 ID</dt><dd>{task.id}</dd></div><div><dt>Harness 摘要</dt><dd>{task.advanced.harnessDigest}</dd></div><div><dt>候选与预算</dt><dd>{task.advanced.candidateCount} 个 · {task.advanced.remainingBudget}</dd></div></dl>}
  </div>;
}

function CodingResults({ task }: { readonly task: CodingTaskSummary }) {
  return <div className="coding-result-grid" aria-label="任务结果">
    <section><PanelHeading title="差异" /><div className="diff-summary"><FileDiff size={20} /><p>{task.diffSummary ?? "尚未生成差异"}</p></div></section>
    <section><PanelHeading title="检查" /><div className="check-list">{task.checks.map((check) => <p key={check.name} className={check.status}><span>{check.status === "pass" ? <CheckCircle2 size={15} /> : check.status === "fail" ? <AlertTriangle size={15} /> : <CircleDashed size={15} />}</span><strong>{check.name}</strong><small>{check.status}</small></p>)}</div></section>
    <section><PanelHeading title="审批" /><div className="approval-summary"><UserCheck size={20} /><p>{task.approval ?? "等待检查完成"}</p></div></section>
  </div>;
}

export function PluginOverview({ opcCount, codingCount }: { readonly opcCount: number; readonly codingCount: number }) {
  return <div className="plugin-overview"><article><FlaskConical size={18} /><strong>{opcCount}</strong><small>推进中的机会</small></article><article><Code2 size={18} /><strong>{codingCount}</strong><small>Coding 任务</small></article></div>;
}
