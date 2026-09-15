// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from "react";
import type { CodingRunnerViewV2, ExternalCodingRunnerId, RunnerBinaryInspectionV1 } from "@mn/contracts";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { WorkspaceSummary } from "../types";

export function RunnerConfiguration({ api, workspace, onChanged }: {
  readonly api: AgentOsClient; readonly workspace: WorkspaceSummary;
  readonly onChanged: (workspace: WorkspaceSummary) => void;
}) {
  const [runners, setRunners] = useState<readonly CodingRunnerViewV2[]>([]);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setRunners(await api.codingRunners(workspace.id)); setError(undefined); }
    catch (caught) { setError(errorMessage(caught)); }
  }, [api, workspace.id]);
  useEffect(() => { void load(); }, [load]);
  return <section className="panel settings-section">
    <h2>外部 Runner</h2><p>内置 Agent 是默认执行方式。外部 Runner 只在每次发起任务时显式选择，不接管其模型、技能或历史会话。</p>
    {error && <p role="alert">{error}<button className="quiet-button" onClick={() => void load()}>重新读取配置</button></p>}
    <div className="runner-grid">{(["claude-cli", "codex-cli"] as const).map(runnerId => {
      const configuration = runners.find(runner => runner.runnerId === runnerId);
      return <RunnerCard key={`${workspace.id}:${runnerId}`} api={api} workspace={workspace} runnerId={runnerId}
        configuration={configuration} onChanged={onChanged} onConfirmed={load} />;
    })}</div>
  </section>;
}

function RunnerCard({ api, workspace, runnerId, configuration, onChanged, onConfirmed }: {
  readonly api: AgentOsClient; readonly workspace: WorkspaceSummary; readonly runnerId: ExternalCodingRunnerId;
  readonly configuration?: CodingRunnerViewV2; readonly onChanged: (workspace: WorkspaceSummary) => void;
  readonly onConfirmed: () => Promise<void>;
}) {
  const name = runnerId === "claude-cli" ? "Claude CLI" : "Codex CLI";
  const enabled = workspace.activePluginIds.includes(`runner-${runnerId}`);
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
  return <section className="runner-card" aria-label={`${name} 配置`}>
    <h3>{name}</h3>
    <p>{!enabled ? "插件尚未启用" : configuration?.status === "confirmed" ? "已确认" : "尚未确认可执行文件"}</p>
    {configuration?.status === "confirmed" && <small>{configuration.identity.realPath} · {configuration.identity.version}</small>}
    {!enabled ? <button className="secondary-button" disabled={busy} onClick={() => void act(async () => {
      onChanged(await api.setPluginActivation(workspace.id, `runner-${runnerId}`, workspace.streamVersion, true));
    })}>启用 {name} 插件</button> : <>
      <label>可执行文件绝对路径<input value={path} disabled={busy} placeholder="输入可信的原生 CLI 文件路径" onChange={event => {
        setPath(event.target.value); setInspection(undefined); setReviewed(false);
      }} /></label>
      <button className="secondary-button" disabled={busy || !path.trim().startsWith("/")} onClick={() => void act(async () => {
        setInspection(undefined); setReviewed(false);
        setInspection(await api.inspectCodingRunner(workspace.id, runnerId, path.trim()));
      })}>{busy ? "正在处理" : "检查文件"}</button>
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
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function errorMessage(error: unknown): string {
  return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "无法读取 Runner 配置，请检查 Host 后重试。";
}
