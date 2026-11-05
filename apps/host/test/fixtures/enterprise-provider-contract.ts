// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import type test from 'node:test';
import { actionIntentView, type ActionIntent, type BudgetReservationV1, type EnterpriseContractTypes, type ProviderBinding } from '@mn/contracts';
import type { BusinessProviderContext, BusinessProviderContribution, ProviderActionPreparation } from '@mn/plugin-sdk';
import { sha256 } from '@mn/kernel';
import { EnterpriseError, EnterprisePermissionService, type EnterpriseActor } from '@mn/enterprise-services';
import { fixture } from './business.js';
import { createEnterpriseEventRepository } from '../../src/enterprise-event-repository.js';
import { EnterpriseBuiltinProvider } from '../../src/enterprise-builtin-provider.js';
import { enterpriseBusinessFacts } from '../../src/enterprise-business.js';
import { EnterpriseExecutionRuntime } from '../../src/enterprise-execution-runtime.js';
import { EnterpriseExecutionConfigurationService } from '../../src/enterprise-execution-config.js';

type Role = 'writer' | 'restricted' | 'otherTenant';
type Prepared = EnterpriseContractTypes['EnterpriseProviderPreparedAction'];
type ActionKind = ActionIntent['action'];
export interface ProviderContractFixtureInput { readonly caseId: string; readonly action: ActionKind; }
interface Committed {
  readonly intent: ActionIntent & { readonly status: 'committed' };
  readonly context: BusinessProviderContext;
  readonly actionDigest: string;
}

export async function createBuiltinProviderContractFixture(input: ProviderContractFixtureInput, t: test.TestContext) {
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const hook of cleanup.reverse()) {
      try { await hook(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Provider contract fixture cleanup failed');
  };
  t.after(close);
  try {
    const f = await fixture({ after(callback) {
      if (!callback) return;
      cleanup.push(() => new Promise<void>((resolve, reject) => {
        const result = callback(t, error => { if (error) reject(error); else resolve(); });
        if (callback.length < 2) void Promise.resolve(result).then(() => resolve(), reject);
      }));
    } }, true, false);
    const base = await f.base();
    if (input.action === 'issue_quote_package') await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: base.quote.reference.streamVersion }, 'manager');
    const configuration = new EnterpriseExecutionConfigurationService({ repository: f.repository, now: f.now });
    await f.permissions.grantRole(f.admin, 'contract-manager-execution', {
      id: 'contract-manager-execution', workspaceId: f.workspace.id, principalId: 'manager', role: 'sales_manager',
      scope: { kind: 'workspace' }, operations: ['read', 'execution_approve'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z',
    });
    await configuration.configure(f.admin, f.workspace.id, 'contract-settings', {
      expectedStreamVersion: 0, responsibilities: [{ id: 'sales', capabilities: ['create_followup_task', 'update_followup_date', 'issue_quote_package'], fieldClasses: ['public', 'price'] }],
    });
    const binding: ProviderBinding = {
      tenantId: 'tenant', workspaceId: f.workspace.id, id: 'builtin', streamVersion: 1, mode: 'builtin',
      bindings: (['customer', 'opportunity', 'quote_version', 'followup_task'] as const).map(objectType => ({
        objectType, provider: 'builtin', allowedActions: objectType === 'quote_version' ? ['issue_quote_package'] : objectType === 'followup_task' ? [] : ['create_followup_task', 'update_followup_date'],
        supportedPorts: ['readSnapshot', 'listChanges', 'prepareAction', 'executeAction', 'getReceipt'],
      })),
    };
    await configuration.registerBinding(f.admin, f.workspace.id, 'contract-binding', 0, binding);

    let runtime: EnterpriseExecutionRuntime;
    const builtin = (activeBinding: ProviderBinding, actorFor: (context: BusinessProviderContext) => Promise<EnterpriseActor>) => new EnterpriseBuiltinProvider({
      store: f.store, repository: f.repository, binding: activeBinding, protection: { cas: f.cas, keyProvider: f.keyProvider }, now: f.now, actorFor,
      // Each case owns a fresh, uninterrupted SQLite history; production must supply its own proof.
      hasContinuousHistory: () => true,
      assertExecution: (tx, records, intent, context) => runtime.assertProviderExecution(tx, records, intent, context),
    });
    const runtimeProvider = builtin(binding, context => runtime.providerActor(context));
    runtime = new EnterpriseExecutionRuntime({
      store: f.store, repository: f.repository, now: f.now,
      resolveProvider: async (tenantId, workspaceId, providerId) => {
        if (tenantId !== 'tenant' || workspaceId !== f.workspace.id || providerId !== 'builtin') throw new EnterpriseError('PROVIDER_CONTEXT_MISMATCH');
        return runtimeProvider;
      },
      usageForReceipt: () => ({ tokens: 0, costMinorUnits: '0', currency: 'CNY' }),
    });
    const providers = new Map<Role, EnterpriseBuiltinProvider>();
    const contexts = new Map<Role, BusinessProviderContext>();
    const bindActor = (role: Role, actor: EnterpriseActor, activeBinding: ProviderBinding) => {
      providers.set(role, builtin(activeBinding, async () => actor));
      contexts.set(role, { tenantId: actor.tenantId, workspaceId: activeBinding.workspaceId, principalId: actor.principalId, principalSessionEpoch: actor.sessionEpoch, signal: new AbortController().signal });
    };
    bindActor('writer', f.actor('sales'), binding);
    bindActor('restricted', f.actor('viewer'), binding);

    if (input.caseId === 'field_tenant_isolation') {
      const actor: EnterpriseActor = { tenantId: 'other-tenant', principalId: 'other-admin', sessionEpoch: 1 };
      await f.identity.provision({ tenantId: actor.tenantId, name: '另一家合成企业', issuer: 'https://other-issuer.test/', maxMembers: 2, administrator: { id: actor.principalId, subject: 'other-admin', displayName: '另一企业管理员' } });
      const workspace = await f.identity.createWorkspace(actor, 'other-workspace', { name: '另一业务主体', mode: 'builtin' });
      await f.permissions.grantRole(actor, 'other-sales-role', { id: 'other-sales-role', workspaceId: workspace.id, principalId: actor.principalId, role: 'sales', scope: { kind: 'workspace' }, operations: ['read', 'write'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z' });
      await f.service.execute({ actor, actorKind: 'human', workspaceId: workspace.id, idempotencyKey: 'same-object-id', command: { type: 'customer.create', id: 'customer', name: '另一企业客户' } });
      const otherBinding: ProviderBinding = { ...binding, tenantId: actor.tenantId, workspaceId: workspace.id };
      await configuration.registerBinding(actor, workspace.id, 'other-binding', 0, otherBinding);
      bindActor('otherTenant', actor, otherBinding);
    }
    const context = (role: Role = 'writer') => {
      const value = contexts.get(role); if (!value) throw new EnterpriseError('FIXTURE_ROLE_UNAVAILABLE'); return value;
    };
    const providerFor = (role: Role = 'writer') => {
      const value = providers.get(role); if (!value) throw new EnterpriseError('FIXTURE_ROLE_UNAVAILABLE'); return value;
    };
    const forContext = (value: BusinessProviderContext) => {
      for (const [role, stored] of contexts) if (stored.tenantId === value.tenantId && stored.workspaceId === value.workspaceId && stored.principalId === value.principalId) return providerFor(role);
      throw new EnterpriseError('PROVIDER_CONTEXT_MISMATCH');
    };
    const request = async (operationKey: string, action: ActionKind = 'create_followup_task'): Promise<ProviderActionPreparation> => {
      const target = (await f.get(action === 'issue_quote_package' ? 'quote_version' : 'customer', action === 'issue_quote_package' ? 'quote' : 'customer')).reference;
      const common = { tenantId: 'tenant', workspaceId: f.workspace.id, operationKey, providerBindingVersion: binding.streamVersion, target, expiresAt: '2026-11-02T02:00:00.000Z' };
      if (action === 'issue_quote_package') {
        const quote = await f.get('quote_version', 'quote'), businessApprovalRef = quote.values.approvalId;
        assert.ok(typeof businessApprovalRef === 'string');
        return { ...common, action, businessApprovalRef, input: { format: 'docx' } };
      }
      return action === 'create_followup_task'
        ? { ...common, action, input: { title: '合成客户跟进', dueAt: '2026-11-03T00:00:00.000Z' } }
        : { ...common, action, input: { nextFollowupAt: '2026-11-04T00:00:00.000Z' } };
    };
    const admitAndApprove = async (draft: ProviderActionPreparation, prepared: Prepared) => {
      assert.ok('streamVersion' in draft.target);
      const action = await runtime.prepare(f.actor('sales'), {
        ...prepared, target: draft.target, idempotencyKey: draft.operationKey, operationKey: draft.operationKey,
        goalId: 'contract-goal-' + draft.operationKey, nodeId: draft.action, attemptId: 'contract-attempt-' + draft.operationKey,
        responsibilityId: 'sales', action: draft.action, expiresAt: draft.expiresAt,
        amount: { tokens: 0, costMinorUnits: '0', currency: 'CNY' }, goalBudget: { tokens: 0, costMinorUnits: '0', currency: 'CNY' },
        ...('businessApprovalRef' in draft ? { businessApprovalRef: draft.businessApprovalRef } : {}),
      });
      assert.ok(action.executionApprovalRef);
      return runtime.decide(f.actor('manager'), 'approve-' + draft.operationKey, action.executionApprovalRef, 1, action.actionDigest, 'approve_once');
    };
    const commit = async (draft: ProviderActionPreparation, prepared: Prepared): Promise<Committed> => {
      const approved = await admitAndApprove(draft, prepared), workerId = 'contract-worker-' + draft.operationKey;
      const job = await f.store.claimJob(workerId, f.now(), { tenantId: 'tenant', kinds: ['provider.action.execute'] });
      assert.ok(job); assert.equal(job.id, approved.jobId);
      const executionLease = { jobId: job.id, workerId, fencingToken: job.fencingToken };
      const committed = await runtime.coordinator.begin('tenant', approved.id, { ...executionLease, occurredAt: f.now() });
      return { intent: { ...actionIntentView(committed), status: 'committed' }, actionDigest: committed.actionDigest,
        context: { ...context(), authorityRevisionId: committed.authorityRevisionId, executionLease } };
    };
    const worker = runtime.createWorker({ id: 'contract-dispatch-worker', jobs: f.store,
      lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' } });
    const actionFor = (operationKey: string) => runtime.get(f.actor('manager'), 'action:' + sha256(['tenant', operationKey]));

    const concurrentRepository = createEnterpriseEventRepository({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, allowExecutionEvents: true });
    const concurrentPermissions = new EnterprisePermissionService({ repository: concurrentRepository, now: f.now });
    const revoke = async (role: Role) => {
      assert.equal(role, 'writer');
      await concurrentPermissions.revoke(f.admin, 'contract-revoke-writer', 'role', 'sales-own', 1);
    };
    let armed: 'snapshot' | 'commit' | undefined, triggered = false;
    const originalPut = f.cas.put, put = originalPut.bind(f.cas);
    cleanup.push(() => { f.cas.put = originalPut; });
    f.cas.put = async bytes => {
      const result = await put(bytes);
      if (armed === 'snapshot') {
        armed = undefined; triggered = true; await revoke('writer');
      } else if (armed === 'commit') {
        let purpose: unknown;
        try { purpose = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { context?: { purpose?: unknown } }).context?.purpose; } catch { /* Protected JSON ciphertext is not an enterprise event envelope. */ }
        if (typeof purpose === 'string' && purpose.startsWith('enterprise-event:')) {
          armed = undefined; triggered = true; await revoke('writer');
        }
      }
      return result;
    };

    return {
      reference: base.customer.reference, fieldReference: base.quote.reference, fieldExpectations: { publicFields: ['currency', 'status'], restrictedFields: ['totalMinor', 'lines'] },
      context, providerFor, request, commit, revoke, close,
      readContent: (reference: string, ctx: BusinessProviderContext) => forContext(ctx).readContent(reference, ctx),
      businessState: async () => enterpriseBusinessFacts(await f.repository.read('tenant'), 'tenant', f.workspace.id),
      async mutateTarget() {
        const current = await f.get('customer', 'customer');
        return (await f.command({ type: 'customer.rename', id: 'customer', expectedStreamVersion: current.reference.streamVersion, name: '已改版的合成客户' })).reference;
      },
      async armRevocation(boundary: 'snapshot' | 'commit') {
        assert.equal(armed, undefined);
        // Native identity synchronization must finish before the snapshot CAS hook is armed.
        if (boundary === 'snapshot') await providerFor().bridge.store.transact('tenant', () => undefined);
        armed = boundary; triggered = false;
        return { triggered: () => triggered };
      },
      async expireLease(committed: Committed) {
        assert.ok(committed.context.executionLease);
        f.advance(new Date(Date.parse(f.now()) + 31_000).toISOString());
      },
      async dispatch(draft: ProviderActionPreparation, prepared: Prepared, options: { execute: BusinessProviderContribution['executeAction'] }) {
        await admitAndApprove(draft, prepared);
        const execute = runtimeProvider.executeAction;
        runtimeProvider.executeAction = options.execute;
        try { assert.equal((await worker.pollOnce()).status, 'needs_reconciliation'); }
        finally { runtimeProvider.executeAction = execute; }
      },
      async executionState(operationKey: string) {
        const action = await actionFor(operationKey);
        const reservation = await f.store.transact('tenant', tx => tx.getProjection<BudgetReservationV1>('budget.reservation', action.reservationId));
        assert.ok(reservation);
        assert.ok(['reserved', 'committed', 'unknown', 'settled'].includes(reservation.status));
        if (action.status === 'needs_reconciliation') assert.equal(reservation.status, 'unknown');
        return { operationKey: action.operationKey, reservationId: reservation.id, status: action.status, reservationStatus: reservation.status === 'settled' ? 'settled' : 'reserved' };
      },
      async reconcile(operationKey: string) {
        const action = await actionFor(operationKey);
        await runtime.reconcile(f.actor('manager'), 'reconcile-' + operationKey, action.id, action.streamVersion);
      },
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Provider contract fixture setup and cleanup failed'); }
    throw error;
  }
}
