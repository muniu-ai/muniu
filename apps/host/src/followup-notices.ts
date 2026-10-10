// SPDX-License-Identifier: Apache-2.0
import type { FollowupRunV2, GoalV2, InboxItemV2 } from '@mn/contracts';
import type { KernelTransaction } from '@mn/kernel';
import { FOLLOWUP_POLICY, FOLLOWUP_RUN, type FollowupStoredPolicy } from './followup-authority.js';
interface Notice { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly principalId: string; readonly policyId: string;
  readonly kind: 'result' | 'failure' | 'decision'; readonly goalId?: string; readonly threadId?: string; readonly executionId?: string; readonly createdAt: string; readonly streamVersion: number }
export function readFollowupNotices(tx: KernelTransaction, tenantId: string, principalId: string, workspaceId?: string): InboxItemV2[] {
  return tx.listProjections<Notice>('followup.notice').filter(item => item.tenantId === tenantId && item.principalId === principalId && (!workspaceId || item.workspaceId === workspaceId)).flatMap(item => {
    const policy = tx.getProjection<FollowupStoredPolicy>(FOLLOWUP_POLICY, item.policyId); if (!policy) return [];
    const goal = item.goalId ? tx.getProjection<GoalV2>('goal.state', item.goalId) : undefined;
    if (goal && ['accepted', 'cancelled'].includes(goal.status)) return [];
    if (!goal && policy.status === 'stopped') return [];
    if (!goal && item.kind === 'decision' && policy.status === 'active') {
      const runs = tx.listProjections<FollowupRunV2>(FOLLOWUP_RUN).filter(run => run.policyId === policy.id);
      if (runs.some(run => run.createdAt > item.createdAt)) return [];
    }
    return [{ id: item.id, tenantId, workspaceId: item.workspaceId, kind: 'notice' as const, status: 'open' as const,
      title: item.kind === 'result' ? '跟进成果待验收' : item.kind === 'failure' ? '跟进任务需要处理' : '跟进需要核对授权或额度',
      summary: item.kind === 'result' ? '业务对象变化后的分析已完成，请查看任务成果。' : item.kind === 'failure' ? '请查看任务状态和已有证据；结果未知时不能重新执行。' : '请在主动跟进中查看原因、有效期和周期额度。',
      createdAt: item.createdAt, streamVersion: item.streamVersion,
      ...(goal ? { navigation: { pluginId: 'opc', threadId: goal.threadId, resourceRef: { namespace: 'goal.state', resourceId: goal.id } } } : {}) }];
  });
}
