import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, Bot, Boxes, BriefcaseBusiness, ChevronDown, Code2, Command, FileCheck2,
  FolderKanban, Home, Inbox, PanelLeftClose, PanelLeftOpen, Plug, Plus, Search,
  Settings, Sparkles, Users, Zap,
} from "lucide-react";
import { AgentOsApiError, AgentOsClient } from "./api";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { PluginBoundary } from "./components/PluginBoundary";
import { PluginCard } from "./components/PluginSurface";
import { PluginManager } from "./components/PluginManager";
import type { WorkspacePluginSurfaceV1 } from "@mn/contracts";
import { ErrorState, Loading } from "./components/Status";
import {
  ActivityPage, AgentsPage, DeliverablesPage, HomePage, InboxPage, IntegrationsPage,
  SettingsPage, WorkspacesPage,
} from "./pages/CorePages";
import { CodingPage, OpcPage } from "./pages/PluginPages";
import type {
  ActivitySummary, AgentCatalog, CodingTaskSummary, DeliverableSummary, HomeSummary, MemorySummary,
  OpportunitySummary, PluginHealth, ProductPluginId, WorkspaceMemberSummary, WorkspaceSummary,
} from "./types";

type PageId = "home" | "workspaces" | "inbox" | "deliverables" | "activity" | "agents" | "integrations" | "settings" | "opc" | "coding" | `plugin:${string}`;

const emptyHome: HomeSummary = { todayActions: [], blockers: [], approvals: [], recentDeliverables: [] };
const emptyAgentCatalog: AgentCatalog = { agents: [], skills: [] };

function productPlugins(pluginIds: readonly string[]): readonly ProductPluginId[] {
  return pluginIds.filter((pluginId): pluginId is ProductPluginId => pluginId === "opc" || pluginId === "coding");
}

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
}

export function WorkspaceShell({ api, initialWorkspace, initialWorkspaces }: WorkspaceShellProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [page, setPage] = useState<PageId>("home");
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [capturePlugin, setCapturePlugin] = useState<ProductPluginId | undefined>(productPlugins(initialWorkspace.activePluginIds)[0]);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [home, setHome] = useState<HomeSummary>(emptyHome);
  const [deliverables, setDeliverables] = useState<readonly DeliverableSummary[]>([]);
  const [activity, setActivity] = useState<readonly ActivitySummary[]>([]);
  const [memories, setMemories] = useState<readonly MemorySummary[]>([]);
  const [members, setMembers] = useState<readonly WorkspaceMemberSummary[]>([]);
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalog>(emptyAgentCatalog);
  const [opportunities, setOpportunities] = useState<readonly OpportunitySummary[]>([]);
  const [codingTasks, setCodingTasks] = useState<readonly CodingTaskSummary[]>([]);
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

  const professional = workspace.viewMode === "professional";

  const refreshCore = useCallback(async () => {
    setCoreLoading(true); setCoreError(undefined);
    const [homeResult, deliverablesResult, activityResult, memoriesResult, membersResult, catalogResult, healthResult] = await Promise.allSettled([
      api.home(workspace.id), api.deliverables(workspace.id), api.activity(workspace.id), api.memories(workspace.id), api.workspaceMembers(workspace.id), api.agentCatalog(workspace.id), api.health(workspace.id),
    ]);
    if (homeResult.status === "fulfilled") setHome(homeResult.value); else setCoreError(safeMessage(homeResult.reason));
    if (deliverablesResult.status === "fulfilled") setDeliverables(deliverablesResult.value);
    if (activityResult.status === "fulfilled") setActivity(activityResult.value);
    if (memoriesResult.status === "fulfilled") setMemories(memoriesResult.value);
    if (membersResult.status === "fulfilled") setMembers(membersResult.value);
    if (catalogResult.status === "fulfilled") setAgentCatalog(catalogResult.value);
    if (healthResult.status === "fulfilled") setHealth(healthResult.value.plugins);
    setCoreLoading(false);
  }, [api, workspace.id]);

  const refreshOpc = useCallback(async () => {
    if (!workspace.activePluginIds.includes("opc")) return;
    setOpcLoading(true); setOpcError(undefined);
    try { setOpportunities(await api.opportunities(workspace.id)); }
    catch (error) { setOpcError(safeMessage(error)); }
    finally { setOpcLoading(false); }
  }, [api, workspace.activePluginIds, workspace.id]);

  const refreshCoding = useCallback(async () => {
    if (!workspace.activePluginIds.includes("coding")) return;
    setCodingLoading(true); setCodingError(undefined);
    try { setCodingTasks(await api.codingTasks(workspace.id)); }
    catch (error) { setCodingError(safeMessage(error)); }
    finally { setCodingLoading(false); }
  }, [api, workspace.activePluginIds, workspace.id]);

  useEffect(() => { void refreshCore(); void refreshOpc(); void refreshCoding(); }, [refreshCoding, refreshCore, refreshOpc]);
  useEffect(() => {
    let current = true;
    void api.pluginSurfaces(workspace.id).then((value) => { if (current) setSurfaces(value); })
      .catch(() => { if (current) setSurfaces([]); });
    return () => { current = false; };
  }, [api, workspace.id, workspace.streamVersion]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const paletteItems = useMemo<readonly PaletteItem[]>(() => [
    { id: "home", kind: "命令", title: "打开首页", action: () => setPage("home") },
    { id: "inbox", kind: "命令", title: "打开收件箱", detail: `${home.approvals.length} 项待处理`, action: () => setPage("inbox") },
    ...surfaces.flatMap((surface) => (surface.ui?.pages ?? []).map((entry) => ({ id: `plugin:${surface.pluginId}:${entry.routeId}`, kind: "命令" as const, title: entry.title, action: () => setPage(`plugin:${surface.pluginId}:${entry.routeId}`) }))),
    ...opportunities.map((item) => ({ id: `opportunity:${item.id}`, kind: "机会" as const, title: item.title, detail: item.nextAction, action: () => { setSelectedOpportunityId(item.id); setPage("opc"); } })),
    ...codingTasks.map((item) => ({ id: `task:${item.id}`, kind: "Coding 任务" as const, title: item.title, detail: item.status, action: () => { setSelectedCodingTaskId(item.id); setPage("coding"); } })),
    ...deliverables.map((item) => ({ id: `deliverable:${item.id}`, kind: "成果" as const, title: item.title, detail: item.outcome, action: () => setPage(item.pluginId) })),
    ...agentCatalog.skills.map((skill) => ({ id: `skill:${skill.id}`, kind: "Skill" as const, title: skill.title, detail: skill.expectedOutcome, action: () => setPage("agents") })),
  ], [agentCatalog.skills, codingTasks, deliverables, home.approvals.length, opportunities, surfaces]);

  async function submitCapture() {
    const value = captureText.trim();
    if (!value || !capturePlugin) return;
    setCaptureBusy(true); setNotice(undefined);
    try {
      await api.capture(workspace.id, capturePlugin, value);
      setCaptureText(""); setNotice(capturePlugin === "opc" ? "机会已生成，等待你审阅" : "Coding 任务已生成，等待你审阅");
      if (capturePlugin === "opc") { await refreshOpc(); setPage("opc"); }
      else { await refreshCoding(); setPage("coding"); }
      await refreshCore();
    } catch (error) { setNotice(safeMessage(error)); }
    finally { setCaptureBusy(false); }
  }

  function selectWorkspace(next: WorkspaceSummary) {
    setWorkspace(next); setCapturePlugin(productPlugins(next.activePluginIds)[0]); setSelectedOpportunityId(undefined); setSelectedCodingTaskId(undefined); setPage("home");
  }

  function updateWorkspace(next: WorkspaceSummary) {
    setWorkspace(next);
    setWorkspaces((current) => current.map((candidate) => candidate.id === next.id ? next : candidate));
  }

  const degraded = health.filter((item) => item.status === "degraded");
  const capturePlugins = productPlugins(workspace.activePluginIds);

  return <div className={`app-shell ${sidebarCompact ? "sidebar-compact" : ""}`} data-view-mode={workspace.viewMode}>
    <aside className="sidebar" aria-label="主导航">
      <header className="sidebar-brand"><span className="brand-mark small">木</span>{!sidebarCompact && <div><strong>木牛</strong><small>Agent OS</small></div>}<button className="icon-button sidebar-toggle" title={sidebarCompact ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCompact((value) => !value)}>{sidebarCompact ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></header>
      <button className="workspace-switcher" onClick={() => setPage("workspaces")}><span className="workspace-avatar">{workspace.name.slice(0, 1)}</span>{!sidebarCompact && <span><strong>{workspace.name}</strong><small>{workspace.viewMode === "business" ? "经营视图" : "专业视图"}</small></span>}{!sidebarCompact && <ChevronDown size={15} />}</button>
      <nav>
        <NavButton compact={sidebarCompact} active={page === "home"} label="首页" icon={<Home />} onClick={() => setPage("home")} />
        <NavButton compact={sidebarCompact} active={page === "workspaces"} label="工作区" icon={<FolderKanban />} onClick={() => setPage("workspaces")} />
        <NavButton compact={sidebarCompact} active={page === "inbox"} label="收件箱" badge={home.approvals.length} icon={<Inbox />} onClick={() => setPage("inbox")} />
        <NavButton compact={sidebarCompact} active={page === "deliverables"} label="成果" icon={<FileCheck2 />} onClick={() => setPage("deliverables")} />
        <NavButton compact={sidebarCompact} active={page === "activity"} label="活动" icon={<Activity />} onClick={() => setPage("activity")} />
        {!sidebarCompact && <p className="nav-label">已启用插件</p>}
        {workspace.activePluginIds.includes("opc") && <NavButton compact={sidebarCompact} active={page === "opc"} label="OPC" icon={<BriefcaseBusiness />} onClick={() => setPage("opc")} status={health.find((item) => item.pluginId === "opc")?.status} />}
        {workspace.activePluginIds.includes("coding") && <NavButton compact={sidebarCompact} active={page === "coding"} label="Coding" icon={<Code2 />} onClick={() => setPage("coding")} status={health.find((item) => item.pluginId === "coding")?.status} />}
        {surfaces.flatMap((surface) => (surface.ui?.pages ?? []).map((entry) => {
          const target: PageId = `plugin:${surface.pluginId}:${entry.routeId}`;
          return <NavButton key={target} compact={sidebarCompact} active={page === target} label={surface.navigation.find((item) => item.routeId === entry.routeId)?.label ?? entry.title} icon={<Plug />} onClick={() => setPage(target)} />;
        }))}
      </nav>
      <div className="technical-nav"><button className="technical-toggle" onClick={() => setTechnicalOpen((value) => !value)} title="技术配置"><span><Boxes size={17} />{!sidebarCompact && "技术配置"}</span>{!sidebarCompact && <ChevronDown className={technicalOpen ? "rotated" : ""} size={15} />}</button>{technicalOpen && <div><NavButton compact={sidebarCompact} active={page === "agents"} label="Agents" icon={<Bot />} onClick={() => setPage("agents")} /><NavButton compact={sidebarCompact} active={page === "integrations"} label="集成" icon={<Plug />} onClick={() => setPage("integrations")} /><NavButton compact={sidebarCompact} active={page === "settings"} label="设置" icon={<Settings />} onClick={() => setPage("settings")} /></div>}</div>
      <footer className="sidebar-footer"><span className="connection-dot" />{!sidebarCompact && <span><strong>本地数据已连接</strong><small>遥测已关闭</small></span>}</footer>
    </aside>

    <main className="main-surface">
      <header className="topbar">
        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <Search size={17} /><span>搜索命令、机会、任务和成果</span>
          <kbd><Command size={12} />K</kbd>
        </button>
        <span className="view-chip">{professional ? "专业视图" : "经营视图"}</span>
        <button className="avatar-button" title="本地所有者">本</button>
      </header>
      <section className="quick-capture" aria-label="快速捕获"><span className="capture-icon"><Zap size={17} /></span><input value={captureText} disabled={!capturePlugin} onChange={(event) => setCaptureText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitCapture(); }} placeholder={!capturePlugin ? "先在工作区启用 OPC 或 Coding" : capturePlugin === "opc" ? "记下一条机会、客户原话或反证" : "描述一个 Coding 任务"} /><select aria-label="捕获类型" value={capturePlugin ?? ""} disabled={capturePlugins.length === 0} onChange={(event) => setCapturePlugin(event.target.value as ProductPluginId)}>{capturePlugins.map((pluginId) => <option key={pluginId} value={pluginId}>{pluginLabel(pluginId)}</option>)}</select><button className="primary-button" disabled={!capturePlugin || !captureText.trim() || captureBusy} onClick={() => void submitCapture()}><Plus size={15} />{captureBusy ? "正在保存" : "捕获"}</button></section>
      {notice && <div className="toast" role="status"><Sparkles size={15} />{notice}<button onClick={() => setNotice(undefined)}>关闭</button></div>}
      {degraded.length > 0 && <div className="degraded-banner" role="status">{degraded.map((item) => `${pluginLabel(item.pluginId)} 已降级`).join("，")}。首页、收件箱和设置仍可使用。</div>}
      <div className="page-scroll">
        {coreLoading && page === "home" && <Loading />}
        {coreError && page === "home" && <ErrorState detail={coreError} action="检查 Host 后重试" onRetry={() => void refreshCore()} />}
        {!coreLoading && !coreError && page === "home" && <HomePage summary={home} onNavigate={(target) => setPage(target as PageId)} />}
        {page === "workspaces" && <WorkspacesPage workspaces={workspaces} currentId={workspace.id} members={members} onSelect={selectWorkspace} />}
        {page === "inbox" && <InboxPage workspaceId={workspace.id} summary={home} api={api} onChanged={refreshCore} />}
        {page === "deliverables" && <DeliverablesPage items={deliverables} onOpen={(item) => setPage(item.pluginId)} />}
        {page === "activity" && <ActivityPage items={activity} professional={professional} />}
        {page === "agents" && <AgentsPage catalog={agentCatalog} />}
        {page === "integrations" && <IntegrationsPage />}
        {page === "settings" && <div className="page-stack"><SettingsPage workspace={workspace} memories={memories} api={api} onModeChanged={updateWorkspace} onMemoriesChanged={() => void refreshCore()} /><PluginManager api={api} workspace={workspace} onChanged={updateWorkspace} /></div>}
        {surfaces.flatMap((surface) => (surface.ui?.pages ?? []).filter((entry) => page === `plugin:${surface.pluginId}:${entry.routeId}`).map((entry) => <PluginBoundary key={`${surface.pluginId}:${surface.version}:${entry.routeId}`} pluginName={surface.pluginId}><div className="page-stack"><h1>{entry.title}</h1>{entry.cards.map((card, index) => <PluginCard key={index} card={card} pluginId={surface.pluginId} workspaceId={workspace.id} api={api} />)}</div></PluginBoundary>))}
        {page === "home" && surfaces.flatMap((surface) => (surface.ui?.widgets ?? []).map((widget) => <PluginBoundary key={`${surface.pluginId}:${surface.version}:${widget.widgetId}`} pluginName={surface.pluginId}><PluginCard card={widget.card} pluginId={surface.pluginId} workspaceId={workspace.id} api={api} /></PluginBoundary>))}
        {page === "opc" && <PluginBoundary pluginName="OPC"><OpcPage api={api} workspaceId={workspace.id} items={opportunities} selectedId={selectedOpportunityId} onSelect={setSelectedOpportunityId} loading={opcLoading} error={opcError} viewMode={workspace.viewMode} onRetry={() => void refreshOpc()} onChanged={async () => { await Promise.all([refreshOpc(), refreshCore()]); }} /></PluginBoundary>}
        {page === "coding" && <PluginBoundary pluginName="Coding"><CodingPage items={codingTasks} selectedId={selectedCodingTaskId} onSelect={setSelectedCodingTaskId} loading={codingLoading} error={codingError} viewMode={workspace.viewMode} onRetry={() => void refreshCoding()} /></PluginBoundary>}
      </div>
    </main>
    <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />
  </div>;
}

function NavButton({ compact, active, label, icon, badge, status, onClick }: { readonly compact: boolean; readonly active: boolean; readonly label: string; readonly icon: React.ReactNode; readonly badge?: number; readonly status?: "healthy" | "degraded"; readonly onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick} title={compact ? label : undefined}><span>{icon}</span>{!compact && <><strong>{label}</strong>{Boolean(badge) && <small className="nav-badge">{badge}</small>}{status === "degraded" && <small className="nav-status" title="插件已降级" />}</>}</button>;
}

function safeMessage(error: unknown): string {
  if (error instanceof AgentOsApiError) return `${error.detail.message}。${error.detail.action}`;
  return "连接暂时不可用，请检查 Host 后重试";
}
