// SPDX-License-Identifier: Apache-2.0
import { EnterpriseBuiltinExecution } from './enterprise-builtin-execution.js';
import { EnterpriseProviderPreparation } from './enterprise-provider-preparation.js';
import { randomBytes } from 'node:crypto';
import { parseEnterpriseContract, type ActionIntent, type ActionReceipt, type BusinessObjectRef, type EnterpriseContractTypes, type JsonObject, type ProviderBinding } from '@mn/contracts';
import type { BusinessProviderContribution, BusinessProviderContext, ProviderObjectReference, ProviderResult, ProviderSnapshot, ProviderActionPreparation } from '@mn/plugin-sdk';
import { appendKernelEvent, PROTECTED_PAYLOAD_KEY_NAMESPACE, sha256, type KernelStore, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, requireActor, reduceIdentityEvents, type EnterpriseActor, type EnterpriseRecord } from '@mn/enterprise-services';
import { reduceBusinessEvents, businessObjectKey } from '@mn/plugin-business';
import { storeProtectedJson, readProtectedJson, type ContentAddressedStorage, type KeyProvider, type ProtectedJsonKeyRecordV1 } from '@mn/storage';
import type { EnterpriseEventRepository } from './enterprise-event-repository.js';
import { EnterpriseKernelBridge } from './enterprise-kernel-bridge.js';
import { EnterpriseBusinessService, enterpriseBusinessFacts } from './enterprise-business.js';
import { executionConfiguration, executionBusinessObject, executionObjectAccess, executionPermissionDigest } from './enterprise-execution-config.js';
type Content = EnterpriseContractTypes['EnterpriseBusinessObjectView'];
interface SnapshotRecord { id: string; tenantId: string; workspaceId: string; streamVersion: number; ownerPrincipalId: string; reference: BusinessObjectRef; fields: readonly string[]; protectedPayloadRef: string; contentDigest: string; observedAt: string; }
interface CursorRecord { id: string; tenantId: string; workspaceId: string; streamVersion: number; ownerPrincipalId: string; bindingVersion: number; permissionDigest: string; offset: number; }
const SNAPSHOT = 'enterprise-provider.snapshot', CURSOR = 'enterprise-provider.cursor';
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
export class EnterpriseBuiltinProvider implements BusinessProviderContribution {
  readonly id = 'builtin'; readonly version = '1'; readonly binding: ProviderBinding;
  readonly bridge: EnterpriseKernelBridge; readonly business: EnterpriseBusinessService;
  constructor(readonly options: { store: KernelStore; repository: EnterpriseEventRepository; binding: ProviderBinding; protection: { cas: ContentAddressedStorage; keyProvider: KeyProvider }; now?: () => string; actorFor: (context: BusinessProviderContext) => Promise<EnterpriseActor>; assertExecution?: (tx: KernelTransaction, records: readonly EnterpriseRecord[], intent: ActionIntent, context: BusinessProviderContext) => void; hasContinuousHistory?: (tx: KernelTransaction, context: BusinessProviderContext) => boolean }) {
    this.binding = structuredClone(parseEnterpriseContract('ProviderBinding', options.binding));
    this.bridge = new EnterpriseKernelBridge(options); this.business = new EnterpriseBusinessService(options);
  }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private async actor(context: BusinessProviderContext): Promise<EnterpriseActor> {
    if (context.signal.aborted) throw new EnterpriseError('PROVIDER_CANCELLED', 409);
    const actor = await this.options.actorFor(context);
    if (actor.tenantId !== context.tenantId || actor.principalId !== context.principalId || context.tenantId !== this.binding.tenantId || context.workspaceId !== this.binding.workspaceId) throw new EnterpriseError('PROVIDER_CONTEXT_MISMATCH');
    return actor;
  }
  private guard(tx: KernelTransaction, actor: EnterpriseActor, context: BusinessProviderContext): void {
    if (context.signal.aborted) throw new EnterpriseError('PROVIDER_CANCELLED', 409);
    const records = this.bridge.snapshot(tx).records;
    requireActor(reduceIdentityEvents(records), actor, false, this.now());
    const current = executionConfiguration(records, context.workspaceId).binding;
    if (!current || sha256(current) !== sha256(this.binding)) throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409);
  }
  private supported(type: string, capability: 'readSnapshot' | 'listChanges'): boolean {
    return this.binding.mode === 'builtin' && this.binding.bindings.some(b => b.objectType === type && b.provider === this.id && b.supportedPorts.includes(capability));
  }
  private readable(tx: KernelTransaction, actor: EnterpriseActor, context: BusinessProviderContext, reference: BusinessObjectRef, fields: readonly string[]): void {
    this.guard(tx, actor, context);
    if (reference.tenantId !== context.tenantId || reference.workspaceId !== context.workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
    if (!this.supported(reference.objectType, 'readSnapshot')) throw new EnterpriseError('PROVIDER_NOT_RESPONSIBLE', 409);
    const records = this.bridge.snapshot(tx).records, current = executionBusinessObject(records, reference, false);
    executionObjectAccess(records, actor, current, 'read', fields, this.now());
  }
  private record<T extends { id: string; tenantId: string; workspaceId: string; streamVersion: number }>(tx: KernelTransaction, namespace: string, value: T, actor: EnterpriseActor, type: string): T {
    tx.putProjection(namespace, value.id, value);
    appendKernelEvent(tx, { tenantId: value.tenantId, aggregateType: namespace, aggregateId: value.id, expectedStreamVersion: value.streamVersion - 1, type, actorId: actor.principalId, generation: 0, correlationId: value.id, publicPayload: { workspaceId: value.workspaceId } });
    return value;
  }
  async readSnapshot(reference: ProviderObjectReference, context: BusinessProviderContext): Promise<ProviderResult<ProviderSnapshot>> {
    const actor = await this.actor(context);
    if ('provider' in reference || !this.supported(reference.objectType, 'readSnapshot')) return { status: 'not_supported', capability: 'readSnapshot' };
    await this.bridge.store.transact(actor.tenantId, tx => this.readable(tx, actor, context, reference, []));
    const body = await this.business.get(actor, context.workspaceId, reference.objectType, reference.objectId, reference.streamVersion);
    if (sha256(body.reference) !== sha256(reference)) throw new EnterpriseError('SOURCE_VERSION_CONFLICT', 409);
    const fields = Object.keys(body.values), digest = sha256(body);
    const id = 'provider-snapshot:' + sha256([actor.tenantId, context.workspaceId, actor.principalId, this.binding.streamVersion, reference, digest]);
    const prior = await this.bridge.store.transact(actor.tenantId, tx => {
      this.readable(tx, actor, context, reference, fields);
      return tx.getProjection<SnapshotRecord>(SNAPSHOT, id);
    });
    if (prior) { await this.readContent(id, context); return { status: 'supported', value: { objectRef: prior.reference, protectedContentRef: id, observedAt: prior.observedAt } }; }
    const observedAt = this.now(), protectedPayloadRef = 'provider-payload:' + randomBytes(32).toString('hex');
    const stored = await storeProtectedJson({ ...this.options.protection, tenantId: actor.tenantId, workspaceId: context.workspaceId, ownerType: 'enterprise-provider-snapshot', ownerId: id, protectedPayloadRef, value: json(body), createdAt: observedAt });
    const snapshot = await this.bridge.store.transact(actor.tenantId, tx => {
      const check = () => this.readable(tx, actor, context, reference, fields); check(); tx.beforeCommit!(check);
      const existing = tx.getProjection<SnapshotRecord>(SNAPSHOT, id); if (existing) return existing;
      tx.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, protectedPayloadRef, stored.keyRecord);
      return this.record<SnapshotRecord>(tx, SNAPSHOT, { id, tenantId: actor.tenantId, workspaceId: context.workspaceId, streamVersion: 1, ownerPrincipalId: actor.principalId, reference, fields, protectedPayloadRef, contentDigest: stored.plaintextDigest, observedAt }, actor, 'provider.snapshot_observed');
    });
    return { status: 'supported', value: { objectRef: snapshot.reference, protectedContentRef: id, observedAt: snapshot.observedAt } };
  }
  async readContent(reference: string, context: BusinessProviderContext): Promise<Content> {
    const actor = await this.actor(context);
    const saved = await this.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, actor, context);
      const record = tx.getProjection<SnapshotRecord>(SNAPSHOT, reference);
      if (!record || record.ownerPrincipalId !== actor.principalId || record.workspaceId !== context.workspaceId) throw new EnterpriseError('PROVIDER_CONTENT_NOT_FOUND', 404);
      this.readable(tx, actor, context, record.reference, record.fields);
      const key = tx.getProjection<ProtectedJsonKeyRecordV1>(PROTECTED_PAYLOAD_KEY_NAMESPACE, record.protectedPayloadRef);
      if (!key) throw new EnterpriseError('PROVIDER_CONTENT_UNAVAILABLE', 410); return { record, key };
    });
    const body = await readProtectedJson({ ...this.options.protection, tenantId: actor.tenantId, workspaceId: context.workspaceId, ownerType: 'enterprise-provider-snapshot', ownerId: saved.record.id, protectedPayloadRef: saved.record.protectedPayloadRef, keyRecord: saved.key });
    if (sha256(body) !== saved.record.contentDigest) throw new EnterpriseError('PROVIDER_CONTENT_INVALID', 503);
    await this.bridge.store.transact(actor.tenantId, tx => { const check = () => this.readable(tx, actor, context, saved.record.reference, saved.record.fields); check(); tx.beforeCommit!(check); });
    return parseEnterpriseContract('EnterpriseBusinessObjectView', body);
  }
  async listChanges(cursor: string | null, context: BusinessProviderContext): Promise<ProviderResult<EnterpriseContractTypes['EnterpriseProviderChanges']>> {
    const actor = await this.actor(context);
    if (!this.binding.bindings.some(b => this.supported(b.objectType, 'listChanges'))) return { status: 'not_supported', capability: 'listChanges' };
    const page = await this.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, actor, context); const records = this.bridge.snapshot(tx).records;
      const permissionDigest = executionPermissionDigest(records, actor.principalId, context.workspaceId);
      const prior = cursor ? tx.getProjection<CursorRecord>(CURSOR, cursor) : undefined;
      if (cursor && (!prior || prior.ownerPrincipalId !== actor.principalId || prior.workspaceId !== context.workspaceId || prior.bindingVersion !== this.binding.streamVersion)) throw new EnterpriseError('PROVIDER_CURSOR_INVALID', 409);
      if (prior && prior.permissionDigest !== permissionDigest) throw new EnterpriseError('PROVIDER_CURSOR_AUTHORIZATION_CHANGED', 409);
      const history = enterpriseBusinessFacts(records, actor.tenantId, context.workspaceId), start = prior?.offset ?? 0, end = Math.min(history.length, start + 50);
      if (start > history.length) throw new EnterpriseError('PROVIDER_CURSOR_INVALID', 409);
      const selected = history.slice(start, end).filter(event => this.supported(event.objectType, 'listChanges')).map(event => {
        const object = reduceBusinessEvents(history.filter(e => e.objectType === event.objectType && e.objectId === event.objectId && e.expectedStreamVersion <= event.expectedStreamVersion)).objects.get(businessObjectKey(event.objectType, event.objectId))!;
        return { event, reference: object.reference };
      });
      return { selected, end, permissionDigest };
    });
    const changes: EnterpriseContractTypes['EnterpriseProviderChanges']['changes'][number][] = [];
    for (const item of page.selected) {
      try {
        const snapshot = await this.readSnapshot(item.reference, context);
        if (snapshot.status === 'supported') changes.push({ sourceEventId: 'builtin-event:' + sha256([actor.tenantId, context.workspaceId, item.event.objectType, item.event.objectId, item.event.expectedStreamVersion + 1]), sourceEventType: item.event.type, sourceOccurredAt: item.event.occurredAt, snapshot: snapshot.value, origin: item.event.causation ? 'muniu' : 'external', ...(item.event.causation ? { causedByOperationKey: item.event.causation.operationKey, causedByGoalId: item.event.causation.goalId } : {}) });
      } catch (error) { if (error instanceof EnterpriseError && ['OBJECT_ACCESS_DENIED', 'FIELD_ACCESS_DENIED', 'OBJECT_NOT_FOUND'].includes(error.code)) continue; throw error; }
    }
    return this.bridge.store.transact(actor.tenantId, tx => {
      const check = () => {
        this.guard(tx, actor, context);
        if (executionPermissionDigest(this.bridge.snapshot(tx).records, actor.principalId, context.workspaceId) !== page.permissionDigest) throw new EnterpriseError('PROVIDER_CURSOR_AUTHORIZATION_CHANGED', 409);
        for (const change of changes) { const record = tx.getProjection<SnapshotRecord>(SNAPSHOT, change.snapshot.protectedContentRef)!; this.readable(tx, actor, context, record.reference, record.fields); }
      };
      check(); tx.beforeCommit!(check);
      const nextCursor = 'provider-cursor:' + randomBytes(32).toString('hex');
      this.record<CursorRecord>(tx, CURSOR, { id: nextCursor, tenantId: actor.tenantId, workspaceId: context.workspaceId, streamVersion: 1, ownerPrincipalId: actor.principalId, bindingVersion: this.binding.streamVersion, permissionDigest: page.permissionDigest, offset: page.end }, actor, 'provider.cursor_created');
      return { status: 'supported', value: { changes, nextCursor } } as const;
    });
  }
  async prepareAction(request: ProviderActionPreparation, context: BusinessProviderContext): Promise<ProviderResult<EnterpriseContractTypes['EnterpriseProviderPreparedAction']>> {
    const actor = await this.actor(context);
    if (!this.binding.bindings.some(b => b.objectType === request.target.objectType && b.provider === this.id && b.supportedPorts.includes('prepareAction') && b.allowedActions.includes(request.action))) return { status: 'not_supported', capability: 'prepareAction' };
    if (request.providerBindingVersion !== this.binding.streamVersion) throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409);
    return new EnterpriseProviderPreparation({ bridge: this.bridge, business: this.business, protection: this.options.protection, now: () => this.now(), guard: (tx, person, call) => this.guard(tx, person, call) }).prepare(request, actor, context);
  }
  async readPrepared(reference: string, context: BusinessProviderContext): Promise<EnterpriseContractTypes['EnterpriseProviderActionPreview']> {
    const actor = await this.actor(context);
    return new EnterpriseProviderPreparation({ bridge: this.bridge, business: this.business, protection: this.options.protection, now: () => this.now(), guard: (tx, person, call) => this.guard(tx, person, call) }).preview(reference, actor, context);
  }
  async readPackage(reference: string, context: BusinessProviderContext): Promise<EnterpriseContractTypes['EnterpriseProviderPackageContent']> {
    const actor = await this.actor(context);
    return new EnterpriseProviderPreparation({ bridge: this.bridge, business: this.business, protection: this.options.protection, now: () => this.now(), guard: (tx, person, call) => this.guard(tx, person, call) }).package(reference, actor, context);
  }
  async readReceiptEvidence(reference: string, context: BusinessProviderContext): Promise<EnterpriseContractTypes['EnterpriseProviderReceiptEvidence']> {
    const actor = await this.actor(context);
    return this.execution().readEvidence(reference, actor, context);
  }
  private execution(): EnterpriseBuiltinExecution {
    const assertExecution = this.options.assertExecution;
    if (!assertExecution) throw new EnterpriseError('PROVIDER_EXECUTION_UNCONFIGURED', 503);
    return new EnterpriseBuiltinExecution({ bridge: this.bridge, repository: this.options.repository, protection: this.options.protection, now: () => this.now(), bindingVersion: this.binding.streamVersion, assertExecution, hasContinuousHistory: this.options.hasContinuousHistory });
  }
  async executeAction(intent: ActionIntent & { status: 'committed' }, context: BusinessProviderContext): Promise<ProviderResult<ActionReceipt>> {
    const actor = await this.actor(context);
    if (!this.binding.bindings.some(b => b.objectType === intent.target.objectType && b.provider === this.id && b.supportedPorts.includes('executeAction') && b.allowedActions.includes(intent.action))) return { status: 'not_supported', capability: 'executeAction' };
    return { status: 'supported', value: await this.execution().execute(intent, actor, context) };
  }
  async getReceipt(operationKey: string, context: BusinessProviderContext): Promise<ProviderResult<ActionReceipt>> {
    const actor = await this.actor(context);
    if (!this.binding.bindings.some(b => b.provider === this.id && b.supportedPorts.includes('getReceipt'))) return { status: 'not_supported', capability: 'getReceipt' };
    return { status: 'supported', value: await this.execution().getReceipt(operationKey, actor, context) };
  }
}
