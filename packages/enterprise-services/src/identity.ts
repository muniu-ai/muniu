// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson, type JsonObject } from '@mn/contracts';
import type { EnterpriseRecord, EnterpriseRepository } from './repository.js';
export class EnterpriseError extends Error {
  constructor(readonly code: string, readonly status = 403) { super(code); this.name = 'EnterpriseError'; }
}
export interface EnterpriseActor { readonly tenantId: string; readonly principalId: string; readonly sessionEpoch: number; readonly sessionId?: string; }
export interface Organization { readonly id: string; readonly name: string; readonly issuer: string; readonly maxMembers: number; readonly streamVersion: number; }
export interface OrganizationMember {
  readonly id: string; readonly tenantId: string; readonly issuer: string; readonly subject: string; readonly displayName: string;
  readonly organizationAdmin: boolean; readonly status: 'invited' | 'active' | 'disabled' | 'removed';
  readonly streamVersion: number; readonly sessionEpoch: number; readonly invitedUntil?: string; readonly invitationHash?: string;
}
export interface EnterpriseWorkspace { readonly id: string; readonly tenantId: string; readonly name: string; readonly mode: 'builtin' | 'sales'; readonly streamVersion: number; }
interface Receipt { readonly requestDigest: string; readonly response: unknown; }
export interface IdentityState {
  organization?: Organization;
  readonly sessions: Map<string, { principalId: string; sessionEpoch: number; expiresAt: string; revoked: boolean }>;
  readonly members: Map<string, OrganizationMember>;
  readonly workspaces: Map<string, EnterpriseWorkspace>;
  readonly receipts: Map<string, Receipt>;
}
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export const opaqueHash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => opaqueHash(canonicalJson(value));
function text(value: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new EnterpriseError('INVALID_BODY', 400);
  return value;
}
function requireVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || actual !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
}
export function reduceIdentityEvents(events: readonly EnterpriseRecord[]): IdentityState {
  const state: IdentityState = { sessions: new Map(), members: new Map(), workspaces: new Map(), receipts: new Map() };
  for (const e of events) {
    if (e.type === 'enterprise.auth.session_created') state.sessions.set(e.aggregateId, e.payload.session as unknown as { principalId: string; sessionEpoch: number; expiresAt: string; revoked: boolean });
    else if (e.type === 'enterprise.auth.session_revoked') {
      const session = state.sessions.get(e.aggregateId); if (!session) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
      state.sessions.set(e.aggregateId, { ...session, revoked: true });
    }
    else if (e.type === 'enterprise.organization.provisioned') state.organization = e.payload.organization as unknown as Organization;
    else if (e.type === 'enterprise.member.created' || e.type === 'enterprise.member.invited') state.members.set(e.aggregateId, e.payload.member as unknown as OrganizationMember);
    else if (e.type === 'enterprise.member.invitation_accepted') {
      const current = state.members.get(e.aggregateId);
      if (!current || current.streamVersion !== e.expectedStreamVersion) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
      const { invitationHash: _hash, invitedUntil: _until, ...member } = current;
      state.members.set(e.aggregateId, { ...member, status: 'active', streamVersion: e.expectedStreamVersion + 1 });
    } else if (e.type === 'enterprise.member.status_changed' || e.type === 'enterprise.member.identity_rebound') {
      const current = state.members.get(e.aggregateId);
      if (!current || current.streamVersion !== e.expectedStreamVersion) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
      state.members.set(e.aggregateId, { ...current, ...(e.payload.status ? { status: e.payload.status as OrganizationMember['status'] } : {}),
        ...(e.payload.subject ? { subject: String(e.payload.subject) } : {}), streamVersion: e.expectedStreamVersion + 1, sessionEpoch: current.sessionEpoch + 1 });
    } else if (e.type === 'enterprise.workspace.created') state.workspaces.set(e.aggregateId, e.payload.workspace as unknown as EnterpriseWorkspace);
    else if (e.type === 'enterprise.identity.command_recorded') state.receipts.set(e.aggregateId, e.payload as unknown as Receipt);
  }
  return state;
}
export function requireActor(state: IdentityState, actor: EnterpriseActor, invited = false, now = new Date().toISOString()): OrganizationMember {
  if (!state.organization || state.organization.id !== actor.tenantId) throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
  if (actor.sessionId !== undefined) {
    const session = state.sessions.get(actor.sessionId);
    if (!session || session.revoked || session.principalId !== actor.principalId || session.sessionEpoch !== actor.sessionEpoch
      || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.parse(now)) throw new EnterpriseError('AUTHENTICATION_REQUIRED', 401);
  }
  const member = state.members.get(actor.principalId);
  if (!member || member.tenantId !== actor.tenantId || (member.status !== 'active' && !(invited && member.status === 'invited'))) throw new EnterpriseError('MEMBER_UNAVAILABLE');
  if (member.sessionEpoch !== actor.sessionEpoch) throw new EnterpriseError('SESSION_REVOKED', 401);
  return member;
}
const requireAdmin = (state: IdentityState, actor: EnterpriseActor, now: string) => {
  const member = requireActor(state, actor, false, now);
  if (!member.organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
  return member;
};
export function memberView(member: OrganizationMember): Omit<OrganizationMember, 'invitationHash'> {
  const { invitationHash: _hash, ...value } = member; return value;
}
export class EnterpriseIdentityService {
  private readonly now: () => string;
  constructor(readonly options: { readonly repository: EnterpriseRepository; readonly now?: () => string }) { this.now = options.now ?? (() => new Date().toISOString()); }
  private event(type: string, aggregateType: string, aggregateId: string, expectedStreamVersion: number, actorId: string, payload: unknown): EnterpriseRecord {
    return { type, aggregateType, aggregateId, expectedStreamVersion, actorId, occurredAt: this.now(), payload: json(payload) };
  }
  /** Trusted Host provisioning only; never accepts token-supplied tenant or role claims. */
  async provision(input: { tenantId: string; name: string; issuer: string; administrator: { id: string; subject: string; displayName: string }; maxMembers: number }): Promise<Organization> {
    text(input.tenantId); text(input.name); text(input.issuer); text(input.administrator.id); text(input.administrator.subject); text(input.administrator.displayName);
    if (!Number.isSafeInteger(input.maxMembers) || input.maxMembers < 1) throw new EnterpriseError('INVALID_MEMBER_QUOTA', 400);
    return this.options.repository.transact(input.tenantId, records => {
      const state = reduceIdentityEvents(records);
      if (state.organization) {
        const owner = records.find(record => record.type === 'enterprise.member.created'
          && record.aggregateId === input.administrator.id && record.expectedStreamVersion === 0)?.payload.member as unknown as OrganizationMember | undefined;
        if (state.organization.name !== input.name || state.organization.issuer !== input.issuer || state.organization.maxMembers !== input.maxMembers
          || !owner || owner.subject !== input.administrator.subject) throw new EnterpriseError('PROVISIONING_CONFLICT', 409);
        return { events: [], value: state.organization };
      }
      const organization: Organization = { id: input.tenantId, name: input.name, issuer: input.issuer, maxMembers: input.maxMembers, streamVersion: 1 };
      const member: OrganizationMember = { ...input.administrator, tenantId: input.tenantId, issuer: input.issuer, organizationAdmin: true,
        status: 'active', streamVersion: 1, sessionEpoch: 1 };
      return { events: [this.event('enterprise.organization.provisioned', 'enterprise.organization', input.tenantId, 0, 'platform-operator', { organization }),
        this.event('enterprise.member.created', 'enterprise.member', member.id, 0, 'platform-operator', { member })], value: organization };
    });
  }
  async resolveIdentity(tenantId: string, identity: { issuer: string; subject: string }): Promise<OrganizationMember> {
    const state = reduceIdentityEvents(await this.options.repository.read(tenantId));
    if (!state.organization) throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
    const member = [...state.members.values()].find(m => m.issuer === identity.issuer && m.subject === identity.subject && m.status !== 'removed');
    if (state.organization.issuer !== identity.issuer || !member) throw new EnterpriseError('IDENTITY_NOT_BOUND', 401);
    if (member.status === 'disabled') throw new EnterpriseError('MEMBER_UNAVAILABLE');
    return member;
  }
  async assertActor(actor: EnterpriseActor, invited = false): Promise<OrganizationMember> {
    return requireActor(reduceIdentityEvents(await this.options.repository.read(actor.tenantId)), actor, invited, this.now());
  }
  private async command<T>(actor: EnterpriseActor, key: string, operation: string, input: unknown, authorize: (state: IdentityState) => void,
    work: (state: IdentityState) => { events: readonly EnterpriseRecord[]; value: T }): Promise<T> {
    text(key); const id = digest([actor.principalId, key]); const requestDigest = digest([operation, input]);
    return this.options.repository.transact(actor.tenantId, records => {
      const state = reduceIdentityEvents(records); authorize(state);
      const previous = state.receipts.get(id);
      if (previous) {
        if (previous.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
        return { events: [], value: previous.response as T };
      }
      const result = work(state);
      return { events: [...result.events, this.event('enterprise.identity.command_recorded', 'enterprise.identity.command', id, 0, actor.principalId,
        { requestDigest, response: result.value })], value: result.value, assertBeforeCommit: () => {
          const current = reduceIdentityEvents(records); authorize(current); work(current);
        } };
    });
  }
  async invite(actor: EnterpriseActor, key: string, input: { id: string; subject: string; displayName: string; organizationAdmin: boolean }) {
    text(input.id); text(input.subject); text(input.displayName);
    if (typeof input.organizationAdmin !== 'boolean') throw new EnterpriseError('INVALID_BODY', 400);
    const token = randomBytes(32).toString('base64url');
    return this.command(actor, key, 'invite', input, state => { requireAdmin(state, actor, this.now()); }, state => {
      if (state.members.has(input.id) || [...state.members.values()].some(m => m.subject === input.subject && m.status !== 'removed')) throw new EnterpriseError('IDENTITY_ALREADY_BOUND', 409);
      if ([...state.members.values()].filter(m => m.status !== 'removed').length >= state.organization!.maxMembers) throw new EnterpriseError('MEMBER_QUOTA_EXCEEDED', 409);
      const member: OrganizationMember = { ...input, tenantId: actor.tenantId, issuer: state.organization!.issuer, status: 'invited',
        streamVersion: 1, sessionEpoch: 1, invitedUntil: new Date(Date.parse(this.now()) + 7 * 86400000).toISOString(), invitationHash: opaqueHash(token) };
      return { events: [this.event('enterprise.member.invited', 'enterprise.member', input.id, 0, actor.principalId, { member })],
        value: { id: member.id, member: memberView(member), token } };
    });
  }
  async acceptInvitation(actor: EnterpriseActor, key: string, memberId: string, expectedStreamVersion: number, token: string) {
    return this.command(actor, key, 'accept_invitation', { memberId, expectedStreamVersion, tokenHash: opaqueHash(token) }, state => { requireActor(state, actor, true, this.now()); }, state => {
      if (actor.principalId !== memberId) throw new EnterpriseError('INVITATION_IDENTITY_MISMATCH');
      const member = state.members.get(memberId)!; requireVersion(member.streamVersion, expectedStreamVersion);
      if (member.status !== 'invited' || !member.invitedUntil || Date.parse(member.invitedUntil) <= Date.parse(this.now())
        || member.invitationHash !== opaqueHash(token)) throw new EnterpriseError('INVITATION_INVALID');
      const event = this.event('enterprise.member.invitation_accepted', 'enterprise.member', memberId, member.streamVersion, actor.principalId, {});
      const { invitationHash: _hash, invitedUntil: _until, ...accepted } = member;
      return { events: [event], value: memberView({ ...accepted, status: 'active', streamVersion: member.streamVersion + 1 }) };
    });
  }
  async commandMember(actor: EnterpriseActor, key: string, memberId: string, expectedStreamVersion: number,
    command: { type: 'disable' | 'activate' | 'remove' } | { type: 'rebind'; subject: string }) {
    if (!['disable', 'activate', 'remove', 'rebind'].includes(command.type)) throw new EnterpriseError('INVALID_BODY', 400);
    if (command.type === 'rebind') text(command.subject);
    return this.command(actor, key, 'member_command', { memberId, expectedStreamVersion, command }, state => { requireAdmin(state, actor, this.now()); }, state => {
      const current = state.members.get(memberId);
      if (!current || current.status === 'removed') throw new EnterpriseError('MEMBER_UNAVAILABLE');
      requireVersion(current.streamVersion, expectedStreamVersion);
      if (current.organizationAdmin && current.status === 'active' && ['disable', 'remove'].includes(command.type)
        && [...state.members.values()].filter(m => m.organizationAdmin && m.status === 'active').length === 1) throw new EnterpriseError('LAST_ADMINISTRATOR', 409);
      if (command.type === 'activate' && (current.status !== 'disabled' || current.invitationHash)) throw new EnterpriseError('MEMBER_STATE_CONFLICT', 409);
      if (command.type === 'rebind' && (current.status === 'invited' || [...state.members.values()].some(m => m.id !== memberId && m.subject === command.subject && m.status !== 'removed')))
        throw new EnterpriseError('IDENTITY_ALREADY_BOUND', 409);
      const payload = command.type === 'rebind' ? { subject: command.subject } : { status: { disable: 'disabled', activate: 'active', remove: 'removed' }[command.type] };
      const event = this.event(command.type === 'rebind' ? 'enterprise.member.identity_rebound' : 'enterprise.member.status_changed', 'enterprise.member', memberId,
        current.streamVersion, actor.principalId, payload);
      const next = { ...current, ...payload, sessionEpoch: current.sessionEpoch + 1, streamVersion: current.streamVersion + 1 } as OrganizationMember;
      return { events: [event], value: memberView(next) };
    });
  }
  async createWorkspace(actor: EnterpriseActor, key: string, input: { name: string; mode: 'builtin' | 'sales' }) {
    text(input.name); if (!['builtin', 'sales'].includes(input.mode)) throw new EnterpriseError('INVALID_BODY', 400);
    const id = randomUUID();
    return this.command(actor, key, 'workspace_create', input, state => { requireAdmin(state, actor, this.now()); }, state => {
      if (state.workspaces.size) throw new EnterpriseError('WORKSPACE_LIMIT_EXCEEDED', 409);
      const workspace: EnterpriseWorkspace = { ...input, id, tenantId: actor.tenantId, streamVersion: 1 };
      return { events: [this.event('enterprise.workspace.created', 'enterprise.workspace', id, 0, actor.principalId, { workspace })], value: workspace };
    });
  }
  async listWorkspaces(actor: EnterpriseActor) {
    const state = reduceIdentityEvents(await this.options.repository.read(actor.tenantId)); requireActor(state, actor, false, this.now());
    return [...state.workspaces.values()];
  }
  async organization(actor: EnterpriseActor) {
    const state = reduceIdentityEvents(await this.options.repository.read(actor.tenantId)); requireActor(state, actor, true, this.now()); return state.organization!;
  }
  async listMembers(actor: EnterpriseActor) {
    const state = reduceIdentityEvents(await this.options.repository.read(actor.tenantId)); requireAdmin(state, actor, this.now()); return [...state.members.values()].map(memberView);
  }
}
