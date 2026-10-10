// SPDX-License-Identifier: Apache-2.0
import { isCoordinatedGoalPlan, type Thread } from '@mn/contracts';
import { KernelError, sha256 } from '@mn/kernel';
import type { GoalScope } from './goals.js';
import type { GoalDeliveryServiceOptions } from './goal-delivery-service.js';
import { createHostGoalRuntime, goalDomainInputDigest } from './goal-runtime.js';
import { createHostTeamRuntime } from './team-runtime.js';
import { currentTeamCapabilities, type HostTeamRuntimeOptions } from './team-planning.js';

export async function createGoalDeliveryService(options: HostTeamRuntimeOptions, scope: GoalScope): Promise<GoalDeliveryServiceOptions> {
  const team = createHostTeamRuntime(options), single = createHostGoalRuntime(options);
  const service = await team.service(scope);
  return { ...service, ports: {
    assertResources: service.ports.assertResources,
    assertPlan: service.ports.assertPlan,
    assertHistorical(tx, current) {
      if (isCoordinatedGoalPlan(current.plan)) team.assertDelivery(tx, { ...current, plan: current.plan });
      else single.assertDelivery(tx, { ...current, plan: current.plan });
    },
    preparePlan(tx, current) {
      const thread = tx.getProjection<Thread>('thread', current.goal.threadId);
      if (!thread || thread.tenantId !== scope.tenantId || thread.workspaceId !== scope.workspaceId) throw new KernelError('GOAL_THREAD_INVALID', '原任务会话不可用', '刷新任务与权限');
      const domainInputDigest = goalDomainInputDigest(tx, thread);
      const { digest: _digest, ...body } = current.plan;
      const candidate = { ...body, domainInputDigest, threadStreamVersion: thread.streamVersion,
        nodes: body.nodes.map(node => node.kind !== 'agent' ? node : { ...node, executor: { ...node.executor, domainInputDigest, threadStreamVersion: thread.streamVersion } }) };
      const capabilities = currentTeamCapabilities(options, tx, current.goal, candidate);
      const next = { ...candidate, nodes: candidate.nodes.map(node => {
        if (node.kind !== 'agent') return node;
        const capability = capabilities.find(value => value.id === node.capabilityRef.id);
        if (!capability) throw new KernelError('GOAL_EXECUTOR_UNAVAILABLE', '返工执行能力不可用', '检查原执行者');
        return { ...node, capabilityRef: { id: capability.id, version: capability.version, digest: capability.digest } };
      }) };
      return { ...next, digest: sha256(next) };
    },
    resolveReuse: team.resolveReuse,
    start: service.ports.start,
  } };
}
