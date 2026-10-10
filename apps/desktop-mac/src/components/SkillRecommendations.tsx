// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamSkillSummaryV2, TeamSkillVersionV2 } from '@mn/contracts';
import type { AgentOsClient } from '../api';
import { reuseFailure, useReuseRead } from './ReuseState';
export function SkillRecommendationList({ items, disabled, onUse }: { items: readonly TeamSkillSummaryV2[]; disabled?: boolean; onUse: (item: TeamSkillSummaryV2) => void }) {
 const recommended = items.filter(item => item.recommended && item.available && item.validation === 'passed');
 if (!recommended.length) return null;
 return <section aria-label="已验证的技能建议"><h4>已验证的技能建议</h4><p>这些版本已启用推荐并符合本目标条件。采用后生成新计划修订，仍需确认后执行。</p>{recommended.map(item => <article key={`${item.id}:${item.version}`}><strong>{item.title} · 版本 {item.version}</strong><p>{item.description}</p><button className="secondary-button" disabled={disabled} onClick={() => onUse(item)}>采用建议技能生成计划</button></article>)}</section>;
}
export function SkillRecommendations({ api, workspaceId, goalId, disabled, onUse }: { api: AgentOsClient; workspaceId: string; goalId: string; disabled: boolean; onUse: (version: TeamSkillVersionV2) => void }) {
 const list = useReuseRead(api, workspaceId, useCallback(() => api.teamSkills(workspaceId, goalId), [api, workspaceId, goalId]));
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), epoch = useRef(0);
 useEffect(() => { const stop = api.watchWorkspaceEvents(workspaceId, () => { epoch.current++; setBusy(false); setError(undefined); }); return () => { epoch.current++; stop(); }; }, [api, workspaceId, goalId]);
 async function useVersion(item: TeamSkillSummaryV2) {
  if (disabled || busy) return;
  const request = ++epoch.current; setBusy(true); setError(undefined);
  try { const detail = await api.teamSkill(workspaceId, item.id, item.version); if (request !== epoch.current) return;
   if (!detail.allowedActions.trial || detail.version.skillId !== item.id || detail.version.version !== item.version || detail.version.digest !== item.digest) throw new Error('技能建议已变化，请重新核对');
   onUse(detail.version);
  } catch (caught) { if (request === epoch.current) setError(reuseFailure(caught)); }
  finally { if (request === epoch.current) setBusy(false); }
 }
 return <>{error && <p role="alert">{error}</p>}<SkillRecommendationList items={list.value?.items ?? []} disabled={disabled || busy} onUse={item => void useVersion(item)} /></>;
}
