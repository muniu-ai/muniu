// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { BusinessObjectRef, EnterpriseContractTypes, EvidenceRef } from '@mn/contracts';
import { EnterpriseApiFailure, type EnterpriseBrowserClient, type MutationTicket } from './client.js';
import { ADJUSTMENT_KINDS, businessCommandSchema, buildBusinessCommand, lineOptions, referenceTypes, REFERENCE_TYPES, type BusinessAction, type BusinessObjectView, type Schema } from './business-command-model.js';
import { FIELD_LABELS, OBJECT_LABELS, objectTitle } from './business-fields.js';
import { EmptyState, ErrorNotice, LoadingState, useResource } from './components.js';
import { businessDate, formatDate, formatMoney, moneyInputValue, statusLabel } from './format.js';
import type { Workspace } from './business-page.js';
import { submissionError, useSubmission } from './submission-ui.js';
import { CustomerCreationModel, customerCreationScope } from './customer-creation-model.js';

const labels: Readonly<Record<string, string>> = { ...FIELD_LABELS, email: '电子邮箱', phone: '电话', service: '服务版本', supersedes: '替代旧服务版本', lineId: '范围明细', quoteLineId: '报价明细', orderLineId: '原订单明细', quantity: '数量', acceptanceCriteria: '验收条件', expenseRefs: '纳入核对的费用', zeroCost: '已核实本项目没有成本', includeCosts: '在复盘中纳入已授权的成本信息', milestones: '受影响的里程碑' };
const hidden = new Set(['type', 'id', 'expectedStreamVersion', 'evidence', 'kind', 'departmentId']);
type Fields = Record<string, unknown>;
type Sources = Readonly<Record<string, readonly BusinessObjectView[]>>;
function initialValue(schema: Schema): unknown {
  if ('const' in schema) return schema.const;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => initialValue(schema.items ?? {}) ?? {});
  if (schema.type === 'object') return {};
  return undefined;
}
function initialDraft(action: BusinessAction, object?: BusinessObjectView): Fields {
  const schema = businessCommandSchema(action), result: Fields = {};
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if (hidden.has(key)) continue;
    if (object && Object.hasOwn(object.values, key)) result[key] = structuredClone(object.values[key]);
    else if (key === 'businessDate') result[key] = businessDate();
    else if (schema.required?.includes(key)) { const value = initialValue(field); if (value !== undefined) result[key] = value; }
  }
  return result;
}
function referenceOf(value: unknown): BusinessObjectRef | undefined { return value && typeof value === 'object' && 'objectType' in value && 'objectId' in value ? value as BusinessObjectRef : undefined; }
function sameObject(a: BusinessObjectRef, b: BusinessObjectRef): boolean { return a.objectType === b.objectType && a.objectId === b.objectId && a.workspaceId === b.workspaceId && a.tenantId === b.tenantId; }
function recordLabel(view: BusinessObjectView): string {
  const title = objectTitle(view), parts = [title], values = view.values;
  if (title === (OBJECT_LABELS[view.reference.objectType] ?? '业务记录') + '记录') {
    const lines = Array.isArray(values.scopeLines) ? values.scopeLines : Array.isArray(values.lines) ? values.lines : [];
    const titles = [...new Set(lines.flatMap(line => line && typeof line === 'object' && 'title' in line && typeof line.title === 'string' && line.title.trim() ? [line.title] : []))];
    if (titles.length) parts.push(titles.slice(0, 3).join('、') + (titles.length > 3 ? '等' : ''));
  }
  const amount = ['totalMinor', 'amountMinor', 'unitPriceMinor', 'targetMinor'].map(field => values[field]).find(value => typeof value === 'number' && Number.isSafeInteger(value));
  if (amount !== undefined) parts.push(formatMoney(amount));
  if (typeof values.status === 'string') parts.push(statusLabel(values.status));
  const date = values.dueDate ?? values.businessDate;
  if (typeof date === 'string') parts.push(formatDate(date));
  parts.push('第 ' + view.reference.streamVersion + ' 版');
  return parts.join(' · ');
}
function SchemaFields({ schema, values, onChange, sources, draft, object, parentRow, prefix = '' }: { schema: Schema; values: Fields; onChange: (value: Fields) => void; sources: Sources; draft: Fields; object?: BusinessObjectView; parentRow?: Fields; prefix?: string }) {
  return <>{Object.entries(schema.properties ?? {}).filter(([key]) => !hidden.has(key)).map(([name, field]) => <ControlledField key={name} name={name} schema={field} value={values[name]} required={schema.required?.includes(name) === true} sources={sources} draft={draft} row={{ ...parentRow, ...values }} object={object} prefix={prefix + name} onChange={value => {
    const next = { ...values }; if (value === undefined) delete next[name]; else next[name] = value;
    if (name === 'milestone' && schema.properties?.expectedStreamVersion) { const reference = referenceOf(value); if (reference) next.expectedStreamVersion = reference.streamVersion; else delete next.expectedStreamVersion; }
    onChange(next);
  }} />)}</>;
}
function ControlledField({ name, schema, value, required, onChange, sources, draft, row, object, prefix }: { name: string; schema: Schema; value: unknown; required: boolean; onChange: (value: unknown) => void; sources: Sources; draft: Fields; row: Fields; object?: BusinessObjectView; prefix: string }) {
  const label = labels[name];
  if (!label) return <p className="mn-alert">当前界面尚未接入这项业务字段。</p>;
  if (schema.$ref === '#/components/schemas/BusinessObjectRef' || name === 'supersedes') {
    const type = REFERENCE_TYPES[name], options = type ? sources[type] ?? [] : [], current = referenceOf(value);
    const selected = name === 'supersedes' ? typeof (value as Fields | undefined)?.id === 'string' ? String((value as Fields).id) : '' : current?.objectId ?? '';
    return <label>{label}{!required && '（可选）'}<select required={required} value={selected} onChange={event => {
      const selected = options.find(item => item.reference.objectId === event.target.value);
      onChange(selected ? name === 'supersedes' ? { id: selected.reference.objectId, expectedStreamVersion: selected.reference.streamVersion } : selected.reference : undefined);
    }}><option value="">请选择{OBJECT_LABELS[type ?? ''] ?? '关联记录'}</option>{options.map(item => <option key={item.reference.objectId} value={item.reference.objectId}>{recordLabel(item)}</option>)}</select>{options.length === 0 && <span className="mn-form-field-note">没有当前账号可选的关联记录，请先建立记录或核对业务权限。</span>}</label>;
  }
  if (['lineId', 'quoteLineId', 'orderLineId'].includes(name)) {
    const flattened = Object.values(sources).flat();
    const sourceReference = [row.milestone, draft.contract, draft.milestone, draft.delivery, draft.project, draft.order, object?.values.project, object?.values.order].map(referenceOf).find(Boolean);
    let source = sourceReference ? flattened.find(item => sameObject(item.reference, sourceReference)) : object;
    if (name === 'orderLineId' && source?.reference.objectType === 'project') { const order = referenceOf(source.values.order); if (order) source = flattened.find(item => sameObject(item.reference, order)); }
    const options = lineOptions(source);
    return <label>{label}<select required={required} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value || undefined)}><option value="">请选择业务明细</option>{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{options.length === 0 && <span className="mn-form-field-note">请先选择关联业务记录。只有已获准的原始明细可供选择。</span>}</label>;
  }
  if (schema.oneOf) {
    const current = value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
    const distinct = (branch: Schema) => Object.keys(branch.properties ?? {}).filter(key => schema.oneOf!.some(other => !Object.hasOwn(other.properties ?? {}, key)));
    const selected = Math.max(0, schema.oneOf.findIndex(branch => distinct(branch).some(key => Object.hasOwn(current, key))));
    return <fieldset className="mn-fieldset"><legend>{label}</legend><label>明细来源<select value={selected} onChange={event => { const branch = schema.oneOf![Number(event.target.value)]!, key = distinct(branch)[0]; onChange(key ? { [key]: undefined } : {}); }}>{schema.oneOf.map((branch, index) => <option value={index} key={index}>{branch.properties?.service ? '服务目录' : branch.properties?.orderLineId ? '原订单明细' : '业务明细'}</option>)}</select></label><SchemaFields schema={schema.oneOf[selected]!} values={current} onChange={onChange} sources={sources} draft={draft} object={object} parentRow={row} prefix={prefix + '.'} /></fieldset>;
  }
  if (schema.type === 'array') {
    const values = Array.isArray(value) ? value : [], item = schema.items ?? {};
    if (item.type === 'string') return <label>{label}<textarea required={required} value={values.join('\n')} onChange={event => onChange(event.target.value.split('\n').filter(line => line.trim()))} /><span className="mn-form-field-note">每行填写一项。</span></label>;
    return <fieldset className="mn-fieldset"><legend>{label}</legend>{values.map((entry, index) => <div className="mn-array-item" key={index}><div className="mn-array-heading"><span>第 {index + 1} 项</span><button type="button" className="mn-link-button" disabled={values.length <= (schema.minItems ?? 0)} onClick={() => onChange(values.filter((_, position) => position !== index))}>移除</button></div>{item.$ref || item.oneOf ? <ControlledField name={name === 'expenseRefs' ? 'expenseRefs' : name} schema={item} value={entry} required onChange={next => onChange(values.map((current, position) => position === index ? next : current))} sources={sources} draft={draft} row={row} object={object} prefix={prefix + '.' + index} /> : <SchemaFields schema={item} values={entry && typeof entry === 'object' ? entry as Fields : {}} onChange={next => onChange(values.map((current, position) => position === index ? next : current))} sources={sources} draft={draft} object={object} parentRow={row} prefix={prefix + '.' + index + '.'} />}</div>)}<button type="button" className="mn-button-secondary" disabled={values.length >= (schema.maxItems ?? 100)} onClick={() => onChange([...values, initialValue(item) ?? {}])}>添加一项</button></fieldset>;
  }
  if (schema.type === 'object') return <fieldset className="mn-fieldset"><legend>{label}</legend><SchemaFields schema={schema} values={value && typeof value === 'object' ? value as Fields : {}} onChange={onChange} sources={sources} draft={draft} object={object} parentRow={row} prefix={prefix + '.'} /></fieldset>;
  if (schema.type === 'boolean') return <label className="mn-checkbox"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />{label}</label>;
  if (schema.enum) return <label>{label}<select required={required} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value || undefined)}><option value="">请选择</option>{schema.enum.map(choice => <option key={String(choice)} value={String(choice)}>{({ net_received: '净回款', outstanding: '应收余额', confirmed_cost: '已确认成本' } as Readonly<Record<string, string>>)[String(choice)] ?? String(choice)}</option>)}</select></label>;
  if (schema.type === 'integer' || schema.type === 'number') {
    const monetary = /Minor$/u.test(name);
    return <label>{label}{monetary ? '（元）' : ''}<input type={monetary ? 'text' : 'number'} inputMode={monetary ? 'decimal' : 'numeric'} required={required} step={monetary ? undefined : '1'} min={monetary ? undefined : schema.minimum} value={typeof value === 'string' ? value : typeof value === 'number' ? monetary ? moneyInputValue(value) : value : ''} onChange={event => onChange(event.target.value === '' ? undefined : monetary ? event.target.value : Number(event.target.value))} /></label>;
  }
  if (schema.format === 'date-time') {
    const date = typeof value === 'string' ? new Date(value) : undefined;
    const local = date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace(' ', 'T') : '';
    return <label>{label}<input type="datetime-local" required={required} value={local} onChange={event => { const parsed = event.target.value && new Date(event.target.value + '+08:00'); onChange(parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined); }} /><span className="mn-form-field-note">按北京时间保存。</span></label>;
  }
  if (schema.format === 'date') return <label>{label}<input type="date" required={required} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value || undefined)} /></label>;
  const multiline = (schema.maxLength ?? 0) > 1000;
  return <label>{label}{!required && '（可选）'}{multiline ? <textarea required={required} maxLength={schema.maxLength} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value || undefined)} /> : <input required={required} maxLength={schema.maxLength} type={name === 'email' ? 'email' : 'text'} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value || undefined)} />}</label>;
}

export function BusinessCommandForm({ api, workspace, definition, object, capabilities, onSaved, onCancel, onRestricted }: { api: EnterpriseBrowserClient; workspace: Workspace; definition: BusinessAction; object?: BusinessObjectView; capabilities?: EnterpriseContractTypes['EnterpriseBusinessCapabilities']; onSaved: (value: BusinessObjectView) => void; onCancel: () => void; onRestricted: (error: unknown) => void }) {
  const [variant, setVariant] = useState(definition.variant), action = useMemo(() => ({ ...definition, ...(variant ? { variant } : {}) }), [definition, variant]);
  const schema = businessCommandSchema(action), [draft, setDraft] = useState<Fields>(() => initialDraft(action, object)), [recordId] = useState(() => crypto.randomUUID());
  const [attestation, setAttestation] = useState(''), [confirmed, setConfirmed] = useState(false), [evidence, setEvidence] = useState<EvidenceRef>();
  const [evidenceTicket, setEvidenceTicket] = useState<MutationTicket<'recordBusinessEvidence'>>(), [ticket, setTicket] = useState<MutationTicket<'executeBusinessCommand'>>();
  const [error, setError] = useState<unknown>(), submission = useSubmission(definition.label), { busy, uncertain } = submission;
  const customerCreation = action.command === 'customer.create', customerName = typeof draft.name === 'string' ? draft.name : '';
  const creationModel = useMemo(() => new CustomerCreationModel(api), [api]);
  const creationDraft = useMemo(() => ({ tenantId: workspace.tenantId, workspaceId: workspace.id, recordId, name: customerName }), [workspace.tenantId, workspace.id, recordId, customerName]);
  const creation = useSyncExternalStore(creationModel.subscribe, creationModel.snapshot, creationModel.snapshot);
  useEffect(() => {
    creationModel.clear();
    const timer = customerCreation && customerName.trim() ? window.setTimeout(() => { void creationModel.load(creationDraft); }, 250) : undefined;
    return () => { if (timer !== undefined) window.clearTimeout(timer); creationModel.clear(); };
  }, [creationModel, creationDraft, customerCreation, customerName]);
  const creationCurrent = creation.workspaceId === customerCreationScope(creationDraft);
  const creationChoices = creationCurrent && creation.status === 'ready' ? creation.data?.choices : undefined;
  const creationBlocked = customerCreation && (!creationChoices || !creationChoices.allowUnassigned && !creation.selectedDepartmentId);
  const sources = useResource<Sources>(workspace.id, 'form-sources:' + action.command + ':' + (variant ?? ''), async signal => {
    const types = new Set(referenceTypes(action)); if (action.command === 'change_request.price') { types.add('project'); types.add('order'); }
    const result: Record<string, readonly BusinessObjectView[]> = {};
    for (const objectType of types) result[objectType] = await api.query('listBusinessObjects', { path: { workspaceId: workspace.id, objectType } }, signal);
    return result;
  });
  const contactBlocked = action.command === 'contact.update' && !['name', 'email', 'phone'].every(field => capabilities?.readableFields.includes(field));
  const proofBlocked = action.evidence && (!object || !capabilities?.canRecordEvidence);
  const save = async () => {
    if (submission.chain.snapshot().busy || proofBlocked || contactBlocked || sources.status !== 'ready' || !ticket && creationBlocked) return;
    setError(undefined);
    try {
      const result = await submission.run(async scope => {
        if (ticket) return scope.write({ key: ticket.key, label: action.label, execute: signal => api.executeMutation(ticket, signal) });
        let proof = evidence;
        if (action.confirmation && !confirmed) throw new Error('请确认已核对当前记录');
        if (action.evidence && !proof) {
          if (!attestation.trim()) throw new Error('请填写实际核对依据');
          const pending = evidenceTicket ?? api.prepareMutation('recordBusinessEvidence', { path: { workspaceId: workspace.id }, body: { subject: object!.reference, attestation: attestation.trim(), additionalFieldClasses: [] } });
          setEvidenceTicket(pending); proof = await scope.write({ key: pending.key, label: '核对说明', execute: signal => api.executeMutation(pending, signal) }); setEvidence(proof);
        }
        const command = customerCreation ? creationModel.build(creationDraft) : buildBusinessCommand(action, { ...draft, ...(proof ? { evidence: proof } : {}) }, { tenantId: workspace.tenantId, workspaceId: workspace.id, recordId, object });
        const checked = await scope.read(signal => api.query('checkEnterpriseBusinessCommand', { path: { workspaceId: workspace.id }, body: command }, signal));
        if (!checked.allowedNow) throw new EnterpriseApiFailure({ status: /DENIED|REVOKED/u.test(checked.reasonCode ?? '') ? 403 : 409, code: checked.reasonCode ?? 'BUSINESS_CHECK_FAILED' });
        const pending = api.prepareMutation('executeBusinessCommand', { path: { workspaceId: workspace.id }, body: command }); setTicket(pending);
        return scope.write({ key: pending.key, label: action.label, execute: signal => api.executeMutation(pending, signal) });
      });
      if (submission.isMounted()) onSaved(result);
    } catch (cause) {
      if (!submission.isMounted()) return;
      const result = submissionError(cause, submission.chain); setError(result);
      if (!submission.chain.snapshot().pendingKey) setTicket(undefined);
      if (result instanceof EnterpriseApiFailure && result.status === 403) onRestricted(result);
    }
  };
  let unavailable: ReactNode;
  if (contactBlocked) unavailable = <EmptyState title="当前无法完整修改联系人" detail="修改联系人会替换姓名及联系方式。请先取得这些字段的读取权限，避免覆盖不可见内容。" unavailable />;
  if (proofBlocked) unavailable = <EmptyState title="当前无法登记核对依据" detail="请由能完整核对当前内容且拥有相应业务权限的人员处理。" unavailable />;
  return <form className="mn-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    {action.explanation && <p className="mn-inline-note">{action.explanation}</p>}
    {definition.variant && <label>调整方式<select value={variant} disabled={busy || uncertain} onChange={event => { setVariant(event.target.value); setDraft(initialDraft({ ...definition, variant: event.target.value }, object)); setError(undefined); }}>{ADJUSTMENT_KINDS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
    {error !== undefined && <ErrorNotice error={error} />}{evidence && <p className="mn-small mn-muted">核对说明已保存。业务决定须以下方实际提交结果为准。</p>}
    {sources.status === 'loading' && <LoadingState />}{sources.status === 'error' && <ErrorNotice error={sources.error} onRetry={sources.reload} />}
    {unavailable ?? (sources.data && <fieldset className="mn-form-fields" disabled={busy || uncertain}><SchemaFields schema={schema} values={draft} onChange={next => { if (customerCreation && next.name !== draft.name) creationModel.clear(); setDraft(next); }} sources={sources.data} draft={draft} object={object} />
      {customerCreation && <div className="mn-customer-department">
        {!customerName.trim() ? <p className="mn-form-field-note">填写客户名称后，可选择有权使用的归属部门。</p> : creationCurrent && creation.status === 'error' ? <ErrorNotice error={creation.error} onRetry={() => { void creationModel.load(creationDraft); }} /> : !creationChoices ? <p className="mn-form-field-note" role="status">正在核对客户归属…</p> : !creationChoices.allowUnassigned && creationChoices.departments.length === 0 ? <p className="mn-alert" role="alert">当前账号没有新建此客户的业务权限。请联系企业管理员核对权限。</p> : <label>归属部门<select required={!creationChoices.allowUnassigned} value={creation.selectedDepartmentId ?? ''} onChange={event => { try { creationModel.selectDepartment(event.target.value || undefined); setError(undefined); } catch (cause) { setError(cause); } }}>
          <option value="">{creationChoices.allowUnassigned ? '不指定部门' : '请选择归属部门'}</option>{creationChoices.departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select><span className="mn-form-field-note">只列出本次客户可使用的归属部门，保存时会再次核对业务权限。</span></label>}
      </div>}
      {action.evidence && <label>实际核对依据<textarea required maxLength={4000} value={attestation} disabled={!!evidence} onChange={event => setAttestation(event.target.value)} placeholder="说明核对的资料、实际发生情况和确认依据" /></label>}
      {action.confirmation && <label className="mn-checkbox"><input type="checkbox" checked={confirmed} required onChange={event => setConfirmed(event.target.checked)} />我已核对上方当前内容，明确提交本次业务决定</label>}
    </fieldset>)}
    <div className="mn-form-footer"><button type="button" className="mn-button-secondary" disabled={busy} onClick={() => { if (!submission.chain.snapshot().busy) onCancel(); }}>{uncertain ? '关闭并稍后核对' : '取消'}</button><button className="mn-button" type="submit" disabled={busy || !!unavailable || sources.status !== 'ready' || !ticket && creationBlocked}>{busy ? '正在保存…' : uncertain ? '重试原请求' : action.label}</button></div>
  </form>;
}
