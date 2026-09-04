// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Clock3, RefreshCw, Send } from "lucide-react";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { AgentThreadSummary, ThreadTurnEntry, ThreadTurnsView } from "../types";

interface OpcAgentPanelProps {
  readonly api: AgentOsClient;
  readonly workspaceId: string;
  readonly opportunityId: string;
}

const promptSuggestions = [
  "列出当前证据缺口",
  "生成非诱导访谈问题",
  "找出最可能推翻假设的信号",
] as const;

export function OpcAgentPanel({ api, workspaceId, opportunityId }: OpcAgentPanelProps) {
  const [thread, setThread] = useState<AgentThreadSummary>();
  const [conversation, setConversation] = useState<ThreadTurnsView>();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const requestSequence = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const loadConversation = useCallback(async (showLoading = false) => {
    const sequence = ++requestSequence.current;
    if (showLoading) setLoading(true);
    try {
      const threads = await api.threads(workspaceId);
      const matched = threads.find((candidate) =>
        candidate.pluginId === "opc"
        && candidate.archivedAt === undefined
        && candidate.resourceRef?.namespace === "opc.opportunity"
        && candidate.resourceRef.resourceId === opportunityId);
      if (!matched) throw new Error("OPC_THREAD_NOT_FOUND");
      const turns = await api.threadTurns(workspaceId, matched.id);
      if (sequence !== requestSequence.current) return;
      setThread(matched);
      setConversation(turns);
      setError(undefined);
    } catch (caught) {
      if (sequence !== requestSequence.current) return;
      setError(agentErrorMessage(caught));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [api, opportunityId, workspaceId]);

  useEffect(() => { void loadConversation(true); }, [loadConversation]);
  useEffect(() => api.watchWorkspaceEvents(workspaceId, () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void loadConversation(), 80);
  }), [api, loadConversation, workspaceId]);
  useEffect(() => () => {
    requestSequence.current += 1;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [conversation]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = message.trim();
    if (!content || !thread || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await api.submitTurn(workspaceId, thread, content);
      setMessage("");
      await loadConversation();
    } catch (caught) {
      if (caught instanceof AgentOsApiError && caught.status === 409) {
        await loadConversation();
        setError("会话已更新。请核对最新内容后重新发送。");
      } else {
        setError(agentErrorMessage(caught));
      }
    } finally {
      setSending(false);
    }
  }

  const entries = conversation?.turns.flatMap((turn) => turn.entries) ?? [];
  const latestExecution = conversation?.turns.at(-1)?.execution;

  return <section className="opc-agent-panel" aria-labelledby="opc-agent-title">
    <header>
      <span className="opc-agent-mark"><Bot size={19} /></span>
      <div><p className="eyebrow">OPC Agent OS</p><h2 id="opc-agent-title">与 OPC Agent 一起推进</h2><p>Agent 只使用当前机会的上下文，建议需要你审阅。</p></div>
      <button className="icon-button" type="button" title="刷新会话" disabled={loading} onClick={() => void loadConversation(true)}><RefreshCw size={16} /></button>
    </header>

    <div className="opc-agent-transcript" ref={transcriptRef} aria-live="polite">
      {loading && entries.length === 0 && <p className="opc-agent-empty">正在读取机会会话…</p>}
      {!loading && entries.length === 0 && !error && <div className="opc-agent-empty">
        <strong>从当前阶段开始</strong>
        <p>可以请 Agent 梳理假设、证据缺口或访谈问题。</p>
      </div>}
      {entries.map((entry) => <ConversationEntry key={entry.id} entry={entry} />)}
      {latestExecution && latestExecution.status !== "completed" && <p className={`opc-agent-status ${latestExecution.status}`}><Clock3 size={14} />{executionStatus(latestExecution.status)}</p>}
    </div>

    {error && <div className="opc-agent-error" role="alert"><span>{error}</span><button type="button" className="quiet-button" onClick={() => void loadConversation(true)}>重试</button></div>}

    {entries.length === 0 && <div className="opc-agent-suggestions" aria-label="建议问题">
      {promptSuggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setMessage(suggestion)}>{suggestion}</button>)}
    </div>}
    <form className="opc-agent-composer" onSubmit={(event) => void submit(event)}>
      <label htmlFor="opc-agent-message">给 OPC Agent 的消息</label>
      <div><textarea id="opc-agent-message" rows={2} value={message} disabled={!thread || sending} placeholder="例如：先找出最可能推翻这个假设的证据" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
      }} /><button className="primary-button" type="submit" disabled={!thread || !message.trim() || sending}><Send size={15} />{sending ? "正在发送" : "发送给 OPC Agent"}</button></div>
      <small>按 Command + Enter 发送</small>
    </form>
  </section>;
}

function ConversationEntry({ entry }: { readonly entry: ThreadTurnEntry }) {
  if (entry.role === "tool") {
    return <details className="opc-agent-tool"><summary>查看工具结果</summary><p>{entry.content}</p></details>;
  }
  return <article className={`opc-agent-message ${entry.role}`}>
    <strong>{entry.role === "user" ? "你" : "OPC Agent"}</strong>
    <p>{entry.content}</p>
  </article>;
}

function executionStatus(status: string): string {
  return ({
    queued: "已提交，等待执行",
    running: "Agent 正在整理",
    waiting_approval: "需要你在收件箱审批",
    paused: "执行已暂停",
    interrupted: "执行已中断，可以在收件箱恢复",
    needs_reconciliation: "结果需要人工核对",
    failed: "执行失败，请查看收件箱",
    cancelled: "执行已取消",
  } as Record<string, string>)[status] ?? status;
}

function agentErrorMessage(error: unknown): string {
  if (error instanceof AgentOsApiError) return `${error.detail.message}。${error.detail.action}`;
  if (error instanceof Error && error.message === "OPC_THREAD_NOT_FOUND") {
    return "当前机会缺少关联会话。请返回机会列表后重试。";
  }
  return "无法读取 OPC Agent 会话。请检查 Host 后重试。";
}
