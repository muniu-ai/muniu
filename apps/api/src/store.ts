import { CLASSIC_WORKFLOW_REF } from "@mn/core";
import type {
  AgentTask,
  GateArtifactV2,
  Project,
  RunEvent,
  RunRecord
} from "@mn/core";
import type {
  PackLock,
  ScopedGovernanceLayer,
  StandardPackManifest,
  Waiver
} from "@mn/governance";
import type { GovernedRunState } from "@mn/loop";
import type {
  EvalAssetRevision,
  LearningProposal,
  MaturityReport,
  TraceAnalysis,
  TraceGraph
} from "@mn/evidence";
import type { MaturitySourceBinding } from "./evidenceTruth.js";
import type { RunScopedCasObjectRef } from "./runScopedCas.js";
import type { AuthoritativeGateReceipt } from "./authoritativeGateVerification.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface ApiStateSnapshotV1 {
  version: 1;
  projects: Project[];
  tasks: AgentTask[];
  runs: RunRecord[];
  runJobs?: RunJobRecord[];
  events: Array<{ runId: string; events: RunEvent[] }>;
}

interface ApiStateSnapshotV2 {
  version: 2;
  tenantId: string;
  projects: Project[];
  tasks: AgentTask[];
  runs: RunRecord[];
  runJobs: RunJobRecord[];
  events: Array<{ runId: string; events: RunEvent[] }>;
  standardPacks?: StandardPackRecord[];
  governanceLayers?: GovernanceLayerRecord[];
  waivers?: Waiver[];
  scopedWaivers?: Array<{ key: string; tenantId: string; waiver: Waiver }>;
  projectPackLocks?: ProjectPackLockRecord[];
  specSetTenants?: Array<{ specSetId: string; tenantId: string }>;
  governedLoopStates?: GovernedRunState[];
  auditEvents?: AuditEvent[];
  evalAssets?: EvalAssetRecord[];
  traceGraphs?: TraceGraphRecord[];
  learningProposals?: LearningProposalRecord[];
  maturityReports?: MaturityReportRecord[];
  gateArtifactHandles?: GateArtifactHandleRecord[];
  authoritativeGateReceipts?: AuthoritativeGateReceiptRecord[];
}

type ApiStateSnapshot = ApiStateSnapshotV1 | ApiStateSnapshotV2;

export const LOCAL_TENANT_ID = "local";
export const BUILTIN_DEFAULT_STANDARD_PACK = "builtin/default@1";

export function scopedTenantRecordKey(tenantId: string, resourceId: string): string {
  // Scope local records too. Leaving local keys unscoped makes a legitimate
  // resource id such as `["tenant-a","waiver-1"]` indistinguishable from the
  // historical JSON encoding of a tenant-scoped key.
  return JSON.stringify([tenantId, resourceId]);
}

function tenantIdFromScopedRecordKey(key: string): string | undefined {
  try {
    const value = JSON.parse(key) as unknown;
    return Array.isArray(value) && value.length === 2 &&
      typeof value[0] === "string" && typeof value[1] === "string"
      ? value[0]
      : undefined;
  } catch {
    return undefined;
  }
}

export interface StandardPackRecord {
  key: string;
  tenantId?: string;
  manifest: StandardPackManifest;
  digest: string;
  importedAt: string;
  importedBy: string;
  trust: "builtin" | "local" | "verified";
}

export interface GovernanceLayerRecord {
  key: string;
  tenantId?: string;
  layer: ScopedGovernanceLayer;
  activatedAt: string;
  activatedBy: string;
  packKey: string;
}

export interface ProjectPackLockRecord {
  projectId: string;
  tenantId?: string;
  lock: PackLock;
  updatedAt: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly projectId?: string;
  readonly policyDecision: "allow" | "deny";
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  readonly packDigest?: string;
  readonly traceId: string;
  readonly result: "success" | "failure";
  readonly timestamp: string;
  readonly statusCode: number;
  /** Optional immutable evidence attached to provider-usage reconciliation. */
  readonly evidence?: Readonly<{
    uri: string;
    sha256: string;
    kind: "provider" | "invoice";
    verification?: Readonly<{
      objectKey: string;
      byteLength: number;
      verifiedAt: string;
      verificationDigest: string;
      envelopeDigest?: string;
      sourceReference?: string;
      issuedAt?: string;
    }>;
  }>;
  readonly basisDigest?: string;
  readonly reason?: string;
  readonly ticket?: string;
}

export interface EvalAssetRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly asset: EvalAssetRevision;
}

export interface TraceGraphRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly id: string;
  readonly graph: TraceGraph;
  readonly analysis?: TraceAnalysis;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface LearningProposalRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proposal: LearningProposal;
}

export interface MaturityReportRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly id: string;
  readonly report: MaturityReport;
  readonly generatedAt: string;
  readonly generatedBy: string;
  /** Present for enterprise reports whose inputs were derived by the server. */
  readonly source?: MaturitySourceBinding;
}

/** Durable authorization/binding record for an opaque Gate artifact handle.
 * The CAS ref proves bytes; this record proves which claim may introduce those
 * bytes into which tenant/project/run/result. */
export interface GateArtifactHandleRecord {
  readonly schemaVersion: 1;
  readonly handle: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly gateResultId: string;
  readonly gateId: string;
  readonly artifactId: string;
  readonly kind: GateArtifactV2["kind"];
  readonly contentType: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly cas: RunScopedCasObjectRef;
  readonly claimTokenHash: string;
  readonly ownerId: string;
  readonly registeredAt: string;
}

/** API-only durable receipt. It is deliberately not part of RunRecord or the
 * worker wire format, so a worker can neither introduce nor rewrite it. */
export interface AuthoritativeGateReceiptRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stageAttemptId: string;
  readonly receipt: AuthoritativeGateReceipt;
}

/**
 * Complete enterprise cache image reconstructed from PostgreSQL. PostgreSQL is
 * the source of truth in the enterprise profile; the in-process maps only
 * provide fast route access and local event subscriptions.
 */
export interface EnterpriseStoreState {
  readonly projects: readonly Project[];
  readonly tasks: readonly AgentTask[];
  readonly runs: readonly RunRecord[];
  readonly runJobs: readonly RunJobRecord[];
  readonly events: readonly { runId: string; events: readonly RunEvent[] }[];
  readonly standardPacks: readonly StandardPackRecord[];
  readonly governanceLayers: readonly GovernanceLayerRecord[];
  readonly waivers: readonly { tenantId: string; waiver: Waiver }[];
  readonly projectPackLocks: readonly ProjectPackLockRecord[];
  readonly specSetTenants: readonly { specSetId: string; tenantId: string }[];
  readonly governedLoopStates: readonly GovernedRunState[];
  readonly auditEvents: readonly AuditEvent[];
  readonly evalAssets: readonly EvalAssetRecord[];
  readonly traceGraphs: readonly TraceGraphRecord[];
  readonly learningProposals: readonly LearningProposalRecord[];
  readonly maturityReports: readonly MaturityReportRecord[];
  readonly gateArtifactHandles: readonly GateArtifactHandleRecord[];
  readonly authoritativeGateReceipts: readonly AuthoritativeGateReceiptRecord[];
}

export function scopedEvidenceRecordKey(
  tenantId: string,
  projectId: string,
  resourceId: string,
  revision?: number
): string {
  return JSON.stringify(
    revision === undefined
      ? [tenantId, projectId, resourceId]
      : [tenantId, projectId, resourceId, revision]
  );
}

type RunJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunJobRecord {
  runId: string;
  tenantId?: string;
  projectId: string;
  taskId: string;
  status: RunJobStatus;
  priority: number;
  attempt: number;
  recovered: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  resumeFromRunId?: string;
  interruptedAt?: string;
}

class PersistedMap<K, V> extends Map<K, V> {
  constructor(
    private readonly onChange: () => void,
    entries?: readonly (readonly [K, V])[]
  ) {
    super(entries);
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    this.onChange();
    return this;
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key);
    if (deleted) this.onChange();
    return deleted;
  }

  override clear(): void {
    if (this.size === 0) return;
    super.clear();
    this.onChange();
  }

  replace(entries: readonly (readonly [K, V])[]): void {
    super.clear();
    for (const [key, value] of entries) {
      super.set(key, value);
    }
  }
}

export class MemoryStore {
  readonly projects: PersistedMap<string, Project>;
  readonly tasks: PersistedMap<string, AgentTask>;
  readonly runs: PersistedMap<string, RunRecord>;
  readonly runJobs: PersistedMap<string, RunJobRecord>;
  readonly events: PersistedMap<string, RunEvent[]>;
  readonly standardPacks: PersistedMap<string, StandardPackRecord>;
  readonly governanceLayers: PersistedMap<string, GovernanceLayerRecord>;
  readonly waivers: PersistedMap<string, Waiver>;
  readonly projectPackLocks: PersistedMap<string, ProjectPackLockRecord>;
  readonly specSetTenants: PersistedMap<string, string>;
  readonly governedLoopStates: PersistedMap<string, GovernedRunState>;
  readonly auditEvents: PersistedMap<string, AuditEvent>;
  readonly evalAssets: PersistedMap<string, EvalAssetRecord>;
  readonly traceGraphs: PersistedMap<string, TraceGraphRecord>;
  readonly learningProposals: PersistedMap<string, LearningProposalRecord>;
  readonly maturityReports: PersistedMap<string, MaturityReportRecord>;
  readonly gateArtifactHandles: PersistedMap<string, GateArtifactHandleRecord>;
  readonly authoritativeGateReceipts: PersistedMap<string, AuthoritativeGateReceiptRecord>;
  private readonly eventListeners = new Map<string, Set<(event: RunEvent) => void>>();
  private readonly statePath: string | undefined;
  private hydrating = false;
  private batching = 0;
  private pendingPersist = false;

  constructor(options: { statePath?: string } = {}) {
    this.statePath = options.statePath;
    this.projects = new PersistedMap<string, Project>(() => this.onChange());
    this.tasks = new PersistedMap<string, AgentTask>(() => this.onChange());
    this.runs = new PersistedMap<string, RunRecord>(() => this.onChange());
    this.runJobs = new PersistedMap<string, RunJobRecord>(() => this.onChange());
    this.events = new PersistedMap<string, RunEvent[]>(() => this.onChange());
    this.standardPacks = new PersistedMap<string, StandardPackRecord>(() => this.onChange());
    this.governanceLayers = new PersistedMap<string, GovernanceLayerRecord>(() => this.onChange());
    this.waivers = new PersistedMap<string, Waiver>(() => this.onChange());
    this.projectPackLocks = new PersistedMap<string, ProjectPackLockRecord>(() => this.onChange());
    this.specSetTenants = new PersistedMap<string, string>(() => this.onChange());
    this.governedLoopStates = new PersistedMap<string, GovernedRunState>(() => this.onChange());
    this.auditEvents = new PersistedMap<string, AuditEvent>(() => this.onChange());
    this.evalAssets = new PersistedMap<string, EvalAssetRecord>(() => this.onChange());
    this.traceGraphs = new PersistedMap<string, TraceGraphRecord>(() => this.onChange());
    this.learningProposals = new PersistedMap<string, LearningProposalRecord>(
      () => this.onChange()
    );
    this.maturityReports = new PersistedMap<string, MaturityReportRecord>(
      () => this.onChange()
    );
    this.gateArtifactHandles = new PersistedMap<string, GateArtifactHandleRecord>(
      () => this.onChange()
    );
    this.authoritativeGateReceipts = new PersistedMap<
      string,
      AuthoritativeGateReceiptRecord
    >(() => this.onChange());
    this.load();
  }

  appendEvent(event: RunEvent): void {
    const events = [...(this.events.get(event.runId) ?? []), event];
    this.events.set(event.runId, events);

    for (const listener of this.eventListeners.get(event.runId) ?? []) {
      listener(event);
    }
  }

  appendAuditEvent(event: AuditEvent): void {
    if (this.auditEvents.has(event.id)) {
      throw new Error(`Audit event ${event.id} already exists`);
    }
    this.auditEvents.set(event.id, Object.freeze({ ...event }));
  }

  restoreEnterpriseState(state: EnterpriseStoreState): void {
    this.hydrating = true;
    try {
      this.projects.replace(state.projects.map((record) => [record.id, record]));
      this.tasks.replace(state.tasks.map((record) => [record.id, record]));
      this.runs.replace(state.runs.map((record) => [record.id, record]));
      this.runJobs.replace(state.runJobs.map((record) => [record.runId, record]));
      this.events.replace(
        state.events.map((record) => [record.runId, [...record.events]])
      );
      this.standardPacks.replace(
        state.standardPacks.map((record) => [
          scopedTenantRecordKey(record.tenantId ?? LOCAL_TENANT_ID, record.key),
          record
        ])
      );
      this.governanceLayers.replace(
        state.governanceLayers.map((record) => [
          scopedTenantRecordKey(record.tenantId ?? LOCAL_TENANT_ID, record.key),
          record
        ])
      );
      this.waivers.replace(
        state.waivers.map(({ tenantId, waiver }) => [
          scopedTenantRecordKey(tenantId, waiver.id),
          waiver
        ])
      );
      this.projectPackLocks.replace(
        state.projectPackLocks.map((record) => [
          scopedTenantRecordKey(
            record.tenantId ?? LOCAL_TENANT_ID,
            record.projectId
          ),
          record
        ])
      );
      this.specSetTenants.replace(
        state.specSetTenants.map((record) => [record.specSetId, record.tenantId])
      );
      this.governedLoopStates.replace(
        state.governedLoopStates.map((record) => [record.runId, record])
      );
      this.auditEvents.replace(
        state.auditEvents.map((record) => [record.id, record])
      );
      this.evalAssets.replace(
        state.evalAssets.map((record) => [
          scopedEvidenceRecordKey(
            record.tenantId,
            record.projectId,
            record.asset.id,
            record.asset.revision
          ),
          record
        ])
      );
      this.traceGraphs.replace(
        state.traceGraphs.map((record) => [
          scopedEvidenceRecordKey(record.tenantId, record.projectId, record.id),
          record
        ])
      );
      this.learningProposals.replace(
        state.learningProposals.map((record) => [
          scopedEvidenceRecordKey(
            record.tenantId,
            record.projectId,
            record.proposal.id,
            record.proposal.revision
          ),
          record
        ])
      );
      this.maturityReports.replace(
        state.maturityReports.map((record) => [
          scopedEvidenceRecordKey(record.tenantId, record.projectId, record.id),
          record
        ])
      );
      this.gateArtifactHandles.replace(
        state.gateArtifactHandles.map((record) => [record.handle, record])
      );
      this.authoritativeGateReceipts.replace(
        state.authoritativeGateReceipts.map((record) => [record.id, record])
      );
    } finally {
      this.hydrating = false;
    }
  }

  subscribeEvents(runId: string, listener: (event: RunEvent) => void): () => void {
    const listeners = this.eventListeners.get(runId) ?? new Set<(event: RunEvent) => void>();
    listeners.add(listener);
    this.eventListeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.eventListeners.delete(runId);
      }
    };
  }

  findRestartablePendingRuns(): string[] {
    return [...this.runs.values()]
      .filter(
        (run) =>
          (run.status === "queued" || run.status === "preparing") &&
          run.candidates.length === 0
      )
      .map((run) => run.id);
  }

  findActiveRunJobIds(): string[] {
    return [...this.runJobs.values()]
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.runId);
  }

  queueRunJob(input: {
    runId: string;
    projectId: string;
    taskId: string;
    priority?: number;
    recovered: boolean;
    now: string;
    resumeFromRunId?: string;
  }): RunJobRecord {
    const existing = this.runJobs.get(input.runId);
    const job: RunJobRecord = {
      runId: input.runId,
      projectId: input.projectId,
      taskId: input.taskId,
      status: "queued",
      priority: input.priority ?? existing?.priority ?? 0,
      attempt: (existing?.attempt ?? 0) + 1,
      recovered: input.recovered,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
      ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {})
    };
    this.runJobs.set(input.runId, job);
    return job;
  }

  markRunJobRunning(runId: string, now: string): void {
    const job = this.runJobs.get(runId);
    if (!job) return;
    this.runJobs.set(runId, {
      ...job,
      status: "running",
      startedAt: job.startedAt ?? now,
      updatedAt: now
    });
  }

  markRunJobQueued(runId: string, now: string): void {
    const job = this.runJobs.get(runId);
    if (!job) return;
    const { startedAt: _startedAt, finishedAt: _finishedAt, ...rest } = job;
    this.runJobs.set(runId, {
      ...rest,
      status: "queued",
      updatedAt: now
    });
  }

  markRunJobFinished(runId: string, status: RunJobStatus, now: string): void {
    const job = this.runJobs.get(runId);
    if (!job) return;
    this.runJobs.set(runId, {
      ...job,
      status,
      finishedAt: now,
      updatedAt: now
    });
  }

  finishRun(run: RunRecord, status: RunJobStatus, now: string): void {
    this.batchPersist(() => {
      this.runs.set(run.id, run);
      this.markRunJobFinished(run.id, status, now);
    });
  }

  findRestartableCheckpointRuns(): string[] {
    return [...this.runs.values()]
      .filter(
        (run) =>
          (run.status === "preparing" ||
            run.status === "running" ||
            run.status === "verifying") &&
          run.candidates.length > 0 &&
          run.candidates.every(
            (candidate) =>
              (candidate.status === "completed" && Boolean(candidate.result)) ||
              (candidate.status === "queued" && !candidate.result)
          )
      )
      .map((run) => run.id);
  }

  recoverInterruptedRuns(
    now = new Date().toISOString(),
    options: { skipRunIds?: Set<string> } = {}
  ): string[] {
    const recovered: string[] = [];
    for (const run of this.runs.values()) {
      if (options.skipRunIds?.has(run.id)) continue;
      if (
        run.status !== "queued" &&
        run.status !== "preparing" &&
        run.status !== "running" &&
        run.status !== "verifying"
      ) {
        continue;
      }
      const updated: RunRecord = {
        ...run,
        status: "failed",
        candidates: run.candidates.map((candidate) => {
          if (candidate.status !== "queued" && candidate.status !== "running") {
            return candidate;
          }
          const recoveredResult = recoverInterruptedCandidateResult(
            candidate,
            run.createdAt,
            now
          );
          return {
            ...candidate,
            status: "failed" as const,
            ...(recoveredResult ? { result: recoveredResult } : {})
          };
        }),
        updatedAt: now
      };
      this.batchPersist(() => {
        this.runs.set(run.id, updated);
        this.markRunJobFinished(run.id, "failed", now);
        const failedJob = this.runJobs.get(run.id);
        if (failedJob) {
          this.runJobs.set(run.id, {
            ...failedJob,
            interruptedAt: now
          });
        }
        this.appendEvent({
          runId: run.id,
          type: "error",
          message: "Run interrupted while API was offline; use resume to start a replacement run.",
          timestamp: now
        });
      });
      recovered.push(run.id);
    }
    return recovered;
  }

  private batchPersist(action: () => void): void {
    this.batching += 1;
    try {
      action();
    } finally {
      this.batching -= 1;
      if (this.batching === 0 && this.pendingPersist) {
        this.pendingPersist = false;
        this.persist();
      }
    }
  }

  private onChange(): void {
    if (this.hydrating) return;
    if (this.batching > 0) {
      this.pendingPersist = true;
      return;
    }
    this.persist();
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    this.hydrating = true;
    try {
      const snapshot = JSON.parse(readFileSync(this.statePath, "utf8")) as ApiStateSnapshot;
      if (snapshot.version !== 1 && snapshot.version !== 2) {
        throw new Error(`Unsupported API state snapshot version: ${String((snapshot as { version?: unknown }).version)}`);
      }
      const tenantId = snapshot.version === 2 ? snapshot.tenantId : LOCAL_TENANT_ID;
      this.projects.replace(
        snapshot.projects.map((project) => [
          project.id,
          {
            ...project,
            tenantId: project.tenantId ?? tenantId,
            policyId:
              snapshot.version === 1 && project.policyId === "default"
                ? BUILTIN_DEFAULT_STANDARD_PACK
                : project.policyId
          }
        ])
      );
      this.tasks.replace(
        snapshot.tasks.map((task) => [
          task.id,
          {
            ...task,
            tenantId: task.tenantId ?? tenantId,
            workflowRef: task.workflowRef ?? CLASSIC_WORKFLOW_REF
          }
        ])
      );
      this.runs.replace(
        snapshot.runs.map((run) => [
          run.id,
          {
            ...run,
            tenantId: run.tenantId ?? tenantId,
            workflowRef: run.workflowRef ?? CLASSIC_WORKFLOW_REF
          }
        ])
      );
      this.runJobs.replace(
        (snapshot.runJobs ?? []).map((job) => [
          job.runId,
          {
            ...job,
            tenantId: job.tenantId ?? tenantId,
            priority: job.priority ?? 0
          }
        ])
      );
      this.events.replace(
        snapshot.events.map((entry) => [entry.runId, entry.events])
      );
      this.standardPacks.replace(
        (snapshot.version === 2 ? snapshot.standardPacks ?? [] : []).map((record) => [
          scopedTenantRecordKey(record.tenantId ?? LOCAL_TENANT_ID, record.key),
          record
        ])
      );
      this.governanceLayers.replace(
        (snapshot.version === 2 ? snapshot.governanceLayers ?? [] : []).map((record) => [
          scopedTenantRecordKey(record.tenantId ?? LOCAL_TENANT_ID, record.key),
          record
        ])
      );
      this.waivers.replace(
        snapshot.version === 2 && snapshot.scopedWaivers
          ? snapshot.scopedWaivers.map((record) => [
              scopedTenantRecordKey(
                // Older writers left local waiver ids unscoped and then tried
                // to infer their tenant by parsing the key. If the id itself
                // looked like `["tenant","resource"]`, that inference was
                // wrong. Equality with the waiver id unambiguously identifies
                // that legacy-local representation.
                record.key === record.waiver.id
                  ? LOCAL_TENANT_ID
                  : record.tenantId,
                record.waiver.id
              ),
              record.waiver
            ])
          : (snapshot.version === 2 ? snapshot.waivers ?? [] : []).map((waiver) => [
              scopedTenantRecordKey(LOCAL_TENANT_ID, waiver.id),
              waiver
            ])
      );
      this.projectPackLocks.replace(
        (snapshot.version === 2 ? snapshot.projectPackLocks ?? [] : []).map((record) => [
          scopedTenantRecordKey(
            record.tenantId ?? LOCAL_TENANT_ID,
            record.projectId
          ),
          record
        ])
      );
      this.specSetTenants.replace(
        (snapshot.version === 2 ? snapshot.specSetTenants ?? [] : []).map((record) => [
          record.specSetId,
          record.tenantId
        ])
      );
      this.governedLoopStates.replace(
        (snapshot.version === 2 ? snapshot.governedLoopStates ?? [] : []).map(
          (state) => [state.runId, state]
        )
      );
      this.auditEvents.replace(
        (snapshot.version === 2 ? snapshot.auditEvents ?? [] : []).map(
          (event) => [event.id, event]
        )
      );
      this.evalAssets.replace(
        (snapshot.version === 2 ? snapshot.evalAssets ?? [] : []).map((record) => [
          scopedEvidenceRecordKey(
            record.tenantId,
            record.projectId,
            record.asset.id,
            record.asset.revision
          ),
          record
        ])
      );
      this.traceGraphs.replace(
        (snapshot.version === 2 ? snapshot.traceGraphs ?? [] : []).map((record) => [
          scopedEvidenceRecordKey(record.tenantId, record.projectId, record.id),
          record
        ])
      );
      this.learningProposals.replace(
        (snapshot.version === 2 ? snapshot.learningProposals ?? [] : []).map((record) => [
          scopedEvidenceRecordKey(
            record.tenantId,
            record.projectId,
            record.proposal.id,
            record.proposal.revision
          ),
          record
        ])
      );
      this.maturityReports.replace(
        (snapshot.version === 2 ? snapshot.maturityReports ?? [] : []).map((record) => [
          scopedEvidenceRecordKey(record.tenantId, record.projectId, record.id),
          record
        ])
      );
      this.gateArtifactHandles.replace(
        (snapshot.version === 2 ? snapshot.gateArtifactHandles ?? [] : []).map(
          (record) => [record.handle, record]
        )
      );
      this.authoritativeGateReceipts.replace(
        (snapshot.version === 2 ? snapshot.authoritativeGateReceipts ?? [] : []).map(
          (record) => [record.id, record]
        )
      );
    } finally {
      this.hydrating = false;
    }
  }

  private persist(): void {
    if (!this.statePath || this.hydrating) return;
    const snapshot: ApiStateSnapshotV2 = {
      version: 2,
      tenantId: LOCAL_TENANT_ID,
      projects: [...this.projects.values()],
      tasks: [...this.tasks.values()],
      runs: [...this.runs.values()],
      runJobs: [...this.runJobs.values()],
      events: [...this.events.entries()].map(([runId, events]) => ({ runId, events })),
      standardPacks: [...this.standardPacks.values()],
      governanceLayers: [...this.governanceLayers.values()],
      scopedWaivers: [...this.waivers.entries()].map(([key, waiver]) => ({
        key,
        tenantId: tenantIdFromScopedRecordKey(key) ?? LOCAL_TENANT_ID,
        waiver
      })),
      projectPackLocks: [...this.projectPackLocks.values()],
      specSetTenants: [...this.specSetTenants.entries()].map(([specSetId, tenantId]) => ({
        specSetId,
        tenantId
      })),
      governedLoopStates: [...this.governedLoopStates.values()],
      auditEvents: [...this.auditEvents.values()],
      evalAssets: [...this.evalAssets.values()],
      traceGraphs: [...this.traceGraphs.values()],
      learningProposals: [...this.learningProposals.values()],
      maturityReports: [...this.maturityReports.values()],
      gateArtifactHandles: [...this.gateArtifactHandles.values()],
      authoritativeGateReceipts: [...this.authoritativeGateReceipts.values()]
    };
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.statePath);
  }
}

type InterruptedCandidate = RunRecord["candidates"][number];

function recoverInterruptedCandidateResult(
  candidate: InterruptedCandidate,
  runCreatedAt: string,
  recoveredAt: string
) {
  if (candidate.status !== "running" || candidate.result) return undefined;
  const stdout = readCheckpointText(candidate.outputCheckpoint?.stdoutPath);
  const stderr = readCheckpointText(candidate.outputCheckpoint?.stderrPath);
  if (!stdout && !stderr) return undefined;
  return {
    provider: candidate.provider,
    candidateId: candidate.id,
    status: "failed" as const,
    exitCode: null,
    stdout,
    stderr,
    summary: summarizeCheckpointOutput(stdout, stderr),
    artifacts: [],
    startedAt: candidate.outputCheckpoint?.startedAt ?? runCreatedAt,
    finishedAt: recoveredAt
  };
}

function readCheckpointText(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function summarizeCheckpointOutput(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return "Interrupted candidate produced no checkpointed output.";
  return `Recovered partial output from interrupted candidate:\n${combined.slice(-4000)}`;
}
