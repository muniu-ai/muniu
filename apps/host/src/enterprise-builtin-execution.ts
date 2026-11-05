// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { canonicalJson, computeActionIntentDigest, parseEnterpriseContract, type ActionIntent, type ActionReceipt, type BusinessObjectRef, type EnterpriseContractTypes, type JsonObject } from '@mn/contracts';
import { PROVIDER_ACTION_NAMESPACE, type CoordinatedAction } from '@mn/business-execution';
import type { BusinessProviderContext } from '@mn/plugin-sdk';
import { PROTECTED_PAYLOAD_KEY_NAMESPACE, sha256, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, requireActor, reduceIdentityEvents, resolveObjectAccess, type EnterpriseActor, type EnterpriseRecord } from '@mn/enterprise-services';
import { decideBuiltinProviderAction, BusinessDomainError, reduceBusinessEvents, type BusinessEvent } from '@mn/plugin-business';
import { readProtectedJson, type ContentAddressedStorage, type KeyProvider, type ProtectedJsonKeyRecordV1 } from '@mn/storage';
import { EnterpriseKernelBridge } from './enterprise-kernel-bridge.js';
import type { EnterpriseEventRepository } from './enterprise-event-repository.js';
import { businessAccessDescriptor, enterpriseBusinessFacts } from './enterprise-business.js';
import { executionBusinessObject, executionObjectAccess, executionSourceFields, executionConfiguration } from './enterprise-execution-config.js';
import { PROVIDER_PREPARATION, type ProviderPreparationRecord } from './enterprise-provider-preparation.js';
export const BUILTIN_RECEIPT_TYPE = 'enterprise.provider.receipt_recorded';
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
export class EnterpriseBuiltinExecution {
  constructor(readonly options: { bridge: EnterpriseKernelBridge; repository: EnterpriseEventRepository; protection: { cas: ContentAddressedStorage; keyProvider: KeyProvider }; now: () => string; bindingVersion: number; assertExecution: (tx: KernelTransaction, records: readonly EnterpriseRecord[], intent: ActionIntent, context: BusinessProviderContext) => void; hasContinuousHistory?: (tx: KernelTransaction, context: BusinessProviderContext) => boolean }) {}
  private receipt(records: readonly EnterpriseRecord[], operationKey: string, workspaceId: string) {
    return records.find(r => r.type === BUILTIN_RECEIPT_TYPE && r.payload.operationKey === operationKey && r.payload.workspaceId === workspaceId);
  }
  private access(records: readonly EnterpriseRecord[], actor: EnterpriseActor, intent: Pick<ActionIntent, 'target' | 'workspaceId' | 'providerBindingVersion'>, write: boolean): void {
    requireActor(reduceIdentityEvents(records), actor, false, this.options.now());
    if ('provider' in intent.target || intent.target.tenantId !== actor.tenantId || intent.target.workspaceId !== intent.workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
    const binding = executionConfiguration(records, intent.workspaceId).binding;
    if (!binding || binding.streamVersion !== intent.providerBindingVersion || binding.bindings.find(b => b.objectType === intent.target.objectType)?.provider !== 'builtin') throw new EnterpriseError('PROVIDER_BINDING_CHANGED', 409);
    const target = executionBusinessObject(records, intent.target, write);
    executionObjectAccess(records, actor, target, write ? 'write' : 'read', executionSourceFields(target.reference.objectType), this.options.now());
  }
  async execute(raw: ActionIntent & { status: 'committed' }, actor: EnterpriseActor, context: BusinessProviderContext): Promise<ActionReceipt> {
    const intent = parseEnterpriseContract('ActionIntent', raw), actionDigest = computeActionIntentDigest(intent);
    if (intent.provider !== 'builtin' || intent.tenantId !== actor.tenantId || intent.workspaceId !== context.workspaceId || intent.status !== 'committed') throw new EnterpriseError('PROVIDER_CONTEXT_MISMATCH');
    const prior = await this.options.repository.read(actor.tenantId);
    const existing = this.receipt(prior, intent.operationKey, intent.workspaceId);
    if (existing) { const receipt = await this.getReceipt(intent.operationKey, actor, context); if (receipt.actionDigest !== actionDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return receipt; }
    const saved = await this.options.bridge.store.transact(actor.tenantId, tx => {
      this.options.assertExecution(tx, this.options.bridge.snapshot(tx).records, intent, context);
      const record = tx.getProjection<ProviderPreparationRecord>(PROVIDER_PREPARATION, intent.preparedInputRef);
      if (!record || record.ownerPrincipalId !== actor.principalId || record.workspaceId !== intent.workspaceId || record.result.inputDigest !== intent.inputDigest || record.request.operationKey !== intent.operationKey || record.request.action !== intent.action || canonicalJson(record.request.target) !== canonicalJson(intent.target) || record.request.providerBindingVersion !== intent.providerBindingVersion || record.request.expiresAt !== intent.expiresAt || ('businessApprovalRef' in record.request ? record.request.businessApprovalRef : undefined) !== intent.businessApprovalRef) throw new EnterpriseError('PROVIDER_PREPARATION_MISMATCH', 409);
      const key = tx.getProjection<ProtectedJsonKeyRecordV1>(PROTECTED_PAYLOAD_KEY_NAMESPACE, record.protectedPayloadRef);
      if (!key) throw new EnterpriseError('PROVIDER_CONTENT_UNAVAILABLE', 410); return { record, key };
    });
    const body = await readProtectedJson({ ...this.options.protection, tenantId: actor.tenantId, workspaceId: intent.workspaceId, ownerType: 'enterprise-provider-preparation', ownerId: saved.record.id, protectedPayloadRef: saved.record.protectedPayloadRef, keyRecord: saved.key });
    if (sha256(body) !== saved.record.contentDigest || sha256(body) !== intent.inputDigest) throw new EnterpriseError('PROVIDER_CONTENT_INVALID', 503);
    const request = parseEnterpriseContract('EnterpriseProviderActionPreparation', body.request);
    const rawDocument = body.document as JsonObject | undefined;
    const document = rawDocument ? { protectedContentRef: rawDocument.protectedContentRef, digest: rawDocument.digest, mediaType: rawDocument.mediaType } : undefined;
    const salt = randomBytes(32).toString('hex');
    let protectedRecords: readonly EnterpriseRecord[] = [];
    try {
      await this.options.repository.transact(actor.tenantId, records => {
        protectedRecords = records;
        this.access(records, actor, intent, false);
        const priorReceipt = this.receipt(records, intent.operationKey, intent.workspaceId);
        if (priorReceipt) { const value = parseEnterpriseContract('ActionReceipt', priorReceipt.payload.receipt); if (value.actionDigest !== actionDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return { events: [], value }; }
        const history = enterpriseBusinessFacts(records, actor.tenantId, intent.workspaceId), state = reduceBusinessEvents(history);
        const decide = () => {
          if (context.signal.aborted) throw new EnterpriseError('PROVIDER_CANCELLED', 409);
          this.access(records, actor, intent, true);
          return decideBuiltinProviderAction(state, request, { tenantId: actor.tenantId, workspaceId: intent.workspaceId, actorId: actor.principalId, actorKind: 'service', now: this.options.now(), revisionSalt: salt,
            assertExecutionAllowed: () => { if (!context.authorityRevisionId || context.authorityRevisionId !== intent.authorityRevisionId) throw new EnterpriseError('EXECUTION_SCOPE_INVALID', 409); },
            assertCurrent: requirement => { const descriptor = businessAccessDescriptor(requirement.object), allowed = resolveObjectAccess(records, actor, descriptor, requirement.operation, this.options.now()); if (requirement.fields.some(field => !descriptor.fieldClasses[field] || !allowed.has(descriptor.fieldClasses[field]!))) throw new EnterpriseError('FIELD_ACCESS_DENIED'); },
            assertEvidence: () => { throw new EnterpriseError('PROVIDER_EVIDENCE_UNSUPPORTED'); },
          }, document);
        };
        const change = decide(), updated = reduceBusinessEvents([...history, ...change.events]).objects.get(change.primaryObjectKey)!;
        const now = this.options.now(), receiptId = 'builtin-receipt:' + sha256([actor.tenantId, intent.workspaceId, intent.operationKey]);
        const receipt: ActionReceipt = { tenantId: actor.tenantId, workspaceId: intent.workspaceId, id: receiptId, operationKey: intent.operationKey, actionDigest, provider: 'builtin', status: 'succeeded', receivedAt: now, completedAt: now, evidenceRefs: [{ tenantId: actor.tenantId, workspaceId: intent.workspaceId, id: receiptId, sourceKind: 'business_fact', sourceVersion: String(updated.reference.streamVersion), digest: sha256([actionDigest, updated.reference]), protectedContentRef: receiptId, permissionRef: 'builtin-object:' + updated.reference.objectId, locator: { paragraph: '业务动作回执' } }] };
        const events: EnterpriseRecord[] = change.events.map((fact: BusinessEvent) => ({ type: 'enterprise.business.' + fact.type, aggregateType: 'enterprise.business.' + fact.objectType, aggregateId: canonicalJson([intent.workspaceId, fact.objectId]), expectedStreamVersion: fact.expectedStreamVersion, actorId: fact.actorId, occurredAt: fact.occurredAt, payload: json({ fact: { ...fact, causation: { operationKey: intent.operationKey, goalId: intent.goalId } } }) }));
        events.push({ type: BUILTIN_RECEIPT_TYPE, aggregateType: 'enterprise.provider.operation', aggregateId: receiptId, expectedStreamVersion: 0, actorId: actor.principalId, occurredAt: now, payload: json({ operationKey: intent.operationKey, workspaceId: intent.workspaceId, target: intent.target, providerBindingVersion: intent.providerBindingVersion, result: updated.reference, receipt }) });
        return { events, value: receipt, assertBeforeCommit: () => { decide(); } };
      }, tx => this.options.assertExecution(tx, protectedRecords, intent, context));
      // A concurrent receipt can take the read-only branch, which skips write guards.
      const receipt = await this.getReceipt(intent.operationKey, actor, context);
      if (receipt.actionDigest !== actionDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
      return receipt;
    } catch (error) { if (error instanceof BusinessDomainError) throw new EnterpriseError(error.code, error.status); throw error; }
  }
  async readEvidence(reference: string, actor: EnterpriseActor, context: BusinessProviderContext): Promise<EnterpriseContractTypes['EnterpriseProviderReceiptEvidence']> {
    return this.options.bridge.store.transact(actor.tenantId, tx => {
      const records = this.options.bridge.snapshot(tx).records;
      requireActor(reduceIdentityEvents(records), actor, false, this.options.now());
      const saved = records.find(r => r.type === BUILTIN_RECEIPT_TYPE && r.aggregateId === reference && r.payload.workspaceId === context.workspaceId);
      if (!saved) throw new EnterpriseError('PROVIDER_CONTENT_NOT_FOUND', 404);
      const target = saved.payload.target as unknown as BusinessObjectRef;
      const check = () => { if (context.signal.aborted) throw new EnterpriseError('PROVIDER_CANCELLED', 409); this.access(records, actor, { target, workspaceId: context.workspaceId, providerBindingVersion: this.options.bindingVersion }, false); };
      check(); tx.beforeCommit!(check);
      return parseEnterpriseContract('EnterpriseProviderReceiptEvidence', { receipt: saved.payload.receipt, target, ...(saved.payload.result ? { result: saved.payload.result } : {}) });
    });
  }
  async getReceipt(operationKey: string, actor: EnterpriseActor, context: BusinessProviderContext): Promise<ActionReceipt> {
    const result = await this.options.bridge.store.transact(actor.tenantId, tx => {
      const records = this.options.bridge.snapshot(tx).records;
      requireActor(reduceIdentityEvents(records), actor, false, this.options.now());
      const saved = this.receipt(records, operationKey, context.workspaceId);
      if (saved) {
        const intent = { target: saved.payload.target as unknown as BusinessObjectRef, workspaceId: context.workspaceId, providerBindingVersion: this.options.bindingVersion };
        const check = () => { if (context.signal.aborted) throw new EnterpriseError('PROVIDER_CANCELLED', 409); this.access(records, actor, intent, false); }; check(); tx.beforeCommit!(check);
        return { receipt: parseEnterpriseContract('ActionReceipt', saved.payload.receipt) };
      }
      if (this.options.hasContinuousHistory?.(tx, context) !== true) throw new EnterpriseError('PROVIDER_RECEIPT_UNAVAILABLE', 409);
      const preparation = tx.getProjection<ProviderPreparationRecord>(PROVIDER_PREPARATION, 'builtin-prepared:' + sha256([actor.tenantId, context.workspaceId, operationKey]));
      const action = tx.getProjection<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE, 'action:' + sha256([actor.tenantId, operationKey]));
      if (!preparation || !action || action.provider !== 'builtin' || action.workspaceId !== context.workspaceId || action.preparedInputRef !== preparation.id || action.inputDigest !== preparation.result.inputDigest || Date.parse(preparation.request.expiresAt) > Date.parse(this.options.now())) throw new EnterpriseError('PROVIDER_RECEIPT_UNAVAILABLE', 409);
      this.access(records, actor, { ...action, providerBindingVersion: this.options.bindingVersion }, false);
      return { action, preparation };
    });
    if (result.receipt) return result.receipt;
    const { action, preparation } = result;
    const receipt: ActionReceipt = { tenantId: actor.tenantId, workspaceId: context.workspaceId, id: 'builtin-receipt:' + sha256([actor.tenantId, context.workspaceId, operationKey]), operationKey, actionDigest: action!.actionDigest, provider: 'builtin', receivedAt: this.options.now(), status: 'not_executed', reasonCode: 'PREPARATION_EXPIRED_WITHOUT_EFFECT' };
    return this.options.repository.transact(actor.tenantId, records => {
      if (context.signal.aborted) throw new EnterpriseError('PROVIDER_CANCELLED', 409);
      this.access(records, actor, { ...action!, providerBindingVersion: this.options.bindingVersion }, false);
      const prior = this.receipt(records, operationKey, context.workspaceId);
      if (prior) return { events: [], value: parseEnterpriseContract('ActionReceipt', prior.payload.receipt) };
      return { events: [{ type: BUILTIN_RECEIPT_TYPE, aggregateType: 'enterprise.provider.operation', aggregateId: receipt.id, expectedStreamVersion: 0, actorId: actor.principalId, occurredAt: this.options.now(), payload: json({ operationKey, workspaceId: context.workspaceId, target: action!.target, providerBindingVersion: action!.providerBindingVersion, receipt }) }], value: receipt,
        assertBeforeCommit: () => { this.access(records, actor, { ...action!, providerBindingVersion: this.options.bindingVersion }, false); if (Date.parse(preparation!.request.expiresAt) > Date.parse(this.options.now())) throw new EnterpriseError('PROVIDER_RECEIPT_UNAVAILABLE', 409); } };
    }, tx => {
      if (this.options.hasContinuousHistory?.(tx, context) !== true) throw new EnterpriseError('PROVIDER_RECEIPT_UNAVAILABLE', 409);
      const current = tx.getProjection<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE, action!.id);
      const prepared = tx.getProjection<ProviderPreparationRecord>(PROVIDER_PREPARATION, preparation!.id);
      if (!current || !prepared || current.actionDigest !== receipt.actionDigest || current.preparedInputRef !== prepared.id || prepared.result.inputDigest !== current.inputDigest || Date.parse(prepared.request.expiresAt) > Date.parse(this.options.now())) throw new EnterpriseError('PROVIDER_RECEIPT_UNAVAILABLE', 409);
    });
  }
}
