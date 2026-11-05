// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes as Types } from '@mn/contracts';
import type { ProviderResult } from '@mn/plugin-sdk';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseProviderService } from './enterprise-provider-service.js';

const supported = <T>(result: ProviderResult<T>): T => {
  if (result.status !== 'supported') throw new EnterpriseError('PROVIDER_CAPABILITY_UNAVAILABLE', 409);
  return result.value;
};
export async function dispatchEnterpriseProviders(options: {
  operationId: string;
  params: Readonly<Record<string, string>>;
  actor: EnterpriseActor;
  input: unknown;
  key?: string;
  businessProviders?: EnterpriseProviderService;
}): Promise<{ handled: false } | { handled: true; value: unknown }> {
  const { operationId, params, actor, input, key, businessProviders } = options;
  if (!['initializeEnterpriseProvider', 'readEnterpriseProviderSnapshot', 'listEnterpriseProviderChanges', 'readEnterpriseProviderContent', 'createEnterpriseProviderAction', 'previewEnterpriseProviderAction', 'readEnterpriseProviderPackage', 'readEnterpriseProviderReceiptEvidence'].includes(operationId)) return { handled: false };
  if (!businessProviders) throw new EnterpriseError('PROVIDER_RUNTIME_UNCONFIGURED', 503);
  const workspaceId = params.workspaceId!;
  let value: unknown;
  switch (operationId) {
    case 'initializeEnterpriseProvider': value = await businessProviders.initialize(actor, workspaceId, (input as Types['EnterpriseProviderInitialization']).expectedStreamVersion, key!); break;
    case 'createEnterpriseProviderAction': value = await businessProviders.createAction(actor, workspaceId, key!, input as Types['EnterpriseProviderActionCreate']); break;
    case 'previewEnterpriseProviderAction': value = await businessProviders.previewAction(actor, params.actionId!); break;
    default: {
      const provider = await businessProviders.forActor(actor, workspaceId), context = businessProviders.context(actor, workspaceId);
      if (operationId === 'readEnterpriseProviderSnapshot') {
        const reference = input as Types['EnterpriseProviderObjectReference'];
        if (reference.tenantId !== actor.tenantId || reference.workspaceId !== workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
        value = supported(await provider.readSnapshot(reference, context));
      }
      if (operationId === 'listEnterpriseProviderChanges') value = supported(await provider.listChanges((input as Types['EnterpriseProviderChangesQuery']).cursor, context));
      if (operationId === 'readEnterpriseProviderContent') value = await provider.readContent((input as Types['EnterpriseProviderContentQuery']).reference, context);
      if (operationId === 'readEnterpriseProviderPackage') value = await provider.readPackage((input as Types['EnterpriseProviderContentQuery']).reference, context);
      if (operationId === 'readEnterpriseProviderReceiptEvidence') value = await provider.readReceiptEvidence((input as Types['EnterpriseProviderContentQuery']).reference, context);
    }
  }
  return { handled: true, value };
}
