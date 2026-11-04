// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { canonicalJson, parseEnterpriseContract, type BusinessObjectRef, type EvidenceRef, type EnterpriseContractTypes, type JsonObject } from '@mn/contracts';
import { BUSINESS_FIELD_CLASSES, BusinessDomainError, businessDigest, businessObjectKey, decideBusinessCommand, reduceBusinessEvents,
  type BusinessCommand, type BusinessCommandContext, type BusinessEvent, type BusinessObject, type BusinessObjectType, type BusinessState } from '@mn/plugin-business';
import { EnterpriseError, opaqueHash, reduceAccessEvents, reduceIdentityEvents, requireActor, resolveObjectAccess, assertBusinessDecisionAccess,
  type EnterpriseActor, type EnterpriseRecord, type EnterpriseRepository, type FieldClass, type ObjectAccessDescriptor } from '@mn/enterprise-services';
type ObjectView = EnterpriseContractTypes['EnterpriseBusinessObjectView'];
type EvidenceInput = EnterpriseContractTypes['EnterpriseBusinessEvidenceCreate'];
type StoredEvidence = EnterpriseContractTypes['EnterpriseBusinessEvidenceView'] & { readonly withdrawnAt?: string };
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const key = (workspaceId: string, id: string) => canonicalJson([workspaceId, id]);
function facts(records: readonly EnterpriseRecord[], tenantId: string, workspaceId: string): BusinessEvent[] {
  return records.filter(record => record.type.startsWith('enterprise.business.') && record.payload.fact).flatMap(record => {
    const fact = record.payload.fact as unknown as BusinessEvent;
    if (fact.tenantId !== tenantId || record.type !== `enterprise.business.${fact.type}` || record.aggregateType !== `enterprise.business.${fact.objectType}`
      || record.aggregateId !== key(fact.workspaceId, fact.objectId) || record.actorId !== fact.actorId || record.expectedStreamVersion !== fact.expectedStreamVersion)
      throw new EnterpriseError('BUSINESS_EVENT_HISTORY_INVALID', 503);
    return fact.workspaceId === workspaceId ? [fact] : [];
  });
}
function descriptor(object: BusinessObject): ObjectAccessDescriptor {
  const fieldClasses = BUSINESS_FIELD_CLASSES[object.reference.objectType as BusinessObjectType];
  if (!fieldClasses) throw new EnterpriseError('BUSINESS_OBJECT_TYPE_UNSUPPORTED', 404);
  return { ...object.reference, fieldClasses,
    ...(typeof object.value.ownerPrincipalId === 'string' ? { ownerPrincipalId: object.value.ownerPrincipalId } : {}),
    ...(typeof object.value.departmentId === 'string' ? { departmentId: object.value.departmentId } : {}),
    ...(object.reference.objectType === 'order' ? { orderId: object.reference.objectId } : {}),
  };
}
function evidenceRecords(records: readonly EnterpriseRecord[], workspaceId: string): Map<string, StoredEvidence> {
  const result = new Map<string, StoredEvidence>();
  for (const record of records) {
    if (record.type === 'enterprise.business_evidence.recorded') {
      const value = record.payload.value as unknown as StoredEvidence;
      if (value.reference.workspaceId === workspaceId) result.set(value.reference.id, value);
    } else if (record.type === 'enterprise.business_evidence.withdrawn') {
      const id = String(record.payload.id), current = result.get(id);
      if (!current) continue;
      if (current.streamVersion !== record.expectedStreamVersion) throw new EnterpriseError('BUSINESS_EVENT_HISTORY_INVALID', 503);
      result.set(id, { ...current, streamVersion: current.streamVersion + 1, withdrawnAt: record.occurredAt });
    }
  }
  return result;
}
export class EnterpriseBusinessService {
  private readonly now: () => string;
  constructor(readonly options: { repository: EnterpriseRepository; now?: () => string }) { this.now = options.now ?? (() => new Date().toISOString()); }
  private bound(records: readonly EnterpriseRecord[], actor: EnterpriseActor, workspaceId: string): void {
    const identity = reduceIdentityEvents(records); requireActor(identity, actor, false, this.now());
    const workspace = identity.workspaces.get(workspaceId);
    if (!workspace) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404);
    if (workspace.mode !== 'builtin') throw new EnterpriseError('PROVIDER_NOT_RESPONSIBLE', 409);
  }
  private object(state: BusinessState, type: string, id: string): BusinessObject {
    const object = state.objects.get(businessObjectKey(type, id));
    if (!object) throw new EnterpriseError('OBJECT_NOT_FOUND', 404); return object;
  }
  private allow(records: readonly EnterpriseRecord[], actor: EnterpriseActor, object: BusinessObject, operation: 'read' | 'write' | 'business_approve', fields: readonly string[], preparedBy?: string): void {
    const desc = descriptor(object), now = this.now();
    const classes = resolveObjectAccess(records, actor, desc, operation, now);
    if (fields.some(field => !Object.hasOwn(desc.fieldClasses, field) || !classes.has(desc.fieldClasses[field]!))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
    if (operation === 'business_approve') {
      const readable = resolveObjectAccess(records, actor, desc, 'read', now);
      if (fields.some(field => !readable.has(desc.fieldClasses[field]!))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
      if (preparedBy) assertBusinessDecisionAccess(records, actor, { ...desc, approvalFields: fields }, preparedBy, now);
    }
    if (desc.departmentId) {
      const department = reduceAccessEvents(records).departments.get(desc.departmentId);
      if (!department || department.workspaceId !== desc.workspaceId || department.revokedAt) throw new EnterpriseError('DEPARTMENT_NOT_FOUND', 404);
    }
  }
  private view(records: readonly EnterpriseRecord[], actor: EnterpriseActor, current: BusinessObject, value = current): ObjectView {
    const classes = resolveObjectAccess(records, actor, descriptor(current), 'read', this.now()), fields = descriptor(value).fieldClasses;
    return { reference: value.reference, values: Object.fromEntries(Object.entries(value.value).filter(([field]) => Object.hasOwn(fields, field) && classes.has(fields[field]!))) };
  }
  private historical(events: readonly BusinessEvent[], reference: BusinessObjectRef): BusinessObject {
    const history = events.filter(event => event.objectType === reference.objectType && event.objectId === reference.objectId && event.expectedStreamVersion < reference.streamVersion);
    const object = this.object(reduceBusinessEvents(history), reference.objectType, reference.objectId);
    if (canonicalJson(object.reference) !== canonicalJson(reference)) throw new EnterpriseError('BUSINESS_REFERENCE_INVALID', 503);
    return object;
  }
  private assertEvidence(records: readonly EnterpriseRecord[], actor: EnterpriseActor, state: BusinessState, reference: EvidenceRef, subject: BusinessObjectRef): void {
    const proof = evidenceRecords(records, subject.workspaceId).get(reference.id);
    if (!proof || proof.withdrawnAt || canonicalJson(proof.reference) !== canonicalJson(reference)) throw new EnterpriseError('EVIDENCE_REFERENCE_INVALID', 409);
    if (canonicalJson(proof.subject) !== canonicalJson(subject)) throw new EnterpriseError('EVIDENCE_SUBJECT_MISMATCH', 409);
    const current = this.object(state, subject.objectType, subject.objectId);
    const readable = resolveObjectAccess(records, actor, descriptor(current), 'read', this.now());
    if (proof.requiredClasses.some(field => !readable.has(field))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
  }
  private record(type: string, aggregateType: string, id: string, version: number, actor: EnterpriseActor, payload: unknown): EnterpriseRecord {
    return { type, aggregateType, aggregateId: id, expectedStreamVersion: version, actorId: actor.principalId, occurredAt: this.now(), payload: json(payload) };
  }
  private commandId(actor: EnterpriseActor, workspaceId: string, idempotencyKey: string): string {
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    return opaqueHash(canonicalJson([actor.principalId, workspaceId, idempotencyKey]));
  }
  async execute(input: { actor: EnterpriseActor; actorKind: 'human' | 'agent' | 'service'; workspaceId: string; idempotencyKey: string; command: BusinessCommand }): Promise<ObjectView> {
    const { actor, actorKind, workspaceId } = input;
    const command = parseEnterpriseContract('EnterpriseBusinessCommand', input.command);
    const id = this.commandId(actor, workspaceId, input.idempotencyKey), requestDigest = businessDigest([command, actorKind]), salt = randomBytes(32).toString('hex');
    try {
      const reference = await this.options.repository.transact(actor.tenantId, records => {
        this.bound(records, actor, workspaceId);
        const history = facts(records, actor.tenantId, workspaceId), state = reduceBusinessEvents(history);
        const prior = records.find(record => record.type === 'enterprise.business.command_recorded' && record.aggregateId === id);
        if (prior) {
          if (prior.payload.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
          const ref = prior.payload.reference as unknown as BusinessObjectRef;
          const current = this.object(state, ref.objectType, ref.objectId);
          const formal = ['quote.approve','quote.record_acceptance','contract.activate','order.activate'].includes(command.type);
          this.allow(records, actor, current, formal ? 'business_approve' : 'write', []);
          return { events: [], value: ref };
        }
        const decide = () => {
          const context: BusinessCommandContext = { tenantId: actor.tenantId, workspaceId, actorId: actor.principalId, actorKind, now: this.now(), revisionSalt: salt,
            assertCurrent: requirement => this.allow(records, actor, requirement.object, requirement.operation, requirement.fields, requirement.preparedByPrincipalId),
            assertEvidence: (evidence, subject) => this.assertEvidence(records, actor, state, evidence, subject) };
          return decideBusinessCommand(state, command, context);
        };
        const change = decide(), updated = reduceBusinessEvents([...history, ...change.events]).objects.get(change.primaryObjectKey)!;
        const events = change.events.map(fact => this.record(`enterprise.business.${fact.type}`, `enterprise.business.${fact.objectType}`,
          key(workspaceId, fact.objectId), fact.expectedStreamVersion, actor, { fact }));
        events.push(this.record('enterprise.business.command_recorded', 'enterprise.business.command', id, 0, actor, { requestDigest, reference: updated.reference }));
        return { events, value: updated.reference, assertBeforeCommit: () => { this.bound(records, actor, workspaceId); decide(); } };
      });
      const records = await this.options.repository.read(actor.tenantId); this.bound(records, actor, workspaceId);
      const history = facts(records, actor.tenantId, workspaceId), state = reduceBusinessEvents(history);
      return this.view(records, actor, this.object(state, reference.objectType, reference.objectId), this.historical(history, reference));
    } catch (error) { if (error instanceof BusinessDomainError) throw new EnterpriseError(error.code, error.status); throw error; }
  }
  async get(actor: EnterpriseActor, workspaceId: string, type: string, id: string, version?: number): Promise<ObjectView> {
    const records = await this.options.repository.read(actor.tenantId); this.bound(records, actor, workspaceId);
    const history = facts(records, actor.tenantId, workspaceId), object = this.object(reduceBusinessEvents(history), type, id);
    if (version === undefined) return this.view(records, actor, object);
    if (!Number.isSafeInteger(version) || version < 1 || version > object.reference.streamVersion) throw new EnterpriseError('OBJECT_VERSION_NOT_FOUND', 404);
    const old = this.object(reduceBusinessEvents(history.filter(event => event.objectType === type && event.objectId === id && event.expectedStreamVersion < version)), type, id);
    return this.view(records, actor, object, old);
  }
  async getApproval(actor: EnterpriseActor, workspaceId: string, id: string): Promise<EnterpriseContractTypes['BusinessApproval']> {
    const records = await this.options.repository.read(actor.tenantId); this.bound(records, actor, workspaceId);
    const state = reduceBusinessEvents(facts(records, actor.tenantId, workspaceId)), stored = state.approvals.get(id);
    if (!stored) throw new EnterpriseError('BUSINESS_APPROVAL_NOT_FOUND', 404);
    const approval = parseEnterpriseContract('BusinessApproval', stored);
    const subject = this.object(state, approval.subjectRef.objectType, approval.subjectRef.objectId);
    const readable = resolveObjectAccess(records, actor, { ...descriptor(subject), objectType: 'decision_record', objectId: id,
      fieldClasses: Object.fromEntries(Object.keys(approval).map(field => [field, 'public' as const])) }, 'read', this.now());
    if (!readable.has('public')) throw new EnterpriseError('FIELD_ACCESS_DENIED');
    return approval;
  }
  async list(actor: EnterpriseActor, workspaceId: string, type: string): Promise<ObjectView[]> {
    if (!Object.hasOwn(BUSINESS_FIELD_CLASSES, type)) throw new EnterpriseError('BUSINESS_OBJECT_TYPE_UNSUPPORTED', 404);
    const records = await this.options.repository.read(actor.tenantId); this.bound(records, actor, workspaceId);
    const result: ObjectView[] = [];
    for (const object of reduceBusinessEvents(facts(records, actor.tenantId, workspaceId)).objects.values()) {
      if (object.reference.objectType !== type) continue;
      try { result.push(this.view(records, actor, object)); }
      catch (error) { if (!(error instanceof EnterpriseError) || error.code !== 'OBJECT_ACCESS_DENIED') throw error; }
    }
    return result.sort((a, b) => a.reference.objectId.localeCompare(b.reference.objectId));
  }
  async recordEvidence(input: EvidenceInput & { actor: EnterpriseActor; actorKind: 'human' | 'agent' | 'service'; workspaceId: string; idempotencyKey: string }): Promise<EvidenceRef> {
    const { actor, workspaceId } = input;
    if (input.actorKind !== 'human') throw new EnterpriseError('HUMAN_CONFIRMATION_REQUIRED');
    const parsed = parseEnterpriseContract('EnterpriseBusinessEvidenceCreate', { subject: input.subject, attestation: input.attestation, additionalFieldClasses: input.additionalFieldClasses });
    const id = this.commandId(actor, workspaceId, input.idempotencyKey), requestDigest = businessDigest(parsed), salt = randomBytes(32).toString('hex');
    return this.options.repository.transact(actor.tenantId, records => {
      this.bound(records, actor, workspaceId);
      const state = reduceBusinessEvents(facts(records, actor.tenantId, workspaceId));
      const subject = this.object(state, parsed.subject.objectType, parsed.subject.objectId);
      const validate = (replay?: StoredEvidence) => {
        this.allow(records, actor, subject, 'write', []);
        if (!replay && canonicalJson(subject.reference) !== canonicalJson(parsed.subject)) throw new EnterpriseError('SOURCE_VERSION_CONFLICT', 409);
        const classes = resolveObjectAccess(records, actor, descriptor(subject), 'read', this.now());
        const required = replay?.requiredClasses ?? [...new Set([...Object.entries(descriptor(subject).fieldClasses).filter(([field]) => Object.hasOwn(subject.value, field)).map(([, classification]) => classification), ...parsed.additionalFieldClasses])];
        if (required.some(field => !classes.has(field))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
        return required;
      };
      const existing = records.find(record => record.type === 'enterprise.business_evidence.recorded' && record.aggregateId === key(workspaceId, id));
      if (existing) {
        if (existing.payload.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
        const current = evidenceRecords(records, workspaceId).get(id)!;
        if (current.withdrawnAt) throw new EnterpriseError('EVIDENCE_WITHDRAWN', 409);
        validate(current);
        return { events: [], value: current.reference };
      }
      const requiredClasses = validate();
      const reference: EvidenceRef = { tenantId: actor.tenantId, workspaceId, id, sourceKind: 'human_decision', sourceVersion: '1',
        digest: businessDigest([parsed, actor.principalId, salt]), permissionRef: `business-evidence:${id}`, protectedContentRef: `enterprise-evidence:${id}`, locator: { paragraph: 'attestation' } };
      const value: StoredEvidence = { reference, subject: parsed.subject, attestation: parsed.attestation, requiredClasses, recordedBy: actor.principalId, recordedAt: this.now(), streamVersion: 1 };
      return { events: [this.record('enterprise.business_evidence.recorded', 'enterprise.business_evidence', key(workspaceId, id), 0, actor,
        { value, requestDigest, revisionSalt: salt })], value: reference, assertBeforeCommit: () => { validate(); } };
    });
  }
  async getEvidence(actor: EnterpriseActor, workspaceId: string, id: string): Promise<EnterpriseContractTypes['EnterpriseBusinessEvidenceView']> {
    const records = await this.options.repository.read(actor.tenantId); this.bound(records, actor, workspaceId);
    const proof = evidenceRecords(records, workspaceId).get(id);
    if (!proof || proof.withdrawnAt) throw new EnterpriseError('EVIDENCE_NOT_FOUND', 404);
    const state = reduceBusinessEvents(facts(records, actor.tenantId, workspaceId)), subject = this.object(state, proof.subject.objectType, proof.subject.objectId);
    const classes = resolveObjectAccess(records, actor, descriptor(subject), 'read', this.now());
    if (proof.requiredClasses.some(field => !classes.has(field))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
    return proof;
  }
  async withdrawEvidence(actor: EnterpriseActor, workspaceId: string, id: string, expectedStreamVersion: number, idempotencyKey: string): Promise<{ id: string; streamVersion: number }> {
    const commandId = this.commandId(actor, workspaceId, idempotencyKey), requestDigest = businessDigest([id, expectedStreamVersion]);
    return this.options.repository.transact(actor.tenantId, records => {
      this.bound(records, actor, workspaceId);
      const proof = evidenceRecords(records, workspaceId).get(id);
      if (!proof) throw new EnterpriseError('EVIDENCE_NOT_FOUND', 404);
      const subject = this.object(reduceBusinessEvents(facts(records, actor.tenantId, workspaceId)), proof.subject.objectType, proof.subject.objectId);
      const validate = () => { this.allow(records, actor, subject, 'write', []); };
      validate();
      const prior = records.find(record => record.type === 'enterprise.business_evidence.withdrawal_recorded' && record.aggregateId === commandId);
      if (prior) { if (prior.payload.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return { events: [], value: prior.payload.result as unknown as { id: string; streamVersion: number } }; }
      if (proof.streamVersion !== expectedStreamVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      if (proof.withdrawnAt) throw new EnterpriseError('EVIDENCE_WITHDRAWN', 409);
      const result = { id, streamVersion: expectedStreamVersion + 1 };
      return { events: [this.record('enterprise.business_evidence.withdrawn', 'enterprise.business_evidence', key(workspaceId, id), expectedStreamVersion, actor, { id }),
        this.record('enterprise.business_evidence.withdrawal_recorded', 'enterprise.business_evidence.command', commandId, 0, actor, { requestDigest, result })], value: result, assertBeforeCommit: validate };
    });
  }
}
