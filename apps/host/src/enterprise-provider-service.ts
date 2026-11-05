// SPDX-License-Identifier: Apache-2.0
import { parseEnterpriseContract, type EnterpriseContractTypes, type ProviderBinding } from '@mn/contracts';
import type { BusinessProviderContext, BusinessProviderContribution } from '@mn/plugin-sdk';
import { sha256, type KernelStore } from '@mn/kernel';
import { BUSINESS_FIELD_CLASSES } from '@mn/plugin-business';
import { EnterpriseError, requireActor, reduceIdentityEvents, type EnterpriseActor } from '@mn/enterprise-services';
import type { ContentAddressedStorage, KeyProvider } from '@mn/storage';
import type { EnterpriseEventRepository } from './enterprise-event-repository.js';
import { EnterpriseBuiltinProvider } from './enterprise-builtin-provider.js';
import { EnterpriseExecutionRuntime } from './enterprise-execution-runtime.js';
import { EnterpriseExecutionConfigurationService, executionConfiguration } from './enterprise-execution-config.js';
const SALES_TYPES = new Set(['customer','contact','opportunity','followup_task','service_version','quote_version','contract','order','payment_schedule','receipt','refund','adjustment','expense']);
export class EnterpriseProviderService {
  readonly configuration: EnterpriseExecutionConfigurationService;
  constructor(readonly options: { store: KernelStore; repository: EnterpriseEventRepository; protection: { cas: ContentAddressedStorage; keyProvider: KeyProvider }; execution: EnterpriseExecutionRuntime; now?: () => string }) { this.configuration = new EnterpriseExecutionConfigurationService(options); }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  context(actor: EnterpriseActor, workspaceId: string): BusinessProviderContext { return { tenantId: actor.tenantId, workspaceId, principalId: actor.principalId, principalSessionEpoch: actor.sessionEpoch, signal: new AbortController().signal }; }
  async initialize(actor: EnterpriseActor, workspaceId: string, expected: number, key: string): Promise<ProviderBinding> {
    const identity = reduceIdentityEvents(await this.options.repository.read(actor.tenantId)), member = requireActor(identity, actor, true, this.now()), workspace = identity.workspaces.get(workspaceId);
    if (!member.organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
    if (!workspace) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404);
    const binding: ProviderBinding = { id: workspaceId, tenantId: actor.tenantId, workspaceId, streamVersion: expected + 1, mode: workspace.mode, bindings: Object.keys(BUSINESS_FIELD_CLASSES).map(objectType => {
      const type = objectType as ProviderBinding['bindings'][number]['objectType'], available = workspace.mode === 'builtin';
      const allowedActions: ProviderBinding['bindings'][number]['allowedActions'] = !available ? [] : type === 'quote_version' ? ['issue_quote_package'] : ['customer','opportunity'].includes(type) ? ['create_followup_task','update_followup_date'] : [];
      return { objectType: type, provider: workspace.mode === 'sales' && SALES_TYPES.has(type) ? 'sales' : 'builtin', allowedActions, supportedPorts: !available ? [] : allowedActions.length ? ['readSnapshot','listChanges','prepareAction','executeAction','getReceipt'] : ['readSnapshot','listChanges'] };
    }) };
    return this.configuration.registerBinding(actor, workspaceId, key, expected, binding);
  }
  async forActor(actor: EnterpriseActor, workspaceId: string): Promise<EnterpriseBuiltinProvider> {
    const config = await this.configuration.get(actor, workspaceId);
    if (!config.binding) throw new EnterpriseError('PROVIDER_BINDING_REQUIRED', 409);
    if (config.binding.mode !== 'builtin') throw new EnterpriseError('PROVIDER_CONNECTION_UNCONFIGURED', 503);
    return this.builtin(config.binding, async context => {
      if (context.principalId !== actor.principalId || context.tenantId !== actor.tenantId) throw new EnterpriseError('PROVIDER_CONTEXT_MISMATCH');
      return actor;
    });
  }
  private builtin(binding: ProviderBinding, actorFor: (context: BusinessProviderContext) => Promise<EnterpriseActor>): EnterpriseBuiltinProvider {
    return new EnterpriseBuiltinProvider({ ...this.options, binding, actorFor, assertExecution: (tx, records, intent, context) => this.options.execution.assertProviderExecution(tx, records, intent, context) });
  }
  async resolveRuntime(tenantId: string, workspaceId: string, providerId: string): Promise<BusinessProviderContribution> {
    const binding = executionConfiguration(await this.options.repository.read(tenantId), workspaceId).binding;
    if (!binding) throw new EnterpriseError('PROVIDER_BINDING_REQUIRED', 409);
    if (providerId !== 'builtin' || binding.mode !== 'builtin') throw new EnterpriseError('PROVIDER_CONNECTION_UNCONFIGURED', 503);
    return this.builtin(binding, context => this.options.execution.providerActor(context));
  }
  async createAction(actor: EnterpriseActor, workspaceId: string, key: string, raw: EnterpriseContractTypes['EnterpriseProviderActionCreate']): Promise<EnterpriseContractTypes['EnterpriseActionView']> {
    if (!key.trim() || key.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    const input = parseEnterpriseContract('EnterpriseProviderActionCreate', raw), provider = await this.forActor(actor, workspaceId);
    const configuration = await this.configuration.get(actor, workspaceId);
    if (!configuration.settings?.responsibilities.some(r => r.id === input.responsibilityId && r.capabilities.includes(input.action))) throw new EnterpriseError('RESPONSIBILITY_UNAVAILABLE', 409);
    const operationKey = 'manual-operation:' + sha256([actor.tenantId, workspaceId, actor.principalId, key]);
    const { responsibilityId, policyId, ...actionInput } = input;
    let previous: Awaited<ReturnType<EnterpriseExecutionRuntime['get']>> | undefined;
    try { previous = await this.options.execution.get(actor, 'action:' + sha256([actor.tenantId, operationKey])); }
    catch (error) { if (!(error instanceof EnterpriseError) || error.code !== 'ACTION_NOT_FOUND') throw error; }
    const request = parseEnterpriseContract('EnterpriseProviderActionPreparation', { ...actionInput, tenantId: actor.tenantId, workspaceId, operationKey, providerBindingVersion: previous?.providerBindingVersion ?? provider.binding.streamVersion });
    let prepared: EnterpriseContractTypes['EnterpriseProviderPreparedAction'];
    if (previous) {
      const preview = await provider.readPrepared(previous.preparedInputRef, this.context(actor, workspaceId));
      if (sha256(preview.request) !== sha256(request)) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
      prepared = { preparedInputRef: previous.preparedInputRef, inputDigest: previous.inputDigest, target: previous.target, expiresAt: previous.expiresAt };
    } else {
      const result = await provider.prepareAction(request, this.context(actor, workspaceId));
      if (result.status !== 'supported') throw new EnterpriseError('PROVIDER_CAPABILITY_UNAVAILABLE', 409);
      prepared = result.value;
    }
    if ('provider' in input.target) throw new EnterpriseError('PROVIDER_NOT_RESPONSIBLE', 409);
    const action = await this.options.execution.prepare(actor, { ...prepared, target: input.target, idempotencyKey: key, operationKey, goalId: 'manual-work:' + sha256(operationKey), nodeId: input.action, attemptId: 'manual-attempt:' + sha256(operationKey), responsibilityId, action: input.action, amount: { tokens: 0, costMinorUnits: '0', currency: 'CNY' }, goalBudget: { tokens: 0, costMinorUnits: '0', currency: 'CNY' }, ...('businessApprovalRef' in input ? { businessApprovalRef: input.businessApprovalRef } : {}), ...(policyId ? { policyId } : {}) });
    return this.options.execution.view(actor, action.id);
  }
  async previewAction(actor: EnterpriseActor, id: string): Promise<EnterpriseContractTypes['EnterpriseProviderActionPreview']> {
    const action = await this.options.execution.get(actor, id), provider = await this.forActor(actor, action.workspaceId);
    return provider.readPrepared(action.preparedInputRef, this.context(actor, action.workspaceId));
  }
}
