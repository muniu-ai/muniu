// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseGoalService } from './enterprise-goals.js';
export async function dispatchEnterpriseGoals(options: { operationId: string; params: Readonly<Record<string, string>>; actor: EnterpriseActor; input: unknown; key?: string; goals?: EnterpriseGoalService }): Promise<{ handled: false } | { handled: true; value: unknown }> {
  const { operationId, params, actor, input, key, goals } = options;
  if (!['adoptOperatingEvaluation', 'getGoalConfiguration', 'listOperatingGoals', 'createOperatingGoal', 'getOperatingGoal', 'getOperatingGoalControlState', 'reviseOperatingGoal', 'authorizeOperatingGoal', 'commitOperatingPlan', 'requestOperatingPlan', 'controlOperatingGoal', 'getOperatingGoalReport'].includes(operationId)) return { handled: false };
  if (!goals) throw new EnterpriseError('GOAL_RUNTIME_UNCONFIGURED', 503);
  let value: unknown;
  switch (operationId) {
    case 'adoptOperatingEvaluation': { const { evaluationId, ...spec } = input as EnterpriseContractTypes['EnterpriseGoalAdopt']; if (spec.sources.some(s => s.reference.workspaceId !== params.workspaceId)) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH'); value = await goals.adopt(actor, evaluationId, key!, spec); break; }
    case 'getGoalConfiguration': value = await goals.configuration(actor, params.workspaceId!); break;
    case 'listOperatingGoals': value = await goals.list(actor, params.workspaceId!); break;
    case 'createOperatingGoal': value = await goals.create(actor, params.workspaceId!, key!, input as EnterpriseContractTypes['EnterpriseGoalCreate']); break;
    case 'getOperatingGoal': value = await goals.get(actor, params.goalId!); break;
    case 'getOperatingGoalControlState': value = await goals.controlState(actor, params.goalId!); break;
    case 'reviseOperatingGoal': { const { expectedStreamVersion, ...spec } = input as EnterpriseContractTypes['EnterpriseGoalRevise']; value = await goals.revise(actor, params.goalId!, expectedStreamVersion, key!, spec); break; }
    case 'authorizeOperatingGoal': { const body = input as EnterpriseContractTypes['EnterpriseGoalAuthorize']; value = await goals.authorize(actor, params.goalId!, body.expectedStreamVersion, body.scopeDigest, key!); break; }
    case 'commitOperatingPlan': { const { expectedStreamVersion, ...body } = input as EnterpriseContractTypes['EnterpriseGoalPlanWrite']; value = await goals.plan(actor, params.goalId!, expectedStreamVersion, key!, body); break; }
    case 'requestOperatingPlan': { const body = input as EnterpriseContractTypes['EnterpriseGoalPlanningRequest']; value = await goals.requestPlan(actor, params.goalId!, body.expectedStreamVersion, key!, body.modelBindingId); break; }
    case 'controlOperatingGoal': { const body = input as EnterpriseContractTypes['EnterpriseGoalControl']; value = await goals.control(actor, params.goalId!, body.expectedStreamVersion, body.command, key!); break; }
    case 'getOperatingGoalReport': value = await goals.result(actor, params.goalId!, params.attemptId!); break;
  }
  return { handled: true, value };
}
