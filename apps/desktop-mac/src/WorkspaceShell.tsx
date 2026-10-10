import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Bot, Boxes, BriefcaseBusiness, ChevronDown, Code2, Command, FileCheck2,
  FolderKanban, Home, Inbox, PanelLeftClose, PanelLeftOpen, Plug, Search,
  Settings, Sparkles, Users,
} from "lucide-react";
import { AgentOsApiError, AgentOsClient } from "./api";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { BrandMark } from "./components/BrandMark";
import { RepositoryDialog } from "./components/RepositoryDialog";
import { PluginBoundary } from "./components/PluginBoundary";
import { PluginCard } from "./components/PluginSurface";
import { PluginManager } from "./components/PluginManager";
import type { BusinessManagementViewV1, GoalV2, ProductNavigationV2, WorkspacePluginSurfaceV1 } from "@mn/contracts";
import { ErrorState, Loading } from "./components/Status";
import {
  ActivityPage, AgentsPage, DeliverablesPage, HomePage, InboxPage, IntegrationsPage,
  SettingsPage, WorkspacesPage,
} from "./pages/CorePages";
import { CodingPage, OpcPage } from "./pages/PluginPages";
import { GoalsPage } from "./pages/GoalsPage";
import { BusinessManagementPage } from "./pages/BusinessManagementPage";
import type { BusinessStart } from "./Onboarding";
import type {
  ActivitySummary, AgentCatalog, CodingRepositorySummary, CodingTaskSummary, DeliverableSummary, HomeSummary, MemorySummary,
  InboxItemSummary, OpportunitySummary, PluginHealth, WorkspaceMemberSummary, WorkspaceSummary,
} from "./types";

import type { WorkspaceConnectionState } from "./workspace-events";

type PageId = "home" | "goals" | "workspaces" | "inbox" | "deliverables" | "activity" | "agents" | "integrations" | "settings" | "opc" | "opc-validation" | "coding" | `plugin:${string}`;

const emptyHome: HomeSummary = { todayActions: [], blockers: [], approvals: [], recentDeliverables: [] };
const emptyAgentCatalog: AgentCatalog = { agents: [], skills: [] };


function pluginLabel(pluginId: string): string {
  if (pluginId === "opc") return "OPC";
  if (pluginId === "coding") return "Coding";
  if (pluginId === "runner-claude-cli") return "Claude Runner";
  if (pluginId === "runner-codex-cli") return "Codex Runner";
  return pluginId;
}

interface WorkspaceShellProps {
  readonly api: AgentOsClient;
  readonly initialWorkspace: WorkspaceSummary;
  readonly initialWorkspaces: readonly WorkspaceSummary[];
  readonly initialBusinessTab?: BusinessStart;
}

export function WorkspaceShell({ api, initialWorkspace, initialWorkspaces, initialBusinessTab }: WorkspaceShellProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [page, setPage] = useState<PageId>(initialBusinessTab || (initialWorkspace.viewMode === "business" && initialWorkspace.activePluginIds.includes("opc")) ? "opc" : "home");
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [newTaskRequest, setNewTaskRequest] = useState(0);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [goals, setGoals] = useState<readonly GoalV2[]>([]);
  const [business, setBusiness] = useState<BusinessManagementViewV1>();
  const [goalTarget, setGoalTarget] = useState<{ id: string; sequence: number }>();
  const [businessTarget, setBusinessTarget] = useState<{ namespace: string; resourceId: string }>();
  const [repositoryTarget, setRepositoryTarget] = useState<{ id: string; sequence: number }>();
  const [connection, setConnection] = useState<WorkspaceConnectionState>("connecting");
  const workspaceRef = useRef(workspace.id); workspaceRef.current = workspace.id;
  const coreSequence = useRef(0), opcSequence = useRef(0), codingSequence = useRef(0);
  const loadedWorkspace = useRef<string | undefined>(undefined);
  const [home, setHome] = useState<HomeSummary>(emptyHome);
  const [deliverables, setDeliverables] = useState<readonly DeliverableSummary[]>([]);
  const [activity, setActivity] = useState<readonly ActivitySummary[]>([]);
  const [memories, setMemories] = useState<readonly MemorySummary[]>([]);
  const [members, setMembers] = useState<readonly WorkspaceMemberSummary[]>([]);
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalog>(emptyAgentCatalog);
  const [opportunities, setOpportunities] = useState<readonly OpportunitySummary[]>([]);
  const [codingTasks, setCodingTasks] = useState<readonly CodingTaskSummary[]>([]);
  const [codingRepositories, setCodingRepositories] = useState<readonly CodingRepositorySummary[]>([]);
  const [captureRepositoryId, setCaptureRepositoryId] = useState<string>();
  const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string>();
  const [selectedCodingTaskId, setSelectedCodingTaskId] = useState<string>();
  const [health, setHealth] = useState<readonly PluginHealth[]>([]);
  const [surfaces, setSurfaces] = useState<readonly WorkspacePluginSurfaceV1[]>([]);
  const [coreLoading, setCoreLoading] = useState(true);
  const [coreError, setCoreError] = useState<string>();
  const [opcLoading, setOpcLoading] = useState(false);
  const [opcError, setOpcError] = useState<string>();
  const [codingLoading, setCodingLoading] = useState(false);
  const [codingError, setCodingError] = useState<string>();

  useEffect(() => { document.querySelector(".page-scroll")?.scrollTo({ top: 0 }); }, [page]);
  useEffect(() => {
    if ((["opc", "opc-validation"].includes(page) && !workspace.activePluginIds.includes("opc")) || (page === "coding" && !workspace.activePluginIds.includes("coding"))) setPage("home");
  }, [page, workspace.activePluginIds]);

  const professional = workspace.viewMode === "professional";
  const repositories = codingRepositories.filter(item => item.workspaceId === workspace.id);
  const repositoryId = repositories.find(item => item.id === captureRepositoryId)?.id
    ?? (repositories.length === 1 ? repositories[0]?.id : undefined);


  const refreshCore = useCallback(async () => {
    const sequence = ++coreSequence.current;
    setCoreLoading(loadedWorkspace.current !== workspace.id); setCoreError(undefined);
    const results = await Promise.allSettled([
      api.home(workspace.id), api.deliverables(workspace.id), api.activity(workspace.id), api.memories(workspace.id),
      api.workspaceMembers(workspace.id), api.agentCatalog(workspace.id), api.health(workspace.id), api.goals(workspace.id),
      workspace.activePluginIds.includes("opc") ? api.business(workspace.id) : Promise.resolve(undefined),
      api.workspace(workspace.id), api.listWorkspaces(),
    ] as const);
    if (sequence !== coreSequence.current || workspaceRef.current !== workspace.id) return;
    const [h, d, a, m, membersResult, catalog, healthResult, g, businessResult, currentWorkspace, workspaceList] = results;
    if (currentWorkspace.status === "fulfilled") setWorkspace(current => current.id === currentWorkspace.value.id && current.streamVersion < currentWorkspace.value.streamVersion ? currentWorkspace.value : current);
    if (workspaceList.status === "fulfilled") setWorkspaces(workspaceList.value);
    setHome(h.status === "fulfilled" ? h.value : emptyHome);
    setDeliverables(d.status === "fulfilled" ? d.value : []);
    setActivity(a.status === "fulfilled" ? a.value : []);
    setMemories(m.status === "fulfilled" ? m.value : []);
    setMembers(membersResult.status === "fulfilled" ? membersResult.value : []);
    setAgentCatalog(catalog.status === "fulfilled" ? catalog.value : emptyAgentCatalog);
    setHealth(healthResult.status === "fulfilled" ? healthResult.value.plugins : []);
    setGoals(g.status === "fulfilled" ? g.value : []);
    setBusiness(businessResult.status === "fulfilled" ? businessResult.value : undefined);
    const failure = results.find(result => result.status === "rejected");
    setCoreError(failure?.status === "rejected" ? safeMessage(failure.reason) : undefined);
    loadedWorkspace.current = workspace.id; setCoreLoading(false);
  }, [api, workspace.id, workspace.activePluginIds]);

  const refreshOpc = useCallback(async () => {
    if (!workspace.activePluginIds.includes("opc")) { setOpportunities([]); return; }
    const sequence = ++opcSequence.current;
    setOpcLoading(true); setOpcError(undefined);
    try { const next = await api.opportunities(workspace.id); if (sequence === opcSequence.current && workspaceRef.current === workspace.id) setOpportunities(next); }
    catch (error) { if (sequence === opcSequence.current && workspaceRef.current === workspace.id) { setOpportunities([]); setOpcError(safeMessage(error)); } }
    finally { if (sequence === opcSequence.current && workspaceRef.current === workspace.id) setOpcLoading(false); }
  }, [api, workspace.activePluginIds, workspace.id]);

  const refreshCoding = useCallback(async () => {
    if (!workspace.activePluginIds.includes("coding")) { setCodingTasks([]); setCodingRepositories([]); return; }
    const sequence = ++codingSequence.current;
    setCodingLoading(true); setCodingError(undefined);
    try {
      const [tasks, repositories] = await Promise.all([api.codingTasks(workspace.id), api.codingRepositories(workspace.id)]);
      if (sequence !== codingSequence.current || workspaceRef.current !== workspace.id) return;
      setCodingTasks(tasks); setCodingRepositories(repositories);
    }
    catch (error) { if (sequence === codingSequence.current && workspaceRef.current === workspace.id) { setCodingTasks([]); setCodingRepositories([]); setCodingError(safeMessage(error)); } }
    finally { if (sequence === codingSequence.current && workspaceRef.current === workspace.id) setCodingLoading(false); }
  }, [api, workspace.activePluginIds, workspace.id]);

  useEffect(() => { void refreshCore(); void refreshOpc(); void refreshCoding(); }, [refreshCoding, refreshCore, refreshOpc]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = api.watchWorkspaceEvents(workspace.id, () => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; void refreshCore(); void refreshOpc(); void refreshCoding(); }, 150);
    }, setConnection);
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [api, workspace.id, refreshCore, refreshOpc, refreshCoding]);
  useEffect(() => {
    let current = true;
    void api.pluginSurfaces(workspace.id).then((value) => { if (current) setSurfaces(value); })
      .catch(() => { if (current) setSurfaces([]); });
    return () => { current = false; };
  }, [api, workspace.id, workspace.streamVersion]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") { event.preventDefault(); setPage("goals"); setNewTaskRequest(value => value + 1); }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function openGoal(id: string) { setGoalTarget(current => ({ id, sequence: (current?.sequence ?? 0) + 1 })); setPage("goals"); }
  function openNavigation(target?: ProductNavigationV2) {
    if (!target) { setPage("deliverables"); setNotice("没有可用的对象入口，请检查成果来源"); return; }
    const goal = target.threadId ? goals.find(item => item.threadId === target.threadId) : undefined;
    if (goal) { openGoal(goal.id); return; }
    if (target.resourceRef?.namespace === "opc.opportunity") { setSelectedOpportunityId(target.resourceRef.resourceId); setPage("opc-validation"); return; }
    if (target.resourceRef?.namespace === "coding.task") { setSelectedCodingTaskId(target.resourceRef.resourceId); setPage("coding"); return; }
    if (target.resourceRef?.namespace === "opc.customer" || target.resourceRef?.namespace === "opc.order") { setBusinessTarget(target.resourceRef); setPage("opc"); return; }
    setNotice("该对象暂无可用详情，请从任务列表核对来源"); setPage("goals");
  }

  function openInboxItem(item: InboxItemSummary) {
    if (item.kind === "credential") { setPage("settings"); return; }
    openNavigation(item.navigation);
  }

  const paletteItems = useMemo<readonly PaletteItem[]>(() => [
    { id: "delegate", kind: "命令", title: "委派任务", action: () => { setPage("goals"); setNewTaskRequest(value => value + 1); } },
    { id: "home", kind: "命令", title: "打开工作台", action: () => setPage("home") },
    { id: "inbox", kind: "命令", title: "打开收件箱", detail: `${home.approvals.length} 项待处理`, action: () => setPage("inbox") },
    ...surfaces.flatMap((surface) => (surface.ui?.pages ?? []).map((entry) => ({ id: `plugin:${surface.pluginId}:${entry.routeId}`, kind: "命令" as const, title: entry.title, action: () => setPage(`plugin:${surface.pluginId}:${entry.routeId}`) }))),
    ...goals.map(item => ({ id: `goal:${item.id}`, kind: "任务" as const, title: item.objective.split("\n")[0]!, detail: item.status, action: () => openGoal(item.id) })),
    ...latestCustomers(business).map(item => ({ id: `customer:${item.id}`, kind: "客户" as const, title: item.name, detail: item.need, action: () => openNavigation({ pluginId: "opc", resourceRef: { namespace: "opc.customer", resourceId: item.id } }) })),
    ...(business?.state.orders ?? []).map(item => ({ id: `order:${item.id}`, kind: "订单" as const, title: `${business?.state.customers.find(customer => customer.id === item.customerId && customer.version === item.customerVersion)?.name ?? "客户"} · ${business?.state.services.find(service => service.id === item.serviceId && service.version === item.serviceVersion)?.title ?? "订单"}`, detail: `${item.contractedOn} · ${item.id}`, action: () => openNavigation({ pluginId: "opc", resourceRef: { namespace: "opc.order", resourceId: item.id } }) })),
    ...repositories.map(item => ({ id: `repository:${item.id}`, kind: "仓库" as const, title: item.name, detail: item.rootRealPath, action: () => { setCaptureRepositoryId(item.id); setSelectedCodingTaskId(undefined); setRepositoryTarget(current => ({ id: item.id, sequence: (current?.sequence ?? 0) + 1 })); setPage("coding"); } })),
    ...opportunities.map((item) => ({ id: `opportunity:${item.id}`, kind: "机会" as const, title: item.title, detail: item.nextAction, action: () => { setSelectedOpportunityId(item.id); setPage("opc-validation"); } })),
    ...codingTasks.map((item) => ({ id: `task:${item.id}`, kind: "Coding 任务" as const, title: item.title, detail: item.status, action: () => { setSelectedCodingTaskId(item.id); setPage("coding"); } })),
    ...deliverables.map((item) => ({ id: `deliverable:${item.id}`, kind: "成果" as const, title: item.title, detail: item.outcome, action: () => openNavigation(item.navigation) })),
    ...agentCatalog.skills.map((skill) => ({ id: `skill:${skill.id}`, kind: "Skill" as const, title: skill.title, detail: skill.expectedOutcome, action: () => setPage("agents") })),
  ], [agentCatalog.skills, codingTasks, deliverables, home.approvals.length, opportunities, surfaces, goals, business, repositories]);

  async function submitCapture() {
    if (!captureText.trim() || captureBusy) return;
    setCaptureBusy(true);
    try {
      await api.capture(workspace.id, "opc", captureText.trim());
      setCaptureText(""); setNotice("机会已记录，可以继续整理证据或委派分析任务");
      await refreshOpc();
    } catch (error) { setNotice(safeMessage(error)); }
    finally { setCaptureBusy(false); }
  }

  function selectWorkspace(next: WorkspaceSummary) {
    setRepositoryDialogOpen(false);
    setGoals([]); setBusiness(undefined); setGoalTarget(undefined); setBusinessTarget(undefined); setOpportunities([]); setCodingTasks([]); setHome(emptyHome); setDeliverables([]);
    setCaptureRepositoryId(undefined); setCodingRepositories([]); setRepositoryTarget(undefined);
    setWorkspace(next); setCaptureText(""); setSelectedOpportunityId(undefined); setSelectedCodingTaskId(undefined); setPage(next.viewMode === "business" && next.activePluginIds.includes("opc") ? "opc" : "home");
  }

  function updateWorkspace(next: WorkspaceSummary) {
    setWorkspace(next);
    setWorkspaces((current) => current.map((candidate) => candidate.id === next.id ? next : candidate));
  }

  const degraded = health.filter((item) => item.status === "degraded");

  return <div className={`app-shell ${sidebarCompact ? "sidebar-compact" : ""}`} data-view-mode={workspace.viewMode}>
    <aside className="sidebar" aria-label="主导航">
      <header className="sidebar-brand"><BrandMark small />{!sidebarCompact && <div><strong>木牛</strong><small>Agent OS</small></div>}<button className="icon-button sidebar-toggle" title={sidebarCompact ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCompact((value) => !value)}>{sidebarCompact ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></header>
      <button className="workspace-switcher" onClick={() => setPage("workspaces")}><span className="workspace-avatar">{workspace.name.slice(0, 1)}</span>{!sidebarCompact && <span><strong>{workspace.name}</strong><small>{workspace.viewMode === "business" ? "经营视图" : "专业视图"}</small></span>}{!sidebarCompact && <ChevronDown size={15} />}</button>
      <nav>
        <NavButton compact={sidebarCompact} active={page === "home"} label="工作台" icon={<Home />} onClick={() => setPage("home")} />
        <NavButton compact={sidebarCompact} active={page === "goals"} label="任务" icon={<FileCheck2 />} onClick={() => setPage("goals")} />
        {workspace.activePluginIds.includes("opc") && <NavButton compact={sidebarCompact} active={page === "opc" || page === "opc-validation"} label="经营" icon={<BriefcaseBusiness />} onClick={() => setPage("opc")} status={health.find((item) => item.pluginId === "opc")?.status} />}
        <NavButton compact={sidebarCompact} active={page === "deliverables"} label="资料与成果" icon={<FileCheck2 />} onClick={() => setPage("deliverables")} />
        {!sidebarCompact && <p className="nav-label">工作区与工具</p>}
        <NavButton compact={sidebarCompact} active={page === "workspaces"} label="工作区" icon={<FolderKanban />} onClick={() => setPage("workspaces")} />
        <NavButton compact={sidebarCompact} active={page === "inbox"} label="收件箱" badge={home.approvals.length} icon={<Inbox />} onClick={() => setPage("inbox")} />
        <NavButton compact={sidebarCompact} active={page === "activity"} label="活动" icon={<Activity />} onClick={() => setPage("activity")} />
        {!sidebarCompact && <p className="nav-label">专业工具</p>}
        {workspace.activePluginIds.includes("coding") && <NavButton compact={sidebarCompact} active={page === "coding"} label="Coding" icon={<Code2 />} onClick={() => setPage("coding")} status={health.find((item) => item.pluginId === "coding")?.status} />}
        {surfaces.flatMap((surface) => (surface.ui?.pages ?? []).map((entry) => {
          const target: PageId = `plugin:${surface.pluginId}:${entry.routeId}`;
          return <NavButton key={target} compact={sidebarCompact} active={page === target} label={surface.navigation.find((item) => item.routeId === entry.routeId)?.label ?? entry.title} icon={<Plug />} onClick={() => setPage(target)} />;
        }))}
      </nav>
      <div className="technical-nav"><button className="technical-toggle" onClick={() => setTechnicalOpen((value) => !value)} title="技术配置"><span><Boxes size={17} />{!sidebarCompact && "技术配置"}</span>{!sidebarCompact && <ChevronDown className={technicalOpen ? "rotated" : ""} size={15} />}</button>{technicalOpen && <div><NavButton compact={sidebarCompact} active={page === "agents"} label="Agents" icon={<Bot />} onClick={() => setPage("agents")} /><NavButton compact={sidebarCompact} active={page === "integrations"} label="集成" icon={<Plug />} onClick={() => setPage("integrations")} /></div>}<NavButton compact={sidebarCompact} active={page === "settings"} label="设置" icon={<Settings />} onClick={() => setPage("settings")} /></div>
      <footer className="sidebar-footer"><span className={`connection-dot ${connection}`} />{!sidebarCompact && <span><strong>{connection === "connected" ? "本地数据已连接" : connection === "connecting" ? "正在连接" : "连接已断开"}</strong><small>遥测已关闭</small></span>}</footer>
    </aside>

    <main className="main-surface">
      <header className="topbar">
        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <Search size={17} /><span>搜索命令、任务、客户、订单和成果</span>
          <kbd><Command size={12} />K</kbd>
        </button>
        <span className="view-chip">{professional ? "专业视图" : "经营视图"}</span>
        <button className="avatar-button" title="本地所有者">本</button>
      </header>
      {page !== "goals" && <section className="delegation-launcher"><span><Sparkles size={20} /><span><strong>把目标交给木牛</strong><small>补充资料与验收要求，跟进经营或研发任务</small></span></span><button className="primary-button" onClick={() => { setPage("goals"); setNewTaskRequest(value => value + 1); }}>委派任务<kbd aria-hidden="true">⌘ J</kbd></button></section>}
      {connection === "disconnected" && <div className="degraded-banner" role="status">连接已断开，显示的数据可能过期。重新连接后会自动刷新。</div>}
      {notice && <div className="toast" role="status"><Sparkles size={15} />{notice}<button onClick={() => setNotice(undefined)}>关闭</button></div>}
      {degraded.length > 0 && <div className="degraded-banner" role="status">{degraded.map((item) => `${pluginLabel(item.pluginId)} 已降级`).join("，")}。工作台、收件箱和设置仍可使用。</div>}
      <div className="page-scroll">
        {coreLoading && page === "home" && <Loading />}
        {coreError && page === "home" && <ErrorState detail={coreError} action="检查 Host 后重试" onRetry={() => void refreshCore()} />}
        {!coreLoading && !coreError && page === "home" && <HomePage summary={home} goals={goals} business={business} onGoal={openGoal} onObject={openNavigation} onNavigate={(target) => setPage(target as PageId)} />}
        {page === "workspaces" && <WorkspacesPage workspaces={workspaces} currentId={workspace.id} members={members} onSelect={selectWorkspace} />}
        <div hidden={page !== "goals"}><GoalsPage target={goalTarget} active={page === "goals"} onTaskCreated={() => { void refreshCoding(); void refreshCore(); }} key={workspace.id} pluginIds={workspace.activePluginIds} repositories={repositories} repositoryId={repositoryId} onRepository={setCaptureRepositoryId} onRegisterRepository={() => setRepositoryDialogOpen(true)} onSettings={() => setPage("settings")} newTaskRequest={newTaskRequest} api={api} workspaceId={workspace.id} onOpenThread={thread => {
          if (thread.pluginId === "coding") { setSelectedCodingTaskId(thread.resourceRef?.resourceId); setPage("coding"); }
          else { setSelectedOpportunityId(thread.resourceRef?.resourceId); setPage("opc-validation"); }
        }} /></div>
        {page === "inbox" && <InboxPage workspaceId={workspace.id} summary={home} api={api} onChanged={refreshCore} onOpen={openInboxItem} />}
        {page === "deliverables" && <DeliverablesPage items={deliverables} goals={goals} onGoal={openGoal} onOpen={(item) => openNavigation(item.navigation)} />}
        {page === "activity" && <ActivityPage items={activity} professional={professional} />}
        {page === "agents" && <AgentsPage catalog={agentCatalog} />}
        {page === "integrations" && <IntegrationsPage onOpenSettings={() => setPage("settings")} />}
        {page === "settings" && <div className="page-stack"><SettingsPage workspace={workspace} memories={memories} api={api} onModeChanged={updateWorkspace} onMemoriesChanged={() => void refreshCore()} /><PluginManager api={api} workspace={workspace} onChanged={updateWorkspace} /></div>}
        {surfaces.flatMap((surface) => (surface.ui?.pages ?? []).filter((entry) => page === `plugin:${surface.pluginId}:${entry.routeId}`).map((entry) => <PluginBoundary key={`${surface.pluginId}:${surface.version}:${entry.routeId}`} pluginName={surface.pluginId}><div className="page-stack"><h1>{entry.title}</h1>{entry.cards.map((card, index) => <PluginCard key={index} card={card} pluginId={surface.pluginId} workspaceId={workspace.id} api={api} />)}</div></PluginBoundary>))}
        {page === "home" && surfaces.flatMap((surface) => (surface.ui?.widgets ?? []).map((widget) => <PluginBoundary key={`${surface.pluginId}:${surface.version}:${widget.widgetId}`} pluginName={surface.pluginId}><PluginCard card={widget.card} pluginId={surface.pluginId} workspaceId={workspace.id} api={api} /></PluginBoundary>))}
        {page === "opc" && <PluginBoundary pluginName="OPC"><BusinessManagementPage target={businessTarget} key={workspace.id} api={api} workspaceId={workspace.id} initialTab={workspace.id === initialWorkspace.id ? initialBusinessTab : undefined} onExplore={() => { setSelectedOpportunityId(undefined); setPage("opc-validation"); }} /></PluginBoundary>}
        {page === "opc-validation" && <PluginBoundary pluginName="OPC"><button className="quiet-button" onClick={() => setPage("opc")}>返回经营管理</button><form className="quick-capture" aria-label="记录机会" onSubmit={event => { event.preventDefault(); void submitCapture(); }}><input aria-label="机会描述" placeholder="记录客户原话或待验证的机会" value={captureText} disabled={captureBusy} onChange={event => setCaptureText(event.target.value)} /><button className="primary-button" disabled={captureBusy || !captureText.trim()}>记录机会</button></form><OpcPage api={api} workspaceId={workspace.id} items={opportunities} selectedId={selectedOpportunityId} onSelect={setSelectedOpportunityId} loading={opcLoading} error={opcError} viewMode={workspace.viewMode} onRetry={() => void refreshOpc()} onChanged={async () => { await Promise.all([refreshOpc(), refreshCore()]); }} /></PluginBoundary>}
        {page === "coding" && <PluginBoundary pluginName="Coding"><CodingPage repositoryTarget={repositoryTarget} key={workspace.id} api={api} workspaceId={workspace.id} repositories={repositories} onRegisterRepository={() => setRepositoryDialogOpen(true)} items={codingTasks} selectedId={selectedCodingTaskId} onSelect={setSelectedCodingTaskId} loading={codingLoading} error={codingError} viewMode={workspace.viewMode} onRetry={() => void refreshCoding()} /></PluginBoundary>}
      </div>
    </main>
    <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />
    <RepositoryDialog key={workspace.id} api={api} workspaceId={workspace.id} workspaceName={workspace.name} repositories={repositories} open={repositoryDialogOpen} onClose={() => setRepositoryDialogOpen(false)} onSelected={repository => {
      setCodingRepositories(current => [...current.filter(item => item.id !== repository.id), repository]);
      setCaptureRepositoryId(repository.id);
      setNotice(`已选中仓库「${repository.name}」，可以继续填写任务`);
    }} />
  </div>;
}

function NavButton({ compact, active, label, icon, badge, status, onClick }: { readonly compact: boolean; readonly active: boolean; readonly label: string; readonly icon: React.ReactNode; readonly badge?: number; readonly status?: "healthy" | "degraded"; readonly onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick} title={compact ? label : undefined}><span>{icon}</span>{!compact && <><strong>{label}</strong>{Boolean(badge) && <small className="nav-badge">{badge}</small>}{status === "degraded" && <small className="nav-status" title="插件已降级" />}</>}</button>;
}

function safeMessage(error: unknown): string {
  if (error instanceof AgentOsApiError) return `${error.detail.message}。${error.detail.action}`;
  return "连接暂时不可用，请检查 Host 后重试";
}

function latestCustomers(view?: BusinessManagementViewV1) {
  const customers = new Map<string, NonNullable<typeof view>["state"]["customers"][number]>();
  for (const item of view?.state.customers ?? []) if ((customers.get(item.id)?.version ?? 0) < item.version) customers.set(item.id, item);
  return [...customers.values()];
}
