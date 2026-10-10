// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentSchedulingRequestV2, BusinessContextTargetV2, GoalResponseV2, GoalTeamDetailV2, GoalTeamProgressV2, TeamTemplateIdV1, TeamTemplateSummaryV1, GoalStatusV2, GoalV2, ModelConnectionV2, Thread } from "@mn/contracts";
import { GoalDetailViews, type GoalDetailView } from "../components/GoalDetailViews";
import { GoalPlanView, formatTeamCost } from "../components/GoalPlanView";
import { GoalProgressView } from "../components/GoalProgressView";
import { TeamSelector } from "../components/TeamSelector";
import { AgentOsApiError, type AgentOsClient } from "../api";
import { ResultText } from "../components/ResultText";
import { TaskComposer } from "../components/TaskComposer";
import { GoalSources } from "../components/GoalSources";
import { ThreadAgentPanel } from "../components/ThreadAgentPanel";
import type { CodingRepositorySummary } from "../types";
import { EmptyState, ErrorState, Loading } from "../components/Status";

import { SchedulingControls, SchedulingDecision, ExternalUsageForm } from "../components/AgentScheduling";

type PendingGoalMutation = { goalId: string; uncertain: boolean; work: () => Promise<GoalResponseV2> };

const labels: Record<GoalStatusV2, string> = { draft: "草稿", awaiting_authorization: "待确认计划", running: "执行中", waiting_approval: "等待审批", pausing: "正在暂停", paused: "已暂停",
  needs_reconciliation: "待核对", failed: "未完成", awaiting_acceptance: "待验收", accepted: "已验收", cancelled: "已取消" };

export function GoalsPage({ target, api, workspaceId, onOpenThread, pluginIds, repositories, repositoryId, onRepository, onRegisterRepository, onSettings, newTaskRequest, active, onTaskCreated, businessTarget }: {
  readonly target?: { readonly id: string; readonly sequence: number };
  readonly api: AgentOsClient; readonly workspaceId: string; readonly onOpenThread: (thread: Thread) => void;
  readonly businessTarget?: BusinessContextTargetV2 & { readonly sequence: number };
  readonly active: boolean; readonly onTaskCreated: () => void;
  readonly pluginIds: readonly string[]; readonly repositories: readonly CodingRepositorySummary[]; readonly repositoryId?: string;
  readonly onRepository: (id: string) => void; readonly onRegisterRepository: () => void; readonly onSettings: () => void; readonly newTaskRequest: number;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const [existing, setExisting] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [goals, setGoals] = useState<readonly GoalV2[]>([]);
  const [threads, setThreads] = useState<readonly Thread[]>([]);
  const [models, setModels] = useState<readonly ModelConnectionV2[]>([]);
  const [detail, setDetail] = useState<GoalResponseV2>();
  const [view, setView] = useState<GoalDetailView>("goal");
  const [teamTemplates, setTeamTemplates] = useState<readonly TeamTemplateSummaryV1[]>([]);
  const [teamTemplateId, setTeamTemplateId] = useState<TeamTemplateIdV1 | null>(null);
  const [teamModelId, setTeamModelId] = useState("");
  const [teamProgress, setTeamProgress] = useState<GoalTeamProgressV2>();
  const progressSequence = useRef(0);
  const [pendingMutations, setPendingMutations] = useState<ReadonlyMap<string, PendingGoalMutation>>(new Map());
  const pendingMutation = detail ? pendingMutations.get(detail.goal.id) : undefined;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [threadId, setThreadId] = useState("");
  const [selection, setSelection] = useState<AgentSchedulingRequestV2>({ runnerId: "auto", strategy: "quality" });
  const [currency, setCurrency] = useState("CNY");
  const [tokens, setTokens] = useState("100000");
  const [cost, setCost] = useState("5000");
  const teamDetail = detail && isTeamGoalDetail(detail) ? detail : undefined;
  const progress = teamDetail && teamProgress?.goalId === teamDetail.goal.id && teamProgress.planRevisionId === teamDetail.plan.id ? teamProgress : undefined;
  const singleDetail = detail && !isTeamGoalDetail(detail) ? detail : undefined;
  const mutationLocked = pendingMutation?.goalId === detail?.goal.id;
  const teamModels = models.filter(model => model.billingCurrency === detail?.goal.budget.currency);
  const teamModel = teamModels.find(model => model.id === teamModelId) ?? teamModels[0];
  const canPlan = Boolean(detail && ["draft", "awaiting_authorization"].includes(detail.goal.status) && !teamDetail?.runId && !singleDetail?.goal.executionRef);
  const [duration, setDuration] = useState("60");
  const navigationSequence = useRef(0);
  function startNewTask() { navigationSequence.current += 1; setDetail(undefined); setExisting(false); setError(undefined); }
  useEffect(() => { navigationSequence.current += 1; setDetail(undefined); setExisting(false); setError(undefined); }, [newTaskRequest]);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const readEpochs = useRef(new Map<string, number>());
  const listRequestSequence = useRef(0);
  const selectedGoalId = useRef<string | undefined>(undefined);
  selectedGoalId.current = detail?.goal.id;
  const refreshGoals = useCallback(async () => {
    const sequence = ++listRequestSequence.current;
    try {
      const next = await api.goals(workspaceId);
      if (sequence === listRequestSequence.current) setGoals(next);
    } catch (caught) {
      if (sequence !== listRequestSequence.current) return;
      setGoals([]); setError(message(caught)); progressSequence.current += 1; setTeamProgress(undefined);
      const goalId = selectedGoalId.current;
      if (goalId) {
        readEpochs.current.set(goalId, (readEpochs.current.get(goalId) ?? 0) + 1);
        setDetail(previous => previous?.goal.id === goalId ? { ...previous, deliverySet: null } : previous);
        setReviewed(new Set());
      }
    }
  }, [api, workspaceId]);
  const refreshList = useCallback(async () => {
    const [, nextThreads, nextModels] = await Promise.all([refreshGoals(), api.threads(workspaceId), api.modelConnections()]);
    setThreads(nextThreads.filter(thread => ["opc", "coding"].includes(thread.pluginId)));
    setModels(nextModels.filter(model => model.status === "ready"));
  }, [api, workspaceId, refreshGoals]);
  useEffect(() => { let active = true;
    void refreshList().catch(caught => { if (active) setError(message(caught)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshList]);
  useEffect(() => { let current = true; void api.teamTemplates(workspaceId).then(next => { if (current) setTeamTemplates(next); }).catch(() => { if (current) setTeamTemplates([]); }); return () => { current = false; }; }, [api, workspaceId]);
  useEffect(() => { setView(!detail || detail.goal.status === "draft" ? "goal" : detail.goal.status === "awaiting_authorization" ? "plan" : ["awaiting_acceptance", "accepted"].includes(detail.goal.status) ? "results" : "progress"); }, [detail?.goal.id, detail?.goal.status]);
  useEffect(() => {
    const request = ++progressSequence.current;
    setTeamProgress(undefined);
    if (!detail || !isTeamGoalDetail(detail)) return;
    const goalId = detail.goal.id, planId = detail.plan.id;
    void api.goalNodes(workspaceId, goalId).then(next => {
      if (request === progressSequence.current && next.goalId === goalId && next.planRevisionId === planId) setTeamProgress(next);
    }).catch(caught => { if (request === progressSequence.current) setError(message(caught)); });
    return () => { progressSequence.current += 1; };
  }, [api, workspaceId, detail]);
  useEffect(() => { pageRef.current?.closest(".page-scroll")?.scrollTo({ top: 0 }); }, [detail?.goal.id]);
  useEffect(() => {
    setSelection(singleDetail?.plan?.scheduling?.request ?? (singleDetail?.plan ? { runnerId: singleDetail.plan.runnerId, strategy: "quality", modelBindingId: singleDetail.plan.modelBindingId } : { runnerId: "auto", strategy: "quality" }));
    setTeamTemplateId(teamDetail?.plan.template.id ?? null);
    const agent = teamDetail?.plan.nodes.find(node => node.kind === "agent");
    setTeamModelId(agent?.kind === "agent" ? agent.executor.modelBindingId : "");
  }, [detail?.goal.id, detail?.plan?.id]);
  useEffect(() => { setReviewed(new Set()); }, [detail?.goal.id, detail?.deliverySet?.digest]);
  useEffect(() => {
    const goalId = detail?.goal.id;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = api.watchWorkspaceEvents(workspaceId, () => {
      progressSequence.current += 1; setTeamProgress(undefined);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refreshGoals();
        if (!goalId) return;
        const epoch = readEpochs.current.get(goalId) ?? 0;
        void api.goal(workspaceId, goalId).then(next => {
          if (active && epoch === (readEpochs.current.get(goalId) ?? 0)) setDetail(previous => previous?.goal.id === goalId && previous.goal.streamVersion <= next.goal.streamVersion ? next : previous);
        }).catch(caught => {
          if (!active) return;
          readEpochs.current.set(goalId, (readEpochs.current.get(goalId) ?? 0) + 1);
          setDetail(previous => previous?.goal.id === goalId ? { ...previous, deliverySet: null } : previous);
          setReviewed(new Set()); setError(message(caught));
        });
      }, 150);
    });
    return () => { active = false; stop(); if (timer) clearTimeout(timer); };
  }, [api, workspaceId, detail?.goal.id, refreshGoals]);
  useEffect(() => {
    if (!target) return;
    let current = true;
    const sequence = ++navigationSequence.current;
    setDetail(undefined); setReviewed(new Set()); setError(undefined);
    void api.goal(workspaceId, target.id).then(next => { if (current && sequence === navigationSequence.current) setDetail(next); })
      .catch(caught => { if (current && sequence === navigationSequence.current) setError(message(caught)); });
    return () => { current = false; };
  }, [api, workspaceId, target]);
  const selectedThreadId = threads.find(thread => thread.id === threadId)?.id ?? threads[0]?.id ?? "";
  const planDirty = teamDetail ? teamTemplateId !== teamDetail.plan.template.id || teamDetail.plan.nodes.some(node => node.kind === "agent" && node.executor.modelBindingId !== teamModel?.id)
    : Boolean(detail?.plan && (teamTemplateId || JSON.stringify(selection) !== JSON.stringify(singleDetail?.plan?.scheduling?.request ?? { runnerId: singleDetail?.plan?.runnerId, strategy: "quality", modelBindingId: singleDetail?.plan?.modelBindingId })));
  const selectedTemplate = teamTemplates.find(template => template.id === teamTemplateId);
  const planReady = !teamTemplateId || Boolean(selectedTemplate?.available && selectedTemplate.pluginId === (detail?.plan?.pluginId ?? threads.find(item => item.id === detail?.goal.threadId)?.pluginId) && teamModel);
  async function mutate(work: (key: string) => Promise<GoalResponseV2>) {
    if (busy || pendingMutation || !detail) return;
    const key = crypto.randomUUID();
    const pending = { goalId: detail.goal.id, uncertain: false, work: () => work(key) };
    setPendingMutations(previous => new Map(previous).set(pending.goalId, pending)); await retryMutation(pending);
  }
  async function retryMutation(pending: PendingGoalMutation) {
    const clear = () => setPendingMutations(previous => { const next = new Map(previous); next.delete(pending.goalId); return next; });
    await perform(async () => {
      try { const next = await pending.work(); clear(); return next; }
      catch (caught) { if (!pending.uncertain && caught instanceof AgentOsApiError && caught.status < 500) clear(); else pending.uncertain = true; throw caught; }
    }, pending.goalId);
  }
  async function perform(work: () => Promise<GoalResponseV2>, goalId = detail?.goal.id) {
    if (busy) return;
    const sequence = ++navigationSequence.current;
    const epoch = goalId ? readEpochs.current.get(goalId) ?? 0 : undefined;
    setBusy(true); setError(undefined);
    try {
      const next = await work();
      if (sequence !== navigationSequence.current) return;
      if (goalId && epoch !== (readEpochs.current.get(goalId) ?? 0)) return;
      setError(undefined);
      setDetail(previous => previous?.goal.id === next.goal.id && previous.goal.streamVersion > next.goal.streamVersion ? previous : next);
      await refreshList();
    } catch (caught) {
      if (sequence !== navigationSequence.current) return;
      if (caught instanceof AgentOsApiError && (caught.status === 403 || caught.status === 404 || /RESOURCE|ACCESS|AUTHORIZATION/u.test(caught.detail.code))) {
        if (goalId) readEpochs.current.set(goalId, (readEpochs.current.get(goalId) ?? 0) + 1);
        progressSequence.current += 1; setTeamProgress(undefined);
        setDetail(previous => previous && previous.goal.id === goalId ? { ...previous, deliverySet: null } : previous); setReviewed(new Set());
      }
      setError(message(caught));
    } finally { setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    const descriptions = criteria.split("\n").map(value => value.trim()).filter(Boolean);
    if (!objective.trim() || !descriptions.length || !selectedThreadId) return;
    await perform(() => api.createGoal(workspaceId, { threadId: selectedThreadId, objective: objective.trim(), resourceRefs: [],
      budget: { maxTokens: Number(tokens), maxCostMinorUnits: cost, currency, maxDurationMs: Number(duration) * 60_000 },
      deliverables: [{ key: "result", title: "任务成果", required: true, criteria: descriptions.map((description, index) => ({ id: `criterion-${index + 1}`, description })) }],
    }));
  }
  const required = detail?.goal.deliverables.filter(item => item.required) ?? [];
  const acceptanceReady = Boolean(detail?.deliverySet && required.length && required.every(spec => {
    const output = detail.deliverySet!.items.find(item => item.key === spec.key);
    return output && output.checks.length > 0 && output.checks.every(check => check.status === "passed")
      && spec.criteria.every(criterion => reviewed.has(JSON.stringify([spec.key, criterion.id])));
  }));
  const thread = threads.find(item => item.id === detail?.goal.threadId);
  return <div ref={pageRef} className="page-stack goals-page">
    <header className="goal-heading"><div><h1>任务</h1><p>经营与研发在这里委派、跟进和验收。</p></div>
      <button className={!detail || ["accepted", "cancelled", "failed"].includes(detail.goal.status) ? "primary-button" : "secondary-button"} disabled={busy} onClick={startNewTask}>新建任务</button></header>
    {error && <ErrorState detail={error} onRetry={() => detail ? void perform(() => api.goal(workspaceId, detail.goal.id)) : void refreshList().then(() => setError(undefined)).catch(caught => setError(message(caught)))} />}
    {loading ? <Loading label="正在读取目标…" /> : <div className="goal-layout">
      <section className="panel goal-list" aria-label="目标列表"><h2>工作区任务</h2><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="筛选任务状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="active">进行中</option><option value="awaiting_acceptance">待验收</option><option value="accepted">已验收</option></select>
        {goals.length === 0 ? <EmptyState title="还没有任务" detail="描述想要的结果，或从模板开始。" /> : goals.filter(goal => goal.objective.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "active" ? ["draft", "awaiting_authorization", "running", "waiting_approval", "pausing", "paused"].includes(goal.status) : goal.status === filter))).map(goal =>
          <button key={goal.id} className={`goal-list-item ${detail?.goal.id === goal.id ? "selected" : ""}`} disabled={busy} onClick={() => void perform(() => api.goal(workspaceId, goal.id), goal.id)}>
            <strong>{goal.objective.split("\n")[0]}</strong><small>{goal.id === detail?.goal.id ? "当前目标" : labels[goal.status]}</small></button>)}
      </section>
      <section className="panel task-compose-panel" hidden={Boolean(detail)}><div hidden={existing}><TaskComposer businessTarget={businessTarget} visible={active && !detail && !existing} api={api} workspaceId={workspaceId} pluginIds={pluginIds} repositories={repositories} repositoryId={repositoryId} onRepository={onRepository} onRegisterRepository={onRegisterRepository} onSettings={onSettings} onCreated={next => { navigationSequence.current += 1; setDetail(next); setError(undefined); void refreshList(); onTaskCreated(); }} /></div>
        <button className="quiet-button existing-task-toggle" onClick={() => setExisting(value => !value)}>{existing ? "返回新任务" : "关联已有任务"}</button>
        {existing && <form className="form-stack" onSubmit={event => void create(event)}><h2>创建目标</h2>
        <div className="field"><label htmlFor="goal-objective">预期结果</label><textarea id="goal-objective" rows={3} value={objective} required maxLength={16000} disabled={busy} onChange={event => setObjective(event.target.value)} /></div>
        <div className="field"><label htmlFor="goal-thread">关联任务</label><select id="goal-thread" value={selectedThreadId} disabled={busy || !threads.length} onChange={event => setThreadId(event.target.value)}>
          {!threads.length && <option value="">先在 OPC 或 Coding 中创建任务</option>}{threads.map(item => <option key={item.id} value={item.id}>{item.pluginId === "coding" ? "Coding" : "OPC"} · {item.subject}</option>)}</select></div>
        <div className="field"><label htmlFor="goal-criteria">验收标准（每行一项）</label><textarea id="goal-criteria" rows={4} value={criteria} required disabled={busy} onChange={event => setCriteria(event.target.value)} /></div>
        <fieldset className="goal-budget"><legend>执行额度</legend>
          <div className="field"><label htmlFor="goal-currency">币种</label><select id="goal-currency" value={currency} disabled={busy} onChange={event => setCurrency(event.target.value)}><option>CNY</option><option>USD</option></select></div>
          <div className="field"><label htmlFor="goal-cost">金额上限（分）</label><input id="goal-cost" type="number" min="1" step="1" value={cost} required disabled={busy} onChange={event => setCost(event.target.value)} /></div>
          <div className="field"><label htmlFor="goal-tokens">Token 上限</label><input id="goal-tokens" type="number" min="1" step="1" value={tokens} required disabled={busy} onChange={event => setTokens(event.target.value)} /></div>
          <div className="field"><label htmlFor="goal-duration">时限（分钟）</label><input id="goal-duration" type="number" min="1" step="1" value={duration} required disabled={busy} onChange={event => setDuration(event.target.value)} /></div>
        </fieldset><button className="primary-button" disabled={busy || !selectedThreadId || !objective.trim() || !criteria.trim()}>{busy ? "正在保存…" : "创建目标"}</button>
      </form>}</section>{detail && <section className="panel goal-detail" aria-label="目标详情">
        <div className="goal-heading"><h2>{detail.goal.objective.split("\n")[0]}</h2><span className="pill" role="status">{labels[detail.goal.status]}</span></div>
        <ol className="task-lifecycle" aria-label="任务阶段">{["委派说明", "审阅计划", "执行与调整", "成果验收"].map((label, index) => <li key={label} className={(detail.goal.status === "draft" ? 0 : detail.goal.status === "awaiting_authorization" ? 1 : ["awaiting_acceptance", "accepted"].includes(detail.goal.status) ? 3 : 2) === index ? "current" : ""}>{index + 1}. {label}</li>)}</ol>
        {mutationLocked && !busy && <div role="alert"><p>上次操作的结果尚未确认，请使用原请求继续核对。</p><button className="secondary-button" onClick={() => void retryMutation(pendingMutation!)}>重试上次操作</button></div>}
        <GoalDetailViews value={view} onChange={setView} panels={{
          goal: <>
        <h3>任务与约束</h3><pre className="goal-brief-preview">{detail.goal.objective}</pre>
        <GoalSources key={detail.goal.id} api={api} workspaceId={workspaceId} resourceRefs={detail.goal.resourceRefs} />
        {detail.goal.reasonCode && <p className="inline-error">{reason(detail.goal.reasonCode)}</p>}
        <p>额度：{formatTeamCost(detail.goal.budget.maxCostMinorUnits, detail.goal.budget.currency)} · {detail.goal.budget.maxTokens} tokens · {detail.goal.budget.maxDurationMs / 60_000} 分钟</p>
        {detail.goal.reservation && <p>用量：{detail.goal.reservation.status === "settled" ? `${detail.goal.reservation.actual?.costMinorUnits ?? "0"} 分 ${detail.goal.budget.currency}，${detail.goal.reservation.actual?.tokens ?? 0} tokens` : detail.goal.reservation.status === "unknown" ? "待核对，额度继续保留" : "已预留"}</p>}
        <h3>验收标准</h3>{detail.goal.deliverables.map(spec => <div key={spec.key}><strong>{spec.title}{spec.required ? "（必需）" : "（可选）"}</strong><ul>{spec.criteria.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul></div>)}
          </>,
          plan: <>
            {canPlan && <>
              <TeamSelector value={teamTemplateId} onChange={setTeamTemplateId} disabled={busy || mutationLocked} templates={teamTemplates.map(template => ({ ...template,
                available: template.available && template.pluginId === (detail.plan?.pluginId ?? thread?.pluginId),
                unavailableReason: template.pluginId !== (detail.plan?.pluginId ?? thread?.pluginId) ? "该模板不适用于当前业务对象" : template.unavailableReason }))} />
              {teamTemplateId ? <label className="field">团队执行模型<select aria-label="团队执行模型" value={teamModel?.id ?? ""} disabled={busy || mutationLocked} onChange={event => setTeamModelId(event.target.value)}>
                {!teamModels.length && <option value="">请连接同币种的已计价模型</option>}{teamModels.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
              </select></label> : <SchedulingControls value={selection} onChange={setSelection} models={models} disabled={busy || mutationLocked} currency={detail.goal.budget.currency} onSettings={onSettings} />}
            </>}
            {planDirty && canPlan && <p className="inline-error">调度选择已变更，请重新生成计划后确认。</p>}
            {detail.plan ? <><GoalPlanView plan={detail.plan} onOpenSource={() => setView("goal")} />
              {singleDetail?.plan?.scheduling && <SchedulingDecision decision={singleDetail.plan.scheduling} />}
              {singleDetail?.plan && <details><summary>计划权限与版本</summary><dl><dt>计划版本</dt><dd>{singleDetail.plan.revision}</dd><dt>工具</dt><dd>{singleDetail.plan.toolIds.join("、") || "无"}</dd><dt>数据范围</dt><dd>{singleDetail.plan.dataScopes.map(scope => `${scope.namespace}: ${scope.resourceId}`).join("、")}</dd><dt>计划摘要</dt><dd>{singleDetail.plan.digest}</dd></dl></details>}
            </> : <p>尚未生成计划，请选择执行方式后生成。</p>}
          </>,
          progress: <>
            {teamDetail ? progress ? <>
              <p>总执行额度：{formatTeamCost(detail.goal.budget.maxCostMinorUnits, detail.goal.budget.currency)} · {detail.goal.budget.maxTokens} tokens</p>
              {detail.goal.reservation?.status === "reserved" && <p>执行额度已预留，实际用量待结算。</p>}
              <GoalProgressView nodes={progress.nodes} costs={detail.goal.reservation?.status === "unknown" ? [{ currency: detail.goal.budget.currency, costMinorUnits: null }]
                : detail.goal.reservation?.actual ? [{ currency: detail.goal.reservation.actual.currency, costMinorUnits: detail.goal.reservation.actual.costMinorUnits }] : undefined} allowedActions={progress.allowedActions.filter(action => action !== "start")} busy={busy || mutationLocked}
                onAction={action => { if (action === "decide") document.getElementById(`decisions-${detail.goal.id}`)?.focus(); else void mutate(key => api.commandGoal(detail, action, key)); }} />
              {progress.allowedActions.includes("decide") && <section id={`decisions-${detail.goal.id}`} tabIndex={-1} aria-label="待决定事项">
                {teamDetail.plan.nodes.filter(node => node.kind === "human_decision" && progress.nodes.some(progress => progress.nodeId === node.id && progress.status === "awaiting_decision")).map(node => node.kind === "human_decision" && <article key={node.id}><h3>{node.title}</h3><p>{node.prompt}</p>
                  <button className="primary-button" disabled={busy || mutationLocked} onClick={() => void mutate(key => api.decideGoal(detail, node.id, "continue", key))}>确认并继续</button>
                  <button className="secondary-button" disabled={busy || mutationLocked} onClick={() => void mutate(key => api.decideGoal(detail, node.id, "stop", key))}>停止此计划</button></article>)}
              </section>}
            </> : <p role="status">正在核对团队进展与可用操作…</p> : singleDetail?.goal.executionRef && thread ? <ThreadAgentPanel key={detail.goal.id} api={api} workspaceId={workspaceId} pluginId={thread.pluginId as "opc" | "coding"} threadId={thread.id} resourceId={thread.resourceRef?.resourceId} goalExecution={{ executionId: singleDetail.goal.executionRef.executionId, canControl: ["running", "waiting_approval"].includes(detail.goal.status), onCancel: () => perform(() => api.commandGoal(detail, "cancel")) }} /> : <p>计划确认后开始执行。</p>}
            {singleDetail?.plan?.runnerId !== "builtin" && singleDetail?.goal.reasonCode === "GOAL_USAGE_UNKNOWN" && <ExternalUsageForm key={detail.goal.id} detail={singleDetail} disabled={busy} onSave={(usage, source) => void perform(() => api.recordExternalUsage(singleDetail, usage, source))} />}
          </>,
          results: <>
        {detail.deliverySet ? <section aria-label="成果验收"><h3>成果与检查</h3><p>先查看任务成果，再确认各项内容标准。程序检查不代替内容判断。</p>
          {detail.deliverySet.items.map(output => { const spec = detail.goal.deliverables.find(item => item.key === output.key); return <article className="goal-output" key={output.key}><strong>{spec?.title ?? output.key}</strong>
            <ResultText text={output.preview} /><a className="quiet-button" download="木牛任务成果.md" href={`data:text/markdown;charset=utf-8,${encodeURIComponent(output.preview)}`}>下载成果</a>
            <ul>{output.checks.map(check => <li key={check.checkId}>{check.status === "passed" ? "通过" : "未通过"} · {checkLabel(check.checkId)}</li>)}</ul>
            {spec?.criteria.map(criterion => { const key = JSON.stringify([output.key, criterion.id]); return <label className="goal-criterion" key={criterion.id}>
              <input type="checkbox" disabled={busy || detail.goal.status !== "awaiting_acceptance"} checked={detail.goal.status === "accepted" || reviewed.has(key)} onChange={event => {
                const checked = event.target.checked; setReviewed(previous => { const next = new Set(previous); if (checked) next.add(key); else next.delete(key); return next; });
              }} />已复核：{criterion.description}</label>; })}
            <details><summary>成果版本与证据</summary><p>{output.resourceRef.namespace} · {output.resourceRef.resourceId}</p><p>摘要：{output.digest}</p><ul>{output.checks.flatMap(check => check.evidenceRefs.map((ref, index) => <li key={`${check.checkId}:${index}`}>{ref.namespace} · {ref.resourceId} · 版本 {ref.streamVersion}</li>))}</ul></details>
          </article>; })}
          {detail.goal.status === "awaiting_acceptance" && <button className="primary-button" disabled={busy || !acceptanceReady} onClick={() => void perform(() => api.acceptGoal(detail,
            detail.deliverySet!.items.map(output => ({ key: output.key, digest: output.digest, reviewedCriterionIds: detail.goal.deliverables.find(spec => spec.key === output.key)!.criteria.filter(criterion => reviewed.has(JSON.stringify([output.key, criterion.id]))).map(criterion => criterion.id) }))))}>接收成果</button>}
        </section> : <p>尚无可验收成果。完成计划后在这里查看成果与检查结果。</p>}
          </>,
        }} />
        <div className="goal-actions">{thread?.resourceRef && <button className="secondary-button" onClick={() => onOpenThread(thread)}>查看业务对象</button>}
          {canPlan && <button className="secondary-button" disabled={busy || mutationLocked || !planReady} onClick={() => void mutate(key => teamTemplateId && teamModel ? api.planTeamGoal(detail, { templateId: teamTemplateId, templateVersion: "1", modelBindingId: teamModel.id }, key) : api.planGoal(detail, selection, key))}>生成计划</button>}
          {detail.goal.status === "awaiting_authorization" && detail.plan && (!teamDetail || progress?.allowedActions.includes("start")) && <button className="primary-button" disabled={busy || mutationLocked || planDirty} onClick={() => void mutate(key => api.commandGoal(detail, "start", key))}>确认计划并启动</button>}
          {singleDetail?.goal.executionRef && <button className="secondary-button" disabled={busy || mutationLocked} onClick={() => void perform(() => api.commandGoal(detail, "refresh"))}>更新执行状态</button>}
          {!teamDetail && !["accepted", "cancelled"].includes(detail.goal.status) && <button className="secondary-button" disabled={busy || mutationLocked} onClick={() => void perform(() => api.commandGoal(detail, "cancel"))}>取消任务</button>}
        </div>
      </section>}
    </div>}
  </div>;
}
function message(error: unknown): string { return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "无法读取或更新目标，请检查 Host 后重试。"; }
function checkLabel(id: string): string {
  if (id === "opc.persisted-response-and-sources") return "答复与来源版本一致";
  if (id === "coding.authoritative-evidence") return "代码候选与检查证据一致";
  return "成果证据检查";
}
function reason(code: string): string {
  if (code.includes("USAGE") || code.includes("BUDGET")) return "费用或用量需要核对，暂不继续派发。";
  if (code.includes("DELIVERY") || code.includes("OUTPUT")) return "成果尚未满足检查要求，请查看关联任务。";
  if (code.includes("AUTH") || code.includes("RESOURCE")) return "权限或资料已变化，请核对关联任务与授权。";
  return "当前目标需要处理，请查看关联任务和收件箱。";
}

function isTeamGoalDetail(value: GoalResponseV2): value is GoalTeamDetailV2 { return value.plan !== null && "kind" in value.plan && value.plan.kind === "team-v1"; }
