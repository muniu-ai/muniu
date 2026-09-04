import { Activity, AlertCircle, ArrowRight, Check, Clock3, FileCheck2, Inbox, Lightbulb, MemoryStick, ShieldCheck, Users, X } from "lucide-react";
import type { AgentOsClient } from "../api";
import { EmptyState } from "../components/Status";
import type { ActivitySummary, DeliverableSummary, HomeSummary, MemorySummary, ViewMode, WorkspaceSummary } from "../types";

export function HomePage({ summary, onNavigate }: { readonly summary: HomeSummary; readonly onNavigate: (page: string) => void }) {
  return <div className="page-stack">
    <section className="hero-panel">
      <div><p className="eyebrow">今天</p><h2>{summary.todayActions[0]?.title ?? "工作区已经就绪"}</h2><p>{summary.todayActions[0]?.detail ?? "捕获一条机会或 Coding 任务，木牛会把它整理成可审阅对象。"}</p></div>
      <button className="primary-button" onClick={() => onNavigate(summary.todayActions[0]?.pluginId ?? "opc")}><Lightbulb size={16} />开始推进</button>
    </section>
    <div className="metric-grid">
      <Metric icon={<ArrowRight />} label="今日行动" value={summary.todayActions.length} tone="accent" />
      <Metric icon={<AlertCircle />} label="阻塞" value={summary.blockers.length} tone="warning" />
      <Metric icon={<ShieldCheck />} label="待审批" value={summary.approvals.length} tone="blue" />
      <Metric icon={<FileCheck2 />} label="最近成果" value={summary.recentDeliverables.length} tone="green" />
    </div>
    <div className="content-grid home-grid">
      <section className="panel"><PanelHeading title="接下来做什么" action="查看活动" onAction={() => onNavigate("activity")} />
        <div className="action-list">{summary.todayActions.map((item) => <button key={item.id} onClick={() => onNavigate(item.pluginId ?? "home")}><span className="status-dot accent" /><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowRight size={16} /></button>)}</div>
        {summary.todayActions.length === 0 && <EmptyState title="今天没有待办" detail="所有计划内行动都已处理" />}
      </section>
      <section className="panel"><PanelHeading title="需要你处理" action="打开收件箱" onAction={() => onNavigate("inbox")} />
        <div className="attention-list">
          {summary.blockers.map((item) => <article key={item.id}><span className="attention-icon warning"><AlertCircle size={16} /></span><div><strong>{item.title}</strong><p>{item.detail}</p></div></article>)}
          {summary.approvals.map((item) => <article key={item.id}><span className="attention-icon blue"><ShieldCheck size={16} /></span><div><strong>{item.title}</strong><p>{item.intent}</p></div></article>)}
          {summary.blockers.length + summary.approvals.length === 0 && <EmptyState title="没有阻塞" detail="Agent 可以继续执行已授权的工作" />}
        </div>
      </section>
    </div>
    <section className="panel"><PanelHeading title="最近成果" action="查看全部" onAction={() => onNavigate("deliverables")} /><DeliverableList items={summary.recentDeliverables} /></section>
  </div>;
}

function Metric({ icon, label, value, tone }: { readonly icon: React.ReactNode; readonly label: string; readonly value: number; readonly tone: string }) {
  return <article className={`metric-card ${tone}`}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

export function PanelHeading({ title, action, onAction }: { readonly title: string; readonly action?: string; readonly onAction?: () => void }) {
  return <header className="panel-heading"><h3>{title}</h3>{action && <button onClick={onAction}>{action}<ArrowRight size={14} /></button>}</header>;
}

export function InboxPage({ summary, api, onChanged }: { readonly summary: HomeSummary; readonly api: AgentOsClient; readonly onChanged: () => void }) {
  async function decide(id: string, version: number, decision: "approve_once" | "deny") {
    await api.decideApproval(id, version, decision);
    onChanged();
  }
  return <div className="page-stack"><PageTitle eyebrow="你的决定" title="收件箱" detail="审批、Agent 问题、凭据失效、失败和人工核对集中在这里。" />
    <div className="inbox-list">{summary.approvals.map((approval) => <article className="approval-card" key={approval.id}>
      <header><span className="pill risk">{approval.risk}</span><span className="expiry"><Clock3 size={14} />{new Date(approval.expiresAt).toLocaleString("zh-CN")}</span></header>
      <h3>{approval.title}</h3><p className="intent">{approval.intent}</p>
      <dl><div><dt>资源</dt><dd>{approval.resourceSummary}</dd></div><div><dt>风险</dt><dd>{approval.risk}</dd></div></dl>
      <footer><button className="danger-button" onClick={() => void decide(approval.id, approval.streamVersion, "deny")}><X size={15} />拒绝</button><button className="primary-button" onClick={() => void decide(approval.id, approval.streamVersion, "approve_once")}><Check size={15} />仅批准这一次</button></footer>
    </article>)}</div>
    {summary.approvals.length === 0 && <EmptyState title="收件箱已清空" detail="没有等待处理的审批或人工核对" />}
  </div>;
}

export function DeliverablesPage({ items }: { readonly items: readonly DeliverableSummary[] }) {
  return <div className="page-stack"><PageTitle eyebrow="可以交付的结果" title="成果" detail="跨插件查看档案、方案、代码证据和决策记录。" /><section className="panel"><DeliverableList items={items} /></section></div>;
}

export function DeliverableList({ items }: { readonly items: readonly DeliverableSummary[] }) {
  if (items.length === 0) return <EmptyState title="还没有成果" detail="完成一次机会验证或 Coding 任务后，成果会出现在这里" />;
  return <div className="deliverable-list">{items.map((item) => <article key={item.id}><span className={`plugin-badge ${item.pluginId}`}>{item.pluginId === "opc" ? "OPC" : "CODE"}</span><div><h4>{item.title}</h4><p>{item.outcome}</p><footer>{item.decision && <span><strong>决定</strong>{item.decision}</span>}{item.nextAction && <span><strong>下一步</strong>{item.nextAction}</span>}</footer></div><button className="icon-button" title="打开成果"><ArrowRight size={17} /></button></article>)}</div>;
}

export function ActivityPage({ items, professional }: { readonly items: readonly ActivitySummary[]; readonly professional: boolean }) {
  return <div className="page-stack"><PageTitle eyebrow="运行与审计" title="活动" detail="查看执行状态、费用与需要关注的故障。" />
    <section className="panel"><div className="timeline">{items.map((item) => <article key={item.id}><span className="timeline-marker"><Activity size={14} /></span><div><header><strong>{item.title}</strong><span className="pill">{item.status}</span></header><p>{new Date(item.occurredAt).toLocaleString("zh-CN")} · {item.cost}</p>{professional && <details><summary>技术详情</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>}</div></article>)}</div>{items.length === 0 && <EmptyState title="暂无活动" detail="开始一次任务后会显示运行与审计事件" />}</section>
  </div>;
}

export function WorkspacesPage({ workspaces, currentId, onSelect }: { readonly workspaces: readonly WorkspaceSummary[]; readonly currentId: string; readonly onSelect: (workspace: WorkspaceSummary) => void }) {
  return <div className="page-stack"><PageTitle eyebrow="业务上下文" title="工作区" detail="成员、记忆、插件和会话都以工作区为边界。" /><div className="workspace-grid">{workspaces.map((workspace) => <button key={workspace.id} className={workspace.id === currentId ? "selected" : ""} onClick={() => onSelect(workspace)}><span className="workspace-avatar">{workspace.name.slice(0, 1)}</span><strong>{workspace.name}</strong><small>{workspace.activePluginIds.map((id) => id === "opc" ? "OPC" : "Coding").join(" · ")}</small><span className="pill">{workspace.viewMode === "business" ? "经营视图" : "专业视图"}</span></button>)}</div></div>;
}

export function SettingsPage({ workspace, memories, api, onModeChanged, onMemoriesChanged }: { readonly workspace: WorkspaceSummary; readonly memories: readonly MemorySummary[]; readonly api: AgentOsClient; readonly onModeChanged: (workspace: WorkspaceSummary) => void; readonly onMemoriesChanged: () => void }) {
  async function setMode(mode: ViewMode) { onModeChanged(await api.updateViewMode(workspace, mode)); }
  async function decide(memory: MemorySummary, decision: "accept" | "reject") { await api.decideMemory(memory.id, memory.streamVersion, decision); onMemoriesChanged(); }
  return <div className="page-stack"><PageTitle eyebrow="工作方式" title="设置" detail="视图只改变信息密度，不改变 API、事件或审批。" />
    <section className="panel settings-section"><PanelHeading title="信息密度" /><div className="segmented" role="group" aria-label="信息密度"><button className={workspace.viewMode === "business" ? "active" : ""} onClick={() => void setMode("business")}>经营视图</button><button className={workspace.viewMode === "professional" ? "active" : ""} onClick={() => void setMode("professional")}>专业视图</button></div><p>经营视图先显示成果、证据和下一步；专业视图原位展开执行细节。</p></section>
    <section className="panel settings-section"><PanelHeading title="记忆与偏好" /><div className="memory-list">{memories.map((memory) => <article key={memory.id}><span className="attention-icon"><MemoryStick size={16} /></span><div><header><strong>{memory.summary}</strong><span className={`pill ${memory.status}`}>{memory.status === "proposed" ? "待确认" : memory.status === "accepted" ? "已确认" : "不可用"}</span></header><p>来源：{memory.source} · 置信度 {Math.round(memory.confidence * 100)}%</p><small>{memory.namespace} / {memory.resourceId}</small></div>{memory.status === "proposed" && <footer><button className="quiet-button" onClick={() => void decide(memory, "reject")}>拒绝</button><button className="secondary-button" onClick={() => void decide(memory, "accept")}>接受</button></footer>}</article>)}</div>{memories.length === 0 && <EmptyState title="还没有记忆提案" detail="模型提炼的信息必须经你确认后才会成为记忆" />}</section>
    <section className="panel settings-section"><PanelHeading title="数据治理" /><div className="governance-note"><ShieldCheck size={20} /><p>跨插件默认不可见。共享前会提示：授权撤销后停止后续读取，但已经发送给模型或外部服务的数据无法召回。</p></div></section>
  </div>;
}

export function AgentsPage() { return <StaticPage eyebrow="默认折叠" title="Agents" detail="查看 Agent 的职责、Skill、工具和预算。Builtin Agent 是 Coding 的默认 Runner。" icon={<Users />} />; }
export function IntegrationsPage() { return <StaticPage eyebrow="受控连接" title="集成" detail="模型密钥保存在 Keychain。外部 Runner 与第三方插件必须单独确认。" icon={<ShieldCheck />} />; }

function StaticPage({ eyebrow, title, detail, icon }: { readonly eyebrow: string; readonly title: string; readonly detail: string; readonly icon: React.ReactNode }) {
  return <div className="page-stack"><PageTitle eyebrow={eyebrow} title={title} detail={detail} /><section className="panel static-callout"><span>{icon}</span><h3>保持最小权限</h3><p>只有工作区明确启用的能力才能参与执行。高影响操作始终进入审批。</p></section></div>;
}

export function PageTitle({ eyebrow, title, detail }: { readonly eyebrow: string; readonly title: string; readonly detail: string }) {
  return <header className="page-title"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></header>;
}
