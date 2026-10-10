// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentOsClient } from '../../src/api';
import { AgentOsApiError } from '../../src/api';
import { MemoryPanel } from '../../src/components/MemoryPanel';
import { TeamSkillsPanel } from '../../src/components/TeamSkillsPanel';
import { FollowupsPanel } from '../../src/components/FollowupsPanel';
import { TaskComposer } from '../../src/components/TaskComposer';
import '../../src/styles.css';
const calls: any[] = [], listeners = new Set<() => void>();
let revoked = new URLSearchParams(location.search).get('fixture') === 'skill-revoked', stopped = false, held = false, release = () => {}, reads = 0;
const event = () => listeners.forEach(listener => listener());
const denied = () => new AgentOsApiError({ code: 'RESOURCE_REVOKED', message: '资料撤权', action: '重新授权', fieldIssues: [], traceId: 'fixture', retryable: false }, 403);
const source = { namespace: 'opc.business.customer', resourceId: 'customer', streamVersion: 3, digest: 'a'.repeat(64) };
const specs = [{ key: 'report', title: '研究报告', required: true, criteria: [{ id: 'source', description: '来源明确' }] }, { key: 'counter', title: '反证清单', required: true, criteria: [{ id: 'counter', description: '说明不确定性' }] }];
const version: any = { id: 'skill-version', skillId: 'skill', workspaceId: 'workspace', version: '3', digest: 'c'.repeat(64), title: '研究技能', description: '验证研究方法', pluginId: 'opc', template: { id: 'research-summary', version: '1' }, inputSlots: [{ key: 'source-1', namespace: 'opc.business.customer' }], outputSpecs: specs, sourceRefs: [source], nodes: [{ id: 'review', kind: 'agent', title: '独立复核', dependsOn: [], inputs: [], outputs: [] }], roles: [{ nodeId: 'review', instructions: '获准期间可见的角色说明', sourceRefs: [] }], permissionRequirements: [], checkRules: [] };
const skill: any = { streamVersion: 3, version, versions: [{ id: 'skill', version: '3', digest: version.digest, title: version.title, description: version.description, validation: 'passed', available: true }], validation: 'passed', activation: { streamVersion: 2, activeRef: null, recommendationEnabled: false }, evaluations: [{ id: 'evaluation', skillRef: { id: 'skill', version: '3', digest: version.digest }, releaseGate: 'passed', executionMode: 'measured', status: 'evaluated' }], staleReasons: [], allowedActions: { trial: true, createVersion: false, enable: true, rollback: false, disable: false } };
if (new URLSearchParams(location.search).get('fixture') === 'skill-evaluation') skill.evaluations = [{ id: 'evaluation', streamVersion: 1, skillRef: { id: 'skill', version: '3', digest: version.digest }, releaseGate: 'pending', executionMode: 'test_fixture', status: 'awaiting_report' }];
const memory = { id: 'memory', streamVersion: 1, summary: '受保护记忆正文', namespace: 'opc', resourceId: 'workspace', status: 'proposed', confidence: 1, source: 'event', access: 'readable', allowedActions: ['accept', 'reject', 'revise', 'delete'], provenance: { version: 1, kind: 'preference', origin: 'user', sourceRefs: [source] } };
const budget = { maxTokens: 10000, maxCostMinorUnits: '2000', currency: 'CNY', maxDurationMs: 300000 };
const goal: any = { goal: { id: 'goal', objective: '已批准的经营目标', workspaceId: 'workspace', status: 'awaiting_acceptance', streamVersion: 5, resourceRefs: [source], budget, authorization: { planDigest: 'plan-digest' } }, plan: { pluginId: 'opc', runnerId: 'builtin', toolIds: [], dataScopes: [], modelBindingId: 'model', digest: 'plan-digest' } };
const api = { watchWorkspaceEvents: (_workspace: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
 memories: async () => { reads++; const snapshot = revoked ? [{ ...memory, access: 'revoked', allowedActions: ['delete'], summary: 'placeholder' }] : [structuredClone(memory)]; if (held) { held = false; await new Promise<void>(resolve => { release = resolve; }); } return snapshot; },
 decideMemory: async (id: string, streamVersion: number, decision: string, key: string) => { calls.push({ method: 'memory', id, streamVersion, decision, key }); if (calls.filter(item => item.method === 'memory').length === 1) throw new TypeError('lost response'); memory.status = 'accepted'; memory.allowedActions = ['delete']; },
 teamSkills: async () => ({ items: revoked ? [{ id: 'skill', version: '3', digest: version.digest, title: '来源已不可用', description: '', validation: 'unmeasured', available: false, recommended: false, unavailableReason: '技能来源已撤权', ...(stopped ? {} : { stopControl: { expectedStreamVersion: 2 } }) }] : skill.versions }), teamSkill: async () => { if (revoked) throw denied(); return structuredClone(skill); },
 commandTeamSkill: async (workspace: string, id: string, input: any, key: string) => { calls.push({ method: 'skill', workspace, id, input, key }); if (calls.filter(item => item.method === 'skill').length === 1) throw new TypeError('lost response'); if (input.command === 'disable') stopped = true; return { ...skill.activation, streamVersion: 3, activeRef: input.skillRef ?? null }; },
 uploadAsset: async (workspace: string, file: File, protected_: boolean, key: string) => { calls.push({ method: 'upload', workspace, name: file.name, protected: protected_, key }); return { id: 'report', streamVersion: 1, digest: 'd'.repeat(64) }; },
 submitSkillEvaluation: async (workspace: string, id: string, evaluationId: string, input: any, key: string) => { calls.push({ method: 'report', workspace, id, evaluationId, input, key }); skill.evaluations[0].status = 'evaluated'; skill.evaluations[0].releaseGate = 'blocked'; return structuredClone(skill.evaluations[0]); },
 modelConnections: async () => [{ id: 'model', displayName: '原目标模型', status: 'ready', billingCurrency: 'CNY' }], teamTemplates: async () => [{ id: 'research-summary', title: '研究汇总', description: '固定研究模板', available: true, pluginId: 'opc', version: '1', nodeCount: 5 }],
 goals: async () => [goal.goal], goal: async () => structuredClone(goal), createBusinessThread: async () => ({ id: 'thread' }),
 createGoal: async (workspace: string, input: any, key: string) => { calls.push({ method: 'goal', workspace, input, key }); if (calls.filter(item => item.method === 'goal').length === 1) throw new TypeError('lost response'); return { goal: { id: 'new-goal', workspaceId: workspace, streamVersion: 1 } }; },
 planTeamGoal: async (_detail: any, input: any, key: string) => { calls.push({ method: 'plan', input, key }); return { goal: { id: 'new-goal' } }; },
 followups: async () => [], followup: async () => { throw denied(); },
 createFollowup: async (workspace: string, input: any, key: string) => { calls.push({ method: 'followup', workspace, input, key }); if (calls.filter(item => item.method === 'followup').length === 1) throw new TypeError('lost response'); return { policy: { id: 'followup' } }; },
} as unknown as AgentOsClient;
Object.assign(window, { calls, reuseDriver: { event, hold: () => { held = true; event(); }, release: () => release(), revoke: () => { revoked = true; event(); }, get reads() { return reads; } } });
function App() {
 const fixture = new URLSearchParams(location.search).get('fixture'), [visible, setVisible] = useState(true), [trial, setTrial] = useState<any>(), [done, setDone] = useState(false);
 return <main><button onClick={() => setVisible(value => !value)}>{visible ? '卸载面板' : '打开面板'}</button>{visible && (fixture === 'memory' ? <MemoryPanel api={api} workspaceId="workspace" professional /> : fixture === 'followup' ? <FollowupsPanel api={api} workspaceId="workspace" onGoal={() => {}} /> : fixture === 'trial' ? done ? <p>新任务已准备</p> : <><button onClick={() => setTrial({ version, sequence: (trial?.sequence ?? 0) + 1 })}>选入技能试用</button><TaskComposer api={api} workspaceId="workspace" skillTrial={trial} visible pluginIds={['opc']} repositories={[]} onRepository={() => {}} onRegisterRepository={() => {}} onSettings={() => {}} onCreated={() => setDone(true)} /></> : <TeamSkillsPanel api={api} workspaceId="workspace" onTrial={() => {}} />)}</main>;
}
createRoot(document.getElementById('root')!).render(<App />);
