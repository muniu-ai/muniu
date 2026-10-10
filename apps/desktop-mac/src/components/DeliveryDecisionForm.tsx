// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { GoalDeliverableSpecV2, GoalDeliveryItemDecisionV2, GoalOutputRefV2 } from '@mn/contracts';
export interface DeliveryDecisionDraft { readonly decision: '' | 'accept' | 'defer' | 'request_changes'; readonly criteria?: readonly string[]; readonly instruction?: string; readonly reason?: string }
export function buildDeliveryDecisions(specs: readonly GoalDeliverableSpecV2[], outputs: readonly GoalOutputRefV2[], drafts: Readonly<Record<string, DeliveryDecisionDraft>>): readonly GoalDeliveryItemDecisionV2[] | null {
  const items: GoalDeliveryItemDecisionV2[] = [];
  for (const output of outputs) {
    const draft = drafts[output.key]; if (!draft?.decision) continue;
    const spec = specs.find(item => item.key === output.key); if (!spec) return null;
    const criteria = [...new Set(draft.criteria ?? [])];
    if (criteria.some(id => !spec.criteria.some(item => item.id === id))) return null;
    if (draft.decision === 'accept') {
      if (criteria.length !== spec.criteria.length || !output.checks.length || output.checks.some(check => check.status !== 'passed')) return null;
      items.push({key:output.key,digest:output.digest,decision:'accept',reviewedCriterionIds:criteria});
    } else if (draft.decision === 'request_changes') {
      if (!criteria.length || !draft.instruction?.trim()) return null;
      items.push({key:output.key,digest:output.digest,decision:'request_changes',failedCriterionIds:criteria,instruction:draft.instruction.trim()});
    } else items.push({key:output.key,digest:output.digest,decision:'defer',...(draft.reason?.trim() ? {reason:draft.reason.trim()} : {})});
  }
  return items.length ? items : null;
}
export function DeliveryDecisionForm({specs,outputs,disabled=false,allowAccept=true,onSubmit}: {specs:readonly GoalDeliverableSpecV2[];outputs:readonly GoalOutputRefV2[];disabled?:boolean;allowAccept?:boolean;onSubmit:(items:readonly GoalDeliveryItemDecisionV2[])=>void}) {
  const [drafts,setDrafts]=useState<Readonly<Record<string,DeliveryDecisionDraft>>>({});
  function update(key:string,patch:Partial<DeliveryDecisionDraft>) { setDrafts(previous=>({...previous,[key]:{decision:'',...previous[key],...patch}})); }
  const items= !allowAccept && Object.values(drafts).some(draft=>draft.decision==='accept') ? null : buildDeliveryDecisions(specs,outputs,drafts);
  return <form aria-label="逐项验收" onSubmit={event=>{event.preventDefault();if(items&&!disabled)onSubmit(items);}}><h3>逐项验收</h3><p>只保存已选择的决定，其他成果保留原决定。接收 Agent 成果后仍需单独登记客户验收。</p>
    {outputs.map(output=>{const spec=specs.find(item=>item.key===output.key);const draft=drafts[output.key];return <fieldset key={output.key} disabled={disabled}><legend>{spec?.title??output.key}</legend>
      <label className="field">验收决定<select aria-label={`${spec?.title??output.key}的验收决定`} value={draft?.decision??''} onChange={event=>update(output.key,{decision:event.target.value as DeliveryDecisionDraft['decision'],criteria:[]})}><option value="">请选择决定</option><option value="accept" disabled={!allowAccept||!output.checks.length||output.checks.some(check=>check.status!=='passed')}>接收</option><option value="request_changes">要求修改</option><option value="defer">暂缓</option></select></label>
      {(draft?.decision==='accept'||draft?.decision==='request_changes')&&<><p>{draft.decision==='accept'?'逐条确认已满足的验收标准。':'仅选择未满足的验收标准。'}</p>{spec?.criteria.map(criterion=><label className="goal-criterion" key={criterion.id}><input type="checkbox" checked={draft.criteria?.includes(criterion.id)??false} onChange={event=>update(output.key,{criteria:event.target.checked?[...(draft.criteria??[]),criterion.id]:(draft.criteria??[]).filter(id=>id!==criterion.id)})}/>{criterion.description}</label>)}</>}
      {draft?.decision==='request_changes'&&<label className="field">修改说明<textarea required maxLength={4000} value={draft.instruction??''} onChange={event=>update(output.key,{instruction:event.target.value})}/></label>}
      {draft?.decision==='defer'&&<label className="field">暂缓原因（可选）<textarea maxLength={4000} value={draft.reason??''} onChange={event=>update(output.key,{reason:event.target.value})}/></label>}
    </fieldset>;})}<button className="primary-button" disabled={disabled||!items}>保存逐项决定</button></form>;
}
