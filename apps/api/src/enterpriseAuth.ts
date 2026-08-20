import { createPublicKey, verify } from "node:crypto";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";
import type { RequestContext } from "@mn/core";

export type EnterpriseRole = RequestContext["roles"][number];
export type WorkerScope = RequestContext["scopes"][number];

export interface EnterpriseAuthOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly tenantClaim?: string;
  readonly rolesClaim?: string;
  readonly projectsClaim?: string;
  readonly principalTypeClaim?: string;
  readonly scopesClaim?: string;
  readonly clockToleranceSeconds?: number;
  readonly jwksCacheMs?: number;
  readonly fetchJwks?: (url: string) => Promise<unknown>;
}

interface JsonWebKeySet {
  readonly keys: readonly NodeJsonWebKey[];
}

interface JwtHeader {
  readonly alg: "RS256" | "EdDSA";
  readonly kid: string;
  readonly typ?: string;
}

interface JwtClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [claim: string]: unknown;
}

const ROLES = new Set<EnterpriseRole>([
  "org_admin",
  "governance_admin",
  "project_owner",
  "developer",
  "reviewer",
  "auditor"
]);
const WORKER_SCOPES = new Set<WorkerScope>([
  "run_jobs:claim",
  "run_jobs:heartbeat",
  "run_jobs:checkpoint",
  "run_jobs:finish",
  "run_jobs:events",
  "run_jobs:release"
]);

function decodeJson(segment: string, field: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    throw new TypeError(`JWT ${field} is not valid base64url JSON`, { cause: error });
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringClaim(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

const RESERVED_TENANT_IDS = new Set(["builtin", "local", "system", "unknown"]);

function enterpriseTenantClaim(value: unknown, field: string): string {
  const tenantId = stringClaim(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tenantId)) {
    throw new TypeError(`${field} must be a safe enterprise tenant identifier`);
  }
  if (RESERVED_TENANT_IDS.has(tenantId.normalize("NFKC").toLowerCase())) {
    throw new TypeError(`${field} uses a reserved tenant identifier`);
  }
  return tenantId;
}

function stringArrayClaim(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const items = value.map((item, index) => stringClaim(item, `${field}[${index}]`));
  if (new Set(items).size !== items.length) throw new TypeError(`${field} must be unique`);
  return items;
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(
    authorization ?? ""
  );
  if (!match?.[1]) throw new TypeError("A Bearer JWT is required");
  return match[1];
}

export class EnterpriseJwtAuthenticator {
  #cached?: { expiresAt: number; keys: ReadonlyMap<string, NodeJsonWebKey> };

  constructor(private readonly options: EnterpriseAuthOptions) {
    for (const [field, value] of [
      ["issuer", options.issuer],
      ["audience", options.audience],
      ["jwksUrl", options.jwksUrl]
    ] as const) {
      stringClaim(value, `auth.${field}`);
    }
  }

  async authenticate(
    authorization: string | undefined,
    traceId: string,
    now = Date.now()
  ): Promise<RequestContext> {
    const token = bearerToken(authorization);
    const segments = token.split(".");
    if (segments.length !== 3) throw new TypeError("JWT must contain three segments");
    const headerValue = record(decodeJson(segments[0]!, "header"), "JWT header");
    if (
      (headerValue.alg !== "RS256" && headerValue.alg !== "EdDSA") ||
      typeof headerValue.kid !== "string" ||
      headerValue.kid.length === 0
    ) {
      throw new TypeError("JWT alg and kid are required and must be trusted");
    }
    const header = headerValue as unknown as JwtHeader;
    const keys = await this.keys(now);
    const jwk = keys.get(header.kid);
    if (!jwk) throw new TypeError("JWT signing key is not trusted");
    if (
      (header.alg === "RS256" && jwk.kty !== "RSA") ||
      (header.alg === "EdDSA" && jwk.kty !== "OKP")
    ) {
      throw new TypeError("JWT algorithm does not match its signing key");
    }
    const signed = Buffer.from(`${segments[0]}.${segments[1]}`);
    const signature = Buffer.from(segments[2]!, "base64url");
    const valid = verify(
      header.alg === "RS256" ? "RSA-SHA256" : null,
      signed,
      createPublicKey({ key: jwk, format: "jwk" }),
      signature
    );
    if (!valid) throw new TypeError("JWT signature is invalid");

    const claimsValue = record(decodeJson(segments[1]!, "claims"), "JWT claims");
    const claims = claimsValue as unknown as JwtClaims;
    const tolerance = this.options.clockToleranceSeconds ?? 30;
    const seconds = Math.floor(now / 1_000);
    if (claims.iss !== this.options.issuer) throw new TypeError("JWT issuer is invalid");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.options.audience)) {
      throw new TypeError("JWT audience is invalid");
    }
    stringClaim(claims.sub, "JWT sub");
    if (!Number.isSafeInteger(claims.exp) || claims.exp < seconds - tolerance) {
      throw new TypeError("JWT is expired or has no valid exp");
    }
    if (
      claims.nbf !== undefined &&
      (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds + tolerance)
    ) {
      throw new TypeError("JWT is not active yet");
    }
    const tenantClaim = this.options.tenantClaim ?? "tenant_id";
    const rolesClaim = this.options.rolesClaim ?? "roles";
    const projectsClaim = this.options.projectsClaim ?? "project_ids";
    const principalTypeClaim = this.options.principalTypeClaim ?? "principal_type";
    const scopesClaim = this.options.scopesClaim ?? "scopes";
    const principalTypeValue = claims[principalTypeClaim] ?? "human";
    if (principalTypeValue !== "human" && principalTypeValue !== "worker") {
      throw new TypeError("JWT principal_type must be human or worker");
    }
    const principalType = principalTypeValue;
    const roles = stringArrayClaim(claims[rolesClaim], `JWT ${rolesClaim}`);
    if (roles.some((role) => !ROLES.has(role as EnterpriseRole))) {
      throw new TypeError("JWT contains an unsupported enterprise role");
    }
    const scopes = stringArrayClaim(claims[scopesClaim] ?? [], `JWT ${scopesClaim}`);
    if (scopes.some((scope) => !WORKER_SCOPES.has(scope as WorkerScope))) {
      throw new TypeError("JWT contains an unsupported worker scope");
    }
    if (principalType === "worker" && roles.length > 0) {
      throw new TypeError("worker principal cannot contain human roles");
    }
    if (principalType === "worker" && scopes.length === 0) {
      throw new TypeError("worker principal requires at least one queue scope");
    }
    if (principalType === "human" && scopes.length > 0) {
      throw new TypeError("human principal cannot contain worker scopes");
    }
    return Object.freeze({
      tenantId: enterpriseTenantClaim(claims[tenantClaim], `JWT ${tenantClaim}`),
      actorId: claims.sub,
      roles: roles as EnterpriseRole[],
      projectIds: stringArrayClaim(claims[projectsClaim] ?? [], `JWT ${projectsClaim}`),
      principalType,
      scopes: scopes as WorkerScope[],
      authentication: "oidc",
      traceId
    });
  }

  async #loadKeys(): Promise<ReadonlyMap<string, NodeJsonWebKey>> {
    const raw = this.options.fetchJwks
      ? await this.options.fetchJwks(this.options.jwksUrl)
      : await fetch(this.options.jwksUrl).then(async (response) => {
          if (!response.ok) throw new Error(`JWKS endpoint returned ${response.status}`);
          return response.json() as Promise<unknown>;
        });
    const jwks = record(raw, "JWKS") as unknown as JsonWebKeySet;
    if (!Array.isArray(jwks.keys)) throw new TypeError("JWKS keys must be an array");
    const keys = new Map<string, NodeJsonWebKey>();
    for (const [index, key] of jwks.keys.entries()) {
      const candidate = record(key, `JWKS keys[${index}]`) as NodeJsonWebKey & {
        kid?: string;
        use?: string;
      };
      const kid = stringClaim(candidate.kid, `JWKS keys[${index}].kid`);
      if (candidate.use !== undefined && candidate.use !== "sig") continue;
      if (keys.has(kid)) throw new TypeError(`JWKS contains duplicate kid ${kid}`);
      keys.set(kid, candidate);
    }
    return keys;
  }

  async keys(now = Date.now()): Promise<ReadonlyMap<string, NodeJsonWebKey>> {
    if (this.#cached && this.#cached.expiresAt > now) return this.#cached.keys;
    const keys = await this.#loadKeys();
    this.#cached = {
      expiresAt: now + (this.options.jwksCacheMs ?? 300_000),
      keys
    };
    return keys;
  }
}

export function localRequestContext(traceId: string): RequestContext {
  return Object.freeze({
    tenantId: "local",
    actorId: "local-user",
    roles: ["org_admin" as const],
    projectIds: [],
    principalType: "human",
    scopes: [],
    authentication: "local",
    traceId
  });
}

/** Enterprise authorization separates machine queue credentials from human
 * roles. A worker token is unusable outside its explicitly scoped queue
 * operations, and human role tokens cannot impersonate workers. */
export function principalAllows(
  context: RequestContext,
  method: string,
  pathname: string
): boolean {
  const requiredScope = queueScopeForRoute(method, pathname);
  if (context.principalType === "worker") {
    return requiredScope !== undefined && context.scopes.includes(requiredScope);
  }
  // Queue/fleet reads are control-plane observability and retain normal human
  // RBAC. Only state-changing queue operations are machine-principal-only.
  if (
    requiredScope !== undefined &&
    method.toUpperCase() !== "GET" &&
    method.toUpperCase() !== "HEAD"
  ) {
    return false;
  }
  return roleAllows(context.roles, method, pathname);
}

/**
 * A worker credential identifies a machine principal. Replicas that share the
 * same credential may append a bounded instance name so queue leases remain
 * independently recoverable. The credential already grants equal authority
 * to every replica, so the suffix is an ownership discriminator, not a new
 * security boundary.
 */
export function workerOwnerMatchesPrincipal(
  ownerId: unknown,
  actorId: string
): ownerId is string {
  if (ownerId === actorId) return true;
  if (typeof ownerId !== "string" || !ownerId.startsWith(`${actorId}@`)) {
    return false;
  }
  const instanceId = ownerId.slice(actorId.length + 1);
  return (
    ownerId.length <= 256 &&
    instanceId.length >= 1 &&
    instanceId.length <= 253 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(instanceId)
  );
}

function queueScopeForRoute(method: string, pathname: string): WorkerScope | undefined {
  const normalized = method.toUpperCase();
  if (normalized === "GET" || normalized === "HEAD") {
    if (/^\/v1\/run-jobs\/queue(?:\/[^/]+)?$/u.test(pathname)) {
      return "run_jobs:claim";
    }
    if (pathname === "/v1/run-jobs/workers") return "run_jobs:heartbeat";
  }
  if (normalized !== "POST") return undefined;
  if (pathname === "/v1/run-jobs/queue/claim") return "run_jobs:claim";
  if (pathname === "/v1/run-jobs/workers/heartbeat") return "run_jobs:heartbeat";
  if (
    /^\/v1\/run-jobs\/queue\/[^/]+\/builtin-executions(?:\/[^/]+\/(?:poll|tool-results|cancel))?$/u.test(pathname)
  ) {
    return "run_jobs:checkpoint";
  }
  const action = /^\/v1\/run-jobs\/queue\/[^/]+\/(heartbeat|release|events|artifacts|measurements|usage-receipts|update|finish|sandbox-runtime-proof|source-snapshot|resume-diff)$/u.exec(
    pathname
  )?.[1];
  switch (action) {
    case "heartbeat": return "run_jobs:heartbeat";
    case "release": return "run_jobs:release";
    case "events": return "run_jobs:events";
    case "artifacts": return "run_jobs:checkpoint";
    case "measurements": return "run_jobs:checkpoint";
    case "usage-receipts": return "run_jobs:checkpoint";
    case "update": return "run_jobs:checkpoint";
    case "sandbox-runtime-proof": return "run_jobs:checkpoint";
    case "source-snapshot": return "run_jobs:checkpoint";
    case "resume-diff": return "run_jobs:checkpoint";
    case "finish": return "run_jobs:finish";
    default: return undefined;
  }
}

export function roleAllows(
  roles: readonly EnterpriseRole[],
  method: string,
  pathname: string
): boolean {
  if (roles.includes("org_admin")) return true;
  // Provider endpoints expose account routing and secret-backed configuration.
  // They are tenant administration operations, never generic read-only data.
  if (/^\/v1\/providers(?:\/|$)/u.test(pathname)) return false;
  const readOnly = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const evidencePath = /^\/v1\/(?:eval-assets|trace-graphs|maturity-report|learning-proposals)(?:\/|$)/u.test(
    pathname
  );
  const usageEvidencePath = /^\/v1\/(?:proxy\/logs|usage\/(?:summary|requests|models))$/u.test(
    pathname
  ) || /^\/v1\/provider-usage\/requests\/[^/]+$/u.test(pathname);
  const evidenceContribution =
    method === "POST" &&
    (/^\/v1\/(?:eval-assets|trace-graphs|maturity-report)$/u.test(pathname) ||
      /^\/v1\/learning-proposals(?:$|\/[^/]+\/submit$)/u.test(pathname));
  const agentApprovalDecision =
    method === "POST" &&
    /^\/v1\/agent-sessions\/[^/]+\/approvals\/[^/]+$/u.test(pathname);
  if (roles.includes("auditor")) return readOnly;
  if (
    roles.includes("governance_admin") &&
    (/^\/v1\/(?:standard-packs|waivers|learning-proposals|audit-events)/u.test(pathname) ||
      /\/effective-governance$|\/policy\/explain$/u.test(pathname) ||
      (readOnly && usageEvidencePath))
  ) {
    return true;
  }
  if (
    roles.includes("reviewer") &&
    (readOnly || agentApprovalDecision || /\/approve$|\/review$|\/canary$/u.test(pathname))
  ) {
    return true;
  }
  if (roles.includes("project_owner")) {
    return (
      /^\/v1\/(?:projects|tasks|runs|run-jobs|spec-sets)/u.test(pathname) ||
      (readOnly && (evidencePath || usageEvidencePath)) ||
      evidenceContribution
    );
  }
  if (roles.includes("developer")) {
    if (readOnly) return !/^\/v1\/(?:audit-events|standard-packs|waivers)/u.test(pathname);
    return (
      /^\/v1\/(?:tasks|runs|projects\/[^/]+\/index)/u.test(pathname) ||
      evidenceContribution
    );
  }
  return false;
}
