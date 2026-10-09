import { useEffect, useMemo, useState } from "react";
import { AgentOsApiError, AgentOsClient } from "./api";
import { Onboarding, type BusinessStart } from "./Onboarding";
import { WorkspaceShell } from "./WorkspaceShell";
import { ErrorState, Loading } from "./components/Status";
import type { WorkspaceSummary } from "./types";
import "./styles.css";

const startupRetryDelays = [250, 500, 1000, 2000, 3000] as const;

export default function App() {
  const api = useMemo(() => new AgentOsClient(), []);
  const [checking, setChecking] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(() => localStorage.getItem("muniu:v2:onboarding-complete") !== "1");
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>();
  const [businessStart, setBusinessStart] = useState<BusinessStart>();
  const [error, setError] = useState<string>();
  const [waitingForHost, setWaitingForHost] = useState(false);

  useEffect(() => {
    if (showOnboarding) { setChecking(false); return; }
    let active = true;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    setChecking(true); setError(undefined); setWaitingForHost(false);
    async function openWorkspace() {
      try {
        for (let attempt = 0; attempt <= startupRetryDelays.length; attempt++) {
          try {
            const items = await api.listWorkspaces(controller.signal);
            if (!active) return;
            if (controller.signal.aborted) { setError("木牛后台服务响应超时，请稍后重试。"); return; }
            if (items.length === 0) { setShowOnboarding(true); return; }
            setError(undefined); setWorkspaces(items); setWorkspace(items[0]); return;
          } catch (caught) {
            if (!active) return;
            if (controller.signal.aborted) { setError("木牛后台服务响应超时，请稍后重试。"); return; }
            const transient = caught instanceof AgentOsApiError
              ? caught.detail.retryable && (caught.status === 429 || caught.status >= 500)
              : caught instanceof TypeError || (caught instanceof DOMException && caught.name === "NetworkError");
            const delay = startupRetryDelays[attempt];
            if (!transient || delay === undefined) {
              setError(caught instanceof AgentOsApiError ? `${caught.detail.message}。${caught.detail.action}` : "无法连接木牛 Host。请确认应用后台服务已经启动。");
              return;
            }
            setWaitingForHost(true);
            await waitForStartupRetry(delay, controller.signal);
          }
        }
      } finally { clearTimeout(deadline); if (active) setChecking(false); }
    }
    void openWorkspace();
    return () => { active = false; clearTimeout(deadline); controller.abort(); };
  }, [api, showOnboarding]);

  if (showOnboarding) {
    return <Onboarding api={api} onComplete={(created, start) => { setChecking(true); setWorkspaces([created]); setWorkspace(created); setBusinessStart(start); setShowOnboarding(false); }} />;
  }
  if (checking) return <main className="boot-screen"><Loading label={waitingForHost ? "正在等待木牛后台服务…" : "正在打开工作台"} /></main>;
  if (error || !workspace) return <main className="boot-screen"><ErrorState detail={error ?? "没有可用工作区"} action="运行 mn doctor --fix 后重试" onRetry={() => location.reload()} /></main>;
  return <WorkspaceShell api={api} initialWorkspace={workspace} initialWorkspaces={workspaces} initialBusinessTab={businessStart} />;
}

function waitForStartupRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
