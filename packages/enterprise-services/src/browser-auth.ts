// SPDX-License-Identifier: Apache-2.0
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { JsonObject } from '@mn/contracts';
import type { EnterpriseRecord, EnterpriseRepository } from './repository.js';
import { EnterpriseError, opaqueHash, reduceIdentityEvents, requireActor, type EnterpriseActor, type OrganizationMember } from './identity.js';
export interface LoginAttempt {
  readonly id: string; readonly state: string; readonly nonce: string; readonly codeVerifier: string;
  readonly browserHash: string; readonly returnTo: string; readonly expiresAt: string; readonly consumed: boolean;
}
export interface BrowserSession {
  readonly id: string; readonly principalId: string; readonly sessionEpoch: number; readonly csrfToken: string;
  readonly expiresAt: string; readonly revoked: boolean; readonly streamVersion: number;
}
export function equalOpaque(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(opaqueHash(left), 'hex'), Buffer.from(opaqueHash(right), 'hex'));
}
function authState(records: readonly EnterpriseRecord[]) {
  const logins = new Map<string, LoginAttempt>(), sessions = new Map<string, BrowserSession>();
  for (const record of records) {
    if (record.type === 'enterprise.auth.login_started') logins.set(record.aggregateId, record.payload.attempt as unknown as LoginAttempt);
    else if (record.type === 'enterprise.auth.login_consumed') {
      const attempt = logins.get(record.aggregateId); if (!attempt) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
      logins.set(record.aggregateId, { ...attempt, consumed: true });
    } else if (record.type === 'enterprise.auth.session_created') sessions.set(record.aggregateId, record.payload.session as unknown as BrowserSession);
    else if (record.type === 'enterprise.auth.session_revoked') {
      const session = sessions.get(record.aggregateId); if (!session) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
      sessions.set(record.aggregateId, { ...session, revoked: true, streamVersion: session.streamVersion + 1 });
    }
  }
  return { logins, sessions };
}
const opaque = () => randomBytes(32).toString('base64url');
export class BrowserAuthService {
  private readonly now: () => string;
  constructor(readonly options: { repository: EnterpriseRepository; now?: () => string }) { this.now = options.now ?? (() => new Date().toISOString()); }
  private event(type: string, id: string, version: number, actorId: string, payload: unknown): EnterpriseRecord {
    return { type, aggregateType: type.includes('.login_') ? 'enterprise.auth.login' : 'enterprise.auth.session', aggregateId: id,
      expectedStreamVersion: version, actorId, occurredAt: this.now(), payload: JSON.parse(JSON.stringify(payload)) as JsonObject };
  }
  async startLogin(tenantId: string, returnTo: string): Promise<LoginAttempt & { browserSecret: string }> {
    const id = opaque(), browserSecret = opaque();
    const attempt: LoginAttempt = { id, state: opaque(), nonce: opaque(), codeVerifier: opaque(), browserHash: opaqueHash(browserSecret),
      returnTo, expiresAt: new Date(Date.parse(this.now()) + 600000).toISOString(), consumed: false };
    return this.options.repository.transact(tenantId, records => {
      if (!reduceIdentityEvents(records).organization) throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
      return { events: [this.event('enterprise.auth.login_started', id, 0, 'authentication', { attempt })], value: { ...attempt, browserSecret } };
    });
  }
  async claimLogin(tenantId: string, id: string, browserSecret: string, state: string): Promise<LoginAttempt> {
    return this.options.repository.transact(tenantId, records => {
      const attempt = authState(records).logins.get(id);
      if (!attempt || attempt.consumed || Date.parse(attempt.expiresAt) <= Date.parse(this.now()) || !equalOpaque(attempt.state, state)
        || !equalOpaque(attempt.browserHash, opaqueHash(browserSecret))) throw new EnterpriseError('LOGIN_ATTEMPT_INVALID', 401);
      return { events: [this.event('enterprise.auth.login_consumed', id, 1, 'authentication', {})], value: attempt };
    });
  }
  /** This proof is produced by the Host OIDC adapter, never by a JSON request body. */
  async createSession(tenantId: string, proof: { issuer: string; subject: string }): Promise<{ token: string; session: BrowserSession; member: OrganizationMember }> {
    const token = opaque();
    return this.options.repository.transact(tenantId, records => {
      const state = reduceIdentityEvents(records);
      const member = [...state.members.values()].find(item => item.issuer === proof.issuer && item.subject === proof.subject && item.status !== 'removed');
      if (state.organization?.issuer !== proof.issuer || !member) throw new EnterpriseError('IDENTITY_NOT_BOUND', 401);
      requireActor(state, { tenantId, principalId: member.id, sessionEpoch: member.sessionEpoch }, true);
      if (member.status === 'invited' && (!member.invitedUntil || Date.parse(member.invitedUntil) <= Date.parse(this.now()))) throw new EnterpriseError('INVITATION_INVALID', 401);
      const session: BrowserSession = { id: opaqueHash(token), principalId: member.id, sessionEpoch: member.sessionEpoch, csrfToken: opaque(),
        expiresAt: new Date(Date.parse(this.now()) + 8 * 3600000).toISOString(), revoked: false, streamVersion: 1 };
      return { events: [this.event('enterprise.auth.session_created', session.id, 0, member.id, { session })], value: { token, session, member } };
    });
  }
  async resolveSession(tenantId: string, token: string): Promise<{ actor: EnterpriseActor; session: BrowserSession; member: OrganizationMember }> {
    const records = await this.options.repository.read(tenantId);
    const session = authState(records).sessions.get(opaqueHash(token));
    if (!session || session.revoked || Date.parse(session.expiresAt) <= Date.parse(this.now())) throw new EnterpriseError('AUTHENTICATION_REQUIRED', 401);
    const actor = { tenantId, principalId: session.principalId, sessionEpoch: session.sessionEpoch };
    const member = requireActor(reduceIdentityEvents(records), actor, true);
    return { actor, session, member };
  }
  async logout(tenantId: string, token: string): Promise<void> {
    return this.options.repository.transact(tenantId, records => {
      const session = authState(records).sessions.get(opaqueHash(token));
      if (!session || session.revoked) return { events: [], value: undefined };
      return { events: [this.event('enterprise.auth.session_revoked', session.id, session.streamVersion, session.principalId, {})], value: undefined };
    });
  }
}
