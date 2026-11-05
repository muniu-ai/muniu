// SPDX-License-Identifier: Apache-2.0
import { randomBytes, createHash } from 'node:crypto';
import { parseEnterpriseContract, type BusinessObjectRef, type EnterpriseContractTypes, type JsonObject } from '@mn/contracts';
import type { BusinessProviderContext, ProviderActionPreparation, ProviderResult } from '@mn/plugin-sdk';
import { PROTECTED_PAYLOAD_KEY_NAMESPACE, appendKernelEvent, sha256, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import { storeProtectedJson, readProtectedJson, type ProtectedJsonKeyRecordV1, type ContentAddressedStorage, type KeyProvider } from '@mn/storage';
import { EnterpriseKernelBridge } from './enterprise-kernel-bridge.js';
import { EnterpriseBusinessService } from './enterprise-business.js';
import { executionBusinessObject, executionObjectAccess, executionSourceFields } from './enterprise-execution-config.js';
import { renderGoalExport } from './goal-export-renderer.js';
export const PROVIDER_PREPARATION = 'enterprise-provider.preparation';
export interface ProviderPreparationRecord {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly ownerPrincipalId: string;
  readonly requestDigest: string; readonly request: ProviderActionPreparation; readonly result: EnterpriseContractTypes['EnterpriseProviderPreparedAction'];
  readonly protectedPayloadRef: string; readonly contentDigest: string; readonly fields: readonly string[];
}
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
export class EnterpriseProviderPreparation {
  constructor(readonly options: { bridge: EnterpriseKernelBridge; business: EnterpriseBusinessService; protection: { cas: ContentAddressedStorage; keyProvider: KeyProvider }; now: () => string; guard: (tx: KernelTransaction, actor: EnterpriseActor, context: BusinessProviderContext) => void }) {}
  check(tx: KernelTransaction, actor: EnterpriseActor, request: ProviderActionPreparation, context: BusinessProviderContext): void {
    this.options.guard(tx, actor, context);
    if (request.tenantId !== actor.tenantId || request.workspaceId !== context.workspaceId || request.target.tenantId !== actor.tenantId || request.target.workspaceId !== context.workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
    if ('provider' in request.target) throw new EnterpriseError('PROVIDER_NOT_RESPONSIBLE', 409);
    if (Date.parse(request.expiresAt) <= Date.parse(this.options.now())) throw new EnterpriseError('ACTION_EXPIRED', 409);
    if (request.action === 'issue_quote_package' ? request.target.objectType !== 'quote_version' : !['customer', 'opportunity'].includes(request.target.objectType)) throw new EnterpriseError('ACTION_TARGET_UNSUPPORTED', 409);
    const records = this.options.bridge.snapshot(tx).records, object = executionBusinessObject(records, request.target);
    executionObjectAccess(records, actor, object, 'write', executionSourceFields(object.reference.objectType), this.options.now());
    if (request.action === 'issue_quote_package' && (!['approved', 'accepted'].includes(String(object.value.status)) || object.value.approvalId !== request.businessApprovalRef || Date.parse(String(object.value.validUntil)) < Date.parse(request.expiresAt))) throw new EnterpriseError('BUSINESS_APPROVAL_REQUIRED', 409);
  }
  private readable(tx: KernelTransaction, actor: EnterpriseActor, context: BusinessProviderContext, record: ProviderPreparationRecord, review: boolean): void {
    this.options.guard(tx, actor, context);
    if (record.tenantId !== actor.tenantId || record.workspaceId !== context.workspaceId || 'provider' in record.request.target) throw new EnterpriseError('PROVIDER_CONTENT_NOT_FOUND', 404);
    const records = this.options.bridge.snapshot(tx).records, object = executionBusinessObject(records, record.request.target, false);
    executionObjectAccess(records, actor, object, 'read', record.fields, this.options.now());
    if (review && record.ownerPrincipalId !== actor.principalId) executionObjectAccess(records, actor, object, 'execution_approve', record.fields, this.options.now());
  }
  private async content(id: string, actor: EnterpriseActor, context: BusinessProviderContext, review: boolean): Promise<{ record: ProviderPreparationRecord; body: JsonObject }> {
    const saved = await this.options.bridge.store.transact(actor.tenantId, tx => {
      const record = tx.getProjection<ProviderPreparationRecord>(PROVIDER_PREPARATION, id);
      if (!record) throw new EnterpriseError('PROVIDER_CONTENT_NOT_FOUND', 404);
      this.readable(tx, actor, context, record, review);
      const key = tx.getProjection<ProtectedJsonKeyRecordV1>(PROTECTED_PAYLOAD_KEY_NAMESPACE, record.protectedPayloadRef);
      if (!key) throw new EnterpriseError('PROVIDER_CONTENT_UNAVAILABLE', 410); return { record, key };
    });
    const body = await readProtectedJson({ ...this.options.protection, tenantId: actor.tenantId, workspaceId: context.workspaceId, ownerType: 'enterprise-provider-preparation', ownerId: id, protectedPayloadRef: saved.record.protectedPayloadRef, keyRecord: saved.key });
    if (sha256(body) !== saved.record.contentDigest || sha256(body) !== saved.record.result.inputDigest) throw new EnterpriseError('PROVIDER_CONTENT_INVALID', 503);
    await this.options.bridge.store.transact(actor.tenantId, tx => { const check = () => this.readable(tx, actor, context, saved.record, review); check(); tx.beforeCommit!(check); });
    return { record: saved.record, body };
  }
  async preview(id: string, actor: EnterpriseActor, context: BusinessProviderContext): Promise<EnterpriseContractTypes['EnterpriseProviderActionPreview']> {
    const { record, body } = await this.content(id, actor, context, true), document = body.document as JsonObject | undefined;
    return parseEnterpriseContract('EnterpriseProviderActionPreview', { request: record.request, inputDigest: record.result.inputDigest, ...(document ? { document: { protectedContentRef: document.protectedContentRef, digest: document.digest, mediaType: document.mediaType } } : {}) });
  }
  async package(reference: string, actor: EnterpriseActor, context: BusinessProviderContext): Promise<EnterpriseContractTypes['EnterpriseProviderPackageContent']> {
    const found = await this.options.bridge.store.transact(actor.tenantId, tx => {
      this.options.guard(tx, actor, context);
      const record = tx.listProjections<ProviderPreparationRecord>(PROVIDER_PREPARATION).find(r => r.workspaceId === context.workspaceId && r.request.action === 'issue_quote_package' && 'builtin-package:' + sha256(r.id) === reference);
      if (!record) throw new EnterpriseError('PROVIDER_CONTENT_NOT_FOUND', 404);
      const official = this.options.bridge.snapshot(tx).records.some(r => r.type === 'enterprise.provider.receipt_recorded' && r.payload.operationKey === record.request.operationKey && r.payload.workspaceId === context.workspaceId && (r.payload.receipt as JsonObject | undefined)?.status === 'succeeded');
      this.readable(tx, actor, context, record, !official); return { record, official };
    });
    const loaded = await this.content(found.record.id, actor, context, !found.official), document = loaded.body.document as JsonObject;
    if (!document || document.protectedContentRef !== reference || typeof document.bytesBase64 !== 'string') throw new EnterpriseError('PROVIDER_CONTENT_INVALID', 503);
    const bytes = Buffer.from(document.bytesBase64, 'base64');
    if (bytes.toString('base64') !== document.bytesBase64 || createHash('sha256').update(bytes).digest('hex') !== document.digest) throw new EnterpriseError('PROVIDER_CONTENT_INVALID', 503);
    return parseEnterpriseContract('EnterpriseProviderPackageContent', { reference, source: found.record.request.target, mediaType: document.mediaType, digest: document.digest, bytesBase64: document.bytesBase64, official: found.official });
  }
  async prepare(raw: ProviderActionPreparation, actor: EnterpriseActor, context: BusinessProviderContext): Promise<ProviderResult<EnterpriseContractTypes['EnterpriseProviderPreparedAction']>> {
    const request = parseEnterpriseContract('EnterpriseProviderActionPreparation', raw), id = 'builtin-prepared:' + sha256([actor.tenantId, context.workspaceId, request.operationKey]), requestDigest = sha256(request);
    const existing = await this.options.bridge.store.transact(actor.tenantId, tx => {
      this.check(tx, actor, request, context);
      const previous = tx.getProjection<ProviderPreparationRecord>(PROVIDER_PREPARATION, id);
      if (previous && (previous.requestDigest !== requestDigest || previous.ownerPrincipalId !== actor.principalId)) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
      return previous;
    });
    if (existing) return { status: 'supported', value: existing.result };
    let document: { bytesBase64: string; mediaType: string; digest: string; protectedContentRef: string } | undefined;
    if (request.action === 'issue_quote_package') {
      const quote = await this.options.business.get(actor, context.workspaceId, 'quote_version', request.target.objectId, (request.target as BusinessObjectRef).streamVersion);
      const lines = quote.values.lines as unknown as readonly { title: string; quantity: number; unit: string; unitPriceMinor: number; totalMinor: number; scope: string; acceptanceCriteria: readonly string[] }[];
      const money = (minor: number) => (BigInt(minor) / 100n).toString() + '.' + (minor % 100).toString().padStart(2, '0');
      const body = [...lines.map(line => line.title + '：' + line.quantity + line.unit + '，单价 ' + money(line.unitPriceMinor) + ' 元，金额 ' + money(line.totalMinor) + ' 元\n范围：' + line.scope + '\n验收条件：' + line.acceptanceCriteria.join('；')), '合计：人民币 ' + money(Number(quote.values.totalMinor)) + ' 元', '有效期：' + quote.values.validUntil].join('\n\n');
      const rendered = await renderGoalExport(request.input.format, { title: '报价单', text: body, sourceLabel: '报价编号 ' + request.target.objectId + '，版本 ' + (request.target as BusinessObjectRef).streamVersion, accepted: false, statusLabel: '业务报价已批准；文件出包状态以系统回执为准', createdAt: this.options.now() });
      document = { bytesBase64: Buffer.from(rendered.bytes).toString('base64'), mediaType: rendered.mediaType, digest: createHash('sha256').update(rendered.bytes).digest('hex'), protectedContentRef: 'builtin-package:' + sha256(id) };
    }
    const payload = json({ request, ...(document ? { document } : {}) }), inputDigest = sha256(payload), protectedPayloadRef = 'provider-input:' + randomBytes(32).toString('hex');
    const stored = await storeProtectedJson({ ...this.options.protection, tenantId: actor.tenantId, workspaceId: context.workspaceId, ownerType: 'enterprise-provider-preparation', ownerId: id, protectedPayloadRef, value: payload, createdAt: this.options.now() });
    return this.options.bridge.store.transact(actor.tenantId, tx => {
      const check = () => this.check(tx, actor, request, context); check(); tx.beforeCommit!(check);
      const prior = tx.getProjection<ProviderPreparationRecord>(PROVIDER_PREPARATION, id);
      if (prior) { if (prior.requestDigest !== requestDigest || prior.ownerPrincipalId !== actor.principalId) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return { status: 'supported', value: prior.result } as const; }
      const result = { preparedInputRef: id, inputDigest, target: request.target, expiresAt: request.expiresAt };
      const record: ProviderPreparationRecord = { id, tenantId: actor.tenantId, workspaceId: context.workspaceId, streamVersion: 1, ownerPrincipalId: actor.principalId, requestDigest, request, result, protectedPayloadRef, contentDigest: stored.plaintextDigest, fields: executionSourceFields(request.target.objectType) };
      tx.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, protectedPayloadRef, stored.keyRecord); tx.putProjection(PROVIDER_PREPARATION, id, record);
      appendKernelEvent(tx, { tenantId: actor.tenantId, aggregateType: PROVIDER_PREPARATION, aggregateId: id, expectedStreamVersion: 0, type: 'provider.input_prepared', actorId: actor.principalId, generation: 0, correlationId: id, publicPayload: { workspaceId: context.workspaceId } });
      return { status: 'supported', value: result } as const;
    });
  }
}
