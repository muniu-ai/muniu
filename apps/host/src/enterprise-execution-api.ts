// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseExecutionConfigurationService } from './enterprise-execution-config.js';
import type { EnterpriseExecutionRuntime } from './enterprise-execution-runtime.js';
export async function dispatchEnterpriseExecution(options: {
    operationId: string;
    params: Readonly<Record<string, string>>;
    actor: EnterpriseActor;
    input: unknown;
    key?: string;
    configuration: EnterpriseExecutionConfigurationService;
    runtime?: EnterpriseExecutionRuntime;
}): Promise<{
    handled: false;
} | {
    handled: true;
    value: unknown;
}> {
    const { operationId, params, actor, input, key, configuration } = options;
    let value: unknown;
    switch (operationId) {
        case 'getExecutionConfiguration':
            value = await configuration.get(actor, params.workspaceId!);
            break;
        case 'configureExecutionSettings':
            value = await configuration.configure(actor, params.workspaceId!, key!, input as EnterpriseContractTypes['EnterpriseExecutionSettingsWrite']);
            break;
        case 'writeExecutionPolicy':
            value = await configuration.writePolicy(actor, params.workspaceId!, key!, input as EnterpriseContractTypes['EnterpriseExecutionPolicyWrite']);
            break;
        case 'acceptExecutionPolicy':
            value = await configuration.acceptPolicy(actor, params.workspaceId!, params.policyId!, (input as EnterpriseContractTypes['EnterpriseExecutionPolicyCommand']).expectedStreamVersion, key!);
            break;
        case 'revokeExecutionPolicy':
            value = await configuration.revokePolicy(actor, params.workspaceId!, params.policyId!, (input as EnterpriseContractTypes['EnterpriseExecutionPolicyCommand']).expectedStreamVersion, key!);
            break;
        default: {
            if (!['getEnterpriseAction', 'getEnterpriseExecutionApproval', 'decideEnterpriseExecutionApproval', 'cancelEnterpriseAction', 'reconcileEnterpriseAction'].includes(operationId))
                return { handled: false };
            const runtime = options.runtime;
            if (!runtime)
                throw new EnterpriseError('EXECUTION_RUNTIME_UNCONFIGURED', 503);
            if (operationId === 'getEnterpriseAction')
                value = await runtime.view(actor, params.actionId!);
            if (operationId === 'getEnterpriseExecutionApproval')
                value = await runtime.getApproval(actor, params.approvalId!);
            if (operationId === 'decideEnterpriseExecutionApproval') {
                const body = input as EnterpriseContractTypes['EnterpriseExecutionApprovalDecision'];
                const action = await runtime.decide(actor, key!, params.approvalId!, body.expectedStreamVersion, body.actionDigest, body.decision);
                value = await runtime.view(actor, action.id);
            }
            if (operationId === 'cancelEnterpriseAction') {
                const body = input as EnterpriseContractTypes['EnterpriseActionControl'];
                const action = await runtime.cancel(actor, key!, params.actionId!, body.expectedStreamVersion);
                value = { actionId: action.id, streamVersion: action.streamVersion, status: action.status, cancelRequested: !!action.cancelRequestedAt, ...(action.localOutcome ? { localOutcome: action.localOutcome } : {}) };
            }
            if (operationId === 'reconcileEnterpriseAction') {
                const body = input as EnterpriseContractTypes['EnterpriseActionControl'];
                const action = await runtime.reconcile(actor, key!, params.actionId!, body.expectedStreamVersion);
                value = await runtime.view(actor, action.id);
            }
        }
    }
    return { handled: true, value };
}
