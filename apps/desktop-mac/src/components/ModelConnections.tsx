// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ModelConnectionV2, ModelPresetV2 } from "@mn/contracts";
import { AgentOsApiError, type AgentOsClient } from "../api";

export function ModelConnections({ api, professional }: { readonly api: AgentOsClient; readonly professional: boolean }) {
  const [connections, setConnections] = useState<readonly ModelConnectionV2[]>([]);
  const [presets, setPresets] = useState<readonly ModelPresetV2[]>([]);
  const [presetId, setPresetId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const refresh = useCallback(async () => {
    const [models, choices] = await Promise.all([api.modelConnections(), api.modelPresets()]);
    setConnections(models); setPresets(choices);
    setPresetId(current => choices.some(preset => preset.id === current) ? current : choices[0]?.id ?? "");
  }, [api]);
  useEffect(() => {
    void refresh().catch(caught => setError(safeError(caught))).finally(() => setLoading(false));
  }, [refresh]);
  const selected = connections.find(connection => connection.status === "ready" && connection.defaultForNewExecutions)
    ?? connections.find(connection => connection.status === "ready");
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy || !apiKey.trim()) return;
    const secret = apiKey.trim();
    setBusy(true); setError(undefined); setNotice(undefined); setApiKey("");
    try {
      const connection = await api.connectModel(presetId, secret);
      await api.probeModel(connection.id, connection.streamVersion, true);
      await refresh();
      setNotice("模型已连接，新任务将使用此连接。既有执行保持原模型绑定。");
    } catch (caught) { setError(safeError(caught)); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  async function probe(connection: ModelConnectionV2) {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.probeModel(connection.id, connection.streamVersion);
      await refresh();
      setNotice("连接探测通过。");
    } catch (caught) { setError(safeError(caught)); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  async function selectModel(connection: ModelConnectionV2, modelName: string) {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.selectModelConnectionModel(connection.id, connection.streamVersion, modelName);
      await refresh();
      setNotice("已为新任务创建所选模型连接，既有执行保持原模型绑定。");
    } catch (caught) { setError(safeError(caught)); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  return <section className="panel settings-section model-connections" aria-label="模型连接管理">
    <h2>模型连接</h2>
    <p>为木牛内置 Agent 选择模型厂商并填写密钥。模型连接与外部 Agent 的登录、授权和执行环境分别管理。</p>
    <p>检查连接只读取厂商模型列表，不发起生成任务。切换模型仅影响新执行，不会自动恢复暂停的任务。</p>
    {loading && <p role="status">正在读取连接…</p>}
    <div className="model-connection-list">{connections.map(connection => <article key={connection.id} aria-label={`${connection.displayName} 模型连接`}>
      <div><strong>{connection.displayName}</strong><span className="pill">{connection.status === "ready" ? "已读取模型列表" : connection.status === "invalid" ? "凭据失效" : "待探测"}</span>
        {selected?.id === connection.id && <span className="pill accepted">新任务默认</span>}
        <small>任务模型：{connection.defaultModel || "尚未发现模型"}</small>
        {professional && <small>厂商返回 {connection.discoveredModels.length} 个模型</small>}
      </div>
      <div className="model-connection-actions"><button className="secondary-button" disabled={busy} onClick={() => void probe(connection)}>检查连接</button>
        {connection.status === "ready" && selected?.id !== connection.id && <button className="secondary-button" disabled={busy} onClick={() => void selectModel(connection, connection.defaultModel)}>设为默认连接</button>}
      </div>
      <ModelChoice connection={connection} busy={busy} onSelect={modelName => selectModel(connection, modelName)} />
    </article>)}</div>
    <form className="form-stack" onSubmit={event => void connect(event)}>
      <h3>新增连接或更换密钥</h3>
      <div className="field"><label htmlFor="connection-provider">模型厂商</label><select id="connection-provider" value={presetId} disabled={busy || !presets.length} onChange={event => setPresetId(event.target.value)}>
        {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.displayName}</option>)}
      </select></div>
      <div className="field"><label htmlFor="connection-api-key">新模型密钥</label><input id="connection-api-key" type="password" autoComplete="off" value={apiKey} disabled={busy}
        aria-describedby="connection-key-storage" onChange={event => setApiKey(event.target.value)} /><small id="connection-key-storage">仅提交给当前部署的密钥存储，不在页面回显或写入浏览器存储。</small></div>
      <button className="primary-button" disabled={busy || !apiKey.trim() || !presets.length}>{busy ? "正在连接…" : "保存并用于新任务"}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

function ModelChoice({ connection, busy, onSelect }: {
  readonly connection: ModelConnectionV2; readonly busy: boolean;
  readonly onSelect: (modelName: string) => Promise<void>;
}) {
  const [modelName, setModelName] = useState(connection.defaultModel);
  useEffect(() => { setModelName(connection.defaultModel); }, [connection.id, connection.defaultModel]);
  const choice = connection.modelOptions.find(option => option.modelName === modelName);
  return <div className="model-choice">
    <label htmlFor={`model-choice-${connection.id}`}>为新任务选择模型</label>
    <select id={`model-choice-${connection.id}`} value={modelName} disabled={busy || connection.status !== "ready"}
      onChange={event => setModelName(event.target.value)}>
      {connection.modelOptions.map(option => <option key={option.modelName} value={option.modelName} disabled={!option.selectable}>
        {option.modelName}{option.reason ? ` · ${option.reason}` : ""}
      </option>)}
    </select>
    <button className="secondary-button" disabled={busy || connection.status !== "ready" || !choice?.selectable || modelName === connection.defaultModel}
      onClick={() => void onSelect(modelName)}>用于新任务</button>
    <small>仅可选择已发现且具备预算计价的模型。既有连接保留原模型。</small>
  </div>;
}

function safeError(error: unknown): string {
  return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "模型连接未完成，请检查 Host 和网络后重试。";
}
