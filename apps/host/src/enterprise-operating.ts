// SPDX-License-Identifier: Apache-2.0
import { businessObjectKey, reduceBusinessEvents } from '@mn/plugin-business';
import { enterpriseBusinessFacts } from './enterprise-business.js';
import { randomBytes } from 'node:crypto';
import { parseEnterpriseContract, type BusinessObjectRef, type EnterpriseContractTypes, type JsonObject } from '@mn/contracts';
import { appendKernelEvent, sha256, type KernelStore, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, reduceIdentityEvents, requireActor, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseEventRepository } from './enterprise-event-repository.js';
import { EnterpriseKernelBridge } from './enterprise-kernel-bridge.js';
import { executionBusinessObject, executionObjectAccess, executionPermissionDigest, executionRelationDigest } from './enterprise-execution-config.js';
export const OPERATING = { policy: 'operating.policy', source: 'operating.source', trigger: 'operating.trigger', batch: 'operating.batch', command: 'operating.command', cursor: 'operating.cursor', subscription: 'operating.subscription' } as const;
type PolicyView = EnterpriseContractTypes['EnterpriseOperatingPolicyView'];
export type OperatingSources = PolicyView['sources'];
export interface OperatingPolicy extends PolicyView { readonly acceptedEpoch?: number; readonly permissionDigest?: string; readonly salt: string; readonly relations: readonly string[]; }
interface Versioned { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; }
export interface OperatingSource { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly kind: 'web' | 'internal' | 'sales' | 'wecom' | 'timer'; }
export interface OperatingSubscription extends Versioned { readonly goalId?: string; readonly goalScopeId?: string; readonly batchId: string; readonly owner: EnterpriseActor; readonly permissionDigest: string; readonly sources: OperatingSources; readonly sourceIds: readonly string[]; readonly triggerIds: readonly string[]; readonly validUntil: string; readonly status: 'active' | 'paused'; }
interface SourceState extends OperatingSource { readonly streamVersion: number; }
export interface OperatingSourceEvent { readonly id: string; readonly type: string; readonly objectRefs: readonly BusinessObjectRef[]; readonly origin: 'external' | 'muniu'; readonly senderPrincipalId?: string; readonly message?: string; }
export interface OperatingTrigger extends Versioned { readonly sourceId: string; readonly sourceEventId: string; readonly eventType: string; readonly digest: string; readonly objectRefs: readonly BusinessObjectRef[]; readonly status: 'received' | 'quarantined' | 'loop_filtered' | 'unauthorized'; readonly receivedAt: string; readonly senderPrincipalId?: string; readonly message?: string; }
export interface OperatingBatch extends Versioned { readonly policyId?: string; readonly policyVersion?: number; readonly owner: EnterpriseActor; readonly permissionDigest: string; readonly topic: string; readonly triggerIds: readonly string[]; readonly sources: OperatingSources; readonly mode: 'observe' | 'execute'; readonly evaluation: PolicyView['evaluation']; readonly validUntil: string; readonly status: 'pending' | 'evaluating' | 'evaluated' | 'blocked' | 'cancelled' | 'needs_reconciliation'; readonly priority: 'manual' | 'ordinary'; readonly createdAt: string; readonly reasonCode?: string; readonly attemptId?: string; readonly cancelRequested?: boolean; }
export interface OperatingCursor extends Versioned { readonly cursor: string | null; readonly nextPollAt: string; readonly failures: number; readonly pollLease?: number; }
const objectKey = (r: BusinessObjectRef) => sha256([r.tenantId, r.workspaceId, r.objectType, r.objectId]);
const policyKey = (workspaceId: string, id: string) => sha256([workspaceId, id]);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const view = (p: OperatingPolicy): PolicyView => { const { salt: _salt, relations: _relations, acceptedEpoch: _epoch, permissionDigest: _digest, ...result } = p; return result; };
export interface EnterpriseSourceAdapter {
  readonly objectTypes: readonly BusinessObjectRef['objectType'][];
  current(tx: KernelTransaction, reference: BusinessObjectRef): BusinessObjectRef;
  assertRead(tx: KernelTransaction, actor: EnterpriseActor, reference: BusinessObjectRef, fields: readonly string[]): void;
  read(actor: EnterpriseActor, reference: BusinessObjectRef, fields: readonly string[], query: string, maxBytes: number): Promise<JsonObject>;
}
export class EnterpriseOperatingService {
  private readonly sourceAdapters = new Map<string, EnterpriseSourceAdapter>();
  readonly bridge: EnterpriseKernelBridge;
  readonly now: () => string;
  constructor(readonly options: { store: KernelStore; repository: EnterpriseEventRepository; now?: () => string }) { this.bridge = new EnterpriseKernelBridge(options); this.now = options.now ?? (() => new Date().toISOString()); }
  registerSources(adapter: EnterpriseSourceAdapter): void {
    for (const type of adapter.objectTypes) { if (this.sourceAdapters.has(type)) throw new EnterpriseError('SOURCE_ADAPTER_EXISTS', 503); this.sourceAdapters.set(type, adapter); }
  }
  sourceReference(tx: KernelTransaction, reference: BusinessObjectRef, exact = false): BusinessObjectRef {
    if (reference.tenantId !== this.bridge.snapshot(tx).tenantId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
    const adapter = this.sourceAdapters.get(reference.objectType);
    return adapter ? adapter.current(tx, reference) : executionBusinessObject(this.bridge.snapshot(tx).records, reference, exact).reference;
  }
  sourceRelation(tx: KernelTransaction, reference: BusinessObjectRef, salt: string): string {
    const adapter = this.sourceAdapters.get(reference.objectType);
    return adapter ? sha256([salt, adapter.current(tx, reference)]) : executionRelationDigest(executionBusinessObject(this.bridge.snapshot(tx).records, reference, false), salt);
  }
  async readSource(actor: EnterpriseActor, reference: BusinessObjectRef, fields: readonly string[], query = '', maxBytes = 65536): Promise<JsonObject> {
    const adapter = this.sourceAdapters.get(reference.objectType);
    if (adapter) return adapter.read(actor, reference, fields, query, maxBytes);
    return this.bridge.store.transact(actor.tenantId, tx => { this.sources(tx, actor, reference.workspaceId, [{ reference, fields }], true);
      const object = executionBusinessObject(this.bridge.snapshot(tx).records, reference); return JSON.parse(JSON.stringify(Object.fromEntries(fields.map(field => [field, object.value[field]])))) as JsonObject; });
  }
  record<T extends Versioned>(tx: KernelTransaction, namespace: string, value: T, actorId: string, type: string): T {
    tx.putProjection(namespace, namespace === OPERATING.policy ? policyKey(value.workspaceId, value.id) : value.id, value);
    appendKernelEvent(tx, { tenantId: value.tenantId, aggregateType: namespace, aggregateId: namespace === OPERATING.policy ? policyKey(value.workspaceId, value.id) : value.id, expectedStreamVersion: value.streamVersion - 1, type, actorId, generation: 0, correlationId: value.id, publicPayload: { workspaceId: value.workspaceId } });
    return value;
  }
  actor(tx: KernelTransaction, actor: EnterpriseActor, workspaceId: string, admin = false) {
    const snapshot = this.bridge.snapshot(tx), identity = reduceIdentityEvents(snapshot.records);
    if (actor.tenantId !== snapshot.tenantId || actor.principalId.startsWith('enterprise-system:') || actor.principalId.startsWith('enterprise-agent:')) throw new EnterpriseError('EXECUTION_PRINCIPAL_INVALID');
    const member = requireActor(identity, actor, false, this.now());
    if (!identity.workspaces.has(workspaceId)) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404);
    if (admin && !member.organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
    return member;
  }
  sources(tx: KernelTransaction, actor: EnterpriseActor, workspaceId: string, sources: OperatingSources, exact = false): void {
    this.actor(tx, actor, workspaceId);
    const records = this.bridge.snapshot(tx).records;
    for (const source of sources) {
      if (source.reference.tenantId !== actor.tenantId || source.reference.workspaceId !== workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
      const adapter = this.sourceAdapters.get(source.reference.objectType);
      if (adapter) { adapter.current(tx, source.reference); adapter.assertRead(tx, actor, source.reference, source.fields); }
      else executionObjectAccess(records, actor, executionBusinessObject(records, source.reference, exact), 'read', source.fields, this.now());
    }
  }
  currentPolicy(tx: KernelTransaction, policy: OperatingPolicy): EnterpriseActor {
    if (policy.status !== 'active' || Date.parse(policy.validUntil) <= Date.parse(this.now())) throw new EnterpriseError('POLICY_INACTIVE', 409);
    const owner = { tenantId: policy.tenantId, principalId: policy.responsiblePrincipalId, sessionEpoch: policy.acceptedEpoch ?? 0 };
    this.sources(tx, owner, policy.workspaceId, policy.sources);
    const records = this.bridge.snapshot(tx).records;
    if (policy.permissionDigest !== executionPermissionDigest(records, owner.principalId, policy.workspaceId)
      || policy.sources.some((s, i) => this.sourceRelation(tx, s.reference, policy.salt) !== policy.relations[i])) throw new EnterpriseError('POLICY_AUTHORITY_CHANGED', 409);
    return owner;
  }
  private change<T>(tx: KernelTransaction, actor: EnterpriseActor, workspaceId: string, key: string, request: unknown, work: () => T): T {
    if (!text(key)) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    const id = sha256([actor.principalId, workspaceId, key]), digest = sha256(request), previous = tx.getProjection<{ digest: string; value: T }>(OPERATING.command, id);
    if (previous) { if (previous.digest !== digest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return previous.value; }
    const value = work();
    this.record(tx, OPERATING.command, { id, tenantId: actor.tenantId, workspaceId, streamVersion: 1, digest, value }, actor.principalId, 'operating.command_recorded');
    return value;
  }
  private guard(tx: KernelTransaction, check: () => void): void { check(); tx.beforeCommit!(() => { check(); }); }
  async initializeWorkspace(tenantId: string, workspaceId: string): Promise<void> {
    await this.bridge.store.transact(tenantId, tx => {
      const snapshot = this.bridge.snapshot(tx);
      if (!reduceIdentityEvents(snapshot.records).workspaces.has(workspaceId)) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404);
      for (const kind of ['internal', 'timer'] as const) {
        const id = (kind === 'internal' ? 'builtin:' : 'timer:') + workspaceId;
        if (tx.getProjection(OPERATING.source, id)) continue;
        this.record(tx, OPERATING.source, { id, tenantId, workspaceId, kind, streamVersion: 1 }, 'enterprise-system:router', 'operating.source_registered');
        if (kind === 'internal') this.record(tx, OPERATING.cursor, { id, tenantId, workspaceId, cursor: String(snapshot.records.length), streamVersion: 1, failures: 0, nextPollAt: this.now() }, 'enterprise-system:router', 'operating.cursor_initialized');
      }
    });
  }
  async ingestBusinessChanges(tenantId: string, workspaceId: string): Promise<void> {
    await this.bridge.store.transact(tenantId, tx => {
      const source = tx.getProjection<SourceState>(OPERATING.source, 'builtin:' + workspaceId), cursor = tx.getProjection<OperatingCursor>(OPERATING.cursor, 'builtin:' + workspaceId);
      if (!source || !cursor || !/^\d+$/u.test(cursor.cursor ?? '')) throw new EnterpriseError('SOURCE_UNAVAILABLE', 409);
      const records = this.bridge.snapshot(tx).records, start = Number(cursor.cursor), end = Math.min(records.length, start + 100);
      if (!Number.isSafeInteger(start) || start > records.length) throw new EnterpriseError('SOURCE_CURSOR_INVALID', 503);
      if (start === end) return;
      const changed = enterpriseBusinessFacts(records.slice(start, end), tenantId, workspaceId), state = reduceBusinessEvents(enterpriseBusinessFacts(records, tenantId, workspaceId));
      const events: OperatingSourceEvent[] = [];
      for (const fact of changed) {
        const object = state.objects.get(businessObjectKey(fact.objectType, fact.objectId));
        if (object) events.push({ id: sha256([fact.objectType, fact.objectId, fact.expectedStreamVersion + 1]), type: 'business.changed', objectRefs: [object.reference], origin: fact.causation ? 'muniu' : 'external' });
      }
      this.route(tx, source, events);
      this.record(tx, OPERATING.cursor, { ...cursor, streamVersion: cursor.streamVersion + 1, cursor: String(end) }, 'enterprise-system:router', 'operating.cursor_advanced');
    });
  }
  async registerSource(actor: EnterpriseActor, key: string, input: OperatingSource): Promise<OperatingSource> {
    if (!text(input.id) || !['web', 'internal', 'sales', 'wecom', 'timer'].includes(input.kind)) throw new EnterpriseError('SOURCE_INVALID', 400);
    return this.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, () => { this.actor(tx, actor, input.workspaceId, true); if (input.tenantId !== actor.tenantId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH'); });
      return this.change(tx, actor, input.workspaceId, key, ['source', input], () => {
        const old = tx.getProjection<SourceState>(OPERATING.source, input.id);
        if (old) { const { streamVersion: _v, ...prior } = old; if (sha256(prior) !== sha256(input)) throw new EnterpriseError('SOURCE_BINDING_CONFLICT', 409); return old; }
        return this.record(tx, OPERATING.source, { ...input, streamVersion: 1 }, actor.principalId, 'operating.source_registered');
      });
    });
  }
  async writePolicy(actor: EnterpriseActor, workspaceId: string, key: string, raw: EnterpriseContractTypes['EnterpriseOperatingPolicyWrite']): Promise<PolicyView> {
    const input = parseEnterpriseContract('EnterpriseOperatingPolicyWrite', raw), salt = randomBytes(32).toString('hex');
    return this.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, () => this.actor(tx, actor, workspaceId, true));
      return this.change(tx, actor, workspaceId, key, ['policy', input], () => {
        const previous = tx.getProjection<OperatingPolicy>(OPERATING.policy, policyKey(workspaceId, input.id));
        if ((previous?.streamVersion ?? 0) !== input.expectedStreamVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        if (!reduceIdentityEvents(this.bridge.snapshot(tx).records).members.has(input.responsiblePrincipalId)) throw new EnterpriseError('MEMBER_UNAVAILABLE', 409);
        const validate = () => {
          if (Date.parse(input.validUntil) <= Date.parse(this.now())) throw new EnterpriseError('POLICY_EXPIRED', 409);
          if (input.work && (sha256(input.work.sources) !== sha256(input.sources) || Date.parse(input.work.budget.deadline) > Date.parse(input.validUntil))) throw new EnterpriseError('POLICY_WORK_SCOPE_INVALID', 409);
          for (const id of input.sourceIds) if (tx.getProjection<SourceState>(OPERATING.source, id)?.workspaceId !== workspaceId) throw new EnterpriseError('SOURCE_UNAVAILABLE', 409);
          for (const s of input.sources) { if (s.reference.tenantId !== actor.tenantId || s.reference.workspaceId !== workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH'); this.sourceReference(tx, s.reference, true); }
        };
        this.guard(tx, validate);
        const { expectedStreamVersion, ...fields } = input;
        const value: OperatingPolicy = { ...fields, tenantId: actor.tenantId, workspaceId, streamVersion: expectedStreamVersion + 1, status: 'awaiting_acceptance', salt,
          relations: input.sources.map(s => this.sourceRelation(tx, s.reference, salt)) };
        this.record(tx, OPERATING.policy, value, actor.principalId, 'operating.policy_defined');
        return view(value);
      });
    });
  }
  async controlPolicy(actor: EnterpriseActor, workspaceId: string, id: string, command: 'accept' | 'pause' | 'close', expected: number, key: string): Promise<PolicyView> {
    if (!['accept', 'pause', 'close'].includes(command) || !Number.isSafeInteger(expected) || expected < 1) throw new EnterpriseError('INVALID_BODY', 400);
    return this.bridge.store.transact(actor.tenantId, tx => {
      const old = tx.getProjection<OperatingPolicy>(OPERATING.policy, policyKey(workspaceId, id));
      if (!old) throw new EnterpriseError('POLICY_NOT_FOUND', 404);
      const check = () => { const member = this.actor(tx, actor, workspaceId); if (command === 'accept') {
        if (old.responsiblePrincipalId !== actor.principalId) throw new EnterpriseError('POLICY_RESPONSIBLE_REQUIRED');
        this.sources(tx, actor, workspaceId, old.sources);
        if (Date.parse(old.validUntil) <= Date.parse(this.now())) throw new EnterpriseError('POLICY_EXPIRED', 409);
      } else if (!member.organizationAdmin && old.responsiblePrincipalId !== actor.principalId) throw new EnterpriseError('POLICY_RESPONSIBLE_REQUIRED'); };
      this.guard(tx, check);
      return this.change(tx, actor, workspaceId, key, ['control', id, command, expected], () => {
        if (old.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        if (old.status === 'closed') throw new EnterpriseError('POLICY_CLOSED', 409);
        const value: OperatingPolicy = { ...old, streamVersion: expected + 1, status: command === 'accept' ? 'active' : command === 'pause' ? 'paused' : 'closed',
          ...(command === 'accept' ? { acceptedEpoch: actor.sessionEpoch, permissionDigest: executionPermissionDigest(this.bridge.snapshot(tx).records, actor.principalId, workspaceId) } : {}) };
        this.record(tx, OPERATING.policy, value, actor.principalId, 'operating.policy_' + command);
        return view(value);
      });
    });
  }
  private availablePolicies(tx: KernelTransaction, source: OperatingSource): OperatingPolicy[] {
    const result: OperatingPolicy[] = [];
    for (const p of tx.listProjections<OperatingPolicy>(OPERATING.policy).filter(p => p.workspaceId === source.workspaceId && p.sourceIds.includes(source.id) && p.status === 'active')) {
      try { this.currentPolicy(tx, p); result.push(p); }
      catch (error) { if (!(error instanceof EnterpriseError)) throw error;
        this.record(tx, OPERATING.policy, { ...p, status: 'paused', reasonCode: error.code, streamVersion: p.streamVersion + 1 }, 'enterprise-system:router', 'operating.policy_suspended'); }
    }
    return result;
  }
  private route(tx: KernelTransaction, source: OperatingSource, events: readonly OperatingSourceEvent[], onlyPolicyId?: string): { accepted: number; duplicate: number } {
    const policies = this.availablePolicies(tx, source).filter(p => !onlyPolicyId || p.id === onlyPolicyId); let accepted = 0, duplicate = 0;
    for (const input of events) {
      if (!text(input.id) || !text(input.type) || !Array.isArray(input.objectRefs) || input.objectRefs.length < 1 || input.objectRefs.length > 100 || !['external', 'muniu'].includes(input.origin)
        || (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 12000))) throw new EnterpriseError('SOURCE_EVENT_INVALID', 400);
      for (const ref of input.objectRefs) { parseEnterpriseContract('BusinessObjectRef', ref); if (ref.tenantId !== source.tenantId || ref.workspaceId !== source.workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH'); }
      const id = sha256([source.tenantId, source.id, input.id, input.type]), digest = sha256(input), prior = tx.getProjection<OperatingTrigger>(OPERATING.trigger, id);
      if (prior) { if (prior.digest !== digest) throw new EnterpriseError('SOURCE_EVENT_CONFLICT', 409); duplicate++; continue; }
      let status: OperatingTrigger['status'] = input.origin === 'muniu' ? 'loop_filtered' : 'received';
      const identity = reduceIdentityEvents(this.bridge.snapshot(tx).records), sender = input.senderPrincipalId ? identity.members.get(input.senderPrincipalId) : undefined;
      if (status === 'received' && ((input.senderPrincipalId && sender?.status !== 'active') || (['web', 'wecom'].includes(source.kind) && !sender))) status = 'quarantined';
      const matches = status === 'received' ? policies.filter(p => p.eventTypes.includes(input.type) && input.objectRefs.every(r => p.sources.some(s => objectKey(s.reference) === objectKey(r)))) : [];
      const allowed: OperatingPolicy[] = [];
      for (const p of matches) {
        try { if (sender) this.sources(tx, { tenantId: source.tenantId, principalId: sender.id, sessionEpoch: sender.sessionEpoch }, source.workspaceId, p.sources); allowed.push(p); }
        catch (error) { if (!(error instanceof EnterpriseError)) throw error; }
      }
      const subscribed = tx.listProjections<OperatingSubscription>(OPERATING.subscription).some(s => s.goalId && s.status === 'active' && s.workspaceId === source.workspaceId && s.sourceIds.includes(source.id) && input.objectRefs.every(r => s.sources.some(item => objectKey(item.reference) === objectKey(r))));
      if (status === 'received' && !allowed.length && !subscribed) status = 'unauthorized';
      const trigger: OperatingTrigger = { id, tenantId: source.tenantId, workspaceId: source.workspaceId, streamVersion: 1, sourceId: source.id, sourceEventId: input.id, eventType: input.type, digest, objectRefs: input.objectRefs, status, receivedAt: this.now(), ...(input.senderPrincipalId ? { senderPrincipalId: input.senderPrincipalId } : {}), ...(input.message ? { message: input.message } : {}) };
      this.record(tx, OPERATING.trigger, trigger, 'enterprise-system:router', 'operating.source_received'); accepted++;
      const deliveredPolicies = new Set<string>();
      if (status === 'received') for (const subscription of tx.listProjections<OperatingSubscription>(OPERATING.subscription).filter(s => s.workspaceId === source.workspaceId && s.sourceIds.includes(source.id) && s.status === 'active'
        && input.objectRefs.every(r => s.sources.some(s => objectKey(s.reference) === objectKey(r))))) {
        try {
          const target = subscription.goalId ? tx.getProjection<{ scopeId?: string; status: string; owner: EnterpriseActor; spec: { budget: { deadline: string } } }>('enterprise-work.goal', subscription.goalId) : undefined;
          if (subscription.goalId && (!target || target.scopeId !== subscription.goalScopeId || target.owner.principalId !== subscription.owner.principalId || ['completed', 'cancelled', 'failed'].includes(target.status) || Date.parse(target.spec.budget.deadline) <= Date.parse(this.now()))) continue;
          const check = () => { this.sources(tx, subscription.owner, subscription.workspaceId, subscription.sources); if (sender) this.sources(tx, { tenantId: source.tenantId, principalId: sender.id, sessionEpoch: sender.sessionEpoch }, source.workspaceId, subscription.sources);
            if (Date.parse(subscription.validUntil) <= Date.parse(this.now()) || executionPermissionDigest(this.bridge.snapshot(tx).records, subscription.owner.principalId, subscription.workspaceId) !== subscription.permissionDigest) throw new EnterpriseError('SUBSCRIPTION_REVOKED', 409); };
          this.guard(tx, check);
          this.record(tx, OPERATING.subscription, { ...subscription, streamVersion: subscription.streamVersion + 1, triggerIds: [...subscription.triggerIds, id] }, 'enterprise-system:router', 'operating.subscription_delivered');
          if (target) { const original = tx.getProjection<OperatingBatch>(OPERATING.batch, subscription.batchId); if (original?.policyId) deliveredPolicies.add(original.policyId); }
        } catch (error) { if (!(error instanceof EnterpriseError)) throw error;
          this.record(tx, OPERATING.subscription, { ...subscription, streamVersion: subscription.streamVersion + 1, status: 'paused' }, 'enterprise-system:router', 'operating.subscription_suspended'); }
      }

      for (const p of allowed.filter(p => !deliveredPolicies.has(p.id))) {
        const owner = this.currentPolicy(tx, p), topic = sha256([p.id, p.streamVersion, source.id, ...input.objectRefs.map(objectKey).sort()]);
        const pending = tx.listProjections<OperatingBatch>(OPERATING.batch).find(b => b.workspaceId === p.workspaceId && b.topic === topic && b.status === 'pending');
        const batch: OperatingBatch = pending ? { ...pending, streamVersion: pending.streamVersion + 1, triggerIds: [...pending.triggerIds, id] } : {
          id: 'batch:' + sha256([topic, id]), tenantId: source.tenantId, workspaceId: source.workspaceId, streamVersion: 1, policyId: p.id, policyVersion: p.streamVersion,
          owner, permissionDigest: p.permissionDigest!, topic, triggerIds: [id], sources: p.sources, mode: p.mode, evaluation: p.evaluation, validUntil: p.validUntil, status: 'pending', priority: sender ? 'manual' : 'ordinary', createdAt: this.now() };
        this.record(tx, OPERATING.batch, batch, 'enterprise-system:router', 'operating.batch_queued');
        this.guard(tx, () => { this.currentPolicy(tx, p); if (sender) this.sources(tx, { tenantId: source.tenantId, principalId: sender.id, sessionEpoch: sender.sessionEpoch }, source.workspaceId, p.sources); });
      }
    }
    return { accepted, duplicate };
  }
  /** The composition root gives this port only to an authenticated, tenant-bound adapter. */
  ingress(binding: OperatingSource) {
    const source = structuredClone(binding);
    const bound = (tx: KernelTransaction) => { const stored = tx.getProjection<SourceState>(OPERATING.source, source.id); if (!stored || stored.tenantId !== source.tenantId || stored.workspaceId !== source.workspaceId || stored.kind !== source.kind) throw new EnterpriseError('SOURCE_BINDING_CONFLICT', 409); };
    const cursor = async (): Promise<OperatingCursor> => this.bridge.store.transact(source.tenantId, tx => { bound(tx); return tx.getProjection<OperatingCursor>(OPERATING.cursor, source.id) ?? { ...source, streamVersion: 0, cursor: null, nextPollAt: this.now(), failures: 0 }; });
    const receive = async (input: { expectedCursor: string | null; nextCursor: string; events: readonly OperatingSourceEvent[] }, pollLease?: number) => {
      if (!text(input.nextCursor) || (input.expectedCursor !== null && !text(input.expectedCursor)) || !Array.isArray(input.events) || input.events.length > 100) throw new EnterpriseError('SOURCE_BATCH_INVALID', 400);
      return this.bridge.store.transact(source.tenantId, tx => {
        bound(tx);
        const requestId = sha256(['source-batch', source.id, input, pollLease ?? null]), prior = tx.getProjection<{ value: { accepted: number; duplicate: number } }>(OPERATING.command, requestId);
        if (prior) return prior.value;
        const previous = tx.getProjection<OperatingCursor>(OPERATING.cursor, source.id);
        if (pollLease !== undefined && previous?.pollLease !== pollLease) throw new EnterpriseError('SOURCE_LEASE_STALE', 409);
        if ((previous?.cursor ?? null) !== input.expectedCursor) throw new EnterpriseError('SOURCE_CURSOR_CONFLICT', 409);
        if (input.events.length && input.nextCursor === input.expectedCursor) throw new EnterpriseError('SOURCE_CURSOR_NOT_ADVANCED', 409);
        const value = this.route(tx, source, input.events);
        this.record(tx, OPERATING.cursor, { id: source.id, tenantId: source.tenantId, workspaceId: source.workspaceId, streamVersion: (previous?.streamVersion ?? 0) + 1, cursor: input.nextCursor, failures: 0, nextPollAt: new Date(Date.parse(this.now()) + 300_000).toISOString() }, 'enterprise-system:router', 'operating.cursor_advanced');
        this.record(tx, OPERATING.command, { id: requestId, tenantId: source.tenantId, workspaceId: source.workspaceId, streamVersion: 1, value }, 'enterprise-system:router', 'operating.batch_received');
        return value;
      });
    };
    const poll = async (read: (cursor: string | null, signal: AbortSignal) => Promise<{ nextCursor: string; events: readonly OperatingSourceEvent[] }>) => {
      if (source.kind !== 'sales') throw new EnterpriseError('SOURCE_POLL_NOT_SUPPORTED', 409);
      const claim = await this.bridge.store.transact(source.tenantId, tx => {
        bound(tx); const old = tx.getProjection<OperatingCursor>(OPERATING.cursor, source.id);
        if (old && Date.parse(old.nextPollAt) > Date.parse(this.now())) return undefined;
        const next: OperatingCursor = { ...source, streamVersion: (old?.streamVersion ?? 0) + 1, cursor: old?.cursor ?? null, failures: old?.failures ?? 0,
          pollLease: (old?.streamVersion ?? 0) + 1, nextPollAt: new Date(Date.parse(this.now()) + 90_000).toISOString() };
        return this.record(tx, OPERATING.cursor, next, 'enterprise-system:poller', 'operating.poll_claimed');
      });
      if (!claim) return { status: 'idle' as const };
      const signal = AbortSignal.timeout(60_000);
      try {
        const result = await read(claim.cursor, signal); signal.throwIfAborted();
        await receive({ expectedCursor: claim.cursor, ...result }, claim.pollLease);
        return { status: 'received' as const };
      } catch {
        await this.bridge.store.transact(source.tenantId, tx => {
          bound(tx); const old = tx.getProjection<OperatingCursor>(OPERATING.cursor, source.id);
          if (!old || old.pollLease !== claim.pollLease) return;
          const { pollLease: _lease, ...prior } = old;
          this.record(tx, OPERATING.cursor, { ...prior, streamVersion: old.streamVersion + 1, failures: Math.min(30, old.failures + 1),
            nextPollAt: new Date(Date.parse(this.now()) + Math.min(3_600_000, 300_000 * 2 ** Math.min(4, old.failures))).toISOString() }, 'enterprise-system:poller', 'operating.poll_deferred');
        });
        return { status: 'failed' as const };
      }
    };
    return { cursor, receive: (input: Parameters<typeof receive>[0]) => receive(input), poll };
  }
  async tick(tenantId: string, workspaceId: string): Promise<void> {
    await this.bridge.store.transact(tenantId, tx => {
      const minute = Math.floor(Date.parse(this.now()) / 60_000), tick = tx.getProjection<{ minute: number; streamVersion: number }>('operating.tick', workspaceId);
      if (tick && tick.minute >= minute) return;
      for (const source of tx.listProjections<SourceState>(OPERATING.source).filter(s => s.workspaceId === workspaceId)) {
        const policies = this.availablePolicies(tx, source);
        if (source.kind !== 'timer') continue;
        for (const policy of policies.filter(p => p.intervalMinutes && p.eventTypes.includes('timer.due'))) {
          const period = Math.floor(minute / policy.intervalMinutes!), id = policyKey(workspaceId, policy.id + ':' + policy.streamVersion);
          const prior = tx.getProjection<Versioned & { period: number; digest: string }>('operating.timer', id);
          if (prior && prior.period >= period) continue;
          const refs = policy.sources.map(s => this.sourceReference(tx, s.reference)), digest = sha256(refs);
          if (prior?.digest !== digest) this.route(tx, source, [{ id: id + ':' + period, type: 'timer.due', objectRefs: refs, origin: 'external' }], policy.id);
          this.record(tx, 'operating.timer', { id, tenantId, workspaceId, streamVersion: (prior?.streamVersion ?? 0) + 1, period, digest }, 'enterprise-system:timer', 'operating.timer_checked');
        }
      }
      this.record(tx, 'operating.tick', { id: workspaceId, tenantId, workspaceId, streamVersion: (tick?.streamVersion ?? 0) + 1, minute }, 'enterprise-system:timer', 'operating.tick_checked');
    });
  }
  async subscribe(actor: EnterpriseActor, workspaceId: string, batchId: string, expected: number, key: string): Promise<{ subscriptionId: string }> {
    return this.bridge.store.transact(actor.tenantId, tx => {
      const batch = tx.getProjection<OperatingBatch>(OPERATING.batch, batchId);
      if (!batch || batch.workspaceId !== workspaceId || batch.owner.principalId !== actor.principalId) throw new EnterpriseError('BATCH_NOT_FOUND', 404);
      this.guard(tx, () => { this.sources(tx, actor, workspaceId, batch.sources); if (Date.parse(batch.validUntil) <= Date.parse(this.now())) throw new EnterpriseError('EVALUATION_EXPIRED', 409); });
      return this.change(tx, actor, workspaceId, key, ['subscribe', batchId, expected], () => {
        if (batch.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        const id = 'subscription:' + batchId, old = tx.getProjection<OperatingSubscription>(OPERATING.subscription, id);
        if (old) throw new EnterpriseError('SUBSCRIPTION_EXISTS', 409);
        const sourceIds = [...new Set(batch.triggerIds.map(id => tx.getProjection<OperatingTrigger>(OPERATING.trigger, id)!.sourceId))];
        this.record(tx, OPERATING.subscription, { id, tenantId: actor.tenantId, workspaceId, streamVersion: 1, batchId, owner: batch.owner, permissionDigest: executionPermissionDigest(this.bridge.snapshot(tx).records, actor.principalId, workspaceId), sources: batch.sources, sourceIds, triggerIds: [], validUntil: batch.validUntil, status: 'active' }, actor.principalId, 'operating.subscription_created');
        return { subscriptionId: id };
      });
    });
  }
  async updates(actor: EnterpriseActor, workspaceId: string, batchId: string): Promise<{ triggerIds: readonly string[] }> {
    return this.bridge.store.transact(actor.tenantId, tx => {
      const subscription = tx.getProjection<OperatingSubscription>(OPERATING.subscription, 'subscription:' + batchId);
      if (!subscription || subscription.workspaceId !== workspaceId) throw new EnterpriseError('SUBSCRIPTION_NOT_FOUND', 404);
      this.guard(tx, () => { this.sources(tx, actor, workspaceId, subscription.sources); });
      return { triggerIds: subscription.triggerIds };
    });
  }
  async submit(actor: EnterpriseActor, workspaceId: string, key: string, raw: EnterpriseContractTypes['EnterpriseOperatingRequest']): Promise<{ batchId: string; streamVersion: number }> {
    const input = parseEnterpriseContract('EnterpriseOperatingRequest', raw);
    return this.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, () => { this.sources(tx, actor, workspaceId, input.sources); });
      return this.change(tx, actor, workspaceId, key, ['manual', input], () => {
        this.guard(tx, () => { this.sources(tx, actor, workspaceId, input.sources, true); if (Date.parse(input.validUntil) <= Date.parse(this.now())) throw new EnterpriseError('EVALUATION_EXPIRED', 409); });
        const id = sha256([actor.tenantId, actor.principalId, workspaceId, key]), sourceId = 'web:' + actor.principalId;
        this.record(tx, OPERATING.trigger, { id, tenantId: actor.tenantId, workspaceId, streamVersion: 1, sourceId, sourceEventId: key, eventType: 'manual.request', digest: sha256(input), objectRefs: input.sources.map(s => s.reference), status: 'received', receivedAt: this.now(), senderPrincipalId: actor.principalId, message: input.message }, actor.principalId, 'operating.manual_request_received');
        const batch: OperatingBatch = { id: 'batch:' + id, tenantId: actor.tenantId, workspaceId, streamVersion: 1, owner: { tenantId: actor.tenantId, principalId: actor.principalId, sessionEpoch: actor.sessionEpoch }, permissionDigest: executionPermissionDigest(this.bridge.snapshot(tx).records, actor.principalId, workspaceId), topic: sha256([actor.principalId, key]), triggerIds: [id], sources: input.sources, mode: 'execute', evaluation: input.evaluation, validUntil: input.validUntil, status: 'pending', priority: 'manual', createdAt: this.now() };
        this.record(tx, OPERATING.batch, batch, actor.principalId, 'operating.batch_queued');
        return { batchId: batch.id, streamVersion: batch.streamVersion };
      });
    });
  }
  async cancel(actor: EnterpriseActor, workspaceId: string, id: string, expected: number, key: string): Promise<{ batchId: string; streamVersion: number; status: OperatingBatch['status'] }> {
    return this.bridge.store.transact(actor.tenantId, tx => {
      const member = this.actor(tx, actor, workspaceId), batch = tx.getProjection<OperatingBatch>(OPERATING.batch, id);
      if (!batch || batch.workspaceId !== workspaceId || (!member.organizationAdmin && batch.owner.principalId !== actor.principalId)) throw new EnterpriseError('BATCH_NOT_FOUND', 404);
      this.guard(tx, () => { this.actor(tx, actor, workspaceId); });
      return this.change(tx, actor, workspaceId, key, ['cancel', id, expected], () => {
        if (batch.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        if (['evaluated', 'blocked'].includes(batch.status)) throw new EnterpriseError('BATCH_ALREADY_FINISHED', 409);
        const current = batch.attemptId ? tx.getProjection<{ status: string }>('operating.evaluation', batch.attemptId) : undefined;
        const status = current && ['committed', 'needs_reconciliation'].includes(current.status) ? 'needs_reconciliation' as const : 'cancelled' as const;
        this.record(tx, OPERATING.batch, { ...batch, status, cancelRequested: true, streamVersion: batch.streamVersion + 1 }, actor.principalId, 'operating.batch_cancel_requested');
        return { batchId: id, streamVersion: batch.streamVersion + 1, status };
      });
    });
  }
  async inspect(actor: EnterpriseActor, workspaceId: string) {
    return this.bridge.store.transact(actor.tenantId, tx => {
      const member = this.actor(tx, actor, workspaceId);
      const visible = (sources: OperatingSources) => { try { this.sources(tx, actor, workspaceId, sources); return true; } catch { return false; } };
      const batches = tx.listProjections<OperatingBatch>(OPERATING.batch).filter(b => b.workspaceId === workspaceId && (member.organizationAdmin || visible(b.sources))).map(b => ({ id: b.id, streamVersion: b.streamVersion, status: b.status, triggerIds: b.triggerIds, ...(b.reasonCode ? { reasonCode: b.reasonCode } : {}) }));
      const ids = new Set(batches.flatMap(b => b.triggerIds));
      const triggers = tx.listProjections<OperatingTrigger>(OPERATING.trigger).filter(t => t.workspaceId === workspaceId && (member.organizationAdmin || ids.has(t.id))).map(t => ({ id: t.id, sourceEventId: t.sourceEventId, status: t.status }));
      const policies = tx.listProjections<OperatingPolicy>(OPERATING.policy).filter(p => p.workspaceId === workspaceId && (member.organizationAdmin || (p.responsiblePrincipalId === actor.principalId && visible(p.sources)))).map(view);
      this.guard(tx, () => this.actor(tx, actor, workspaceId));
      const sources = tx.listProjections<SourceState>(OPERATING.source).filter(s => s.workspaceId === workspaceId).map(({ streamVersion: _v, ...source }) => source);
      return { sources: sources.slice(-100), policies: policies.slice(-100), triggers: triggers.slice(-100), batches: batches.slice(-100), hasMore: [sources, policies, triggers, batches].some(rows => rows.length > 100) };
    });
  }
}
