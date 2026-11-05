// SPDX-License-Identifier: Apache-2.0
import { dispatchEnterpriseWorkflows } from './enterprise-workflows-api.js';
import type { EnterpriseWorkflowService } from './enterprise-workflows.js';
import { dispatchEnterpriseKnowledge } from './enterprise-knowledge-api.js';
import type { EnterpriseKnowledgeService } from './enterprise-knowledge.js';
import type { EnterpriseArtifactService } from './enterprise-artifacts.js';
import type { EnterpriseExperienceService } from './enterprise-experience.js';
import type { EnterpriseGoalService } from './enterprise-goals.js';
import { dispatchEnterpriseGoals } from './enterprise-goals-api.js';
import { dispatchEnterpriseOperating } from './enterprise-operating-api.js';
import type { EnterpriseEvaluationRuntime } from './enterprise-evaluation.js';
import type { EnterpriseOperatingService } from './enterprise-operating.js';
import { EnterprisePlanError } from '@mn/task-orchestration';
import { KernelError } from '@mn/kernel';
import { EnterpriseExecutionConfigurationService } from './enterprise-execution-config.js';
import type { EnterpriseExecutionRuntime } from './enterprise-execution-runtime.js';
import { dispatchEnterpriseExecution } from './enterprise-execution-api.js';
import { dispatchEnterpriseProviders } from './enterprise-providers-api.js';
import type { EnterpriseProviderService } from './enterprise-provider-service.js';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { ENTERPRISE_HTTP_OPERATIONS, createEnterpriseOpenApiDocument } from '@mn/contracts';
import { parseEnterpriseContract, canonicalJson, type EnterpriseContractTypes } from '@mn/contracts';
import { BrowserAuthService, EnterpriseError, EnterpriseIdentityService, EnterprisePermissionService, EnterpriseQuotaService, equalOpaque, opaqueHash, type EnterpriseRepository } from '@mn/enterprise-services';
import { EnterpriseBusinessService } from './enterprise-business.js';
import { dispatchEnterpriseBusiness } from './enterprise-business-api.js';
import { dispatchEnterpriseAccess } from './enterprise-access-api.js';
import { createEnterpriseOidc, type EnterpriseOidcProvider } from './enterprise-oidc.js';
import { createEnterpriseWeb } from './enterprise-web.js';

export interface EnterpriseHostOptions {
  readonly workflows?: EnterpriseWorkflowService;
  readonly knowledge?: EnterpriseKnowledgeService;
  readonly artifacts?: EnterpriseArtifactService;
  readonly experiences?: EnterpriseExperienceService;
  readonly goals?: EnterpriseGoalService;
  readonly operating?: EnterpriseOperatingService;
  readonly evaluation?: EnterpriseEvaluationRuntime;
  readonly executionRuntime?: EnterpriseExecutionRuntime;
  readonly businessProviders?: EnterpriseProviderService;
  readonly repository: EnterpriseRepository;
  readonly origin: string;
  readonly profile: 'development' | 'hosted';
  readonly providers: Readonly<Record<string, EnterpriseOidcProvider>>;
  readonly loginOrganizations?: EnterpriseContractTypes['EnterpriseLoginDirectory']['organizations'];
  readonly webRoot?: string;
  readonly now?: () => string;
}
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCookie(value: string, keys: readonly string[]): Record<string, string> {
  try {
    const object: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length !== keys.length
      || keys.some(key => typeof (object as Record<string, unknown>)[key] !== 'string' || !(object as Record<string, string>)[key]
        || (object as Record<string, string>)[key]!.length > 300)) throw new Error();
    return object as Record<string, string>;
  } catch { throw new EnterpriseError('AUTHENTICATION_REQUIRED', 401); }
}
function cookieValue(request: Request, name: string): string | undefined {
  const found = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (found.length > 1) throw new EnterpriseError('AUTHENTICATION_REQUIRED', 401);
  return found[0]?.slice(name.length + 1);
}
const requestBodyLimit = (path: string) => {
  if (/^\/v2\/workspaces\/[^/]+\/knowledge$/u.test(path)) return 13 * 1024 * 1024;
  if (/^\/v2\/workspaces\/[^/]+\/workflows\/versions$/u.test(path) || /^\/v2\/artifacts\/[^/]+\/experiences$/u.test(path)) return 1024 * 1024;
  if (/^\/v2\/workspaces\/[^/]+\/(business\/commands|business-command-checks|goals)$/u.test(path) || /^\/v2\/goals\/[^/]+\/(plans|scope-revisions)$/u.test(path) || /^\/v2\/artifacts\/[^/]+\/acceptances$/u.test(path)) return 262144;
  return 16384;
};
async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new EnterpriseError('INVALID_CONTENT_TYPE', 415);
  const reader = request.body?.getReader(); if (!reader) throw new EnterpriseError('INVALID_BODY', 400);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > requestBodyLimit(new URL(request.url).pathname)) { await reader.cancel(); throw new EnterpriseError('REQUEST_TOO_LARGE', 413); }
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof EnterpriseError) throw error; throw new EnterpriseError('INVALID_BODY', 400); }
  finally { reader.releaseLock(); }
}
const parse = <K extends keyof EnterpriseContractTypes>(name: K, value: unknown) => {
  try { return parseEnterpriseContract(name, value); } catch { throw new EnterpriseError('INVALID_BODY', 400); }
};

/** The same Host composition root owns authentication, application services and future Workers. */
export function createEnterpriseHost(options: EnterpriseHostOptions) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.username || origin.password || !['hosted', 'development'].includes(options.profile)
    || (origin.protocol !== 'https:' && !(options.profile === 'development' && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
    throw new Error('企业 Host 需要明确的安全来源；开发 HTTP 仅限回环地址');
  const secure = origin.protocol === 'https:';
  let loginOrganizations: EnterpriseContractTypes['EnterpriseLoginDirectory']['organizations'];
  try {
    const directory = parseEnterpriseContract('EnterpriseLoginDirectory', { organizations: options.loginOrganizations === undefined ? [] : options.loginOrganizations });
    if (new Set(directory.organizations.map(item => item.id)).size !== directory.organizations.length
      || directory.organizations.some(item => !Object.hasOwn(options.providers, item.id))) throw new Error();
    loginOrganizations = structuredClone(directory.organizations);
  } catch { throw new EnterpriseError('LOGIN_DIRECTORY_INVALID', 503); }
  const web = options.webRoot === undefined ? undefined : createEnterpriseWeb(options.webRoot);
  const sessionName = secure ? '__Host-mn-enterprise-session' : 'mn-enterprise-dev-session';
  const loginName = secure ? '__Host-mn-enterprise-login' : 'mn-enterprise-dev-login';
  const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const identity = new EnterpriseIdentityService(options), auth = new BrowserAuthService(options), permissions = new EnterprisePermissionService(options), quotas = new EnterpriseQuotaService(options);
  const business = new EnterpriseBusinessService(options);
  const executionConfiguration = new EnterpriseExecutionConfigurationService(options);
  const oidc = createEnterpriseOidc({ providers: options.providers, redirectUri: `${options.origin}/v2/auth/callback`, development: options.profile === 'development' });
  const headers = () => new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  const reply = (data: unknown, status: number, traceId: string, schema?: keyof EnterpriseContractTypes) => {
    if (schema) parseEnterpriseContract(schema, data);
    const h = headers(); h.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ data, traceId }), { status, headers: h });
  };
  function requireOrigin(request: Request): void {
    if (request.headers.get('origin') !== options.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new EnterpriseError('CSRF_ORIGIN_REJECTED');
  }
  let server: Server | undefined;
  const dispatch = async (request: Request): Promise<Response> => {
    const traceId = randomUUID();
    let callback = false;
    try {
      const url = new URL(request.url);
      if (url.origin !== options.origin) throw new EnterpriseError('REQUEST_ORIGIN_INVALID', 400);
      if (web && !url.pathname.startsWith('/v2')) return await web(request);
      if (request.method === 'GET' && url.pathname === '/v2/auth/organizations') {
        if (url.search) throw new EnterpriseError('INVALID_QUERY', 400);
        return reply({ organizations: loginOrganizations }, 200, traceId, 'EnterpriseLoginDirectory');
      }
      if (request.method === 'GET' && url.pathname === '/v2/openapi.json') {
        const h = headers(); h.set('Content-Type', 'application/json'); return new Response(JSON.stringify(createEnterpriseOpenApiDocument()), { headers: h });
      }
      if (request.method === 'GET' && url.pathname === '/v2/health') return reply({ status: 'healthy', profile: options.profile }, 200, traceId, 'EnterpriseHealthView');
      if (request.method === 'GET' && url.pathname === '/v2/auth/login') {
        const tenantId = url.searchParams.get('organizationId');
        if (!tenantId || [...url.searchParams.keys()].some(key => !['organizationId', 'returnTo'].includes(key))
          || new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw new EnterpriseError('INVALID_QUERY', 400);
        const returnTo = url.searchParams.get('returnTo') ?? '/';
        if (!returnTo.startsWith('/') || returnTo.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(returnTo)
          || new URL(returnTo, options.origin).origin !== options.origin) throw new EnterpriseError('INVALID_RETURN_PATH', 400);
        if (!Object.hasOwn(options.providers, tenantId)) throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
        const attempt = await auth.startLogin(tenantId, returnTo);
        const location = await oidc.authorizationUrl(tenantId, attempt);
        const h = headers(); h.set('Location', location);
        h.append('Set-Cookie', cookie(loginName, base64({ tenantId, id: attempt.id, secret: attempt.browserSecret }), 600));
        return new Response(null, { status: 302, headers: h });
      }
      if (request.method === 'GET' && url.pathname === '/v2/auth/callback') {
        callback = true;
        const value = cookieValue(request, loginName);
        if (!value || url.searchParams.getAll('state').length !== 1) throw new EnterpriseError('LOGIN_ATTEMPT_INVALID', 401);
        const login = decodeCookie(value, ['tenantId', 'id', 'secret']);
        const attempt = await auth.claimLogin(login.tenantId!, login.id!, login.secret!, url.searchParams.get('state')!);
        const proof = await oidc.exchange(login.tenantId!, url, attempt);
        const result = await auth.createSession(login.tenantId!, proof);
        const h = headers(); h.set('Location', new URL(attempt.returnTo, options.origin).href);
        h.append('Set-Cookie', cookie(sessionName, base64({ tenantId: login.tenantId, token: result.token }), 28800));
        h.append('Set-Cookie', cookie(loginName, '', 0));
        return new Response(null, { status: 303, headers: h });
      }
      if (!['GET', 'POST'].includes(request.method)) throw new EnterpriseError('ROUTE_NOT_FOUND', 404);
      if (request.method === 'POST') requireOrigin(request);
      const rawSession = cookieValue(request, sessionName);
      if (!rawSession) throw new EnterpriseError('AUTHENTICATION_REQUIRED', 401);
      const decoded = decodeCookie(rawSession, ['tenantId', 'token']);
      const current = await auth.resolveSession(decoded.tenantId!, decoded.token!);
      if (request.method === 'POST' && !equalOpaque(request.headers.get('x-csrf-token') ?? '', current.session.csrfToken)) throw new EnterpriseError('CSRF_TOKEN_REJECTED');
      if (request.method === 'POST' && url.pathname === '/v2/auth/logout') {
        await auth.logout(decoded.tenantId!, decoded.token!); const h = headers(); h.append('Set-Cookie', cookie(sessionName, '', 0));
        return new Response(null, { status: 204, headers: h });
      }
      const matched = ENTERPRISE_HTTP_OPERATIONS.map(operation => ({ operation,
        match: new RegExp(`^${operation.path.replace(/\{[^}]+\}/gu, '([^/]+)')}$`, 'u').exec(url.pathname) }))
        .find(item => item.operation.method === request.method.toLowerCase() && item.match);
      if (!matched) throw new EnterpriseError('ROUTE_NOT_FOUND', 404);
      if (url.search) throw new EnterpriseError('INVALID_QUERY', 400);
      const op = matched.operation;
      const params: Record<string, string> = {};
      try { [...op.path.matchAll(/\{([^}]+)\}/gu)].forEach((part, i) => { params[part[1]!] = decodeURIComponent(matched.match![i + 1]!); }); }
      catch { throw new EnterpriseError('INVALID_PATH', 400); }
      if (params.organizationId && params.organizationId !== current.actor.tenantId) throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
      const key = request.headers.get('idempotency-key')?.trim();
      if (op.mutation && (!key || key.length > 200)) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
      const input = 'body' in op ? parse(op.body, await body(request)) : undefined;
      const access = await dispatchEnterpriseAccess({ operationId: op.id, params, input, actor: current.actor, key, permissions, quotas });
      if (access.handled) return reply(access.value, 200, traceId, op.response);
      const businessResult = await dispatchEnterpriseBusiness({ operationId: op.id, params, input, actor: current.actor, key, business });
      if (businessResult.handled) return reply(businessResult.value, 200, traceId, op.response);
      const executionResult = await dispatchEnterpriseExecution({operationId:op.id,params,input,actor:current.actor,key,configuration:executionConfiguration,runtime:options.executionRuntime});
      if(executionResult.handled)return reply(executionResult.value,200,traceId,op.response);
      const providerResult = await dispatchEnterpriseProviders({ operationId: op.id, params, input, actor: current.actor, key, businessProviders: options.businessProviders });
      if (providerResult.handled) return reply(providerResult.value, 200, traceId, op.response);
      const operatingResult = await dispatchEnterpriseOperating({ operationId: op.id, params, input, actor: current.actor, key, operating: options.operating, evaluation: options.evaluation });
      if (operatingResult.handled) return reply(operatingResult.value, 200, traceId, op.response);
      const goalsResult = await dispatchEnterpriseGoals({ operationId: op.id, params, input, actor: current.actor, key, goals: options.goals });
      if (goalsResult.handled) return reply(goalsResult.value, 200, traceId, op.response);
      const knowledgeResult = await dispatchEnterpriseKnowledge({ operationId: op.id, params, input, actor: current.actor, key, knowledge: options.knowledge, artifacts: options.artifacts, experiences: options.experiences });
      if (knowledgeResult.handled) return reply(knowledgeResult.value, 200, traceId, op.response);
      const workflowResult = await dispatchEnterpriseWorkflows({ operationId: op.id, params, input, actor: current.actor, key, workflows: options.workflows });
      if (workflowResult.handled) return reply(workflowResult.value, 200, traceId, op.response);
      let data: unknown;
      switch (op.id) {
        case 'enterpriseSession': data = { tenantId: current.actor.tenantId, principalId: current.member.id, displayName: current.member.displayName,
          status: current.member.status, organizationAdmin: current.member.organizationAdmin, csrfToken: current.session.csrfToken, expiresAt: current.session.expiresAt, profile: options.profile }; break;
        case 'listOrganizations': data = [await identity.organization(current.actor)]; break;
        case 'listEnterpriseWorkspaces': data = await identity.listWorkspaces(current.actor); break;
        case 'createEnterpriseWorkspace': {
          const workspace = await identity.createWorkspace(current.actor, key!, input as EnterpriseContractTypes['EnterpriseWorkspaceCreate']);
          if (options.businessProviders) await options.businessProviders.initialize(current.actor, workspace.id, 0, 'workspace-binding:' + opaqueHash(canonicalJson([current.actor.principalId, workspace.id, key])));
          data = workspace; break;
        }
        case 'listOrganizationMembers': data = await identity.listMembers(current.actor); break;
        case 'inviteOrganizationMember': data = await identity.invite(current.actor, key!, { ...input as EnterpriseContractTypes['OrganizationInvitationCreate'],
          id: opaqueHash(canonicalJson(['member', current.actor.tenantId, current.actor.principalId, key])) }); break;
        case 'acceptOrganizationInvitation': {
          const value = input as EnterpriseContractTypes['OrganizationInvitationAccept'];
          data = await identity.acceptInvitation(current.actor, key!, params.memberId!, value.expectedStreamVersion, value.token); break;
        }
        case 'commandOrganizationMember': {
          const value = input as EnterpriseContractTypes['OrganizationMemberCommand'];
          data = await identity.commandMember(current.actor, key!, params.memberId!, value.expectedStreamVersion,
            value.type === 'rebind' ? { type: 'rebind', subject: value.subject } : { type: value.type }); break;
        }
        default: throw new EnterpriseError('ROUTE_NOT_FOUND', 404);
      }
      return reply(data, ['createEnterpriseWorkspace', 'inviteOrganizationMember'].includes(op.id) ? 201 : 200, traceId, op.response);
    } catch (error) {
      const own = error instanceof EnterpriseError, kernel = error instanceof KernelError || error instanceof EnterprisePlanError;
      const status = own ? error.status : kernel ? (/NOT_FOUND/u.test(error.code)?404:/AUTHORIZATION_REVOKED|FORBIDDEN|HUMAN_APPROVAL/u.test(error.code)?403:409) : callback ? 401 : 503;
      const code = own || kernel ? error.code : callback ? 'AUTHENTICATION_FAILED' : 'SERVICE_UNAVAILABLE';
      const h = headers(); h.set('Content-Type', 'application/json; charset=utf-8');
      if (callback) h.append('Set-Cookie', cookie(loginName, '', 0));
      return new Response(JSON.stringify({ code, message: status === 401 ? '登录已失效，请重新登录' : '请求未完成，请核对权限、版本或服务状态',
        action: status === 401 ? '重新登录' : '核对当前数据、权限和配置', fieldIssues: [], traceId,
        retryable: code === 'STREAM_VERSION_CONFLICT' || code === 'CONCURRENT_COMMAND_RETRY' || code === 'CONCURRENT_READ_RETRY' || code === 'SERVICE_UNAVAILABLE' }), { status, headers: h });
    }
  };
  return { identity, permissions, quotas, executionConfiguration, executionRuntime:options.executionRuntime, businessProviders: options.businessProviders, operating: options.operating, dispatch,
    async listen(input: { host?: string; port: number }) {
      if (server) throw new Error('Host 已启动');
      server = createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (incoming, outgoing) => {
        try {
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of incoming) { size += chunk.length; if (size > requestBodyLimit(new URL(incoming.url ?? '/', options.origin).pathname)) { outgoing.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
          const h = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) h.set(name, Array.isArray(value) ? value.join(', ') : value);
          const request = new Request(new URL(incoming.url ?? '/', options.origin), { method: incoming.method, headers: h,
            ...(!['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}) });
          const response = await dispatch(request); outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => { if (name !== 'set-cookie') outgoing.setHeader(name, value); });
          if (response.headers.getSetCookie().length) outgoing.setHeader('set-cookie', response.headers.getSetCookie());
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch { outgoing.writeHead(500, { 'Cache-Control': 'no-store' }).end(); }
      });
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(input.port, input.host ?? '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host 地址无效');
      return { host: input.host ?? '127.0.0.1', port: address.port };
    },
    async close() { const active = server; server = undefined; if (active) { active.closeAllConnections(); await new Promise<void>((resolve, reject) => active.close(error => error ? reject(error) : resolve())); } },
  };
}
