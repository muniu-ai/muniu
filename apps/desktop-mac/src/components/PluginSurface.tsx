import { useState } from "react";
import type { PluginCardV1 } from "@mn/contracts";
import { AgentOsApiError, type AgentOsClient } from "../api";

export function PluginCard({ card, pluginId, workspaceId, api }: {
  readonly card: PluginCardV1; readonly pluginId: string; readonly workspaceId: string; readonly api: AgentOsClient;
}) {
  const [input, setInput] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  return <section className="panel"><h3>{card.title}</h3><p>{card.body}</p>{card.commandId && <form className="page-stack" onSubmit={(event) => {
    event.preventDefault(); setBusy(true); setResult(undefined);
    const body: Record<string, unknown> = {};
    for (const field of card.fields ?? []) {
      const raw = input[field.name];
      if (raw === undefined || raw === "") continue;
      body[field.name] = field.type === "number" ? Number(raw) : field.type === "boolean" ? raw === "true" : raw;
    }
    void api.pluginCommand(workspaceId, pluginId, card.commandId!, version, body)
      .then((value) => setResult(typeof value === "string" ? value : JSON.stringify(value, null, 2)))
      .catch((error: unknown) => setResult(error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "插件命令未完成，请重试"))
      .finally(() => setBusy(false));
  }}>{(card.fields ?? []).map((field) => <label key={field.name}>{field.label ?? field.name}{field.type === "boolean"
      ? <select required={field.required} value={input[field.name] ?? ""} onChange={(event) => setInput({ ...input, [field.name]: event.target.value })}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
      : <input type={field.type === "number" ? "number" : "text"} required={field.required} value={input[field.name] ?? ""} onChange={(event) => setInput({ ...input, [field.name]: event.target.value })} />}</label>)}
    <details><summary>并发版本</summary><label>对象版本号<input type="number" min={0} step={1} required value={version} onChange={(event) => setVersion(Number(event.target.value))} /></label></details>
    <button className="primary-button" disabled={busy}>{busy ? "正在执行" : card.title}</button></form>}
    {result && <pre className="plugin-result" role="status">{result}</pre>}
  </section>;
}
