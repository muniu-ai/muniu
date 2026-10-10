// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GoalResponseV2, RegisterTeamSkillEvaluationV2, TeamSkillDetailV2, TeamSkillEvidenceV2, TeamSkillVersionV2 } from '@mn/contracts';
import { parseRegisterTeamSkillEvaluationV2, parseSubmitTeamSkillEvaluationV2 } from '@mn/contracts/client';
import type { AgentOsClient } from '../api';
import { TeamSkillReview, skillValidation } from './TeamSkillReview';
import { GoalSources } from './GoalSources';
import { useReuseAction, useReuseRead } from './ReuseState';

interface SkillEvaluationDraft {
  configuration?: Omit<RegisterTeamSkillEvaluationV2, 'skillRef' | 'expectedStreamVersion'>;
  report?: File;
  evidence?: readonly TeamSkillEvidenceV2[];
  evaluationId?: string;
}
type FileEpoch = { configuration: number; evidence: number };
export function TeamSkillsPanel({ api, workspaceId, onTrial }: { api: AgentOsClient; workspaceId: string; onTrial: (version: TeamSkillVersionV2) => void }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<{ id: string; version?: string }>();
  const [evaluationDrafts, setEvaluationDrafts] = useState<Record<string, SkillEvaluationDraft>>({}), fileEpochs = useRef<Record<string, FileEpoch>>({});
  useEffect(() => () => { for (const value of Object.values(fileEpochs.current)) { value.configuration++; value.evidence++; } }, []);
  const list = useReuseRead(api, workspaceId, useCallback(() => api.teamSkills(workspaceId), [api, workspaceId]));
  const read = useReuseRead(api, workspaceId, useCallback(() => selected ? api.teamSkill(workspaceId, selected.id, selected.version) : Promise.resolve(undefined), [api, workspaceId, selected?.id, selected?.version]));
  const refresh = () => { void list.reload(); void read.reload(); };
  const action = useReuseAction(api, workspaceId, 'skills', refresh), detail = read.value;
  const evaluationKey = detail ? `${workspaceId}:${detail.version.digest}` : '';
  if (detail && !fileEpochs.current[evaluationKey]) fileEpochs.current[evaluationKey] = { configuration: 0, evidence: 0 };
  const items = list.value?.items.filter(item => `${item.title}\n${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  return <section className="panel" aria-label="团队技能"><h2>团队技能</h2><p>保存已验收的团队流程，明确试用后评测；达到质量门槛才可启用和推荐。</p>
    <label>搜索技能<input aria-label="搜索技能" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {(list.error || read.error || action.error) && <p role="alert">{list.error || read.error || action.error}</p>}
    {action.success && <p role="status">技能操作已保存。</p>}{action.pending && !action.busy && <button onClick={action.retry}>核对上次技能操作</button>}
    <div className="skill-catalog-grid">{items.map(item => <div key={`${item.id}:${item.version}`}><button className="skill-catalog-card" disabled={action.locked} onClick={() => setSelected({ id: item.id, version: item.version })}><strong>{item.title}</strong><p>{item.description}</p><span>版本 {item.version} · {skillValidation[item.validation]}</span>{!item.available && <p>{item.unavailableReason}</p>}</button>{item.stopControl && <button disabled={action.locked} onClick={() => action.run(key => api.commandTeamSkill(workspaceId, item.id, { command: 'disable', expectedStreamVersion: item.stopControl!.expectedStreamVersion }, key))}>停用此技能</button>}</div>)}</div>
    {list.value && !items.length && <p>{query ? '没有匹配的技能。' : '还没有已保存的团队技能。'}</p>}
    {detail && <><TeamSkillReview key={`${detail.version.skillId}:${detail.version.version}`} detail={detail} disabled={action.locked} onTrial={onTrial} onVersion={version => setSelected({ id: detail.version.skillId, version })} onCommand={(command, evaluationId, recommendationEnabled) => action.run(key => api.commandTeamSkill(workspaceId, detail.version.skillId,
      command === 'disable' ? { command, expectedStreamVersion: detail.activation.streamVersion } : { command, expectedStreamVersion: detail.activation.streamVersion, skillRef: skillRef(detail), evaluationId: evaluationId!, recommendationEnabled: recommendationEnabled === true }, key))} />
      <SkillEvaluationForm key={evaluationKey} api={api} workspaceId={workspaceId} detail={detail} action={action} draft={evaluationDrafts[evaluationKey] ?? {}} fileEpoch={fileEpochs.current[evaluationKey]!} onDraft={change => setEvaluationDrafts(current => ({ ...current, [evaluationKey]: { ...current[evaluationKey], ...change } }))} />
    </>}
    <CreateSkillVersion api={api} workspaceId={workspaceId} existing={detail} disabled={action.locked} submit={input => action.run(async key => { const next = await api.createTeamSkill(workspaceId, input, key); setSelected({ id: next.version.skillId, version: next.version.version }); })} />
  </section>;
}
function skillRef(detail: TeamSkillDetailV2) { return { id: detail.version.skillId, version: detail.version.version, digest: detail.version.digest }; }
function CreateSkillVersion({ api, workspaceId, existing, disabled, submit }: { api: AgentOsClient; workspaceId: string; existing?: TeamSkillDetailV2; disabled: boolean; submit: (input: Parameters<AgentOsClient['createTeamSkill']>[1]) => void }) {
  const goals = useReuseRead(api, workspaceId, useCallback(() => api.goals(workspaceId), [api, workspaceId]));
  const [goalId, setGoalId] = useState(''), [title, setTitle] = useState(''), [description, setDescription] = useState('');
  const [asVersion, setAsVersion] = useState(false), [roles, setRoles] = useState<Record<string, string>>({});
  const source = useReuseRead(api, workspaceId, useCallback(() => goalId ? api.goal(workspaceId, goalId) : Promise.resolve(undefined), [api, workspaceId, goalId]));
  const detail: GoalResponseV2 | undefined = source.value;
  const valid = detail?.goal.status === 'accepted' && detail.plan && 'kind' in detail.plan && detail.plan.kind === 'team-v1' && detail.deliverySet;
  return <details><summary>从验收成果保存技能版本</summary><form aria-label="保存团队技能" onSubmit={event => { event.preventDefault(); if (disabled || !valid || !detail?.plan || !detail.deliverySet || asVersion && !existing?.allowedActions.createVersion) return; submit({ skillId: asVersion && existing ? existing.version.skillId : crypto.randomUUID(), expectedStreamVersion: asVersion && existing ? existing.streamVersion : 0, title: title.trim(), description: description.trim(), source: { goalId: detail.goal.id, planRevisionId: detail.plan.id, deliverySetId: detail.deliverySet.id, deliveryDigest: detail.deliverySet.digest }, roles: Object.entries(roles).filter(([, text]) => text.trim()).map(([nodeId, instructions]) => ({ nodeId, instructions: instructions.trim(), sourceRefs: [] })) }); }}>
    <label>已验收任务<select aria-label="已验收任务" disabled={disabled} value={goalId} onChange={event => { setGoalId(event.target.value); setRoles({}); }}><option value="">选择已验收的团队任务</option>{goals.value?.filter(goal => goal.status === 'accepted').map(goal => <option key={goal.id} value={goal.id}>{goal.objective.split('\n')[0]}</option>)}</select></label>
    {source.error && <p role="alert">{source.error}</p>}{detail && !valid && <p>只能保存已最终验收的团队流程，单 Agent 任务不提供团队技能。</p>}
    {existing?.allowedActions.createVersion && <label><input type="checkbox" checked={asVersion} disabled={disabled} onChange={event => setAsVersion(event.target.checked)} />为「{existing.version.title}」创建新版本</label>}
    <label>技能名称<input required disabled={disabled} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label>适用场景<textarea required disabled={disabled} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></label>
    {valid && detail?.plan && 'nodes' in detail.plan && detail.plan.nodes.filter(node => node.kind === 'agent').map(node => <label key={node.id}>{node.title}的补充说明<textarea disabled={disabled} maxLength={4000} value={roles[node.id] ?? ''} onChange={event => setRoles(values => ({ ...values, [node.id]: event.target.value }))} /></label>)}
    <p>只保存固定流程和补充说明。原资料内容不自动复制到后续任务，说明中的文字不能授予权限。</p><button disabled={disabled || !valid || !title.trim() || !description.trim() || asVersion && !existing?.allowedActions.createVersion}>保存不可变版本</button>
  </form></details>;
}
function SkillEvaluationForm({ api, workspaceId, detail, action, draft, fileEpoch, onDraft }: { api: AgentOsClient; workspaceId: string; detail: TeamSkillDetailV2; action: ReturnType<typeof useReuseAction>; draft: SkillEvaluationDraft; fileEpoch: FileEpoch; onDraft: (change: Partial<SkillEvaluationDraft>) => void }) {
  const { configuration, report, evidence, evaluationId = '' } = draft;
  const [error, setError] = useState<string>(), [reportId, setReportId] = useState('');
  const setConfiguration = (configuration: SkillEvaluationDraft['configuration']) => onDraft({ configuration });
  const setReport = (report: File | undefined) => onDraft({ report });
  const setEvidence = (evidence: readonly TeamSkillEvidenceV2[] | undefined) => onDraft({ evidence });
  const setEvaluationId = (evaluationId: string) => onDraft({ evaluationId });
  const awaiting = detail.evaluations.filter(item => item.status === 'awaiting_report' && item.skillRef.digest === detail.version.digest), evaluation = awaiting.find(item => item.id === evaluationId) ?? awaiting[0];
  async function fileJson(file: File | undefined) { if (!file || file.size > 1024 * 1024) throw new Error('请选择不超过 1 MB 的 JSON 文件'); return JSON.parse(await file.text()); }
  return <section aria-label="技能质量评测"><h4>质量评测</h4><p>先固定模型、权限、资料和预算，再登记人工及确定性证据。测试替身报告不能开启自动推荐；费用未知不能按零计。</p>
    {error && <p role="alert">{error}</p>}
    <label>评测配置文件<input type="file" accept=".json" disabled={action.locked} onChange={event => { const file = event.target.files?.[0], epoch = ++fileEpoch.configuration; setConfiguration(undefined); void fileJson(file).then(input => { if (epoch !== fileEpoch.configuration) return; const parsed = parseRegisterTeamSkillEvaluationV2({ ...input, expectedStreamVersion: 0, skillRef: skillRef(detail) }); setConfiguration(parsed); setError(undefined); }).catch(() => { if (epoch !== fileEpoch.configuration) return; setConfiguration(undefined); setError('配置文件无效，请核对固定模型、资料摘要、预算和代码版本。'); }); }} /></label>
    {configuration && <p>{configuration.executionMode === 'measured' ? '实测' : '测试替身'} · {configuration.configuration.model.name} · 固定版本 {configuration.configuration.model.revision}</p>}
    <button disabled={action.locked || !configuration} onClick={() => action.run(key => api.registerSkillEvaluation(workspaceId, detail.version.skillId, { ...configuration!, expectedStreamVersion: 0, skillRef: skillRef(detail) }, key))}>登记评测配置</button>
    <ul>{detail.evaluations.map(item => <li key={item.id}>{item.executionMode === 'measured' ? '实测' : '测试替身'} · {item.releaseGate === 'passed' ? '质量门通过' : item.releaseGate === 'blocked' ? '未达到质量门槛' : '等待报告'}{item.reportRef && <div><button onClick={() => setReportId(current => current === item.id ? '' : item.id)}>查看受保护报告 · 版本 {item.reportRef.streamVersion}</button>{reportId === item.id && <GoalSources api={api} workspaceId={workspaceId} resourceRefs={[item.reportRef]} />}</div>}</li>)}</ul>
    {awaiting.length > 0 && <>{report && <p>已选报告：{report.name}</p>}{evidence && <p>已选证据：{evidence.length} 项</p>}<label>待提交评测<select value={evaluation?.id ?? ''} disabled={action.locked} onChange={event => setEvaluationId(event.target.value)}>{awaiting.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><label>受保护评测报告<input type="file" accept=".json" disabled={action.locked} onChange={event => setReport(event.target.files?.[0])} /></label><label>评测证据引用文件<input type="file" accept=".json" disabled={action.locked} onChange={event => { const epoch = ++fileEpoch.evidence; setEvidence(undefined); void fileJson(event.target.files?.[0]).then(input => { if (epoch !== fileEpoch.evidence) return; const parsed = parseSubmitTeamSkillEvaluationV2({ expectedStreamVersion: 1, reportRef: { namespace: 'asset', resourceId: 'pending-report', streamVersion: 1, digest: '0'.repeat(64) }, evidence: input }); setEvidence(parsed.evidence); setError(undefined); }).catch(() => { if (epoch !== fileEpoch.evidence) return; setEvidence(undefined); setError('证据文件必须是 JSON 数组，包含获准资料版本与人工或确定性检查依据。'); }); }} /></label><button disabled={action.locked || !report || !evidence?.length || !evaluation} onClick={() => action.run(async key => { const asset = await api.uploadAsset(workspaceId, report!, true, `${key}:report`); const input = parseSubmitTeamSkillEvaluationV2({ expectedStreamVersion: evaluation!.streamVersion, reportRef: { namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest }, evidence }); return api.submitSkillEvaluation(workspaceId, detail.version.skillId, evaluation!.id, input, `${key}:submit`); })}>提交受保护报告</button></>}
  </section>;
}
