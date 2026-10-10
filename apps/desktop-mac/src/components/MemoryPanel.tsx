// SPDX-License-Identifier: Apache-2.0
import { useCallback } from 'react';
import type { AgentOsClient } from '../api';
import { MemoryCard } from './MemoryCard';
import { useReuseRead } from './ReuseState';
export function MemoryPanel({ api, workspaceId, professional }: { api: AgentOsClient; workspaceId: string; professional: boolean }) {
  const read = useReuseRead(api, workspaceId, useCallback(() => api.memories(workspaceId), [api, workspaceId]));
  return <section className="panel settings-section" aria-label="记忆与偏好"><h2>记忆与偏好</h2><p>模型提出的信息需确认后才能跨任务采用。资料撤权或更新后，先核对来源，再创建新提案。</p>
    {read.error && <p role="alert">{read.error}</p>}{!read.value && !read.error && <p role="status">正在核对记忆来源…</p>}
    <div className="memory-list">{read.value?.map(memory => <MemoryCard key={memory.id} api={api} workspaceId={workspaceId} memory={memory} professional={professional} onChanged={() => void read.reload()}
      onDecide={async (item, decision, key) => { await api.decideMemory(item.id, item.streamVersion, decision, key); }}
      onRevise={async (item, summary, key) => { await api.reviseMemory(item.id, item.streamVersion, summary, item.confidence, key); }}
      onDelete={async (item, key) => { await api.deleteMemory(item.id, item.streamVersion, '用户在设置中确认删除', key); }} />)}</div>
    {read.value?.length === 0 && <p>还没有记忆提案。</p>}
  </section>;
}
