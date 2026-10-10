// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { TeamSkillDetailV2, TeamSkillVersionV2 } from '@mn/contracts';
export const skillValidation = { unmeasured: '尚未评测', passed: '评测通过', failed: '评测未通过' };
export function TeamSkillReview({ detail, disabled = false, onTrial, onCommand, onVersion }: {
  detail: TeamSkillDetailV2; disabled?: boolean; onTrial: (version: TeamSkillVersionV2) => void;
  onCommand: (command: 'enable' | 'rollback' | 'disable', evaluationId?: string, recommendationEnabled?: boolean) => void;
  onVersion: (version: string) => void;
}) {
  const { version, activation, allowedActions } = detail;
  const [recommend, setRecommend] = useState(false), [evaluationId, setEvaluationId] = useState('');
  const approved = detail.evaluations.filter(item => item.skillRef.digest === version.digest && item.releaseGate === 'passed' && item.executionMode === 'measured');
  const evaluation = approved.find(item => item.id === evaluationId) ?? approved[0];
  return <article aria-label="团队技能详情"><h3>{version.title} · 版本 {version.version}</h3><p>{version.description}</p><p>{skillValidation[detail.validation]} · {activation.activeRef ? `已启用版本 ${activation.activeRef.version}` : '尚未启用'} · {activation.recommendationEnabled ? '允许自动推荐' : '自动推荐关闭'}</p>
    <label>查看技能版本<select aria-label="查看技能版本" disabled={disabled} value={version.version} onChange={event => onVersion(event.target.value)}>{detail.versions.map(item => <option key={item.version} value={item.version}>{item.version} · {skillValidation[item.validation]}</option>)}</select></label>
    {detail.staleReasons.map(reason => <p role="status" key={reason}>{reason}</p>)}
    <h4>输入与成果</h4><p>{version.inputSlots.map(item => `${item.key} · ${item.namespace}`).join('、') || '无需固定资料槽位'}</p><ul>{version.outputSpecs.map(item => <li key={item.key}>{item.title}<ul>{item.criteria.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul></li>)}</ul>
    {version.deliverableBindings?.length > 0 && <details><summary>成果对应步骤</summary><ul>{version.deliverableBindings.map(binding => <li key={binding.deliverableKey}>{version.outputSpecs.find(spec => spec.key === binding.deliverableKey)?.title ?? binding.deliverableKey} ← {version.nodes.find(node => node.id === binding.nodeId)?.title ?? binding.nodeId} / {binding.outputKey}</li>)}</ul></details>}<h4>工作步骤</h4><ol>{version.nodes.map(node => <li key={node.id}><strong>{node.title}</strong><p>前置步骤：{node.dependsOn.join('、') || '无'}</p><p>输入：{node.inputs.map(input => input.key).join('、')}；输出：{node.outputs.map(output => output.key).join('、')}</p>{node.review && <p>独立复核：{node.review.producerNodeIds.join('、')}；不接收生成者自评分。</p>}{node.choices && <p>人工选择：继续或停止。</p>}{node.mappings && <p>汇合：{node.mappings.map(mapping => `${mapping.fromNodeId} → ${mapping.outputKey}`).join('；')}</p>}{version.roles.filter(role => role.nodeId === node.id).map(role => <p key={role.nodeId}>{role.instructions}</p>)}</li>)}</ol>
    <details><summary>权限与版本依据</summary><p>角色说明不能授予权限；试用仍需审阅新目标计划。</p><ul>{version.permissionRequirements.map(item => <li key={item.nodeId}>{item.nodeId} · {item.toolIds.join('、') || '无工具'} · {item.isolation === 'required_sandbox' ? '需要沙箱' : '无需执行沙箱'}</li>)}</ul><p>检查规则：{version.checkRules.join('、')}</p><p>版本摘要：{version.digest}</p></details>
    <button className="primary-button" disabled={disabled || !allowedActions.trial} onClick={() => onTrial(version)}>试用为新任务</button><p>新任务固定此版本；资料、执行模型和额度需重新确认。在途任务继续使用原版本。</p>
    {(allowedActions.enable || allowedActions.rollback) && <div><label>已通过评测<select value={evaluation?.id ?? ''} disabled={disabled} onChange={event => setEvaluationId(event.target.value)}>{!approved.length && <option value="">没有满足发布门槛的实测报告</option>}{approved.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><label><input type="checkbox" checked={recommend} disabled={disabled || !evaluation} onChange={event => setRecommend(event.target.checked)} />允许后续任务自动推荐此版本</label>
      {allowedActions.enable && <button disabled={disabled || !evaluation} onClick={() => onCommand('enable', evaluation!.id, recommend)}>启用此版本</button>}
      {allowedActions.rollback && <button disabled={disabled || !evaluation} onClick={() => onCommand('rollback', evaluation!.id, recommend)}>回滚到此版本</button>}</div>}
    {allowedActions.disable && <button className="secondary-button" disabled={disabled} onClick={() => onCommand('disable')}>停用技能</button>}
  </article>;
}
