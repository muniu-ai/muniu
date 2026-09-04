import { useCallback, useEffect, useState } from "react";
import { Activity, AlertCircle, ArrowRight, Bot, Check, Clock3, FileCheck2, KeyRound, Lightbulb, MemoryStick, ShieldCheck, Sparkles, X } from "lucide-react";
import type { AgentOsClient } from "../api";
import { EmptyState } from "../components/Status";
import type { ActivitySummary, AgentCatalog, CodingReconciliationDecision, CodingReconciliationView, DeliverableSummary, HomeSummary, InboxItemSummary, MemorySummary, ViewMode, WorkspaceMemberSummary, WorkspaceSummary } from "../types";

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
    <section className="panel"><PanelHeading title="最近成果" action="查看全部" onAction={() => onNavigate("deliverables")} /><DeliverableList items={summary.recentDeliverables} onOpen={(item) => onNavigate(item.pluginId)} /></section>
  </div>;
}

function Metric({ icon, label, value, tone }: { readonly icon: React.ReactNode; readonly label: string; readonly value: number; readonly tone: string }) {
  return <article className={`metric-card ${tone}`}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

export function PanelHeading({ title, action, onAction }: { readonly title: string; readonly action?: string; readonly onAction?: () => void }) {
  return <header className="panel-heading"><h3>{title}</h3>{action && <button onClick={onAction}>{action}<ArrowRight size={14} /></button>}</header>;
}

export function InboxPage({ workspaceId, summary, api, onChanged }: { readonly workspaceId: string; readonly summary: HomeSummary; readonly api: AgentOsClient; readonly onChanged: () => Promise<void> | void }) {
  const [items, setItems] = useState<readonly InboxItemSummary[]>([]);
  const [reconciliations, setReconciliations] = useState<Readonly<Record<string, CodingReconciliationView>>>({});
  const [detailErrors, setDetailErrors] = useState<Readonly<Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refreshInbox = useCallback(async () => {
    setLoading(true);
    const next = await api.inbox(workspaceId);
    const actionable = next.filter((item) => item.kind !== "approval");
    setItems(actionable);
    const reconciliationItems = actionable
      .filter((item) => item.kind === "reconciliation" && item.executionId);
    const settled = await Promise.allSettled(reconciliationItems
      .map(async (item) => [item.id, await api.codingReconciliation(item.executionId!)] as const));
    const details: Record<string, CodingReconciliationView> = {};
    const errors: Record<string, string> = {};
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const item = reconciliationItems[index]!;
      if (result.status === "fulfilled") details[result.value[0]] = result.value[1];
      else errors[item.id] = safeInboxMessage(result.reason);
    }
    setReconciliations(details);
    setDetailErrors(errors);
    setLoading(false);
  }, [api, workspaceId]);

  useEffect(() => { void refreshInbox().catch((error) => { setDetailErrors({ inbox: safeInboxMessage(error) }); setLoading(false); }); }, [refreshInbox]);

  async function decide(id: string, version: number, decision: "approve_once" | "deny") {
    await api.decideApproval(id, version, decision);
    await onChanged();
  }

  async function reconcile(detail: CodingReconciliationView, decision: CodingReconciliationDecision) {
    setBusyId(detail.executionId); setNotice(undefined);
    try {
      await api.decideCodingReconciliation(detail, decision);
      setNotice(decision === "terminate"
        ? "旧调用已终止，隔离资源正在清理"
        : decision === "mark_completed"
          ? "已依据权威证据标记完成，隔离资源正在清理"
          : "旧调用已终止，全新调用已经入队");
      await Promise.all([refreshInbox(), onChanged()]);
    } catch (error) {
      setNotice(safeInboxMessage(error));
    } finally {
      setBusyId(undefined);
    }
  }
  return <div className="page-stack"><PageTitle eyebrow="你的决定" title="收件箱" detail="审批、Agent 问题、凭据失效、失败和人工核对集中在这里。" />
    {notice && <div className="governance-note" role="status"><ShieldCheck size={18} /><p>{notice}</p></div>}
    <div className="inbox-list">{summary.approvals.map((approval) => <article className="approval-card" key={approval.id}>
      <header><span className="pill risk">{approval.risk}</span><span className="expiry"><Clock3 size={14} />{new Date(approval.expiresAt).toLocaleString("zh-CN")}</span></header>
      <h3>{approval.title}</h3><p className="intent">{approval.intent}</p>
      <dl><div><dt>资源</dt><dd>{approval.resourceSummary}</dd></div><div><dt>风险</dt><dd>{approval.risk}</dd></div></dl>
      <footer><button className="danger-button" onClick={() => void decide(approval.id, approval.streamVersion, "deny")}><X size={15} />拒绝</button><button className="primary-button" onClick={() => void decide(approval.id, approval.streamVersion, "approve_once")}><Check size={15} />仅批准这一次</button></footer>
    </article>)}{items.map((item) => item.kind === "reconciliation" && reconciliations[item.id]
      ? <ReconciliationCard key={item.id} item={item} detail={reconciliations[item.id]!} busy={busyId === item.executionId} onDecide={reconcile} />
      : <article className="approval-card inbox-message-card" key={item.id}>
      <header><span className="pill risk"><AlertCircle size={13} />需要处理</span></header>
      <h3>{item.title}</h3><p className="intent">{item.summary}</p>
      {detailErrors[item.id] && <p className="inline-error" role="alert">{detailErrors[item.id]}</p>}
    </article>)}</div>
    {detailErrors.inbox && <p className="inline-error" role="alert">{detailErrors.inbox}</p>}
    {!loading && summary.approvals.length + items.length === 0 && <EmptyState title="收件箱已清空" detail="没有等待处理的审批、问题、故障或人工核对" />}
  </div>;
}

function ReconciliationCard({ item, detail, busy, onDecide }: { readonly item: InboxItemSummary; readonly detail: CodingReconciliationView; readonly busy: boolean; readonly onDecide: (detail: CodingReconciliationView, decision: CodingReconciliationDecision) => Promise<void> }) {
  return <article className="approval-card reconciliation-card">
    <header><span className="pill risk"><AlertCircle size={13} />结果未知</span><span className="expiry">{detail.runnerId === "claude-cli" ? "Claude Runner" : "Codex Runner"}</span></header>
    <h3>{item.title}</h3><p className="intent">{item.summary}</p>
    <dl><div><dt>任务</dt><dd>{detail.taskTitle}</dd></div><div><dt>保留结果</dt><dd>{detail.evidence.candidateCount} 个候选 · {detail.evidence.gateCount} 次 Gate</dd></div></dl>
    <div className="governance-note"><ShieldCheck size={18} /><p>{detail.evidence.summary}<br />下一步：{detail.nextStep}</p></div>
    <footer>
      <button className="danger-button" disabled={busy || !detail.availableDecisions.includes("terminate")} onClick={() => void onDecide(detail, "terminate")}>终止旧调用</button>
      {detail.availableDecisions.includes("mark_completed") && <button className="secondary-button" disabled={busy} onClick={() => void onDecide(detail, "mark_completed")}>依据证据标记完成</button>}
      {detail.availableDecisions.includes("create_new_call") && <button className="primary-button" disabled={busy} onClick={() => void onDecide(detail, "create_new_call")}>创建全新调用</button>}
    </footer>
  </article>;
}

function safeInboxMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail?: { readonly message?: string; readonly action?: string } }).detail;
    if (detail?.message) return `${detail.message}${detail.action ? `。${detail.action}` : ""}`;
  }
  return "收件箱暂时无法更新，请稍后重试";
}

export function DeliverablesPage({ items, onOpen }: { readonly items: readonly DeliverableSummary[]; readonly onOpen: (item: DeliverableSummary) => void }) {
  return <div className="page-stack"><PageTitle eyebrow="可以交付的结果" title="成果" detail="跨插件查看档案、方案、代码证据和决策记录。" /><section className="panel"><DeliverableList items={items} onOpen={onOpen} /></section></div>;
}

export function DeliverableList({ items, onOpen }: { readonly items: readonly DeliverableSummary[]; readonly onOpen: (item: DeliverableSummary) => void }) {
  if (items.length === 0) return <EmptyState title="还没有成果" detail="完成一次机会验证或 Coding 任务后，成果会出现在这里" />;
  return <div className="deliverable-list">{items.map((item) => <article key={item.id}><span className={`plugin-badge ${item.pluginId}`}>{item.pluginId === "opc" ? "OPC" : "CODE"}</span><div><h4>{item.title}</h4><p>{item.outcome}</p><footer>{item.decision && <span><strong>决定</strong>{item.decision}</span>}{item.nextAction && <span><strong>下一步</strong>{item.nextAction}</span>}</footer></div><button className="icon-button" aria-label={`打开成果：${item.title}`} title="打开成果" onClick={() => onOpen(item)}><ArrowRight size={17} /></button></article>)}</div>;
}

export function ActivityPage({ items, professional }: { readonly items: readonly ActivitySummary[]; readonly professional: boolean }) {
  return <div className="page-stack"><PageTitle eyebrow="运行与审计" title="活动" detail="查看执行状态、费用与需要关注的故障。" />
    <section className="panel"><div className="timeline">{items.map((item) => <article key={item.id}><span className="timeline-marker"><Activity size={14} /></span><div><header><strong>{item.title}</strong><span className="pill">{item.status}</span></header><p>{new Date(item.occurredAt).toLocaleString("zh-CN")} · {item.cost}</p>{professional && <details><summary>技术详情</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>}</div></article>)}</div>{items.length === 0 && <EmptyState title="暂无活动" detail="开始一次任务后会显示运行与审计事件" />}</section>
  </div>;
}

export function WorkspacesPage({ workspaces, currentId, members, onSelect }: { readonly workspaces: readonly WorkspaceSummary[]; readonly currentId: string; readonly members: readonly WorkspaceMemberSummary[]; readonly onSelect: (workspace: WorkspaceSummary) => void }) {
  const current = workspaces.find((workspace) => workspace.id === currentId);
  return <div className="page-stack"><PageTitle eyebrow="业务上下文" title="工作区" detail="成员、记忆、插件和会话都以工作区为边界。" /><div className="workspace-grid">{workspaces.map((workspace) => <button key={workspace.id} className={workspace.id === currentId ? "selected" : ""} onClick={() => onSelect(workspace)}><span className="workspace-avatar">{workspace.name.slice(0, 1)}</span><strong>{workspace.name}</strong><small>{workspace.activePluginIds.map(pluginLabel).join(" · ") || "尚未启用产品插件"}</small><span className="pill">{workspace.viewMode === "business" ? "经营视图" : "专业视图"}</span></button>)}</div>{current && <div className="workspace-context-grid"><section className="panel"><PanelHeading title="成员" /><div className="workspace-members">{members.map((member) => <article key={member.id}><span className="workspace-avatar">{memberLabel(member.principalId).slice(0, 1)}</span><div><strong>{memberLabel(member.principalId)}</strong><small>{roleLabel(member.workspaceRole)}</small></div></article>)}</div></section><section className="panel"><PanelHeading title="已启用插件" /><div className="workspace-plugin-list">{current.activePluginIds.map((pluginId) => <span className={`plugin-badge ${pluginId}`} key={pluginId}>{pluginLabel(pluginId)}</span>)}{current.activePluginIds.length === 0 && <p>这个工作区还没有启用产品插件。</p>}</div></section></div>}</div>;
}

function memberLabel(principalId: string): string {
  return principalId === "local-owner" ? "本地所有者" : principalId;
}

function roleLabel(role: WorkspaceMemberSummary["workspaceRole"]): string {
  return { owner: "所有者", operator: "操作员", reviewer: "审核员", viewer: "查看者" }[role];
}

function pluginLabel(pluginId: string): string {
  if (pluginId === "opc") return "OPC";
  if (pluginId === "coding") return "Coding";
  if (pluginId === "runner-claude-cli") return "Claude Runner";
  if (pluginId === "runner-codex-cli") return "Codex Runner";
  return pluginId;
}

export function SettingsPage({ workspace, memories, api, onModeChanged, onMemoriesChanged }: { readonly workspace: WorkspaceSummary; readonly memories: readonly MemorySummary[]; readonly api: AgentOsClient; readonly onModeChanged: (workspace: WorkspaceSummary) => void; readonly onMemoriesChanged: () => void }) {
  async function setMode(mode: ViewMode) { onModeChanged(await api.updateViewMode(workspace, mode)); }
  async function decide(memory: MemorySummary, decision: "accept" | "reject") { await api.decideMemory(memory.id, memory.streamVersion, decision); onMemoriesChanged(); }
  async function revise(memory: MemorySummary, summary: string) { await api.reviseMemory(memory.id, memory.streamVersion, summary, memory.confidence); onMemoriesChanged(); }
  async function remove(memory: MemorySummary) { await api.deleteMemory(memory.id, memory.streamVersion, "用户在设置中确认删除"); onMemoriesChanged(); }
  return <div className="page-stack"><PageTitle eyebrow="工作方式" title="设置" detail="视图只改变信息密度，不改变 API、事件或审批。" />
    <section className="panel settings-section"><PanelHeading title="信息密度" /><div className="segmented" role="group" aria-label="信息密度"><button className={workspace.viewMode === "business" ? "active" : ""} onClick={() => void setMode("business")}>经营视图</button><button className={workspace.viewMode === "professional" ? "active" : ""} onClick={() => void setMode("professional")}>专业视图</button></div><p>经营视图先显示成果、证据和下一步；专业视图原位展开执行细节。</p></section>
    <section className="panel settings-section"><PanelHeading title="记忆与偏好" /><div className="memory-list">{memories.map((memory) => <MemoryCard key={memory.id} memory={memory} professional={workspace.viewMode === "professional"} onDecide={decide} onRevise={revise} onDelete={remove} />)}</div>{memories.length === 0 && <EmptyState title="还没有记忆提案" detail="模型提炼的信息必须经你确认后才会成为记忆" />}</section>
    <section className="panel settings-section"><PanelHeading title="数据治理" /><div className="governance-note"><ShieldCheck size={20} /><p>跨插件默认不可见。共享前会提示：授权撤销后停止后续读取，但已经发送给模型或外部服务的数据无法召回。</p></div></section>
  </div>;
}

function MemoryCard({ memory, professional, onDecide, onRevise, onDelete }: {
  readonly memory: MemorySummary;
  readonly professional: boolean;
  readonly onDecide: (memory: MemorySummary, decision: "accept" | "reject") => Promise<void>;
  readonly onRevise: (memory: MemorySummary, summary: string) => Promise<void>;
  readonly onDelete: (memory: MemorySummary) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(memory.summary);
  const [busy, setBusy] = useState(false);

  async function save() {
    const summary = draft.trim();
    if (!summary) return;
    setBusy(true);
    try { await onRevise(memory, summary); setEditing(false); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try { await onDelete(memory); }
    finally { setBusy(false); }
  }

  return <article>
    <span className="attention-icon"><MemoryStick size={16} /></span>
    <div>
      <header><strong>{memory.summary}</strong><span className={`pill ${memory.status}`}>{memory.status === "proposed" ? "待确认" : memory.status === "accepted" ? "已确认" : "不可用"}</span></header>
      <p>来源：已记录活动 · 置信度 {Math.round(memory.confidence * 100)}%</p>
      {professional && <small>{memory.source} · {memory.namespace} / {memory.resourceId}</small>}
      {editing && <div className="memory-editor"><label>记忆内容<input aria-label="记忆内容" value={draft} onChange={(event) => setDraft(event.target.value)} /></label><div><button type="button" className="quiet-button" disabled={busy} onClick={() => { setDraft(memory.summary); setEditing(false); }}>取消</button><button type="button" className="secondary-button" disabled={busy || !draft.trim()} onClick={() => void save()}>保存记忆修改</button></div></div>}
      {confirmingDelete && <div className="governance-note"><AlertCircle size={18} /><p>删除后无法恢复；审计只保留对象摘要和删除原因。</p><button type="button" className="quiet-button" disabled={busy} onClick={() => setConfirmingDelete(false)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void remove()}>确认删除记忆</button></div>}
    </div>
    {!editing && !confirmingDelete && memory.status !== "invalidated" && <footer>
      {memory.status === "proposed" && <><button type="button" className="quiet-button" onClick={() => void onDecide(memory, "reject")}>拒绝</button><button type="button" className="quiet-button" aria-label={`修改记忆：${memory.summary}`} onClick={() => setEditing(true)}>修改</button><button type="button" className="secondary-button" onClick={() => void onDecide(memory, "accept")}>接受</button></>}
      <button type="button" className="danger-button" aria-label={`删除记忆：${memory.summary}`} onClick={() => setConfirmingDelete(true)}>删除</button>
    </footer>}
  </article>;
}

export function AgentsPage({ catalog }: { readonly catalog: AgentCatalog }) {
  return <div className="page-stack">
    <PageTitle eyebrow="工作能力" title="Agents" detail="先看能交付什么，再按需展开来源、权限和版本。" />
    <section className="panel"><PanelHeading title="已启用的 Agent" />
      <div className="agent-catalog-grid">{catalog.agents.map((agent) => <article className="agent-catalog-card" key={agent.id}><span className="agent-catalog-icon"><Bot size={19} /></span><div><header><span className={`plugin-badge ${agent.pluginId}`}>{pluginLabel(agent.pluginId)}</span><span className="pill accepted">已启用</span></header><h3>{agent.displayName}</h3><p>{agent.description}</p></div></article>)}</div>
      {catalog.agents.length === 0 && <EmptyState title="没有已启用的 Agent" detail="先在工作区启用 OPC 或 Coding 插件" />}
    </section>
    <section className="panel"><PanelHeading title="成果导向 Skill" />
      <div className="skill-catalog-grid">{catalog.skills.map((skill) => <article className="skill-catalog-card" key={skill.id}>
        <header><span className="skill-catalog-icon"><Sparkles size={17} /></span><span className={`plugin-badge ${skill.pluginId}`}>{pluginLabel(skill.pluginId)}</span><span className="pill accepted">已启用</span></header>
        <h3>{skill.title}</h3>
        <dl><div><dt>预期成果</dt><dd>{skill.expectedOutcome}</dd></div>{skill.exampleInput && <div><dt>示例输入</dt><dd>{skill.exampleInput}</dd></div>}</dl>
        <footer><span>{skill.source}</span><span>{skill.license}</span><span>v{skill.version}</span></footer>
        <details><summary><KeyRound size={14} />权限</summary><p>{skill.permissionIds.length > 0 ? skill.permissionIds.join(" · ") : "无需额外工具权限"}</p></details>
      </article>)}</div>
      {catalog.skills.length === 0 && <EmptyState title="还没有可用 Skill" detail="启用产品插件后会显示预期成果和使用示例" />}
    </section>
  </div>;
}
export function IntegrationsPage() {
  return <div className="page-stack">
    <PageTitle eyebrow="受控连接" title="集成" detail="模型、外部 Runner 与产品插件分别授权，变更后重新确认。" />
    <section className="panel settings-section">
      <PanelHeading title="模型与 Runner" />
      <div className="governance-note"><ShieldCheck size={20} /><p>模型密钥只保存在 v2 Keychain。Claude 和 Codex Runner 会固定可执行文件的绝对路径、版本和摘要；文件变化后不会继续沿用原确认。</p></div>
    </section>
    <section className="panel settings-section">
      <PanelHeading title="插件信任边界" />
      <div className="governance-note"><AlertCircle size={20} /><p>生产插件与 Host 同进程运行，能获得宿主进程可见的能力，不是安全沙箱。Execution Authority 只能约束 Agent 和经内核调用的工具，无法约束恶意插件直接使用进程能力。只安装来源、签名、版本、权限和摘要均已核对的插件。</p></div>
    </section>
  </div>;
}

export function PageTitle({ eyebrow, title, detail }: { readonly eyebrow: string; readonly title: string; readonly detail: string }) {
  return <header className="page-title"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></header>;
}
