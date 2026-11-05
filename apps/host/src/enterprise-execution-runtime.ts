// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { canonicalJson, actionIntentView, computeActionIntentDigest, type ActionIntent, type ActionReceipt, type Approval, type BudgetAmountV1, type BudgetAccountV1, type BusinessObjectRef, type Execution, type ExecutionAuthority, type Job, type EnterpriseContractTypes, type JsonObject } from '@mn/contracts';
import { AgentOsKernel, computeExecutionAuthorityCommitment, appendKernelEvent, createBudgetAccount, sha256, type KernelStore, type KernelTransaction } from '@mn/kernel';
import { ActionCoordinator, verifiedActionUsage, PROVIDER_ACTION_AGENT_ID, PROVIDER_ACTION_NAMESPACE, type CoordinatedAction, type ActionPolicyContext } from '@mn/business-execution';
import { AgentOsWorker, createProviderActionWorkerHandler, type WorkerLockState, type WorkerJobStore as WorkerStore, type WorkerJobHandler } from '@mn/worker';
import type { BusinessProviderContribution, BusinessProviderContext } from '@mn/plugin-sdk';
import { EnterpriseError, assertModelQuota, assertBusinessDecisionAccess, reduceIdentityEvents, reduceAccessEvents, reduceQuotaEvents, requireActor, type EnterpriseActor, type FieldClass } from '@mn/enterprise-services';
import { reduceBusinessEvents } from '@mn/plugin-business';
import { EnterpriseKernelBridge, ENTERPRISE_SYSTEM_PREFIX, ENTERPRISE_AGENT_PREFIX, enterpriseBudgetPrincipal } from './enterprise-kernel-bridge.js';
import type { EnterpriseEventRepository, EnterpriseSnapshot } from './enterprise-event-repository.js';
import { executionConfiguration, executionBusinessObject, executionObjectAccess, executionSourceFields, executionRelationDigest, executionPermissionDigest, type EnterpriseExecutionPolicy } from './enterprise-execution-config.js';
import { businessAccessDescriptor, enterpriseBusinessFacts } from './enterprise-business.js';
const SCOPE = 'execution.enterprise_scope', APPROVAL_CONTEXT = 'execution.approval_context';
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
export interface TrustedEnterpriseActionInput {
    readonly idempotencyKey: string;
    readonly operationKey: string;
    readonly goalId: string;
    readonly nodeId: string;
    readonly attemptId: string;
    readonly responsibilityId: string;
    readonly target: BusinessObjectRef;
    readonly action: ActionIntent['action'];
    readonly preparedInputRef: string;
    readonly inputDigest: string;
    readonly expiresAt: string;
    readonly amount: BudgetAmountV1;
    readonly goalBudget: BudgetAmountV1;
    readonly businessApprovalRef?: string;
    readonly policyId?: string;
    readonly inputSources?: readonly {
        readonly reference: BusinessObjectRef;
        readonly fields: readonly string[];
    }[];
}
interface Scope {
    readonly id: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly executionId: string;
    readonly authorityId: string;
    readonly authorityCommitment: string;
    readonly digest: string;
    readonly template: {
        readonly salt: string;
        readonly owner: EnterpriseActor;
        readonly permissionDigest: string;
        readonly responsibilityId: string;
        readonly settingsVersion: number;
        readonly provider: string;
        readonly providerVersion: string;
        readonly bindingVersion: number;
        readonly capability: ActionIntent['action'];
        readonly target: BusinessObjectRef;
        readonly sources: readonly {
            readonly reference: BusinessObjectRef;
            readonly fields: readonly string[];
        }[];
        readonly expiresAt: string;
        readonly goalId: string;
        readonly amount: BudgetAmountV1;
        readonly goalBudget: BudgetAmountV1;
        readonly inputDigest: string;
        readonly policyId?: string;
        readonly policyVersion?: number;
    };
    readonly workspaceAccountId: string;
    readonly requestDigest: string;
    readonly streamVersion: number;
}
interface ApprovalContext {
    readonly id: string;
    readonly actionId: string;
    readonly actor: EnterpriseActor;
    readonly permissionDigest: string;
    readonly mode: 'manual' | 'policy';
    readonly policyId?: string;
    readonly policyVersion?: number;
    readonly streamVersion: number;
}
const permissionDigest = (snapshot: EnterpriseSnapshot, principalId: string, workspaceId: string) => executionPermissionDigest(snapshot.records, principalId, workspaceId);
export class EnterpriseExecutionRuntime {
    readonly bridge: EnterpriseKernelBridge;
    readonly kernel: AgentOsKernel;
    readonly coordinator: ActionCoordinator;
    private readonly now: () => string;
    constructor(readonly options: {
        store: KernelStore;
        repository: EnterpriseEventRepository;
        now?: () => string;
        resolveProvider: (tenantId: string, workspaceId: string, providerId: string) => Promise<BusinessProviderContribution>;
        usageForReceipt: (receipt: ActionReceipt, action: CoordinatedAction) => BudgetAmountV1;
    }) {
        this.now = options.now ?? (() => new Date().toISOString());
        this.bridge = new EnterpriseKernelBridge(options);
        this.kernel = new AgentOsKernel(this.bridge.store, { now: this.now });
        this.coordinator = new ActionCoordinator({ store: this.bridge.store, kernel: this.kernel, now: this.now, assertCurrent: (tx, context) => {
                const check = () => this.admit(tx, context);
                check();
                if (!(context.phase === 'cancel' && context.lease))
                    tx.beforeCommit!(check);
            } });
    }
    private actor(snapshot: EnterpriseSnapshot, actor: EnterpriseActor): void { if (actor.tenantId !== snapshot.tenantId || actor.principalId.startsWith(ENTERPRISE_SYSTEM_PREFIX) || actor.principalId.startsWith(ENTERPRISE_AGENT_PREFIX))
        throw new EnterpriseError('EXECUTION_PRINCIPAL_INVALID'); requireActor(reduceIdentityEvents(snapshot.records), actor, false, this.now()); }
    private scope(tx: KernelTransaction, executionId: string): Scope { const scope = tx.getProjection<Scope>(SCOPE, executionId); if (!scope || sha256(scope.template) !== scope.digest)
        throw new EnterpriseError('EXECUTION_SCOPE_INVALID', 503); const authority = tx.getProjection<ExecutionAuthority>('authority', scope.authorityId); if (!authority || authority.executionId !== executionId || authority.commitment !== scope.authorityCommitment || computeExecutionAuthorityCommitment(authority) !== scope.authorityCommitment || !authority.dataScopes.some(r => r.namespace === SCOPE && r.resourceId === scope.id && r.digest === scope.digest))
        throw new EnterpriseError('EXECUTION_SCOPE_INVALID', 503); return scope; }
    private getAction(tx: KernelTransaction, tenantId: string, id: string): CoordinatedAction { const action = tx.getProjection<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE, id); if (!action || action.tenantId !== tenantId)
        throw new EnterpriseError('ACTION_NOT_FOUND', 404); return action; }
    private readScope(tx: KernelTransaction, scope: Scope, actor: EnterpriseActor, supplied?: EnterpriseSnapshot): void { const snapshot = supplied ?? this.bridge.snapshot(tx); this.actor(snapshot, actor); for (const source of scope.template.sources) {
        const object = executionBusinessObject(snapshot.records, source.reference, false);
        executionObjectAccess(snapshot.records, actor, object, 'read', source.fields, this.now());
    } }
    private validateRequest(snapshot: EnterpriseSnapshot, actor: EnterpriseActor, input: TrustedEnterpriseActionInput) {
        this.actor(snapshot, actor);
        const workspaceId = input.target.workspaceId;
        if (input.target.tenantId !== actor.tenantId)
            throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
        const target = executionBusinessObject(snapshot.records, input.target), fields = executionSourceFields(input.target.objectType);
        if (!fields.length || (input.action === 'issue_quote_package' ? input.target.objectType !== 'quote_version' : !['customer', 'opportunity'].includes(input.target.objectType)))
            throw new EnterpriseError('ACTION_TARGET_UNSUPPORTED', 409);
        executionObjectAccess(snapshot.records, actor, target, 'write', fields, this.now());
        const configuration = executionConfiguration(snapshot.records, workspaceId), role = configuration.settings?.responsibilities.find(r => r.id === input.responsibilityId), binding = configuration.binding;
        if (!role?.capabilities.includes(input.action))
            throw new EnterpriseError('RESPONSIBILITY_UNAVAILABLE', 409);
        const sources = [{ reference: input.target, fields }, ...input.inputSources ?? []];
        for (const source of sources) {
            if (source.reference.tenantId !== actor.tenantId || source.reference.workspaceId !== workspaceId)
                throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
            const object = executionBusinessObject(snapshot.records, source.reference);
            const descriptor = businessAccessDescriptor(object);
            if (source.fields.some(field => !descriptor.fieldClasses[field] || !role.fieldClasses.includes(descriptor.fieldClasses[field]!)))
                throw new EnterpriseError('RESPONSIBILITY_FIELD_DENIED');
            executionObjectAccess(snapshot.records, actor, object, 'read', source.fields, this.now());
        }
        const entry = binding?.bindings.find(b => b.objectType === input.target.objectType);
        if (!binding || !entry || !entry.allowedActions.includes(input.action) || !['executeAction', 'getReceipt'].every(port => entry.supportedPorts.includes(port as never)))
            throw new EnterpriseError('PROVIDER_CAPABILITY_UNAVAILABLE', 409);
        if (input.amount.currency !== 'CNY' || input.goalBudget.currency !== 'CNY' || input.amount.tokens > input.goalBudget.tokens || BigInt(input.amount.costMinorUnits) > BigInt(input.goalBudget.costMinorUnits))
            throw new EnterpriseError('EXECUTION_BUDGET_INVALID', 400);
        if (input.amount.tokens !== 0 || input.amount.costMinorUnits !== '0' || input.goalBudget.tokens !== 0 || input.goalBudget.costMinorUnits !== '0') assertModelQuota(snapshot.records, actor, workspaceId, { tokens: Math.max(input.goalBudget.tokens, 1), costMinorUnits: input.goalBudget.costMinorUnits, expiresAt: input.expiresAt, purpose: 'goal' }, this.now());
        if (input.action === 'issue_quote_package') {
            if (!input.businessApprovalRef || target.value.approvalId !== input.businessApprovalRef || !['approved', 'accepted'].includes(String(target.value.status)) || Date.parse(String(target.value.validUntil)) < Date.parse(input.expiresAt))
                throw new EnterpriseError('BUSINESS_APPROVAL_REQUIRED', 409);
        }
        return { target, fields, sources, configuration, role, binding, entry };
    }
    private policy(snapshot: EnterpriseSnapshot, actor: EnterpriseActor, data: Pick<Scope['template'], 'policyId' | 'responsibilityId' | 'capability' | 'target' | 'expiresAt' | 'sources'>, exact = true): EnterpriseExecutionPolicy | undefined {
        if (!data.policyId)
            return undefined;
        if (data.capability === 'issue_quote_package')
            throw new EnterpriseError('POLICY_ACTION_NOT_ALLOWED');
        const policy = executionConfiguration(snapshot.records, data.target.workspaceId).policies.get(data.policyId);
        if (!policy || policy.status !== 'active')
            throw new EnterpriseError('POLICY_NOT_ACTIVE', 409);
        if (policy.responsiblePrincipalId !== actor.principalId || policy.action !== data.capability || policy.responsibilityId !== data.responsibilityId || policy.target.objectType !== data.target.objectType || policy.target.objectId !== data.target.objectId || policy.target.tenantId !== actor.tenantId || policy.target.workspaceId !== data.target.workspaceId)
            throw new EnterpriseError('POLICY_SCOPE_MISMATCH');
        if (policy.acceptedEpoch !== actor.sessionEpoch || policy.acceptedPermissionDigest !== permissionDigest(snapshot, actor.principalId, data.target.workspaceId))
            throw new EnterpriseError('POLICY_ACCEPTANCE_STALE');
        if (Date.parse(policy.validUntil) <= Date.parse(this.now()) || Date.parse(data.expiresAt) > Date.parse(policy.validUntil))
            throw new EnterpriseError('POLICY_EXPIRED', 409);
        const configuration = executionConfiguration(snapshot.records, data.target.workspaceId), entry = configuration.binding?.bindings.find(b => b.objectType === data.target.objectType);
        if (configuration.binding?.streamVersion !== policy.providerBindingVersion || entry?.provider !== policy.providerId)
            throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409);
        const target = executionBusinessObject(snapshot.records, data.target, exact), fields = executionSourceFields(data.target.objectType);
        if (executionRelationDigest(target, policy.relationSalt) !== policy.relationDigest || data.sources.some(s => s.reference.objectId !== data.target.objectId || s.reference.objectType !== data.target.objectType || s.fields.some(field => !fields.includes(field))))
            throw new EnterpriseError('POLICY_SCOPE_MISMATCH');
        executionObjectAccess(snapshot.records, actor, target, 'execution_approve', fields, this.now());
        return policy;
    }
    private policyCounterId(workspaceId: string, policyId: string): string { return canonicalJson([workspaceId, policyId]); }
    private reservePolicy(tx: KernelTransaction, scope: Scope, action: CoordinatedAction, policy: EnterpriseExecutionPolicy): void {
        if (tx.getProjection('execution.policy_use', action.id))
            return;
        const id = this.policyCounterId(scope.workspaceId, policy.id), current = tx.getProjection<{
            count: number;
            streamVersion: number;
        }>('execution.policy_counter', id);
        if ((current?.count ?? 0) >= policy.maxActions)
            throw new EnterpriseError('POLICY_LIMIT_REACHED', 409);
        this.record(tx, 'execution.policy_counter', id, { id, workspaceId: scope.workspaceId, policyId: policy.id, count: (current?.count ?? 0) + 1, streamVersion: (current?.streamVersion ?? 0) + 1 }, 'policy.usage_recorded', ENTERPRISE_SYSTEM_PREFIX + 'policy', current?.streamVersion ?? 0);
        this.record(tx, 'execution.policy_use', action.id, { id: action.id, workspaceId: scope.workspaceId, policyId: policy.id, policyVersion: policy.streamVersion, streamVersion: 1 }, 'policy.action_reserved', ENTERPRISE_SYSTEM_PREFIX + 'policy');
    }
    private businessApproval(snapshot: EnterpriseSnapshot, scope: Scope, action: ActionIntent): void {
        if (action.action !== 'issue_quote_package')
            return;
        const object = executionBusinessObject(snapshot.records, action.target as BusinessObjectRef), state = reduceBusinessEvents(enterpriseBusinessFacts(snapshot.records, scope.tenantId, scope.workspaceId)), approval = state.approvals.get(String(action.businessApprovalRef));
        if (!approval || approval.id !== object.value.approvalId || approval.decision !== 'approve' || (approval.subjectRef as unknown as BusinessObjectRef).objectId !== object.reference.objectId || !['approved', 'accepted'].includes(String(object.value.status)) || Date.parse(String(object.value.validUntil)) <= Date.parse(this.now()))
            throw new EnterpriseError('BUSINESS_APPROVAL_REQUIRED', 409);
        const approver = reduceIdentityEvents(snapshot.records).members.get(String(approval.approvedByPrincipalId));
        if (!approver)
            throw new EnterpriseError('MEMBER_UNAVAILABLE');
        assertBusinessDecisionAccess(snapshot.records, { tenantId: scope.tenantId, principalId: approver.id, sessionEpoch: approver.sessionEpoch }, { ...businessAccessDescriptor(object), approvalFields: ['lines', 'totalMinor', 'validUntil'] }, String(object.value.preparedByPrincipalId), this.now());
    }
    private admit(tx: KernelTransaction, context: ActionPolicyContext, supplied?: EnterpriseSnapshot): void {
        const inflight = context.phase === 'inflight';
        const snapshot = supplied ?? this.bridge.snapshot(tx), scope = this.scope(tx, context.execution.id), data = scope.template;
        if (context.action.tenantId !== scope.tenantId || context.action.workspaceId !== scope.workspaceId || context.action.authorityRevisionId !== scope.authorityId || context.action.action !== data.capability || context.action.provider !== data.provider || canonicalJson(context.action.target) !== canonicalJson(data.target) || context.action.inputDigest !== data.inputDigest)
            throw new EnterpriseError('EXECUTION_SCOPE_INVALID', 503);
        if (context.phase === 'cancel' && context.lease) {
            if (context.actorId !== 'worker:' + context.lease.workerId)
                throw new EnterpriseError('EXECUTION_PRINCIPAL_INVALID');
            return;
        }
        const callerMember = reduceIdentityEvents(snapshot.records).members.get(context.actorId);
        if (!callerMember)
            throw new EnterpriseError('MEMBER_UNAVAILABLE');
        const caller = { tenantId: scope.tenantId, principalId: callerMember.id, sessionEpoch: callerMember.sessionEpoch };
        if (['read', 'cancel', 'reconcile'].includes(context.phase)) {
            if (context.phase === 'cancel' && caller.principalId === data.owner.principalId) {
                this.actor(snapshot, caller);
                return;
            }
            this.readScope(tx, scope, caller, snapshot);
            if (context.phase === 'reconcile' || context.phase === 'cancel')
                executionObjectAccess(snapshot.records, caller, executionBusinessObject(snapshot.records, data.target, false), 'execution_approve', executionSourceFields(data.target.objectType), this.now());
            return;
        }
        this.actor(snapshot, data.owner);
        if (permissionDigest(snapshot, data.owner.principalId, scope.workspaceId) !== data.permissionDigest)
            throw new EnterpriseError('EXECUTION_AUTHORIZATION_CHANGED');
        const configuration = executionConfiguration(snapshot.records, scope.workspaceId), role = configuration.settings?.responsibilities.find(r => r.id === data.responsibilityId);
        if (configuration.settings?.streamVersion !== data.settingsVersion || !role?.capabilities.includes(data.capability))
            throw new EnterpriseError('RESPONSIBILITY_CHANGED', 409);
        if (configuration.binding?.streamVersion !== data.bindingVersion)
            throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409);
        if (Date.parse(data.expiresAt) <= Date.parse(this.now()))
            throw new EnterpriseError('EXECUTION_AUTHORITY_EXPIRED', 409);
        for (const source of data.sources) {
            const object = executionBusinessObject(snapshot.records, source.reference, !inflight);
            executionObjectAccess(snapshot.records, data.owner, object, 'read', source.fields, this.now());
        }
        executionObjectAccess(snapshot.records, data.owner, executionBusinessObject(snapshot.records, data.target, !inflight), 'write', executionSourceFields(data.target.objectType), this.now());
        const zeroUsage = data.amount.tokens === 0 && data.amount.costMinorUnits === '0' && data.goalBudget.tokens === 0 && data.goalBudget.costMinorUnits === '0';
        if (!zeroUsage) {
            assertModelQuota(snapshot.records, data.owner, scope.workspaceId, { tokens: Math.max(data.amount.tokens, 1), costMinorUnits: data.amount.costMinorUnits, expiresAt: data.expiresAt, purpose: 'goal' }, this.now());
            const root = tx.getProjection<BudgetAccountV1>('budget.account', scope.workspaceAccountId), quota = reduceQuotaEvents(snapshot.records).workspaces.get(scope.workspaceId)!;
            if (!root || BigInt(root.spentTokens) + BigInt(root.heldTokens) > BigInt(quota.tokens) || BigInt(root.spentCostMinorUnits) + BigInt(root.heldCostMinorUnits) > BigInt(quota.costMinorUnits)) throw new EnterpriseError('WORKSPACE_BUDGET_EXCEEDED', 409);
        }
        if (!inflight) this.businessApproval(snapshot, scope, context.action);
        if (data.policyId) {
            const policy = this.policy(snapshot, data.owner, data, !inflight)!;
            if (policy.streamVersion !== data.policyVersion)
                throw new EnterpriseError('POLICY_CHANGED', 409);
            const counter = tx.getProjection<{
                count: number;
            }>('execution.policy_counter', this.policyCounterId(scope.workspaceId, policy.id)), used = tx.getProjection('execution.policy_use', context.action.id);
            if ((counter?.count ?? 0) > (used ? policy.maxActions : policy.maxActions - 1))
                throw new EnterpriseError('POLICY_LIMIT_REACHED', 409);
        }
        if (context.phase === 'queue' || context.phase === 'dispatch' || inflight) {
            const approval = context.action.executionApprovalRef && tx.getProjection<Approval>('approval', context.action.executionApprovalRef), record = approval && tx.getProjection<ApprovalContext>(APPROVAL_CONTEXT, approval.id);
            if (!approval || !record || record.actionId !== context.action.id || record.actor.principalId !== approval.decidedBy)
                throw new EnterpriseError('EXECUTION_APPROVAL_REQUIRED', 409);
            if (record.mode === 'policy' && (!data.policyId || record.policyId !== data.policyId || record.policyVersion !== data.policyVersion || context.action.action === 'issue_quote_package'))
                throw new EnterpriseError('POLICY_SCOPE_MISMATCH');
            this.actor(snapshot, record.actor);
            if (permissionDigest(snapshot, record.actor.principalId, scope.workspaceId) !== record.permissionDigest)
                throw new EnterpriseError('APPROVER_AUTHORIZATION_CHANGED');
            this.readScope(tx, scope, record.actor, snapshot);
            executionObjectAccess(snapshot.records, record.actor, executionBusinessObject(snapshot.records, data.target, !inflight), 'execution_approve', executionSourceFields(data.target.objectType), this.now());
        }
    }
    async providerActor(context: BusinessProviderContext): Promise<EnterpriseActor> {
        return this.bridge.store.transact(context.tenantId, tx => {
            const snapshot = this.bridge.snapshot(tx);
            let actor: EnterpriseActor;
            if (context.principalSessionEpoch !== undefined) actor = { tenantId: context.tenantId, principalId: context.principalId, sessionEpoch: context.principalSessionEpoch };
            else {
                const authority = context.authorityRevisionId && tx.getProjection<ExecutionAuthority>('authority', context.authorityRevisionId);
                if (!authority) throw new EnterpriseError('PROVIDER_AUTH_CONTEXT_REQUIRED');
                const scope = this.scope(tx, authority.executionId);
                if (scope.workspaceId !== context.workspaceId || scope.template.owner.principalId !== context.principalId) throw new EnterpriseError('PROVIDER_CONTEXT_MISMATCH');
                actor = scope.template.owner;
            }
            this.actor(snapshot, actor);
            tx.beforeCommit!(() => this.actor(snapshot, actor));
            return actor;
        });
    }
    assertProviderExecution(tx: KernelTransaction, records: EnterpriseSnapshot['records'], intent: ActionIntent, context: BusinessProviderContext): void {
        const action = this.getAction(tx, context.tenantId, intent.id);
        if (action.status !== 'committed' || action.cancelRequestedAt || context.signal.aborted) throw new EnterpriseError('PROVIDER_EXECUTION_NOT_COMMITTED', 409);
        if (context.workspaceId !== action.workspaceId || context.authorityRevisionId !== action.authorityRevisionId || computeActionIntentDigest(intent) !== action.actionDigest) throw new EnterpriseError('EXECUTION_SCOPE_INVALID', 409);
        const execution = tx.getProjection<Execution>('execution', action.executionId);
        if (!execution || execution.status !== 'running' || execution.initiatedBy !== context.principalId) throw new EnterpriseError('EXECUTION_PRINCIPAL_INVALID');
        const lease = context.executionLease, job = action.jobId && tx.getProjection<Job>('job', action.jobId);
        if (!lease || !job || lease.jobId !== action.jobId || job.payload.actionId !== action.id || job.payload.executionId !== action.executionId || job.payload.generation !== action.generation || !tx.assertJobLease) throw new EnterpriseError('ACTION_LEASE_REQUIRED', 409);
        tx.assertJobLease({ ...lease, occurredAt: this.now() });
        this.admit(tx, { action: actionIntentView(action), execution, actorId: context.principalId, phase: 'dispatch', lease: { ...lease, occurredAt: this.now() } }, { tenantId: context.tenantId, records, revision: 0, position: 0 });
    }
    private record(tx: KernelTransaction, namespace: string, id: string, value: unknown, type: string, actorId: string, version = 0): void { const scope = this.bridge.snapshot(tx); tx.putProjection(namespace, id, json(value)); appendKernelEvent(tx, { tenantId: scope.tenantId, aggregateType: namespace, aggregateId: id, expectedStreamVersion: version, type, actorId, generation: 0, correlationId: id, publicPayload: {} }); }
    async prepare(actor: EnterpriseActor, input: TrustedEnterpriseActionInput): Promise<CoordinatedAction> {
        const actionId = 'action:' + sha256([actor.tenantId, input.operationKey]);
        const { idempotencyKey: _key, ...semantic } = input;
        const requestDigest = sha256([actor.principalId, semantic]);
        const replay = await this.bridge.store.transact(actor.tenantId, tx => {
            this.actor(this.bridge.snapshot(tx), actor);
            const prior = tx.getProjection<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE, actionId);
            if (!prior)
                return undefined;
            const scope = this.scope(tx, prior.executionId);
            const check = () => this.readScope(tx, scope, actor);
            check();
            tx.beforeCommit!(check);
            if (scope.requestDigest !== requestDigest)
                throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
            const reservation = tx.getProjection<{
                accountId: string;
            }>('budget.reservation', prior.reservationId)!;
            const { streamVersion: _v, status: _s, reservationId: _r, executionApprovalRef: _a, ...prepared } = actionIntentView(prior);
            return this.coordinator.prepareInTransaction(tx, prepared, { executionId: prior.executionId, actorId: actor.principalId, accountId: reservation.accountId, idempotencyKey: actor.principalId + ':' + input.idempotencyKey, toolId: prior.toolId, toolVersion: prior.toolVersion, amount: scope.template.amount });
        });
        if (replay)
            return replay;
        const initial = await this.options.repository.readSnapshot(actor.tenantId), initialCheck = this.validateRequest(initial, actor, input);
        this.policy(initial, actor, { policyId: input.policyId, responsibilityId: input.responsibilityId, capability: input.action, target: input.target, expiresAt: input.expiresAt, sources: initialCheck.sources });
        const provider = await this.options.resolveProvider(actor.tenantId, input.target.workspaceId, initialCheck.entry.provider);
        return this.bridge.store.transact(actor.tenantId, tx => {
            const snapshot = this.bridge.snapshot(tx), checked = this.validateRequest(snapshot, actor, input), policy = this.policy(snapshot, actor, { policyId: input.policyId, responsibilityId: input.responsibilityId, capability: input.action, target: input.target, expiresAt: input.expiresAt, sources: checked.sources });
            tx.beforeCommit!(() => { this.validateRequest(snapshot, actor, input); });
            if (provider.id !== checked.entry.provider || provider.binding.tenantId !== actor.tenantId || provider.binding.workspaceId !== input.target.workspaceId || provider.binding.streamVersion !== checked.binding.streamVersion)
                throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409);
            const prior = tx.getProjection<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE, actionId);
            if (prior) {
                const scope = this.scope(tx, prior.executionId);
                this.readScope(tx, scope, actor);
                if (scope.requestDigest !== requestDigest)
                    throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
                return prior;
            }
            const workspaceId = input.target.workspaceId, scopeId = 'scope:' + sha256([actor.tenantId, input.operationKey]);
            const root = createBudgetAccount(tx, { tenantId: actor.tenantId, workspaceId, principalId: enterpriseBudgetPrincipal(workspaceId), occurredAt: this.now(), scope: { namespace: 'enterprise.workspace_budget', resourceId: workspaceId }, limit: { tokens: Number.MAX_SAFE_INTEGER, costMinorUnits: '9'.repeat(30), currency: 'CNY' }, expiresAt: '9999-12-31T23:59:59.999Z' });
            const account = createBudgetAccount(tx, { tenantId: actor.tenantId, workspaceId, principalId: actor.principalId, occurredAt: this.now(), scope: { namespace: 'goal', resourceId: input.goalId }, parentAccountId: root.id, limit: input.goalBudget, expiresAt: input.expiresAt });
            const template: Scope['template'] = { salt: randomBytes(32).toString('hex'), owner: { tenantId: actor.tenantId, principalId: actor.principalId, sessionEpoch: actor.sessionEpoch }, permissionDigest: permissionDigest(snapshot, actor.principalId, workspaceId), responsibilityId: input.responsibilityId, settingsVersion: checked.configuration.settings!.streamVersion, provider: provider.id, providerVersion: provider.version, bindingVersion: checked.binding.streamVersion, capability: input.action, target: input.target, sources: checked.sources, expiresAt: input.expiresAt, goalId: input.goalId, amount: input.amount, goalBudget: input.goalBudget, inputDigest: input.inputDigest, ...(policy ? { policyId: policy.id, policyVersion: policy.streamVersion } : {}) };
            const digest = sha256(template), toolId = 'provider.' + provider.id + '.' + input.action;
            const thread = this.kernel.createThreadInTransaction(tx, actor.tenantId, actor.principalId, 'enterprise-thread:' + input.goalId, { workspaceId, pluginId: 'business', subject: '企业工作' });
            const execution = this.kernel.createExecutionInTransaction(tx, actor.tenantId, actor.principalId, 'enterprise-execution:' + actionId, { workspaceId, threadId: thread.id, pluginId: 'business', agentDefinitionId: PROVIDER_ACTION_AGENT_ID, modelBindingId: 'none', executionPrincipalId: ENTERPRISE_AGENT_PREFIX + sha256([actor.tenantId, input.goalId]), authority: { workspaceId, principalId: ENTERPRISE_AGENT_PREFIX + sha256([actor.tenantId, input.goalId]), toolIds: [toolId], dataScopes: [{ namespace: `provider.${provider.id}.${input.target.objectType}`, resourceId: input.target.objectId, digest: input.target.digest }, { namespace: SCOPE, resourceId: scopeId, digest }], autoAllowedEffects: [], budget: { maxTokens: input.amount.tokens, maxCostMinorUnits: input.amount.costMinorUnits, currency: 'CNY', maxDurationMs: Date.parse(input.expiresAt) - Date.parse(this.now()), maxSubagents: 0, maxSubagentDepth: 0 } } });
            const authority = tx.getProjection<ExecutionAuthority>('authority', execution.authorityId)!;
            const scope: Scope = { id: scopeId, tenantId: actor.tenantId, workspaceId, executionId: execution.id, authorityId: authority.id, authorityCommitment: authority.commitment, digest, template, workspaceAccountId: root.id, requestDigest, streamVersion: 1 };
            this.record(tx, SCOPE, execution.id, scope, 'execution.scope_bound', actor.principalId);
            this.coordinator.prepareInTransaction(tx, { id: actionId, tenantId: actor.tenantId, workspaceId, operationKey: input.operationKey, goalId: input.goalId, nodeId: input.nodeId, attemptId: input.attemptId, generation: 1, provider: provider.id, action: input.action, target: input.target, authorityRevisionId: authority.id, providerBindingVersion: checked.binding.streamVersion, preparedInputRef: input.preparedInputRef, inputDigest: input.inputDigest, expiresAt: input.expiresAt, ...(input.businessApprovalRef ? { businessApprovalRef: input.businessApprovalRef } : {}) }, { executionId: execution.id, actorId: actor.principalId, accountId: account.id, idempotencyKey: actor.principalId + ':' + input.idempotencyKey, toolId, toolVersion: provider.version, amount: input.amount });
            const approval = this.coordinator.requestApprovalInTransaction(tx, actor.tenantId, actionId);
            if (policy) {
                this.reservePolicy(tx, scope, this.getAction(tx, actor.tenantId, actionId), policy);
                this.kernel.decideApprovalInTransaction(tx, actor.tenantId, actor.principalId, 'policy:' + actionId, approval.id, approval.streamVersion, 'approve_once');
                const record: ApprovalContext = { id: approval.id, actionId, actor: { tenantId: actor.tenantId, principalId: actor.principalId, sessionEpoch: actor.sessionEpoch }, permissionDigest: permissionDigest(snapshot, actor.principalId, workspaceId), mode: 'policy', policyId: policy.id, policyVersion: policy.streamVersion, streamVersion: 1 };
                this.record(tx, APPROVAL_CONTEXT, approval.id, record, 'approval.enterprise_policy_applied', ENTERPRISE_SYSTEM_PREFIX + 'policy');
                this.coordinator.enqueueInTransaction(tx, actor.tenantId, actionId);
            }
            return this.getAction(tx, actor.tenantId, actionId);
        });
    }
    async get(actor: EnterpriseActor, id: string): Promise<CoordinatedAction> { return this.bridge.store.transact(actor.tenantId, tx => { const action = this.getAction(tx, actor.tenantId, id); const check = () => this.readScope(tx, this.scope(tx, action.executionId), actor); check(); tx.beforeCommit!(check); return action; }); }
    private approvalView(tx: KernelTransaction, actor: EnterpriseActor, action: CoordinatedAction): EnterpriseContractTypes['EnterpriseExecutionApprovalView'] | undefined {
        if (!action.executionApprovalRef)
            return undefined;
        const approval = tx.getProjection<Approval>('approval', action.executionApprovalRef);
        if (!approval)
            return undefined;
        const scope = this.scope(tx, action.executionId), origin = tx.getProjection<ApprovalContext>(APPROVAL_CONTEXT, approval.id);
        let canDecide = false;
        if (approval.status === 'pending')
            try {
                const execution = tx.getProjection<Execution>('execution', action.executionId)!;
                this.admit(tx, { action: actionIntentView(action), execution, actorId: scope.template.owner.principalId, phase: 'prepare' });
                const snapshot = this.bridge.snapshot(tx), object = executionBusinessObject(snapshot.records, scope.template.target);
                executionObjectAccess(snapshot.records, actor, object, 'execution_approve', executionSourceFields(object.reference.objectType), this.now());
                canDecide = !(action.action === 'issue_quote_package' && (actor.principalId === scope.template.owner.principalId || actor.principalId === object.value.preparedByPrincipalId));
            }
            catch { }
        return { tenantId: action.tenantId, workspaceId: action.workspaceId, id: approval.id, streamVersion: approval.streamVersion, actionId: action.id, actionDigest: action.actionDigest, authorityRevisionId: action.authorityRevisionId, status: approval.status, initiatedByPrincipalId: scope.template.owner.principalId, ...(approval.decidedBy ? { approvedByPrincipalId: approval.decidedBy } : {}), origin: origin?.mode ?? 'manual', ...(origin?.policyId ? { policyId: origin.policyId, policyVersion: origin.policyVersion! } : {}), validUntil: approval.expiresAt, canDecide };
    }
    async view(actor: EnterpriseActor, id: string): Promise<EnterpriseContractTypes['EnterpriseActionView']> {
        return this.bridge.store.transact(actor.tenantId, tx => {
            const action = this.getAction(tx, actor.tenantId, id), scope = this.scope(tx, action.executionId);
            const check = () => this.readScope(tx, scope, actor);
            check();
            tx.beforeCommit!(check);
            const approval = this.approvalView(tx, actor, action), execution = tx.getProjection<Execution>('execution', action.executionId)!;
            return { action: actionIntentView(action), executionId: execution.id, executionStatus: execution.status, ...(approval ? { approval } : {}), ...(action.receipt ? { receipt: action.receipt } : {}), cancelRequested: !!action.cancelRequestedAt, ...(action.localOutcome ? { localOutcome: action.localOutcome } : {}) };
        });
    }
    async getApproval(actor: EnterpriseActor, id: string): Promise<EnterpriseContractTypes['EnterpriseExecutionApprovalView']> {
        return this.bridge.store.transact(actor.tenantId, tx => {
            const action = tx.listProjections<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE).find(a => a.executionApprovalRef === id);
            if (!action)
                throw new EnterpriseError('APPROVAL_NOT_FOUND', 404);
            const scope = this.scope(tx, action.executionId), check = () => this.readScope(tx, scope, actor);
            check();
            tx.beforeCommit!(check);
            return this.approvalView(tx, actor, action)!;
        });
    }
    async decide(actor: EnterpriseActor, key: string, approvalId: string, expectedStreamVersion: number, actionDigest: string, decision: 'approve_once' | 'deny'): Promise<CoordinatedAction> {
        return this.bridge.store.transact(actor.tenantId, tx => {
            const approval = tx.getProjection<Approval>('approval', approvalId);
            if (!approval)
                throw new EnterpriseError('APPROVAL_NOT_FOUND', 404);
            const action = tx.listProjections<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE).find(a => a.executionApprovalRef === approvalId);
            if (!action)
                throw new EnterpriseError('ACTION_NOT_FOUND', 404);
            const scope = this.scope(tx, action.executionId), snapshot = this.bridge.snapshot(tx);
            const check = () => { this.readScope(tx, scope, actor); if (action.actionDigest !== actionDigest)
                throw new EnterpriseError('ACTION_CHANGED', 409); const object = executionBusinessObject(snapshot.records, scope.template.target, false); executionObjectAccess(snapshot.records, actor, object, 'execution_approve', executionSourceFields(object.reference.objectType), this.now()); if (action.action === 'issue_quote_package' && (actor.principalId === scope.template.owner.principalId || actor.principalId === object.value.preparedByPrincipalId))
                throw new EnterpriseError('SEPARATION_OF_DUTIES_REQUIRED'); };
            check();
            tx.beforeCommit!(check);
            const prior = tx.getIdempotency('enterprise.approval:' + actor.principalId, key), digest = sha256([approvalId, expectedStreamVersion, actionDigest, decision]);
            if (prior) {
                if (prior.requestDigest !== digest)
                    throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
                return action;
            }
            this.kernel.decideApprovalInTransaction(tx, actor.tenantId, actor.principalId, 'enterprise:' + key, approvalId, expectedStreamVersion, decision);
            if (decision === 'approve_once') {
                const record: ApprovalContext = { id: approvalId, actionId: action.id, actor: { tenantId: actor.tenantId, principalId: actor.principalId, sessionEpoch: actor.sessionEpoch }, permissionDigest: permissionDigest(snapshot, actor.principalId, scope.workspaceId), mode: 'manual', streamVersion: 1 };
                this.record(tx, APPROVAL_CONTEXT, approvalId, record, 'approval.enterprise_context_bound', actor.principalId);
                this.coordinator.enqueueInTransaction(tx, actor.tenantId, action.id);
            }
            else
                this.coordinator.cancelBeforeDispatchInTransaction(tx, actor.tenantId, action.id, actor.principalId);
            const result = this.getAction(tx, actor.tenantId, action.id);
            tx.putIdempotency({ tenantId: actor.tenantId, scope: 'enterprise.approval:' + actor.principalId, key, requestDigest: digest, response: { actionId: action.id }, createdAt: this.now() });
            return result;
        });
    }
    async cancel(actor: EnterpriseActor, key: string, id: string, expectedStreamVersion: number): Promise<CoordinatedAction> {
        return this.bridge.store.transact(actor.tenantId, tx => {
            const action = this.getAction(tx, actor.tenantId, id), scope = this.scope(tx, action.executionId), snapshot = this.bridge.snapshot(tx);
            const check = () => { this.actor(snapshot, actor); if (actor.principalId !== scope.template.owner.principalId) {
                const object = executionBusinessObject(snapshot.records, scope.template.target, false);
                executionObjectAccess(snapshot.records, actor, object, 'execution_approve', executionSourceFields(object.reference.objectType), this.now());
            } };
            check();
            tx.beforeCommit!(check);
            const prior = tx.getIdempotency('enterprise.cancel:' + actor.principalId, key), digest = sha256([id, expectedStreamVersion]);
            if (prior) {
                if (prior.requestDigest !== digest)
                    throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
                return action;
            }
            if (action.streamVersion !== expectedStreamVersion)
                throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
            const result = this.coordinator.requestCancellationInTransaction(tx, actor.tenantId, id, actor.principalId);
            appendKernelEvent(tx, { tenantId: actor.tenantId, aggregateType: 'execution.command', aggregateId: sha256([actor.principalId, 'cancel', key]), expectedStreamVersion: 0, type: 'execution.command_recorded', actorId: actor.principalId, generation: 0, correlationId: id, publicPayload: { actionId: id } });
            tx.putIdempotency({ tenantId: actor.tenantId, scope: 'enterprise.cancel:' + actor.principalId, key, requestDigest: digest, response: { actionId: id }, createdAt: this.now() });
            return result;
        });
    }
    async reconcile(actor: EnterpriseActor, key: string, id: string, expectedStreamVersion: number): Promise<CoordinatedAction> {
        const digest = sha256([id, expectedStreamVersion]);
        const pending = await this.bridge.store.transact(actor.tenantId, tx => {
            const action = this.getAction(tx, actor.tenantId, id), scope = this.scope(tx, action.executionId), snapshot = this.bridge.snapshot(tx);
            const check = () => { this.readScope(tx, scope, actor); executionObjectAccess(snapshot.records, actor, executionBusinessObject(snapshot.records, scope.template.target, false), 'execution_approve', executionSourceFields(scope.template.target.objectType), this.now()); };
            check();
            tx.beforeCommit!(check);
            const prior = tx.getIdempotency('enterprise.reconcile:' + actor.principalId, key);
            if (prior && prior.requestDigest !== digest)
                throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
            return { action, replayed: !!prior };
        });
        if (pending.replayed)
            return pending.action;
        const action = pending.action, provider = await this.options.resolveProvider(actor.tenantId, action.workspaceId, action.provider);
        if (provider.id !== action.provider || provider.version !== action.toolVersion)
            throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409);
        const reply = await provider.getReceipt(action.operationKey, { tenantId: actor.tenantId, workspaceId: action.workspaceId, principalId: actor.principalId, principalSessionEpoch: actor.sessionEpoch, authorityRevisionId: action.authorityRevisionId, signal: new AbortController().signal });
        if (reply.status !== 'supported' || !['succeeded', 'not_executed'].includes(reply.value.status))
            throw new EnterpriseError('ACTION_RECEIPT_PENDING', 409);
        const usage = verifiedActionUsage(this.options.usageForReceipt, reply.value, action);
        return this.bridge.store.transact(actor.tenantId, tx => {
            const snapshot = this.bridge.snapshot(tx);
            this.actor(snapshot, actor);
            tx.beforeCommit!(() => this.actor(snapshot, actor));
            const result = this.coordinator.reconcileInTransaction(tx, actor.tenantId, id, expectedStreamVersion, actor.principalId, reply.value, usage);
            const prior = tx.getIdempotency('enterprise.reconcile:' + actor.principalId, key);
            if (prior) {
                if (prior.requestDigest !== digest)
                    throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
                return result;
            }
            appendKernelEvent(tx, { tenantId: actor.tenantId, aggregateType: 'execution.command', aggregateId: sha256([actor.principalId, 'reconcile', key]), expectedStreamVersion: 0, type: 'execution.command_recorded', actorId: actor.principalId, generation: 0, correlationId: id, publicPayload: { actionId: id } });
            tx.putIdempotency({ tenantId: actor.tenantId, scope: 'enterprise.reconcile:' + actor.principalId, key, requestDigest: digest, response: { actionId: id }, createdAt: this.now() });
            return result;
        });
    }
    createWorker(input: {
        id: string;
        jobs: WorkerStore;
        lock: WorkerLockState;
    }) { return new AgentOsWorker({ id: input.id, store: this.workerStore(input.jobs), lock: input.lock, now: () => new Date(this.now()), handlers: { 'provider.action.execute': this.workerHandler() } }); }
    workerStore(jobs: WorkerStore): WorkerStore & KernelStore { const methods = ['claimJob', 'renewJobLease', 'completeJob', 'failJob', 'interruptJob', 'markNeedsReconciliation'] as const; return { ...this.bridge.store, ...Object.fromEntries(methods.map(name => [name, (...args: unknown[]) => Reflect.apply(jobs[name], jobs, args)])) } as WorkerStore & KernelStore; }
    workerHandler(): WorkerJobHandler {
        return async (job, context) => {
            const abort = new AbortController();
            let checking = false, closed = false;
            const inspect = async () => {
                if (checking || closed)
                    return;
                checking = true;
                try {
                    await this.bridge.store.transact(job.tenantId, tx => {
                        const action = this.getAction(tx, job.tenantId, String(job.payload.actionId));
                        if (action.cancelRequestedAt)
                            throw new EnterpriseError('ACTION_CANCEL_REQUESTED');
                        const execution = tx.getProjection<Execution>('execution', action.executionId)!;
                        this.admit(tx, { action: actionIntentView(action), execution, actorId: execution.initiatedBy, phase: ['committed','needs_reconciliation'].includes(action.status) ? 'inflight' : 'dispatch' });
                    });
                }
                catch {
                    abort.abort();
                }
                finally {
                    checking = false;
                }
            };
            await inspect();
            const timer = setInterval(() => { void inspect(); }, 500);
            timer.unref?.();
            const handler = createProviderActionWorkerHandler({ store: this.bridge.store, coordinator: this.coordinator, now: this.now, resolveProvider: id => this.options.resolveProvider(job.tenantId, job.workspaceId!, id), usageForReceipt: this.options.usageForReceipt });
            try {
                return await handler(job, { ...context, signal: AbortSignal.any([context.signal, abort.signal]) });
            }
            finally {
                closed = true;
                clearInterval(timer);
            }
        };
    }
}
