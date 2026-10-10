// SPDX-License-Identifier: Apache-2.0
import type { Asset, CreateMcpRequestV2, GoalResourceRefV2, JsonObject, McpConnectionV2, McpRequestV2, McpResourceTemplateV2, McpResourceV2 } from '@mn/contracts';
import { admitExternalReadInTransaction, assertExternalReadAuthorization, beginExternalReadInTransaction, finishExternalReadInTransaction, appendKernelEvent, KernelError, sha256, type ExternalReadCommitment, type KernelStore, type KernelTransaction } from '@mn/kernel';
import type { ContentAddressedStorage, KeyProvider } from '@mn/storage';
import type { McpReadWorkerPorts } from '@mn/worker';
import { commitPreparedDerivedAssetInTransaction, prepareProtectedAsset, type PreparedProtectedAsset } from './assets.js';
import { assertMcpConnectionCurrent, assertMcpMember, mcpConnectionDigest, mcpConnectionRef, mcpFail, validateMcpContextSource, type McpResourceSnapshot, type McpScope, type McpSecretStore, type McpStoredConnection } from './mcp-sources.js';
import { createMcpTransport, MCP_VERSION, mcpRequestBody, parseMcpEndpoint, type McpMethod, type McpTransport } from './mcp-transport.js';
export { validateMcpContextSource } from './mcp-sources.js';
export interface McpOptions { readonly store: KernelStore; readonly cas: ContentAddressedStorage; readonly keyProvider: KeyProvider; readonly protectedJournal: boolean;
  readonly secrets?: McpSecretStore; readonly transport?: McpTransport; readonly now: () => string; readonly id: (kind: string) => string }
interface McpStoredRequest extends McpRequestV2 {
  readonly tenantId: string; readonly principalId: string; readonly connectionRef: GoalResourceRefV2; readonly createdAt: string;
  readonly method: McpMethod; readonly params: Readonly<Record<string, string>>; readonly authorityDigest: string;
  readonly requestBody: string; readonly requestBodyDigest: string;
}
const CONNECTION = 'mcp.connection', READ = 'mcp.resourceRead', SNAPSHOT = 'mcp.resourceSnapshot';
function protect(options: McpOptions): void { if (!options.protectedJournal || !options.cas || !options.keyProvider) mcpFail('PROTECTED_PAYLOAD_UNAVAILABLE'); }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) mcpFail('MCP_REQUEST_INVALID'); return value as Record<string, unknown>; }
function text(value: unknown, max = 2048): string { if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) mcpFail('MCP_REQUEST_INVALID'); return value; }
function uri(value: unknown): string { const result = text(value); if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(result)) mcpFail('MCP_URI_INVALID'); return result; }
function version(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) mcpFail('MCP_REQUEST_INVALID'); return Number(value); }
function event(tx: KernelTransaction, options: McpOptions, scope: McpScope, namespace: string, id: string, previous: number, type: string): void {
  appendKernelEvent(tx, { tenantId: scope.tenantId, aggregateType: namespace, aggregateId: id, expectedStreamVersion: previous, type, actorId: scope.principalId,
    generation: 0, correlationId: options.id('mcp-event'), publicPayload: { workspaceId: scope.workspaceId } });
}
function receipt(tx: KernelTransaction, scope: McpScope, kind: string, key: string, raw: unknown) {
  text(key, 200); const namespace = `mcp:${scope.workspaceId}:${scope.principalId}:${kind}`, digest = sha256(raw), previous = tx.getIdempotency(namespace, key);
  if (previous && previous.requestDigest !== digest) mcpFail('IDEMPOTENCY_KEY_REUSED');
  return { previous: previous?.response as { id: string } | undefined, save(id: string, now: string) { tx.putIdempotency({ tenantId: scope.tenantId, scope: namespace, key, requestDigest: digest, response: { id }, createdAt: now }); } };
}
function connection(tx: KernelTransaction, scope: McpScope, id: string): McpStoredConnection {
  assertMcpMember(tx, scope, false); const value = tx.getProjection<McpStoredConnection>(CONNECTION, id);
  if (!value || value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId) mcpFail('MCP_CONNECTION_NOT_FOUND'); return value;
}
function publicConnection(tx: KernelTransaction, scope: McpScope, value: McpStoredConnection, now: string): McpConnectionV2 {
  const usedRequests = tx.listProjections<McpStoredRequest>(READ).filter(item => item.connectionId === value.id).length;
  const member = assertMcpMember(tx, scope, false), manage = member.workspaceRole === 'owner' || (member.workspaceRole === 'operator' && value.principalId === scope.principalId);
  let available = true; try { assertMcpConnectionCurrent(tx, value, now); } catch { available = false; }
  let canEnable = false;
  try { assertEnableGrant(tx, value, now); canEnable = true; } catch { /* The original grant cannot be expanded by resuming. */ }
  return { id: value.id, workspaceId: value.workspaceId, label: value.label, endpoint: value.endpoint, protocolVersion: value.protocolVersion, status: value.status,
    streamVersion: value.streamVersion, digest: value.digest, credentialConfigured: Boolean(value.secretRef), expiresAt: value.expiresAt, uriPrefixes: value.uriPrefixes,
    maxRequests: value.maxRequests, usedRequests, allowedActions: { request: available && usedRequests < value.maxRequests && ['owner', 'operator'].includes(member.workspaceRole),
      disable: manage && value.status === 'enabled', enable: manage && value.status === 'disabled' && canEnable, rotateCredential: manage } };
}
function assertEnableGrant(tx: KernelTransaction, value: McpStoredConnection, now: string): void {
  if (mcpConnectionDigest(value) !== value.digest || assertMcpMember(tx, value).streamVersion !== value.membershipVersion
    || Date.parse(value.expiresAt) <= Date.parse(now) || tx.listProjections<McpStoredRequest>(READ).filter(item => item.connectionId === value.id).length >= value.maxRequests) mcpFail('MCP_GRANT_INVALID');
}
export async function listMcpConnections(options: McpOptions, scope: McpScope): Promise<readonly McpConnectionV2[]> {
  protect(options); return options.store.transact(scope.tenantId, tx => { assertMcpMember(tx, scope, false); return tx.listProjections<McpStoredConnection>(CONNECTION).filter(value => value.workspaceId === scope.workspaceId && value.tenantId === scope.tenantId).map(value => publicConnection(tx, scope, value, options.now())); });
}
async function secret(options: McpOptions, scope: McpScope, id: string, bearerToken: unknown): Promise<{ credentialId?: string; secretRef?: string }> {
  if (bearerToken === undefined) return {}; const value = text(bearerToken, 8192); if (!/^[\x21-\x7e]+$/u.test(value) || !options.secrets) mcpFail('MCP_CREDENTIAL_UNAVAILABLE');
  const credentialId = options.id('mcp-credential');
  try { return { credentialId, secretRef: await options.secrets.save({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, connectionId: id, credentialId }, value) }; }
  catch { mcpFail('MCP_CREDENTIAL_UNAVAILABLE'); }
}
export async function createMcpConnection(options: McpOptions, scope: McpScope, raw: unknown, key: string): Promise<McpConnectionV2> {
  protect(options); const body = fields(raw, ['expectedStreamVersion', 'label', 'endpoint', 'bearerToken', 'expiresAt', 'uriPrefixes', 'maxRequests']);
  if (body.expectedStreamVersion !== 0) mcpFail('STREAM_VERSION_CONFLICT');
  const label = text(body.label, 120), endpoint = parseMcpEndpoint(text(body.endpoint)).href, expiresAt = text(body.expiresAt), maxRequests = version(body.maxRequests);
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(options.now()) || Date.parse(expiresAt) > Date.parse(options.now()) + 366 * 86400000 || maxRequests > 1000
    || !Array.isArray(body.uriPrefixes) || !body.uriPrefixes.length || body.uriPrefixes.length > 20) mcpFail('MCP_GRANT_INVALID');
  const uriPrefixes = body.uriPrefixes.map(uri); if (new Set(uriPrefixes).size !== uriPrefixes.length) mcpFail('MCP_GRANT_INVALID');
  const old = await options.store.transact(scope.tenantId, tx => { assertMcpMember(tx, scope); const prior = receipt(tx, scope, 'connection', key, raw).previous; return prior && publicConnection(tx, scope, connection(tx, scope, prior.id), options.now()); }); if (old) return old;
  const id = options.id('mcp-connection'), credential = await secret(options, scope, id, body.bearerToken);
  return options.store.transact(scope.tenantId, tx => {
    const member = assertMcpMember(tx, scope), saved = receipt(tx, scope, 'connection', key, raw); if (saved.previous) return publicConnection(tx, scope, connection(tx, scope, saved.previous.id), options.now());
    if (tx.listProjections<McpStoredConnection>(CONNECTION).filter(value => value.workspaceId === scope.workspaceId).length >= 100) mcpFail('MCP_CONNECTION_LIMIT');
    const base = { ...scope, id, label, endpoint, expiresAt, maxRequests, uriPrefixes, ...credential, protocolVersion: MCP_VERSION as '2026-07-28', status: 'enabled' as const, streamVersion: 1, membershipVersion: member.streamVersion, createdAt: options.now() };
    const value = { ...base, digest: mcpConnectionDigest(base) }; tx.putProjection(CONNECTION, id, value); event(tx, options, scope, CONNECTION, id, 0, 'mcp.connection_created'); saved.save(id, options.now()); return publicConnection(tx, scope, value, options.now());
  });
}
export async function commandMcpConnection(options: McpOptions, scope: McpScope, id: string, raw: unknown, key: string): Promise<McpConnectionV2> {
  protect(options); const body = fields(raw, ['expectedStreamVersion', 'command', 'bearerToken']), expected = version(body.expectedStreamVersion);
  if (!['enable', 'disable', 'rotate_credential'].includes(String(body.command)) || (body.command !== 'rotate_credential' && body.bearerToken !== undefined) || (body.command === 'rotate_credential' && body.bearerToken === undefined)) mcpFail('MCP_REQUEST_INVALID');
  const check = (tx: KernelTransaction) => { const current = connection(tx, scope, id), member = assertMcpMember(tx, scope); if (member.workspaceRole !== 'owner' && current.principalId !== scope.principalId) mcpFail('MCP_ACCESS_DENIED'); return current; };
  const old = await options.store.transact(scope.tenantId, tx => { const current = check(tx); const known = receipt(tx, scope, `command:${id}`, key, raw); if (known.previous) return publicConnection(tx, scope, current, options.now()); if (current.streamVersion !== expected) mcpFail('STREAM_VERSION_CONFLICT'); }); if (old) return old;
  const credential = body.command === 'rotate_credential' ? await secret(options, scope, id, body.bearerToken) : {};
  return options.store.transact(scope.tenantId, tx => { const current = check(tx), known = receipt(tx, scope, `command:${id}`, key, raw); if (known.previous) return publicConnection(tx, scope, current, options.now()); if (current.streamVersion !== expected) mcpFail('STREAM_VERSION_CONFLICT');
    if (body.command === 'enable') assertEnableGrant(tx, current, options.now());
    const base = { ...current, ...credential, status: body.command === 'disable' ? 'disabled' as const : body.command === 'enable' ? 'enabled' as const : current.status, streamVersion: current.streamVersion + 1 };
    const next = { ...base, digest: mcpConnectionDigest(base) }; tx.putProjection(CONNECTION, id, next); event(tx, options, scope, CONNECTION, id, current.streamVersion, 'mcp.connection_changed'); known.save(id, options.now()); return publicConnection(tx, scope, next, options.now()); });
}
function scopeAllows(connection: McpStoredConnection, value: string): boolean { return connection.uriPrefixes.some(prefix => value.startsWith(prefix)); }
function templateSupported(value: string): boolean { return !value.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/gu, '').match(/[{}]/u); }
function parameters(tx: KernelTransaction, scope: McpScope, target: McpStoredConnection, body: Record<string, unknown>): { kind: CreateMcpRequestV2['kind']; method: McpMethod; params: Record<string, string> } {
  const kind = body.kind; if (!['resources', 'templates', 'read'].includes(String(kind))) mcpFail('MCP_REQUEST_INVALID');
  if (kind !== 'read') {
    if (body.selection !== undefined) mcpFail('MCP_REQUEST_INVALID'); const cursor = body.cursor === undefined ? undefined : text(body.cursor, 4096);
    if (cursor && !tx.listProjections<McpStoredRequest>(READ).some(item => item.connectionId === target.id && item.kind === kind && item.status === 'completed' && item.nextCursor === cursor && sha256(item.connectionRef) === sha256(mcpConnectionRef(target)))) mcpFail('MCP_CURSOR_INVALID');
    return { kind: kind as 'resources' | 'templates', method: kind === 'resources' ? 'resources/list' : 'resources/templates/list', params: cursor ? { cursor } : {} };
  }
  if (body.cursor !== undefined) mcpFail('MCP_REQUEST_INVALID');
  const selected = fields(body.selection, ['catalogRequestId', 'uri', 'uriTemplate', 'variables']);
  const catalog = tx.getProjection<McpStoredRequest>(READ, text(selected.catalogRequestId, 200));
  if (!catalog || catalog.tenantId !== scope.tenantId || catalog.workspaceId !== scope.workspaceId || catalog.connectionId !== target.id || catalog.status !== 'completed' || sha256(catalog.connectionRef) !== sha256(mcpConnectionRef(target))) mcpFail('MCP_SELECTION_STALE');
  let selectedUri: string;
  if (selected.uriTemplate !== undefined) {
    if (selected.uri !== undefined || catalog.kind !== 'templates') mcpFail('MCP_SELECTION_INVALID');
    const template = text(selected.uriTemplate), definition = catalog.templates?.find(value => value.uriTemplate === template && value.supported);
    if (!definition) mcpFail('MCP_TEMPLATE_UNSUPPORTED');
    const names = [...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map(match => match[1]!);
    const variables = fields(selected.variables ?? {}, names); if (names.length > 20 || names.some(name => !Object.hasOwn(variables, name))) mcpFail('MCP_TEMPLATE_INVALID');
    selectedUri = uri(template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_all, name: string) => encodeURIComponent(text(variables[name], 1024))));
  } else {
    if (selected.variables !== undefined || catalog.kind !== 'resources') mcpFail('MCP_SELECTION_INVALID');
    selectedUri = uri(selected.uri); if (!catalog.resources?.some(resource => resource.uri === selectedUri)) mcpFail('MCP_SELECTION_INVALID');
  }
  if (!scopeAllows(target, selectedUri)) mcpFail('MCP_RESOURCE_DENIED');
  return { kind: 'read', method: 'resources/read', params: { uri: selectedUri } };
}
function publicRequest(value: McpStoredRequest): McpRequestV2 {
  return { id: value.id, workspaceId: value.workspaceId, connectionId: value.connectionId, streamVersion: value.streamVersion, kind: value.kind, status: value.status,
    ...(value.resources ? { resources: value.resources } : {}), ...(value.templates ? { templates: value.templates } : {}), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
    ...(value.assetRefs ? { assetRefs: value.assetRefs } : {}), ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}) };
}
export async function createMcpRequest(options: McpOptions, scope: McpScope, connectionId: string, raw: unknown, key: string): Promise<McpRequestV2> {
  protect(options); const body = fields(raw, ['expectedStreamVersion', 'kind', 'cursor', 'selection']); const expected = version(body.expectedStreamVersion);
  return options.store.transact(scope.tenantId, tx => { assertMcpMember(tx, scope); const target = connection(tx, scope, connectionId); assertMcpConnectionCurrent(tx, target, options.now());
    const known = receipt(tx, scope, `request:${connectionId}`, key, raw);
    if (known.previous) return publicRequest(readRequest(tx, scope, known.previous.id, options.now()));
    if (target.streamVersion !== expected) mcpFail('STREAM_VERSION_CONFLICT');
    if (tx.listProjections<McpStoredRequest>(READ).filter(value => value.tenantId === scope.tenantId && value.workspaceId === scope.workspaceId).length >= 1000) mcpFail('MCP_WORKSPACE_READ_LIMIT');
    if (tx.listProjections<McpStoredRequest>(READ).filter(value => value.connectionId === target.id).length >= target.maxRequests) mcpFail('MCP_READ_LIMIT');
    const request = parameters(tx, scope, target, body), id = options.id('mcp-read'), createdAt = options.now(), connectionRef = mcpConnectionRef(target);
    const requestBody = mcpRequestBody(id, request.method, request.params);
    const value: McpStoredRequest = { ...scope, ...request, id, connectionId, connectionRef, streamVersion: 1, status: 'queued', createdAt, authorityDigest: target.digest, requestBody, requestBodyDigest: sha256(requestBody) };
    admitExternalReadInTransaction(tx, { id, ...scope, toolId: `mcp.${request.method}`, toolVersion: MCP_VERSION, effectClass: 'external_read', resourceRefs: [connectionRef],
      requestDigest: sha256({ method: request.method, params: request.params }), replayScopeDigest: sha256({ endpoint: target.endpoint, method: request.method, params: request.params }),
      authorityDigest: target.digest, expiresAt: target.expiresAt, now: createdAt, jobKind: 'mcp.resource.read' });
    tx.putProjection(READ, id, value); event(tx, options, scope, READ, id, 0, 'mcp.read_queued'); known.save(id, createdAt); return publicRequest(value);
  });
}
function readRequest(tx: KernelTransaction, scope: McpScope, id: string, now: string): McpStoredRequest {
  assertMcpMember(tx, scope, false); const value = tx.getProjection<McpStoredRequest>(READ, id);
  if (!value || value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId) mcpFail('MCP_READ_NOT_FOUND');
  const target = connection(tx, scope, value.connectionId); assertMcpConnectionCurrent(tx, target, now);
  if (sha256(mcpConnectionRef(target)) !== sha256(value.connectionRef)) mcpFail('MCP_SELECTION_STALE'); return value;
}
export async function getMcpRequest(options: McpOptions, scope: McpScope, id: string): Promise<McpRequestV2> { protect(options); return options.store.transact(scope.tenantId, tx => publicRequest(readRequest(tx, scope, id, options.now()))); }
export async function listMcpRequests(options: McpOptions, scope: McpScope): Promise<readonly McpRequestV2[]> {
  protect(options);
  return options.store.transact(scope.tenantId, tx => {
    assertMcpMember(tx, scope, false);
    return tx.listProjections<McpStoredRequest>(READ).filter(value => value.tenantId === scope.tenantId && value.workspaceId === scope.workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).flatMap(value => {
        let current = false;
        try { readRequest(tx, scope, value.id, options.now()); current = true; } catch { /* Old content remains unavailable. */ }
        if (!current && value.status !== 'needs_reconciliation') return [];
        return [{ id: value.id, workspaceId: value.workspaceId, connectionId: value.connectionId, streamVersion: value.streamVersion,
          kind: value.kind, status: value.status, ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}) }];
      });
  });
}
function catalogResult(result: Record<string, unknown>, kind: 'resources' | 'templates', target: McpStoredConnection): Pick<McpRequestV2, 'resources' | 'templates' | 'nextCursor'> {
  const rows = result[kind === 'resources' ? 'resources' : 'resourceTemplates']; if (!Array.isArray(rows) || rows.length > 100) mcpFail('MCP_RESPONSE_INVALID');
  const nextCursor = result.nextCursor === undefined ? undefined : text(result.nextCursor, 4096);
  const metadata = (row: Record<string, unknown>) => ({ name: text(row.name, 200), ...(row.title === undefined ? {} : { title: text(row.title, 200) }), ...(row.description === undefined ? {} : { description: text(row.description, 4000) }), ...(row.mimeType === undefined ? {} : { mimeType: text(row.mimeType, 120) }) });
  const resources: McpResourceV2[] = [], templates: McpResourceTemplateV2[] = [];
  for (const row of rows) { if (!row || typeof row !== 'object' || Array.isArray(row)) mcpFail('MCP_RESPONSE_INVALID');
    if (kind === 'resources') { const resourceUri = uri(row.uri); if (scopeAllows(target, resourceUri)) resources.push({ ...metadata(row), uri: resourceUri }); }
    else { const uriTemplate = text(row.uriTemplate); templates.push({ ...metadata(row), uriTemplate, supported: templateSupported(uriTemplate) }); }
  }
  return { ...(kind === 'resources' ? { resources } : { templates }), ...(nextCursor ? { nextCursor } : {}) };
}
const EXTENSIONS: Readonly<Record<string, string>> = { 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };
async function prepareContents(options: McpOptions, scope: McpScope, target: McpStoredConnection, result: Record<string, unknown>): Promise<{ prepared: PreparedProtectedAsset; uri: string }[]> {
  if (!Array.isArray(result.contents) || !result.contents.length || result.contents.length > 20) mcpFail('MCP_CONTENT_INVALID');
  const prepared: { prepared: PreparedProtectedAsset; uri: string }[] = []; let total = 0;
  for (const raw of result.contents) {
    const item = fields(raw, ['uri', 'mimeType', 'text', 'blob', '_meta', 'annotations']), resourceUri = uri(item.uri), mediaType = item.mimeType === undefined ? 'text/plain' : text(item.mimeType, 120), extension = EXTENSIONS[mediaType];
    if (!scopeAllows(target, resourceUri) || !extension || ('text' in item) === ('blob' in item)) mcpFail('MCP_CONTENT_INVALID');
    let bytes: Buffer;
    if ('text' in item) { if (typeof item.text !== 'string' || !['txt', 'md', 'csv', 'json'].includes(extension)) mcpFail('MCP_CONTENT_INVALID'); bytes = Buffer.from(item.text, 'utf8'); }
    else { if (typeof item.blob !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.blob) || item.blob.length > 3 * 1024 * 1024) mcpFail('MCP_CONTENT_INVALID'); bytes = Buffer.from(item.blob, 'base64'); }
    try { total += bytes.length; if (!bytes.length || total > 2 * 1024 * 1024) mcpFail('MCP_CONTENT_LIMIT');
      prepared.push({ uri: resourceUri, prepared: await prepareProtectedAsset({ ...options, ...scope, assetId: options.id('mcp-asset'), fileName: `mcp-${prepared.length + 1}.${extension}`, mediaType, bytes }) });
    } finally { bytes.fill(0); }
  }
  return prepared;
}
export function createMcpWorkerPorts(options: McpOptions): McpReadWorkerPorts {
  protect(options); const transport = options.transport ?? createMcpTransport();
  return { async execute(job, context) {
    const id = typeof job.payload.readId === 'string' ? job.payload.readId : mcpFail('MCP_JOB_INVALID'); let sent = false, beganHere = false;
    const stored = await options.store.transact(job.tenantId, tx => tx.getProjection<McpStoredRequest>(READ, id));
    if (!stored || stored.tenantId !== job.tenantId || stored.workspaceId !== job.workspaceId) mcpFail('MCP_JOB_INVALID');
    const scope: McpScope = { tenantId: stored.tenantId, workspaceId: stored.workspaceId, principalId: stored.principalId };
    const boundary = () => ({ id, tenantId: job.tenantId, jobId: job.id, workerId: context.workerId, fencingToken: context.fencingToken, occurredAt: options.now(), authorityDigest: stored.authorityDigest });
    const current = (tx: KernelTransaction) => { const value = readRequest(tx, scope, id, options.now()); const committed = tx.getProjection<ExternalReadCommitment>('kernel.externalRead', id);
      if (!committed || sha256(value.requestBody) !== value.requestBodyDigest || value.requestBody !== mcpRequestBody(id, value.method, value.params)
        || committed.requestDigest !== sha256({ method: value.method, params: value.params }) || value.requestBody !== stored.requestBody) mcpFail('MCP_JOB_INVALID');
      assertExternalReadAuthorization(tx, committed, stored.authorityDigest, options.now()); return { value, target: connection(tx, scope, value.connectionId) }; };
    const save = (tx: KernelTransaction, value: McpStoredRequest, update: Partial<McpRequestV2>) => { const next = { ...value, ...update, streamVersion: value.streamVersion + 1 }; tx.putProjection(READ, id, next); event(tx, options, scope, READ, id, value.streamVersion, `mcp.read_${next.status}`); return next; };
    try {
      const started = await options.store.transact(job.tenantId, tx => { const state = current(tx); beginExternalReadInTransaction(tx, boundary()); return { ...state, value: save(tx, state.value, { status: 'running' }) }; });
      beganHere = true;
      let token: string | undefined;
      if (started.target.secretRef) { if (!options.secrets || !started.target.credentialId) mcpFail('MCP_CREDENTIAL_UNAVAILABLE');
        try { token = await options.secrets.read({ ...scope, connectionId: started.target.id, credentialId: started.target.credentialId }, started.target.secretRef); } catch { mcpFail('MCP_CREDENTIAL_UNAVAILABLE'); } }
      const allowed = () => options.store.transact(job.tenantId, tx => { tx.assertJobLease?.(boundary()); current(tx); });
      await allowed(); context.signal.throwIfAborted();
      sent = true;
      const result = await transport({ endpoint: started.target.endpoint, id, method: stored.method, params: stored.params, requestBody: stored.requestBody, ...(token ? { token } : {}), signal: context.signal,
        assertAllowed: async () => { await allowed(); sent = true; } });
      // Test transports also cross the current-authority boundary; production calls it immediately before POST.
      sent = true; await allowed();
      if (!result || result.resultType !== 'complete' || 'inputRequests' in result || 'inputResponses' in result) mcpFail('MCP_INPUT_REQUEST_DENIED');
      const prepared = stored.kind === 'read' ? await prepareContents(options, scope, started.target, result) : [];
      const page = stored.kind === 'read' ? {} : catalogResult(result, stored.kind, started.target);
      const value = await options.store.transact(job.tenantId, tx => {
        const state = current(tx); tx.assertJobLease?.(boundary()); context.signal.throwIfAborted();
        const assets: Asset[] = [];
        if (prepared.length) {
          const body = { id: `mcp-snapshot:${id}`, tenantId: scope.tenantId, workspaceId: scope.workspaceId, streamVersion: 1 as const, connectionRef: stored.connectionRef, protocolVersion: MCP_VERSION as '2026-07-28', requestId: id,
            contents: prepared.map(item => ({ uri: item.uri, mediaType: item.prepared.asset.mediaType, contentDigest: item.prepared.contentSha256 })), readAt: options.now() };
          const snapshot: McpResourceSnapshot = { ...body, digest: sha256(body) }; tx.putProjection(SNAPSHOT, snapshot.id, snapshot); event(tx, options, scope, SNAPSHOT, snapshot.id, 0, 'mcp.snapshot_created');
          const sourceRefs = [stored.connectionRef, { namespace: SNAPSHOT, resourceId: snapshot.id, streamVersion: 1, digest: snapshot.digest }];
          for (const item of prepared) assets.push(commitPreparedDerivedAssetInTransaction(tx, scope, item.prepared, { version: 1, kind: 'mcp_resource', sourceRefs, producer: { namespace: READ, resourceId: id } }, { ...options, validateContextSource: validateMcpContextSource }));
        }
        const next = save(tx, state.value, { status: 'completed', ...page, ...(assets.length ? { assetRefs: assets.map(asset => ({ namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest })) } : {}) });
        const receipt = finishExternalReadInTransaction(tx, { ...boundary(), outcome: 'completed', value: { requestId: id } }); return { receipt, result: publicRequest(next) };
      });
      context.acknowledgeJobSettlement?.(value.receipt); return { requestId: id } as JsonObject;
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'MCP_READ_FAILED';
      const value = await options.store.transact(job.tenantId, tx => {
        const previous = tx.getProjection<McpStoredRequest>(READ, id); if (!previous) mcpFail('MCP_JOB_INVALID');
        const commitment = tx.getProjection<ExternalReadCommitment>('kernel.externalRead', id);
        const unknown = sent || code === 'EXTERNAL_READ_ALREADY_STARTED'
          || (commitment?.status === 'started' && (!beganHere || commitment.startedFence !== context.fencingToken));
        const outcome = unknown ? 'needs_reconciliation' as const : 'failed' as const;
        const receipt = finishExternalReadInTransaction(tx, { ...boundary(), outcome, value: { requestId: id, code } });
        save(tx, previous, { status: outcome, reasonCode: code }); return receipt;
      });
      context.acknowledgeJobSettlement?.(value); return { requestId: id, code } as JsonObject;
    }
  } };
}
