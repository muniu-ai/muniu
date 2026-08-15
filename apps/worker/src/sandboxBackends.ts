import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  SandboxBackend,
  SandboxPreparation,
  SandboxPreparationRequest
} from "@mn/harness";
import {
  prepareCandidateWorkspace,
  type WorkspaceResult
} from "./workspace.js";

export interface ReleasableSandboxBackend extends SandboxBackend {
  release(leaseId: string): Promise<void>;
}

/**
 * The local backend isolates source mutations and supports a post-run diff
 * check. It deliberately does not claim to enforce process, network, secret,
 * or resource boundaries.
 */
export class WorktreePostcheckSandboxBackend implements ReleasableSandboxBackend {
  readonly id = "worktree-postcheck";
  readonly version = "1";
  readonly enforcement = "postcheck" as const;
  readonly capabilities = Object.freeze(["source-isolation", "diff-postcheck"]);
  readonly #leases = new Map<string, WorkspaceResult>();
  readonly #workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = requireAbsolutePath(workspaceRoot, "workspaceRoot");
  }

  async prepare(request: SandboxPreparationRequest): Promise<SandboxPreparation> {
    validatePreparationRequest(request);
    if ((request.networkAllowlist?.length ?? 0) > 0) {
      throw new Error(
        "worktree-postcheck cannot enforce a network allowlist; use an enforced backend"
      );
    }
    if ((request.commandAllowlist?.length ?? 0) > 0) {
      throw new Error(
        "worktree-postcheck cannot enforce a command allowlist; use an enforced backend"
      );
    }
    const projectRoot = await requireRealDirectory(request.projectRoot, "projectRoot");
    const workspace = await prepareCandidateWorkspace({
      projectRoot,
      workspaceRoot: this.#workspaceRoot,
      runId: `task-${sha256(request.taskId).slice(0, 20)}`,
      candidateId: randomUUID(),
      isolated: true
    });
    assertContained(this.#workspaceRoot, workspace.path, "prepared workspace");
    const leaseId = randomUUID();
    this.#leases.set(leaseId, workspace);
    return Object.freeze({
      backendId: this.id,
      workspacePath: workspace.path,
      leaseId
    });
  }

  async release(leaseId: string): Promise<void> {
    requireIdentifier(leaseId, "leaseId");
    const workspace = this.#leases.get(leaseId);
    if (!workspace) throw new Error(`Unknown or already released sandbox lease ${leaseId}`);
    this.#leases.delete(leaseId);
    await workspace.cleanup();
  }
}

export type EnforcedSandboxKind = "container" | "remote";

export interface EnforcedSandboxMount {
  readonly source: "project" | "scratch" | "dependency-cache";
  readonly target: string;
  readonly readOnly: boolean;
}

export interface EnforcedSandboxResourceLimits {
  readonly cpu: number;
  readonly memoryMb: number;
  readonly pids: number;
  readonly timeoutSeconds: number;
}

export interface EnforcedSandboxPolicy {
  readonly mounts: readonly EnforcedSandboxMount[];
  readonly networkMode: "deny" | "allowlist";
  readonly networkAllowlist: readonly string[];
  /** Secret identifiers only. Secret values must be resolved inside the backend. */
  readonly secretNames: readonly string[];
  readonly allowedCommands: readonly string[];
  readonly resources: EnforcedSandboxResourceLimits;
  readonly readOnlyRootFilesystem: true;
}

export interface EnforcedSandboxProvisionRequest {
  readonly backendId: string;
  readonly kind: EnforcedSandboxKind;
  readonly projectRoot: string;
  readonly taskId: string;
  readonly policy: EnforcedSandboxPolicy;
}

export interface EnforcedSandboxProvisioner {
  provision(request: EnforcedSandboxProvisionRequest): Promise<SandboxPreparation>;
  release(leaseId: string): Promise<void>;
}

export interface EnforcedSandboxBackendOptions {
  readonly id: string;
  readonly version: string;
  readonly kind: EnforcedSandboxKind;
  readonly policy: EnforcedSandboxPolicy;
  readonly provisioner: EnforcedSandboxProvisioner;
}

/** Adapter for a real container or remote isolation service. The adapter only
 * reports `enforced` after all policy dimensions are configured and a
 * provisioner creates a leased environment. */
export class EnforcedSandboxBackend implements ReleasableSandboxBackend {
  readonly id: string;
  readonly version: string;
  readonly enforcement = "enforced" as const;
  readonly capabilities = Object.freeze([
    "mount-policy",
    "network-policy",
    "resource-limits",
    "secret-injection",
    "tool-allowlist",
    "read-only-root-filesystem"
  ]);
  readonly #kind: EnforcedSandboxKind;
  readonly #policy: EnforcedSandboxPolicy;
  readonly #provisioner: EnforcedSandboxProvisioner;
  readonly #leases = new Set<string>();

  constructor(options: EnforcedSandboxBackendOptions) {
    this.id = requireIdentifier(options.id, "backend id");
    this.version = requireIdentifier(options.version, "backend version");
    if (options.kind !== "container" && options.kind !== "remote") {
      throw new TypeError("sandbox kind must be container or remote");
    }
    if (
      !options.provisioner ||
      typeof options.provisioner.provision !== "function" ||
      typeof options.provisioner.release !== "function"
    ) {
      throw new TypeError("enforced sandbox requires provision and release functions");
    }
    this.#kind = options.kind;
    this.#policy = normalizePolicy(options.policy);
    this.#provisioner = options.provisioner;
  }

  async prepare(request: SandboxPreparationRequest): Promise<SandboxPreparation> {
    validatePreparationRequest(request);
    const projectRoot = await requireRealDirectory(request.projectRoot, "projectRoot");
    requireSubset(
      request.networkAllowlist ?? [],
      this.#policy.networkAllowlist,
      "requested network allowlist"
    );
    if (
      this.#policy.networkMode === "deny" &&
      (request.networkAllowlist?.length ?? 0) > 0
    ) {
      throw new Error("sandbox denies all network access");
    }
    requireSubset(
      request.commandAllowlist ?? [],
      this.#policy.allowedCommands,
      "requested command allowlist"
    );
    const prepared = await this.#provisioner.provision(
      deepFreeze({
        backendId: this.id,
        kind: this.#kind,
        projectRoot,
        taskId: request.taskId,
        policy: this.#policy
      })
    );
    if (prepared.backendId !== this.id) {
      throw new Error(
        `sandbox provisioner returned backend ${prepared.backendId}; expected ${this.id}`
      );
    }
    const workspacePath = requireTrimmed(prepared.workspacePath, "workspacePath");
    const leaseId = requireIdentifier(prepared.leaseId ?? "", "leaseId");
    if (this.#leases.has(leaseId)) {
      throw new Error(`sandbox provisioner reused active lease ${leaseId}`);
    }
    this.#leases.add(leaseId);
    return Object.freeze({ backendId: this.id, workspacePath, leaseId });
  }

  async release(leaseId: string): Promise<void> {
    requireIdentifier(leaseId, "leaseId");
    if (!this.#leases.delete(leaseId)) {
      throw new Error(`Unknown or already released sandbox lease ${leaseId}`);
    }
    await this.#provisioner.release(leaseId);
  }
}

function normalizePolicy(policy: EnforcedSandboxPolicy): EnforcedSandboxPolicy {
  if (!policy || typeof policy !== "object") throw new TypeError("sandbox policy is required");
  if (policy.readOnlyRootFilesystem !== true) {
    throw new TypeError("enforced sandbox requires a read-only root filesystem");
  }
  if (policy.networkMode !== "deny" && policy.networkMode !== "allowlist") {
    throw new TypeError("networkMode must be deny or allowlist");
  }
  const networkAllowlist = uniqueSorted(
    policy.networkAllowlist.map((value) => requireNetworkTarget(value))
  );
  if (policy.networkMode === "deny" && networkAllowlist.length > 0) {
    throw new TypeError("deny network mode cannot contain an allowlist");
  }
  if (policy.networkMode === "allowlist" && networkAllowlist.length === 0) {
    throw new TypeError("allowlist network mode requires at least one target");
  }
  const allowedCommands = uniqueSorted(
    policy.allowedCommands.map((value) => requireCommand(value))
  );
  if (allowedCommands.length === 0) {
    throw new TypeError("enforced sandbox requires at least one allowed command");
  }
  const secretNames = uniqueSorted(policy.secretNames.map(requireSecretName));
  const mounts = policy.mounts.map((mount) => {
    if (!["project", "scratch", "dependency-cache"].includes(mount.source)) {
      throw new TypeError(`unsupported mount source ${String(mount.source)}`);
    }
    if (mount.readOnly !== true && mount.source !== "scratch") {
      throw new TypeError(`${mount.source} mounts must be read-only`);
    }
    return Object.freeze({
      source: mount.source,
      target: requireAbsolutePath(mount.target, "mount target"),
      readOnly: mount.readOnly
    });
  });
  if (!mounts.some((mount) => mount.source === "project")) {
    throw new TypeError("enforced sandbox requires a project mount");
  }
  if (new Set(mounts.map((mount) => mount.target)).size !== mounts.length) {
    throw new TypeError("sandbox mount targets must be unique");
  }
  const resources = Object.freeze({
    cpu: requirePositiveFinite(policy.resources.cpu, "resources.cpu"),
    memoryMb: requirePositiveSafeInteger(policy.resources.memoryMb, "resources.memoryMb"),
    pids: requirePositiveSafeInteger(policy.resources.pids, "resources.pids"),
    timeoutSeconds: requirePositiveSafeInteger(
      policy.resources.timeoutSeconds,
      "resources.timeoutSeconds"
    )
  });
  return deepFreeze({
    mounts,
    networkMode: policy.networkMode,
    networkAllowlist,
    secretNames,
    allowedCommands,
    resources,
    readOnlyRootFilesystem: true as const
  });
}

function validatePreparationRequest(request: SandboxPreparationRequest): void {
  if (!request || typeof request !== "object") {
    throw new TypeError("sandbox preparation request is required");
  }
  requireAbsolutePath(request.projectRoot, "projectRoot");
  requireIdentifier(request.taskId, "taskId");
  for (const target of request.networkAllowlist ?? []) requireNetworkTarget(target);
  for (const command of request.commandAllowlist ?? []) requireCommand(command);
}

async function requireRealDirectory(path: string, field: string): Promise<string> {
  const absolute = requireAbsolutePath(path, field);
  const actual = await realpath(absolute);
  const stats = await lstat(actual);
  if (!stats.isDirectory()) throw new TypeError(`${field} must be a directory`);
  return actual;
}

function requireSubset(
  requested: readonly string[],
  available: readonly string[],
  field: string
): void {
  const known = new Set(available);
  const missing = requested.filter((value) => !known.has(value));
  if (missing.length > 0) {
    throw new Error(`${field} exceeds backend policy: ${uniqueSorted(missing).join(", ")}`);
  }
}

function assertContained(root: string, child: string, field: string): void {
  const fromRoot = relative(resolve(root), resolve(child));
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${field} is outside the configured workspace root`);
  }
}

function requireAbsolutePath(value: string, field: string): string {
  const normalized = requireTrimmed(value, field);
  if (!isAbsolute(normalized) || normalized.includes("\0")) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return resolve(normalized);
}

function requireIdentifier(value: string, field: string): string {
  const normalized = requireTrimmed(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`${field} contains unsupported characters`);
  }
  return normalized;
}

function requireTrimmed(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function requireNetworkTarget(value: string): string {
  const normalized = requireTrimmed(value, "network target").toLowerCase();
  if (
    normalized.includes("/") ||
    normalized.includes("://") ||
    !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::(?:[1-9][0-9]{0,4}))?$/u.test(
      normalized
    )
  ) {
    throw new TypeError(`invalid network target ${value}`);
  }
  const port = normalized.match(/:([0-9]+)$/u)?.[1];
  if (port && Number(port) > 65_535) throw new TypeError(`invalid network port in ${value}`);
  return normalized;
}

function requireCommand(value: string): string {
  const normalized = requireTrimmed(value, "allowed command");
  if (/[\0\r\n]/u.test(normalized) || normalized.includes("..")) {
    throw new TypeError("allowed command contains traversal or control characters");
  }
  return normalized;
}

function requireSecretName(value: string): string {
  const normalized = requireTrimmed(value, "secret name");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(normalized)) {
    throw new TypeError("secret names must be uppercase identifiers, never secret values");
  }
  return normalized;
}

function requirePositiveFinite(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive finite number`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
