import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import {
  normalizeWorkerCapabilities,
  workerCapabilityDigest,
  type PartialWorkerCapabilitySet,
  type RunJobQueueStatus,
  type WorkerCapabilitySet
} from "./runJobQueue.js";

export type RunJobWorkerStatus = "idle" | "running";
export type RunJobWorkerState = RunJobWorkerStatus | "stale";

export interface RunJobWorkerRecord {
  version: 1 | 2;
  ownerId: string;
  status: RunJobWorkerStatus;
  capacity: number;
  activeRunIds: string[];
  startedAt: string;
  updatedAt: string;
  lastSeenAt: string;
  heartbeatExpiresAt: string;
  activeRunId?: string;
  capabilities?: WorkerCapabilitySet;
  capabilityDigest?: string;
  lastClaimedAt?: string;
  lastReleasedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
  completedRunCount: number;
  failedRunCount: number;
  cancelledRunCount: number;
  releasedRunCount: number;
}

export interface RunJobWorkerView extends RunJobWorkerRecord {
  state: RunJobWorkerState;
  stale: boolean;
  activeRunCount: number;
  availableSlots: number;
}

export interface RunJobWorkerRegistryOptions {
  rootDir: string;
}

export interface RunJobWorkerHeartbeatInput {
  ownerId: string;
  status?: RunJobWorkerStatus;
  activeRunId?: string;
  activeRunIds?: string[];
  capacity?: number;
  ttlMs?: number;
  now?: string;
  lastError?: string;
  capabilities?: PartialWorkerCapabilitySet;
}

export interface RunJobWorkerFinishInput {
  ownerId: string;
  runId?: string;
  status: Exclude<RunJobQueueStatus, "queued" | "running">;
  capacity?: number;
  ttlMs?: number;
  now?: string;
}

export interface RunJobWorkerReleaseInput {
  ownerId: string;
  runId?: string;
  capacity?: number;
  ttlMs?: number;
  now?: string;
  lastError?: string;
}

export interface RunJobWorkerCapacityInput {
  ownerId: string;
  capacity?: number;
  now?: string;
}

export class RunJobWorkerRegistry {
  constructor(private readonly options: RunJobWorkerRegistryOptions) {
    assertPath(options.rootDir);
  }

  heartbeat(
    input: RunJobWorkerHeartbeatInput,
    tenantId = LOCAL_WORKER_TENANT_ID
  ): RunJobWorkerRecord {
    assertInputObject(input, "worker heartbeat", HEARTBEAT_INPUT_KEYS);
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const now = normalizeNow(input.now);
    const requestedStatus = normalizeStatus(input.status ?? "idle");
    const current = this.read(ownerId, tenantId);
    const capabilityFields = resolveCapabilityFields(current, input.capabilities);
    const capacity = normalizeCapacity(input.capacity ?? current?.capacity);
    const currentActiveRunIds = current?.activeRunIds ?? (current?.activeRunId ? [current.activeRunId] : []);
    const reportedActiveRunIds = normalizeActiveRunIds([
      ...(input.activeRunIds ?? []),
      ...(input.activeRunId ? [input.activeRunId] : [])
    ]);
    if (requestedStatus === "idle" && reportedActiveRunIds.length > 0) {
      throw new TypeError("idle worker heartbeat cannot report active runs");
    }
    // A heartbeat cannot silently release work. Only markReleased/markFinished may
    // remove an active run from the registry.
    const status: RunJobWorkerStatus = currentActiveRunIds.length > 0 ? "running" : requestedStatus;
    const activeRunIds = status === "running"
      ? normalizeActiveRunIds([...currentActiveRunIds, ...reportedActiveRunIds])
      : [];
    if (activeRunIds.length > capacity) throw new RangeError("worker capacity is below its active run count");
    if (status === "running" && activeRunIds.length === 0) {
      throw new TypeError("running worker heartbeat requires an active run");
    }
    const record = buildRecord({
      current,
      ownerId,
      status,
      capacity,
      activeRunIds,
      now,
      ttlMs: input.ttlMs,
      capabilityFields,
      lastError: input.lastError
    });
    this.write(record, tenantId);
    return record;
  }

  markClaimed(
    input: RunJobWorkerHeartbeatInput & { activeRunId: string },
    tenantId = LOCAL_WORKER_TENANT_ID
  ): RunJobWorkerRecord {
    assertInputObject(input, "worker claim", HEARTBEAT_INPUT_KEYS);
    const now = normalizeNow(input.now);
    const activeRunId = normalizeIdentifier(input.activeRunId, "activeRunId");
    const record = this.heartbeat(
      { ...input, activeRunId, status: "running", now },
      tenantId
    );
    const activeRunIds = normalizeActiveRunIds([...record.activeRunIds, activeRunId]);
    if (activeRunIds.length > record.capacity) throw new RangeError("worker has no capacity for another run");
    const next: RunJobWorkerRecord = {
      ...record,
      status: "running",
      lastClaimedAt: now,
      activeRunId,
      activeRunIds
    };
    this.write(next, tenantId);
    return next;
  }

  markReleased(
    input: RunJobWorkerReleaseInput,
    tenantId = LOCAL_WORKER_TENANT_ID
  ): RunJobWorkerRecord {
    assertInputObject(input, "worker release", RELEASE_INPUT_KEYS);
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const now = normalizeNow(input.now);
    const current = this.read(ownerId, tenantId);
    if (input.runId && (!current || !current.activeRunIds.includes(input.runId))) {
      throw new Error("cannot release a run that is not active on this worker");
    }
    const activeRunIds = input.runId
      ? normalizeActiveRunIds((current?.activeRunIds ?? []).filter((runId) => runId !== normalizeIdentifier(input.runId, "runId")))
      : [];
    const status: RunJobWorkerStatus = activeRunIds.length > 0 ? "running" : "idle";
    const capabilityFields = resolveCapabilityFields(current, undefined);
    const record = buildRecord({
      current,
      ownerId,
      status,
      activeRunIds,
      capacity: normalizeCapacity(input.capacity ?? current?.capacity),
      ttlMs: input.ttlMs,
      now,
      capabilityFields,
      lastError: input.lastError
    });
    const next: RunJobWorkerRecord = {
      ...record,
      releasedRunCount: (current?.releasedRunCount ?? 0) + 1,
      lastReleasedAt: now
    };
    this.write(next, tenantId);
    return next;
  }

  markFinished(
    input: RunJobWorkerFinishInput,
    tenantId = LOCAL_WORKER_TENANT_ID
  ): RunJobWorkerRecord {
    assertInputObject(input, "worker finish", FINISH_INPUT_KEYS);
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const now = normalizeNow(input.now);
    const current = this.read(ownerId, tenantId);
    if (input.status !== "completed" && input.status !== "failed" && input.status !== "cancelled") {
      throw new TypeError("invalid terminal status");
    }
    if (input.runId && (!current || !current.activeRunIds.includes(input.runId))) {
      throw new Error("cannot finish a run that is not active on this worker");
    }
    const remainingRunIds = input.runId
      ? normalizeActiveRunIds((current?.activeRunIds ?? []).filter((runId) => runId !== normalizeIdentifier(input.runId, "runId")))
      : [];
    const status: RunJobWorkerStatus = remainingRunIds.length > 0 ? "running" : "idle";
    const record = buildRecord({
      current,
      ownerId,
      status,
      activeRunIds: remainingRunIds,
      capacity: normalizeCapacity(input.capacity ?? current?.capacity),
      ttlMs: input.ttlMs,
      now,
      capabilityFields: resolveCapabilityFields(current, undefined)
    });
    const next: RunJobWorkerRecord = {
      ...record,
      completedRunCount: (current?.completedRunCount ?? 0) + (input.status === "completed" ? 1 : 0),
      failedRunCount: (current?.failedRunCount ?? 0) + (input.status === "failed" ? 1 : 0),
      cancelledRunCount: (current?.cancelledRunCount ?? 0) + (input.status === "cancelled" ? 1 : 0),
      lastFinishedAt: now
    };
    if (remainingRunIds.length === 0) delete next.activeRunId;
    this.write(next, tenantId);
    return next;
  }

  hasClaimCapacity(
    input: RunJobWorkerCapacityInput,
    tenantId = LOCAL_WORKER_TENANT_ID
  ): {
    available: boolean;
    worker?: RunJobWorkerView;
  } {
    assertInputObject(input, "worker capacity input", CAPACITY_INPUT_KEYS);
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const current = this.read(ownerId, tenantId);
    if (!current) return { available: true };
    const nowMs = input.now === undefined ? Date.now() : timestampMs(normalizeTimestamp(input.now, "now"));
    const worker = workerView(current, nowMs);
    if (worker.state === "stale" || worker.state === "idle") return { available: true, worker };
    const capacity = normalizeCapacity(input.capacity ?? worker.capacity);
    return {
      available: worker.activeRunCount < capacity,
      worker: { ...worker, capacity, availableSlots: Math.max(0, capacity - worker.activeRunCount) }
    };
  }

  read(
    ownerId: string,
    tenantId = LOCAL_WORKER_TENANT_ID
  ): RunJobWorkerRecord | undefined {
    const path = this.itemPath(
      normalizeIdentifier(ownerId, "ownerId"),
      tenantId
    );
    if (!existsSync(path)) return undefined;
    try {
      return normalizeWorkerRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      return undefined;
    }
  }

  list(
    now?: string,
    tenantId = LOCAL_WORKER_TENANT_ID
  ): RunJobWorkerView[] {
    const rootDir = this.ensureRoot(tenantId);
    const nowMs = now === undefined ? Date.now() : timestampMs(normalizeTimestamp(now, "now"));
    return readdirSync(rootDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        try {
          return normalizeWorkerRecord(JSON.parse(readFileSync(join(rootDir, entry), "utf8")) as unknown);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is RunJobWorkerRecord => Boolean(item))
      .map((item) => workerView(item, nowMs))
      .sort((left, right) => codeUnitCompare(left.ownerId, right.ownerId));
  }

  private write(
    item: RunJobWorkerRecord,
    tenantId = LOCAL_WORKER_TENANT_ID
  ): void {
    const normalized = normalizeWorkerRecord(item);
    this.ensureRoot(tenantId);
    const path = this.itemPath(normalized.ownerId, tenantId);
    const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    renameSync(tmpPath, path);
  }

  private itemPath(ownerId: string, tenantId: string): string {
    return join(this.tenantRoot(tenantId), `${safeFileName(ownerId)}.json`);
  }

  private tenantRoot(tenantId: string): string {
    const normalizedTenantId = normalizeIdentifier(tenantId, "tenantId");
    if (normalizedTenantId === LOCAL_WORKER_TENANT_ID) return this.options.rootDir;
    const digest = createHash("sha256").update(normalizedTenantId).digest("hex");
    return join(
      this.options.rootDir,
      "tenants",
      `${safeFileName(normalizedTenantId).slice(0, 64)}-${digest}`
    );
  }

  private ensureRoot(tenantId = LOCAL_WORKER_TENANT_ID): string {
    const rootDir = this.tenantRoot(tenantId);
    mkdirSync(rootDir, { recursive: true });
    return rootDir;
  }
}

export function summarizeRunJobWorkers(workers: RunJobWorkerView[]) {
  return {
    total: workers.length,
    idle: workers.filter((worker) => worker.state === "idle").length,
    running: workers.filter((worker) => worker.state === "running").length,
    stale: workers.filter((worker) => worker.state === "stale").length,
    capacity: workers.reduce((sum, worker) => sum + worker.capacity, 0),
    activeRunCount: workers.reduce((sum, worker) => sum + worker.activeRunCount, 0),
    availableSlots: workers.reduce((sum, worker) => sum + worker.availableSlots, 0)
  };
}

interface CapabilityFields {
  version: 1 | 2;
  capabilities?: WorkerCapabilitySet;
  capabilityDigest?: string;
}

interface BuildRecordInput {
  current?: RunJobWorkerRecord;
  ownerId: string;
  status: RunJobWorkerStatus;
  capacity: number;
  activeRunIds: string[];
  now: string;
  ttlMs?: number;
  capabilityFields: CapabilityFields;
  lastError?: string;
}

function buildRecord(input: BuildRecordInput): RunJobWorkerRecord {
  if (input.current && timestampMs(input.now) < timestampMs(input.current.updatedAt)) {
    throw new RangeError("worker heartbeat time cannot move backwards");
  }
  const lastError = input.lastError === undefined ? undefined : normalizeLastError(input.lastError);
  return {
    version: input.capabilityFields.version,
    ownerId: input.ownerId,
    status: input.status,
    capacity: input.capacity,
    activeRunIds: input.activeRunIds,
    startedAt: input.current?.startedAt ?? input.now,
    updatedAt: input.now,
    lastSeenAt: input.now,
    heartbeatExpiresAt: expiresAt(input.now, input.ttlMs),
    completedRunCount: input.current?.completedRunCount ?? 0,
    failedRunCount: input.current?.failedRunCount ?? 0,
    cancelledRunCount: input.current?.cancelledRunCount ?? 0,
    releasedRunCount: input.current?.releasedRunCount ?? 0,
    ...(input.activeRunIds[0] ? { activeRunId: input.activeRunIds[0] } : {}),
    ...(input.capabilityFields.capabilities ? { capabilities: input.capabilityFields.capabilities } : {}),
    ...(input.capabilityFields.capabilityDigest ? { capabilityDigest: input.capabilityFields.capabilityDigest } : {}),
    ...(input.current?.lastClaimedAt ? { lastClaimedAt: input.current.lastClaimedAt } : {}),
    ...(input.current?.lastReleasedAt ? { lastReleasedAt: input.current.lastReleasedAt } : {}),
    ...(input.current?.lastFinishedAt ? { lastFinishedAt: input.current.lastFinishedAt } : {}),
    ...(input.current?.lastError && input.status === "running" ? { lastError: input.current.lastError } : {}),
    ...(lastError ? { lastError } : {})
  };
}

function resolveCapabilityFields(
  current: RunJobWorkerRecord | undefined,
  input: PartialWorkerCapabilitySet | undefined
): CapabilityFields {
  if (input === undefined) {
    return current?.version === 2 && current.capabilities && current.capabilityDigest
      ? { version: 2, capabilities: current.capabilities, capabilityDigest: current.capabilityDigest }
      : { version: 1 };
  }
  const capabilities = normalizeWorkerCapabilities(input);
  const capabilityDigest = workerCapabilityDigest(capabilities);
  if (
    current && current.activeRunIds.length > 0 &&
    current.capabilityDigest !== capabilityDigest
  ) {
    throw new Error("worker capabilities cannot change while runs are active");
  }
  return { version: 2, capabilities, capabilityDigest };
}

function workerView(item: RunJobWorkerRecord, nowMs: number): RunJobWorkerView {
  const stale = timestampMs(item.heartbeatExpiresAt) <= nowMs;
  const activeRunCount = item.status === "running" && !stale ? item.activeRunIds.length : 0;
  return {
    ...item,
    state: stale ? "stale" : item.status,
    stale,
    activeRunCount,
    availableSlots: stale ? 0 : Math.max(0, item.capacity - activeRunCount)
  };
}

function normalizeWorkerRecord(value: unknown): RunJobWorkerRecord {
  if (!isPlainObject(value)) throw new TypeError("worker record must be a plain object");
  const version = value.version;
  if (version !== 1 && version !== 2) throw new TypeError("invalid worker record version");
  const status = normalizeStatus(value.status);
  const capacity = normalizeCapacity(value.capacity as number | undefined);
  const sourceRunIds = Array.isArray(value.activeRunIds) ? value.activeRunIds : [];
  const activeRunIds = normalizeActiveRunIds([
    ...sourceRunIds,
    ...(typeof value.activeRunId === "string" ? [value.activeRunId] : [])
  ]).slice(0, capacity);
  if (status === "running" && activeRunIds.length === 0) throw new TypeError("running worker has no active run");
  const record: RunJobWorkerRecord = {
    version,
    ownerId: normalizeIdentifier(value.ownerId, "ownerId"),
    status,
    capacity,
    activeRunIds,
    startedAt: normalizeTimestamp(value.startedAt, "startedAt"),
    updatedAt: normalizeTimestamp(value.updatedAt, "updatedAt"),
    lastSeenAt: normalizeTimestamp(value.lastSeenAt, "lastSeenAt"),
    heartbeatExpiresAt: normalizeTimestamp(value.heartbeatExpiresAt, "heartbeatExpiresAt"),
    completedRunCount: normalizeCounter(value.completedRunCount, "completedRunCount"),
    failedRunCount: normalizeCounter(value.failedRunCount, "failedRunCount"),
    cancelledRunCount: normalizeCounter(value.cancelledRunCount, "cancelledRunCount"),
    releasedRunCount: normalizeCounter(value.releasedRunCount, "releasedRunCount"),
    ...(activeRunIds[0] ? { activeRunId: activeRunIds[0] } : {}),
    ...optionalTimestamp(value, "lastClaimedAt"),
    ...optionalTimestamp(value, "lastReleasedAt"),
    ...optionalTimestamp(value, "lastFinishedAt"),
    ...(typeof value.lastError === "string" ? { lastError: normalizeLastError(value.lastError) } : {})
  };
  if (version === 2) {
    const capabilities = normalizeWorkerCapabilities(value.capabilities as PartialWorkerCapabilitySet);
    const digest = workerCapabilityDigest(capabilities);
    if (value.capabilityDigest !== digest) throw new TypeError("worker capability digest mismatch");
    record.capabilities = capabilities;
    record.capabilityDigest = digest;
  }
  return record;
}

function expiresAt(now: string, ttlMs: number | undefined): string {
  return new Date(timestampMs(now) + normalizeTtl(ttlMs)).toISOString();
}

function normalizeNow(now: string | undefined): string {
  return now === undefined ? new Date().toISOString() : normalizeTimestamp(now, "now");
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp with milliseconds`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${label} is invalid`);
  return value;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("invalid timestamp");
  return parsed;
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 86_400_000) throw new RangeError("ttlMs must be between 1000 and 86400000");
  return ttl;
}

function normalizeCapacity(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) throw new RangeError("capacity must be between 1 and 256");
  return value;
}

function normalizeCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value as number;
}

function normalizeStatus(value: unknown): RunJobWorkerStatus {
  if (value !== "idle" && value !== "running") throw new TypeError("invalid worker status");
  return value;
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a non-empty printable identifier`);
  }
  return value;
}

function normalizeActiveRunIds(values: unknown[]): string[] {
  if (!Array.isArray(values)) throw new TypeError("activeRunIds must be an array");
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !("value" in descriptor)) throw new TypeError("activeRunIds must be dense data properties");
  }
  return [...new Set(values.map((value) => normalizeIdentifier(value, "activeRunId")))];
}

function normalizeLastError(value: string): string {
  if (value.length > 4_096 || /\u0000/.test(value)) throw new TypeError("lastError is invalid");
  return value;
}

function optionalTimestamp(value: Record<string, unknown>, key: string): Record<string, string> {
  return value[key] === undefined ? {} : { [key]: normalizeTimestamp(value[key], key) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertInputObject(value: unknown, label: string, allowedKeys: ReadonlySet<string>): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} cannot contain symbols`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError(`${label}.${key} must be an enumerable data property`);
    if (!allowedKeys.has(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  }
}

function assertPath(value: string): void {
  if (typeof value !== "string" || value.length === 0 || /\u0000/.test(value)) throw new TypeError("rootDir is invalid");
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const HEARTBEAT_INPUT_KEYS = new Set(["ownerId", "status", "activeRunId", "activeRunIds", "capacity", "ttlMs", "now", "lastError", "capabilities"]);
const RELEASE_INPUT_KEYS = new Set(["ownerId", "runId", "capacity", "ttlMs", "now", "lastError"]);
const FINISH_INPUT_KEYS = new Set(["ownerId", "runId", "status", "capacity", "ttlMs", "now"]);
const CAPACITY_INPUT_KEYS = new Set(["ownerId", "capacity", "now"]);
const LOCAL_WORKER_TENANT_ID = "local";
