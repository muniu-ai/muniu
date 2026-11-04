// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseEvaluationRuntime } from './enterprise-evaluation.js';
import type { EnterpriseOperatingService } from './enterprise-operating.js';
export async function dispatchEnterpriseOperating(options: { operationId: string; params: Readonly<Record<string, string>>; actor: EnterpriseActor; input: unknown; key?: string; operating?: EnterpriseOperatingService; evaluation?: EnterpriseEvaluationRuntime }): Promise<{ handled: false } | { handled: true; value: unknown }> {
  const { operationId, params, actor, input, key, operating } = options;
  if (operationId === 'getEnterpriseEvaluation') { if (!options.evaluation) throw new EnterpriseError('EVALUATION_RUNTIME_UNCONFIGURED', 503); return { handled: true, value: await options.evaluation.view(actor, params.attemptId!) }; }
  if (!['getOperatingState', 'writeOperatingPolicy', 'controlOperatingPolicy', 'submitOperatingRequest', 'cancelOperatingBatch', 'subscribeOperatingBatch', 'getOperatingUpdates'].includes(operationId)) return { handled: false };
  if (!operating) throw new EnterpriseError('OPERATING_RUNTIME_UNCONFIGURED', 503);
  let value: unknown;
  switch (operationId) {
    case 'getOperatingState': value = await operating.inspect(actor, params.workspaceId!); break;
    case 'writeOperatingPolicy': value = await operating.writePolicy(actor, params.workspaceId!, key!, input as EnterpriseContractTypes['EnterpriseOperatingPolicyWrite']); break;
    case 'controlOperatingPolicy': {
      const body = input as EnterpriseContractTypes['EnterpriseOperatingPolicyControl'];
      value = await operating.controlPolicy(actor, params.workspaceId!, params.policyId!, body.command, body.expectedStreamVersion, key!); break;
    }
    case 'submitOperatingRequest': value = await operating.submit(actor, params.workspaceId!, key!, input as EnterpriseContractTypes['EnterpriseOperatingRequest']); break;
    case 'cancelOperatingBatch': value = await operating.cancel(actor, params.workspaceId!, params.batchId!, (input as EnterpriseContractTypes['EnterpriseOperatingBatchControl']).expectedStreamVersion, key!); break;
    case 'subscribeOperatingBatch': value = await operating.subscribe(actor, params.workspaceId!, params.batchId!, (input as EnterpriseContractTypes['EnterpriseOperatingBatchControl']).expectedStreamVersion, key!); break;
    case 'getOperatingUpdates': value = await operating.updates(actor, params.workspaceId!, params.batchId!); break;
  }
  return { handled: true, value };
}
