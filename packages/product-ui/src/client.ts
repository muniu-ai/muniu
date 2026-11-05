// SPDX-License-Identifier: Apache-2.0
import { enterpriseRequest, parseEnterpriseResponse, ENTERPRISE_HTTP_OPERATIONS, parseEnterpriseContract, type EnterpriseApiInputs, type EnterpriseApiOutputs, type EnterpriseOperationId } from '@mn/contracts/enterprise-client';
import type { EnterpriseContractTypes } from '@mn/contracts';

export type EnterpriseSession = EnterpriseContractTypes['EnterpriseSessionView'];
export type ApiInput<K extends EnterpriseOperationId> = Omit<EnterpriseApiInputs[K], 'headers'>;
export interface MutationTicket<K extends EnterpriseOperationId> { readonly operation: K; readonly key: string; }
export class EnterpriseApiFailure extends Error {
  readonly status: number; readonly code: string; readonly traceId?: string; readonly unknownOutcome: boolean;
  constructor(input: { status: number; code: string; traceId?: string; unknownOutcome?: boolean }) {
    super(input.code); this.name = 'EnterpriseApiFailure'; this.status = input.status; this.code = input.code; this.traceId = input.traceId; this.unknownOutcome = input.unknownOutcome === true;
  }
}
export class EnterpriseBrowserClient {
  readonly origin: string;
  private readonly fetcher: typeof fetch; private readonly now: () => number; private readonly randomId: () => string;
  private currentSession?: EnterpriseSession; private revision = 0; private sessionRead = 0;
  private readonly tickets = new WeakMap<object, { revision: number; input: unknown }>();
  constructor(private readonly options: { origin: string; fetch?: typeof fetch; now?: () => number; randomId?: () => string; onSessionInvalid?: () => void }) {
    const url = new URL(options.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Host 来源无效');
    this.origin = url.origin; this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis); this.now = options.now ?? Date.now; this.randomId = options.randomId ?? (() => crypto.randomUUID());
  }
  get session(): EnterpriseSession | undefined { return this.currentSession; }
  private clearSession(): void {
    const present = this.currentSession !== undefined; this.currentSession = undefined; this.revision++; this.sessionRead++;
    if (present) this.options.onSessionInvalid?.();
  }
  private authenticated(): EnterpriseSession {
    if (!this.currentSession) throw new EnterpriseApiFailure({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    if (Date.parse(this.currentSession.expiresAt) <= this.now()) { this.clearSession(); throw new EnterpriseApiFailure({ status: 401, code: 'SESSION_EXPIRED' }); }
    return this.currentSession;
  }
  private operation(id: EnterpriseOperationId) {
    const operation = ENTERPRISE_HTTP_OPERATIONS.find(item => item.id === id);
    if (!operation) throw new EnterpriseApiFailure({ status: 400, code: 'OPERATION_UNAVAILABLE' }); return operation;
  }
  async loadSession(signal?: AbortSignal): Promise<EnterpriseSession> {
    const sequence = ++this.sessionRead, revision = this.revision;
    const result = await this.perform('enterpriseSession', {}, undefined, signal);
    if (sequence !== this.sessionRead || revision !== this.revision) throw new EnterpriseApiFailure({ status: 0, code: 'STALE_RESPONSE' });
    if (Date.parse(result.expiresAt) <= this.now()) { this.clearSession(); throw new EnterpriseApiFailure({ status: 401, code: 'SESSION_EXPIRED' }); }
    if (!this.currentSession || [this.currentSession.tenantId, this.currentSession.principalId, this.currentSession.csrfToken].join('\n') !== [result.tenantId, result.principalId, result.csrfToken].join('\n')) this.revision++;
    this.currentSession = Object.freeze(result); return result;
  }
  async query<K extends EnterpriseOperationId>(id: K, input: ApiInput<K>, signal?: AbortSignal): Promise<EnterpriseApiOutputs[K]> {
    if (this.operation(id).mutation) throw new EnterpriseApiFailure({ status: 400, code: 'MUTATION_TICKET_REQUIRED' });
    return this.perform(id, input, undefined, signal);
  }
  prepareMutation<K extends EnterpriseOperationId>(id: K, input: ApiInput<K>): MutationTicket<K> {
    const session = this.authenticated();
    if (!this.operation(id).mutation) throw new EnterpriseApiFailure({ status: 400, code: 'READ_OPERATION_REQUIRED' });
    const copy = structuredClone(input), key = this.randomId();
    enterpriseRequest(id, { ...copy, headers: { 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': key } } as EnterpriseApiInputs[K]);
    const ticket = Object.freeze({ operation: id, key }); this.tickets.set(ticket, { revision: this.revision, input: copy }); return ticket;
  }
  async executeMutation<K extends EnterpriseOperationId>(ticket: MutationTicket<K>, signal?: AbortSignal): Promise<EnterpriseApiOutputs[K]> {
    const stored = this.tickets.get(ticket); this.authenticated();
    if (!stored || stored.revision !== this.revision) throw new EnterpriseApiFailure({ status: 401, code: 'SESSION_CHANGED' });
    return this.perform(ticket.operation, stored.input as ApiInput<K>, ticket.key, signal);
  }
  private async perform<K extends EnterpriseOperationId>(id: K, input: ApiInput<K>, key?: string, signal?: AbortSignal): Promise<EnterpriseApiOutputs[K]> {
    const operation = this.operation(id), publicRead = ['enterpriseSession', 'enterpriseHealth', 'listEnterpriseLoginOrganizations'].includes(id);
    const session = publicRead ? undefined : this.authenticated(), revision = this.revision;
    const protocolHeaders = operation.method === 'post' ? { 'X-CSRF-Token': session!.csrfToken, ...(operation.mutation ? { 'Idempotency-Key': key! } : {}) } : undefined;
    const request = enterpriseRequest(id, { ...input, ...(protocolHeaders ? { headers: protocolHeaders } : {}) } as EnterpriseApiInputs[K]);
    let response: Response;
    try {
      response = await this.fetcher(new URL(request.path, this.origin), { method: request.method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
        headers: { Accept: 'application/json', ...request.headers, ...('body' in request ? { 'Content-Type': 'application/json' } : {}) },
        ...('body' in request ? { body: JSON.stringify(request.body) } : {}),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new EnterpriseApiFailure({ status: 0, code: 'NETWORK_UNAVAILABLE', unknownOutcome: operation.mutation });
    }
    if (revision !== this.revision) throw new EnterpriseApiFailure({ status: 0, code: 'STALE_RESPONSE' });
    if (!response.ok) throw await this.failure(response, operation.mutation, revision);
    let body: unknown;
    try { body = await response.json(); }
    catch { if (revision !== this.revision) throw new EnterpriseApiFailure({ status: 0, code: 'STALE_RESPONSE' }); throw new EnterpriseApiFailure({ status: response.status, code: 'INVALID_SERVICE_RESPONSE', unknownOutcome: operation.mutation }); }
    if (revision !== this.revision) throw new EnterpriseApiFailure({ status: 0, code: 'STALE_RESPONSE' });
    try { return parseEnterpriseResponse(id, body); }
    catch { throw new EnterpriseApiFailure({ status: response.status, code: 'INVALID_SERVICE_RESPONSE', unknownOutcome: operation.mutation }); }
  }
  private async failure(response: Response, mutation: boolean, revision: number): Promise<EnterpriseApiFailure> {
    let code = 'SERVICE_UNAVAILABLE', traceId: string | undefined;
    try { const parsed = parseEnterpriseContract('EnterpriseApiError', await response.json()); code = parsed.code; traceId = parsed.traceId; } catch { /* Never expose an unvalidated error body. */ }
    if (revision !== this.revision) throw new EnterpriseApiFailure({ status: 0, code: 'STALE_RESPONSE' });
    if (response.status === 401) this.clearSession();
    return new EnterpriseApiFailure({ status: response.status, code, traceId, unknownOutcome: mutation && response.status >= 500 });
  }
  loginUrl(organizationId: string): string {
    const url = new URL('/v2/auth/login', this.origin); url.searchParams.set('organizationId', organizationId); url.searchParams.set('returnTo', '/'); return url.href;
  }
  async logout(): Promise<void> {
    const session = this.authenticated(), revision = this.revision; this.sessionRead++;
    let response: Response;
    try { response = await this.fetcher(new URL('/v2/auth/logout', this.origin), { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-CSRF-Token': session.csrfToken } }); }
    catch { throw new EnterpriseApiFailure({ status: 0, code: 'LOGOUT_UNCONFIRMED' }); }
    if (revision !== this.revision) return;
    if (response.status !== 204 && response.status !== 401) throw await this.failure(response, false, revision);
    this.clearSession();
  }
}
