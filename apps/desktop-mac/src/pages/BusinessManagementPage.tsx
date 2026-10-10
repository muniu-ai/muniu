// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { BusinessContextTargetV2, BusinessCommandV1, BusinessManagementViewV1, BusinessPeriodV1, BusinessStateV1, BusinessSummaryV1 } from "@mn/contracts";
import { businessDateAt } from "@mn/contracts/client";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { BusinessStart } from "../Onboarding";
import { EmptyState, ErrorState, Loading } from "../components/Status";

const tabs = { overview: "经营总览", plan: "经营计划", customers: "客户", services: "产品与服务", orders: "报价与订单", delivery: "交付与验收", money: "收支记录", reviews: "周期复盘" } as const;
type Tab = keyof typeof tabs;
type CommandType = BusinessCommandV1["type"];
type Defaults = Readonly<Record<string, string | boolean | readonly string[]>>;
interface FormSpec { readonly type: CommandType; readonly id: string; readonly defaults?: Defaults }
interface Choice { readonly value: string; readonly label: string }
interface FieldSpec { readonly name: string; readonly label: string; readonly kind?: "date" | "number" | "textarea" | "select" | "checkbox" | "multiple"; readonly choices?: readonly Choice[]; readonly value?: string | boolean; readonly optional?: boolean; readonly hint?: string; readonly min?: number; readonly max?: number }
const labels: Record<CommandType, string> = {
  "plan.record": "保存经营计划", "customer.record": "保存客户", "service.record": "发布产品版本", "quote.create": "生成报价",
  "quote.confirm": "确认成交", "order.record": "登记已有订单", "order.adjust": "记录订单调整", "delivery.record": "记录交付",
  "acceptance.record": "登记客户验收", "payment.record": "登记收款", "payment.reverse": "冲销错误收款", "refund.record": "登记退款", "expense.record": "登记费用", "review.record": "保存周期复盘",
};
const today = () => businessDateAt(new Date().toISOString());
const currentPeriod = (): BusinessPeriodV1 => ({ start: `${today().slice(0, 7)}-01`, end: today() });
const makeId = (): string => crypto.randomUUID();
export function businessMoney(value: string): string {
  const amount = BigInt(value); const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
function minorUnits(value: string): string {
  if (!/^-?\d+(\.\d{1,2})?$/u.test(value)) throw new Error("金额请填写元，最多保留两位小数");
  const negative = value.startsWith("-"); const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return ((BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"))) * (negative ? -1n : 1n)).toString();
}
function message(error: unknown) { return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : error instanceof Error ? error.message : "经营记录暂时无法更新"; }
function latest<T extends { readonly id: string; readonly version: number }>(items: readonly T[]): T[] {
  const result = new Map<string, T>(); for (const item of items) if ((result.get(item.id)?.version ?? 0) < item.version) result.set(item.id, item);
  return [...result.values()];
}

export function BusinessManagementPage({ target, api, workspaceId, initialTab = "overview", onExplore, onDelegate }: { readonly target?: { readonly namespace: string; readonly resourceId: string }; readonly api: AgentOsClient; readonly workspaceId: string; readonly initialTab?: BusinessStart | "overview"; readonly onExplore: () => void; readonly onDelegate?: (target: BusinessContextTargetV2) => void }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [view, setView] = useState<BusinessManagementViewV1>();
  const [period, setPeriod] = useState<BusinessPeriodV1>(currentPeriod);
  const [form, setForm] = useState<FormSpec>();
  const [selectedOrderId, setSelectedOrderId] = useState<string>();
  const focusedTarget = useRef<typeof target>(undefined);
  useEffect(() => {
    if (!target) return;
    setTab(target.namespace === "opc.customer" ? "customers" : "orders"); setForm(undefined);
    setSelectedOrderId(target.namespace === "opc.order" ? target.resourceId : undefined);
  }, [target]);
  useEffect(() => {
    if (!target || !view || focusedTarget.current === target) return;
    const frame = requestAnimationFrame(() => {
      const element = [...document.querySelectorAll<HTMLElement>("[data-business-resource]")].find(item => item.dataset.businessResource === target.resourceId);
      if (element) { focusedTarget.current = target; element.scrollIntoView({ block: "center" }); element.focus({ preventScroll: true }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [target, view, tab]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const sequence = useRef(0); const epoch = useRef(0); const mounted = useRef(true);
  const pendingSave = useRef<{ readonly fingerprint: string; readonly expectedStreamVersion: number; readonly key: string } | undefined>(undefined);
  const apply = useCallback((next: BusinessManagementViewV1) => setView(current => !current || next.state.streamVersion >= current.state.streamVersion ? next : current), []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current; const startedEpoch = epoch.current;
    try { const next = await api.business(workspaceId, period); if (mounted.current && request === sequence.current && startedEpoch === epoch.current) { apply(next); setError(undefined); } }
    catch (caught) { if (mounted.current && request === sequence.current) { epoch.current += 1; setView(undefined); setError(message(caught)); } }
    finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [api, apply, period, workspaceId]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; epoch.current += 1; }; }, [refresh]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = api.watchWorkspaceEvents(workspaceId, () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void refresh(), 150); });
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [api, refresh, workspaceId]);
  function open(type: CommandType, defaults?: Defaults, id = makeId()) { pendingSave.current = undefined; setForm({ type, id, ...(defaults ? { defaults } : {}) }); setNotice(undefined); setError(undefined); setSaveError(undefined); }
  function cancelForm() { pendingSave.current = undefined; setForm(undefined); setSaveError(undefined); }
  async function save(command: BusinessCommandV1, expectedStreamVersion: number) {
    if (!view || busy) return;
    const fingerprint = JSON.stringify({ workspaceId, command });
    if (pendingSave.current?.fingerprint !== fingerprint) pendingSave.current = { fingerprint, expectedStreamVersion, key: makeId() };
    const request = pendingSave.current;
    setBusy(true); setError(undefined); setSaveError(undefined); setNotice(undefined); const startedEpoch = epoch.current;
    try {
      const next = await api.commandBusiness(workspaceId, request.expectedStreamVersion, command, request.key);
      if (!mounted.current || startedEpoch !== epoch.current) return;
      pendingSave.current = undefined;
      apply(next); setForm(undefined); setNotice(`${labels[command.type]}已完成`); await refresh();
    } catch (caught) {
      if (!mounted.current || startedEpoch !== epoch.current) return;
      if (caught instanceof AgentOsApiError && caught.status === 409) { pendingSave.current = undefined; setForm(undefined); await refresh(); setSaveError("记录已被其他入口更新。请重新打开表单，核对最新内容后再提交。"); }
      else if (caught instanceof AgentOsApiError && [403, 404].includes(caught.status)) { epoch.current += 1; setView(undefined); setSaveError(message(caught)); }
      else setSaveError(message(caught));
    } finally { if (mounted.current) setBusy(false); }
  }
  const state = view?.state;
  const customer = (id: string, version?: number) => state?.customers.slice().reverse().find(item => item.id === id && (version === undefined || item.version === version))?.name ?? "客户记录不可用";
  const service = (id: string, version: number) => state?.services.find(item => item.id === id && item.version === version)?.title ?? "产品记录不可用";
  const orderName = (id: string) => { const order = state?.orders.find(item => item.id === id); return order ? `${customer(order.customerId, order.customerVersion)} · ${service(order.serviceId, order.serviceVersion)}` : "订单记录不可用"; };
  const chooseTab = (next: Tab) => { setTab(next); cancelForm(); setNotice(undefined); };
  const selected = state?.orders.find(item => item.id === selectedOrderId);
  const recordDate = businessDateAt;
  return <div className="page-stack business-page">
    <header className="business-heading"><div><p className="eyebrow">OPC · 服务与项目型经营</p><h1>经营管理</h1><p>管理计划、客户、订单、交付与收支。当前工作区对应一个经营主体，金额使用人民币。</p></div><button className="secondary-button" onClick={onExplore}>机会验证</button></header>
    <nav className="business-tabs" aria-label="经营模块">{Object.entries(tabs).map(([key, label]) => <button key={key} aria-current={tab === key ? "page" : undefined} className={tab === key ? "active" : ""} onClick={() => chooseTab(key as Tab)}>{label}</button>)}</nav>
    {(error || saveError) && <ErrorState title="经营记录未更新" detail={error ?? saveError!} onRetry={() => void refresh()} />}
    {notice && <p className="business-notice" role="status">{notice}</p>}
    {tab === "overview" && <section className="panel business-period"><div><h2>经营概览</h2><p>流水按发生日期统计；历史已收作为期初记录，不计入本期现金。</p></div><label>统计开始<input type="date" aria-label="统计开始" value={period.start} onChange={event => setPeriod({ ...period, start: event.target.value })} /></label><label>统计截止<input type="date" aria-label="统计截止" value={period.end} onChange={event => setPeriod({ ...period, end: event.target.value })} /></label><button className="secondary-button" onClick={() => setPeriod(currentPeriod())}>恢复本月</button></section>}
    {loading && !state && <Loading label="正在读取经营记录" />}
    {state && view && <>
      {form && <BusinessForm key={`${form.type}:${form.id}`} form={form} state={state} busy={busy} onSave={save} onCancel={cancelForm} />}
      {tab === "overview" && <>

        <Summary summary={view.summary} />
        <section className="panel"><h2>下一步经营工作</h2><div className="business-actions"><button onClick={() => chooseTab("customers")}>跟进客户 · {latest(state.customers).filter(item => item.followUpOn && item.followUpOn <= today()).length} 项到期</button><button onClick={() => chooseTab("delivery")}>安排交付 · {view.summary.orders.filter(item => !item.accepted).length} 笔待验收</button><button onClick={() => chooseTab("money")}>核对收款 · {view.summary.orders.filter(item => BigInt(item.outstandingMinor) > 0n).length} 笔未结</button><button onClick={() => chooseTab("reviews")}>记录周期复盘</button></div></section>
      </>}
      {tab === "plan" && <><Toolbar title="经营计划" action="新增经营计划" onClick={() => open("plan.record")} /><Records empty="还没有经营计划">{state.plans.slice().reverse().map(item => <article key={`${item.id}:${item.revision}`}><h3>{item.title}<small>第 {item.revision} 版</small></h3><p>{item.period.start} 至 {item.period.end} · 复盘 {item.reviewOn}</p><dl><dt>目标客户</dt><dd>{item.targetCustomer}</dd><dt>客户价值</dt><dd>{item.valueProposition}</dd><dt>本期重点</dt><dd>{item.focus.join("；")}</dd><dt>资源约束</dt><dd>{item.resources}</dd></dl><button onClick={() => open("plan.record", { title: item.title, targetCustomer: item.targetCustomer, valueProposition: item.valueProposition, resources: item.resources, reviewOn: item.reviewOn, start: item.period.start, end: item.period.end, focus: item.focus.join("\n") }, item.id)}>修订计划</button></article>)}</Records></>}
      {tab === "customers" && <><Toolbar title="客户与需求" action="新增客户" onClick={() => open("customer.record")} /><Records empty="还没有客户，可先登记需求和来源">{latest(state.customers).map(item => <article key={item.id} tabIndex={-1} data-business-resource={item.id}><h3>{item.name}</h3><p>{item.need}</p><dl><dt>来源</dt><dd>{item.source}</dd><dt>联系资料</dt><dd>{item.contact || "未登记"}</dd><dt>下次跟进</dt><dd>{item.followUpOn || "未安排"}</dd></dl><button onClick={() => open("customer.record", { name: item.name, source: item.source, need: item.need, contact: item.contact ?? "", followUpOn: item.followUpOn ?? "" }, item.id)}>更新客户</button>{onDelegate && <button onClick={() => onDelegate({ kind: "customer", resourceId: item.id })}>交给 Agent</button>}</article>)}</Records></>}
      {tab === "services" && <><Toolbar title="产品与服务版本" action="新增产品或服务" onClick={() => open("service.record")} /><Records empty="先明确可销售范围、价格和验收标准">{state.services.slice().reverse().map(item => <article key={`${item.id}:${item.version}`}><h3>{item.title}<small>第 {item.version} 版 · ¥{businessMoney(item.priceMinor)}</small></h3><dl><dt>交付范围</dt><dd>{item.inScope.join("；")}</dd><dt>不包含</dt><dd>{item.outOfScope.join("；") || "未列出"}</dd><dt>验收标准</dt><dd>{item.acceptanceCriteria.join("；")}</dd></dl><button onClick={() => open("service.record", { title: item.title, price: businessMoney(item.priceMinor), inScope: item.inScope.join("\n"), outOfScope: item.outOfScope.join("\n"), acceptanceCriteria: item.acceptanceCriteria.join("\n") }, item.id)}>发布新版本</button></article>)}</Records></>}
      {tab === "orders" && <>
        <Toolbar title="报价与订单" action="新增报价" onClick={() => open("quote.create")} extra={<button className="secondary-button" onClick={() => open("order.record")}>登记已有订单</button>} />
        {(!state.customers.length || !state.services.length) && <p className="business-hint">请先登记客户和产品版本。已有订单可使用原合同，不需要补做机会验证或系统报价。</p>}
        <h2>报价记录</h2><Records empty="还没有报价">{state.quotes.slice().reverse().map(item => <article key={item.id}><h3>{customer(item.customerId, item.customerVersion)} · {service(item.serviceId, item.serviceVersion)}</h3><p>¥{businessMoney(item.totalMinor)} · 数量 {item.quantity} · 产品第 {item.serviceVersion} 版</p><p>有效期 {item.validUntil} · 付款期限 {item.dueOn}</p>{item.notes && <p>{item.notes}</p>}{state.orders.some(order => order.quoteId === item.id) ? <span className="pill">已确认成交</span> : <button onClick={() => open("quote.confirm", { quoteId: item.id })}>登记客户确认</button>}</article>)}</Records>
        <h2>订单记录</h2><Records empty="还没有订单">{state.orders.slice().reverse().map(item => <article key={item.id} tabIndex={-1} data-business-resource={item.id}><h3>{orderName(item.id)}</h3><p>约定 ¥{businessMoney(item.agreedAmountMinor)} · {item.contractedOn} 签订 · 付款期限 {item.dueOn}</p><p>{item.quoteId ? "来自已确认报价" : "来自已有合同"} · 依据：{item.sourceRef}</p>{item.opening && <p>截至 {item.opening.asOf}，历史已收 ¥{businessMoney(item.opening.receivedMinor)}，已交付 {item.opening.deliveredPercent}%</p>}<button onClick={() => setSelectedOrderId(selectedOrderId === item.id ? undefined : item.id)}>查看订单详情</button>{onDelegate && <button onClick={() => onDelegate({ kind: "order", resourceId: item.id })}>交给 Agent</button>}</article>)}</Records>
        {selected && <section className="panel business-order-detail"><h2>{orderName(selected.id)}</h2><p>固定产品第 {selected.serviceVersion} 版 · 客户第 {selected.customerVersion} 版</p><div className="business-actions"><button onClick={() => { chooseTab("delivery"); open("delivery.record", { orderId: selected.id }); }}>记录交付</button><button onClick={() => { chooseTab("money"); open("payment.record", { orderId: selected.id }); }}>登记收款</button><button onClick={() => open("order.adjust", { orderId: selected.id })}>调整订单金额或期限</button></div><h3>订单调整</h3>{state.adjustments.filter(item => item.orderId === selected.id).map(item => <p key={item.id}>{item.effectiveOn} · ¥{businessMoney(item.amountDeltaMinor)} · {item.reason} · {item.sourceRef}</p>)}<h3>确认依据</h3><p>{selected.sourceRef}</p>{selected.opening && <p>期初依据：{selected.opening.sourceRef}；期初客户验收：{selected.opening.accepted ? "已完成" : "未完成"}</p>}</section>}
      </>}
      {tab === "delivery" && <><Toolbar title="交付与客户验收" action="记录交付" onClick={() => open("delivery.record")} extra={<button className="secondary-button" onClick={() => open("acceptance.record")}>登记客户验收</button>} /><p className="business-hint">Agent 成果接收与客户验收分别记录。交付进度填写本次新增比例，累计不得超过 100%。</p><Records empty="还没有交付记录">{state.deliveries.slice().reverse().map(item => <article key={item.id}><h3>{item.title}</h3><p>{orderName(item.orderId)} · {item.deliveredOn} · 本次 {item.progressPercent}%</p><p>成果依据：{item.artifactRef}</p>{item.notes && <p>{item.notes}</p>}{onDelegate && <button onClick={() => onDelegate({ kind: "delivery", resourceId: item.id })}>交给 Agent</button>}</article>)}</Records><h2>客户验收记录</h2><Records empty="还没有客户验收记录">{state.acceptances.slice().reverse().map(item => <article key={item.id}><h3>{orderName(item.orderId)}</h3><p>{item.acceptedOn} · {item.complete ? "全部履约已验收" : "部分交付已验收"}</p><p>依据：{item.customerConfirmationRef}</p><p>验收交付：{item.deliveryIds.map(id => state.deliveries.find(delivery => delivery.id === id)?.title).join("、")}</p></article>)}</Records></>}
      {tab === "money" && <>
        <Toolbar title="收支与核对" action="登记收款" onClick={() => open("payment.record")} extra={<><button className="secondary-button" onClick={() => open("expense.record")}>登记费用</button><button className="secondary-button" onClick={() => open("refund.record")}>登记退款</button></>} />
        <p className="business-hint">这里只登记已发生的资金事实，不发起转账或银行核验。退款与合同金额调整分别记录。</p>
        <div className="business-table-wrap"><table><caption>截至 {view.summary.period?.end ?? today()} 的订单余额</caption><thead><tr><th>订单</th><th>约定金额</th><th>净收款</th><th>待收</th><th>交付</th><th>客户验收</th></tr></thead><tbody>{view.summary.orders.map(item => <tr key={item.orderId}><td>{orderName(item.orderId)}</td><td>¥{businessMoney(item.agreedAmountMinor)}</td><td>¥{businessMoney(item.netReceivedMinor)}</td><td>{item.overdue ? "逾期 " : ""}¥{businessMoney(item.outstandingMinor)}</td><td>{item.deliveredPercent}%</td><td>{item.accepted ? "完成" : "待完成"}</td></tr>)}</tbody></table></div>
        <h2>收款记录</h2><Records empty="还没有登记新收款">{state.payments.slice().reverse().map(item => <article key={item.id}><h3>¥{businessMoney(item.amountMinor)} · {orderName(item.orderId)}</h3><p>{item.receivedOn} · {item.sourceRef}</p>{state.paymentReversals.some(reversal => reversal.paymentId === item.id) ? <span className="pill">已冲销</span> : <button onClick={() => open("payment.reverse", { paymentId: item.id })}>冲销错误记录</button>}</article>)}</Records>
        <h2>期初已收</h2><Records empty="没有期初收款">{state.orders.filter(item => item.opening).map(item => <article key={item.id}><h3>{orderName(item.id)}</h3><p>截至 {item.opening!.asOf} 已收 ¥{businessMoney(item.opening!.receivedMinor)}，不计入本期现金。</p><p>{item.opening!.sourceRef}</p></article>)}</Records>
        <h2>费用与退款</h2><Records empty="没有费用或退款">{state.expenses.map(item => <article key={item.id}><h3>{item.category} · ¥{businessMoney(item.amountMinor)}</h3><p>{item.description} · {item.paidOn}</p><p>{item.orderId ? orderName(item.orderId) : "经营公共费用"} · {item.sourceRef}</p></article>)}{state.refunds.map(item => <article key={item.id}><h3>退款 ¥{businessMoney(item.amountMinor)}</h3><p>{orderName(item.orderId)} · {item.refundedOn}</p><p>{item.reason} · {item.sourceRef}</p></article>)}{state.paymentReversals.map(item => <article key={item.id}><h3>收款纠错</h3><p>{item.reversedOn} · {item.reason} · {item.sourceRef}</p></article>)}</Records>
      </>}
      {tab === "reviews" && <><Toolbar title="周期复盘" action="新增周期复盘" onClick={() => open("review.record")} /><p className="business-hint">复盘保存指定期间及当时的事实版本。之后新增的记录不会改写旧复盘。</p><Records empty="还没有周期复盘">{state.reviews.slice().reverse().map(item => <article key={item.id}><h3>{item.period.start} 至 {item.period.end}</h3><p>记录于 {recordDate(item.recordedAt)} · 事实版本 {item.sourceStreamVersion}</p><Summary summary={item.summary} compact /><h4>经营解释</h4><p>{item.explanation}</p><h4>下一步决定</h4><ul>{item.nextDecisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul>{onDelegate && <button onClick={() => onDelegate({ kind: "review", resourceId: item.id })}>交给 Agent</button>}</article>)}</Records></>}
    </>}
  </div>;
}

function Toolbar({ title, action, onClick, extra }: { title: string; action: string; onClick: () => void; extra?: React.ReactNode }) { return <div className="business-toolbar"><h2>{title}</h2><div><button className="primary-button" onClick={onClick}>{action}</button>{extra}</div></div>; }
function Records({ children, empty }: { children: React.ReactNode; empty: string }) {
  const count = Array.isArray(children) ? children.flat().filter(Boolean).length : children ? 1 : 0;
  return count ? <div className="business-records">{children}</div> : <EmptyState title={empty} detail="按当前业务事实填写，记录会保留来源与版本。" />;
}
function Summary({ summary, compact = false }: { summary: BusinessSummaryV1; compact?: boolean }) {
  const metrics = [["本期实收", summary.cashReceivedMinor], ["本期退款", summary.cashRefundedMinor], ["本期费用", summary.cashExpensesMinor], ["本期净流入", summary.netCashFlowMinor], ...(!compact ? [["待收款", summary.outstandingMinor], ["逾期待收", summary.overdueMinor]] : [])];
  return <section className={`business-metrics ${compact ? "compact" : ""}`} aria-label="经营指标">{metrics.map(([label, value]) => <div key={label}><small>{label}</small><strong>¥{businessMoney(value!)}</strong></div>)}</section>;
}

function BusinessForm({ form, state, busy, onSave, onCancel }: { form: FormSpec; state: BusinessStateV1; busy: boolean; onSave: (command: BusinessCommandV1, expectedStreamVersion: number) => Promise<void>; onCancel: () => void }) {
  const [error, setError] = useState<string>();
  const [orderId, setOrderId] = useState(String(form.defaults?.orderId ?? ""));
  const [formState] = useState(state);
  const fields = formFields(form.type, formState, orderId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined);
    try { await onSave(commandFromForm(form, new FormData(event.currentTarget)), formState.streamVersion); } catch (caught) { setError(message(caught)); }
  }
  return <section className="panel business-form-panel"><h2>{labels[form.type]}</h2><p>记录来源和实际发生日期。</p><form onSubmit={event => void submit(event)} aria-label={labels[form.type]}>
    <div className="business-fields">{fields.map(field => {
      const value = form.defaults?.[field.name] ?? field.value ?? "";
      if (field.kind === "checkbox") return <label className="check-row" key={field.name}><input name={field.name} type="checkbox" defaultChecked={value === true} /><span>{field.label}{field.hint && <small>{field.hint}</small>}</span></label>;
      if (field.kind === "multiple") return <fieldset key={field.name}><legend>{field.label}</legend>{field.choices?.map(choice => <label className="check-row" key={choice.value}><input name={field.name} type="checkbox" value={choice.value} /><span>{choice.label}</span></label>)}{!field.choices?.length && <p>先登记交付，再选择本次验收的交付记录。</p>}</fieldset>;
      return <label className="field" key={field.name}><span>{field.label}{field.optional ? "（可选）" : ""}</span>{field.kind === "select" ? <select name={field.name} required={!field.optional} defaultValue={String(value)} onChange={event => { if (field.name === "orderId") setOrderId(event.target.value); }}><option value="">{field.optional ? "不关联订单" : "请选择"}</option>{field.choices?.map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</select> : field.kind === "textarea" ? <textarea name={field.name} required={!field.optional} rows={3} defaultValue={String(value)} /> : <input name={field.name} type={field.kind ?? "text"} required={!field.optional} defaultValue={String(value)} min={field.min} max={field.max} step={field.kind === "number" ? 1 : undefined} />}{field.hint && <small>{field.hint}</small>}</label>;
    })}</div>{error && <p role="alert">{error}</p>}<footer><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={busy}>{busy ? "正在保存" : labels[form.type]}</button></footer>
  </form></section>;
}
function formFields(type: CommandType, state: BusinessStateV1, selectedOrderId: string): FieldSpec[] {
  const text = (name: string, label: string, optional = false): FieldSpec => ({ name, label, optional });
  const long = (name: string, label: string, optional = false): FieldSpec => ({ name, label, kind: "textarea", optional });
  const day = (name: string, label: string, value = today(), optional = false): FieldSpec => ({ name, label, kind: "date", value, optional });
  const amount = (name: string, label: string, value = ""): FieldSpec => ({ name, label: `${label}（元）`, value, hint: "人民币，最多两位小数" });
  const select = (name: string, label: string, choices: readonly Choice[], optional = false): FieldSpec => ({ name, label, kind: "select", choices, optional });
  const customerName = (id: string) => state.customers.slice().reverse().find(item => item.id === id)?.name ?? id;
  const orderLabel = (id: string) => { const order = state.orders.find(item => item.id === id); return order ? `${customerName(order.customerId)} · ${state.services.find(item => item.id === order.serviceId && item.version === order.serviceVersion)?.title} · ${order.contractedOn}` : id; };
  const customers = select("customerId", "客户", latest(state.customers).map(item => ({ value: item.id, label: item.name })));
  const services = select("service", "产品版本", state.services.map(item => ({ value: JSON.stringify([item.id, item.version]), label: `${item.title} · 第 ${item.version} 版 · ¥${businessMoney(item.priceMinor)}` })));
  const orders = (optional = false) => select("orderId", "关联订单", state.orders.map(item => ({ value: item.id, label: orderLabel(item.id) })), optional);
  const payments = select("paymentId", "原收款记录", state.payments.filter(item => !state.paymentReversals.some(reversal => reversal.paymentId === item.id)).map(item => ({ value: item.id, label: `${orderLabel(item.orderId)} · ${item.receivedOn} · ¥${businessMoney(item.amountMinor)}` })));
  const source = text("sourceRef", "事实依据");
  const quantity: FieldSpec = { name: "quantity", label: "数量", kind: "number", value: "1", min: 1 };
  switch (type) {
    case "plan.record": return [text("title", "计划名称"), day("start", "周期开始", currentPeriod().start), day("end", "周期结束"), text("targetCustomer", "目标客户"), long("valueProposition", "提供的客户价值"), long("focus", "本期重点（每行一项）"), long("resources", "资源与时间约束"), day("reviewOn", "复盘日期")];
    case "customer.record": return [text("name", "客户名称"), text("source", "客户来源"), long("need", "客户需求"), text("contact", "联系资料", true), day("followUpOn", "下次跟进日期", "", true)];
    case "service.record": return [text("title", "产品或服务名称"), amount("price", "标准价格"), long("inScope", "交付范围（每行一项）"), long("outOfScope", "不包含事项（每行一项）", true), long("acceptanceCriteria", "验收标准（每行一项）")];
    case "quote.create": return [customers, services, quantity, amount("discount", "优惠金额", "0"), day("validUntil", "报价有效期"), day("dueOn", "付款期限"), long("notes", "报价备注", true)];
    case "quote.confirm": return [select("quoteId", "待确认报价", state.quotes.filter(item => !state.orders.some(order => order.quoteId === item.id)).map(item => ({ value: item.id, label: `${customerName(item.customerId)} · ¥${businessMoney(item.totalMinor)}` }))), day("confirmedOn", "客户确认日期"), { ...source, hint: "填写客户确认报价的原始依据，不以 Agent 建议代替客户确认" }];
    case "order.record": return [customers, services, quantity, amount("agreedAmount", "合同金额"), day("contractedOn", "合同日期"), day("dueOn", "付款期限"), { ...source, label: "原合同或客户确认依据" }, day("asOf", "期初截止日期"), amount("openingReceived", "截至期初已收", "0"), { name: "openingDelivered", label: "截至期初已交付（%）", kind: "number", min: 0, max: 100, value: "0" }, { name: "openingAccepted", label: "期初已完成全部客户验收", kind: "checkbox", hint: "仅在已交付 100% 且有确认依据时勾选" }, text("openingSourceRef", "期初收款与交付依据")];
    case "order.adjust": return [orders(), amount("amountDelta", "合同金额调整", "0"), day("effectiveOn", "调整生效日期"), day("dueOn", "调整后的付款期限", "", true), long("reason", "调整原因"), source];
    case "delivery.record": return [orders(), text("title", "本次交付名称"), day("deliveredOn", "实际交付日期"), { name: "progressPercent", label: "本次新增交付（%）", kind: "number", min: 1, max: 100, value: "100" }, text("artifactRef", "交付成果依据"), long("notes", "交付说明", true)];
    case "acceptance.record": return [orders(), { name: "deliveryIds", label: "本次验收的交付", kind: "multiple", choices: state.deliveries.filter(item => item.orderId === selectedOrderId).map(item => ({ value: item.id, label: `${orderLabel(item.orderId)} · ${item.title}` })) }, day("acceptedOn", "客户验收日期"), text("customerConfirmationRef", "客户验收依据"), { name: "complete", label: "客户已确认全部履约完成", kind: "checkbox" }];
    case "payment.record": return [orders(), amount("amount", "实际收款金额"), day("receivedOn", "实际收款日期"), source];
    case "payment.reverse": return [payments, day("reversedOn", "纠错日期"), long("reason", "错误原因"), source];
    case "refund.record": return [select("refundSource", "原收款或期初记录", [...payments.choices!.map(item => ({ ...item, value: JSON.stringify(["payment", item.value]) })), ...state.orders.filter(item => item.opening && BigInt(item.opening.receivedMinor) > 0n).map(item => ({ value: JSON.stringify(["opening", item.id]), label: `${orderLabel(item.id)} · 期初已收 ¥${businessMoney(item.opening!.receivedMinor)}` }))]), amount("amount", "实际退款金额"), day("refundedOn", "实际退款日期"), long("reason", "退款原因"), source];
    case "expense.record": return [orders(true), text("category", "费用类别"), long("description", "费用说明"), amount("amount", "实际支出金额"), day("paidOn", "实际支出日期"), source];
    case "review.record": return [day("start", "复盘开始", currentPeriod().start), day("end", "复盘截止"), long("explanation", "事实解释与偏差"), long("nextDecisions", "下一周期决定（每行一项）")];
  }
}
function commandFromForm(form: FormSpec, data: FormData): BusinessCommandV1 {
  const str = (name: string) => String(data.get(name) ?? "").trim();
  const optional = (name: string) => str(name) ? { [name]: str(name) } : {};
  const lines = (name: string) => str(name).split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
  const money = (name: string) => minorUnits(str(name));
  const checked = (name: string) => data.get(name) === "on";
  const period = { start: str("start"), end: str("end") };
  const [serviceId, version] = str("service") ? JSON.parse(str("service")) as [string, number] : ["", 0];
  const orderId = str("orderId"); const sourceRef = str("sourceRef"); const type = form.type;
  switch (type) {
    case "plan.record": return { type, planId: form.id, title: str("title"), period, targetCustomer: str("targetCustomer"), valueProposition: str("valueProposition"), focus: lines("focus"), resources: str("resources"), reviewOn: str("reviewOn") };
    case "customer.record": return { type, customerId: form.id, name: str("name"), source: str("source"), need: str("need"), ...optional("contact"), ...optional("followUpOn") };
    case "service.record": return { type, serviceId: form.id, title: str("title"), currency: "CNY", priceMinor: money("price"), inScope: lines("inScope"), outOfScope: lines("outOfScope"), acceptanceCriteria: lines("acceptanceCriteria") };
    case "quote.create": return { type, quoteId: form.id, customerId: str("customerId"), serviceId, serviceVersion: Number(version), quantity: Number(str("quantity")), discountMinor: money("discount"), validUntil: str("validUntil"), dueOn: str("dueOn"), ...optional("notes") };
    case "quote.confirm": return { type, quoteId: str("quoteId"), orderId: form.id, confirmedOn: str("confirmedOn"), sourceRef };
    case "order.record": return { type, orderId: form.id, customerId: str("customerId"), serviceId, serviceVersion: Number(version), quantity: Number(str("quantity")), agreedAmountMinor: money("agreedAmount"), contractedOn: str("contractedOn"), dueOn: str("dueOn"), sourceRef, opening: { asOf: str("asOf"), receivedMinor: money("openingReceived"), deliveredPercent: Number(str("openingDelivered")), accepted: checked("openingAccepted"), sourceRef: str("openingSourceRef") } };
    case "order.adjust": return { type, adjustmentId: form.id, orderId, amountDeltaMinor: money("amountDelta"), effectiveOn: str("effectiveOn"), ...optional("dueOn"), reason: str("reason"), sourceRef };
    case "delivery.record": return { type, deliveryId: form.id, orderId, title: str("title"), deliveredOn: str("deliveredOn"), progressPercent: Number(str("progressPercent")), artifactRef: str("artifactRef"), ...optional("notes") };
    case "acceptance.record": return { type, acceptanceId: form.id, orderId, deliveryIds: data.getAll("deliveryIds").map(String), acceptedOn: str("acceptedOn"), customerConfirmationRef: str("customerConfirmationRef"), complete: checked("complete") };
    case "payment.record": return { type, paymentId: form.id, orderId, amountMinor: money("amount"), receivedOn: str("receivedOn"), sourceRef };
    case "payment.reverse": return { type, reversalId: form.id, paymentId: str("paymentId"), reversedOn: str("reversedOn"), reason: str("reason"), sourceRef };
    case "refund.record": { const [kind, id] = JSON.parse(str("refundSource")) as [string, string]; return { type, refundId: form.id, ...(kind === "opening" ? { openingOrderId: id! } : { paymentId: id! }), amountMinor: money("amount"), refundedOn: str("refundedOn"), reason: str("reason"), sourceRef }; }
    case "expense.record": return { type, expenseId: form.id, ...optional("orderId"), category: str("category"), description: str("description"), amountMinor: money("amount"), paidOn: str("paidOn"), sourceRef };
    case "review.record": return { type, reviewId: form.id, period, explanation: str("explanation"), nextDecisions: lines("nextDecisions") };
  }
}
