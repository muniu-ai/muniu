// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileText,
  SearchCheck,
  ShieldCheck,
  Target,
} from "lucide-react";
import { AgentOsApiError, type AgentOsClient } from "../api";
import { ThreadAgentPanel } from "../components/ThreadAgentPanel";
import { Loading } from "../components/Status";
import { ExportFileError, saveJsonExport } from "../export";
import type {
  AssetSummary,
  OpcDeliverablePreview,
  OpcOpportunityCommand,
  OpportunityCommitmentEvidence,
  OpportunityDetail,
  OpportunityState,
  ViewMode,
} from "../types";

interface OpcDetailPageProps {
  readonly api: AgentOsClient;
  readonly workspaceId: string;
  readonly opportunityId: string;
  readonly viewMode: ViewMode;
  readonly onBack: () => void;
  readonly onChanged: () => Promise<void>;
}

type RunCommand = (
  command: OpcOpportunityCommand,
  input: Readonly<Record<string, unknown>>,
  successMessage: string,
) => Promise<boolean>;

type UploadAsset = (file: File, protectedValue: boolean) => Promise<AssetSummary | undefined>;

interface OpcUiError {
  readonly title: string;
  readonly message: string;
}

const stateLabels: Record<OpportunityState, string> = {
  captured: "待界定",
  framed: "已界定",
  researching: "研究中",
  interviewing: "访谈中",
  evaluating: "评估中",
  offer_ready: "方案就绪",
  decided: "已决策",
  paused: "已暂停",
  abandoned: "已放弃",
};

export function OpcDetailPage({ api, workspaceId, opportunityId, viewMode, onBack, onChanged }: OpcDetailPageProps) {
  const [opportunity, setOpportunity] = useState<OpportunityDetail>();
  const [deliverables, setDeliverables] = useState<readonly OpcDeliverablePreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<OpcUiError>();
  const [notice, setNotice] = useState<string>();
  const [lastExport, setLastExport] = useState<{ readonly opportunityId: string; readonly streamVersion: number; readonly items: Awaited<ReturnType<AgentOsClient["exportOpportunity"]>> }>();
  const feedbackRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [detailResult, previewResult] = await Promise.allSettled([
        api.opportunity(workspaceId, opportunityId),
        api.opportunityDeliverables(workspaceId, opportunityId),
      ]);
      if (detailResult.status === "rejected") throw detailResult.reason;
      setOpportunity(detailResult.value);
      if (previewResult.status === "fulfilled") setDeliverables(previewResult.value);
      else setError({ title: "档案已读取，成果预览未更新", message: apiMessage(previewResult.reason) });
    } catch (caught) {
      setError({ title: "机会档案读取失败", message: apiMessage(caught) });
    } finally {
      setLoading(false);
    }
  }, [api, opportunityId, workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.querySelector(".page-scroll")?.scrollTo({ top: 0 }); }, [opportunityId]);
  useEffect(() => {
    if (error || notice) feedbackRef.current?.scrollIntoView({ block: "nearest" });
  }, [error, notice]);

  const runCommand: RunCommand = useCallback(async (command, input, successMessage) => {
    if (!opportunity || busy) return false;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await api.commandOpportunity(workspaceId, opportunity, command, input);
      setOpportunity(updated);
      setNotice(successMessage);
      try {
        setDeliverables(await api.opportunityDeliverables(workspaceId, updated.id));
      } catch (caught) {
        setError({ title: "操作已保存，成果预览未更新", message: apiMessage(caught) });
      }
      try {
        await onChanged();
      } catch (caught) {
        setError({ title: "操作已保存，机会摘要未更新", message: apiMessage(caught) });
      }
      return true;
    } catch (caught) {
      if (caught instanceof AgentOsApiError && caught.status === 409) {
        await load();
        setError({ title: "档案版本已更新", message: "已读取最新档案。请核对当前状态后重新提交" });
      } else {
        setError({ title: "这一步没有保存", message: apiMessage(caught) });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, busy, load, onChanged, opportunity, workspaceId]);

  const uploadAsset: UploadAsset = useCallback(async (file, protectedValue) => {
    if (busy) return undefined;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      return await api.uploadAsset(workspaceId, file, protectedValue);
    } catch (caught) {
      setError({ title: "无法上传附件", message: apiMessage(caught) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [api, busy, workspaceId]);

  async function exportDeliverables() {
    if (!opportunity || busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const exported = lastExport?.opportunityId === opportunity.id && lastExport.streamVersion === opportunity.streamVersion
        ? lastExport.items : await api.exportOpportunity(workspaceId, opportunity);
      setLastExport({ opportunityId: opportunity.id, streamVersion: opportunity.streamVersion, items: exported });
      const saved = await saveJsonExport(`${opportunity.title}-机会成果`, {
        schemaVersion: 1, opportunityId: opportunity.id, opportunityVersion: opportunity.streamVersion,
        deliverables: exported,
      });
      setNotice(saved === "cancelled" ? "成果已生成，已取消保存文件；可再次导出"
        : `${exported.length} 项成果已导出${saved === "saved" ? "，文件已保存" : "，文件下载已发起"}`);
      try {
        await onChanged();
      } catch (caught) {
        setError({ title: "成果已生成，成果列表未更新", message: apiMessage(caught) });
      }
    } catch (caught) {
      if (caught instanceof AgentOsApiError && caught.status === 409) {
        await load();
        setError({ title: "档案版本已更新", message: "已读取最新档案。请核对后重新导出" });
      } else {
        setError({ title: "成果文件未保存", message: apiMessage(caught) });
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="page-stack opc-detail"><BackButton onClick={onBack} /><Loading label="正在读取机会档案" /></div>;
  }
  if (!opportunity) {
    return <div className="page-stack opc-detail"><BackButton onClick={onBack} /><InlineError title={error?.title ?? "机会档案读取失败"} message={error?.message ?? "请返回机会列表后重试"} onDismiss={() => void load()} retry /></div>;
  }

  const hypothesis = opportunity.hypotheses.at(-1);
  const pendingCommitment = opportunity.commitmentEvidence.find((item) => item.status === "proposed");
  const confirmedCommitment = opportunity.commitmentEvidence.find((item) => item.status === "confirmed");

  return <div className="page-stack opc-detail">
    <BackButton onClick={onBack} />
    <header className="opc-detail-hero">
      <div>
        <p className="eyebrow">机会档案</p>
        <div className="opc-detail-title"><h1>{opportunity.title}</h1><span className={`evidence-level ${opportunity.evidenceLevel}`}>{evidenceLabel(opportunity.evidenceLevel)}</span></div>
        <p>{hypothesis ? `${hypothesis.targetCustomer} · ${hypothesis.problem}` : opportunity.rawCapture}</p>
      </div>
      <span className="opc-state">{stateLabels[opportunity.state]}</span>
    </header>

    {viewMode === "professional" && <dl className="opc-professional-meta" aria-label="机会技术信息">
      <div><dt>机会 ID</dt><dd>{opportunity.id}</dd></div>
      <div><dt>事件版本</dt><dd>{opportunity.streamVersion}</dd></div>
      <div><dt>内部状态</dt><dd>{opportunity.state}</dd></div>
    </dl>}

    {(notice || error) && <div className="opc-feedback" ref={feedbackRef}>
      {notice && <div className="opc-inline-notice" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(undefined)}>关闭</button></div>}
      {error && <InlineError title={error.title} message={error.message} onDismiss={() => setError(undefined)} />}
    </div>}

    <NextTask
      opportunity={opportunity}
      pendingCommitment={pendingCommitment}
      confirmedCommitment={confirmedCommitment}
      deliverableCount={deliverables.length}
      busy={busy}
      runCommand={runCommand}
      uploadAsset={uploadAsset}
      onExport={exportDeliverables}
    />
    <ThreadAgentPanel api={api} workspaceId={workspaceId} pluginId="opc" resourceId={opportunity.id} professional={viewMode === "professional"} />
    <OpportunityLifecycle opportunity={opportunity} busy={busy} runCommand={runCommand} />

    <section className="opc-record-grid" aria-label="机会事实记录">
      <article className="opc-record-card">
        <header><Target size={17} /><div><strong>当前假设</strong><small>{opportunity.hypotheses.length} 个版本</small></div></header>
        {hypothesis ? <dl>
          <div><dt>目标客户</dt><dd>{hypothesis.targetCustomer}</dd></div>
          <div><dt>客户问题</dt><dd>{hypothesis.problem}</dd></div>
          <div><dt>可证伪假设</dt><dd>{hypothesis.statement}</dd></div>
        </dl> : <p className="opc-record-empty">完成界定后显示</p>}
      </article>
      <article className="opc-record-card">
        <header><SearchCheck size={17} /><div><strong>证据与反证</strong><small>{opportunity.signals.length} 条市场信号</small></div></header>
        <EvidenceRows opportunity={opportunity} />
      </article>
      <article className="opc-record-card">
        <header><ClipboardCheck size={17} /><div><strong>非诱导访谈提纲</strong><small>围绕既往行为与真实成本</small></div></header>
        <InterviewGuide deliverables={deliverables} />
      </article>
      <article className="opc-record-card">
        <header><FileText size={17} /><div><strong>访谈原文</strong><small>{opportunity.interviews.length} 份记录</small></div></header>
        {opportunity.interviews.length > 0 ? opportunity.interviews.map((interview) => <InterviewRecord
          key={interview.id}
          interview={interview}
          busy={busy}
          canAnnotate={["interviewing", "evaluating", "offer_ready"].includes(opportunity.state)}
          runCommand={runCommand}
        />) : <p className="opc-record-empty">尚未保存访谈原文</p>}
      </article>
      <article className="opc-record-card">
        <header><ClipboardCheck size={17} /><div><strong>方案与决策</strong><small>{opportunity.decision ? "已由负责人决策" : "随验证进展更新"}</small></div></header>
        {!opportunity.minimumPaidOffer && opportunity.commitmentEvidence.length === 0 && !opportunity.decision && <p className="opc-record-empty">尚未形成收费方案</p>}
        {opportunity.minimumPaidOffer && <div className="opc-record-row"><strong>最小收费方案</strong><small>{formatPrice(opportunity.minimumPaidOffer.price.amountMinor, opportunity.minimumPaidOffer.price.currency)} · {opportunity.minimumPaidOffer.duration}</small><p>{opportunity.minimumPaidOffer.promisedOutcome}</p></div>}
        {opportunity.commitmentEvidence.map((evidence) => <div className="opc-record-row" key={evidence.id}><strong>{evidence.status === "confirmed" ? "已确认承诺" : "待确认承诺"}</strong><small>{evidence.sourceRef}</small><p>{evidence.description}</p></div>)}
        {opportunity.decision && <div className="opc-record-row"><strong>{decisionLabel(opportunity.decision.choice)}</strong><small>{formatDate(opportunity.decision.decidedAt)}</small><p>{opportunity.decision.rationale}</p></div>}
      </article>
    </section>

    <section className="opc-deliverable-preview">
      <header><div><p className="eyebrow">成果预览</p><h2>随证据实时更新</h2></div><span>{deliverables.length} 项</span></header>
      <div>{deliverables.map((item) => <article key={item.kind}><FileText size={16} /><div><strong>{item.title}</strong><p>{item.summary}</p><small>{item.validationStatus}</small></div></article>)}</div>
    </section>
  </div>;
}

function NextTask({ opportunity, pendingCommitment, confirmedCommitment, deliverableCount, busy, runCommand, uploadAsset, onExport }: {
  readonly opportunity: OpportunityDetail;
  readonly pendingCommitment?: OpportunityCommitmentEvidence;
  readonly confirmedCommitment?: OpportunityCommitmentEvidence;
  readonly deliverableCount: number;
  readonly busy: boolean;
  readonly runCommand: RunCommand;
  readonly uploadAsset: UploadAsset;
  readonly onExport: () => Promise<void>;
}) {
  if (opportunity.state === "captured") return <FrameTask opportunity={opportunity} busy={busy} runCommand={runCommand} />;
  if (opportunity.state === "framed") return <SimpleTask
    icon={<SearchCheck size={19} />} title="开始资料研究" detail="先收集真实市场信号，并同时寻找能推翻假设的材料。"
    button="开始研究" busy={busy} onClick={() => runCommand("start_research", {}, "研究阶段已开始")}
  />;
  if (opportunity.state === "researching") return <SignalTask busy={busy} runCommand={runCommand} uploadAsset={uploadAsset} />;
  if (opportunity.state === "interviewing") return <InterviewTask busy={busy} runCommand={runCommand} uploadAsset={uploadAsset} />;
  if (opportunity.state === "evaluating") return <OfferTask opportunity={opportunity} busy={busy} runCommand={runCommand} />;
  if (opportunity.state === "offer_ready" && pendingCommitment) return <ConfirmCommitmentTask evidence={pendingCommitment} busy={busy} runCommand={runCommand} />;
  if (opportunity.state === "offer_ready" && !confirmedCommitment) return <CommitmentTask busy={busy} runCommand={runCommand} />;
  if (opportunity.state === "offer_ready") return <DecisionTask busy={busy} runCommand={runCommand} />;
  if (opportunity.state === "decided") return <SimpleTask
    icon={<Download size={19} />} title="导出机会成果" detail="保存包含六项成果的 JSON 文件。文件含明文访谈，请妥善保管；对外分享后无法撤回。"
    button={`导出 ${deliverableCount} 项成果`} busy={busy} onClick={onExport}
  />;
  if (opportunity.state === "paused") return <SimpleTask
    icon={<Target size={19} />} title="恢复机会" detail={opportunity.pauseReason ? `暂停原因：${opportunity.pauseReason}` : "恢复后回到暂停前的阶段。"}
    button="恢复机会" busy={busy} onClick={() => runCommand("resume", {}, "机会已恢复")}
  />;
  if (opportunity.state === "abandoned") return <section className="opc-next-task"><TaskHeading icon={<ClipboardCheck size={19} />} title="机会已放弃" detail={opportunity.abandonmentReason ?? "当前证据已保留，后续可创建新机会。"} /></section>;
  return <section className="opc-next-task"><TaskHeading icon={<ClipboardCheck size={19} />} title={stateLabels[opportunity.state]} detail="当前机会没有待执行的阶段操作。" /></section>;
}

function OpportunityLifecycle({ opportunity, busy, runCommand }: {
  readonly opportunity: OpportunityDetail;
  readonly busy: boolean;
  readonly runCommand: RunCommand;
}) {
  const [reason, setReason] = useState("");
  const [abandonConfirmed, setAbandonConfirmed] = useState(false);
  if (opportunity.state === "decided" || opportunity.state === "abandoned") return null;
  const canPause = opportunity.state !== "paused";

  async function apply(command: "pause" | "abandon", successMessage: string) {
    const saved = await runCommand(command, { reason: reason.trim() }, successMessage);
    if (saved) {
      setReason("");
      setAbandonConfirmed(false);
    }
  }

  return <details className="opc-lifecycle">
    <summary>管理机会</summary>
    <div>
      <Field label="管理原因" value={reason} onChange={setReason} placeholder="记录暂停或放弃的原因" multiline rows={2} />
      <footer>
        {canPause && <button type="button" className="secondary-button" disabled={busy || !reason.trim()} onClick={() => void apply("pause", "机会已暂停")}>暂停机会</button>}
        <label className="check-row"><input type="checkbox" checked={abandonConfirmed} onChange={(event) => setAbandonConfirmed(event.target.checked)} /><span><strong>确认放弃当前机会</strong><small>已有证据将保留，机会不能恢复</small></span></label>
        <button type="button" className="danger-button" disabled={busy || !reason.trim() || !abandonConfirmed} onClick={() => void apply("abandon", "机会已放弃")}>放弃机会</button>
      </footer>
    </div>
  </details>;
}

function FrameTask({ opportunity, busy, runCommand }: { readonly opportunity: OpportunityDetail; readonly busy: boolean; readonly runCommand: RunCommand }) {
  const [targetCustomer, setTargetCustomer] = useState(guessCapture(opportunity.rawCapture, "目标客户"));
  const [problem, setProblem] = useState(guessCapture(opportunity.rawCapture, "问题"));
  const [hypothesis, setHypothesis] = useState(guessCapture(opportunity.rawCapture, "假设"));
  return <TaskForm title="界定这项机会" detail="把想法改写为可以被真实证据推翻的判断。" icon={<Target size={19} />} busy={busy} submitLabel="保存机会界定" onSubmit={() => runCommand("frame", {
    targetCustomer, problem, falsifiableHypothesis: hypothesis,
  }, "机会界定已保存")}>
    <div className="opc-form-grid">
      <Field label="目标客户" value={targetCustomer} onChange={setTargetCustomer} placeholder="例如：有 2–5 年经验的独立设计师" />
      <Field label="客户问题" value={problem} onChange={setProblem} placeholder="描述他们正在经历的具体问题" />
    </div>
    <Field label="可证伪假设" value={hypothesis} onChange={setHypothesis} placeholder="例如：3 人中至少 1 人愿意付费试用" multiline />
  </TaskForm>;
}

function SignalTask({ busy, runCommand, uploadAsset }: { readonly busy: boolean; readonly runCommand: RunCommand; readonly uploadAsset: UploadAsset }) {
  const [sourceKind, setSourceKind] = useState("pasted");
  const [sourceUrl, setSourceUrl] = useState("");
  const [observedAt, setObservedAt] = useState(localDateTime());
  const [excerpt, setExcerpt] = useState("");
  const [summary, setSummary] = useState("");
  const [relationship, setRelationship] = useState("support");
  const [evidenceKind, setEvidenceKind] = useState("context");
  const [sourceFile, setSourceFile] = useState<File>();
  const [fileError, setFileError] = useState<string>();

  async function submit() {
    setFileError(undefined);
    let sourceAssetId: string | undefined;
    if (sourceKind === "file") {
      if (!sourceFile) {
        setFileError("请选择要保存的证据文件");
        return false;
      }
      const asset = await uploadAsset(sourceFile, true);
      if (!asset) return false;
      sourceAssetId = asset.id;
    }
    const saved = await runCommand("record_signal", {
      sourceKind,
      ...(sourceKind === "public_web" ? { sourceUrl } : {}),
      ...(sourceAssetId ? { sourceAssetId } : {}),
      observedAt: toIso(observedAt), excerpt, summary, relationship, evidenceKind,
    }, "信号已保存");
    if (saved) { setExcerpt(""); setSummary(""); setSourceUrl(""); setSourceFile(undefined); }
    return saved;
  }

  return <TaskForm title="记录一条市场信号" detail="先保存来源和原文，再说明它支持还是反对当前假设。" icon={<SearchCheck size={19} />} busy={busy} submitLabel="保存信号" onSubmit={submit} secondary={{
    label: "信号已够，开始访谈",
    onClick: () => runCommand("start_interviewing", {}, "已进入访谈阶段"),
  }}>
    <div className="opc-form-grid three">
      <SelectField label="来源类型" value={sourceKind} onChange={setSourceKind} options={[
        ["pasted", "粘贴内容"], ["public_web", "公开网页"], ["file", "文件"], ["manual", "人工记录"],
      ]} />
      <SelectField label="证据关系" value={relationship} onChange={(value) => { setRelationship(value); if (value !== "support") setEvidenceKind("context"); }} options={[
        ["support", "支持当前假设"], ["oppose", "反对当前假设"], ["neutral", "中立背景"],
      ]} />
      <SelectField label="信号强度" value={evidenceKind} onChange={setEvidenceKind} options={relationship === "support" ? [
        ["context", "背景信号"], ["interest", "兴趣信号"],
      ] : [["context", "背景信号"]]} />
    </div>
    {sourceKind === "public_web" && <Field label="来源网址" type="url" value={sourceUrl} onChange={setSourceUrl} placeholder="https://example.com/research" />}
    {sourceKind === "file" && <FileField
      label="证据文件"
      accept=".txt,.md,.json,.csv,.pdf,.png,.jpg,.jpeg,.webp"
      value={sourceFile}
      onChange={(file) => { setSourceFile(file); setFileError(undefined); }}
      help="文件会先加密上传，再把 Asset 引用写入信号"
      error={fileError}
    />}
    <Field label="观察时间" type="datetime-local" value={observedAt} onChange={setObservedAt} />
    <Field label="原始摘录" value={excerpt} onChange={setExcerpt} placeholder="可选；保留能复核的原话或原文" multiline required={false} />
    <Field label="信号摘要" value={summary} onChange={setSummary} placeholder="一句话说明这条材料意味着什么" multiline />
  </TaskForm>;
}

function InterviewTask({ busy, runCommand, uploadAsset }: { readonly busy: boolean; readonly runCommand: RunCommand; readonly uploadAsset: UploadAsset }) {
  const [participantRef, setParticipantRef] = useState("");
  const [occurredAt, setOccurredAt] = useState(localDateTime());
  const [rawRecord, setRawRecord] = useState("");
  const [rawFile, setRawFile] = useState<File>();
  const [sourceError, setSourceError] = useState<string>();
  async function submit() {
    setSourceError(undefined);
    if (!rawFile && !rawRecord.trim()) {
      setSourceError("请选择访谈文件或粘贴访谈原文");
      return false;
    }
    const source = rawFile ?? new File(
      [rawRecord],
      `访谈原文-${new Date().toISOString().slice(0, 10)}.txt`,
      { type: "text/plain" },
    );
    const asset = await uploadAsset(source, true);
    if (!asset) return false;
    const saved = await runCommand("record_interview", {
      interviewId: `interview-${globalThis.crypto.randomUUID()}`,
      participantRef,
      occurredAt: toIso(occurredAt),
      rawRecordAssetId: asset.id,
    }, "访谈原文已保存");
    if (saved) { setParticipantRef(""); setRawRecord(""); setRawFile(undefined); }
    return saved;
  }
  return <TaskForm title="保存访谈原文" detail="原始记录保存后不会被模型改写；后续解释只能作为标注追加。" icon={<FileText size={19} />} busy={busy} submitLabel="保存访谈原文" onSubmit={submit} secondary={{
    label: "访谈已够，开始评估",
    onClick: () => runCommand("start_evaluation", {}, "已进入证据评估阶段"),
  }}>
    <div className="opc-form-grid">
      <Field label="受访者代号" value={participantRef} onChange={setParticipantRef} placeholder="例如：受访者 A" />
      <Field label="访谈时间" type="datetime-local" value={occurredAt} onChange={setOccurredAt} />
    </div>
    <FileField
      label="访谈文件"
      accept=".txt,.md,text/plain,text/markdown"
      value={rawFile}
      onChange={(file) => { setRawFile(file); setSourceError(undefined); }}
      help="可选择 UTF-8 文本或 Markdown；选择文件后以文件内容为准"
    />
    <Field label="访谈原文" value={rawRecord} onChange={(value) => { setRawRecord(value); setSourceError(undefined); }} placeholder="也可以粘贴未经改写的访谈记录" multiline rows={6} required={false} />
    {sourceError && <p className="field-error" role="alert">{sourceError}</p>}
  </TaskForm>;
}

function OfferTask({ opportunity, busy, runCommand }: { readonly opportunity: OpportunityDetail; readonly busy: boolean; readonly runCommand: RunCommand }) {
  const hypothesis = opportunity.hypotheses.at(-1);
  const [promisedOutcome, setPromisedOutcome] = useState("");
  const [inScope, setInScope] = useState("");
  const [outOfScope, setOutOfScope] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [priceAssumption, setPriceAssumption] = useState("");
  const [deliveryFormat, setDeliveryFormat] = useState("");
  const [duration, setDuration] = useState("");
  const [acceptanceMethod, setAcceptanceMethod] = useState("");
  const [nextCustomerAction, setNextCustomerAction] = useState("");
  const [risks, setRisks] = useState("");
  return <TaskForm title="形成最小收费方案" detail="只承诺最小可交付结果，并明确价格、验收、边界和客户下一步。" icon={<ClipboardCheck size={19} />} busy={busy} submitLabel="保存最小收费方案" onSubmit={() => runCommand("prepare_offer", {
    targetCustomer: hypothesis?.targetCustomer ?? "待确认客户",
    promisedOutcome,
    inScope: lines(inScope),
    outOfScope: lines(outOfScope),
    price: { amountMinor: toMinorUnits(price), currency, assumption: priceAssumption },
    deliveryFormat, duration, acceptanceMethod, nextCustomerAction, risks: lines(risks),
  }, "最小收费方案已保存")}>
    <Field label="承诺结果" value={promisedOutcome} onChange={setPromisedOutcome} placeholder="客户在周期结束时能获得什么" multiline />
    <div className="opc-form-grid">
      <Field label="服务范围" value={inScope} onChange={setInScope} placeholder="每行一项" multiline />
      <Field label="不包含" value={outOfScope} onChange={setOutOfScope} placeholder="每行一项" multiline />
    </div>
    <div className="opc-form-grid three">
      <Field label="价格" type="number" value={price} onChange={setPrice} placeholder="99" />
      <SelectField label="币种" value={currency} onChange={setCurrency} options={[["CNY", "人民币 CNY"], ["USD", "美元 USD"]]} />
      <Field label="价格假设" value={priceAssumption} onChange={setPriceAssumption} placeholder="例如：首批客户测试价" />
    </div>
    <div className="opc-form-grid">
      <Field label="交付形式" value={deliveryFormat} onChange={setDeliveryFormat} placeholder="例如：在线文档与复盘会" />
      <Field label="交付周期" value={duration} onChange={setDuration} placeholder="例如：7 天" />
      <Field label="验收方式" value={acceptanceMethod} onChange={setAcceptanceMethod} placeholder="怎样算交付完成" />
      <Field label="客户下一步" value={nextCustomerAction} onChange={setNextCustomerAction} placeholder="客户接下来要做什么" />
    </div>
    <Field label="主要风险" value={risks} onChange={setRisks} placeholder="每行一项" multiline />
  </TaskForm>;
}

function CommitmentTask({ busy, runCommand }: { readonly busy: boolean; readonly runCommand: RunCommand }) {
  const [level, setLevel] = useState("commitment");
  const [description, setDescription] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  return <TaskForm title="记录客户承诺" detail="先提交待确认记录。只有人工核对后，证据等级才会提升。" icon={<ShieldCheck size={19} />} busy={busy} submitLabel="提交待确认承诺" onSubmit={() => runCommand("propose_commitment", {
    level, description, sourceRef,
  }, "承诺已提交，等待人工核对")}>
    <SelectField label="证据类型" value={level} onChange={setLevel} options={[["commitment", "行动承诺"], ["paid", "付费证据"]]} />
    <Field label="证据说明" value={description} onChange={setDescription} placeholder="客户明确承诺了什么" multiline />
    <Field label="证据来源" value={sourceRef} onChange={setSourceRef} placeholder="指向访谈、邮件或付款记录" />
  </TaskForm>;
}

function ConfirmCommitmentTask({ evidence, busy, runCommand }: { readonly evidence: OpportunityCommitmentEvidence; readonly busy: boolean; readonly runCommand: RunCommand }) {
  const [confirmed, setConfirmed] = useState(false);
  return <TaskForm title="核对客户承诺" detail="请对照原始记录。模型建议和转述不能代替人工确认。" icon={<ShieldCheck size={19} />} busy={busy} submitLabel="确认承诺证据" submitDisabled={!confirmed} onSubmit={() => runCommand("confirm_commitment", { evidenceId: evidence.id }, "承诺证据已由人工确认")}>
    <div className="opc-confirmation-summary"><strong>{evidence.level === "paid" ? "付费证据" : "行动承诺"}</strong><p>{evidence.description}</p><small>来源：{evidence.sourceRef}</small></div>
    <label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>我已核对原始记录，确认这项承诺真实有效</strong><small>确认人和时间将写入证据账本</small></span></label>
  </TaskForm>;
}

function DecisionTask({ busy, runCommand }: { readonly busy: boolean; readonly runCommand: RunCommand }) {
  const [decision, setDecision] = useState("pursue");
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  return <TaskForm title="作出最终决策" detail="负责人根据支持证据、反证和缺口，选择继续、修订或停止。" icon={<ClipboardCheck size={19} />} busy={busy} submitLabel="保存人工决策" submitDisabled={!confirmed} onSubmit={() => runCommand("decide", { decision, rationale }, "人工决策已保存")}>
    <SelectField label="决策" value={decision} onChange={setDecision} options={[["pursue", "继续推进"], ["revise", "修订方案"], ["stop", "停止机会"]]} />
    <Field label="决策理由" value={rationale} onChange={setRationale} placeholder="说明主要证据、反证和仍需接受的风险" multiline />
    <label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>我确认这是负责人作出的最终决策</strong><small>系统不会由模型代替你作出该决定</small></span></label>
  </TaskForm>;
}

function TaskForm({ title, detail, icon, busy, submitLabel, submitDisabled = false, secondary, onSubmit, children }: {
  readonly title: string;
  readonly detail: string;
  readonly icon: React.ReactNode;
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly submitDisabled?: boolean;
  readonly secondary?: { readonly label: string; readonly onClick: () => Promise<boolean> };
  readonly onSubmit: () => Promise<boolean>;
  readonly children: React.ReactNode;
}) {
  function submit(event: FormEvent) { event.preventDefault(); void onSubmit(); }
  return <section className="opc-next-task"><TaskHeading title={title} detail={detail} icon={icon} />
    <form className="opc-task-form" onSubmit={submit}>
      {children}
      <footer>{secondary && <button className="secondary-button" type="button" disabled={busy} onClick={() => void secondary.onClick()}>{secondary.label}</button>}<button className="primary-button" type="submit" disabled={busy || submitDisabled}>{busy ? "正在保存" : submitLabel}</button></footer>
    </form>
  </section>;
}

function SimpleTask({ icon, title, detail, button, busy, onClick }: { readonly icon: React.ReactNode; readonly title: string; readonly detail: string; readonly button: string; readonly busy: boolean; readonly onClick: () => Promise<boolean> | Promise<void> }) {
  return <section className="opc-next-task"><TaskHeading icon={icon} title={title} detail={detail} /><footer className="opc-simple-action"><button className="primary-button" type="button" disabled={busy} onClick={() => void onClick()}>{busy ? "正在处理" : button}</button></footer></section>;
}

function TaskHeading({ icon, title, detail }: { readonly icon: React.ReactNode; readonly title: string; readonly detail: string }) {
  return <header className="opc-task-heading"><span>{icon}</span><div><p className="eyebrow">当前任务</p><h2>{title}</h2><p>{detail}</p></div></header>;
}

function Field({ label, value, onChange, placeholder, multiline = false, rows = 3, type = "text", required = true }: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly rows?: number;
  readonly type?: string;
  readonly required?: boolean;
}) {
  const inputId = useId();
  return <div className="field"><label htmlFor={inputId}>{label}</label>{multiline
    ? <textarea id={inputId} required={required} rows={rows} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    : <input id={inputId} required={required} type={type} step={type === "number" ? "0.01" : undefined} min={type === "number" ? "0.01" : undefined} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />}</div>;
}

function SelectField({ label, value, onChange, options }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly options: readonly (readonly [string, string])[] }) {
  const selectId = useId();
  return <div className="field"><label htmlFor={selectId}>{label}</label><select id={selectId} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></div>;
}

function FileField({ label, accept, value, onChange, help, error }: {
  readonly label: string;
  readonly accept: string;
  readonly value?: File;
  readonly onChange: (file: File | undefined) => void;
  readonly help: string;
  readonly error?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!value && inputRef.current) inputRef.current.value = "";
  }, [value]);
  return <div className="field file-field">
    <label htmlFor={inputId}>{label}</label>
    <input ref={inputRef} id={inputId} type="file" accept={accept} onChange={(event) => onChange(event.target.files?.[0])} />
    <small>{value ? `${value.name} · ${formatBytes(value.size)}` : help}</small>
    {error && <span className="field-error" role="alert">{error}</span>}
  </div>;
}

function BackButton({ onClick }: { readonly onClick: () => void }) {
  return <button className="quiet-button opc-back" type="button" onClick={onClick}><ArrowLeft size={16} />返回机会列表</button>;
}

function InlineError({ title, message, onDismiss, retry = false }: { readonly title: string; readonly message: string; readonly onDismiss: () => void; readonly retry?: boolean }) {
  return <div className="opc-inline-error" role="alert"><AlertTriangle size={18} /><div><strong>{title}</strong><p>{message}</p></div><button className="secondary-button" type="button" onClick={onDismiss}>{retry ? "重试" : "关闭"}</button></div>;
}

function InterviewRecord({ interview, busy, canAnnotate, runCommand }: {
  readonly interview: OpportunityDetail["interviews"][number];
  readonly busy: boolean;
  readonly canAnnotate: boolean;
  readonly runCommand: RunCommand;
}) {
  const [annotation, setAnnotation] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await runCommand("annotate_interview", {
      interviewId: interview.id,
      annotation,
    }, "访谈标注已追加");
    if (saved) setAnnotation("");
  }
  return <div className="opc-record-row interview-record">
    <strong>{interview.participantRef}</strong><small>{formatDate(interview.occurredAt)}</small>
    <p>{interview.rawRecord}</p>
    {interview.annotations.length > 0 && <ul aria-label={`${interview.participantRef}的访谈标注`}>
      {interview.annotations.map((item) => <li key={item.id}>{item.text}</li>)}
    </ul>}
    {canAnnotate && <form onSubmit={(event) => void submit(event)}>
      <label>
        <span>追加标注</span>
        <input
          aria-label={`为${interview.participantRef} 追加标注`}
          required
          value={annotation}
          placeholder="补充解释，不覆盖原文"
          onChange={(event) => setAnnotation(event.target.value)}
        />
      </label>
      <button type="submit" className="quiet-button" disabled={busy || !annotation.trim()}>追加标注</button>
    </form>}
  </div>;
}

function EvidenceRows({ opportunity }: { readonly opportunity: OpportunityDetail }) {
  const items = useMemo(() => opportunity.signals.slice(-4).reverse(), [opportunity.signals]);
  if (items.length === 0) return <p className="opc-record-empty">尚未记录市场信号</p>;
  return <div>{items.map((signal) => <div className={`opc-record-row ${signal.relationship}`} key={signal.id}>
    <strong>{signal.relationship === "support" ? "支持" : signal.relationship === "oppose" ? "反证" : "中立"}</strong>
    <small>{sourceLabel(signal.sourceKind)} · {formatDate(signal.observedAt)}</small><p>{signal.summary}</p>
  </div>)}</div>;
}

function InterviewGuide({ deliverables }: { readonly deliverables: readonly OpcDeliverablePreview[] }) {
  const content = deliverables.find((item) => item.kind === "interview_pack")?.content.guide;
  const guide = Array.isArray(content) ? content.filter((item): item is string => typeof item === "string") : [];
  if (guide.length === 0) return <p className="opc-record-empty">提纲正在随机会档案更新</p>;
  return <ol className="opc-interview-guide">{guide.map((question) => <li key={question}>{question}</li>)}</ol>;
}

function sourceLabel(source: string) {
  return ({ public_web: "公开网页", pasted: "粘贴内容", file: "文件", manual: "人工记录" } as Record<string, string>)[source] ?? source;
}

function evidenceLabel(level: OpportunityDetail["evidenceLevel"]) {
  return ({ none: "方案待验证", interest: "已有兴趣信号", commitment: "已有承诺证据", paid: "已有付费证据" })[level];
}

function apiMessage(error: unknown) {
  if (error instanceof ExportFileError) return error.message;
  if (error instanceof AgentOsApiError) {
    const field = error.detail.fieldIssues?.[0]?.message;
    return [error.detail.message, field, error.detail.action].filter(Boolean).join("。 ");
  }
  return "无法连接 Host。请检查服务后重试";
}

function lines(value: string): readonly string[] {
  return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function toMinorUnits(value: string): string {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/u);
  if (!match) return value.trim();
  return (BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0")).toString();
}

function localDateTime() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIso(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function formatPrice(amountMinor: string, currency: string) {
  try {
    const formatter = new Intl.NumberFormat("zh-CN", { style: "currency", currency });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    const amount = Number(amountMinor) / 10 ** fractionDigits;
    return Number.isFinite(amount) ? formatter.format(amount) : `${amountMinor} ${currency}`;
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

function decisionLabel(choice: "pursue" | "revise" | "stop") {
  return ({ pursue: "继续推进", revise: "修订方案", stop: "停止机会" })[choice];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
}

function guessCapture(raw: string, field: "目标客户" | "问题" | "假设") {
  const match = raw.match(new RegExp(`${field}[：:]([^；;]+)`, "u"));
  return match?.[1]?.trim() ?? "";
}
