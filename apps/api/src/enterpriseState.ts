import type {
  AgentTask,
  Project,
  RunEvent,
  RunRecord
} from "@mn/core";
import type {
  GovernanceLayerRecord,
  MemoryStore,
  MaturityReportRecord,
  ProjectPackLockRecord,
  RunJobRecord,
  StandardPackRecord,
  TraceGraphRecord,
  EvalAssetRecord,
  LearningProposalRecord,
  AuditEvent,
  GateArtifactHandleRecord,
  AuthoritativeGateReceiptRecord
} from "./store.js";
import type { Waiver } from "@mn/governance";
import type { GovernedRunState } from "@mn/loop";
import type { FileSpecRepository, SpecRepositoryRecord } from "@mn/specs";
import type { ProviderRecord } from "@mn/provider-catalog";
import type { FileLocalStore } from "@mn/store";
import type {
  EnterpriseMetadataRecord,
  EnterpriseStateSnapshot
} from "./enterprisePostgres.js";

export const ENTERPRISE_METADATA_KINDS = Object.freeze([
  "project",
  "task",
  "run",
  "run_events",
  "governed_loop_state",
  "standard_pack",
  "governance_layer",
  "standards_lock",
  "waiver",
  "spec_set_owner",
  "spec_repository",
  "eval_asset",
  "trace_graph",
  "learning_proposal",
  "maturity_report",
  "gate_artifact_handle",
  "authoritative_gate_receipt",
  "provider"
] as const);

/** Immutable execution evidence is written by the claim/artifact transaction
 * that creates it. A stale API replica must never prune it while reconciling
 * its mutable control-plane cache. */
export const ENTERPRISE_APPEND_ONLY_METADATA_KINDS = Object.freeze([
  "gate_artifact_handle",
  "authoritative_gate_receipt"
] as const);

export const ENTERPRISE_RECONCILED_METADATA_KINDS = Object.freeze(
  ENTERPRISE_METADATA_KINDS.filter((kind) =>
    !ENTERPRISE_APPEND_ONLY_METADATA_KINDS.includes(
      kind as (typeof ENTERPRISE_APPEND_ONLY_METADATA_KINDS)[number]
    )
  )
);

function objectPayload(record: EnterpriseMetadataRecord): Record<string, unknown> {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid enterprise metadata payload for ${record.kind}/${record.id}`);
  }
  return payload as Record<string, unknown>;
}

function matchingString(
  record: EnterpriseMetadataRecord,
  payload: Record<string, unknown>,
  field: string,
  expected: string
): void {
  if (payload[field] !== expected) {
    throw new Error(
      `Enterprise metadata ${record.kind}/${record.id} has mismatched ${field}`
    );
  }
}

function matchingTenant(
  record: EnterpriseMetadataRecord,
  payload: Record<string, unknown>
): void {
  if (payload.tenantId !== undefined && payload.tenantId !== record.tenantId) {
    throw new Error(
      `Enterprise metadata ${record.kind}/${record.id} has mismatched tenantId`
    );
  }
}

function setUnique<T>(
  map: Map<string, T>,
  id: string,
  value: T,
  kind: string
): void {
  if (map.has(id)) {
    throw new Error(`Duplicate enterprise ${kind} id across tenants: ${id}`);
  }
  map.set(id, value);
}

function runJobRecord(
  item: EnterpriseStateSnapshot["runJobs"][number]["item"]
): RunJobRecord {
  return {
    runId: item.runId,
    ...(item.tenantId ? { tenantId: item.tenantId } : {}),
    projectId: item.projectId,
    taskId: item.taskId,
    status: item.status,
    priority: item.priority,
    attempt: item.attempt,
    recovered: item.recovered,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}),
    ...(item.resumeFromRunId ? { resumeFromRunId: item.resumeFromRunId } : {})
  };
}

function validateCheckpointRun(
  value: unknown,
  runId: string,
  projectId: string,
  taskId: string,
  tenantId: string | undefined
): RunRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const run = value as RunRecord;
  if (
    run.id !== runId ||
    run.projectId !== projectId ||
    run.taskId !== taskId ||
    (run.tenantId !== undefined && tenantId !== undefined && run.tenantId !== tenantId)
  ) {
    throw new Error(`Enterprise queue checkpoint for ${runId} has invalid run bindings`);
  }
  return run;
}

function validateCheckpointState(
  value: unknown,
  runId: string
): GovernedRunState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as GovernedRunState;
  if (state.runId !== runId) {
    throw new Error(`Enterprise queue checkpoint for ${runId} has invalid loop state`);
  }
  return state;
}

/**
 * Rebuilds the API's in-process route cache from one repeatable-read
 * PostgreSQL snapshot. Queue checkpoints intentionally override mn_metadata:
 * a process may have crashed after the checkpoint commit but before onSend
 * mirrored the same run into mn_metadata.
 */
export async function restoreEnterpriseSnapshot(input: {
  store: MemoryStore;
  specRepository: FileSpecRepository;
  localStore?: Pick<FileLocalStore, "restoreEnterpriseProviders">;
  snapshot: EnterpriseStateSnapshot;
}): Promise<void> {
  const projects = new Map<string, Project>();
  const tasks = new Map<string, AgentTask>();
  const runs = new Map<string, RunRecord>();
  const events = new Map<string, { runId: string; events: readonly RunEvent[] }>();
  const governedStates = new Map<string, GovernedRunState>();
  const standardPacks: StandardPackRecord[] = [];
  const governanceLayers: GovernanceLayerRecord[] = [];
  const waivers: Array<{ tenantId: string; waiver: Waiver }> = [];
  const locks: ProjectPackLockRecord[] = [];
  const specOwners = new Map<string, { specSetId: string; tenantId: string }>();
  const specRecords = new Map<string, SpecRepositoryRecord>();
  const evalAssets: EvalAssetRecord[] = [];
  const traceGraphs: TraceGraphRecord[] = [];
  const learningProposals: LearningProposalRecord[] = [];
  const maturityReports: MaturityReportRecord[] = [];
  const gateArtifactHandles = new Map<string, GateArtifactHandleRecord>();
  const authoritativeGateReceipts = new Map<
    string,
    AuthoritativeGateReceiptRecord
  >();
  const providers = new Map<string, ProviderRecord>();

  for (const record of input.snapshot.metadata) {
    const payload = objectPayload(record);
    switch (record.kind) {
      case "project":
        matchingString(record, payload, "id", record.id);
        matchingTenant(record, payload);
        setUnique(projects, record.id, payload as unknown as Project, "project");
        break;
      case "task":
        matchingString(record, payload, "id", record.id);
        matchingTenant(record, payload);
        setUnique(tasks, record.id, payload as unknown as AgentTask, "task");
        break;
      case "run":
        matchingString(record, payload, "id", record.id);
        matchingTenant(record, payload);
        setUnique(runs, record.id, payload as unknown as RunRecord, "run");
        break;
      case "run_events": {
        matchingString(record, payload, "runId", record.id);
        if (!Array.isArray(payload.events)) {
          throw new Error(`Enterprise metadata run_events/${record.id} has invalid events`);
        }
        const restoredEvents = payload.events as RunEvent[];
        if (restoredEvents.some((event) => event.runId !== record.id)) {
          throw new Error(`Enterprise metadata run_events/${record.id} has rebound event`);
        }
        setUnique(
          events,
          record.id,
          { runId: record.id, events: restoredEvents },
          "run events"
        );
        break;
      }
      case "governed_loop_state":
        matchingString(record, payload, "runId", record.id);
        setUnique(
          governedStates,
          record.id,
          payload as unknown as GovernedRunState,
          "governed loop state"
        );
        break;
      case "standard_pack":
        matchingString(record, payload, "key", record.id);
        matchingTenant(record, payload);
        standardPacks.push(payload as unknown as StandardPackRecord);
        break;
      case "governance_layer":
        matchingString(record, payload, "key", record.id);
        matchingTenant(record, payload);
        governanceLayers.push(payload as unknown as GovernanceLayerRecord);
        break;
      case "standards_lock":
        matchingString(record, payload, "projectId", record.id);
        matchingTenant(record, payload);
        locks.push(payload as unknown as ProjectPackLockRecord);
        break;
      case "waiver":
        matchingString(record, payload, "id", record.id);
        waivers.push({ tenantId: record.tenantId, waiver: payload as unknown as Waiver });
        break;
      case "spec_set_owner":
        matchingString(record, payload, "specSetId", record.id);
        matchingString(record, payload, "tenantId", record.tenantId);
        setUnique(
          specOwners,
          record.id,
          { specSetId: record.id, tenantId: record.tenantId },
          "spec set"
        );
        break;
      case "spec_repository": {
        const specSet = payload.specSet;
        if (!specSet || typeof specSet !== "object" || Array.isArray(specSet)) {
          throw new Error(`Enterprise metadata spec_repository/${record.id} is invalid`);
        }
        matchingString(
          record,
          specSet as Record<string, unknown>,
          "id",
          record.id
        );
        if (!Array.isArray(payload.revisions)) {
          throw new Error(`Enterprise metadata spec_repository/${record.id} has invalid revisions`);
        }
        setUnique(
          specRecords,
          record.id,
          payload as unknown as SpecRepositoryRecord,
          "spec repository"
        );
        break;
      }
      case "eval_asset":
        matchingTenant(record, payload);
        evalAssets.push(payload as unknown as EvalAssetRecord);
        break;
      case "trace_graph":
        matchingString(record, payload, "id", record.id);
        matchingTenant(record, payload);
        traceGraphs.push(payload as unknown as TraceGraphRecord);
        break;
      case "learning_proposal":
        matchingTenant(record, payload);
        learningProposals.push(payload as unknown as LearningProposalRecord);
        break;
      case "maturity_report":
        matchingString(record, payload, "id", record.id);
        matchingTenant(record, payload);
        maturityReports.push(payload as unknown as MaturityReportRecord);
        break;
      case "gate_artifact_handle":
        matchingString(record, payload, "handle", record.id);
        matchingString(record, payload, "tenantId", record.tenantId);
        setUnique(
          gateArtifactHandles,
          record.id,
          payload as unknown as GateArtifactHandleRecord,
          "Gate artifact handle"
        );
        break;
      case "authoritative_gate_receipt":
        matchingString(record, payload, "id", record.id);
        matchingString(record, payload, "tenantId", record.tenantId);
        setUnique(
          authoritativeGateReceipts,
          record.id,
          payload as unknown as AuthoritativeGateReceiptRecord,
          "authoritative Gate receipt"
        );
        break;
      case "provider": {
        matchingString(record, payload, "id", record.id);
        const config = payload.config;
        const scope = config && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, unknown>).enterpriseScope
          : undefined;
        const tenantIds = scope && typeof scope === "object" && !Array.isArray(scope)
          ? (scope as Record<string, unknown>).tenantIds
          : undefined;
        if (!Array.isArray(tenantIds) || tenantIds.length !== 1 || tenantIds[0] !== record.tenantId) {
          throw new Error(`Enterprise metadata provider/${record.id} has mismatched tenant scope`);
        }
        setUnique(
          providers,
          record.id,
          payload as unknown as ProviderRecord,
          "provider"
        );
        break;
      }
      default:
        // Forward-compatible readers retain unknown metadata in PostgreSQL but
        // do not expose it through an older API process.
        break;
    }
  }

  const durableSpecSetIds = new Set(specRecords.keys());
  for (const localSpecSet of await input.specRepository.list()) {
    if (!durableSpecSetIds.has(localSpecSet.id)) {
      await input.specRepository.removeForAuthoritativeRestore(localSpecSet.id);
    }
  }
  for (const [specSetId, record] of specRecords) {
    const owner = specOwners.get(specSetId);
    if (!owner) {
      throw new Error(`Enterprise spec repository ${specSetId} has no tenant owner`);
    }
    await input.specRepository.restore(record);
  }
  await input.localStore?.restoreEnterpriseProviders([...providers.values()]);

  const runJobs = input.snapshot.runJobs.map(({ item, payload }) => {
    const run = validateCheckpointRun(
      payload.run,
      item.runId,
      item.projectId,
      item.taskId,
      item.tenantId
    );
    if (run) runs.set(item.runId, run);
    const state = validateCheckpointState(payload.governedResumeState, item.runId);
    if (state) governedStates.set(item.runId, state);
    return runJobRecord(item);
  });

  for (const event of input.snapshot.auditEvents) {
    if (!event || typeof event !== "object" || !event.id || !event.tenantId) {
      throw new Error("Enterprise audit snapshot contains an invalid event");
    }
  }

  input.store.restoreEnterpriseState({
    projects: [...projects.values()],
    tasks: [...tasks.values()],
    runs: [...runs.values()],
    runJobs,
    events: [...events.values()],
    standardPacks,
    governanceLayers,
    waivers,
    projectPackLocks: locks,
    specSetTenants: [...specOwners.values()],
    governedLoopStates: [...governedStates.values()],
    auditEvents: input.snapshot.auditEvents as AuditEvent[],
    evalAssets,
    traceGraphs,
    learningProposals,
    maturityReports,
    gateArtifactHandles: [...gateArtifactHandles.values()],
    authoritativeGateReceipts: [...authoritativeGateReceipts.values()]
  });
}
