// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, ENTERPRISE_OBJECT_TYPES, type JsonObject } from '@mn/contracts';
import { EnterpriseError, opaqueHash, reduceIdentityEvents, requireActor, type EnterpriseActor, type IdentityState } from './identity.js';
import type { EnterpriseRecord, EnterpriseRepository } from './repository.js';
export const BUSINESS_ROLES = ['sales', 'sales_manager', 'project_owner', 'finance', 'auditor'] as const;
export type BusinessRole = typeof BUSINESS_ROLES[number];
export type FieldClass = 'public' | 'price' | 'cost' | 'contact';
export type ObjectOperation = 'read' | 'draft' | 'write' | 'business_approve' | 'execution_approve' | 'audit';
export type AccessScope = { readonly kind: 'owned' } | { readonly kind: 'workspace' } | { readonly kind: 'department'; readonly departmentId: string }
  | { readonly kind: 'objects'; readonly objects: readonly { readonly objectType: string; readonly objectId: string }[] };
export interface ObjectAccessDescriptor {
  readonly tenantId: string; readonly workspaceId: string; readonly objectType: string; readonly objectId: string;
  readonly ownerPrincipalId?: string; readonly departmentId?: string; readonly projectId?: string; readonly orderId?: string;
  readonly fieldClasses: Readonly<Record<string, FieldClass>>;
  /** Supplied by the domain command definition, never by the requesting model. */
  readonly approvalFields?: readonly string[];
}
interface AccessEntity { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly revokedAt?: string; }
export interface Department extends AccessEntity { readonly name: string; readonly parentId?: string; }
export interface BusinessRoleAssignment extends AccessEntity {
  readonly principalId: string; readonly role: BusinessRole; readonly scope: AccessScope;
  readonly operations: readonly ObjectOperation[]; readonly fieldClasses: readonly FieldClass[]; readonly expiresAt: string;
}
export interface BusinessObjectGrant extends AccessEntity {
  readonly principalId: string; readonly objectType: string; readonly objectId: string;
  readonly operations: readonly ObjectOperation[]; readonly fieldClasses: readonly FieldClass[]; readonly expiresAt: string;
}
interface AccessState { identity: IdentityState; departments: Map<string, Department>; roles: Map<string, BusinessRoleAssignment>;
  grants: Map<string, BusinessObjectGrant>; receipts: Map<string, { requestDigest: string; response: unknown }>; }
const READ: readonly ObjectOperation[] = ['read'];
const WRITE: readonly ObjectOperation[] = ['read', 'draft', 'write'];
const APPROVE: readonly ObjectOperation[] = [...WRITE, 'business_approve', 'execution_approve'];
const EVIDENCE = ['artifact_version', 'evidence_ref', 'decision_record', 'business_review'];
function roleOperations(role: BusinessRole, type: string): readonly ObjectOperation[] {
  if (role === 'auditor') return EVIDENCE.includes(type) ? ['read', 'audit'] : [];
  if (role === 'sales' || role === 'sales_manager') {
    if (type === 'service_version') return role === 'sales_manager' ? WRITE : READ;
    if (['customer', 'contact', 'opportunity'].includes(type)) return [...WRITE, 'execution_approve'];
    if (['quote_version', 'contract', 'order'].includes(type)) return role === 'sales_manager' ? APPROVE : WRITE;
    if (['service_version', 'payment_schedule', 'receipt', 'refund', ...EVIDENCE].includes(type)) return READ;
  }
  if (role === 'project_owner') {
    if (['project', 'milestone', 'delivery_version', 'change_request'].includes(type)) return WRITE;
    if (type === 'customer_acceptance') return APPROVE;
    if (['order', ...EVIDENCE].includes(type)) return READ;
  }
  if (role === 'finance') {
    if (['receipt', 'refund', 'adjustment'].includes(type)) return APPROVE;
    if (['payment_schedule', 'expense'].includes(type)) return WRITE;
    if (['order', 'contract', 'operating_objective', 'metric_definition', ...EVIDENCE].includes(type)) return READ;
  }
  return [];
}
export function reduceAccessEvents(records: readonly EnterpriseRecord[]): AccessState {
  const state: AccessState = { identity: reduceIdentityEvents(records), departments: new Map(), roles: new Map(), grants: new Map(), receipts: new Map() };
  for (const event of records) {
    if (event.type === 'enterprise.department.created') state.departments.set(event.aggregateId, event.payload.value as unknown as Department);
    if (event.type === 'enterprise.role.granted') state.roles.set(event.aggregateId, event.payload.value as unknown as BusinessRoleAssignment);
    if (event.type === 'enterprise.object_grant.created') state.grants.set(event.aggregateId, event.payload.value as unknown as BusinessObjectGrant);
    if (event.type === 'enterprise.role.revoked' || event.type === 'enterprise.object_grant.revoked') {
      const collection = event.type === 'enterprise.role.revoked' ? state.roles : state.grants;
      const current = collection.get(event.aggregateId);
      if (!current || current.streamVersion !== event.expectedStreamVersion) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
      collection.set(event.aggregateId, { ...current, revokedAt: event.occurredAt, streamVersion: current.streamVersion + 1 } as BusinessRoleAssignment & BusinessObjectGrant);
    }
    if (event.type === 'enterprise.permissions.command_recorded') state.receipts.set(event.aggregateId, event.payload as unknown as { requestDigest: string; response: unknown });
  }
  return state;
}
const fieldClasses: readonly FieldClass[] = ['public', 'price', 'cost', 'contact'];
const operations: readonly ObjectOperation[] = ['read', 'draft', 'write', 'business_approve', 'execution_approve', 'audit'];
const objectTypes = new Set<string>(ENTERPRISE_OBJECT_TYPES);
function text(value: string): void { if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new EnterpriseError('INVALID_BODY', 400); }
function grantShape(value: { id: string; principalId: string; operations: readonly ObjectOperation[]; fieldClasses: readonly FieldClass[]; expiresAt: string }, now: string): void {
  text(value.id); text(value.principalId);
  if (!value.operations.length || value.operations.some(item => !operations.includes(item)) || new Set(value.operations).size !== value.operations.length
    || !value.fieldClasses.length || value.fieldClasses.some(item => !fieldClasses.includes(item)) || new Set(value.fieldClasses).size !== value.fieldClasses.length
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.parse(now)) throw new EnterpriseError('INVALID_ACCESS_GRANT', 400);
}
function withinDepartment(state: AccessState, candidate: string | undefined, parent: string): boolean {
  const visited = new Set<string>(); let id = candidate;
  while (id) {
    if (visited.has(id)) return false; visited.add(id);
    const department = state.departments.get(id);
    if (!department || department.revokedAt) return false;
    if (id === parent) return true; id = department.parentId;
  }
  return false;
}
function matchesScope(state: AccessState, scope: AccessScope, object: ObjectAccessDescriptor, principalId: string): boolean {
  if (scope.kind === 'workspace') return true;
  if (scope.kind === 'owned') return object.ownerPrincipalId === principalId;
  if (scope.kind === 'department') return withinDepartment(state, object.departmentId, scope.departmentId);
  return scope.objects.some(ref => (ref.objectType === object.objectType && ref.objectId === object.objectId)
    || (ref.objectType === 'project' && ref.objectId === object.projectId) || (ref.objectType === 'order' && ref.objectId === object.orderId));
}
export function resolveObjectAccess(records: readonly EnterpriseRecord[], actor: EnterpriseActor, object: ObjectAccessDescriptor,
  operation: ObjectOperation, now: string): ReadonlySet<FieldClass> {
  if (actor.tenantId !== object.tenantId || !objectTypes.has(object.objectType)) throw new EnterpriseError('OBJECT_ACCESS_DENIED');
  const state = reduceAccessEvents(records); requireActor(state.identity, actor, false, now);
  if (!state.identity.workspaces.has(object.workspaceId)) throw new EnterpriseError('OBJECT_ACCESS_DENIED');
  const fields = new Set<FieldClass>(); let allowed = false;
  const shares = [...state.grants.values()].filter(grant => grant.principalId === actor.principalId && grant.workspaceId === object.workspaceId
    && !grant.revokedAt && Date.parse(grant.expiresAt) > Date.parse(now) && grant.objectType === object.objectType && grant.objectId === object.objectId && grant.operations.includes(operation));
  for (const role of state.roles.values()) {
    if (role.principalId !== actor.principalId || role.workspaceId !== object.workspaceId || role.revokedAt || Date.parse(role.expiresAt) <= Date.parse(now)
      || !role.operations.includes(operation) || !roleOperations(role.role, object.objectType).includes(operation)) continue;
    if (matchesScope(state, role.scope, object, actor.principalId)) { allowed = true; role.fieldClasses.forEach(field => fields.add(field)); }
    else for (const grant of shares) { allowed = true; role.fieldClasses.filter(field => grant.fieldClasses.includes(field)).forEach(field => fields.add(field)); }
  }
  if (!allowed) throw new EnterpriseError('OBJECT_ACCESS_DENIED');
  return fields;
}
export function assertBusinessDecisionAccess(records: readonly EnterpriseRecord[], actor: EnterpriseActor, object: ObjectAccessDescriptor,
  preparedByPrincipalId: string, now: string): void {
  const fields = resolveObjectAccess(records, actor, object, 'business_approve', now);
  if (!object.approvalFields?.length) throw new EnterpriseError('APPROVAL_FIELDS_REQUIRED', 503);
  const readable = resolveObjectAccess(records, actor, object, 'read', now);
  if (object.approvalFields.some(field => !Object.hasOwn(object.fieldClasses, field) || !fields.has(object.fieldClasses[field]!) || !readable.has(object.fieldClasses[field]!))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
  if (!preparedByPrincipalId || actor.principalId === preparedByPrincipalId) throw new EnterpriseError('SEPARATION_OF_DUTIES_REQUIRED');
}
export class EnterprisePermissionService {
  private readonly now: () => string;
  constructor(readonly options: { repository: EnterpriseRepository; now?: () => string }) { this.now = options.now ?? (() => new Date().toISOString()); }
  private event(type: string, namespace: string, id: string, version: number, actorId: string, payload: unknown): EnterpriseRecord {
    return { type, aggregateType: namespace, aggregateId: id, expectedStreamVersion: version, actorId, occurredAt: this.now(), payload: JSON.parse(JSON.stringify(payload)) as JsonObject };
  }
  private async command<T>(actor: EnterpriseActor, key: string, kind: string, body: unknown, work: (state: AccessState) => { events: readonly EnterpriseRecord[]; value: T }): Promise<T> {
    text(key); const id = opaqueHash(canonicalJson([actor.principalId, key])), requestDigest = opaqueHash(canonicalJson([kind, body]));
    return this.options.repository.transact(actor.tenantId, records => {
      const state = reduceAccessEvents(records), member = requireActor(state.identity, actor, false, this.now());
      if (!member.organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
      const prior = state.receipts.get(id);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return { events: [], value: prior.response as T }; }
      const result = work(state);
      return { events: [...result.events, this.event('enterprise.permissions.command_recorded', 'enterprise.permissions.command', id, 0, actor.principalId,
        { requestDigest, response: result.value })], value: result.value, assertBeforeCommit: () => {
          if (!requireActor(state.identity, actor, false, this.now()).organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
        } };
    });
  }
  private workspace(state: AccessState, id: string): void { if (!state.identity.workspaces.has(id)) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404); }
  private targetMember(state: AccessState, principalId: string): void {
    const member = state.identity.members.get(principalId); if (!member || member.status === 'removed') throw new EnterpriseError('MEMBER_UNAVAILABLE');
  }
  async createDepartment(actor: EnterpriseActor, key: string, input: { workspaceId: string; name: string; parentId?: string }): Promise<Department> {
    text(input.name); const id = opaqueHash(canonicalJson(['department', actor.principalId, key]));
    return this.command(actor, key, 'department', input, state => {
      this.workspace(state, input.workspaceId);
      if (input.parentId && state.departments.get(input.parentId)?.workspaceId !== input.workspaceId) throw new EnterpriseError('DEPARTMENT_NOT_FOUND', 404);
      const department: Department = { ...input, id, tenantId: actor.tenantId, streamVersion: 1 };
      return { events: [this.event('enterprise.department.created', 'enterprise.department', id, 0, actor.principalId, { value: department })], value: department };
    });
  }
  async grantRole(actor: EnterpriseActor, key: string, input: Omit<BusinessRoleAssignment, 'tenantId' | 'streamVersion' | 'revokedAt'>): Promise<BusinessRoleAssignment> {
    grantShape(input, this.now());
    if (!BUSINESS_ROLES.includes(input.role) || !['owned', 'workspace', 'department', 'objects'].includes(input.scope.kind)) throw new EnterpriseError('INVALID_ACCESS_GRANT', 400);
    return this.command(actor, key, 'role', input, state => {
      this.workspace(state, input.workspaceId); this.targetMember(state, input.principalId);
      if (state.roles.has(input.id)) throw new EnterpriseError('ROLE_ASSIGNMENT_EXISTS', 409);
      if (input.scope.kind === 'department' && state.departments.get(input.scope.departmentId)?.workspaceId !== input.workspaceId) throw new EnterpriseError('DEPARTMENT_NOT_FOUND', 404);
      if (input.scope.kind === 'objects' && (!input.scope.objects.length || input.scope.objects.some(ref => !objectTypes.has(ref.objectType) || !ref.objectId))) throw new EnterpriseError('INVALID_ACCESS_GRANT', 400);
      const assignment: BusinessRoleAssignment = { ...structuredClone(input), tenantId: actor.tenantId, streamVersion: 1 };
      return { events: [this.event('enterprise.role.granted', 'enterprise.role', input.id, 0, actor.principalId, { value: assignment })], value: assignment };
    });
  }
  async grantObject(actor: EnterpriseActor, key: string, input: Omit<BusinessObjectGrant, 'tenantId' | 'streamVersion' | 'revokedAt'>): Promise<BusinessObjectGrant> {
    grantShape(input, this.now()); text(input.objectId); if (!objectTypes.has(input.objectType)) throw new EnterpriseError('INVALID_ACCESS_GRANT', 400);
    return this.command(actor, key, 'object', input, state => {
      this.workspace(state, input.workspaceId); this.targetMember(state, input.principalId);
      if (state.grants.has(input.id)) throw new EnterpriseError('OBJECT_GRANT_EXISTS', 409);
      const grant: BusinessObjectGrant = { ...structuredClone(input), tenantId: actor.tenantId, streamVersion: 1 };
      return { events: [this.event('enterprise.object_grant.created', 'enterprise.object_grant', input.id, 0, actor.principalId, { value: grant })], value: grant };
    });
  }
  async revoke(actor: EnterpriseActor, key: string, kind: 'role' | 'object', id: string, expectedStreamVersion: number, workspaceId?: string): Promise<BusinessRoleAssignment | BusinessObjectGrant> {
    return this.command(actor, key, 'revoke', { kind, id, expectedStreamVersion, workspaceId }, state => {
      const value = (kind === 'role' ? state.roles : state.grants).get(id);
      if (!value || (workspaceId !== undefined && value.workspaceId !== workspaceId)) throw new EnterpriseError('ACCESS_GRANT_NOT_FOUND', 404);
      if (value.streamVersion !== expectedStreamVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      if (value.revokedAt) throw new EnterpriseError('ACCESS_GRANT_REVOKED', 409);
      const namespace = kind === 'role' ? 'enterprise.role' : 'enterprise.object_grant';
      return { events: [this.event(`${namespace}.revoked`, namespace, id, expectedStreamVersion, actor.principalId, {})],
        value: { ...value, revokedAt: this.now(), streamVersion: value.streamVersion + 1 } };
    });
  }
  async assertAccess(actor: EnterpriseActor, object: ObjectAccessDescriptor, operation: ObjectOperation, fields: readonly string[] = []): Promise<void> {
    const allowed = resolveObjectAccess(await this.options.repository.read(actor.tenantId), actor, object, operation, this.now());
    if (fields.some(field => !Object.hasOwn(object.fieldClasses, field) || !allowed.has(object.fieldClasses[field]!))) throw new EnterpriseError('FIELD_ACCESS_DENIED');
  }
  async filterFields(actor: EnterpriseActor, object: ObjectAccessDescriptor, value: JsonObject): Promise<JsonObject> {
    const allowed = resolveObjectAccess(await this.options.repository.read(actor.tenantId), actor, object, 'read', this.now());
    return Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(object.fieldClasses, key) && allowed.has(object.fieldClasses[key]!)));
  }
  async assertBusinessDecision(actor: EnterpriseActor, object: ObjectAccessDescriptor, preparedByPrincipalId: string): Promise<void> {
    assertBusinessDecisionAccess(await this.options.repository.read(actor.tenantId), actor, object, preparedByPrincipalId, this.now());
  }
  async configuration(actor: EnterpriseActor, workspaceId: string) {
    const state = reduceAccessEvents(await this.options.repository.read(actor.tenantId));
    if (!requireActor(state.identity, actor, false, this.now()).organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
    this.workspace(state, workspaceId);
    return { departments: [...state.departments.values()].filter(value => value.workspaceId === workspaceId),
      roles: [...state.roles.values()].filter(value => value.workspaceId === workspaceId), grants: [...state.grants.values()].filter(value => value.workspaceId === workspaceId) };
  }
}
