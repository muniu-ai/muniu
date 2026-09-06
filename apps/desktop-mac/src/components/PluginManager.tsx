import { useEffect, useState } from "react";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { WorkspaceSummary } from "../types";

export function PluginManager({ api, workspace, onChanged }: { readonly api: AgentOsClient; readonly workspace: WorkspaceSummary; readonly onChanged: (workspace: WorkspaceSummary) => void }) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<AgentOsClient["pluginCatalog"]>>>([]);
  const [installed, setInstalled] = useState<Awaited<ReturnType<AgentOsClient["pluginInstallations"]>>>([]);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  async function refresh() { const [a, b] = await Promise.all([api.pluginCatalog(), api.pluginInstallations()]); setCatalog(a); setInstalled(b); }
  useEffect(() => { void refresh().catch(() => setMessage("无法读取插件仓库，请检查 Host 配置")); }, [api]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setMessage(undefined);
    try { await work(); await refresh(); onChanged(await api.workspace(workspace.id)); setMessage("插件状态已更新"); }
    catch (error) { setMessage(error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "插件操作未完成，请重试"); }
    finally { setBusy(false); }
  }
  return <section className="panel page-stack" aria-label="插件管理"><h3>插件</h3>
    <p>签名插件拥有宿主进程权限，可访问宿主可见的数据。签名用于确认来源和完整性，不是沙箱。</p>
    <label><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />我信任所选插件的发布者，允许安装或更新</label>
    {catalog.length === 0 && <p>未配置受信仓库。官方 OPC 和 Coding 已预装，可按工作区启用。</p>}
    {catalog.map((release) => {
      const current = installed.find((item) => item.pluginId === release.pluginId);
      return <article key={`${release.pluginId}:${release.version}`} className="panel"><h4>{release.displayName} · {release.version}</h4><p>{release.description}</p><p>{release.license}</p><details><summary>权限和来源</summary><ul>{release.permissions.map((permission) => <li key={permission.id}>{permission.description}</li>)}</ul><p>{release.release.source}</p><code>{release.packageSha256}</code></details><button disabled={!trusted || busy || current?.version === release.version} onClick={() => void run(() => api.installPlugin(release.pluginId, release.version, current?.streamVersion))}>{current ? "更新到此版本" : "安装"}</button></article>;
    })}
    {installed.map((item) => <div key={item.pluginId}><strong>{item.pluginId} · {item.version}</strong><button disabled={busy || ["disabled", "revoked", "failed", "draining"].includes(item.status ?? "")} onClick={() => void run(() => api.setPluginActivation(workspace.id, item.pluginId, workspace.streamVersion, !workspace.activePluginIds.includes(item.pluginId)))}>{workspace.activePluginIds.includes(item.pluginId) ? "在此工作区停用" : "在此工作区启用"}</button></div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
