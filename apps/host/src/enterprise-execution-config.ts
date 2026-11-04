// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { canonicalJson, parseEnterpriseContract, type BusinessObjectRef, type EnterpriseContractTypes, type JsonObject, type ProviderBinding } from '@mn/contracts';
import { BusinessDomainError, businessDigest, businessObjectKey, reduceBusinessEvents, type BusinessObject } from '@mn/plugin-business';
import { EnterpriseError, reduceIdentityEvents, requireActor, resolveObjectAccess, reduceAccessEvents, type EnterpriseActor, type EnterpriseRecord, type EnterpriseRepository } from '@mn/enterprise-services';
import { enterpriseBusinessFacts, businessAccessDescriptor, assertBusinessSourceClosure } from './enterprise-business.js';
type Settings = EnterpriseContractTypes['EnterpriseExecutionSettings'];
type PolicyView = EnterpriseContractTypes['EnterpriseExecutionPolicyView'];
export interface EnterpriseExecutionPolicy extends PolicyView {
    readonly relationSalt: string;
    readonly relationDigest: string;
    readonly acceptedEpoch?: number;
    readonly acceptedPermissionDigest?: string;
}
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
const key = (workspaceId: string, id: string) => canonicalJson([workspaceId, id]);
export function executionConfiguration(records: readonly EnterpriseRecord[], workspaceId: string) {
    let settings: Settings | undefined, binding: ProviderBinding | undefined;
    const policies = new Map<string, EnterpriseExecutionPolicy>();
    for (const event of records) {
        const value = event.payload.value as unknown as {
            workspaceId?: string;
            streamVersion?: number;
        };
        if (value?.workspaceId !== workspaceId)
            continue;
        if (event.type === 'enterprise.execution.settings_configured')
            settings = value as Settings;
        if (event.type === 'enterprise.execution.binding_registered')
            binding = value as ProviderBinding;
        if (event.type === 'enterprise.execution.policy_changed') {
            const policy = value as EnterpriseExecutionPolicy;
            policies.set(policy.id, policy);
        }
    }
    return { settings, binding, policies };
}
export function executionBusinessObject(records: readonly EnterpriseRecord[], reference: BusinessObjectRef, exact = true): BusinessObject {
    const object = reduceBusinessEvents(enterpriseBusinessFacts(records, reference.tenantId, reference.workspaceId)).objects.get(businessObjectKey(reference.objectType, reference.objectId));
    if (!object)
        throw new EnterpriseError('OBJECT_NOT_FOUND', 404);
    if (exact && canonicalJson(object.reference) !== canonicalJson(reference))
        throw new EnterpriseError('SOURCE_VERSION_CONFLICT', 409);
    return object;
}
export function executionObjectAccess(records: readonly EnterpriseRecord[], actor: EnterpriseActor, object: BusinessObject, operation: 'read' | 'write' | 'execution_approve', fields: readonly string[], now: string): void {
    const descriptor = businessAccessDescriptor(object), allowed = resolveObjectAccess(records, actor, descriptor, operation, now);
    if (fields.some(field => !descriptor.fieldClasses[field] || !allowed.has(descriptor.fieldClasses[field]!)))
        throw new EnterpriseError('FIELD_ACCESS_DENIED');
    assertBusinessSourceClosure(records, actor, object, fields, now);
    if (operation !== 'read') {
        const readable = resolveObjectAccess(records, actor, descriptor, 'read', now);
        if (fields.some(field => !readable.has(descriptor.fieldClasses[field]!)))
            throw new EnterpriseError('FIELD_ACCESS_DENIED');
    }
}
export function executionPermissionDigest(records: readonly EnterpriseRecord[], principalId: string, workspaceId: string): string { const state = reduceAccessEvents(records); return businessDigest([principalId, workspaceId, ...[...state.roles.values(), ...state.grants.values()].filter(r => r.principalId === principalId && r.workspaceId === workspaceId).sort((a, b) => a.id.localeCompare(b.id))]); }
export const executionSourceFields = (type: string): readonly string[] => type === 'customer' ? ['name'] : type === 'opportunity' ? ['title'] : type === 'quote_version' ? ['lines', 'totalMinor', 'validUntil'] : [];
export const executionRelationDigest = (object: BusinessObject, salt: string) => businessDigest([salt, ...['customer', 'order', 'project', 'contract'].map(field => (object.value[field] as unknown as {
        objectId?: string;
    } | undefined)?.objectId ?? null)]);
export function executionPolicyView(policy: EnterpriseExecutionPolicy): PolicyView { const { relationSalt: _salt, relationDigest: _digest, acceptedEpoch: _epoch, acceptedPermissionDigest: _permissions, ...view } = policy; return view; }
export class EnterpriseExecutionConfigurationService {
    private readonly now: () => string;
    constructor(readonly options: {
        repository: EnterpriseRepository;
        now?: () => string;
    }) { this.now = options.now ?? (() => new Date().toISOString()); }
    private bound(records: readonly EnterpriseRecord[], actor: EnterpriseActor, workspaceId: string, admin = false) { const state = reduceIdentityEvents(records), member = requireActor(state, actor, false, this.now()); if (!state.workspaces.has(workspaceId))
        throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404); if (admin && !member.organizationAdmin)
        throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED'); return member; }
    private async change<T>(actor: EnterpriseActor, workspaceId: string, requestKey: string, request: readonly [
        'settings' | 'binding' | 'policy' | 'accept' | 'revoke',
        ...unknown[]
    ], decide: (records: readonly EnterpriseRecord[]) => {
        type: string;
        id: string;
        expected: number;
        value: T;
        validate: () => void;
    }): Promise<T> {
        if (!requestKey.trim() || requestKey.length > 200)
            throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
        const receiptId = businessDigest([actor.principalId, workspaceId, requestKey]), requestDigest = businessDigest(request);
        return this.options.repository.transact(actor.tenantId, records => {
            const member = this.bound(records, actor, workspaceId);
            if (['settings', 'binding', 'policy'].includes(request[0]) && !member.organizationAdmin)
                throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
            if (request[0] === 'accept' || request[0] === 'revoke') {
                const policy = executionConfiguration(records, workspaceId).policies.get(String(request[1]));
                if (!policy || (!member.organizationAdmin && policy.responsiblePrincipalId !== actor.principalId))
                    throw new EnterpriseError('POLICY_NOT_FOUND', 404);
                if (request[0] === 'accept') {
                    if (policy.responsiblePrincipalId !== actor.principalId)
                        throw new EnterpriseError('POLICY_RESPONSIBLE_REQUIRED');
                    const object = executionBusinessObject(records, policy.target, false);
                    executionObjectAccess(records, actor, object, 'write', executionSourceFields(object.reference.objectType), this.now());
                    executionObjectAccess(records, actor, object, 'execution_approve', executionSourceFields(object.reference.objectType), this.now());
                }
            }
            const prior = records.find(e => e.type === 'enterprise.execution.command_recorded' && e.aggregateId === receiptId);
            if (prior) {
                if (prior.payload.requestDigest !== requestDigest)
                    throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
                return { events: [], value: prior.payload.value as unknown as T };
            }
            const result = decide(records);
            result.validate();
            const record = (type: string, aggregateType: string, id: string, expected: number, payload: unknown): EnterpriseRecord => ({ type, aggregateType, aggregateId: id, expectedStreamVersion: expected, actorId: actor.principalId, occurredAt: this.now(), payload: json(payload) });
            return { events: [record(result.type, result.type === 'enterprise.execution.policy_changed' ? 'enterprise.execution.policy' : result.type === 'enterprise.execution.settings_configured' ? 'enterprise.execution.settings' : 'enterprise.execution.binding', result.id, result.expected, { value: result.value }), record('enterprise.execution.command_recorded', 'enterprise.execution.command', receiptId, 0, { requestDigest, value: result.value })], value: result.value, assertBeforeCommit: result.validate };
        });
    }
    async configure(actor: EnterpriseActor, workspaceId: string, key_: string, input: EnterpriseContractTypes['EnterpriseExecutionSettingsWrite']): Promise<Settings> {
        const parsed = parseEnterpriseContract('EnterpriseExecutionSettingsWrite', input);
        return this.change(actor, workspaceId, key_, ['settings', parsed], records => {
            const validate = () => { this.bound(records, actor, workspaceId, true); };
            const previous = executionConfiguration(records, workspaceId).settings;
            if ((previous?.streamVersion ?? 0) !== parsed.expectedStreamVersion)
                throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
            if (new Set(parsed.responsibilities.map(role => role.id)).size !== parsed.responsibilities.length)
                throw new EnterpriseError('DUPLICATE_RESPONSIBILITY', 400);
            return { type: 'enterprise.execution.settings_configured', id: workspaceId, expected: parsed.expectedStreamVersion, value: { tenantId: actor.tenantId, workspaceId, streamVersion: parsed.expectedStreamVersion + 1, responsibilities: parsed.responsibilities }, validate };
        });
    }
    /** Only the Host supplies a vetted provider manifest; no caller can register arbitrary executable code. */
    async registerBinding(actor: EnterpriseActor, workspaceId: string, key_: string, expectedStreamVersion: number, binding: ProviderBinding): Promise<ProviderBinding> {
        parseEnterpriseContract('ProviderBinding', binding);
        return this.change(actor, workspaceId, key_, ['binding', binding, expectedStreamVersion], records => {
            const validate = () => { this.bound(records, actor, workspaceId, true); if (binding.tenantId !== actor.tenantId || binding.workspaceId !== workspaceId || binding.mode !== reduceIdentityEvents(records).workspaces.get(workspaceId)!.mode)
                throw new EnterpriseError('PROVIDER_SCOPE_MISMATCH'); };
            if ((executionConfiguration(records, workspaceId).binding?.streamVersion ?? 0) !== expectedStreamVersion || binding.streamVersion !== expectedStreamVersion + 1)
                throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
            if (new Set(binding.bindings.map(item => item.objectType)).size !== binding.bindings.length)
                throw new EnterpriseError('PROVIDER_RESPONSIBILITY_CONFLICT', 409);
            return { type: 'enterprise.execution.binding_registered', id: workspaceId, expected: expectedStreamVersion, value: binding, validate };
        });
    }
    async writePolicy(actor: EnterpriseActor, workspaceId: string, key_: string, input: EnterpriseContractTypes['EnterpriseExecutionPolicyWrite']): Promise<PolicyView> {
        const parsed = parseEnterpriseContract('EnterpriseExecutionPolicyWrite', input), salt = randomBytes(32).toString('hex');
        const result = await this.change(actor, workspaceId, key_, ['policy', parsed], records => {
            const state = executionConfiguration(records, workspaceId), previous = state.policies.get(parsed.id), binding = state.binding, entry = binding?.bindings.find(item => item.objectType === parsed.target.objectType), object = executionBusinessObject(records, parsed.target);
            const validate = () => { this.bound(records, actor, workspaceId, true); if (parsed.target.tenantId !== actor.tenantId || parsed.target.workspaceId !== workspaceId)
                throw new EnterpriseError('OBJECT_SCOPE_MISMATCH'); if (!reduceIdentityEvents(records).members.has(parsed.responsiblePrincipalId))
                throw new EnterpriseError('MEMBER_UNAVAILABLE'); if (!['customer', 'opportunity'].includes(parsed.target.objectType))
                throw new EnterpriseError('POLICY_ACTION_NOT_ALLOWED'); if (Date.parse(parsed.validUntil) <= Date.parse(this.now()))
                throw new EnterpriseError('POLICY_EXPIRED', 409); if (!binding || !entry || !entry.allowedActions.includes(parsed.action) || !['executeAction', 'getReceipt'].every(port => entry.supportedPorts.includes(port as never)))
                throw new EnterpriseError('PROVIDER_CAPABILITY_UNAVAILABLE', 409); const role = state.settings?.responsibilities.find(r => r.id === parsed.responsibilityId); if (!role?.capabilities.includes(parsed.action) || !role.fieldClasses.includes('public'))
                throw new EnterpriseError('RESPONSIBILITY_UNAVAILABLE', 409); };
            if ((previous?.streamVersion ?? 0) !== parsed.expectedStreamVersion)
                throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
            const { expectedStreamVersion, ...fields } = parsed;
            const value: EnterpriseExecutionPolicy = { ...fields, tenantId: actor.tenantId, workspaceId, streamVersion: expectedStreamVersion + 1, providerId: entry?.provider ?? '', providerBindingVersion: binding?.streamVersion ?? 0, status: 'awaiting_acceptance', relationSalt: salt, relationDigest: executionRelationDigest(object, salt) };
            return { type: 'enterprise.execution.policy_changed', id: key(workspaceId, parsed.id), expected: expectedStreamVersion, value, validate };
        });
        return executionPolicyView(result);
    }
    async acceptPolicy(actor: EnterpriseActor, workspaceId: string, id: string, expectedStreamVersion: number, key_: string): Promise<PolicyView> {
        const result = await this.change(actor, workspaceId, key_, ['accept', id, expectedStreamVersion], records => {
            const policy = executionConfiguration(records, workspaceId).policies.get(id);
            if (!policy)
                throw new EnterpriseError('POLICY_NOT_FOUND', 404);
            const validate = () => { this.bound(records, actor, workspaceId); if (actor.principalId !== policy.responsiblePrincipalId)
                throw new EnterpriseError('POLICY_RESPONSIBLE_REQUIRED'); if (Date.parse(policy.validUntil) <= Date.parse(this.now()))
                throw new EnterpriseError('POLICY_EXPIRED', 409); const state = executionConfiguration(records, workspaceId); if (state.binding?.streamVersion !== policy.providerBindingVersion)
                throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409); const responsibility = state.settings?.responsibilities.find(r => r.id === policy.responsibilityId); if (!responsibility?.capabilities.includes(policy.action))
                throw new EnterpriseError('RESPONSIBILITY_UNAVAILABLE', 409); const object = executionBusinessObject(records, policy.target); executionObjectAccess(records, actor, object, 'write', executionSourceFields(object.reference.objectType), this.now()); executionObjectAccess(records, actor, object, 'execution_approve', executionSourceFields(object.reference.objectType), this.now()); };
            if (policy.streamVersion !== expectedStreamVersion || policy.status !== 'awaiting_acceptance')
                throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
            return { type: 'enterprise.execution.policy_changed', id: key(workspaceId, id), expected: expectedStreamVersion, value: { ...policy, streamVersion: expectedStreamVersion + 1, status: 'active' as const, acceptedAt: this.now(), acceptedEpoch: actor.sessionEpoch, acceptedPermissionDigest: executionPermissionDigest(records, actor.principalId, workspaceId) }, validate };
        });
        return executionPolicyView(result);
    }
    async revokePolicy(actor: EnterpriseActor, workspaceId: string, id: string, expectedStreamVersion: number, key_: string): Promise<PolicyView> {
        const result = await this.change(actor, workspaceId, key_, ['revoke', id, expectedStreamVersion], records => {
            const policy = executionConfiguration(records, workspaceId).policies.get(id);
            if (!policy)
                throw new EnterpriseError('POLICY_NOT_FOUND', 404);
            const validate = () => { const member = this.bound(records, actor, workspaceId); if (!member.organizationAdmin && policy.responsiblePrincipalId !== actor.principalId)
                throw new EnterpriseError('POLICY_RESPONSIBLE_REQUIRED'); };
            if (policy.streamVersion !== expectedStreamVersion)
                throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
            return { type: 'enterprise.execution.policy_changed', id: key(workspaceId, id), expected: expectedStreamVersion, value: { ...policy, streamVersion: expectedStreamVersion + 1, status: 'revoked' as const }, validate };
        });
        return executionPolicyView(result);
    }
    async get(actor: EnterpriseActor, workspaceId: string): Promise<EnterpriseContractTypes['EnterpriseExecutionConfiguration']> { const records = await this.options.repository.read(actor.tenantId), member = this.bound(records, actor, workspaceId), state = executionConfiguration(records, workspaceId); return { ...(state.settings ? { settings: state.settings } : {}), ...(state.binding ? { binding: state.binding } : {}), policies: [...state.policies.values()].filter(p => member.organizationAdmin || p.responsiblePrincipalId === actor.principalId).map(executionPolicyView) }; }
}
