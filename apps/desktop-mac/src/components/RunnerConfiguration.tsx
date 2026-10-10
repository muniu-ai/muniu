// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentReadinessReportV1, AgentReadinessV1, ExternalCodingRunnerId, RunnerBinaryInspectionV1 } from "@mn/contracts";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { WorkspaceSummary } from "../types";

export function RunnerConfiguration({ api, workspace, onChanged }: {
  readonly api: AgentOsClient; readonly workspace: WorkspaceSummary;
  readonly onChanged: (workspace: WorkspaceSummary) => void;
}) {
  const [report, setReport] = useState<AgentReadinessReportV1>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const requestSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true); setError(undefined);
    try { const next = await api.agentReadiness(workspace.id); if (sequence === requestSequence.current) setReport(next); }
    catch (caught) { if (sequence === requestSequence.current) { setReport(undefined); setError(errorMessage(caught)); } }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, [api, workspace.id, workspace.streamVersion]);
  useEffect(() => { setReport(undefined); void load(); return () => { requestSequence.current += 1; }; }, [load]);
  return <section className="panel settings-section" aria-label="外部 Agent 调度检查">
    <div className="connectivity-heading"><h2>外部 Agent 调度检查</h2><button className="secondary-button" disabled={loading} onClick={() => void load()}>{loading ? "正在检查…" : "重新检查"}</button></div>
    <p>经营与研发任务都可选择内置 Agent 或外部 CLI。内置 Agent 使用木牛模型连接；Codex 和 Claude Code 使用各自的账户和模型。</p>
    <p>检查只读取木牛配置和已确认文件，不启动 Agent、不执行登录或生成任务。安装应用、确认文件和具备执行条件是不同状态。</p>
    {error && <p role="alert">{error}</p>}
    {report && <>
      <small>检查时间：{new Date(report.checkedAt).toLocaleString("zh-CN")}</small>
      <div className="runner-grid">{report.agents.map(agent => <RunnerCard key={`${workspace.id}:${agent.agentId}`} api={api} workspace={workspace}
        agent={agent} onChanged={onChanged} onConfirmed={load} />)}</div>
    </>}
  </section>;
}

const checkLabels: Readonly<Record<AgentReadinessV1["checks"][number]["id"], string>> = {
  task_plugin: "任务能力", runner_plugin: "Agent 插件", permission: "木牛授权", confirmation: "文件确认",
  binary_identity: "文件一致性", worker: "执行服务", sandbox: "隔离环境", authentication: "Agent 登录",
  approval: "任务审批", adapter: "木牛适配", model: "模型连接",
};
const checkStatuses = { passed: "已通过", blocked: "未满足", unknown: "未验证", required: "任务发起时确认" } as const;

function RunnerCard({ api, workspace, agent, onChanged, onConfirmed }: {
  readonly api: AgentOsClient; readonly workspace: WorkspaceSummary; readonly agent: AgentReadinessV1;
  readonly onChanged: (workspace: WorkspaceSummary) => void; readonly onConfirmed: () => Promise<void>;
}) {
  const runnerId: ExternalCodingRunnerId | undefined = agent.agentId === "codex-cli" || agent.agentId === "claude-cli" ? agent.agentId : undefined;
  const configuration = agent.configuration;
  const enabled = runnerId !== undefined && workspace.activePluginIds.includes(`runner-${runnerId}`);
  const codingEnabled = workspace.activePluginIds.some(id => id === "coding" || id === "opc");
  const firstIssue = agent.checks.find(check => check.status === "blocked") ?? agent.checks.find(check => check.status === "unknown");
  const [path, setPath] = useState("");
  const [version, setVersion] = useState("");
  const [inspection, setInspection] = useState<RunnerBinaryInspectionV1>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function act(action: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await action(); } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="runner-card" aria-label={`${agent.displayName} 接入状态`}>
    <header><h3>{agent.displayName}</h3><span className={`pill ${agent.status === "blocked" ? "blocked" : "pending"}`}>{agent.support === "not_supported" ? "尚未接入" : agent.status === "blocked" ? "暂不可启动" : "尚待验证"}</span></header>
    {agent.support === "supported" && <p>适用范围：经营与研发任务</p>}
    {firstIssue && <p className="runner-next-step">{firstIssue.message}</p>}
    <details className="runner-readiness-details"><summary>查看检查项与处理步骤</summary>
      <ul className="runner-checks">{agent.checks.map(check => <li key={check.id}>
        <div><strong>{checkLabels[check.id]}</strong><span className={`pill ${check.status === "passed" ? "accepted" : check.status}`}>{checkStatuses[check.status]}</span></div>
        <p>{check.message}</p>{check.action && <small>下一步：{check.action}</small>}
      </li>)}</ul>
    </details>
    {agent.support === "supported" && runnerId && <>
      {configuration?.status === "confirmed" && <div className="runner-confirmed"><strong>文件已确认</strong><small>{configuration.identity.realPath} · {configuration.identity.version}</small></div>}
      {!codingEnabled ? <button className="secondary-button" disabled={busy} onClick={() => void act(async () => {
        onChanged(await api.setPluginActivation(workspace.id, "coding", workspace.streamVersion, true));
      })}>启用 Coding</button> : !enabled ? <button className="secondary-button" disabled={busy} onClick={() => void act(async () => {
        onChanged(await api.setPluginActivation(workspace.id, `runner-${runnerId}`, workspace.streamVersion, true));
      })}>启用 {agent.displayName} 插件</button> : <details className="runner-file-settings">
        <summary>确认 Agent 可执行文件</summary>
        <label>可执行文件绝对路径<input value={path} disabled={busy} placeholder="输入可信的原生 CLI 文件路径" onChange={event => {
          setPath(event.target.value); setInspection(undefined); setReviewed(false);
        }} /></label>
        <button className="secondary-button" disabled={busy || !path.trim().startsWith("/")} onClick={() => void act(async () => {
          setInspection(undefined); setReviewed(false);
          setInspection(await api.inspectCodingRunner(workspace.id, runnerId, path.trim()));
        })}>{busy ? "正在处理…" : "检查文件"}</button>
        <p>检查只读取文件，不执行程序。不支持 npm 或 shebang 包装脚本。</p>
        {inspection && <div className="runner-inspection">
          <dl><dt>真实路径</dt><dd>{inspection.realPath}</dd><dt>SHA-256</dt><dd>{inspection.sha256}</dd></dl>
          <label>已核实的版本<input value={version} disabled={busy} onChange={event => { setVersion(event.target.value); setReviewed(false); }} /></label>
          <label className="runner-review"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)} />我已核对文件来源、版本和摘要</label>
          <button className="primary-button" disabled={busy || !reviewed || !version.trim()} onClick={() => void act(async () => {
            try {
              await api.confirmCodingRunner(runnerId, { workspaceId: workspace.id, binaryPath: inspection.requestedPath,
                sha256: inspection.sha256, version: version.trim(), expectedStreamVersion: configuration?.status === "confirmed" ? configuration.streamVersion : 0 });
              await onConfirmed();
            } finally { setInspection(undefined); setReviewed(false); }
          })}>确认使用此文件</button>
        </div>}
      </details>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function errorMessage(error: unknown): string {
  return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "无法读取 Agent 接入状态，请检查 Host 后重试。";
}
