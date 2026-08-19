import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

export type RunJobQueueStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SandboxEnforcementLevel = "none" | "postcheck" | "enforced";
/** Runtime capability advertised by a worker, not a model-provider identifier. */
export type WorkerProviderId = "builtin" | "claude" | "codex";

export interface WorkerSandboxCapability {
  backendId: string;
  enforcement: SandboxEnforcementLevel;
  capabilities: string[];
}

/** A worker's complete, normalized execution capability declaration. */
export interface WorkerCapabilitySet {
  providers: WorkerProviderId[];
  languages: string[];
  gateRunnerIds: string[];
  sandboxBackends: WorkerSandboxCapability[];
  tenantIds: string[];
  tools: string[];
}

export interface WorkerSandboxRequirements {
  allowedBackendIds: string[];
  minEnforcement: SandboxEnforcementLevel;
  requiredCapabilities: string[];
}

/** All listed values are conjunctive requirements for a v2 queue item. */
export interface WorkerRequirements {
  requiredProviders: WorkerProviderId[];
  requiredLanguages: string[];
  requiredGateRunnerIds: string[];
  sandbox: WorkerSandboxRequirements;
  requiredTools: string[];
}

export interface RunJobQueueItem {
  version: 1 | 2;
  runId: string;
  projectId: string;
  taskId: string;
  status: RunJobQueueStatus;
  priority: number;
  attempt: number;
  recovered: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  resumeFromRunId?: string;
  ownerId?: string;
  /** Legacy v1 only. v2 claims never persist or expose the bearer token. */
  claimToken?: string;
  claimTokenHash?: string;
  claimBindingDigest?: string;
  workerCapabilityDigest?: string;
  tenantId?: string;
  requirements?: WorkerRequirements;
  requirementsDigest?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  heartbeatAt?: string;
  releasedAt?: string;
}

export interface RunJobQueueOptions {
  rootDir: string;
  ownerId?: string;
}

export interface QueueRunJobInput {
  runId: string;
  projectId: string;
  taskId: string;
  priority?: number;
  attempt: number;
  recovered: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  resumeFromRunId?: string;
  /** Supplying version 2, tenantId, or requirements creates a v2 queue item. */
  version?: 1 | 2;
  tenantId?: string;
  requirements?: PartialWorkerRequirements;
}

export interface PartialWorkerRequirements {
  requiredProviders?: WorkerProviderId[];
  requiredLanguages?: string[];
  requiredGateRunnerIds?: string[];
  sandbox?: {
    allowedBackendIds?: string[];
    minEnforcement?: SandboxEnforcementLevel;
    requiredCapabilities?: string[];
  };
  requiredTools?: string[];
}

export interface PartialWorkerCapabilitySet {
  providers?: WorkerProviderId[];
  languages?: string[];
  gateRunnerIds?: string[];
  sandboxBackends?: Array<{
    backendId: string;
    enforcement: SandboxEnforcementLevel;
    capabilities?: string[];
  }>;
  tenantIds?: string[];
  tools?: string[];
}

export interface ClaimRunJobInput {
  ownerId: string;
  now?: string;
  ttlMs?: number;
  /** Required when claiming a v2 queue item. */
  capabilities?: PartialWorkerCapabilitySet;
}

export interface ClaimedRunJob {
  item: RunJobQueueItem;
  claimToken: string;
}

export interface RunJobClaimInput extends ClaimRunJobInput {
  claimToken: string;
}

export class RunJobQueue {
  private readonly ownerId: string;

  constructor(private readonly options: RunJobQueueOptions) {
    assertNonEmptyPath(options.rootDir, "rootDir");
    this.ownerId = options.ownerId ? normalizeIdentifier(options.ownerId, "ownerId") : `mn-api-${process.pid}-${randomUUID()}`;
  }

  enqueue(input: QueueRunJobInput): RunJobQueueItem {
    assertPlainRecord(input, "queue input", QUEUE_INPUT_KEYS);
    const runId = normalizeIdentifier(input.runId, "runId");
    const previous = this.read(runId);
    const isV2 = previous?.version === 2 || input.version === 2 || input.tenantId !== undefined || input.requirements !== undefined;
    if (input.version === 1 && isV2) {
      throw new TypeError("version 1 queue items cannot declare tenantId or requirements");
    }
    if (previous && (previous.projectId !== input.projectId || previous.taskId !== input.taskId)) {
      throw new TypeError("runId cannot be rebound to another project or task");
    }
    if (
      previous?.version === 2 && previous.status === "running" && previous.claimExpiresAt &&
      timestampMs(previous.claimExpiresAt) > timestampMs(normalizeTimestamp(input.updatedAt, "updatedAt"))
    ) {
      throw new Error("cannot enqueue over an active v2 claim");
    }
    const base = {
      version: isV2 ? 2 as const : 1 as const,
      runId,
      projectId: normalizeIdentifier(input.projectId, "projectId"),
      taskId: normalizeIdentifier(input.taskId, "taskId"),
      status: "queued" as const,
      priority: normalizePriority(input.priority ?? previous?.priority ?? 0),
      attempt: normalizePositiveInteger(input.attempt, "attempt", 1_000_000),
      recovered: normalizeBoolean(input.recovered, "recovered"),
      createdAt: previous?.createdAt ?? normalizeTimestamp(input.createdAt, "createdAt"),
      updatedAt: normalizeTimestamp(input.updatedAt, "updatedAt"),
      ...(input.resumeFromRunId ? { resumeFromRunId: normalizeIdentifier(input.resumeFromRunId, "resumeFromRunId") } : {})
    };
    if (timestampMs(base.updatedAt) < timestampMs(base.createdAt)) {
      throw new RangeError("updatedAt cannot precede createdAt");
    }
    const item: RunJobQueueItem = isV2
      ? createV2QueueItem(
          base,
          input.tenantId ?? previous?.tenantId,
          input.requirements ?? previous?.requirements,
          previous?.version === 2 ? previous : undefined
        )
      : base;
    this.write(item);
    return item;
  }

  markRunning(runId: string, now: string, ownerId = this.ownerId): RunJobQueueItem | undefined {
    const current = this.read(normalizeIdentifier(runId, "runId"));
    if (!current) return undefined;
    const timestamp = normalizeTimestamp(now, "now");
    if (timestampMs(timestamp) < timestampMs(current.updatedAt)) throw new RangeError("now cannot precede updatedAt");
    const item: RunJobQueueItem = {
      ...current,
      status: "running",
      ownerId: normalizeIdentifier(ownerId, "ownerId"),
      startedAt: current.startedAt ?? timestamp,
      updatedAt: timestamp
    };
    this.write(item);
    return item;
  }

  markFinished(
    runId: string,
    status: Exclude<RunJobQueueStatus, "queued" | "running">,
    now: string
  ): RunJobQueueItem | undefined {
    const current = this.read(normalizeIdentifier(runId, "runId"));
    if (!current) return undefined;
    if (!TERMINAL_STATUSES.has(status)) throw new TypeError("invalid terminal status");
    const timestamp = normalizeTimestamp(now, "now");
    if (timestampMs(timestamp) < timestampMs(current.updatedAt)) throw new RangeError("now cannot precede updatedAt");
    const {
      claimToken: _claimToken,
      claimTokenHash: _claimTokenHash,
      claimBindingDigest: _claimBindingDigest,
      workerCapabilityDigest: _workerCapabilityDigest,
      claimedAt: _claimedAt,
      claimExpiresAt: _claimExpiresAt,
      heartbeatAt: _heartbeatAt,
      ...rest
    } = current;
    const item: RunJobQueueItem = {
      ...rest,
      status,
      finishedAt: timestamp,
      updatedAt: timestamp
    };
    this.write(item);
    return item;
  }

  read(runId: string): RunJobQueueItem | undefined {
    const path = this.itemPath(normalizeIdentifier(runId, "runId"));
    if (!existsSync(path)) return undefined;
    try {
      return normalizeQueueItem(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      return undefined;
    }
  }

  list(): RunJobQueueItem[] {
    this.ensureRoot();
    return readdirSync(this.options.rootDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        try {
          return normalizeQueueItem(JSON.parse(readFileSync(join(this.options.rootDir, entry), "utf8")) as unknown);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is RunJobQueueItem => Boolean(item))
      .sort(compareQueueItems);
  }

  listClaimable(now?: string): RunJobQueueItem[] {
    const nowMs = now === undefined ? Date.now() : timestampMs(normalizeTimestamp(now, "now"));
    return this.list().filter((item) => isClaimable(item, nowMs));
  }

  claimNext(input: ClaimRunJobInput): ClaimedRunJob | undefined {
    const normalizedInput = normalizeClaimInput(input);
    const now = normalizedInput.now ?? new Date().toISOString();
    const nowMs = timestampMs(now);
    const capabilitySet = normalizedInput.capabilities;
    const claimable = this.list().find((item) =>
      isClaimable(item, nowMs) && isWorkerCompatible(item, capabilitySet)
    );
    if (!claimable) return undefined;
    return this.claimNormalized(claimable.runId, normalizedInput, now);
  }

  claim(runId: string, input: ClaimRunJobInput): ClaimedRunJob | undefined {
    const normalizedInput = normalizeClaimInput(input);
    const now = normalizedInput.now ?? new Date().toISOString();
    return this.claimNormalized(normalizeIdentifier(runId, "runId"), normalizedInput, now);
  }

  heartbeat(runId: string, input: RunJobClaimInput): RunJobQueueItem | undefined {
    const normalizedInput = normalizeRunJobClaimInput(input);
    const now = normalizedInput.now ?? new Date().toISOString();
    const current = this.read(normalizeIdentifier(runId, "runId"));
    if (!isActiveClaim(current, normalizedInput, now)) return undefined;
    const item: RunJobQueueItem = {
      ...current,
      heartbeatAt: now,
      claimExpiresAt: new Date(timestampMs(now) + normalizedInput.ttlMs).toISOString(),
      updatedAt: now
    };
    if (item.version === 2) {
      item.claimBindingDigest = claimBindingDigest(item);
    }
    this.write(item);
    return item;
  }

  release(runId: string, input: RunJobClaimInput): RunJobQueueItem | undefined {
    const normalizedInput = normalizeRunJobClaimInput(input);
    const now = normalizedInput.now ?? new Date().toISOString();
    const current = this.read(normalizeIdentifier(runId, "runId"));
    if (!isActiveClaim(current, normalizedInput, now)) return undefined;
    const {
      ownerId: _ownerId,
      claimToken: _claimToken,
      claimTokenHash: _claimTokenHash,
      claimBindingDigest: _claimBindingDigest,
      workerCapabilityDigest: _workerCapabilityDigest,
      claimedAt: _claimedAt,
      claimExpiresAt: _claimExpiresAt,
      heartbeatAt: _heartbeatAt,
      startedAt: _startedAt,
      ...rest
    } = current;
    const item: RunJobQueueItem = {
      ...rest,
      status: "queued",
      releasedAt: now,
      updatedAt: now
    };
    this.write(item);
    return item;
  }

  private claimNormalized(
    runId: string,
    input: NormalizedClaimRunJobInput,
    now: string
  ): ClaimedRunJob | undefined {
    const nowMs = timestampMs(now);
    const current = this.read(runId);
    if (!current || !isClaimable(current, nowMs) || !isWorkerCompatible(current, input.capabilities)) {
      return undefined;
    }
    if (nowMs < timestampMs(current.updatedAt)) return undefined;
    const claimToken = randomUUID();
    const expiry = new Date(nowMs + input.ttlMs).toISOString();
    const common = {
      ...current,
      status: "running" as const,
      ownerId: input.ownerId,
      claimedAt: now,
      heartbeatAt: now,
      claimExpiresAt: expiry,
      startedAt: current.startedAt ?? now,
      updatedAt: now
    };
    const item: RunJobQueueItem = current.version === 2
      ? createV2Claim(common, claimToken, input.capabilities as WorkerCapabilitySet)
      : { ...common, claimToken };
    this.write(item);
    return { item, claimToken };
  }

  private write(item: RunJobQueueItem): void {
    const normalized = normalizeQueueItem(item);
    this.ensureRoot();
    const path = this.itemPath(normalized.runId);
    const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    renameSync(tmpPath, path);
  }

  private itemPath(runId: string): string {
    return join(this.options.rootDir, `${safeFileName(runId)}.json`);
  }

  private ensureRoot(): void {
    mkdirSync(this.options.rootDir, { recursive: true });
  }
}

export function normalizeWorkerCapabilities(input: PartialWorkerCapabilitySet): WorkerCapabilitySet {
  assertPlainRecord(input, "worker capabilities", CAPABILITY_KEYS);
  const sandboxesInput = input.sandboxBackends ?? [];
  assertDenseArray(sandboxesInput, "sandboxBackends");
  const sandboxBackends = sandboxesInput.map((sandbox, index) => {
    assertPlainRecord(sandbox, `sandboxBackends[${index}]`, SANDBOX_CAPABILITY_KEYS);
    return {
      backendId: normalizeCapabilityName(sandbox.backendId, `sandboxBackends[${index}].backendId`),
      enforcement: normalizeEnforcement(sandbox.enforcement),
      capabilities: normalizeStringSet(sandbox.capabilities ?? [], `sandboxBackends[${index}].capabilities`)
    };
  }).sort((left, right) => codeUnitCompare(left.backendId, right.backendId));
  for (let index = 1; index < sandboxBackends.length; index += 1) {
    if (sandboxBackends[index - 1]?.backendId === sandboxBackends[index]?.backendId) {
      throw new TypeError(`duplicate sandbox backend: ${sandboxBackends[index]?.backendId}`);
    }
  }
  return {
    providers: normalizeProviderSet(input.providers ?? [], "providers"),
    languages: normalizeStringSet(input.languages ?? [], "languages"),
    gateRunnerIds: normalizeStringSet(input.gateRunnerIds ?? [], "gateRunnerIds"),
    sandboxBackends,
    tenantIds: normalizeStringSet(input.tenantIds ?? [], "tenantIds"),
    tools: normalizeStringSet(input.tools ?? [], "tools")
  };
}

export function normalizeWorkerRequirements(input: PartialWorkerRequirements = {}): WorkerRequirements {
  assertPlainRecord(input, "worker requirements", REQUIREMENT_KEYS);
  const sandboxInput = input.sandbox ?? {};
  assertPlainRecord(sandboxInput, "worker requirements sandbox", SANDBOX_REQUIREMENT_KEYS);
  return {
    requiredProviders: normalizeProviderSet(input.requiredProviders ?? [], "requiredProviders"),
    requiredLanguages: normalizeStringSet(input.requiredLanguages ?? [], "requiredLanguages"),
    requiredGateRunnerIds: normalizeStringSet(input.requiredGateRunnerIds ?? [], "requiredGateRunnerIds"),
    sandbox: {
      allowedBackendIds: normalizeStringSet(sandboxInput.allowedBackendIds ?? [], "sandbox.allowedBackendIds"),
      minEnforcement: normalizeEnforcement(sandboxInput.minEnforcement ?? "none"),
      requiredCapabilities: normalizeStringSet(sandboxInput.requiredCapabilities ?? [], "sandbox.requiredCapabilities")
    },
    requiredTools: normalizeStringSet(input.requiredTools ?? [], "requiredTools")
  };
}

export function workerCapabilityDigest(capabilities: PartialWorkerCapabilitySet): string {
  return sha256Canonical(normalizeWorkerCapabilities(capabilities));
}

export function workerRequirementsDigest(requirements: PartialWorkerRequirements): string {
  return sha256Canonical(normalizeWorkerRequirements(requirements));
}

export function workerSatisfiesRequirements(
  capabilitiesInput: PartialWorkerCapabilitySet,
  requirementsInput: PartialWorkerRequirements,
  tenantId: string
): boolean {
  const capabilities = normalizeWorkerCapabilities(capabilitiesInput);
  const requirements = normalizeWorkerRequirements(requirementsInput);
  const tenant = normalizeIdentifier(tenantId, "tenantId");
  if (!capabilities.tenantIds.includes(tenant)) return false;
  if (!containsAll(capabilities.providers, requirements.requiredProviders)) return false;
  if (!containsAll(capabilities.languages, requirements.requiredLanguages)) return false;
  if (!containsAll(capabilities.gateRunnerIds, requirements.requiredGateRunnerIds)) return false;
  if (!containsAll(capabilities.tools, requirements.requiredTools)) return false;
  return capabilities.sandboxBackends.some((sandbox) =>
    (requirements.sandbox.allowedBackendIds.length === 0 || requirements.sandbox.allowedBackendIds.includes(sandbox.backendId)) &&
    ENFORCEMENT_RANK[sandbox.enforcement] >= ENFORCEMENT_RANK[requirements.sandbox.minEnforcement] &&
    containsAll(sandbox.capabilities, requirements.sandbox.requiredCapabilities)
  );
}

interface NormalizedClaimRunJobInput {
  ownerId: string;
  now?: string;
  ttlMs: number;
  capabilities?: WorkerCapabilitySet;
}

interface NormalizedRunJobClaimInput extends NormalizedClaimRunJobInput {
  claimToken: string;
}

function createV2QueueItem(
  base: Omit<RunJobQueueItem, "tenantId" | "requirements" | "requirementsDigest">,
  tenantId: string | undefined,
  requirementsInput: PartialWorkerRequirements | undefined,
  previous?: RunJobQueueItem
): RunJobQueueItem {
  if (tenantId === undefined) throw new TypeError("v2 queue items require tenantId");
  const tenant = normalizeIdentifier(tenantId, "tenantId");
  const requirements = normalizeWorkerRequirements(requirementsInput ?? {});
  const digest = sha256Canonical(requirements);
  if (previous?.version === 2 && (previous.tenantId !== tenant || previous.requirementsDigest !== digest)) {
    throw new TypeError("v2 queue tenant and worker requirements are immutable for a runId");
  }
  return {
    ...base,
    version: 2,
    tenantId: tenant,
    requirements,
    requirementsDigest: digest
  };
}

function createV2Claim(
  common: RunJobQueueItem,
  claimToken: string,
  capabilities: WorkerCapabilitySet
): RunJobQueueItem {
  const item: RunJobQueueItem = {
    ...common,
    version: 2,
    claimTokenHash: sha256Text(claimToken),
    workerCapabilityDigest: sha256Canonical(capabilities)
  };
  item.claimBindingDigest = claimBindingDigest(item);
  return item;
}

function claimBindingDigest(item: RunJobQueueItem): string {
  if (
    item.version !== 2 || !item.tenantId || !item.ownerId || !item.workerCapabilityDigest ||
    !item.requirementsDigest || !item.claimExpiresAt
  ) {
    throw new TypeError("incomplete v2 claim binding");
  }
  return sha256Canonical({
    tenantId: item.tenantId,
    runId: item.runId,
    ownerId: item.ownerId,
    workerCapabilityDigest: item.workerCapabilityDigest,
    requirementsDigest: item.requirementsDigest,
    expiresAt: item.claimExpiresAt
  });
}

function normalizeClaimInput(input: ClaimRunJobInput): NormalizedClaimRunJobInput {
  assertPlainRecord(input, "claim input", CLAIM_INPUT_KEYS);
  return {
    ownerId: normalizeIdentifier(input.ownerId, "ownerId"),
    ...(input.now === undefined ? {} : { now: normalizeTimestamp(input.now, "now") }),
    ttlMs: normalizeTtl(input.ttlMs),
    ...(input.capabilities === undefined ? {} : { capabilities: normalizeWorkerCapabilities(input.capabilities) })
  };
}

function normalizeRunJobClaimInput(input: RunJobClaimInput): NormalizedRunJobClaimInput {
  assertPlainRecord(input, "claim token input", CLAIM_TOKEN_INPUT_KEYS);
  const normalized = normalizeClaimInput({
    ownerId: input.ownerId,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities })
  });
  return {
    ...normalized,
    claimToken: normalizeSecretToken(input.claimToken)
  };
}

function normalizeQueueItem(value: unknown): RunJobQueueItem {
  assertPlainRecord(value, "queue item", QUEUE_ITEM_KEYS);
  const version = value.version;
  if (version !== 1 && version !== 2) throw new TypeError("invalid queue item version");
  const status = value.status;
  if (typeof status !== "string" || !QUEUE_STATUSES.has(status as RunJobQueueStatus)) {
    throw new TypeError("invalid queue status");
  }
  const item: RunJobQueueItem = {
    version,
    runId: normalizeIdentifier(value.runId, "runId"),
    projectId: normalizeIdentifier(value.projectId, "projectId"),
    taskId: normalizeIdentifier(value.taskId, "taskId"),
    status: status as RunJobQueueStatus,
    priority: normalizePriority(value.priority ?? 0),
    attempt: normalizePositiveInteger(value.attempt, "attempt", 1_000_000),
    recovered: normalizeBoolean(value.recovered, "recovered"),
    createdAt: normalizeTimestamp(value.createdAt, "createdAt"),
    updatedAt: normalizeTimestamp(value.updatedAt, "updatedAt"),
    ...copyOptionalTimestamp(value, "startedAt"),
    ...copyOptionalTimestamp(value, "finishedAt"),
    ...copyOptionalTimestamp(value, "claimedAt"),
    ...copyOptionalTimestamp(value, "claimExpiresAt"),
    ...copyOptionalTimestamp(value, "heartbeatAt"),
    ...copyOptionalTimestamp(value, "releasedAt"),
    ...copyOptionalIdentifier(value, "resumeFromRunId"),
    ...copyOptionalIdentifier(value, "ownerId")
  };
  if (version === 1) {
    if (value.claimToken !== undefined) item.claimToken = normalizeSecretToken(value.claimToken);
    return item;
  }
  if (value.claimToken !== undefined) throw new TypeError("v2 queue item contains plaintext claim token");
  item.tenantId = normalizeIdentifier(value.tenantId, "tenantId");
  item.requirements = normalizeWorkerRequirements(value.requirements as PartialWorkerRequirements);
  item.requirementsDigest = normalizeDigest(value.requirementsDigest, "requirementsDigest");
  if (!safeEqual(item.requirementsDigest, sha256Canonical(item.requirements))) {
    throw new TypeError("requirements digest mismatch");
  }
  if (value.claimTokenHash !== undefined) item.claimTokenHash = normalizeDigest(value.claimTokenHash, "claimTokenHash");
  if (value.workerCapabilityDigest !== undefined) item.workerCapabilityDigest = normalizeDigest(value.workerCapabilityDigest, "workerCapabilityDigest");
  if (value.claimBindingDigest !== undefined) item.claimBindingDigest = normalizeDigest(value.claimBindingDigest, "claimBindingDigest");
  const hasAnyClaimBinding = Boolean(item.claimTokenHash || item.workerCapabilityDigest || item.claimBindingDigest);
  if (hasAnyClaimBinding) {
    if (!item.claimTokenHash || !item.claimBindingDigest || !item.workerCapabilityDigest || !item.ownerId || !item.claimExpiresAt) {
      throw new TypeError("incomplete v2 active claim");
    }
    if (!safeEqual(item.claimBindingDigest, claimBindingDigest(item))) {
      throw new TypeError("v2 claim binding mismatch");
    }
  }
  return item;
}

function isWorkerCompatible(item: RunJobQueueItem, capabilities: WorkerCapabilitySet | undefined): boolean {
  if (item.version === 1) return true;
  if (!capabilities || !item.tenantId || !item.requirements) return false;
  return workerSatisfiesRequirements(capabilities, item.requirements, item.tenantId);
}

function compareQueueItems(left: RunJobQueueItem, right: RunJobQueueItem): number {
  const priorityDelta = right.priority - left.priority;
  if (priorityDelta !== 0) return priorityDelta;
  const createdDelta = codeUnitCompare(left.createdAt, right.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return codeUnitCompare(left.runId, right.runId);
}

function isClaimable(item: RunJobQueueItem, nowMs: number): boolean {
  if (item.status === "queued") return true;
  if (item.status !== "running" || !item.claimExpiresAt) return false;
  return timestampMs(item.claimExpiresAt) <= nowMs;
}

function isActiveClaim(
  item: RunJobQueueItem | undefined,
  input: NormalizedRunJobClaimInput,
  now: string
): item is RunJobQueueItem {
  if (!item || item.status !== "running" || item.ownerId !== input.ownerId || !item.claimExpiresAt) return false;
  if (timestampMs(now) < timestampMs(item.updatedAt)) return false;
  if (timestampMs(item.claimExpiresAt) <= timestampMs(now)) return false;
  if (item.version === 1) return item.claimToken === input.claimToken;
  if (!item.claimTokenHash || !item.claimBindingDigest || !item.workerCapabilityDigest) return false;
  if (!safeEqual(item.claimTokenHash, sha256Text(input.claimToken))) return false;
  if (!safeEqual(item.claimBindingDigest, claimBindingDigest(item))) return false;
  if (input.capabilities && !safeEqual(item.workerCapabilityDigest, sha256Canonical(input.capabilities))) return false;
  return true;
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical values must use safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertDenseArray(value, "canonical array");
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  assertPlainRecord(value, "canonical object");
  return `{${Object.keys(value).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function assertPlainRecord(
  value: unknown,
  label: string,
  allowedKeys?: ReadonlySet<string>
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} cannot contain symbol keys`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError(`${label}.${key} must be an enumerable data property`);
    if (allowedKeys && !allowedKeys.has(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  }
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be an array`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} cannot contain symbols`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError(`${label} cannot be sparse`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError(`${label}[${index}] must be an enumerable data property`);
  }
  const allowed = new Set(["length", ...value.map((_, index) => String(index))]);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains extra property ${key}`);
  }
}

function normalizeStringSet(value: unknown, label: string): string[] {
  assertDenseArray(value, label);
  const normalized = value.map((entry, index) => normalizeCapabilityName(entry, `${label}[${index}]`));
  return [...new Set(normalized)].sort(codeUnitCompare);
}

function normalizeProviderSet(value: unknown, label: string): WorkerProviderId[] {
  const providers = normalizeStringSet(value, label);
  for (const provider of providers) {
    if (provider !== "builtin" && provider !== "claude" && provider !== "codex") throw new TypeError(`${label} contains unsupported runtime ${provider}`);
  }
  return providers as WorkerProviderId[];
}

function normalizeCapabilityName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value)) {
    throw new TypeError(`${label} is not a valid capability identifier`);
  }
  return value;
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a non-empty printable identifier`);
  }
  return value;
}

function normalizeDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return value;
}

function normalizeSecretToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("claimToken is invalid");
  }
  return value;
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp with milliseconds`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${label} is not a valid timestamp`);
  return value;
}

function timestampMs(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError("invalid timestamp");
  return result;
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 86_400_000) throw new RangeError("ttlMs must be a safe integer between 1000 and 86400000");
  return ttl;
}

function normalizePriority(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < -1_000_000 || (value as number) > 1_000_000) throw new RangeError("priority is out of range");
  return value as number;
}

function normalizePositiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new RangeError(`${label} must be a positive safe integer`);
  return value as number;
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeEnforcement(value: unknown): SandboxEnforcementLevel {
  if (value !== "none" && value !== "postcheck" && value !== "enforced") throw new TypeError("invalid sandbox enforcement level");
  return value;
}

function copyOptionalTimestamp(value: Record<string, unknown>, key: string): Record<string, string> {
  return value[key] === undefined ? {} : { [key]: normalizeTimestamp(value[key], key) };
}

function copyOptionalIdentifier(value: Record<string, unknown>, key: string): Record<string, string> {
  return value[key] === undefined ? {} : { [key]: normalizeIdentifier(value[key], key) };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function containsAll(available: string[], required: string[]): boolean {
  const values = new Set(available);
  return required.every((value) => values.has(value));
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function assertNonEmptyPath(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || /\u0000/.test(value)) throw new TypeError(`${label} is invalid`);
}

const ENFORCEMENT_RANK: Record<SandboxEnforcementLevel, number> = { none: 0, postcheck: 1, enforced: 2 };
const QUEUE_STATUSES = new Set<RunJobQueueStatus>(["queued", "running", "completed", "failed", "cancelled"]);
const TERMINAL_STATUSES = new Set<Exclude<RunJobQueueStatus, "queued" | "running">>(["completed", "failed", "cancelled"]);
const QUEUE_INPUT_KEYS = new Set(["runId", "projectId", "taskId", "status", "priority", "attempt", "recovered", "createdAt", "updatedAt", "startedAt", "finishedAt", "resumeFromRunId", "interruptedAt", "version", "tenantId", "requirements"]);
const CLAIM_INPUT_KEYS = new Set(["ownerId", "now", "ttlMs", "capabilities"]);
// capacity/event/run are legacy API envelope fields. Queue authentication ignores them,
// while retaining compatibility until the HTTP layer passes a narrowed claim object.
const CLAIM_TOKEN_INPUT_KEYS = new Set([...CLAIM_INPUT_KEYS, "claimToken", "capacity", "event", "run"]);
const CAPABILITY_KEYS = new Set(["providers", "languages", "gateRunnerIds", "sandboxBackends", "tenantIds", "tools"]);
const SANDBOX_CAPABILITY_KEYS = new Set(["backendId", "enforcement", "capabilities"]);
const REQUIREMENT_KEYS = new Set(["requiredProviders", "requiredLanguages", "requiredGateRunnerIds", "sandbox", "requiredTools"]);
const SANDBOX_REQUIREMENT_KEYS = new Set(["allowedBackendIds", "minEnforcement", "requiredCapabilities"]);
const QUEUE_ITEM_KEYS = new Set([
  "version", "runId", "projectId", "taskId", "status", "priority", "attempt", "recovered", "createdAt", "updatedAt",
  "startedAt", "finishedAt", "resumeFromRunId", "ownerId", "claimToken", "claimTokenHash", "claimBindingDigest",
  "workerCapabilityDigest", "tenantId", "requirements", "requirementsDigest", "claimedAt", "claimExpiresAt", "heartbeatAt", "releasedAt"
]);
