// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Clock3, RefreshCw, Send } from "lucide-react";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { AgentThreadSummary, ThreadTurnEntry, ThreadTurnsView } from "../types";
import type { CodingRunnerId } from "@mn/contracts";

interface ThreadAgentPanelProps {
  readonly api: AgentOsClient;
  readonly workspaceId: string;
  readonly pluginId: "opc" | "coding";
  readonly resourceId: string;
  readonly professional?: boolean;
}

const promptSuggestions = [
  "列出当前证据缺口",
  "生成非诱导访谈问题",
  "找出最可能推翻假设的信号",
] as const;

export function ThreadAgentPanel({ api, workspaceId, pluginId, resourceId, professional = false }: ThreadAgentPanelProps) {
  const agentName = pluginId === "opc" ? "OPC Agent" : "Coding Agent";
  const resourceName = pluginId === "opc" ? "机会" : "任务";
  const namespace = pluginId === "opc" ? "opc.opportunity" : "coding.task";
  const titleId = `${pluginId}-agent-title`;
  const messageId = `${pluginId}-agent-message`;
  const [thread, setThread] = useState<AgentThreadSummary>();
  const [conversation, setConversation] = useState<ThreadTurnsView>();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [runnerId, setRunnerId] = useState<CodingRunnerId>("builtin");
  const [availableRunners, setAvailableRunners] = useState<readonly CodingRunnerId[]>(["builtin"]);
  const [runnerError, setRunnerError] = useState<string>();
  const requestSequence = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const loadConversation = useCallback(async (showLoading = false) => {
    const sequence = ++requestSequence.current;
    if (showLoading) setLoading(true);
    try {
      const threads = await api.threads(workspaceId);
      const matched = threads.find((candidate) =>
        candidate.pluginId === pluginId
        && candidate.archivedAt === undefined
        && candidate.resourceRef?.namespace === namespace
        && candidate.resourceRef.resourceId === resourceId);
      if (!matched) throw new Error("THREAD_NOT_FOUND");
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
  }, [api, namespace, pluginId, resourceId, workspaceId]);

  useEffect(() => { setThread(undefined); setConversation(undefined); setMessage(""); void loadConversation(true); }, [loadConversation]);
  useEffect(() => {
    let current = true;
    setRunnerId("builtin"); setAvailableRunners(["builtin"]); setRunnerError(undefined);
    if (pluginId === "coding") void Promise.all([api.codingRunners(workspaceId), api.workspace(workspaceId)])
      .then(([runners, workspace]) => {
        if (current) setAvailableRunners(["builtin", ...runners.filter(runner => runner.status === "confirmed"
          && workspace.activePluginIds.includes(`runner-${runner.runnerId}`)).map(runner => runner.runnerId)]);
      }).catch(() => { if (current) setRunnerError("无法读取外部 Runner 配置；仍可使用内置 Agent。"); });
    return () => { current = false; };
  }, [api, workspaceId, pluginId, resourceId]);
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
    if (!content || !thread || sending || blocked) return;
    setSending(true);
    setError(undefined);
    try {
      const execution = conversation?.turns.at(-1)?.execution;
      if (execution && ["queued", "running", "waiting_approval"].includes(execution.status)) {
        await api.executionCommand(execution, "follow_up", content);
      } else await api.submitTurn(workspaceId, thread, content, pluginId === "coding" ? runnerId : undefined);
      setRunnerId("builtin");
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
  const latestTurn = conversation?.turns.at(-1);
  const metering = latestTurn?.metering;
  const budgetNeedsNewExecution = metering && ["pending", "overrun"].includes(metering.status);
  const blocked = latestExecution && ["paused", "interrupted", "needs_reconciliation"].includes(latestExecution.status);
  const active = latestExecution && ["queued", "running", "waiting_approval"].includes(latestExecution.status);
  async function control(command: "cancel" | "resume" | "steer") {
    if (!latestExecution || sending) return;
    setSending(true);
    try {
      await api.executionCommand(latestExecution, command, command === "steer" ? message.trim() : undefined);
      if (command === "steer") setMessage("");
      await loadConversation();
    } catch (caught) { await loadConversation(); setError(agentErrorMessage(caught)); }
    finally { setSending(false); }
  }

  return <section className="opc-agent-panel" aria-labelledby={titleId}>
    <header>
      <span className="opc-agent-mark"><Bot size={19} /></span>
      <div><p className="eyebrow">{pluginId === "opc" ? "OPC Agent OS" : "Coding Agent OS"}</p><h2 id={titleId}>与 {agentName} 一起推进</h2><p>{pluginId === "opc" ? "Agent 只使用当前机会的上下文，建议需要你审阅。" : "默认由内置 Agent 在隔离副本生成变更，检查通过后仍需人工审批。"}</p></div>
      <button className="icon-button" type="button" title="刷新会话" disabled={loading} onClick={() => void loadConversation(true)}><RefreshCw size={16} /></button>
    </header>

    <div className="opc-agent-transcript" ref={transcriptRef} aria-live="polite">
      {loading && entries.length === 0 && <p className="opc-agent-empty">正在读取{resourceName}会话…</p>}
      {!loading && entries.length === 0 && !error && <div className="opc-agent-empty">
        <strong>从当前阶段开始</strong>
        <p>{pluginId === "opc" ? "可以请 Agent 梳理假设、证据缺口或访谈问题。" : "先描述本轮修改范围。变更不会直接写入源仓库。"}</p>
      </div>}
      {entries.map((entry) => <ConversationEntry key={entry.id} entry={entry} agentName={agentName} />)}
      {latestExecution && latestExecution.status !== "completed" && <p className={`opc-agent-status ${latestExecution.status}`}><Clock3 size={14} />{executionStatus(latestExecution.status)}</p>}
    </div>

    {metering && <aside className="agent-metering" aria-label="执行用量">
      <strong>{metering.status === "external_runner" ? "外部 Runner 用量请在厂商账单核对"
        : metering.status === "not_started" ? "尚无已结算用量"
        : `预估模型费用：${metering.currency} ${formatCost(metering.estimatedCostNanoMinorUnits)}`}</strong>
      {metering.status === "pending" && <p>另有 {metering.pendingRequests} 次请求用量待核对。该请求不会自动重发。</p>}
      {metering.status === "overrun" && <p>实际用量超出预留，后续模型调用已停止。</p>}
      {metering.status !== "external_runner" && <small>费用按参考价格预估，以厂商账单为准；不自动换算币种。</small>}
      {metering.inputCountEstimated && <small>输入量采用保守估算，不保证与厂商分词结果一致。</small>}
      {professional && <details><summary>查看用量与预算</summary><p>已结算 {metering.knownTokens.toLocaleString("zh-CN")} token；上限 {metering.maxTokens.toLocaleString("zh-CN")} token。预估费用上限：{metering.currency} {formatCost((BigInt(metering.maxCostMinorUnits) * 1_000_000_000n).toString())}。</p></details>}
    </aside>}
    {latestExecution?.status === "paused" && latestTurn?.pauseReason && <p className="agent-pause-reason" role="status">{latestTurn.pauseReason}。终止本次执行后，可发送新消息创建全新执行；原有用量记录会保留。</p>}

    {error && <div className="opc-agent-error" role="alert"><span>{error}</span><button type="button" className="quiet-button" onClick={() => void loadConversation(true)}>重试</button></div>}

    {entries.length === 0 && <div className="opc-agent-suggestions" aria-label="建议问题">
      {(pluginId === "opc" ? promptSuggestions : ["按任务要求生成可审阅的变更", "只修改与当前任务相关的文件"]).map((suggestion) => <button type="button" key={suggestion} onClick={() => setMessage(suggestion)}>{suggestion}</button>)}
    </div>}
    <form className="opc-agent-composer" onSubmit={(event) => void submit(event)}>
      {pluginId === "coding" && <div className="runner-choice"><label>本轮执行方式<select aria-label="本轮执行方式" value={active ? latestExecution.runnerId ?? "builtin" : runnerId}
        disabled={Boolean(active || blocked) || sending} onChange={event => setRunnerId(event.target.value as CodingRunnerId)}>
        <option value="builtin">内置 Agent（默认）</option>
        <option value="claude-cli" disabled={!availableRunners.includes("claude-cli")}>Claude CLI</option>
        <option value="codex-cli" disabled={!availableRunners.includes("codex-cli")}>Codex CLI</option>
      </select></label><small>{active ? "补充消息沿用当前执行方式" : "外部 Runner 需先在集成中启用并确认文件"}</small>{runnerError && <p role="alert">{runnerError}</p>}</div>}
      <label htmlFor={messageId}>给 {agentName} 的消息</label>
      <div><textarea id={messageId} rows={2} value={message} disabled={!thread || sending} placeholder={pluginId === "opc" ? "例如：先找出最可能推翻这个假设的证据" : "例如：按任务要求修改，保留现有未提交内容"} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
      }} /><button className="primary-button" type="submit" disabled={!thread || !message.trim() || sending || Boolean(blocked)}><Send size={15} />{sending ? "正在发送" : `发送给 ${agentName}`}</button></div>
      <small>按 Command + Enter 发送</small>
      {latestExecution && <div className="agent-controls">
        {["queued", "running", "waiting_approval"].includes(latestExecution.status) && <>
          <button type="button" className="quiet-button" disabled={sending || !message.trim()} onClick={() => void control("steer")}>调整当前方向</button>
          <button type="button" className="quiet-button" disabled={sending} onClick={() => void control("cancel")}>取消执行</button>
        </>}
        {["paused", "interrupted"].includes(latestExecution.status) && <>
          {!budgetNeedsNewExecution && <button type="button" className="quiet-button" disabled={sending} onClick={() => void control("resume")}>恢复执行</button>}
          <button type="button" className="quiet-button" disabled={sending} onClick={() => void control("cancel")}>终止本次执行</button>
        </>}
      </div>}
    </form>
  </section>;
}

function formatCost(nanoMinorUnits: string): string {
  const minorUnits = (BigInt(nanoMinorUnits) + 999_999_999n) / 1_000_000_000n;
  return `${minorUnits / 100n}.${String(minorUnits % 100n).padStart(2, "0")}`;
}

function ConversationEntry({ entry, agentName }: { readonly entry: ThreadTurnEntry; readonly agentName: string }) {
  if (entry.role === "tool") {
    return <details className="opc-agent-tool"><summary>查看工具结果</summary><p>{entry.content}</p></details>;
  }
  return <article className={`opc-agent-message ${entry.role}`}>
    <strong>{entry.role === "user" ? "你" : agentName}</strong>
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
  if (error instanceof Error && error.message === "THREAD_NOT_FOUND") {
    return "当前对象缺少关联会话。请返回列表后重试。";
  }
  return "无法读取 Agent 会话。请检查连接后重试。";
}
