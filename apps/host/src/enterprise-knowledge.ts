// SPDX-License-Identifier: Apache-2.0
import { renderGoalExport } from './goal-export-renderer.js';
import { randomBytes } from 'node:crypto';
import { parseEnterpriseContract, type BusinessObjectRef, type EvidenceRef, type EnterpriseContractTypes, type JsonObject } from '@mn/contracts';
import { PROTECTED_PAYLOAD_KEY_NAMESPACE, sha256, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, resolveObjectAccess, type EnterpriseActor, type FieldClass, type ObjectAccessDescriptor } from '@mn/enterprise-services';
import { storeProtectedJson, readProtectedJson, type ContentAddressedStorage, type KeyProvider, type ProtectedJsonKeyRecordV1 } from '@mn/storage';
import { EnterpriseOperatingService, type OperatingSources } from './enterprise-operating.js';
import { executionBusinessObject } from './enterprise-execution-config.js';
import { businessAccessDescriptor } from './enterprise-business.js';
import { selectMaterialBlocks } from './material-context.js';
import { extractDocument, type DocumentExtraction, type DocumentBlock } from './document-extraction.js';
export const KNOWLEDGE_USE = 'enterprise-knowledge.use';
export const KNOWLEDGE_VERSION = 'enterprise-knowledge.version', KNOWLEDGE_DOCUMENT = 'enterprise-knowledge.document';
interface DocumentControl { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly ownerPrincipalId: string; readonly status: 'active' | 'withdrawn'; readonly latestVersionId: string; readonly sharedVersions?: readonly string[]; }
export interface KnowledgeVersion {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly documentId: string; readonly revision: number;
  readonly title: string; readonly ownerPrincipalId: string; readonly bindings: OperatingSources; readonly classification: readonly FieldClass[]; readonly visibility: 'private' | 'business_scope';
  readonly reference: BusinessObjectRef; readonly sourceKind: EvidenceRef['sourceKind']; readonly protectedPayloadRef: string; readonly contentDigest: string; readonly createdAt: string;
}
const documentKey = (workspaceId: string, id: string) => sha256([workspaceId, id]);
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
export class EnterpriseKnowledgeService {
  readonly operating: EnterpriseOperatingService;
  private readonly activeReads = new WeakMap<KernelTransaction, Set<string>>();
  constructor(readonly options: { operating: EnterpriseOperatingService; protection: { cas: ContentAddressedStorage; keyProvider: KeyProvider }; extract?: typeof extractDocument }) { this.operating = options.operating;
    this.operating.registerSources({ objectTypes: ['evidence_ref', 'artifact_version', 'memory_entry', 'decision_record'],
      current: (tx, reference) => { const version = this.require(tx, reference), control = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(version.workspaceId, version.documentId)); if (!control || control.status !== 'active') throw new EnterpriseError('KNOWLEDGE_SOURCE_WITHDRAWN', 410); this.assertUsable(tx, version); return version.reference; },
      assertRead: (tx, actor, reference, fields) => { if (fields.some(field => !['text', 'title', 'citations', 'sourceKind'].includes(field))) throw new EnterpriseError('FIELD_ACCESS_DENIED'); const version = this.require(tx, reference); this.assertUsable(tx, version); this.assertRead(tx, actor, version); },
      read: (actor, reference, fields, query, maxBytes) => this.modelSource(actor, reference, fields, query, maxBytes),
    });
  }
  assertUsable(tx: KernelTransaction, version: KnowledgeVersion): void {
    if (version.reference.objectType === 'memory_entry' && tx.getProjection<{ enabled: boolean }>(KNOWLEDGE_USE, version.id)?.enabled !== true) throw new EnterpriseError('EXPERIENCE_NOT_ENABLED', 409);
  }
  requireReadable(tx: KernelTransaction, actor: EnterpriseActor, reference: BusinessObjectRef): KnowledgeVersion {
    const version = this.require(tx, reference); this.assertRead(tx, actor, version); return version;
  }
  private now(): string { return this.operating.now(); }
  private classification(tx: KernelTransaction, bindings: OperatingSources, extra: readonly FieldClass[]): readonly FieldClass[] {
    const result = new Set<FieldClass>(extra), records = this.operating.bridge.snapshot(tx).records;
    for (const source of bindings) {
      if (['evidence_ref', 'artifact_version', 'memory_entry', 'decision_record'].includes(source.reference.objectType)) { const parent = this.require(tx, source.reference); parent.classification.forEach(kind => result.add(kind)); continue; }
      const object = executionBusinessObject(records, source.reference), descriptor = businessAccessDescriptor(object);
      for (const field of source.fields) { const kind = descriptor.fieldClasses[field]; if (!kind) throw new EnterpriseError('FIELD_ACCESS_DENIED'); result.add(kind); }
    }
    return [...result].sort();
  }
  private descriptor(tx: KernelTransaction, version: KnowledgeVersion): ObjectAccessDescriptor {
    let source = version.bindings[0]!; const seen = new Set<string>();
    while (['evidence_ref', 'artifact_version', 'memory_entry', 'decision_record'].includes(source.reference.objectType)) { if (seen.has(source.reference.objectId) || seen.size >= 32) throw new EnterpriseError('KNOWLEDGE_SOURCE_CLOSURE_INVALID', 409); seen.add(source.reference.objectId); source = this.require(tx, source.reference).bindings[0]!; }
    const anchor = businessAccessDescriptor(executionBusinessObject(this.operating.bridge.snapshot(tx).records, source.reference, false));
    return { ...anchor, tenantId: version.tenantId, workspaceId: version.workspaceId, objectType: version.reference.objectType, objectId: version.id, ownerPrincipalId: version.ownerPrincipalId,
      fieldClasses: Object.fromEntries(version.classification.map(kind => ['content_' + kind, kind])) };
  }
  assertRead(tx: KernelTransaction, actor: EnterpriseActor, version: KnowledgeVersion, existing = true): void {
    const active = this.activeReads.get(tx) ?? new Set<string>();
    if (active.has(version.id) || active.size >= 32) throw new EnterpriseError('KNOWLEDGE_SOURCE_CLOSURE_INVALID', 409);
    active.add(version.id); this.activeReads.set(tx, active);
    try {
    this.operating.actor(tx, actor, version.workspaceId);
    if (actor.tenantId !== version.tenantId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
    const accessControl = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(version.workspaceId, version.documentId));
    if (version.visibility === 'private' && version.ownerPrincipalId !== actor.principalId && !accessControl?.sharedVersions?.includes(version.id)) throw new EnterpriseError('KNOWLEDGE_NOT_FOUND', 404);
    if (existing) {
      const control = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(version.workspaceId, version.documentId));
      if (!control || control.status !== 'active') throw new EnterpriseError('KNOWLEDGE_SOURCE_WITHDRAWN', 410);
    }
    const allowed = resolveObjectAccess(this.operating.bridge.snapshot(tx).records, actor, this.descriptor(tx, version), 'read', this.now());
    if (version.classification.some(kind => !allowed.has(kind))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
    this.operating.sources(tx, actor, version.workspaceId, version.bindings);
    } finally { active.delete(version.id); if (!active.size) this.activeReads.delete(tx); }
  }
  private require(tx: KernelTransaction, reference: BusinessObjectRef): KnowledgeVersion {
    const version = tx.getProjection<KnowledgeVersion>(KNOWLEDGE_VERSION, reference.objectId);
    if (!version || sha256(version.reference) !== sha256(reference)) throw new EnterpriseError('KNOWLEDGE_NOT_FOUND', 404);
    return version;
  }
  async importDocument(actor: EnterpriseActor, workspaceId: string, key: string, raw: EnterpriseContractTypes['EnterpriseDocumentImport']): Promise<EnterpriseContractTypes['EnterpriseKnowledgeView']> { return this.importVersion(actor, workspaceId, key, raw, 'evidence_ref', 'raw_material'); }
  async snapshotBusiness(actor: EnterpriseActor, workspaceId: string, key: string, source: EnterpriseContractTypes['EnterpriseSourceScope']): Promise<EnterpriseContractTypes['EnterpriseKnowledgeView']> {
    parseEnterpriseContract('EnterpriseSourceScope', source);
    if (['evidence_ref', 'artifact_version', 'memory_entry', 'decision_record'].includes(source.reference.objectType) || source.reference.workspaceId !== workspaceId) throw new EnterpriseError('BUSINESS_FACT_SOURCE_REQUIRED', 400);
    const values = await this.operating.readSource(actor, source.reference, source.fields);
    return this.createDerived(actor, workspaceId, key, { documentId: 'fact:' + sha256([actor.principalId, key]), title: '业务事实 ' + source.reference.objectType, text: JSON.stringify({ reference: source.reference, values }, null, 2), bindings: [source], objectType: 'evidence_ref', sourceKind: 'business_fact' });
  }
  async createDerived(actor: EnterpriseActor, workspaceId: string, key: string, input: { documentId: string; title: string; text: string; bindings: OperatingSources; objectType: 'evidence_ref' | 'artifact_version' | 'memory_entry' | 'decision_record'; sourceKind: EvidenceRef['sourceKind']; expectedStreamVersion?: number; visibility?: 'private' | 'business_scope' }): Promise<EnterpriseContractTypes['EnterpriseKnowledgeView']> {
    return this.importVersion(actor, workspaceId, key, { documentId: input.documentId, expectedStreamVersion: input.expectedStreamVersion ?? 0, title: input.title, fileName: 'content.md', mediaType: 'text/markdown', contentBase64: Buffer.from(input.text).toString('base64'), bindings: input.bindings, classification: ['public'], visibility: input.visibility ?? 'private' }, input.objectType, input.sourceKind);
  }
  private async importVersion(actor: EnterpriseActor, workspaceId: string, key: string, raw: EnterpriseContractTypes['EnterpriseDocumentImport'], objectType: BusinessObjectRef['objectType'], sourceKind: EvidenceRef['sourceKind']): Promise<EnterpriseContractTypes['EnterpriseKnowledgeView']> {
    const input = parseEnterpriseContract('EnterpriseDocumentImport', raw);
    if (!key.trim() || key.length > 200 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.contentBase64)) throw new EnterpriseError('INVALID_BODY', 400);
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.toString('base64') !== input.contentBase64 || bytes.length > 8 * 1024 * 1024) throw new EnterpriseError('DOCUMENT_LIMIT', 413);
    const requestId = sha256([actor.principalId, workspaceId, key]), requestDigest = sha256([input, objectType, sourceKind]), id = 'knowledge:' + sha256([actor.tenantId, workspaceId, input.documentId, input.expectedStreamVersion + 1]);
    const checked = await this.operating.bridge.store.transact(actor.tenantId, tx => {
      this.operating.sources(tx, actor, workspaceId, input.bindings);
      const prior = tx.getProjection<{ requestDigest: string; reference: BusinessObjectRef }>('enterprise-knowledge.command', requestId);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); this.assertRead(tx, actor, this.require(tx, prior.reference)); return { replay: prior.reference }; }
      const control = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(workspaceId, input.documentId));
      if ((control?.streamVersion ?? 0) !== input.expectedStreamVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      if (control && (control.ownerPrincipalId !== actor.principalId || control.status !== 'active')) throw new EnterpriseError('KNOWLEDGE_CONTROL_DENIED');
      const classification = this.classification(tx, input.bindings, input.classification);
      const shape: KnowledgeVersion = { id, tenantId: actor.tenantId, workspaceId, streamVersion: 1, documentId: input.documentId, revision: input.expectedStreamVersion + 1, title: input.title, bindings: input.bindings, classification, visibility: input.visibility, ownerPrincipalId: actor.principalId, reference: { tenantId: actor.tenantId, workspaceId, objectType, objectId: id, streamVersion: 1, digest: '0'.repeat(64) }, sourceKind, protectedPayloadRef: '', contentDigest: '', createdAt: this.now() };
      this.assertRead(tx, actor, shape, false); return { shape };
    });
    if (checked.replay) return this.get(actor, checked.replay);
    let extraction: DocumentExtraction;
    try { extraction = await (this.options.extract ?? extractDocument)({ fileName: input.fileName, mediaType: input.mediaType, bytes }, { inputBytes: 8 * 1024 * 1024 }); }
    finally { bytes.fill(0); }
    const protectedPayloadRef = 'knowledge-payload:' + randomBytes(32).toString('hex');
    const stored = await storeProtectedJson({ ...this.options.protection, tenantId: actor.tenantId, workspaceId, ownerType: 'enterprise-knowledge', ownerId: id, protectedPayloadRef, value: json({ contentBase64: input.contentBase64, fileName: input.fileName, mediaType: input.mediaType, extraction }), createdAt: this.now() });
    const reference = await this.operating.bridge.store.transact(actor.tenantId, tx => {
      const previous = tx.getProjection<{ requestDigest: string; reference: BusinessObjectRef }>('enterprise-knowledge.command', requestId);
      if (previous) { if (previous.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); this.assertRead(tx, actor, this.require(tx, previous.reference)); return previous.reference; }
      const current = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(workspaceId, input.documentId));
      if ((current?.streamVersion ?? 0) !== input.expectedStreamVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      if (current && (current.ownerPrincipalId !== actor.principalId || current.status !== 'active')) throw new EnterpriseError('KNOWLEDGE_CONTROL_DENIED');
      const shape = checked.shape!;
      const check = () => { this.assertRead(tx, actor, shape, false); this.operating.sources(tx, actor, workspaceId, input.bindings, true); };
      check(); tx.beforeCommit!(check);
      const digest = sha256([randomBytes(32).toString('hex'), stored.plaintextDigest, shape.bindings, shape.classification]);
      const value: KnowledgeVersion = { ...shape, contentDigest: stored.plaintextDigest, protectedPayloadRef, reference: { ...shape.reference, digest } };
      tx.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, protectedPayloadRef, stored.keyRecord);
      this.operating.record(tx, KNOWLEDGE_VERSION, value, actor.principalId, 'knowledge.version_created');
      this.operating.record(tx, KNOWLEDGE_DOCUMENT, { id: documentKey(workspaceId, input.documentId), tenantId: actor.tenantId, workspaceId, streamVersion: input.expectedStreamVersion + 1, ownerPrincipalId: actor.principalId, status: 'active', latestVersionId: id, ...(current?.sharedVersions ? { sharedVersions: current.sharedVersions } : {}) }, actor.principalId, 'knowledge.document_updated');
      this.operating.record(tx, 'enterprise-knowledge.command', { id: requestId, tenantId: actor.tenantId, workspaceId, streamVersion: 1, requestDigest, reference: value.reference }, actor.principalId, 'knowledge.command_recorded');
      return value.reference;
    });
    return this.get(actor, reference);
  }
  private async modelSource(actor: EnterpriseActor, reference: BusinessObjectRef, fields: readonly string[], query: string, maxBytes: number): Promise<JsonObject> {
    if (fields.some(field => !['text', 'title', 'citations', 'sourceKind'].includes(field))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
    await this.operating.bridge.store.transact(actor.tenantId, tx => this.assertUsable(tx, this.require(tx, reference)));
    const material = await this.get(actor, reference);
    const version = await this.operating.bridge.store.transact(actor.tenantId, tx => { const value = this.require(tx, reference); this.assertUsable(tx, value); this.assertRead(tx, actor, value); return value; });
    const blocks = selectMaterialBlocks(material.extraction.blocks, query, maxBytes);
    return json({ ...(fields.includes('title') ? { title: material.title } : {}), sourceKind: material.sourceKind,
      ...(fields.includes('text') ? { text: blocks.map(block => block.text).join('\n\n') } : {}), citations: blocks.map(block => this.evidence(version, block)),
      sourceStatus: material.extraction.status, coverage: { selectedBlocks: blocks.length, totalBlocks: material.extraction.blocks.length, complete: material.extraction.status === 'complete' && blocks.length === material.extraction.blocks.length } });
  }
  async get(actor: EnterpriseActor, reference: BusinessObjectRef): Promise<EnterpriseContractTypes['EnterpriseKnowledgeView']> {
    if (actor.tenantId !== reference.tenantId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
    const snapshot = await this.operating.bridge.store.transact(actor.tenantId, tx => {
      const version = this.require(tx, reference); this.assertRead(tx, actor, version);
      const keyRecord = tx.getProjection<ProtectedJsonKeyRecordV1>(PROTECTED_PAYLOAD_KEY_NAMESPACE, version.protectedPayloadRef);
      if (!keyRecord) throw new EnterpriseError('KNOWLEDGE_CONTENT_UNAVAILABLE', 410);
      return { version, keyRecord };
    });
    const body = await readProtectedJson({ ...this.options.protection, tenantId: actor.tenantId, workspaceId: reference.workspaceId, ownerType: 'enterprise-knowledge', ownerId: snapshot.version.id, protectedPayloadRef: snapshot.version.protectedPayloadRef, keyRecord: snapshot.keyRecord });
    if (sha256(body) !== snapshot.version.contentDigest) throw new EnterpriseError('KNOWLEDGE_INTEGRITY_INVALID', 503);
    await this.operating.bridge.store.transact(actor.tenantId, tx => { const check = () => this.assertRead(tx, actor, this.require(tx, reference)); check(); tx.beforeCommit!(check); });
    return parseEnterpriseContract('EnterpriseKnowledgeView', { reference, documentId: snapshot.version.documentId, revision: snapshot.version.revision, title: snapshot.version.title, sourceKind: snapshot.version.sourceKind, classification: snapshot.version.classification, sources: snapshot.version.bindings, extraction: body.extraction, createdAt: snapshot.version.createdAt });
  }
  evidence(version: KnowledgeVersion, block: DocumentBlock): EvidenceRef {
    const locator: EvidenceRef['locator'] = block.locator.page ? { page: block.locator.page } : block.locator.cell ? { sheet: block.locator.sheet ?? 'CSV', cell: block.locator.cell } : { paragraph: String(block.locator.paragraph ?? block.locator.part ?? block.id) };
    return { tenantId: version.tenantId, workspaceId: version.workspaceId, id: version.id + ':' + block.id, sourceKind: version.sourceKind, protectedContentRef: version.protectedPayloadRef, sourceVersion: String(version.revision), digest: sha256([version.reference.digest, block]), permissionRef: 'knowledge:' + version.id, locator };
  }
  async search(actor: EnterpriseActor, workspaceId: string, query: string, limit = 20): Promise<EnterpriseContractTypes['EnterpriseKnowledgeSearchResult']> {
    parseEnterpriseContract('EnterpriseKnowledgeSearch', { query, limit });
    const candidates = await this.operating.bridge.store.transact(actor.tenantId, tx => {
      this.operating.actor(tx, actor, workspaceId);
      return tx.listProjections<DocumentControl>(KNOWLEDGE_DOCUMENT).filter(c => c.workspaceId === workspaceId && c.status === 'active').flatMap(control => {
        const version = tx.getProjection<KnowledgeVersion>(KNOWLEDGE_VERSION, control.latestVersionId);
        if (!version) return []; try { this.assertUsable(tx, version); this.assertRead(tx, actor, version); return [version]; } catch (error) { if (error instanceof EnterpriseError && error.status < 500) return []; throw error; }
      });
    });
    const normalized = query.normalize('NFKC').toLowerCase(), hits: EnterpriseContractTypes['EnterpriseKnowledgeSearchResult']['hits'][number][] = [];
    for (const version of candidates) {
      if (hits.length >= limit) break;
      let material: EnterpriseContractTypes['EnterpriseKnowledgeView'];
      try { material = await this.get(actor, version.reference); } catch (error) { if (error instanceof EnterpriseError && error.status < 500) continue; throw error; }
      for (const block of material.extraction.blocks) {
        if (!block.text.normalize('NFKC').toLowerCase().includes(normalized)) continue;
        hits.push({ reference: version.reference, title: version.title, text: block.text, citation: this.evidence(version, block) }); if (hits.length === limit) break;
      }
    }
    const allowed = await this.operating.bridge.store.transact(actor.tenantId, tx => hits.filter(hit => { try { const version = this.require(tx, hit.reference); this.assertUsable(tx, version); this.assertRead(tx, actor, version); return true; } catch (error) { if (error instanceof EnterpriseError && error.status < 500) return false; throw error; } }));
    return { hits: allowed };
  }
  async cite(actor: EnterpriseActor, input: EvidenceRef): Promise<EnterpriseContractTypes['EnterpriseKnowledgeCitation']> {
    parseEnterpriseContract('EvidenceRef', input);
    if (actor.tenantId !== input.tenantId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
    const version = await this.operating.bridge.store.transact(actor.tenantId, tx => {
      const value = tx.listProjections<KnowledgeVersion>(KNOWLEDGE_VERSION).find(v => v.protectedPayloadRef === input.protectedContentRef && v.workspaceId === input.workspaceId);
      if (!value) throw new EnterpriseError('CITATION_INVALID', 400); this.assertRead(tx, actor, value); return value;
    });
    const material = await this.get(actor, version.reference), block = material.extraction.blocks.find(b => this.evidence(version, b).id === input.id);
    if (!block || sha256(this.evidence(version, block)) !== sha256(input)) throw new EnterpriseError('CITATION_INVALID', 400);
    return { reference: version.reference, title: version.title, text: block.text, citation: input };
  }
  async controlState(actor: EnterpriseActor, workspaceId: string, documentId: string): Promise<{ documentId: string; streamVersion: number; status: 'active' | 'withdrawn' }> {
    return this.operating.bridge.store.transact(actor.tenantId, tx => { this.operating.actor(tx, actor, workspaceId); const control = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(workspaceId, documentId));
      if (!control || control.ownerPrincipalId !== actor.principalId) throw new EnterpriseError('KNOWLEDGE_NOT_FOUND', 404); return { documentId, streamVersion: control.streamVersion, status: control.status }; });
  }
  async share(actor: EnterpriseActor, reference: BusinessObjectRef, expected: number, enabled: boolean, key: string): Promise<{ documentId: string; streamVersion: number; shared: boolean }> {
    if (!key.trim() || key.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const version = this.require(tx, reference), control = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(version.workspaceId, version.documentId))!;
      if (version.ownerPrincipalId !== actor.principalId) throw new EnterpriseError('KNOWLEDGE_CONTROL_DENIED');
      const check = () => { this.operating.actor(tx, actor, version.workspaceId); if (enabled) this.assertRead(tx, actor, version); }; check(); tx.beforeCommit!(check);
      const id = sha256([actor.principalId, version.workspaceId, key]), digest = sha256(['share', reference, expected, enabled]), previous = tx.getProjection<{ requestDigest: string }>('enterprise-knowledge.command', id);
      if (previous) { if (previous.requestDigest !== digest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return { documentId: version.documentId, streamVersion: control.streamVersion, shared: control.sharedVersions?.includes(version.id) ?? false }; }
      if (control.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      const versions = new Set(control.sharedVersions ?? []); if (enabled) versions.add(version.id); else versions.delete(version.id);
      this.operating.record(tx, KNOWLEDGE_DOCUMENT, { ...control, streamVersion: expected + 1, sharedVersions: [...versions] }, actor.principalId, 'knowledge.sharing_changed');
      this.operating.record(tx, 'enterprise-knowledge.command', { id, tenantId: actor.tenantId, workspaceId: version.workspaceId, streamVersion: 1, requestDigest: digest }, actor.principalId, 'knowledge.command_recorded');
      return { documentId: version.documentId, streamVersion: expected + 1, shared: enabled };
    });
  }
  async exportDocument(actor: EnterpriseActor, reference: BusinessObjectRef, format: 'docx' | 'pdf' | 'xlsx'): Promise<{ bytesBase64: string; mediaType: string; reference: BusinessObjectRef }> {
    const material = await this.get(actor, reference);
    const accepted = await this.operating.bridge.store.transact(actor.tenantId, tx => tx.listProjections<{ status: string; reference: BusinessObjectRef }>('enterprise-artifact.version').some(a => a.status === 'accepted' && sha256(a.reference) === sha256(reference)));
    const rendered = await renderGoalExport(format, { title: material.title, text: material.extraction.blocks.map(block => block.text).join('\n\n'), sourceLabel: `资料版本 ${material.revision}；提取状态 ${material.extraction.status}`, accepted, createdAt: material.createdAt });
    await this.operating.bridge.store.transact(actor.tenantId, tx => { const check = () => this.assertRead(tx, actor, this.require(tx, reference)); check(); tx.beforeCommit!(check); });
    return { bytesBase64: Buffer.from(rendered.bytes).toString('base64'), mediaType: rendered.mediaType, reference };
  }
  async withdraw(actor: EnterpriseActor, workspaceId: string, documentId: string, expected: number, key: string): Promise<{ documentId: string; streamVersion: number; status: 'withdrawn' }> {
    if (!key.trim() || key.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const check = () => { this.operating.actor(tx, actor, workspaceId); }; check(); tx.beforeCommit!(check);
      const control = tx.getProjection<DocumentControl>(KNOWLEDGE_DOCUMENT, documentKey(workspaceId, documentId));
      if (!control || control.ownerPrincipalId !== actor.principalId) throw new EnterpriseError('KNOWLEDGE_NOT_FOUND', 404);
      const requestId = sha256([actor.principalId, workspaceId, key]), requestDigest = sha256(['withdraw', documentId, expected]);
      const prior = tx.getProjection<{ requestDigest: string }>('enterprise-knowledge.command', requestId);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return { documentId, streamVersion: control.streamVersion, status: 'withdrawn' }; }
      if (control.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      this.operating.record(tx, KNOWLEDGE_DOCUMENT, { ...control, streamVersion: expected + 1, status: 'withdrawn' }, actor.principalId, 'knowledge.source_withdrawn');
      this.operating.record(tx, 'enterprise-knowledge.command', { id: requestId, tenantId: actor.tenantId, workspaceId, streamVersion: 1, requestDigest }, actor.principalId, 'knowledge.command_recorded');
      return { documentId, streamVersion: expected + 1, status: 'withdrawn' };
    });
  }
}
