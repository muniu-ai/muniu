// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { save as showSaveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile as writeTauriFile } from "@tauri-apps/plugin-fs";
import type { JsonValue, Thread, ThreadItem, UserInput } from "@mn/app-server-protocol";

import {
  decideDesktopApproval,
  desktopAppServerClient,
  subscribeDesktopApprovals,
  type DesktopApprovalRequest
} from "./app-server";

function itemSummary(item: ThreadItem): string {
  switch (item.type) {
    case "userMessage":
      return item.content.map((value) => value.type === "text" ? value.text : `[${value.type}]`).join("\n");
    case "agentMessage": return item.text;
    case "plan": return item.text;
    case "reasoning": return item.summary.join("\n");
    case "commandExecution": return `${item.command}\n${item.aggregatedOutput ?? ""}`.trim();
    case "fileChange": return item.changes.map((change) => `${change.kind.type}: ${change.path}`).join("\n");
    case "mcpToolCall": return `${item.server}/${item.tool} · ${item.status}`;
    case "dynamicToolCall": return `${item.namespace ? `${item.namespace}/` : ""}${item.tool} · ${item.status}`;
    case "subAgentActivity": return `${item.agentPath} → ${item.agentThreadId} · ${item.kind}`;
    case "webSearch": return item.query;
    case "attachment": return `${item.name} · ${item.mimeType}\n${item.uri}`;
    case "contextCompaction": return item.summary ?? "上下文已压缩";
    case "approval": return `${item.approvalId} · ${item.status}`;
    case "evidenceCheckpoint": return `${item.evidenceId} · ${item.status}\n${item.digest}`;
  }
}

function parseOutputSchema(value: string): JsonValue | undefined {
  if (!value.trim()) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (parsed === undefined) throw new Error("结构化输出 schema 不能为空");
  return parsed as JsonValue;
}

const MAX_IMAGE_BYTES = 3_670_016;

function readImageDataUrl(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("附件必须是 PNG、JPEG 或 WebP 图像");
  }
  if (file.size > MAX_IMAGE_BYTES) throw new Error("图像附件不能超过 3.5 MiB");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图像附件"));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("无法读取图像附件"));
    reader.readAsDataURL(file);
  });
}

export function ThreadWorkspace() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("local-mock");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [contextPath, setContextPath] = useState("");
  const [attachment, setAttachment] = useState<{ readonly name: string; readonly url: string } | null>(null);
  const [outputSchema, setOutputSchema] = useState("");
  const [goal, setGoal] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly DesktopApprovalRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(
    () => thread?.turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))) ?? [],
    [thread]
  );
  const plans = items.filter(({ item }) => item.type === "plan");
  const changes = items.filter(({ item }) => item.type === "fileChange");
  const commands = items.filter(({ item }) => item.type === "commandExecution");
  const subAgents = items.filter(({ item }) => item.type === "subAgentActivity");
  const evidence = items.filter(({ item }) => item.type === "evidenceCheckpoint");

  async function refreshThreads(nextSelectedId = selectedId): Promise<void> {
    const client = await desktopAppServerClient();
    const result = await client.listThreads({ limit: 100, archived: false });
    setThreads(result.data);
    const id = nextSelectedId ?? result.data[0]?.id ?? null;
    setSelectedId(id);
    if (id) {
      const detail = await client.call("thread/read", { threadId: id, includeTurns: true });
      setThread(detail.thread);
      setCwd(detail.thread.cwd);
      setProvider(detail.thread.muniu.providerId);
      setModel(detail.thread.muniu.modelId);
      setGoal(detail.thread.muniu.goal?.objective ?? "");
      setTokenBudget(detail.thread.muniu.goal?.tokenBudget?.toString() ?? "");
    } else {
      setThread(null);
    }
  }

  async function perform(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void perform(() => refreshThreads(null));
    return subscribeDesktopApprovals(setApprovals);
  }, []);

  async function createThread(): Promise<void> {
    const client = await desktopAppServerClient();
    const handle = await client.startThread({
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      modelProvider: provider.trim(),
      model: model.trim(),
      threadSource: "desktop"
    });
    await refreshThreads(handle.id);
  }

  async function selectThread(id: string): Promise<void> {
    const client = await desktopAppServerClient();
    const detail = await client.call("thread/read", { threadId: id, includeTurns: true });
    setSelectedId(id);
    setThread(detail.thread);
    setCwd(detail.thread.cwd);
    setProvider(detail.thread.muniu.providerId);
    setModel(detail.thread.muniu.modelId);
  }

  async function runTurn(): Promise<void> {
    if (!selectedId || !prompt.trim()) throw new Error("请选择线程并输入消息");
    const client = await desktopAppServerClient();
    const handle = await client.resumeThread({ threadId: selectedId });
    const input: UserInput[] = [{ type: "text", text: prompt.trim() }];
    if (contextPath.trim()) input.push({ type: "mention", name: "context", path: contextPath.trim() });
    if (attachment) input.push({ type: "image", url: attachment.url, detail: "auto" });
    const streamed = await handle.runStreamed({
      input,
      ...(outputSchema.trim() ? { outputSchema: parseOutputSchema(outputSchema) } : {})
    });
    setPrompt("");
    setAttachment(null);
    setActiveTurnId(streamed.turn.status === "inProgress" ? streamed.turn.id : null);
    setThread(await handle.read());
    for await (const event of streamed.events) {
      if (event.method === "item/completed" || event.method === "turn/completed") {
        setThread(await handle.read());
      }
    }
    setActiveTurnId(null);
    await refreshThreads(selectedId);
  }

  async function interrupt(): Promise<void> {
    if (!selectedId || !activeTurnId) return;
    const client = await desktopAppServerClient();
    const handle = await client.resumeThread({ threadId: selectedId });
    await handle.interrupt(activeTurnId);
    setActiveTurnId(null);
    await refreshThreads(selectedId);
  }

  async function saveGoal(): Promise<void> {
    if (!selectedId || !goal.trim()) throw new Error("目标不能为空");
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : undefined;
    if (parsedBudget !== undefined && (!Number.isSafeInteger(parsedBudget) || parsedBudget < 1)) {
      throw new Error("Token 预算必须为正整数");
    }
    const client = await desktopAppServerClient();
    const handle = await client.resumeThread({ threadId: selectedId });
    await handle.setGoal({ objective: goal.trim(), status: "active", tokenBudget: parsedBudget });
    setThread(await handle.read());
  }

  async function exportEvidence(): Promise<void> {
    if (!thread || evidence.length === 0) throw new Error("没有可导出的证据检查点");
    const filename = `muniu-thread-${thread.id}-evidence.json`;
    const payload = `${JSON.stringify({
      schemaVersion: 1,
      kind: "muniu-thread-evidence-export",
      threadId: thread.id,
      evidence: evidence.map(({ turnId, item }) => {
        if (item.type !== "evidenceCheckpoint") throw new Error("证据投影类型无效");
        return {
          turnId,
          itemId: item.id,
          evidenceId: item.evidenceId,
          digest: item.digest,
          status: item.status
        };
      })
    }, null, 2)}\n`;
    if (isTauri()) {
      const target = await showSaveDialog({
        defaultPath: filename,
        filters: [{ name: "JSON", extensions: ["json"] }]
      });
      if (target) await writeTauriFile(target, new TextEncoder().encode(payload));
      return;
    }
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return (
    <section className="panel thread-workspace" id="threads" aria-label="Agent 线程工作区">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">App-server v2</p>
          <h3>Agent 线程</h3>
        </div>
        <div className="panel-actions">
          <button className="text-button" type="button" disabled={busy} onClick={() => void perform(() => refreshThreads())}>刷新</button>
          <button className="text-button primary" type="button" disabled={busy} onClick={() => void perform(createThread)}>新建线程</button>
        </div>
      </div>

      {error ? <div className="thread-error" role="alert">{error}</div> : null}
      <div className="thread-create-grid">
        <label className="form-field"><span>Provider</span><input value={provider} onChange={(event) => setProvider(event.target.value)} /></label>
        <label className="form-field"><span>Model</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <label className="form-field"><span>工作目录</span><input value={cwd} onChange={(event) => setCwd(event.target.value)} /></label>
      </div>

      <div className="thread-layout">
        <aside className="thread-list" aria-label="线程列表">
          {threads.length === 0 ? <p className="thread-empty">暂无线程</p> : threads.map((item) => (
            <button
              className={item.id === selectedId ? "thread-list-item selected" : "thread-list-item"}
              type="button"
              key={item.id}
              onClick={() => void perform(() => selectThread(item.id))}
            >
              <strong>{item.name ?? (item.preview || "未命名线程")}</strong>
              <span>{item.muniu.providerId} / {item.muniu.modelId}</span>
              <small>{item.status.type} · {item.turns.length} turns</small>
            </button>
          ))}
        </aside>

        <div className="thread-main">
          <div className="thread-goal-row">
            <label className="form-field"><span>目标</span><input value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
            <label className="form-field"><span>Token 预算</span><input inputMode="numeric" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} /></label>
            <button className="text-button" type="button" disabled={busy || !selectedId} onClick={() => void perform(saveGoal)}>保存目标</button>
          </div>

          <div className="thread-timeline" aria-live="polite">
            {items.length === 0 ? <p className="thread-empty">选择线程后，消息、计划、命令、补丁与工具调用会显示在这里。</p> : items.map(({ turnId, item }) => (
              <article className={`thread-item thread-item-${item.type}`} key={`${turnId}:${item.id}`}>
                <header><strong>{item.type}</strong><code>{turnId}</code></header>
                <pre>{itemSummary(item)}</pre>
              </article>
            ))}
          </div>

          <div className="thread-composer">
            <textarea rows={4} value={prompt} placeholder="向当前线程发送消息" onChange={(event) => setPrompt(event.target.value)} />
            <div className="thread-context-grid">
              <label className="form-field"><span>上下文路径</span><input value={contextPath} onChange={(event) => setContextPath(event.target.value)} placeholder="可选文件或目录" /></label>
              <label className="form-field"><span>图像附件</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) {
                  setAttachment(null);
                  return;
                }
                void perform(async () => setAttachment({ name: file.name, url: await readImageDataUrl(file) }));
              }} /></label>
              <div className="form-field"><span>已选附件</span><output>{attachment?.name ?? "无"}</output></div>
            </div>
            <label className="form-field"><span>结构化输出 JSON Schema</span><textarea rows={3} value={outputSchema} onChange={(event) => setOutputSchema(event.target.value)} placeholder="可选" /></label>
            <div className="panel-actions">
              <button className="text-button danger" type="button" disabled={!activeTurnId} onClick={() => void perform(interrupt)}>中断</button>
              <button className="text-button primary" type="button" disabled={busy || !selectedId || !prompt.trim()} onClick={() => void perform(runTurn)}>发送</button>
            </div>
          </div>
        </div>

        <aside className="thread-inspector">
          <ThreadInspector title="待审批" empty="没有待审批请求">
            {approvals.map((approval) => (
              <div className="thread-inspector-item" key={approval.id}>
                <strong>{approval.method}</strong><code>{approval.id}</code>
                <div className="thread-approval-actions">
                  <button className="text-button danger" type="button" onClick={() => decideDesktopApproval(approval.id, false)}>拒绝</button>
                  <button className="text-button primary" type="button" onClick={() => decideDesktopApproval(approval.id, true)}>批准一次</button>
                </div>
              </div>
            ))}
          </ThreadInspector>
          <ThreadInspector title="计划 / 差异 / 终端" empty="暂无执行细节">
            {[...plans, ...changes, ...commands].map(({ turnId, item }) => <pre key={`${turnId}:${item.id}`}>{itemSummary(item)}</pre>)}
          </ThreadInspector>
          <ThreadInspector title="子 Agent 图" empty="暂无子 Agent">
            {subAgents.map(({ item }) => <div className="thread-graph-node" key={item.id}>{thread?.id} → {itemSummary(item)}</div>)}
          </ThreadInspector>
          <ThreadInspector
            title="证据"
            empty="暂无证据检查点"
            action={<button className="text-button" type="button" disabled={evidence.length === 0} onClick={() => void perform(exportEvidence)}>导出证据</button>}
          >
            {evidence.map(({ item }) => <pre key={item.id}>{itemSummary(item)}</pre>)}
          </ThreadInspector>
        </aside>
      </div>
    </section>
  );
}

function ThreadInspector({ title, empty, action, children }: { title: string; empty: string; action?: ReactNode; children: ReactNode }) {
  const content = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section className="thread-inspector-section">
    <header className="thread-inspector-heading"><h4>{title}</h4>{action}</header>
    {content ? children : <p>{empty}</p>}
  </section>;
}
