// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Download, Plus, Search } from 'lucide-react';
import type { BusinessObjectRef, EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseApiFailure, type EnterpriseBrowserClient, type MutationTicket } from './client.js';
import { FIELD_LABELS, OBJECT_LABELS, objectTitle } from './business-fields.js';
import { Dialog, EmptyState, ErrorNotice, LoadingState, PageHeading, Status, useResource } from './components.js';
import { formatDate } from './format.js';
import type { BusinessView, Workspace } from './business-page.js';
import { submissionError, useSubmission } from './submission-ui.js';

export interface DownloadRequest { readonly bytesBase64: string; readonly mediaType: string; readonly fileName: string; }
export type DownloadFile = (request: DownloadRequest) => Promise<void>;
const formats = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const classes = [{ id: 'public', label: '一般业务资料' }, { id: 'price', label: '包含价格或回款' }, { id: 'cost', label: '包含成本' }, { id: 'contact', label: '包含联系方式' }] as const;
type Classification = typeof classes[number]['id'];

export function KnowledgePage({ api, workspace, download }: { api: EnterpriseBrowserClient; workspace: Workspace; download: DownloadFile }) {
  const [input, setInput] = useState(''), [query, setQuery] = useState(''), [creating, setCreating] = useState(false), [reading, setReading] = useState<BusinessObjectRef>();
  return <><PageHeading title="知识与成果" description="资料与业务记录关联保存，检索和读取均按当前对象与字段权限过滤。" action={<button className="mn-button" type="button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" />导入资料</button>} />
    <section className="mn-panel"><div className="mn-toolbar"><form className="mn-toolbar-actions" onSubmit={event => { event.preventDefault(); if (input.trim()) setQuery(input.trim()); }}><label className="mn-search"><Search size={16} aria-hidden="true" /><span className="mn-sr-only">搜索业务资料</span><input required maxLength={500} value={input} onChange={event => setInput(event.target.value)} placeholder="需求、条款或交付说明" /></label><button className="mn-button-secondary">搜索资料</button></form></div>
      {query ? <KnowledgeResults key={workspace.id + query} api={api} workspace={workspace} query={query} onRead={setReading} /> : <EmptyState title="从业务资料中查找" detail="输入关键词，查看当前账号有权访问的原始资料与已启用经验。" />}
    </section>
    <p className="mn-small mn-muted">成果集中列表和工作验收入口将在后续阶段接入；本页不会把候选内容显示为已验收成果。</p>
    {creating && <Dialog title="导入业务资料" onClose={() => setCreating(false)}><DocumentImporter api={api} workspace={workspace} onSaved={reference => { setCreating(false); setReading(reference); setQuery(''); }} onCancel={() => setCreating(false)} /></Dialog>}
    {reading && <KnowledgeDetail api={api} workspace={workspace} reference={reading} download={download} onClose={() => setReading(undefined)} />}
  </>;
}
function KnowledgeResults({ api, workspace, query, onRead }: { api: EnterpriseBrowserClient; workspace: Workspace; query: string; onRead: (reference: BusinessObjectRef) => void }) {
  const state = useResource(workspace.id, 'knowledge-search:' + query, signal => api.query('searchEnterpriseKnowledge', { path: { workspaceId: workspace.id }, body: { query, limit: 30 } }, signal));
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <div className="mn-panel-body"><ErrorNotice error={state.error} onRetry={state.reload} /></div>;
  if (!state.data?.hits.length) return <EmptyState title="没有匹配的可见资料" detail="请调整关键词；被撤回或无权访问的资料不会出现在结果中。" />;
  return <ul className="mn-list">{state.data.hits.map((hit, index) => <li className="mn-list-row" key={hit.citation.id + ':' + index}><div><h3><button type="button" className="mn-link-button" onClick={() => onRead(hit.reference)}>{hit.title}</button></h3><p className="mn-reading">{hit.text.slice(0, 220)}</p></div><span className="mn-tag">第 {hit.reference.streamVersion} 版</span></li>)}</ul>;
}
function DocumentImporter({ api, workspace, onSaved, onCancel }: { api: EnterpriseBrowserClient; workspace: Workspace; onSaved: (reference: BusinessObjectRef) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(''), [file, setFile] = useState<File>(), [sourceType, setSourceType] = useState('customer'), [selected, setSelected] = useState<BusinessView>();
  const [binding, setBinding] = useState<EnterpriseContractTypes['EnterpriseSourceScope']>(), [classification, setClassification] = useState<Classification[]>(['public']), [shared, setShared] = useState(false);
  const [documentId] = useState(() => crypto.randomUUID()), [ticket, setTicket] = useState<MutationTicket<'importEnterpriseDocument'>>(), [error, setError] = useState<unknown>();
  const submission = useSubmission('导入资料'), { busy, uncertain } = submission;
  const records = useResource(workspace.id, 'import-sources:' + sourceType, signal => api.query('listBusinessObjects', { path: { workspaceId: workspace.id, objectType: sourceType } }, signal));
  const save = async () => {
    if (submission.chain.snapshot().busy) return;
    setError(undefined);
    try {
      const saved = await submission.run(async scope => {
        let pending = ticket;
        if (!pending) {
          if (!file || !title.trim() || !binding?.fields.length) throw new Error('请填写标题、选择文件，并核对关联资料字段');
          if (file.size === 0) throw new Error('文件为空，请选择有内容的资料');
          if (file.size > 8 * 1024 * 1024) throw new Error('单个文件不能超过 8 MB');
          const extension = file.name.split('.').at(-1)?.toLowerCase(), types: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf', docx: formats.docx, xlsx: formats.xlsx };
          if (!extension || !types[extension]) throw new Error('请选择文本、Markdown、PDF、Word 或 Excel 文件');
          const bytes = new Uint8Array(await scope.read(() => file.arrayBuffer())); let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          pending = api.prepareMutation('importEnterpriseDocument', { path: { workspaceId: workspace.id }, body: { documentId, expectedStreamVersion: 0, title: title.trim(), fileName: file.name, mediaType: types[extension]!, contentBase64: btoa(binary), bindings: [binding], classification, visibility: shared ? 'business_scope' : 'private' } });
          setTicket(pending);
        }
        return scope.write({ key: pending.key, label: '导入资料', execute: signal => api.executeMutation(pending!, signal) });
      });
      if (submission.isMounted()) onSaved(saved.reference);
    } catch (cause) { if (submission.isMounted()) { setError(submissionError(cause, submission.chain)); if (!submission.chain.snapshot().pendingKey) setTicket(undefined); } }
  };
  return <form className="mn-form" onSubmit={event => { event.preventDefault(); void save(); }}>{error !== undefined && <ErrorNotice error={error} />}<fieldset className="mn-form-fields" disabled={busy || uncertain}>
    <label>资料标题<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>资料文件<input type="file" required accept=".txt,.md,.pdf,.docx,.xlsx" onChange={event => setFile(event.target.files?.[0])} /><span className="mn-form-field-note">支持文本、Markdown、PDF、Word、Excel，单个文件不超过 8 MB。</span></label>
    <div className="mn-form-grid"><label>关联业务类型<select value={sourceType} onChange={event => { setSourceType(event.target.value); setSelected(undefined); setBinding(undefined); }}>{['customer', 'opportunity', 'order', 'project'].map(type => <option key={type} value={type}>{OBJECT_LABELS[type]}</option>)}</select></label>
      <label>关联业务记录<select required value={selected?.reference.objectId ?? ''} onChange={event => { setSelected(records.data?.find(item => item.reference.objectId === event.target.value)); setBinding(undefined); }}><option value="">请选择</option>{records.data?.map(item => <option key={item.reference.objectId} value={item.reference.objectId}>{objectTitle(item)}</option>)}</select></label></div>
    {records.status === 'error' && <ErrorNotice error={records.error} onRetry={records.reload} />}
    {selected && <SourceFields key={selected.reference.objectId} api={api} workspace={workspace} object={selected} onChange={setBinding} />}
    <fieldset className="mn-fieldset"><legend>资料内容分类</legend>{classes.map(item => <label className="mn-checkbox" key={item.id}><input type="checkbox" checked={classification.includes(item.id)} disabled={item.id === 'public'} onChange={event => setClassification(value => event.target.checked ? [...value, item.id] : value.filter(entry => entry !== item.id))} />{item.label}</label>)}</fieldset>
    <label className="mn-checkbox"><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} />按关联业务权限共享；未选择时仅本人可见</label>
  </fieldset><div className="mn-form-footer"><button type="button" className="mn-button-secondary" disabled={busy} onClick={() => { if (!submission.chain.snapshot().busy) onCancel(); }}>{uncertain ? '关闭并稍后核对' : '取消'}</button><button className="mn-button" disabled={busy || (!ticket && !binding?.fields.length)}>{busy ? '正在导入…' : uncertain ? '重试原请求' : '保存资料'}</button></div></form>;
}
function SourceFields({ api, workspace, object, onChange }: { api: EnterpriseBrowserClient; workspace: Workspace; object: BusinessView; onChange: (binding: EnterpriseContractTypes['EnterpriseSourceScope'] | undefined) => void }) {
  const [fields, setFields] = useState<string[]>([]);
  const state = useResource(workspace.id, 'source-fields:' + object.reference.objectId, async signal => {
    const result = await api.query('getEnterpriseBusinessCapabilities', { path: { workspaceId: workspace.id, objectType: object.reference.objectType, objectId: object.reference.objectId } }, signal);
    if (result.reference.digest !== object.reference.digest || result.reference.streamVersion !== object.reference.streamVersion) throw new EnterpriseApiFailure({ status: 409, code: 'SOURCE_VERSION_CONFLICT' }); return result;
  });
  useEffect(() => { if (state.status !== 'ready') { setFields([]); onChange(undefined); } }, [state.status, onChange]);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorNotice error={state.error} onRetry={state.reload} />;
  const allowed = state.data?.readableFields.filter(name => Object.hasOwn(object.values, name) && ['name', 'title', 'scope', 'scopeLines', 'summary', 'description', 'lines', 'totalMinor', 'amountMinor', 'currency', 'status'].includes(name)) ?? [];
  return <fieldset className="mn-fieldset"><legend>关联资料字段</legend>{allowed.map(name => <label className="mn-checkbox" key={name}><input type="checkbox" checked={fields.includes(name)} onChange={event => { const selected = event.target.checked ? [...fields, name] : fields.filter(field => field !== name); setFields(selected); onChange(selected.length ? { reference: object.reference, fields: selected } : undefined); }} />{FIELD_LABELS[name]}</label>)}<span className="mn-form-field-note">请选择这份资料涉及的业务字段。后续读取会重新核对这些字段的权限。</span></fieldset>;
}
function KnowledgeDetail({ api, workspace, reference, download, onClose }: { api: EnterpriseBrowserClient; workspace: Workspace; reference: BusinessObjectRef; download: DownloadFile; onClose: () => void }) {
  const state = useResource(workspace.id, 'knowledge-read:' + reference.objectId, signal => api.query('readEnterpriseKnowledge', { path: { workspaceId: workspace.id }, body: reference }, signal));
  const [format, setFormat] = useState<keyof typeof formats>('docx'), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const exportFile = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await api.query('exportEnterpriseKnowledge', { path: { workspaceId: workspace.id }, body: { reference, format } });
      if (result.mediaType !== formats[format]) throw new EnterpriseApiFailure({ status: 503, code: 'INVALID_SERVICE_RESPONSE' });
      await download({ ...result, fileName: (state.data?.title ?? '业务资料').replace(/[\\/:*?"<>|]/gu, '_') + '.' + format });
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  };
  return <Dialog title="业务资料" onClose={onClose} busy={busy} wide>{state.status === 'loading' && <LoadingState />}{state.status === 'error' && <ErrorNotice error={state.error} onRetry={state.reload} />}{state.data && <><div className="mn-page-heading"><div><h2>{state.data.title}</h2><p className="mn-small mn-muted">第 {state.data.revision} 版 · {formatDate(state.data.createdAt)}</p></div><Status value={state.data.extraction.status} /></div>
    {state.data.extraction.status !== 'complete' && <p className="mn-inline-note">原资料已保存，部分内容未能提取。请核对下列提取结果与原文件。</p>}
    {state.data.extraction.issues.map((issue, index) => <p className="mn-alert" key={index}>{issue.message}</p>)}
    {state.data.extraction.blocks.map(block => <section className="mn-detail-section" key={block.id}><p className="mn-small mn-muted">{block.locator.page ? '第 ' + block.locator.page + ' 页' : block.locator.sheet ? '工作表 ' + block.locator.sheet : block.locator.paragraph ? '第 ' + block.locator.paragraph + ' 段' : '原始内容'}</p><p className="mn-reading">{block.text}</p></section>)}
    {error !== undefined && <ErrorNotice error={error} />}<div className="mn-detail-actions"><label className="mn-sr-only" htmlFor="knowledge-export-format">导出格式</label><select className="mn-form-input" id="knowledge-export-format" value={format} disabled={busy} onChange={event => setFormat(event.target.value as keyof typeof formats)}>{(['docx', 'pdf', 'xlsx'] as const).map(item => <option value={item} key={item}>{item === 'docx' ? 'Word' : item === 'xlsx' ? 'Excel' : 'PDF'}</option>)}</select><button type="button" className="mn-button-secondary" disabled={busy} onClick={() => void exportFile()}><Download size={15} aria-hidden="true" />{busy ? '正在导出…' : '导出当前资料'}</button></div>
  </>}</Dialog>;
}
