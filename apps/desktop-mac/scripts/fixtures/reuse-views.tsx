// SPDX-License-Identifier: Apache-2.0
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryCard } from '../../src/components/MemoryCard';
import { TeamSkillReview } from '../../src/components/TeamSkillReview';
import { FollowupReview, followupGoalEligible } from '../../src/components/FollowupsPanel';
const memory = { id: 'memory', workspaceId: 'workspace', streamVersion: 1, scopeType: 'workspace', namespace: 'opc', resourceId: 'workspace', summary: '受保护偏好正文', source: 'event', confidence: 0.8, status: 'proposed',
  provenance: { version: 1, kind: 'preference', origin: 'model', sourceRefs: [{ namespace: 'asset', resourceId: 'asset', streamVersion: 3, digest: 'digest' }] }, access: 'readable', allowedActions: ['accept', 'reject', 'revise', 'delete'] };
const memoryApi = {} as import('../../src/api').AgentOsClient;
export const memoryMarkup = (overrides = {}) => renderToStaticMarkup(<MemoryCard api={memoryApi} workspaceId="workspace" memory={{ ...memory, ...overrides } as never} professional={false} onDecide={async () => {}} onRevise={async () => {}} onDelete={async () => {}} />);
export const skillMarkup = (overrides = {}) => renderToStaticMarkup(<TeamSkillReview detail={{
  streamVersion: 2, version: { skillId: 'skill', version: '2', digest: 'digest', title: '研究流程', description: '整理材料和反证', nodes: [{ id: 'review', title: '独立复核', dependsOn: ['research'], inputs: [{ key: 'result', kind: 'node_output', nodeId: 'research', outputKey: 'result' }], outputs: [{ key: 'evidence', kind: 'evidence' }] }], roles: [{ nodeId: 'review', instructions: '核对反证', sourceRefs: [] }], inputSlots: [{ key: 'materials', namespace: 'asset' }], outputSpecs: [{ key: 'report', title: '研究报告', criteria: [{ id: 'source', description: '来源可核对' }] }], permissionRequirements: [{ nodeId: 'review', toolIds: [], isolation: 'none' }], checkRules: ['authorized_sources'], sourceRefs: [] },
  versions: [], activation: { streamVersion: 0, activeRef: null, recommendationEnabled: false }, validation: 'unmeasured', evaluations: [], staleReasons: [], allowedActions: { trial: true, createVersion: true, enable: false, rollback: false, disable: false }, ...overrides
} as never} onTrial={() => {}} onCommand={() => {}} onVersion={() => {}} />);
export const followupMarkup = () => renderToStaticMarkup(<FollowupReview detail={{ policy: { status: 'paused', definition: { title: '跟进客户', instruction: '有新需求时整理差异', expiresAt: '2026-10-20T00:00:00Z' } }, currentPeriod: { runCount: 1, settled: { costMinorUnits: '0', currency: 'CNY' }, reserved: { costMinorUnits: '100', currency: 'CNY' }, unknown: { tokens: 100, costMinorUnits: '0', currency: 'CNY' } }, allowedActions: { pause: false, resume: false, stop: true }, runs: [{ id: 'run', status: 'needs_reconciliation', createdAt: '2026-10-10T00:00:00Z', goalId: 'goal' }] } as never} onGoal={() => {}} onCommand={() => {}} />);

export const followupEligible = (overrides: { plan?: object; goal?: object } = {}) => followupGoalEligible({ plan: { pluginId: 'opc', runnerId: 'builtin', toolIds: [], dataScopes: [], digest: 'digest', ...overrides.plan }, goal: { status: 'running', authorization: { planDigest: 'digest' }, ...overrides.goal } } as never);
import { SkillRecommendationList } from '../../src/components/SkillRecommendations';
export const recommendationMarkup = () => renderToStaticMarkup(<SkillRecommendationList items={[
 { id: 'good', title: '已验证研究流程', description: '已验证', version: '1', digest: 'digest', validation: 'passed', available: true, recommended: true },
 { id: 'unmeasured', title: '未测流程', validation: 'unmeasured', available: true, recommended: true },
 { id: 'denied', title: '未授权流程', validation: 'passed', available: false, recommended: true },
 { id: 'off', title: '未推荐流程', validation: 'passed', available: true, recommended: false }
] as never} onUse={() => {}} />);
