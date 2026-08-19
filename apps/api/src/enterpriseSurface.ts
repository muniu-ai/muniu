import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { RunRecord } from "@mn/core";

interface EnterpriseRouteRule {
  readonly methods: ReadonlySet<string>;
  readonly pathname: RegExp;
}

const get = new Set(["GET", "HEAD"]);
const post = new Set(["POST"]);
const getPost = new Set(["GET", "HEAD", "POST"]);
const resourceId = "[^/]+";

/**
 * The enterprise process intentionally exposes only the governed increment
 * control plane. Keep this list method-aware: adding a local desktop route to
 * server.ts must not silently make it remotely reachable.
 */
const ENTERPRISE_ROUTE_RULES: readonly EnterpriseRouteRule[] = Object.freeze([
  { methods: get, pathname: /^\/v1\/(?:capabilities|workflows|harness-profiles)$/u },

  { methods: get, pathname: /^\/v1\/standard-packs$/u },
  {
    methods: post,
    pathname: /^\/v1\/standard-packs\/(?:validate|import|diff|activate)$/u
  },
  { methods: getPost, pathname: /^\/v1\/waivers$/u },

  { methods: getPost, pathname: /^\/v1\/spec-sets$/u },
  { methods: get, pathname: new RegExp(`^/v1/spec-sets/${resourceId}$`, "u") },
  {
    methods: post,
    pathname: new RegExp(`^/v1/spec-sets/${resourceId}/revisions$`, "u")
  },
  {
    methods: get,
    pathname: new RegExp(`^/v1/spec-sets/${resourceId}/revisions/[1-9][0-9]*$`, "u")
  },
  {
    methods: post,
    pathname: new RegExp(
      `^/v1/spec-sets/${resourceId}/revisions/[1-9][0-9]*/approve$`,
      "u"
    )
  },

  { methods: post, pathname: /^\/v1\/projects$/u },
  { methods: get, pathname: new RegExp(`^/v1/projects/${resourceId}$`, "u") },
  {
    methods: post,
    pathname: new RegExp(`^/v1/projects/${resourceId}/index$`, "u")
  },
  {
    methods: get,
    pathname: new RegExp(
      `^/v1/projects/${resourceId}/(?:standards-lock|effective-governance|policy/explain)$`,
      "u"
    )
  },

  { methods: post, pathname: /^\/v1\/tasks$/u },
  { methods: get, pathname: new RegExp(`^/v1/tasks/${resourceId}$`, "u") },
  {
    methods: post,
    pathname: new RegExp(`^/v1/tasks/${resourceId}/runs$`, "u")
  },

  { methods: get, pathname: /^\/v1\/run-jobs\/(?:queue|workers)$/u },
  { methods: post, pathname: /^\/v1\/run-jobs\/(?:queue\/claim|workers\/heartbeat)$/u },
  {
    methods: get,
    pathname: new RegExp(`^/v1/run-jobs/queue/${resourceId}$`, "u")
  },
  {
    methods: post,
    pathname: new RegExp(
      `^/v1/run-jobs/queue/${resourceId}/(?:heartbeat|release|events|artifacts|measurements|usage-receipts|update|finish|sandbox-runtime-proof|source-snapshot)$`,
      "u"
    )
  },

  { methods: get, pathname: new RegExp(`^/v1/runs/${resourceId}$`, "u") },
  {
    methods: get,
    pathname: new RegExp(`^/v1/runs/${resourceId}/events(?:/stream)?$`, "u")
  },
  {
    methods: post,
    pathname: new RegExp(`^/v1/runs/${resourceId}/(?:approve|cancel|resume)$`, "u")
  },
  {
    methods: get,
    pathname: new RegExp(
      `^/v1/runs/${resourceId}/artifacts(?:/archive|/${resourceId})?$`,
      "u"
    )
  },

  { methods: get, pathname: /^\/v1\/audit-events$/u },
  // Provider credentials remain an org-admin operation via roleAllows; the
  // enterprise surface exposes only create/list, not desktop projection or
  // takeover endpoints.
  { methods: getPost, pathname: /^\/v1\/providers$/u },
  {
    methods: get,
    pathname: /^\/v1\/(?:proxy\/logs|usage\/(?:summary|requests|models))$/u
  },
  {
    methods: get,
    pathname: new RegExp(`^/v1/provider-usage/requests/${resourceId}$`, "u")
  },
  {
    methods: post,
    pathname: new RegExp(`^/v1/provider-usage/requests/${resourceId}/reconcile$`, "u")
  },
  { methods: getPost, pathname: /^\/v1\/(?:eval-assets|trace-graphs)$/u },
  {
    methods: get,
    pathname: new RegExp(`^/v1/(?:eval-assets|trace-graphs)/${resourceId}$`, "u")
  },
  { methods: getPost, pathname: /^\/v1\/learning-proposals$/u },
  {
    methods: get,
    pathname: new RegExp(`^/v1/learning-proposals/${resourceId}$`, "u")
  },
  {
    methods: post,
    pathname: new RegExp(
      `^/v1/learning-proposals/${resourceId}/(?:submit|review|canary|promote|rollback)$`,
      "u"
    )
  },
  { methods: getPost, pathname: /^\/v1\/maturity-report$/u }
]);

export function enterpriseRouteAllows(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  for (const rule of ENTERPRISE_ROUTE_RULES) {
    if (!rule.pathname.test(pathname)) continue;
    if (normalizedMethod === "OPTIONS") return true;
    return rule.methods.has(normalizedMethod);
  }
  return false;
}

function assertSafeAbsolutePath(value: string, field: string): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new TypeError(`${field} must be a non-empty absolute path`);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/** Resolve configured roots at startup so a later symlink change cannot widen policy. */
export function normalizeEnterpriseProjectRoots(
  configuredRoots: readonly string[]
): readonly string[] {
  if (configuredRoots.length === 0) {
    throw new Error("Enterprise profile requires at least one allowed project root");
  }
  const roots = configuredRoots.map((configuredRoot, index) => {
    assertSafeAbsolutePath(configuredRoot, `enterpriseProjectRoots[${index}]`);
    const root = realpathSync(resolve(configuredRoot));
    if (!statSync(root).isDirectory()) {
      throw new TypeError(`enterpriseProjectRoots[${index}] must be a directory`);
    }
    return root;
  });
  return Object.freeze([...new Set(roots)].sort());
}

/**
 * Canonicalize an enterprise project path and prove it is contained by an
 * administrator-configured repository root. Both lexical traversal and
 * symlink escape are rejected, even if the target happens to exist.
 */
export async function resolveEnterpriseProjectRoot(
  requestedRoot: string,
  allowedRoots: readonly string[]
): Promise<string> {
  assertSafeAbsolutePath(requestedRoot, "project.rootPath");
  if (requestedRoot.split(/[\\/]+/u).includes("..")) {
    throw new TypeError("project.rootPath must not contain path traversal");
  }
  let canonical: string;
  try {
    canonical = await realpath(resolve(requestedRoot));
    if (!(await stat(canonical)).isDirectory()) {
      throw new TypeError("project.rootPath must be a directory");
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("project.rootPath must resolve to an existing directory", {
      cause: error
    });
  }
  if (!allowedRoots.some((root) => isWithinRoot(canonical, root))) {
    throw new TypeError("project.rootPath is outside the enterprise project root allowlist");
  }
  return canonical;
}

function canonicalPathIfPresent(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function safeWorkspacePath(path: unknown, field: string): string | undefined {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path !== path.trim() ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    path.split(/[\\/]+/u).includes("..")
  ) {
    return `${field} must be an absolute traversal-free workspace path`;
  }
  return undefined;
}

function sandboxWorkspaceUriError(
  value: unknown,
  field: string,
  allowedLeaseIds: ReadonlySet<string>
): string | undefined {
  if (typeof value !== "string" || !value.startsWith("mn://sandbox/")) {
    return `${field} is not an mn sandbox workspace URI`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${field} is not a valid mn sandbox workspace URI`;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const leaseId = segments[0];
  let decodedLeaseId: string | undefined;
  let decodedPath: string[];
  try {
    decodedLeaseId = leaseId ? decodeURIComponent(leaseId) : undefined;
    decodedPath = segments.slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return `${field} is not a valid mn sandbox workspace URI`;
  }
  if (
    parsed.protocol !== "mn:" ||
    parsed.hostname !== "sandbox" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !leaseId ||
    decodedLeaseId === undefined ||
    !allowedLeaseIds.has(decodedLeaseId) ||
    decodedPath.some((segment) =>
      segment === "." || segment === ".." || segment.includes("\0")
    )
  ) {
    return `${field} is not bound to a reported sandbox lease`;
  }
  return undefined;
}

function workspaceLocationError(
  value: unknown,
  field: string,
  projectRoot: string,
  allowedLeaseIds: ReadonlySet<string>
): string | undefined {
  if (typeof value === "string" && value.startsWith("mn://")) {
    return sandboxWorkspaceUriError(value, field, allowedLeaseIds);
  }
  const pathError = safeWorkspacePath(value, field);
  if (pathError) return pathError;
  const candidateRoot = canonicalPathIfPresent(resolve(value as string));
  return isWithinRoot(candidateRoot, projectRoot)
    ? undefined
    : `${field} is not bound to the registered project root`;
}

function artifactRefError(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${field} must be a content-addressed artifact reference`;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.path !== "string" ||
    !record.path.startsWith("mn://") ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.sha256)
  ) {
    return `${field} cannot contain an external worker local filesystem path`;
  }
  return undefined;
}

/**
 * External enterprise workers may report inline/content-addressed evidence,
 * but must never persuade the API process to read a worker-selected local
 * file. Candidate paths are metadata-only and remain bound to the registered
 * project mount; artifact payloads are uploaded through the artifact backend.
 */
export function validateEnterpriseExternalRunFilesystem(
  run: RunRecord,
  projectRoot: string
): string | undefined {
  const canonicalProjectRoot = canonicalPathIfPresent(resolve(projectRoot));
  const sandboxLeaseIds = new Set(
    (run.sandboxEvidenceHistory ?? []).map((binding) => binding.execution.leaseId)
  );
  if (run.sandboxExecution?.leaseId) sandboxLeaseIds.add(run.sandboxExecution.leaseId);
  for (const [candidateIndex, candidate] of run.candidates.entries()) {
    const candidateField = `run.candidates[${candidateIndex}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return `${candidateField} must be an object`;
    }
    const workspaceError = workspaceLocationError(
      candidate.worktreePath,
      `${candidateField}.worktreePath`,
      canonicalProjectRoot,
      sandboxLeaseIds
    );
    if (workspaceError) return workspaceError;
    if (candidate.outputCheckpoint !== undefined) {
      return `${candidateField}.outputCheckpoint cannot contain external worker local filesystem paths`;
    }
    const resultArtifacts = candidate.result?.artifacts ?? [];
    if (!Array.isArray(resultArtifacts)) {
      return `${candidateField}.result.artifacts must be an array`;
    }
    for (const [artifactIndex, artifact] of resultArtifacts.entries()) {
      const error = artifactRefError(
        artifact,
        `${candidateField}.result.artifacts[${artifactIndex}]`
      );
      if (error) return error;
    }
    if (!Array.isArray(candidate.gates)) {
      return `${candidateField}.gates must be an array`;
    }
    for (const [gateIndex, gate] of candidate.gates.entries()) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
        return `${candidateField}.gates[${gateIndex}] must be an object`;
      }
      if (!Array.isArray(gate.evidence)) {
        return `${candidateField}.gates[${gateIndex}].evidence must be an array`;
      }
      for (const [artifactIndex, artifact] of gate.evidence.entries()) {
        const error = artifactRefError(
          artifact,
          `${candidateField}.gates[${gateIndex}].evidence[${artifactIndex}]`
        );
        if (error) return error;
      }
    }
  }

  for (const [gateIndex, gate] of (run.gateResultsV2 ?? []).entries()) {
    const workingDirectoryError = workspaceLocationError(
      gate.workingDirectory,
      `run.gateResultsV2[${gateIndex}].workingDirectory`,
      canonicalProjectRoot,
      sandboxLeaseIds
    );
    if (workingDirectoryError) return workingDirectoryError;
    for (const [artifactIndex, artifact] of gate.artifacts.entries()) {
      if (artifact.path !== undefined) {
        return `run.gateResultsV2[${gateIndex}].artifacts[${artifactIndex}].path cannot contain an external worker local filesystem path`;
      }
    }
  }
  return undefined;
}
