// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { AlertCircle, MemoryStick } from 'lucide-react';
import type { MemorySummary } from '../types';
import type { MemoryAccessV2, MemoryActionV2, MemoryProvenanceV2 } from '@mn/contracts';
import type { AgentOsClient } from '../api';
import { useReuseAction } from './ReuseState';
type Memory = MemorySummary & { readonly provenance?: MemoryProvenanceV2; readonly access?: MemoryAccessV2; readonly allowedActions?: readonly MemoryActionV2[] };
export function MemoryCard({ memory, professional, onDecide, onRevise, onDelete, api, workspaceId, onChanged }: {
  readonly api: AgentOsClient; readonly workspaceId: string; readonly onChanged?: () => void;
  readonly memory: Memory; readonly professional: boolean;
  readonly onDecide: (memory: MemorySummary, decision: 'accept' | 'reject', key: string) => Promise<void>;
  readonly onRevise: (memory: MemorySummary, summary: string, key: string) => Promise<void>;
  readonly onDelete: (memory: MemorySummary, key: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false), [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(memory.summary);
  const action = useReuseAction(api, workspaceId, `memory:${memory.id}`, () => { setEditing(false); setConfirmingDelete(false); onChanged?.(); });
  const readable = memory.access === undefined || memory.access === 'readable';
  const allowed = (action: MemoryActionV2) => memory.allowedActions?.includes(action) ?? (memory.status !== 'invalidated' && (action === 'delete' || memory.status === 'proposed'));
  useEffect(() => { setDraft(readable ? memory.summary : ''); setEditing(false); setConfirmingDelete(false); }, [memory.id, memory.streamVersion, readable]);
  const mutate = action.run;
  const blocked = action.locked, summary = readable ? memory.summary : ({ stale: '来源已更新', revoked: '来源已撤权', unavailable: '来源暂不可用' }[memory.access as 'stale' | 'revoked' | 'unavailable']);
  return <article aria-label="记忆提案"><span className="attention-icon"><MemoryStick size={16} /></span><div>
    <header><strong>{summary}</strong><span className={`pill ${memory.status}`}>{memory.status === 'proposed' ? '待确认' : memory.status === 'accepted' ? '已确认' : '不可用'}</span></header>
    {memory.provenance ? <p>{memory.provenance.kind === 'fact' ? '事实' : '偏好'} · {memory.provenance.origin === 'model' ? '模型提议' : '用户提供'}；经营事实仍以经营记录为准。</p> : <p>来源：已记录活动 · 置信度 {Math.round(memory.confidence * 100)}%</p>}
    {readable && memory.provenance && <details><summary>记忆来源</summary>{memory.provenance.sourceRefs.length ? <ul>{memory.provenance.sourceRefs.map(ref => <li key={`${ref.namespace}:${ref.resourceId}`}>{ref.namespace} · {ref.resourceId} · 版本 {ref.streamVersion}</li>)}</ul> : <p>用户提供的信息，没有关联资料。</p>}</details>}
    {readable && professional && <small>{memory.source} · {memory.namespace} / {memory.resourceId}</small>}
    {!readable && <p>内容已隐藏。请核对来源，或删除后创建新的提案。</p>}
    {action.error && <p role="alert">{action.error}</p>}
    {action.pending && !action.busy && <button onClick={action.retry}>重试记忆操作</button>}
    {readable && editing && <div className="memory-editor"><label>记忆内容<input aria-label="记忆内容" disabled={blocked} value={draft} onChange={event => setDraft(event.target.value)} /></label><button disabled={blocked} onClick={() => setEditing(false)}>取消</button><button className="secondary-button" disabled={blocked || !draft.trim() || !allowed('revise')} onClick={() => mutate(key => onRevise(memory, draft.trim(), key))}>保存记忆修改</button></div>}
    {confirmingDelete && <div className="governance-note"><AlertCircle size={18} /><p>将删除当前数据库中的记忆与密钥记录，保留删除审计。历史备份需另行处理；已发送给模型的数据无法召回。</p><button disabled={blocked} onClick={() => setConfirmingDelete(false)}>取消</button><button className="danger-button" disabled={blocked || !allowed('delete')} onClick={() => mutate(key => onDelete(memory, key))}>确认删除记忆</button></div>}
    {!editing && !confirmingDelete && <footer>
      {readable && allowed('reject') && <button disabled={blocked} onClick={() => mutate(key => onDecide(memory, 'reject', key))}>拒绝</button>}
      {readable && allowed('revise') && <button disabled={blocked} aria-label={`修改记忆：${summary}`} onClick={() => setEditing(true)}>修改</button>}
      {readable && allowed('accept') && <button className="secondary-button" disabled={blocked} onClick={() => mutate(key => onDecide(memory, 'accept', key))}>接受</button>}
      {allowed('delete') && <button className="danger-button" disabled={blocked} aria-label={`删除记忆：${summary}`} onClick={() => setConfirmingDelete(true)}>删除</button>}
    </footer>}
  </div></article>;
}
