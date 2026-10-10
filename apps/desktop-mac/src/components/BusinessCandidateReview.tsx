// SPDX-License-Identifier: Apache-2.0
import type { OpcBusinessCandidateDetailV2 } from '@mn/contracts';
import { formatTeamCost } from './GoalPlanView';
const value=(input:unknown)=>input===null?'未设置':typeof input==='string'?input:JSON.stringify(input,null,2);
export function BusinessCandidateReview({detail,disabled=false,onDecide}:{detail:OpcBusinessCandidateDetailV2;disabled?:boolean;onDecide:(decision:'apply'|'reject')=>void}) {
 const {candidate,decision,availability}=detail;
 return <article className="panel" aria-label="经营候选审阅"><h3>{candidate.proposal.title}</h3><p>{candidate.proposal.rationale}</p>
 <div className="business-table-wrap"><table><caption>拟修改的经营记录</caption><thead><tr><th>字段</th><th>当前内容</th><th>采纳后</th></tr></thead><tbody>{candidate.changes.map(change=><tr key={change.path}><th>{change.label}</th><td><pre>{value(change.before)}</pre></td><td><pre>{value(change.after)}</pre></td></tr>)}</tbody></table></div>
 <h4>经营影响</h4>{candidate.impact.quoteTotalMinor!==undefined&&<p>报价金额：{formatTeamCost(candidate.impact.quoteTotalMinor,'CNY')}</p>}
 <p>合同金额变化：{formatTeamCost(candidate.impact.contractedDeltaMinor,'CNY')} · 应收变化：{formatTeamCost(candidate.impact.outstandingDeltaMinor,'CNY')} · 已收变化：{formatTeamCost(candidate.impact.cashReceivedDeltaMinor,'CNY')}</p>
 <p>采纳报价草稿、客户接受报价、订单生效与实际收款分别记录。</p>
 <details><summary>依据与成果版本</summary><p>任务 {candidate.origin.goalId} · 成果 {candidate.origin.outputKey}</p><ul>{candidate.sourceRefs.map(ref=><li key={`${ref.namespace}:${ref.resourceId}`}>{ref.namespace} · {ref.resourceId} · 版本 {ref.streamVersion}</li>)}</ul></details>
 {!!availability.staleReasons.length&&<div role="alert"><p>候选依据已变化，请重新核验。</p><ul>{availability.staleReasons.map(reason=><li key={reason}>{reason}</li>)}</ul></div>}
 {decision?<p role="status">{decision.decision==='apply'?'已采纳':'已拒绝'}</p>:<><button className="primary-button" disabled={disabled||!availability.apply} onClick={()=>onDecide('apply')}>采纳候选</button><button className="secondary-button" disabled={disabled||!availability.reject} onClick={()=>onDecide('reject')}>拒绝候选</button></>}
 </article>;
}
