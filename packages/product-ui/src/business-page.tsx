// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import type { BusinessObjectRef, EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseApiFailure, type EnterpriseBrowserClient } from './client.js';
import { BusinessFields, OBJECT_LABELS, objectTitle } from './business-fields.js';
import { Dialog, EmptyState, ErrorNotice, LoadingState, PageHeading, Status, useResource } from './components.js';
import { businessDate, formatDate, formatMoney } from './format.js';
import { BusinessCommandForm } from './business-command-form.js';
import { actionsForObject, createActionFor } from './business-command-model.js';
import { BUSINESS_GROUPS } from './navigation-state.js';
import { BusinessReferenceModel, sameBusinessReference } from './business-references.js';

export type BusinessView = EnterpriseContractTypes['EnterpriseBusinessObjectView'];
export type Workspace = EnterpriseContractTypes['EnterpriseWorkspaceView'];
const headings = { sales: ['客户与销售', '从客户需求到订单，保留每次业务确认。'], delivery: ['项目与交付', '按原始范围查看里程碑、交付版本和客户验收。'], finance: ['资金与复盘', '查看付款安排、实际收支和固定期间的经营记录。'] } as const;
function amountOf(view: BusinessView): unknown { for (const name of ['amountMinor', 'totalMinor', 'targetMinor', 'unitPriceMinor']) if (Object.hasOwn(view.values, name)) return view.values[name]; return undefined; }
function sameReference(a: BusinessObjectRef, b: BusinessObjectRef): boolean { return a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.objectType === b.objectType && a.objectId === b.objectId && a.streamVersion === b.streamVersion && a.digest === b.digest; }

export function BusinessPage({ api, workspace, group, selectedType, onTypeChange }: { api: EnterpriseBrowserClient; workspace: Workspace; group: keyof typeof BUSINESS_GROUPS; selectedType?: string; onTypeChange?: (type: string) => void }) {
  const categories: readonly string[] = BUSINESS_GROUPS[group];
  const [localType, setLocalType] = useState<string>(categories[0]!), [filter, setFilter] = useState('');
  const objectType = selectedType && categories.includes(selectedType) ? selectedType : localType;
  const [selected, setSelected] = useState<{ type: string; id: string }>(), [creating, setCreating] = useState(false), [notice, setNotice] = useState<unknown>();
  const listing = useResource(workspace.id, 'business-list:' + objectType, signal => api.query('listBusinessObjects', { path: { workspaceId: workspace.id, objectType } }, signal));
  const available = workspace.mode === 'builtin', rows = listing.data?.filter(item => objectTitle(item).toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  const hasAmounts = rows.some(row => amountOf(row) !== undefined), hasStatus = rows.some(row => typeof row.values.status === 'string'), hasCreatedAt = rows.some(row => typeof row.values.createdAt === 'string');
  const create = createActionFor(objectType), label = OBJECT_LABELS[objectType] ?? '业务记录';
  const reload = () => { setNotice(undefined); listing.reload(); };
  return <><PageHeading title={headings[group][0]} description={headings[group][1]} action={<button type="button" className="mn-button-secondary" onClick={reload}><RefreshCw size={15} aria-hidden="true" />重新载入</button>} />
    <div className="mn-tabs" role="tablist" aria-label="业务分类">{BUSINESS_GROUPS[group].map(type => <button key={type} className="mn-tab" type="button" role="tab" aria-selected={objectType === type} onClick={() => { setLocalType(type); onTypeChange?.(type); setSelected(undefined); setCreating(false); setFilter(''); setNotice(undefined); }}>{OBJECT_LABELS[type]}</button>)}</div>
    {notice !== undefined && <ErrorNotice error={notice} />}
    {!available ? <section className="mn-panel"><EmptyState title="Sales 业务连接尚未接入" detail="当前经营主体选择了外部系统模式。连接可用后，业务记录由负责系统提供。" unavailable /></section> : <section className="mn-panel">
      <div className="mn-toolbar"><label className="mn-search"><Search size={16} aria-hidden="true" /><span className="mn-sr-only">筛选{label}</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={'查找' + label} /></label><div className="mn-toolbar-actions">{listing.data && <span className="mn-small mn-muted">当前可见 {listing.data.length} 条</span>}{create && <button type="button" className="mn-button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" />{create.label}</button>}</div></div>
      {listing.status === 'loading' && <LoadingState />}{listing.status === 'error' && <div className="mn-panel-body"><ErrorNotice error={listing.error} onRetry={listing.reload} /></div>}
      {listing.status === 'ready' && (rows.length ? <div className="mn-table-wrap"><table className="mn-table"><thead><tr><th>{label}</th>{hasStatus && <th>当前状态</th>}{hasAmounts && <th>金额</th>}{hasCreatedAt && <th className="mn-table-created">创建时间</th>}<th className="mn-table-actions"><span className="mn-sr-only">操作</span></th></tr></thead><tbody>{rows.map(row => <tr key={row.reference.objectId}><td className="mn-table-main"><button type="button" onClick={() => setSelected({ type: objectType, id: row.reference.objectId })}>{objectTitle(row)}</button></td>{hasStatus && <td><Status value={row.values.status} /></td>}{hasAmounts && <td className="mn-number">{formatMoney(amountOf(row))}</td>}{hasCreatedAt && <td className="mn-muted mn-table-created">{formatDate(row.values.createdAt)}</td>}<td className="mn-table-actions"><button type="button" className="mn-link-button" onClick={() => setSelected({ type: objectType, id: row.reference.objectId })}>查看详情</button></td></tr>)}</tbody></table></div> : <EmptyState title={filter ? '没有匹配的记录' : '暂无可见' + label} detail={filter ? '请调整关键词后再查看。' : '当前列表只包含这个账号有权查看的记录。'} />)}
    </section>}
    {selected && <BusinessDetail api={api} workspace={workspace} objectType={selected.type} objectId={selected.id} onClose={() => setSelected(undefined)} onSaved={listing.reload} onRestricted={error => { setNotice(error); setSelected(undefined); listing.reload(); }} />}
    {creating && create && <Dialog title={create.label} onClose={() => setCreating(false)} wide><BusinessCommandForm api={api} workspace={workspace} definition={create} onSaved={() => { setCreating(false); listing.reload(); }} onCancel={() => setCreating(false)} onRestricted={error => { setNotice(error); setCreating(false); listing.reload(); }} /></Dialog>}
  </>;
}

function BusinessDetail({ api, workspace, objectType, objectId, onClose, onSaved, onRestricted }: { api: EnterpriseBrowserClient; workspace: Workspace; objectType: string; objectId: string; onClose: () => void; onSaved: () => void; onRestricted: (error: unknown) => void }) {
  const [action, setAction] = useState<string>();
  const detail = useResource(workspace.id, 'detail:' + objectType + ':' + objectId, async signal => {
    const path = { workspaceId: workspace.id, objectType, objectId };
    const view = await api.query('getBusinessObject', { path }, signal), capabilities = await api.query('getEnterpriseBusinessCapabilities', { path }, signal);
    if (!sameReference(view.reference, capabilities.reference)) throw new EnterpriseApiFailure({ status: 409, code: 'SOURCE_VERSION_CONFLICT' });
    return { view, capabilities };
  });
  const actions = actionsForObject(objectType), selectedAction = actions.find(item => item.command === action);
  const allowed = detail.data?.capabilities;
  return <Dialog title={(OBJECT_LABELS[objectType] ?? '业务记录') + '详情'} onClose={onClose} wide>
    {detail.status === 'loading' && <LoadingState />}{detail.status === 'error' && <ErrorNotice error={detail.error} onRetry={detail.reload} />}
    {detail.data && <><div className="mn-detail-section"><h2>{objectTitle(detail.data.view)}</h2><p className="mn-small mn-muted">当前第 {detail.data.view.reference.streamVersion} 版。业务操作由系统重新核对权限和原始版本。</p><ResolvedBusinessFields api={api} view={detail.data.view} capabilities={allowed!} /></div>
      {selectedAction ? <div className="mn-detail-section"><h2>{selectedAction.label}</h2><BusinessCommandForm key={selectedAction.command + ':' + detail.data.view.reference.streamVersion} api={api} workspace={workspace} definition={selectedAction} object={detail.data.view} capabilities={allowed} onSaved={() => { setAction(undefined); detail.reload(); onSaved(); }} onCancel={() => setAction(undefined)} onRestricted={onRestricted} /></div> : <>
        <BusinessSummary api={api} workspace={workspace} view={detail.data.view} />
        <div className="mn-detail-actions">{actions.filter(item => item.businessApproval ? allowed!.businessApprovalFields.length > 0 : allowed!.writableFields.length > 0).map(item => <button type="button" className="mn-button-secondary" key={item.command} onClick={() => setAction(item.command)}>{item.label}</button>)}</div>
        {actions.length > 0 && !allowed!.writableFields.length && !allowed!.businessApprovalFields.length && <p className="mn-small mn-muted">当前账号仅能查看这条记录。</p>}
      </>}
    </>}
  </Dialog>;
}

function ResolvedBusinessFields({ api, view, capabilities }: { api: EnterpriseBrowserClient; view: BusinessView; capabilities: EnterpriseContractTypes['EnterpriseBusinessCapabilities'] }) {
  const model = useMemo(() => new BusinessReferenceModel(api), [api]);
  const references = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  useEffect(() => { void model.load(view, capabilities); return () => model.clear(); }, [model, view, capabilities]);
  const current = references.data && sameBusinessReference(references.data.owner, view.reference) ? references.data.fields : undefined;
  return <>{references.status === 'error' && <ErrorNotice error={references.error} />}<BusinessFields objectType={view.reference.objectType} values={view.values} readableFields={capabilities.readableFields} names={Object.fromEntries(capabilities.people.map(person => [person.principalId, person.displayName]))} referenceNames={current} /></>;
}

function BusinessSummary({ api, workspace, view }: { api: EnterpriseBrowserClient; workspace: Workspace; view: BusinessView }) {
  if (view.reference.objectType === 'order') return <OrderBalance api={api} workspace={workspace} objectId={view.reference.objectId} version={view.reference.streamVersion} />;
  if (view.reference.objectType === 'project') return <ProjectSummary api={api} workspace={workspace} objectId={view.reference.objectId} version={view.reference.streamVersion} />;
  return null;
}
function OrderBalance({ api, workspace, objectId, version }: { api: EnterpriseBrowserClient; workspace: Workspace; objectId: string; version: number }) {
  const state = useResource(workspace.id, 'balance:' + objectId + ':' + version, signal => api.query('getBusinessBalance', { path: { workspaceId: workspace.id, orderId: objectId, asOfDate: businessDate() } }, signal));
  return <div className="mn-detail-section"><h2>订单资金</h2>{state.status === 'loading' && <LoadingState />}{state.status === 'error' && <ErrorNotice error={state.error} onRetry={state.reload} />}{state.data && <><p className="mn-small mn-muted">截至 {businessDate()}，金额来自服务端当前业务口径。</p><BusinessFields objectType="order" values={state.data.values} readableFields={Object.keys(state.data.values)} /></>}</div>;
}
function ProjectSummary({ api, workspace, objectId, version }: { api: EnterpriseBrowserClient; workspace: Workspace; objectId: string; version: number }) {
  const progress = useResource(workspace.id, 'progress:' + objectId + ':' + version, signal => api.query('getBusinessProgress', { path: { workspaceId: workspace.id, projectId: objectId } }, signal));
  const costs = useResource(workspace.id, 'costs:' + objectId + ':' + version, signal => api.query('getBusinessCosts', { path: { workspaceId: workspace.id, projectId: objectId } }, signal));
  return <div className="mn-detail-section"><h2>进度与成本</h2>{progress.status === 'error' && <ErrorNotice error={progress.error} onRetry={progress.reload} />}{progress.data && <BusinessFields objectType="project" values={progress.data.values} readableFields={Object.keys(progress.data.values)} />}{costs.status === 'error' && <ErrorNotice error={costs.error} onRetry={costs.reload} />}{costs.data && <>{!costs.data.values.costsComplete && <p className="mn-inline-note">成本尚未确认完整，暂不显示毛利。</p>}<BusinessFields objectType="project" values={costs.data.values} readableFields={Object.keys(costs.data.values).filter(key => key !== 'marginMinor' || costs.data!.values.costsComplete)} /></>}</div>;
}
