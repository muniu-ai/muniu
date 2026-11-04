// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes as Types } from '@mn/contracts';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseWorkflowService } from './enterprise-workflows.js';
export async function dispatchEnterpriseWorkflows(options: { operationId: string; params: Readonly<Record<string, string>>; actor: EnterpriseActor; input: unknown; key?: string; workflows?: EnterpriseWorkflowService }): Promise<{ handled: false } | { handled: true; value: unknown }> {
  const { operationId, params, actor, input, key, workflows } = options;
  if (!['listEnterpriseWorkflows', 'publishEnterpriseWorkflow', 'readEnterpriseWorkflow', 'selectEnterpriseWorkflow'].includes(operationId)) return { handled: false };
  if (!workflows) throw new EnterpriseError('WORKFLOW_RUNTIME_UNCONFIGURED', 503);
  let value: unknown;
  switch (operationId) {
    case 'listEnterpriseWorkflows': value = await workflows.list(actor, params.workspaceId!); break;
    case 'readEnterpriseWorkflow': value = await workflows.read(actor, params.workspaceId!, input as Types['EnterpriseWorkflowRef']); break;
    case 'publishEnterpriseWorkflow': { const body = input as Types['EnterpriseWorkflowPublish']; value = await workflows.publish(actor, params.workspaceId!, body.expectedStreamVersion, body.definition, key!); break; }
    case 'selectEnterpriseWorkflow': { const body = input as Types['EnterpriseWorkflowSelect']; value = await workflows.select(actor, params.workspaceId!, params.flowId!, body.expectedStreamVersion, body.reference, key!); break; }
  }
  return { handled: true, value };
}
