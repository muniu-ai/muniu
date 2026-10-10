// SPDX-License-Identifier: Apache-2.0
import type { GoalReworkPreviewV2 } from '@mn/contracts';
import { formatTeamCost } from './GoalPlanView';
export function ReworkPreview({preview,disabled=false,onConfirm,onCancel}:{preview:GoalReworkPreviewV2;disabled?:boolean;onConfirm:()=>void;onCancel:()=>void}) {
  const title=(id:string)=>preview.plan.nodes.find(node=>node.id===id)?.title??id;
  return <section className="panel" aria-label="返工预览"><h3>返工预览 · 第 {preview.round} 轮</h3>
    <h4>需要处理的步骤</h4><ul>{preview.affectedNodeIds.map(id=><li key={id}>{title(id)}</li>)}</ul>
    <h4>沿用的工作</h4><ul>{preview.reusedNodeIds.map(id=><li key={id}>{title(id)}</li>)}{preview.retainedDeliverableKeys.map(key=><li key={key}>{preview.plan.deliverables.find(item=>item.key===key)?.title??key}</li>)}</ul>
    <h4>新增工作</h4><ul>{preview.additionalWork.map((work,index)=><li key={index}>{work}</li>)}</ul>
    <p>剩余额度：{formatTeamCost(preview.remainingBudget.maxCostMinorUnits,preview.remainingBudget.currency)} · {preview.remainingBudget.maxTokens} tokens</p><p>原期限：{new Date(preview.deadlineAt).toLocaleString('zh-CN')}。返工共用累计额度与期限。</p>
    {preview.authorization.requiresApproval?<><p>需要补充授权后才能执行。</p><ul>{preview.authorization.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul></>:<p>返工使用原授权范围。</p>}
    <button className="primary-button" disabled={disabled} onClick={onConfirm}>确认返工计划</button><button className="secondary-button" disabled={disabled} onClick={onCancel}>返回核对</button>
  </section>;
}
