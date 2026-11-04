// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseBusinessService } from './enterprise-business.js';
export async function dispatchEnterpriseBusiness(options: { operationId: string; params: Readonly<Record<string,string>>; actor: EnterpriseActor; input: unknown; key?: string; business: EnterpriseBusinessService }): Promise<{ handled: true; value: unknown } | { handled: false }> {
  const { operationId, params, actor, input, key, business } = options, workspaceId = params.workspaceId!;
  let value: unknown;
  switch(operationId) {
    case 'getBusinessBalance': value=await business.summary(actor,workspaceId,'balance',params.orderId!,params.asOfDate!);break;
    case 'getBusinessProgress': value=await business.summary(actor,workspaceId,'progress',params.projectId!);break;
    case 'getBusinessCosts': value=await business.summary(actor,workspaceId,'costs',params.projectId!);break;
    case 'getBusinessApproval': value = await business.getApproval(actor,workspaceId,params.approvalId!); break;
    case 'executeBusinessCommand': value = await business.execute({ actor, actorKind:'human', workspaceId, idempotencyKey:key!, command:input as EnterpriseContractTypes['EnterpriseBusinessCommand'] }); break;
    case 'listBusinessObjects': value = await business.list(actor,workspaceId,params.objectType!); break;
    case 'getBusinessObject': value = await business.get(actor,workspaceId,params.objectType!,params.objectId!); break;
    case 'getBusinessObjectVersion': {
      if (!/^[1-9][0-9]*$/u.test(params.streamVersion!)) throw new EnterpriseError('INVALID_VERSION',400);
      value = await business.get(actor,workspaceId,params.objectType!,params.objectId!,Number(params.streamVersion)); break;
    }
    case 'recordBusinessEvidence': value = await business.recordEvidence({ ...input as EnterpriseContractTypes['EnterpriseBusinessEvidenceCreate'], actor, actorKind:'human', workspaceId, idempotencyKey:key! }); break;
    case 'getBusinessEvidence': value = await business.getEvidence(actor,workspaceId,params.evidenceId!); break;
    case 'withdrawBusinessEvidence': value = await business.withdrawEvidence(actor,workspaceId,params.evidenceId!, (input as EnterpriseContractTypes['EnterpriseBusinessEvidenceWithdraw']).expectedStreamVersion,key!); break;
    default: return { handled:false };
  }
  return { handled:true, value };
}
