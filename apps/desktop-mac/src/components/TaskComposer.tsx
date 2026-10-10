// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, BriefcaseBusiness, Code2, FileText, Paperclip, Plus, X } from "lucide-react";
import type { AgentSchedulingRequestV2, Asset, BusinessContextTargetV2, BusinessObjectContextV2, GoalDetailV2, GoalResourceRefV2, GoalResponseV2, ModelConnectionV2, ProposeTeamGoalPlanV2, TeamTemplateIdV1, TeamTemplateSummaryV1 } from "@mn/contracts";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { CodingRepositorySummary } from "../types";

import { sourceLocation } from "./GoalSources";
import { SchedulingControls } from "./AgentScheduling";
import { TeamSelector } from "./TeamSelector";

type Material = { id: string; name: string; file: File; text: string; asset?: Asset;
  extraction?: Awaited<ReturnType<AgentOsClient["assetExtraction"]>>; status: "uploading" | "parsing" | "ready" | "failed"; error?: string };
const templates = [
  { label: "经营复盘", kind: "opc", objective: "复盘本月经营，找出影响现金流和交付的主要问题，并制定下月行动计划。", criteria: "区分已知事实、推断和待补资料\n每项行动说明优先级、负责人和完成条件" },
  { label: "客户与服务", kind: "opc", objective: "梳理目标客户和服务方案，形成可审阅的报价草案及交付范围。", criteria: "说明客户需求与资料来源\n列出服务范围、报价依据和待确认条款" },
  { label: "实现功能", kind: "coding", objective: "在选定仓库实现以下功能：\n\n使用场景：\n预期行为：", criteria: "实现约定的使用场景\n运行相关检查并说明结果\n交付可审阅的代码变更" },
  { label: "排查问题", kind: "coding", objective: "排查并修复以下问题：\n\n复现步骤：\n实际表现：\n预期表现：", criteria: "说明原因和影响范围\n用回归检查证明修复有效\n不修改无关功能" },
] as const;

export function TaskComposer({ api, workspaceId, pluginIds, repositories, repositoryId, onRepository, onRegisterRepository, onCreated, onSettings, visible, businessTarget }: {
  readonly businessTarget?: BusinessContextTargetV2 & { readonly sequence: number };
  readonly visible: boolean; readonly api: AgentOsClient; readonly workspaceId: string; readonly pluginIds: readonly string[];
  readonly repositories: readonly CodingRepositorySummary[]; readonly repositoryId?: string;
  readonly onRepository: (id: string) => void; readonly onRegisterRepository: () => void;
  readonly onCreated: (detail: GoalResponseV2) => void; readonly onSettings: () => void;
}) {
  const [kind, setKind] = useState(pluginIds.includes("opc") ? "opc" : "coding");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [materials, setMaterials] = useState<readonly Material[]>([]);
  const [businessMaterial, setBusinessMaterial] = useState<{ target: BusinessContextTargetV2; context?: BusinessObjectContextV2; error?: string }>();
  const businessSequence = useRef(0);
  const [businessLoading, setBusinessLoading] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [models, setModels] = useState<readonly ModelConnectionV2[]>([]);
  const [teamTemplates, setTeamTemplates] = useState<readonly TeamTemplateSummaryV1[]>([]);
  const [teamError, setTeamError] = useState<string>();
  const [teamTemplateId, setTeamTemplateId] = useState<TeamTemplateIdV1 | null>(null);
  const [teamModelId, setTeamModelId] = useState("");
  const [scheduling, setScheduling] = useState<AgentSchedulingRequestV2>({ runnerId: "auto", strategy: "quality" });
  const [currency, setCurrency] = useState("CNY");
  const [cost, setCost] = useState("20");
  const [minutes, setMinutes] = useState("30");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string>();
  const [step, setStep] = useState("");
  const [locked, setLocked] = useState(false);
  const mounted = useRef(true);
  const transaction = useRef<{ key: string; kind: string; objective: string; brief: string; resourceRefs: readonly GoalResourceRefV2[]; criteria: string[]; repositoryId?: string; scheduling: AgentSchedulingRequestV2; teamPlan?: Pick<ProposeTeamGoalPlanV2, "templateId" | "templateVersion" | "modelBindingId">; currency: string; cost: string; duration: number; threadId?: string; taskId?: string; goal?: GoalDetailV2 } | undefined>(undefined);
  const submitting = useRef(false);
  const readLock = useRef(false);
  const external = scheduling.runnerId === "codex-cli" || scheduling.runnerId === "claude-cli";
  const selectedRepository = repositories.find(item => item.id === repositoryId) ?? (repositories.length === 1 ? repositories[0] : undefined);
  const descriptions = criteria.split("\n").map(item => item.trim()).filter(Boolean);
  const brief = [objective.trim(), constraints.trim() && `约束与边界：\n${constraints.trim()}`].filter(Boolean).join("\n\n");
  const lengthValid = brief.length <= 16000;
  const previewMaterial = materials.find(item => item.id === preview);
  const teamModels = models.filter(model => model.billingCurrency === currency);
  const teamModel = teamModels.find(model => model.id === teamModelId) ?? teamModels[0];
  const teamTemplate = teamTemplates.find(template => template.id === teamTemplateId);
  const ready = pluginIds.includes(kind) && objective.trim() && descriptions.length > 0 && descriptions.length <= 20 && descriptions.every(item => item.length <= 2000)
    && lengthValid && (teamTemplateId ? teamTemplate?.available && teamTemplate.pluginId === kind && teamModel : external || models.some(model => model.billingCurrency === currency)) && (kind !== "coding" || selectedRepository) && !reading && !businessLoading && (!businessMaterial || Boolean(businessMaterial.context))
    && materials.every(item => item.status === "ready" && item.asset && item.extraction && item.extraction.status !== "unreadable");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void api.modelConnections().then(items => { if (current) setModels(items.filter(item => item.status === "ready" && item.billingCurrency)); })
      .catch(() => { if (current) setError("无法读取可用模型，请在设置中检查连接后重试。"); });
    void api.teamTemplates(workspaceId).then(items => { if (current) { setTeamTemplates(items); setTeamError(undefined); } })
      .catch(() => { if (current) { setTeamTemplates([]); setTeamError("无法读取团队模板，请检查连接后重试。"); } });
    return () => { current = false; };
  }, [api, visible, workspaceId]);

  useEffect(() => {
    if (!businessTarget) return;
    if (locked) { setError("当前任务正在保存，请先继续准备，再添加业务资料。"); return; }
    setKind("opc"); if (teamTemplateId === "code-delivery") setTeamTemplateId(null); void loadBusinessMaterial(businessTarget);
  }, [businessTarget?.sequence]);
  async function loadBusinessMaterial(target: BusinessContextTargetV2) {
    const request = ++businessSequence.current;
    setBusinessMaterial({ target }); setBusinessLoading(true);
    try {
      const context = await api.businessContext(workspaceId, target);
      if (!mounted.current || request !== businessSequence.current) return;
      setBusinessMaterial({ target, context });
      setObjective(current => current.trim() ? current : `围绕「${context.title}」完成分析并提出下一步建议。`);
      setCriteria(current => current.trim() ? current : "区分业务事实、建议和待确认事项\n每项结论说明业务资料依据");
    } catch (caught) {
      if (mounted.current && request === businessSequence.current) setBusinessMaterial({ target, error: caught instanceof AgentOsApiError ? `${caught.detail.message}。${caught.detail.action}` : "无法读取业务资料，请重试。" });
    } finally { if (mounted.current && request === businessSequence.current) setBusinessLoading(false); }
  }

  function updateMaterial(id: string, values: Partial<Material>) {
    if (mounted.current) setMaterials(items => items.map(item => item.id === id ? { ...item, ...values } : item));
  }
  async function prepareMaterial(material: Material) {
    try {
      updateMaterial(material.id, { status: material.asset ? "parsing" : "uploading", error: undefined });
      const asset = material.asset ?? await api.uploadAsset(workspaceId, material.file, true, `task-material:${workspaceId}:${material.id}`);
      updateMaterial(material.id, { asset, status: "parsing" });
      const extraction = await api.assetExtraction(asset.id);
      if (extraction.assetRef.resourceId !== asset.id || extraction.assetRef.streamVersion !== asset.streamVersion || extraction.assetRef.digest !== asset.digest) throw new Error("资料提取版本不一致");
      updateMaterial(material.id, { extraction, status: "ready" });
    } catch (caught) {
      updateMaterial(material.id, { status: "failed", error: caught instanceof AgentOsApiError ? `${caught.detail.message}。${caught.detail.action}` : "无法保存或解析资料，请重试。" });
    }
  }
  async function retryMaterial(material: Material) {
    if (readLock.current || locked) return;
    readLock.current = true; setReading(true);
    try { await prepareMaterial(material); }
    finally { readLock.current = false; if (mounted.current) setReading(false); }
  }

  async function addFiles(files: readonly File[]) {
    if (readLock.current || locked) return;
    readLock.current = true; setReading(true); setError(undefined);
    try {
      if (materials.length + files.length > 6) throw new Error("最多添加 6 份资料，请先移除不需要的内容。");
      const additions: Material[] = [];
      for (const file of files) {
        if (!/\.(txt|md|csv|json|pdf|docx|xlsx)$/iu.test(file.name)) throw new Error("支持 TXT、Markdown、CSV、JSON、PDF、DOCX 和 XLSX。文本文件请使用 UTF-8 编码。");
        if (file.size > 20 * 1024 * 1024) throw new Error(`「${file.name}」超过 20 MB，请拆分或摘录相关内容。`);
        const text = /\.(txt|md|csv|json)$/iu.test(file.name) ? new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) : "";
        if (text.includes("\0")) throw new Error("资料包含非文本内容，请使用 UTF-8 文本文件。");
        additions.push({ id: crypto.randomUUID(), name: file.name, file, text, status: "uploading" });
      }
      if (mounted.current) setMaterials(items => [...items, ...additions]);
      for (const material of additions) await prepareMaterial(material);
    } catch (caught) { if (mounted.current) setError(caught instanceof TypeError ? "无法按 UTF-8 读取资料，请转换编码后重试。" : (caught as Error).message); }
    finally { readLock.current = false; if (mounted.current) setReading(false); }
  }
  async function addBusinessSnapshot() {
    if (readLock.current || locked) return;
    readLock.current = true; setReading(true); setError(undefined);
    try {
      if (materials.length >= 6) throw new Error("最多添加 6 份资料，请先移除不需要的内容。");
      const { summary } = await api.business(workspaceId);
      const name = `经营汇总快照 · 事实版本 ${summary.sourceStreamVersion}`;
      const money = (minor: string) => { const amount = BigInt(minor); const absolute = amount < 0n ? -amount : amount; return `${amount < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")} 元`; };
      const text = [`读取时间：${new Date().toISOString()}`, `统计期间：${summary.period?.start ?? "全部"} 至 ${summary.period?.end ?? "读取时"}`,
        "本次分析使用人民币汇总快照文本，不会随台账变化更新，不能用于直接修改经营记录。",
        `本期收款：${money(summary.cashReceivedMinor)}；退款：${money(summary.cashRefundedMinor)}；支出：${money(summary.cashExpensesMinor)}；净现金流：${money(summary.netCashFlowMinor)}`,
        `待收款：${money(summary.outstandingMinor)}；逾期待收：${money(summary.overdueMinor)}`,
        ...summary.orders.map(order => `订单 ${order.orderId}：约定金额 ${money(order.agreedAmountMinor)}，待收 ${money(order.outstandingMinor)}，到期 ${order.dueOn}，交付 ${order.deliveredPercent}%，${order.accepted ? "已验收" : "未验收"}`),
      ].join("\n");
      if (new TextEncoder().encode(text).byteLength > 48_000) throw new Error("经营汇总超过 48 KB，请摘录关键数据后添加。");
      const material: Material = { id: crypto.randomUUID(), name, text, file: new File([text], `${name}.txt`, { type: "text/plain" }), status: "uploading" };
      if (mounted.current) { setMaterials(items => [...items, material]); setPreview(material.id); }
      await prepareMaterial(material);
    } catch (caught) { if (mounted.current) setError(caught instanceof AgentOsApiError ? caught.detail.message : (caught as Error).message); }
    finally { readLock.current = false; if (mounted.current) setReading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || reading || (!locked && !ready)) return;
    const minorUnits = Math.round(Number(cost) * 100);
    if (!Number.isSafeInteger(minorUnits) || minorUnits < 1 || !Number.isSafeInteger(Number(minutes)) || Number(minutes) < 1) { setError("请填写有效的执行额度和时限。"); return; }
    submitting.current = true; setBusy(true); setLocked(true); setError(undefined);
    const previous = transaction.current;
    const run = transaction.current = locked && previous ? previous : { key: crypto.randomUUID(), kind, objective: objective.trim(), brief, criteria: descriptions,
      resourceRefs: [...materials.map(item => ({ namespace: "asset", resourceId: item.asset!.id, streamVersion: item.asset!.streamVersion, digest: item.asset!.digest })), ...(businessMaterial?.context ? [businessMaterial.context.sourceRef] : [])],
      ...(selectedRepository ? { repositoryId: selectedRepository.id } : {}), scheduling, currency, cost: String(minorUnits), duration: Number(minutes) * 60_000,
      ...(teamTemplateId && teamModel ? { teamPlan: { templateId: teamTemplateId, templateVersion: "1" as const, modelBindingId: teamModel.id } } : {}),
      ...(previous?.kind === kind && previous.objective === objective.trim() && previous.repositoryId === selectedRepository?.id ? { threadId: previous.threadId, taskId: previous.taskId } : {}) };
    try {
      setStep("正在保存任务说明…");
      if (!run.threadId) {
        if (run.kind === "opc") run.threadId = (await api.createBusinessThread(workspaceId, run.objective.slice(0, 120), `${run.key}:thread`)).id;
        else {
          if (!run.taskId) run.taskId = (await api.capture(workspaceId, "coding", run.objective, run.repositoryId, `${run.key}:task`)).id;
          run.threadId = (await api.threads(workspaceId)).find(item => item.pluginId === "coding" && item.resourceRef?.resourceId === run.taskId)?.id;
          if (!run.threadId) throw new Error("任务已保存，会话尚未就绪。请继续准备。");
        }
      }
      if (!run.goal) run.goal = await api.createGoal(workspaceId, { threadId: run.threadId, objective: run.brief, resourceRefs: run.resourceRefs,
        budget: { maxTokens: 100000, maxCostMinorUnits: run.cost, currency: run.currency, maxDurationMs: run.duration },
        deliverables: [{ key: "result", title: run.kind === "coding" ? "研发成果" : "经营成果", required: true, criteria: run.criteria.map((description, index) => ({ id: `criterion-${index + 1}`, description })) }],
      }, `${run.key}:goal`);
      setStep("正在准备待审阅的计划…");
      const detail = run.teamPlan ? await api.planTeamGoal(run.goal, run.teamPlan, `${run.key}:plan`) : await api.planGoal(run.goal, run.scheduling, `${run.key}:plan`);
      if (!mounted.current) return;
      setObjective(""); setCriteria(""); setConstraints(""); setMaterials([]); setBusinessMaterial(undefined); setPreview(undefined); setTeamTemplateId(null); transaction.current = undefined; setLocked(false);
      onCreated(detail);
    } catch (caught) {
      if (mounted.current) {
        const editable = !locked && !run.goal && caught instanceof AgentOsApiError && [403, 404, 409, 422].includes(caught.status);
        if (editable) setLocked(false);
        setError(`${caught instanceof AgentOsApiError ? `${caught.detail.message}。${caught.detail.action}` : caught instanceof Error ? caught.message : "连接中断"}。任务说明已保留；${editable ? "请核对资料后重新准备。" : "继续准备会复用本次请求。"}`);
      }
    } finally { submitting.current = false; if (mounted.current) { setBusy(false); setStep(""); } }
  }
  return <form className="task-composer" aria-label="委派新任务" onSubmit={event => void submit(event)} onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!locked) void addFiles(Array.from(event.dataTransfer.files)); }}>
    <div className="composer-intro"><span className="eyebrow">从目标到成果</span><h2>想交给木牛什么工作？</h2><p>说清结果，带上资料。审阅执行计划后，木牛再开始工作。</p></div>
    <fieldset className="task-kind" disabled={locked}><legend>任务类型</legend>{[["opc", "经营", <BriefcaseBusiness size={17} />], ["coding", "研发", <Code2 size={17} />]].map(([id, label, icon]) => <label key={String(id)} className={kind === id ? "selected" : ""}><input type="radio" name="task-kind" value={String(id)} checked={kind === id} disabled={!pluginIds.includes(String(id))} onChange={() => { setKind(String(id)); setTeamTemplateId(null); }} />{icon}{label}</label>)}</fieldset>
    <div className="task-templates" aria-label="任务模板">{templates.filter(item => item.kind === kind).map(item => <button type="button" key={item.label} disabled={locked || Boolean(objective.trim())} onClick={() => { setObjective(item.objective); setCriteria(item.criteria); }}>{item.label}<ArrowUpRight size={14} /></button>)}</div>
    <div className="field task-objective"><label htmlFor="task-objective">任务目标</label><textarea id="task-objective" rows={5} maxLength={6000} disabled={locked} value={objective} onChange={event => setObjective(event.target.value)} placeholder={kind === "coding" ? "描述使用场景、预期行为或需要排查的问题…" : "例如：结合本月经营数据，制定下月客户跟进与交付计划…"} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></div>
    {kind === "coding" && <div className="task-repository"><label>任务仓库<select aria-label="任务仓库" value={selectedRepository?.id ?? ""} disabled={locked} onChange={event => onRepository(event.target.value)}><option value="" disabled>选择仓库</option>{repositories.map(item => <option key={item.id} value={item.id}>{item.name} · {item.rootRealPath}</option>)}</select></label><button type="button" className="quiet-button" disabled={locked} onClick={onRegisterRepository}><Plus size={15} />{repositories.length ? "添加仓库" : "登记仓库"}</button></div>}
    <div className="task-material-actions"><label className={`secondary-button ${locked ? "disabled" : ""}`}><Paperclip size={15} />添加资料<input aria-label="添加文本资料" type="file" accept=".txt,.md,.csv,.json,.pdf,.docx,.xlsx" multiple disabled={locked || reading} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void addFiles(files); }} /></label>{kind === "opc" && <button type="button" className="quiet-button" disabled={locked || reading} onClick={() => void addBusinessSnapshot()}>附加经营汇总</button>}<small>{reading ? "正在读取资料…" : "支持文本、PDF、Word 和表格，最多 6 份，每份 20 MB"}</small></div>
    {businessMaterial && <section className="task-materials" aria-label="关联业务资料">
      {businessLoading ? <p role="status">正在读取业务资料…</p> : businessMaterial.context ? <>
        <strong>{businessMaterial.context.title}</strong><p>事实版本 {businessMaterial.context.sourceRef.streamVersion} · 仅供任务分析，业务变更仍需确认。</p>
        <details><summary>查看业务资料</summary><pre className="material-preview">{businessMaterial.context.content}</pre></details>
        <button type="button" className="quiet-button" disabled={locked} onClick={() => void loadBusinessMaterial(businessMaterial.target)}>重新核对业务资料</button>
      </> : <p role="alert">{businessMaterial.error}<button type="button" className="quiet-button" disabled={locked} onClick={() => void loadBusinessMaterial(businessMaterial.target)}>重试业务资料</button></p>}
      <button type="button" className="quiet-button" disabled={locked} onClick={() => { businessSequence.current += 1; setBusinessMaterial(undefined); setBusinessLoading(false); }}>移除业务资料</button>
    </section>}
    {materials.length > 0 && <div className="task-materials">{materials.map(item => <div key={item.id}><div className="material-chip"><button type="button" onClick={() => setPreview(preview === item.id ? undefined : item.id)}><FileText size={14} />{item.name}</button><button type="button" aria-label={`移除 ${item.name}`} disabled={locked} onClick={() => { setMaterials(current => current.filter(value => value.id !== item.id)); setPreview(undefined); }}><X size={14} /></button></div>
      <small>{item.status === "uploading" ? "正在保存受保护资料…" : item.status === "parsing" ? "正在解析…" : item.status === "failed" ? "资料未就绪" : item.extraction?.status === "partial" ? "部分解析，请核对遗漏" : item.extraction?.status === "unreadable" ? "无法读取，请移除或重新提供文本" : "已解析"}</small>
      {item.error && <p role="alert">{item.error}<button type="button" className="quiet-button" aria-label={`重试资料：${item.name}`} disabled={locked || reading} onClick={() => void retryMaterial(item)}>重试资料</button></p>}
      {item.extraction?.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}
    </div>)}</div>}
    {previewMaterial && <div>{previewMaterial.extraction ? <>{previewMaterial.extraction.blocks.slice(0, 20).map(block => <div key={block.id}><small>{sourceLocation(block.locator)}</small><pre className="material-preview">{block.text}</pre></div>)}{previewMaterial.extraction.blocks.length > 20 && <p>此处仅预览前 20 个片段，完整原文随资料保存。</p>}</> : <p>资料准备完成后显示提取内容与位置。</p>}</div>}
    <div className="field"><label htmlFor="task-criteria">验收要求 <span>每行一项</span></label><textarea id="task-criteria" aria-label="验收要求" rows={3} required maxLength={6000} disabled={locked} value={criteria} onChange={event => setCriteria(event.target.value)} placeholder="成果要包含什么？怎样判断完成？" /></div>
    <details className="task-boundaries"><summary>补充约束与执行额度</summary><div className="field"><label htmlFor="task-constraints">约束与偏好</label><textarea id="task-constraints" rows={3} maxLength={3000} disabled={locked} value={constraints} onChange={event => setConstraints(event.target.value)} placeholder="期限、语气、目标人群、不在范围内的工作…" /></div><div className="task-budget"><label>币种<select aria-label="预算币种" disabled={locked} value={currency} onChange={event => setCurrency(event.target.value)}><option>CNY</option><option>USD</option></select></label><label>费用上限（{currency}）<input aria-label="费用上限" type="number" min="0.01" max="10000" step="0.01" required disabled={locked} value={cost} onChange={event => setCost(event.target.value)} /></label><label>时限（分钟）<input aria-label="时限（分钟）" type="number" min="1" max="1440" step="1" required disabled={locked} value={minutes} onChange={event => setMinutes(event.target.value)} /></label></div><small>模型用量上限 100,000 tokens；费用按参考价格预留，以厂商账单为准。</small></details>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!lengthValid && <p className="inline-error" role="alert">任务和约束合计超过 16000 字符，请精简内容。</p>}
    <TeamSelector value={teamTemplateId} templates={teamTemplates} disabled={locked} onChange={next => { setTeamTemplateId(next); const template = teamTemplates.find(item => item.id === next); if (template) setKind(template.pluginId); }} />
    {teamError && <p role="status">{teamError}</p>}
    {teamTemplateId ? <fieldset className="agent-scheduling" disabled={locked}><legend>团队执行模型</legend>
      <label>已计价模型<select aria-label="团队执行模型" value={teamModel?.id ?? ""} onChange={event => setTeamModelId(event.target.value)}>
        {!teamModels.length && <option value="">尚无同币种可用模型</option>}{teamModels.map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.defaultModel}</option>)}</select></label>
      <p>团队使用内置模型，所有步骤共用本次累计额度；开始前审阅固定计划。</p><button type="button" className="quiet-button" onClick={onSettings}>检查模型连接</button>
    </fieldset> : <SchedulingControls value={scheduling} onChange={setScheduling} models={models} disabled={locked} currency={currency} onSettings={onSettings} />}
    <div className="task-composer-footer"><small>{currency} {cost} 额度 · {minutes} 分钟 · {teamTemplateId ? teamTemplates.find(template => template.id === teamTemplateId)?.title : scheduling.strategy === "quality" ? "质量优先" : "按所选偏好推荐"}</small><button type="submit" className="primary-button" disabled={busy || reading || (!locked && !ready)}>{busy ? step : locked ? "继续准备" : "准备执行计划"}<ArrowUpRight size={17} /></button></div>
    {locked && transaction.current?.goal && !busy && <button type="button" className="quiet-button" onClick={() => { const goal = transaction.current!.goal!; transaction.current = undefined; setLocked(false); onCreated(goal); }}>查看已保存的任务</button>}
    <p className="composer-footnote">草稿暂存在本窗口；资料受保护保存，按任务授权提供给所选 Agent。Command / Ctrl + Enter 准备计划。</p>
  </form>;
}
