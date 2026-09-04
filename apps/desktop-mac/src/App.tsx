import { useEffect, useMemo, useState } from "react";
import { AgentOsClient } from "./api";
import { Onboarding } from "./Onboarding";
import { WorkspaceShell } from "./WorkspaceShell";
import { ErrorState, Loading } from "./components/Status";
import type { WorkspaceSummary } from "./types";
import "./styles.css";

export default function App() {
  const api = useMemo(() => new AgentOsClient(), []);
  const [checking, setChecking] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(() => localStorage.getItem("muniu:v2:onboarding-complete") !== "1");
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (showOnboarding) { setChecking(false); return; }
    let active = true;
    api.listWorkspaces().then((items) => {
      if (!active) return;
      if (items.length === 0) { setShowOnboarding(true); return; }
      setWorkspaces(items); setWorkspace(items[0]);
    }).catch(() => {
      if (active) setError("无法连接木牛 Host。请确认应用后台服务已经启动。");
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [api, showOnboarding]);

  if (showOnboarding) {
    return <Onboarding api={api} onComplete={(created) => { setWorkspaces([created]); setWorkspace(created); setShowOnboarding(false); }} />;
  }
  if (checking) return <main className="boot-screen"><Loading label="正在打开工作台" /></main>;
  if (error || !workspace) return <main className="boot-screen"><ErrorState detail={error ?? "没有可用工作区"} action="运行 mn doctor --fix 后重试" onRetry={() => location.reload()} /></main>;
  return <WorkspaceShell api={api} initialWorkspace={workspace} initialWorkspaces={workspaces} />;
}
