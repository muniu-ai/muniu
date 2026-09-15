// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ModelConnectionV2, ModelPresetV2 } from "@mn/contracts";
import { AgentOsApiError, type AgentOsClient } from "../api";

export function ModelConnections({ api, professional }: { readonly api: AgentOsClient; readonly professional: boolean }) {
  const [connections, setConnections] = useState<readonly ModelConnectionV2[]>([]);
  const [presets, setPresets] = useState<readonly ModelPresetV2[]>([]);
  const [presetId, setPresetId] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const refresh = useCallback(async () => {
    const [models, choices] = await Promise.all([api.modelConnections(), api.modelPresets()]);
    setConnections(models); setPresets(choices);
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
  async function probe(connection: ModelConnectionV2, makeDefault: boolean) {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.probeModel(connection.id, connection.streamVersion, makeDefault);
      await refresh();
      setNotice(makeDefault ? "新任务将使用所选连接，既有执行保持原模型绑定。" : "连接探测通过。");
    } catch (caught) { setError(safeError(caught)); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  return <section className="panel settings-section model-connections" aria-label="模型连接管理">
    <h2>模型连接</h2>
    <p>选择厂商并输入 BYOK 密钥，木牛自动发现可用模型。切换仅影响新执行，不会自动恢复暂停的任务。</p>
    {loading && <p role="status">正在读取连接…</p>}
    <div className="model-connection-list">{connections.map(connection => <article key={connection.id}>
      <div><strong>{connection.displayName}</strong><span className="pill">{connection.status === "ready" ? "已连接" : connection.status === "invalid" ? "凭据失效" : "待探测"}</span>
        {selected?.id === connection.id && <span className="pill accepted">新任务默认</span>}
        {professional && <small>{connection.defaultModel || "尚未发现模型"}</small>}
      </div>
      <div className="model-connection-actions"><button className="secondary-button" disabled={busy} onClick={() => void probe(connection, false)}>检查连接</button>
        {selected?.id !== connection.id && <button className="secondary-button" disabled={busy} onClick={() => void probe(connection, true)}>用于新任务</button>}
      </div>
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

function safeError(error: unknown): string {
  return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "模型连接未完成，请检查 Host 和网络后重试。";
}
