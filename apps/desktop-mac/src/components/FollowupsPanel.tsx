// SPDX-License-Identifier: Apache-2.0
import { useCallback, useState } from 'react';
import type { CreateFollowupV2, FollowupDetailV2, GoalResponseV2 } from '@mn/contracts';
import type { AgentOsClient } from '../api';
import { useReuseAction, useReuseRead } from './ReuseState';
import { formatTeamCost } from './GoalPlanView';
const statuses = { active: '已启用', paused: '已暂停', stopped: '已停止', expired: '已到期', invalidated: '授权已失效', exhausted: '额度已用完' };
export function followupGoalEligible(detail: GoalResponseV2 | undefined): boolean {
  const plan = detail?.plan;
  return Boolean(plan && !('kind' in plan) && 'runnerId' in plan && plan.runnerId === 'builtin' && plan.pluginId === 'opc' && !plan.toolIds.length && !plan.dataScopes.length && detail?.goal.authorization?.planDigest === plan.digest && !['accepted', 'cancelled', 'needs_reconciliation'].includes(detail.goal.status) && !detail.goal.cancellationRequestedAt);
}
export function FollowupReview({ detail, disabled, onCommand, onGoal }: { detail: FollowupDetailV2; disabled?: boolean; onCommand: (command: 'pause' | 'resume' | 'stop') => void; onGoal: (id: string) => void }) {
  const { policy, currentPeriod, allowedActions } = detail;
  return <article aria-label="跟进详情"><h3>{policy.definition.title}</h3><p>{statuses[policy.status]} · 有效期至 {new Date(policy.definition.expiresAt).toLocaleString('zh-CN')}</p><p>{policy.definition.instruction}</p><p>触发条件：所选业务对象发生变化。无变化时不调用模型，也不重复通知。</p><p>原目标关闭、授权撤销、到期或累计次数用完后停止。暂停仅阻止新派发。</p>
    <p>本周期已执行 {currentPeriod.runCount} 次 · 已结算 {formatTeamCost(currentPeriod.settled.costMinorUnits, currentPeriod.settled.currency)} · 预留 {formatTeamCost(currentPeriod.reserved.costMinorUnits, currentPeriod.reserved.currency)} · {detail.runs.some(run => run.status === 'needs_reconciliation') || currentPeriod.unknown.tokens > 0 || BigInt(currentPeriod.unknown.costMinorUnits) > 0n ? '费用尚未核对，不按零结算' : '没有待核对费用'}</p>
    {policy.reasonCode && <p role="status">停止或阻塞原因：{policy.reasonCode}</p>}
    {(['pause', 'resume', 'stop'] as const).filter(command => allowedActions[command]).map(command => <button key={command} disabled={disabled} onClick={() => onCommand(command)}>{command === 'pause' ? '暂停跟进' : command === 'resume' ? '继续跟进' : '停止跟进'}</button>)}
    <ul>{detail.runs.map(run => <li key={run.id}>{new Date(run.createdAt).toLocaleString('zh-CN')} · {run.status === 'needs_reconciliation' ? '费用或结果待核对' : run.status === 'failed' ? '未完成' : run.status === 'accepted' ? '已验收' : run.status === 'awaiting_acceptance' ? '待验收' : run.status === 'cancelled' ? '已取消' : run.status === 'pending' ? '待执行' : '执行中'}{run.goalId && <button onClick={() => onGoal(run.goalId!)}>查看跟进任务</button>}</li>)}</ul>
  </article>;
}
export function FollowupsPanel({ api, workspaceId, onGoal }: { api: AgentOsClient; workspaceId: string; onGoal: (id: string) => void }) {
  const list = useReuseRead(api, workspaceId, useCallback(() => api.followups(workspaceId), [api, workspaceId]));
  const [selected, setSelected] = useState('');
  const read = useReuseRead(api, workspaceId, useCallback(() => selected ? api.followup(workspaceId, selected) : Promise.resolve(undefined), [api, workspaceId, selected]));
  const action = useReuseAction(api, workspaceId, 'followups', () => { void list.reload(); void read.reload(); });
  return <section className="panel" aria-label="主动跟进"><h2>主动跟进</h2><p>只在明确授权的业务对象变化时创建独立任务。周期额度单独授权，不重置原任务额度。</p>
    {(list.error || read.error || action.error) && <p role="alert">{list.error || read.error || action.error}</p>}{action.success && <p role="status">跟进操作已保存。</p>}{action.pending && !action.busy && <button onClick={action.retry}>核对上次跟进操作</button>}
    {list.value?.map(item => <button key={item.policy.id} disabled={action.locked} onClick={() => setSelected(item.policy.id)}>{item.policy.definition.title} · {statuses[item.policy.status]}</button>)}
    {read.value && <FollowupReview detail={read.value} disabled={action.locked} onGoal={onGoal} onCommand={command => action.run(key => api.commandFollowup(workspaceId, read.value!.policy.id, { expectedStreamVersion: read.value!.policy.streamVersion, command }, key))} />}
    <FollowupForm api={api} workspaceId={workspaceId} disabled={action.locked} onCreate={input => action.run(async key => { const detail = await api.createFollowup(workspaceId, input, key); setSelected(detail.policy.id); })} />
  </section>;
}
function FollowupForm({ api, workspaceId, disabled, onCreate }: { api: AgentOsClient; workspaceId: string; disabled: boolean; onCreate: (input: CreateFollowupV2) => void }) {
  const goals = useReuseRead(api, workspaceId, useCallback(() => api.goals(workspaceId), [api, workspaceId]));
  const [goalId, setGoalId] = useState(''), [sourceId, setSourceId] = useState(''), [title, setTitle] = useState(''), [instruction, setInstruction] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [modelId, setModelId] = useState(''), [perCost, setPerCost] = useState('100'), [periodCost, setPeriodCost] = useState('300'), [tokens, setTokens] = useState('5000'), [periodRuns, setPeriodRuns] = useState('3'), [maxRuns, setMaxRuns] = useState('6'), [period, setPeriod] = useState('86400000'), [expiresAt, setExpiresAt] = useState('');
  const read = useReuseRead(api, workspaceId, useCallback(() => goalId ? api.goal(workspaceId, goalId) : Promise.resolve(undefined), [api, workspaceId, goalId]));
  const models = useReuseRead(api, workspaceId, useCallback(() => api.modelConnections(), [api]));
  const detail: GoalResponseV2 | undefined = read.value;
  const sources = detail?.goal.resourceRefs.filter(ref => ref.namespace.startsWith('opc.business.')) ?? [];
  const selected = sources.find(ref => `${ref.namespace}:${ref.resourceId}` === sourceId) ?? sources[0];
  const currency = detail?.goal.budget.currency ?? 'CNY';
  const parentModelId = detail?.plan && 'modelBindingId' in detail.plan ? detail.plan.modelBindingId : undefined;
  const compatibleModels = models.value?.filter(item => item.id === parentModelId && item.status === 'ready' && item.billingCurrency === currency) ?? [];
  const model = compatibleModels.find(item => item.id === modelId);
  const valid = followupGoalEligible(detail) && selected && model && confirmed && expiresAt && title.trim() && instruction.trim();
  return <details><summary>新增受控跟进</summary><form aria-label="新增受控跟进" onSubmit={event => { event.preventDefault(); if (!valid || !detail?.plan) return; onCreate({ expectedStreamVersion: 0, parentGoalId: detail.goal.id, expectedGoalStreamVersion: detail.goal.streamVersion, parentPlanDigest: detail.plan.digest, title: title.trim(), instruction: instruction.trim(), enabled: true, trigger: { kind: 'business_changed', sourceRef: selected! }, resourceRefs: [selected!], modelBindingId: model!.id, perRunBudget: { maxTokens: Number(tokens), maxCostMinorUnits: perCost, currency, maxDurationMs: 300000 }, periodBudget: { periodMs: Number(period) as 86400000 | 604800000, maxRuns: Number(periodRuns), maxTokens: Number(tokens) * Number(periodRuns), maxCostMinorUnits: periodCost, currency }, maxRuns: Number(maxRuns), expiresAt: new Date(expiresAt).toISOString() }); }}>
    <label>关联目标<select aria-label="关联目标" value={goalId} disabled={disabled} onChange={event => { setGoalId(event.target.value); setConfirmed(false); setSourceId(''); }}><option value="">选择已批准且未关闭的经营目标</option>{goals.value?.filter(goal => goal.authorization && !['accepted', 'cancelled'].includes(goal.status)).map(goal => <option key={goal.id} value={goal.id}>{goal.objective.split('\n')[0]}</option>)}</select></label>
    {read.error && <p role="alert">{read.error}</p>}{detail && !followupGoalEligible(detail) && <p>此目标不支持跟进。请选择已批准且未关闭的只读内置单 Agent 经营目标。</p>}<label>跟进业务对象<select value={selected ? `${selected.namespace}:${selected.resourceId}` : ''} disabled={disabled} onChange={event => setSourceId(event.target.value)}>{!sources.length && <option value="">目标没有获准的业务对象</option>}{sources.map(ref => <option key={`${ref.namespace}:${ref.resourceId}`} value={`${ref.namespace}:${ref.resourceId}`}>{ref.namespace} · {ref.resourceId} · 版本 {ref.streamVersion}</option>)}</select></label>
    <label>跟进名称<input value={title} disabled={disabled} required maxLength={200} onChange={event => setTitle(event.target.value)} /></label><label>每次变化后完成什么<textarea value={instruction} disabled={disabled} required maxLength={4000} onChange={event => setInstruction(event.target.value)} /></label>
    <label>跟进执行模型<select aria-label="跟进执行模型" value={modelId} disabled={disabled} onChange={event => setModelId(event.target.value)}><option value="">确认原目标的内置模型</option>{compatibleModels.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <fieldset disabled={disabled}><legend>单独授权的跟进额度（{currency}）</legend><label>周期<select value={period} onChange={event => setPeriod(event.target.value)}><option value="86400000">24 小时</option><option value="604800000">7 天</option></select></label>{[['单次费用上限（分）', perCost, setPerCost], ['周期费用上限（分）', periodCost, setPeriodCost], ['单次 Token 上限', tokens, setTokens], ['周期执行次数', periodRuns, setPeriodRuns], ['累计执行次数', maxRuns, setMaxRuns]].map(([label, value, setter]) => <label key={String(label)}>{String(label)}<input type="number" min="1" required value={String(value)} onChange={event => (setter as (value: string) => void)(event.target.value)} /></label>)}<label>有效期至<input type="datetime-local" required value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />明确启用：仅使用上述对象和额度，允许创建独立的只读跟进任务</label></fieldset>
    <button disabled={disabled || !valid}>启用跟进</button>
  </form></details>;
}
