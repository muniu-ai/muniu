import type { RunBudgetUsage, RunStageName } from "@mn/core";
import {
  assertExactObject,
  canonicalJson,
  cloneAndFreeze,
  cloneCanonical,
  deepFreeze,
  optionalOwnValue,
  ownValue,
  sha256Canonical
} from "./canonical.js";
import type {
  ApprovalDecision,
  ExecuteGovernedRunInput,
  GovernedGovernanceSnapshot,
  GovernedHarnessManifest,
  GovernedRunBindings,
  GovernedRunState,
  GovernedSpecRef,
  GovernedStageHandlers,
  AuthoritativeLoopBudgetMeasurement,
  LoopArtifact,
  LoopBudgetDelta,
  LoopBudgetLimits,
  LoopBudgetMeasurementProof,
  LoopBudgetMeasurementRequest,
  LoopFailureClassification,
  LoopRunStatus,
  LoopStageAttempt,
  RepairObservation,
  StageHandlerContext,
  StageHandlerResult
} from "./types.js";
import {
  GovernedLoopInterruptionError,
  GovernedLoopInputError,
  LoopMeasurementError,
  LoopPersistenceError
} from "./types.js";
import {
  GOVERNED_INCREMENT_DEFINITION,
  GOVERNED_INCREMENT_WORKFLOW_REF
} from "./workflow.js";

const SHA256 = /^[a-f0-9]{64}$/;
const STAGES = GOVERNED_INCREMENT_DEFINITION.stages;
const TERMINAL_STATUSES = new Set<LoopRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "needs_human"
]);
const ZERO_USAGE: RunBudgetUsage = Object.freeze({
  durationSeconds: 0,
  tokens: 0,
  costUsd: 0,
  repairAttempts: 0,
  changedFiles: 0,
  changedLines: 0
});
const ZERO_DELTA: LoopBudgetDelta = Object.freeze({
  durationSeconds: 0,
  tokens: 0,
  costUsd: 0,
  changedFiles: 0,
  changedLines: 0
});

interface WorkingState {
  schemaVersion: 1;
  runId: string;
  workflowRef: typeof GOVERNED_INCREMENT_WORKFLOW_REF;
  bindings: GovernedRunBindings;
  limits: LoopBudgetLimits;
  status: LoopRunStatus;
  currentStage?: RunStageName;
  nextInputArtifacts: LoopArtifact[];
  attempts: LoopStageAttempt[];
  budgetUsage: RunBudgetUsage;
  repairHistory: RepairObservation[];
  approval?: ApprovalDecision;
  failure?: LoopFailureClassification;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeInput {
  runId: string;
  specRef: GovernedSpecRef;
  governanceSnapshot: GovernedGovernanceSnapshot;
  harnessManifest: GovernedHarnessManifest;
  handlers: GovernedStageHandlers;
  onCheckpoint: ExecuteGovernedRunInput["onCheckpoint"];
  measureBudgetDelta?: ExecuteGovernedRunInput["measureBudgetDelta"];
  initialArtifacts: readonly LoopArtifact[];
  limits: LoopBudgetLimits;
  resumeFrom?: GovernedRunState;
  approvalDecision?: ApprovalDecision;
  now: () => string;
  signal?: AbortSignal;
}

function inputError(error: unknown): never {
  if (error instanceof GovernedLoopInputError) throw error;
  const message = error instanceof Error ? error.message : "invalid governed loop input";
  throw new GovernedLoopInputError(message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function requireString(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) throw new TypeError(`${path} must be a trimmed non-empty string`);
  return value;
}

function requireDigest(value: unknown, path: string): string {
  const digest = requireString(value, path);
  if (!SHA256.test(digest)) throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  return digest;
}

function requireSafeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${path} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function requireFiniteNumber(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${path} must be a finite number >= ${minimum}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireString(value, path);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${path} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function exact(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string
): Record<string, unknown> {
  assertExactObject(value, allowed, required, path);
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor && descriptor.value === undefined) {
      throw new TypeError(`${path}.${key} must be omitted instead of undefined`);
    }
  }
  return value;
}

function requireDenseArray(value: unknown, path: string): readonly unknown[] {
  canonicalJson(value);
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function parseSpecRef(value: unknown, path: string): GovernedSpecRef {
  const record = exact(value, ["specSetId", "revision", "digest"], ["specSetId", "revision", "digest"], path);
  return cloneAndFreeze({
    specSetId: requireString(ownValue(record, "specSetId"), `${path}.specSetId`),
    revision: requireSafeInteger(ownValue(record, "revision"), `${path}.revision`, 1),
    digest: requireDigest(ownValue(record, "digest"), `${path}.digest`)
  });
}

function refsEqual(left: GovernedSpecRef, right: GovernedSpecRef): boolean {
  return (
    left.specSetId === right.specSetId &&
    left.revision === right.revision &&
    left.digest === right.digest
  );
}

function parseWorkflowRef(value: unknown, path: string): typeof GOVERNED_INCREMENT_WORKFLOW_REF {
  const record = exact(value, ["id", "version", "digest"], ["id", "version", "digest"], path);
  const id = requireString(ownValue(record, "id"), `${path}.id`);
  const version = requireString(ownValue(record, "version"), `${path}.version`);
  const digest = requireDigest(ownValue(record, "digest"), `${path}.digest`);
  if (
    id !== GOVERNED_INCREMENT_WORKFLOW_REF.id ||
    version !== GOVERNED_INCREMENT_WORKFLOW_REF.version ||
    digest !== GOVERNED_INCREMENT_WORKFLOW_REF.digest
  ) {
    throw new TypeError(`${path} must bind the exact governed-increment-v1 definition`);
  }
  return GOVERNED_INCREMENT_WORKFLOW_REF;
}

function parseGovernanceSnapshot(value: unknown): GovernedGovernanceSnapshot {
  const record = exact(
    value,
    [
      "schemaVersion",
      "resolvedAt",
      "layers",
      "policy",
      "appliedWaivers",
      "decisions",
      "specRef",
      "workflowRef",
      "harnessProfileRef",
      "digest"
    ],
    ["schemaVersion", "resolvedAt", "layers", "policy", "appliedWaivers", "decisions", "specRef", "workflowRef", "digest"],
    "governanceSnapshot"
  );
  canonicalJson(record);
  if (ownValue(record, "schemaVersion") !== 1) {
    throw new TypeError("governanceSnapshot.schemaVersion must be 1");
  }
  requireTimestamp(ownValue(record, "resolvedAt"), "governanceSnapshot.resolvedAt");
  const digest = requireDigest(ownValue(record, "digest"), "governanceSnapshot.digest");
  parseSpecRef(ownValue(record, "specRef"), "governanceSnapshot.specRef");
  parseWorkflowRef(ownValue(record, "workflowRef"), "governanceSnapshot.workflowRef");
  const semantic = cloneCanonical(record) as Record<string, unknown>;
  delete semantic.resolvedAt;
  delete semantic.digest;
  if (sha256Canonical(semantic) !== digest) {
    throw new TypeError("governanceSnapshot.digest does not match its immutable semantic content");
  }
  return cloneAndFreeze(record) as unknown as GovernedGovernanceSnapshot;
}

function parseHarnessManifest(value: unknown): GovernedHarnessManifest {
  const record = exact(
    value,
    [
      "schemaVersion",
      "generatedAt",
      "profile",
      "task",
      "specRef",
      "governanceDigest",
      "workflowRef",
      "harnessProfileRef",
      "selectedServices",
      "languageByService",
      "policy",
      "executionPolicy",
      "context",
      "gatePlan",
      "sandbox",
      "stopConditions",
      "outputSchema",
      "digest"
    ],
    [
      "schemaVersion",
      "generatedAt",
      "profile",
      "task",
      "specRef",
      "governanceDigest",
      "workflowRef",
      "selectedServices",
      "languageByService",
      "policy",
      "executionPolicy",
      "context",
      "gatePlan",
      "sandbox",
      "stopConditions",
      "outputSchema",
      "digest"
    ],
    "harnessManifest"
  );
  canonicalJson(record);
  if (ownValue(record, "schemaVersion") !== 1) {
    throw new TypeError("harnessManifest.schemaVersion must be 1");
  }
  requireTimestamp(ownValue(record, "generatedAt"), "harnessManifest.generatedAt");
  const digest = requireDigest(ownValue(record, "digest"), "harnessManifest.digest");
  requireDigest(ownValue(record, "governanceDigest"), "harnessManifest.governanceDigest");
  parseSpecRef(ownValue(record, "specRef"), "harnessManifest.specRef");
  parseWorkflowRef(ownValue(record, "workflowRef"), "harnessManifest.workflowRef");
  const semantic = cloneCanonical(record) as Record<string, unknown>;
  delete semantic.generatedAt;
  delete semantic.digest;
  if (sha256Canonical(semantic) !== digest) {
    throw new TypeError("harnessManifest.digest does not match its immutable semantic content");
  }
  return cloneAndFreeze(record) as unknown as GovernedHarnessManifest;
}

function parseArtifact(value: unknown, path: string): LoopArtifact {
  const record = exact(
    value,
    ["id", "kind", "path", "digest", "contentType"],
    ["id", "kind", "path", "digest"],
    path
  );
  const allowedKinds = new Set([
    "discovery",
    "specification",
    "impact_report",
    "architecture_decision",
    "diff",
    "verification_evidence",
    "approval_material",
    "learning_proposal",
    "other"
  ]);
  const kind = requireString(ownValue(record, "kind"), `${path}.kind`);
  if (!allowedKinds.has(kind)) throw new TypeError(`${path}.kind is unsupported`);
  const contentTypeValue = optionalOwnValue(record, "contentType");
  return cloneAndFreeze({
    id: requireString(ownValue(record, "id"), `${path}.id`),
    kind,
    path: requireString(ownValue(record, "path"), `${path}.path`),
    digest: requireDigest(ownValue(record, "digest"), `${path}.digest`),
    ...(contentTypeValue === undefined
      ? {}
      : { contentType: requireString(contentTypeValue, `${path}.contentType`) })
  }) as LoopArtifact;
}

function parseArtifacts(value: unknown, path: string): LoopArtifact[] {
  const array = requireDenseArray(value, path);
  const artifacts = array.map((artifact, index) => parseArtifact(artifact, `${path}[${index}]`));
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) throw new TypeError(`${path} contains duplicate artifact id ${artifact.id}`);
    ids.add(artifact.id);
  }
  return artifacts;
}

function parseBudgetDelta(value: unknown, path: string): LoopBudgetDelta {
  if (value === undefined) return { ...ZERO_DELTA };
  const record = exact(
    value,
    ["durationSeconds", "tokens", "costUsd", "changedFiles", "changedLines"],
    [],
    path
  );
  return {
    durationSeconds:
      optionalOwnValue(record, "durationSeconds") === undefined
        ? 0
        : requireFiniteNumber(ownValue(record, "durationSeconds"), `${path}.durationSeconds`),
    tokens:
      optionalOwnValue(record, "tokens") === undefined
        ? 0
        : requireSafeInteger(ownValue(record, "tokens"), `${path}.tokens`),
    costUsd:
      optionalOwnValue(record, "costUsd") === undefined
        ? 0
        : requireFiniteNumber(ownValue(record, "costUsd"), `${path}.costUsd`),
    changedFiles:
      optionalOwnValue(record, "changedFiles") === undefined
        ? 0
        : requireSafeInteger(ownValue(record, "changedFiles"), `${path}.changedFiles`),
    changedLines:
      optionalOwnValue(record, "changedLines") === undefined
        ? 0
        : requireSafeInteger(ownValue(record, "changedLines"), `${path}.changedLines`)
  };
}

function parseUsage(value: unknown, path: string): RunBudgetUsage {
  const record = exact(
    value,
    ["durationSeconds", "tokens", "costUsd", "repairAttempts", "changedFiles", "changedLines"],
    ["durationSeconds", "tokens", "costUsd", "repairAttempts", "changedFiles", "changedLines"],
    path
  );
  return {
    durationSeconds: requireFiniteNumber(ownValue(record, "durationSeconds"), `${path}.durationSeconds`),
    tokens: requireSafeInteger(ownValue(record, "tokens"), `${path}.tokens`),
    costUsd: requireFiniteNumber(ownValue(record, "costUsd"), `${path}.costUsd`),
    repairAttempts: requireSafeInteger(ownValue(record, "repairAttempts"), `${path}.repairAttempts`),
    changedFiles: requireSafeInteger(ownValue(record, "changedFiles"), `${path}.changedFiles`),
    changedLines: requireSafeInteger(ownValue(record, "changedLines"), `${path}.changedLines`)
  };
}

function parseMeasurementDiffArtifact(
  value: unknown,
  path: string
): NonNullable<LoopBudgetMeasurementProof["diffArtifact"]> {
  const record = exact(
    value,
    [
      "id",
      "uri",
      "digest",
      "byteLength",
      "candidateId",
      "workspaceUri",
      "leaseId",
      "runtimeId",
      "runtimeProofDigest",
      "projectSnapshotDigest",
      "candidateSnapshotDigest"
    ],
    [
      "id",
      "uri",
      "digest",
      "byteLength",
      "candidateId",
      "workspaceUri",
      "leaseId",
      "runtimeId",
      "runtimeProofDigest",
      "projectSnapshotDigest",
      "candidateSnapshotDigest"
    ],
    path
  );
  return cloneAndFreeze({
    id: requireString(ownValue(record, "id"), `${path}.id`),
    uri: requireString(ownValue(record, "uri"), `${path}.uri`),
    digest: requireDigest(ownValue(record, "digest"), `${path}.digest`),
    byteLength: requireSafeInteger(ownValue(record, "byteLength"), `${path}.byteLength`),
    candidateId: requireString(ownValue(record, "candidateId"), `${path}.candidateId`),
    workspaceUri: requireString(ownValue(record, "workspaceUri"), `${path}.workspaceUri`),
    leaseId: requireString(ownValue(record, "leaseId"), `${path}.leaseId`),
    runtimeId: requireDigest(ownValue(record, "runtimeId"), `${path}.runtimeId`),
    runtimeProofDigest: requireDigest(
      ownValue(record, "runtimeProofDigest"),
      `${path}.runtimeProofDigest`
    ),
    projectSnapshotDigest: requireDigest(
      ownValue(record, "projectSnapshotDigest"),
      `${path}.projectSnapshotDigest`
    ),
    candidateSnapshotDigest: requireDigest(
      ownValue(record, "candidateSnapshotDigest"),
      `${path}.candidateSnapshotDigest`
    )
  });
}

export function validateLoopBudgetMeasurementProof(
  value: unknown,
  path = "budgetMeasurement"
): LoopBudgetMeasurementProof {
  const record = exact(
    value,
    [
      "schemaVersion",
      "issuer",
      "tenantId",
      "runId",
      "workerId",
      "claimDigest",
      "stageAttemptId",
      "stage",
      "attempt",
      "previousMeasurementDigest",
      "intervalStartedAt",
      "measuredAt",
      "usageRequestIds",
      "usageDigest",
      "diffArtifact",
      "delta",
      "cumulative",
      "digest",
      "signature"
    ],
    [
      "schemaVersion",
      "issuer",
      "tenantId",
      "runId",
      "workerId",
      "claimDigest",
      "stageAttemptId",
      "stage",
      "attempt",
      "intervalStartedAt",
      "measuredAt",
      "usageRequestIds",
      "usageDigest",
      "delta",
      "cumulative",
      "digest",
      "signature"
    ],
    path
  );
  if (ownValue(record, "schemaVersion") !== 1) {
    throw new TypeError(`${path}.schemaVersion must be 1`);
  }
  if (ownValue(record, "issuer") !== "mn-api") {
    throw new TypeError(`${path}.issuer must be mn-api`);
  }
  const stage = ownValue(record, "stage");
  if (!STAGES.includes(stage as RunStageName)) {
    throw new TypeError(`${path}.stage is invalid`);
  }
  const usageRequestIds = requireDenseArray(
    ownValue(record, "usageRequestIds"),
    `${path}.usageRequestIds`
  ).map((id, index) => requireString(id, `${path}.usageRequestIds[${index}]`));
  if (new Set(usageRequestIds).size !== usageRequestIds.length) {
    throw new TypeError(`${path}.usageRequestIds contains duplicates`);
  }
  const previousMeasurementDigest = optionalOwnValue(record, "previousMeasurementDigest");
  const diffArtifact = optionalOwnValue(record, "diffArtifact");
  const semantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    tenantId: requireString(ownValue(record, "tenantId"), `${path}.tenantId`),
    runId: requireString(ownValue(record, "runId"), `${path}.runId`),
    workerId: requireString(ownValue(record, "workerId"), `${path}.workerId`),
    claimDigest: requireDigest(ownValue(record, "claimDigest"), `${path}.claimDigest`),
    stageAttemptId: requireString(
      ownValue(record, "stageAttemptId"),
      `${path}.stageAttemptId`
    ),
    stage: stage as RunStageName,
    attempt: requireSafeInteger(ownValue(record, "attempt"), `${path}.attempt`, 1),
    ...(previousMeasurementDigest === undefined
      ? {}
      : {
          previousMeasurementDigest: requireDigest(
            previousMeasurementDigest,
            `${path}.previousMeasurementDigest`
          )
        }),
    intervalStartedAt: requireTimestamp(
      ownValue(record, "intervalStartedAt"),
      `${path}.intervalStartedAt`
    ),
    measuredAt: requireTimestamp(ownValue(record, "measuredAt"), `${path}.measuredAt`),
    usageRequestIds: [...usageRequestIds].sort(),
    usageDigest: requireDigest(ownValue(record, "usageDigest"), `${path}.usageDigest`),
    ...(diffArtifact === undefined
      ? {}
      : { diffArtifact: parseMeasurementDiffArtifact(diffArtifact, `${path}.diffArtifact`) }),
    delta: parseBudgetDelta(ownValue(record, "delta"), `${path}.delta`),
    cumulative: parseBudgetDelta(ownValue(record, "cumulative"), `${path}.cumulative`)
  };
  if (semantic.measuredAt < semantic.intervalStartedAt) {
    throw new TypeError(`${path}.measuredAt precedes intervalStartedAt`);
  }
  const digest = requireDigest(ownValue(record, "digest"), `${path}.digest`);
  const signature = requireDigest(ownValue(record, "signature"), `${path}.signature`);
  if (sha256Canonical(semantic) !== digest) {
    throw new TypeError(`${path}.digest does not match its canonical content`);
  }
  return cloneAndFreeze({ ...semantic, digest, signature });
}

function parseLimits(value: unknown, path: string, partial: boolean): Partial<LoopBudgetLimits> {
  if (value === undefined) return {};
  const fields = [
    "maxCandidates",
    "maxDurationSeconds",
    "maxTokens",
    "maxCostUsd",
    "maxRepairAttempts",
    "maxChangedFiles",
    "maxChangedLines"
  ] as const;
  const record = exact(value, fields, partial ? [] : ["maxRepairAttempts"], path);
  const result: {
    maxDurationSeconds?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    maxRepairAttempts?: number;
    maxChangedFiles?: number;
    maxChangedLines?: number;
  } = {};
  for (const field of fields) {
    const raw = optionalOwnValue(record, field);
    if (raw === undefined) continue;
    if (field === "maxCandidates") {
      requireSafeInteger(raw, `${path}.${field}`, 1);
      continue;
    }
    if (field === "maxCostUsd" || field === "maxDurationSeconds") {
      result[field] = requireFiniteNumber(raw, `${path}.${field}`);
    } else {
      result[field] = requireSafeInteger(raw, `${path}.${field}`);
    }
  }
  return result;
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

export function effectiveLoopBudgetLimits(
  manifest: GovernedHarnessManifest,
  overrides: Partial<LoopBudgetLimits> = {}
): LoopBudgetLimits {
  const stop = parseLimits(manifest.stopConditions, "harnessManifest.stopConditions", true);
  return cloneAndFreeze({
    ...(minDefined(stop.maxDurationSeconds, overrides.maxDurationSeconds) === undefined
      ? {}
      : { maxDurationSeconds: minDefined(stop.maxDurationSeconds, overrides.maxDurationSeconds) }),
    ...(minDefined(stop.maxTokens, overrides.maxTokens) === undefined
      ? {}
      : { maxTokens: minDefined(stop.maxTokens, overrides.maxTokens) }),
    ...(minDefined(stop.maxCostUsd, overrides.maxCostUsd) === undefined
      ? {}
      : { maxCostUsd: minDefined(stop.maxCostUsd, overrides.maxCostUsd) }),
    maxRepairAttempts:
      minDefined(stop.maxRepairAttempts, overrides.maxRepairAttempts, 3) ?? 3,
    ...(minDefined(stop.maxChangedFiles, overrides.maxChangedFiles) === undefined
      ? {}
      : { maxChangedFiles: minDefined(stop.maxChangedFiles, overrides.maxChangedFiles) }),
    ...(minDefined(stop.maxChangedLines, overrides.maxChangedLines) === undefined
      ? {}
      : { maxChangedLines: minDefined(stop.maxChangedLines, overrides.maxChangedLines) })
  }) as LoopBudgetLimits;
}

function validateHandlers(value: unknown): GovernedStageHandlers {
  const record = exact(value, STAGES, STAGES, "handlers");
  const handlers = Object.create(null) as Record<RunStageName, (context: StageHandlerContext) => unknown>;
  for (const stage of STAGES) {
    const handler = ownValue(record, stage);
    if (typeof handler !== "function") throw new TypeError(`handlers.${stage} must be a function`);
    handlers[stage] = handler as (context: StageHandlerContext) => unknown;
  }
  return Object.freeze(handlers) as GovernedStageHandlers;
}

function validateSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as AbortSignal).aborted !== "boolean" ||
    typeof (value as AbortSignal).addEventListener !== "function"
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return value as AbortSignal;
}

function parseRuntimeInput(input: ExecuteGovernedRunInput): RuntimeInput {
  try {
    const record = exact(
      input,
      [
        "schemaVersion",
        "runId",
        "specRef",
        "governanceSnapshot",
        "harnessManifest",
        "handlers",
        "onCheckpoint",
        "measureBudgetDelta",
        "initialArtifacts",
        "limits",
        "resumeFrom",
        "approvalDecision",
        "now",
        "signal"
      ],
      ["schemaVersion", "runId", "specRef", "governanceSnapshot", "harnessManifest", "handlers", "onCheckpoint"],
      "input"
    );
    if (ownValue(record, "schemaVersion") !== 1) throw new TypeError("input.schemaVersion must be 1");
    const runId = requireString(ownValue(record, "runId"), "input.runId");
    const specRef = parseSpecRef(ownValue(record, "specRef"), "input.specRef");
    const governanceSnapshot = parseGovernanceSnapshot(ownValue(record, "governanceSnapshot"));
    const harnessManifest = parseHarnessManifest(ownValue(record, "harnessManifest"));
    const governanceSpecRef = parseSpecRef(governanceSnapshot.specRef, "governanceSnapshot.specRef");
    const harnessSpecRef = parseSpecRef(harnessManifest.specRef, "harnessManifest.specRef");
    if (!refsEqual(specRef, governanceSpecRef) || !refsEqual(specRef, harnessSpecRef)) {
      throw new TypeError("specRef must exactly match governance and Harness bindings");
    }
    if (harnessManifest.governanceDigest !== governanceSnapshot.digest) {
      throw new TypeError("Harness governanceDigest must exactly match the Governance snapshot");
    }
    if (harnessManifest.workflowRef?.digest !== governanceSnapshot.workflowRef?.digest) {
      throw new TypeError("Harness and Governance workflow references must match");
    }
    const handlers = validateHandlers(ownValue(record, "handlers"));
    const onCheckpoint = ownValue(record, "onCheckpoint");
    if (typeof onCheckpoint !== "function") throw new TypeError("input.onCheckpoint must be a function");
    const measureBudgetDelta = optionalOwnValue(record, "measureBudgetDelta");
    if (measureBudgetDelta !== undefined && typeof measureBudgetDelta !== "function") {
      throw new TypeError("input.measureBudgetDelta must be a function");
    }
    const nowValue = optionalOwnValue(record, "now");
    if (nowValue !== undefined && typeof nowValue !== "function") throw new TypeError("input.now must be a function");
    const limitsOverride = parseLimits(optionalOwnValue(record, "limits"), "input.limits", true);
    const initialArtifactsValue = optionalOwnValue(record, "initialArtifacts");
    const initialArtifacts =
      initialArtifactsValue === undefined ? [] : parseArtifacts(initialArtifactsValue, "input.initialArtifacts");
    const resumeValue = optionalOwnValue(record, "resumeFrom");
    const approvalValue = optionalOwnValue(record, "approvalDecision");
    return {
      runId,
      specRef,
      governanceSnapshot,
      harnessManifest,
      handlers,
      onCheckpoint: onCheckpoint as ExecuteGovernedRunInput["onCheckpoint"],
      ...(measureBudgetDelta === undefined
        ? {}
        : {
            measureBudgetDelta:
              measureBudgetDelta as NonNullable<ExecuteGovernedRunInput["measureBudgetDelta"]>
          }),
      initialArtifacts,
      limits: effectiveLoopBudgetLimits(harnessManifest, limitsOverride),
      ...(resumeValue === undefined ? {} : { resumeFrom: parseState(resumeValue) }),
      ...(approvalValue === undefined ? {} : { approvalDecision: parseApproval(approvalValue) }),
      now:
        nowValue === undefined
          ? () => new Date().toISOString()
          : (nowValue as () => string),
      ...(optionalOwnValue(record, "signal") === undefined
        ? {}
        : { signal: validateSignal(ownValue(record, "signal")) })
    };
  } catch (error) {
    inputError(error);
  }
}

function failureSemantic(value: LoopFailureClassification): LoopFailureClassification {
  return cloneAndFreeze(value);
}

function parseFailure(value: unknown, path: string): LoopFailureClassification {
  const record = exact(
    value,
    ["kind", "retryable", "reason", "failureSignature", "diffDigest"],
    ["kind", "retryable", "reason"],
    path
  );
  const kinds = new Set([
    "stage_failure",
    "handler_error",
    "invalid_handler_result",
    "budget_exhausted",
    "no_progress",
    "approval_rejected",
    "cancelled",
    "interrupted"
  ]);
  const kind = requireString(ownValue(record, "kind"), `${path}.kind`);
  if (!kinds.has(kind)) throw new TypeError(`${path}.kind is unsupported`);
  const retryable = ownValue(record, "retryable");
  if (typeof retryable !== "boolean") throw new TypeError(`${path}.retryable must be boolean`);
  const failureSignature = optionalOwnValue(record, "failureSignature");
  const diffDigest = optionalOwnValue(record, "diffDigest");
  return failureSemantic({
    kind: kind as LoopFailureClassification["kind"],
    retryable,
    reason: requireString(ownValue(record, "reason"), `${path}.reason`),
    ...(failureSignature === undefined
      ? {}
      : { failureSignature: requireDigest(failureSignature, `${path}.failureSignature`) }),
    ...(diffDigest === undefined ? {} : { diffDigest: requireDigest(diffDigest, `${path}.diffDigest`) })
  });
}

export function approvalDecisionDigest(
  decision: Omit<ApprovalDecision, "digest">
): string {
  const record = exact(
    decision,
    ["runId", "stageAttemptId", "decision", "actorId", "decidedAt"],
    ["runId", "stageAttemptId", "decision", "actorId", "decidedAt"],
    "approvalDecision"
  );
  const value = ownValue(record, "decision");
  if (value !== "approve" && value !== "reject") {
    throw new TypeError("approvalDecision.decision must be approve or reject");
  }
  return sha256Canonical({
    runId: requireString(ownValue(record, "runId"), "approvalDecision.runId"),
    stageAttemptId: requireString(
      ownValue(record, "stageAttemptId"),
      "approvalDecision.stageAttemptId"
    ),
    decision: value,
    actorId: requireString(ownValue(record, "actorId"), "approvalDecision.actorId"),
    decidedAt: requireTimestamp(ownValue(record, "decidedAt"), "approvalDecision.decidedAt")
  });
}

export function createApprovalDecision(
  decision: Omit<ApprovalDecision, "digest">
): ApprovalDecision {
  const digest = approvalDecisionDigest(decision);
  return parseApproval({ ...cloneCanonical(decision), digest });
}

function parseApproval(value: unknown): ApprovalDecision {
  const record = exact(
    value,
    ["runId", "stageAttemptId", "decision", "actorId", "decidedAt", "digest"],
    ["runId", "stageAttemptId", "decision", "actorId", "decidedAt", "digest"],
    "approvalDecision"
  );
  const decisionValue = ownValue(record, "decision");
  if (decisionValue !== "approve" && decisionValue !== "reject") {
    throw new TypeError("approvalDecision.decision must be approve or reject");
  }
  const semantic = {
    runId: requireString(ownValue(record, "runId"), "approvalDecision.runId"),
    stageAttemptId: requireString(ownValue(record, "stageAttemptId"), "approvalDecision.stageAttemptId"),
    decision: decisionValue as "approve" | "reject",
    actorId: requireString(ownValue(record, "actorId"), "approvalDecision.actorId"),
    decidedAt: requireTimestamp(ownValue(record, "decidedAt"), "approvalDecision.decidedAt")
  };
  const digest = requireDigest(ownValue(record, "digest"), "approvalDecision.digest");
  if (approvalDecisionDigest(semantic) !== digest) {
    throw new TypeError("approvalDecision.digest does not match its content");
  }
  return cloneAndFreeze({ ...semantic, digest });
}

function parseAttempt(value: unknown, path: string): LoopStageAttempt {
  const record = exact(
    value,
    [
      "id",
      "runId",
      "stage",
      "attempt",
      "status",
      "inputArtifacts",
      "outputArtifacts",
      "inputDigest",
      "outputDigest",
      "budgetUsage",
      "budgetDelta",
      "budgetMeasurement",
      "failure",
      "startedAt",
      "finishedAt"
    ],
    [
      "id",
      "runId",
      "stage",
      "attempt",
      "status",
      "inputArtifacts",
      "outputArtifacts",
      "inputDigest",
      "budgetUsage",
      "budgetDelta",
      "startedAt"
    ],
    path
  );
  const stage = ownValue(record, "stage");
  if (!STAGES.includes(stage as RunStageName)) throw new TypeError(`${path}.stage is invalid`);
  const status = ownValue(record, "status");
  if (!["running", "completed", "failed", "waiting_approval", "cancelled"].includes(status as string)) {
    throw new TypeError(`${path}.status is invalid`);
  }
  const outputDigest = optionalOwnValue(record, "outputDigest");
  const failure = optionalOwnValue(record, "failure");
  const finishedAt = optionalOwnValue(record, "finishedAt");
  const budgetMeasurement = optionalOwnValue(record, "budgetMeasurement");
  const parsed = cloneAndFreeze({
    id: requireString(ownValue(record, "id"), `${path}.id`),
    runId: requireString(ownValue(record, "runId"), `${path}.runId`),
    stage: stage as RunStageName,
    attempt: requireSafeInteger(ownValue(record, "attempt"), `${path}.attempt`, 1),
    status: status as LoopStageAttempt["status"],
    inputArtifacts: parseArtifacts(ownValue(record, "inputArtifacts"), `${path}.inputArtifacts`),
    outputArtifacts: parseArtifacts(ownValue(record, "outputArtifacts"), `${path}.outputArtifacts`),
    inputDigest: requireDigest(ownValue(record, "inputDigest"), `${path}.inputDigest`),
    ...(outputDigest === undefined ? {} : { outputDigest: requireDigest(outputDigest, `${path}.outputDigest`) }),
    budgetUsage: parseUsage(ownValue(record, "budgetUsage"), `${path}.budgetUsage`),
    budgetDelta: parseBudgetDelta(ownValue(record, "budgetDelta"), `${path}.budgetDelta`),
    ...(budgetMeasurement === undefined
      ? {}
      : {
          budgetMeasurement: validateLoopBudgetMeasurementProof(
            budgetMeasurement,
            `${path}.budgetMeasurement`
          )
        }),
    ...(failure === undefined ? {} : { failure: parseFailure(failure, `${path}.failure`) }),
    startedAt: requireTimestamp(ownValue(record, "startedAt"), `${path}.startedAt`),
    ...(finishedAt === undefined ? {} : { finishedAt: requireTimestamp(finishedAt, `${path}.finishedAt`) })
  });
  if (parsed.inputDigest !== sha256Canonical(parsed.inputArtifacts)) {
    throw new TypeError(`${path}.inputDigest does not match inputArtifacts`);
  }
  if (
    parsed.outputDigest !== undefined &&
    parsed.outputDigest !== sha256Canonical(parsed.outputArtifacts)
  ) {
    throw new TypeError(`${path}.outputDigest does not match outputArtifacts`);
  }
  if (parsed.status === "running" && parsed.outputDigest !== undefined) {
    throw new TypeError(`${path}.running attempt must not have outputDigest`);
  }
  if (parsed.status === "running" && parsed.budgetMeasurement !== undefined) {
    throw new TypeError(`${path}.running attempt must not have budgetMeasurement`);
  }
  if (parsed.budgetMeasurement) {
    const measurement = parsed.budgetMeasurement;
    if (
      measurement.runId !== parsed.runId ||
      measurement.stageAttemptId !== parsed.id ||
      measurement.stage !== parsed.stage ||
      measurement.attempt !== parsed.attempt
    ) {
      throw new TypeError(`${path}.budgetMeasurement attempt binding mismatch`);
    }
    if (canonicalJson(measurement.delta) !== canonicalJson(parsed.budgetDelta)) {
      throw new TypeError(`${path}.budgetMeasurement delta does not match budgetDelta`);
    }
  }
  return parsed;
}

function parseRepairObservation(value: unknown, path: string): RepairObservation {
  const record = exact(
    value,
    ["verificationAttemptId", "failureSignature", "diffDigest"],
    ["verificationAttemptId", "failureSignature", "diffDigest"],
    path
  );
  return cloneAndFreeze({
    verificationAttemptId: requireString(ownValue(record, "verificationAttemptId"), `${path}.verificationAttemptId`),
    failureSignature: requireDigest(ownValue(record, "failureSignature"), `${path}.failureSignature`),
    diffDigest: requireDigest(ownValue(record, "diffDigest"), `${path}.diffDigest`)
  });
}

function stateDigest(state: Omit<GovernedRunState, "digest">): string {
  return sha256Canonical(state);
}

function sealState(state: WorkingState): GovernedRunState {
  const semantic: Omit<GovernedRunState, "digest"> = {
    schemaVersion: 1,
    runId: state.runId,
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
    bindings: state.bindings,
    limits: state.limits,
    status: state.status,
    ...(state.currentStage === undefined ? {} : { currentStage: state.currentStage }),
    nextInputArtifacts: state.nextInputArtifacts,
    attempts: state.attempts,
    budgetUsage: state.budgetUsage,
    repairHistory: state.repairHistory,
    ...(state.approval === undefined ? {} : { approval: state.approval }),
    ...(state.failure === undefined ? {} : { failure: state.failure }),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
  return cloneAndFreeze({ ...semantic, digest: stateDigest(semantic) });
}

function parseState(value: unknown): GovernedRunState {
  const record = exact(
    value,
    [
      "schemaVersion",
      "runId",
      "workflowRef",
      "bindings",
      "limits",
      "status",
      "currentStage",
      "nextInputArtifacts",
      "attempts",
      "budgetUsage",
      "repairHistory",
      "approval",
      "failure",
      "createdAt",
      "updatedAt",
      "digest"
    ],
    [
      "schemaVersion",
      "runId",
      "workflowRef",
      "bindings",
      "limits",
      "status",
      "nextInputArtifacts",
      "attempts",
      "budgetUsage",
      "repairHistory",
      "createdAt",
      "updatedAt",
      "digest"
    ],
    "resumeFrom"
  );
  canonicalJson(record);
  if (ownValue(record, "schemaVersion") !== 1) throw new TypeError("resumeFrom.schemaVersion must be 1");
  parseWorkflowRef(ownValue(record, "workflowRef"), "resumeFrom.workflowRef");
  const bindingsRecord = exact(
    ownValue(record, "bindings"),
    ["specRef", "governanceDigest", "harnessDigest"],
    ["specRef", "governanceDigest", "harnessDigest"],
    "resumeFrom.bindings"
  );
  const bindings: GovernedRunBindings = cloneAndFreeze({
    specRef: parseSpecRef(ownValue(bindingsRecord, "specRef"), "resumeFrom.bindings.specRef"),
    governanceDigest: requireDigest(ownValue(bindingsRecord, "governanceDigest"), "resumeFrom.bindings.governanceDigest"),
    harnessDigest: requireDigest(ownValue(bindingsRecord, "harnessDigest"), "resumeFrom.bindings.harnessDigest")
  });
  const status = ownValue(record, "status");
  if (!["running", "waiting_approval", "completed", "failed", "cancelled", "needs_human"].includes(status as string)) {
    throw new TypeError("resumeFrom.status is invalid");
  }
  const stage = optionalOwnValue(record, "currentStage");
  if (stage !== undefined && !STAGES.includes(stage as RunStageName)) {
    throw new TypeError("resumeFrom.currentStage is invalid");
  }
  if (status === "running" && stage === undefined) {
    throw new TypeError("running resumeFrom requires currentStage");
  }
  if (status === "waiting_approval" && stage !== "approval_demo") {
    throw new TypeError("waiting approval resumeFrom must point at approval_demo");
  }
  const attemptsRaw = requireDenseArray(ownValue(record, "attempts"), "resumeFrom.attempts");
  const attempts = attemptsRaw.map((attempt, index) => parseAttempt(attempt, `resumeFrom.attempts[${index}]`));
  const ids = new Set<string>();
  const stageCounts = new Map<RunStageName, number>();
  let lastTimestamp = requireTimestamp(ownValue(record, "createdAt"), "resumeFrom.createdAt");
  for (const attempt of attempts) {
    if (attempt.runId !== ownValue(record, "runId")) throw new TypeError("resumeFrom attempt belongs to another run");
    if (ids.has(attempt.id)) throw new TypeError("resumeFrom contains duplicate attempt ids");
    ids.add(attempt.id);
    const expectedAttempt = (stageCounts.get(attempt.stage) ?? 0) + 1;
    stageCounts.set(attempt.stage, expectedAttempt);
    if (
      attempt.attempt !== expectedAttempt ||
      attempt.id !== attemptId(attempt.runId, attempt.stage, expectedAttempt)
    ) {
      throw new TypeError("resumeFrom attempt sequence is not canonical");
    }
    if (attempt.startedAt < lastTimestamp) {
      throw new TypeError("resumeFrom attempt timestamps are not monotonic");
    }
    if (attempt.finishedAt !== undefined && attempt.finishedAt < attempt.startedAt) {
      throw new TypeError("resumeFrom attempt finishedAt predates startedAt");
    }
    if (
      (attempt.status === "running" || attempt.status === "waiting_approval") &&
      attempt.finishedAt !== undefined
    ) {
      throw new TypeError("indeterminate or waiting attempts must not have finishedAt");
    }
    if (
      attempt.status !== "running" &&
      attempt.status !== "waiting_approval" &&
      attempt.finishedAt === undefined
    ) {
      throw new TypeError("definite attempts require finishedAt");
    }
    if (attempt.status !== "running" && attempt.outputDigest === undefined) {
      throw new TypeError("finished or waiting attempts require outputDigest");
    }
    if (
      (attempt.status === "failed" || attempt.status === "cancelled") !==
      (attempt.failure !== undefined)
    ) {
      throw new TypeError("attempt failure classification does not match its status");
    }
    lastTimestamp = attempt.finishedAt ?? attempt.startedAt;
  }
  const repairRaw = requireDenseArray(ownValue(record, "repairHistory"), "resumeFrom.repairHistory");
  const approvalRaw = optionalOwnValue(record, "approval");
  const failureRaw = optionalOwnValue(record, "failure");
  const semantic: Omit<GovernedRunState, "digest"> = {
    schemaVersion: 1,
    runId: requireString(ownValue(record, "runId"), "resumeFrom.runId"),
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
    bindings,
    limits: parseLimits(ownValue(record, "limits"), "resumeFrom.limits", false) as LoopBudgetLimits,
    status: status as LoopRunStatus,
    ...(stage === undefined ? {} : { currentStage: stage as RunStageName }),
    nextInputArtifacts: parseArtifacts(ownValue(record, "nextInputArtifacts"), "resumeFrom.nextInputArtifacts"),
    attempts,
    budgetUsage: parseUsage(ownValue(record, "budgetUsage"), "resumeFrom.budgetUsage"),
    repairHistory: repairRaw.map((item, index) => parseRepairObservation(item, `resumeFrom.repairHistory[${index}]`)),
    ...(approvalRaw === undefined ? {} : { approval: parseApproval(approvalRaw) }),
    ...(failureRaw === undefined ? {} : { failure: parseFailure(failureRaw, "resumeFrom.failure") }),
    createdAt: requireTimestamp(ownValue(record, "createdAt"), "resumeFrom.createdAt"),
    updatedAt: requireTimestamp(ownValue(record, "updatedAt"), "resumeFrom.updatedAt")
  };
  const digest = requireDigest(ownValue(record, "digest"), "resumeFrom.digest");
  if (stateDigest(semantic) !== digest) throw new TypeError("resumeFrom.digest does not match state content");
  if (semantic.updatedAt < semantic.createdAt || semantic.updatedAt < lastTimestamp) {
    throw new TypeError("resumeFrom.updatedAt is not monotonic");
  }
  if (TERMINAL_STATUSES.has(semantic.status) && semantic.currentStage !== undefined) {
    throw new TypeError("terminal resumeFrom must not have currentStage");
  }
  if (
    (semantic.status === "failed" || semantic.status === "cancelled" || semantic.status === "needs_human") !==
    (semantic.failure !== undefined)
  ) {
    throw new TypeError("resumeFrom failure classification does not match terminal status");
  }
  if (semantic.status === "completed" && semantic.approval?.decision !== "approve") {
    throw new TypeError("completed governed run requires an approved decision");
  }
  if (semantic.approval !== undefined) {
    const approvalAttempt = attempts.find(
      (attempt) => attempt.id === semantic.approval?.stageAttemptId
    );
    if (
      semantic.approval.runId !== semantic.runId ||
      approvalAttempt?.stage !== "approval_demo"
    ) {
      throw new TypeError("resumeFrom approval is not bound to its approval attempt");
    }
  }
  if (semantic.budgetUsage.repairAttempts > semantic.limits.maxRepairAttempts) {
    throw new TypeError("resumeFrom exceeds its repair attempt budget");
  }
  for (const observation of semantic.repairHistory) {
    const verification = attempts.find(
      (attempt) => attempt.id === observation.verificationAttemptId
    );
    if (
      verification?.stage !== "verification" ||
      verification.status !== "failed" ||
      verification.failure?.failureSignature !== observation.failureSignature ||
      verification.failure?.diffDigest !== observation.diffDigest
    ) {
      throw new TypeError("resumeFrom repair observation does not match a failed verification attempt");
    }
  }
  validateBudgetLedger(semantic);
  const running = attempts.filter((attempt) => attempt.status === "running");
  if (running.length > 1 || (running.length === 1 && attempts.at(-1)?.id !== running[0]?.id)) {
    throw new TypeError("resumeFrom may contain only one trailing indeterminate attempt");
  }
  if (status === "waiting_approval" && attempts.at(-1)?.status !== "waiting_approval") {
    throw new TypeError("waiting approval state requires a trailing waiting attempt");
  }
  return cloneAndFreeze({ ...semantic, digest });
}

/**
 * Parses an externally persisted checkpoint using the same exact schema,
 * canonical sequence, timestamp and digest checks used by resume.
 */
export function validateGovernedRunState(value: unknown): GovernedRunState {
  return parseState(value);
}

/** Validates an external checkpoint against the immutable Harness budget
 * contract in addition to the checkpoint's own canonical ledger. */
export function validateGovernedRunStateAgainstHarness(
  value: unknown,
  manifest: GovernedHarnessManifest,
  overrides: Partial<LoopBudgetLimits> = {}
): GovernedRunState {
  const state = parseState(value);
  const expected = effectiveLoopBudgetLimits(manifest, overrides);
  if (canonicalJson(state.limits) !== canonicalJson(expected)) {
    throw new TypeError("resumeFrom.limits do not match immutable Harness stopConditions");
  }
  return state;
}

function validateBudgetLedger(
  state: Omit<GovernedRunState, "digest">
): void {
  let cumulative: RunBudgetUsage = { ...ZERO_USAGE };
  let implementationAttempts = 0;
  let previousMeasurement: LoopBudgetMeasurementProof | undefined;
  for (const [index, attempt] of state.attempts.entries()) {
    if (attempt.stage === "implementation") implementationAttempts += 1;
    const expectedRepairs = Math.max(0, implementationAttempts - 1);
    if (attempt.status === "running") {
      if (canonicalJson(attempt.budgetDelta) !== canonicalJson(ZERO_DELTA)) {
        throw new TypeError(`resumeFrom.attempts[${index}].running budgetDelta must be zero`);
      }
      cumulative = { ...cumulative, repairAttempts: expectedRepairs };
    } else {
      cumulative = {
        ...addUsage(
          { ...cumulative, repairAttempts: expectedRepairs },
          attempt.budgetDelta
        ),
        repairAttempts: expectedRepairs
      };
    }
    if (canonicalJson(attempt.budgetUsage) !== canonicalJson(cumulative)) {
      throw new TypeError(
        `resumeFrom.attempts[${index}].budgetUsage does not match cumulative budgetDelta`
      );
    }
    if (attempt.budgetMeasurement) {
      const measurement = attempt.budgetMeasurement;
      if (
        measurement.previousMeasurementDigest !== previousMeasurement?.digest
      ) {
        throw new TypeError(
          `resumeFrom.attempts[${index}].budgetMeasurement breaks the append-only measurement chain`
        );
      }
      const cumulativeWithoutRepairs: LoopBudgetDelta = {
        durationSeconds: cumulative.durationSeconds,
        tokens: cumulative.tokens,
        costUsd: cumulative.costUsd,
        changedFiles: cumulative.changedFiles,
        changedLines: cumulative.changedLines
      };
      if (
        canonicalJson(measurement.cumulative) !==
        canonicalJson(cumulativeWithoutRepairs)
      ) {
        throw new TypeError(
          `resumeFrom.attempts[${index}].budgetMeasurement cumulative usage mismatch`
        );
      }
      previousMeasurement = measurement;
    }
  }
  const pendingRepair =
    state.status === "running" &&
    state.currentStage === "implementation" &&
    state.attempts.at(-1)?.stage === "verification" &&
    state.attempts.at(-1)?.status === "failed" &&
    state.repairHistory.some(
      (observation) =>
        observation.verificationAttemptId === state.attempts.at(-1)?.id
    );
  if (pendingRepair) {
    cumulative = {
      ...cumulative,
      repairAttempts: cumulative.repairAttempts + 1
    };
  }
  if (canonicalJson(state.budgetUsage) !== canonicalJson(cumulative)) {
    throw new TypeError("resumeFrom.budgetUsage does not match the stage budget ledger");
  }
}

function workingFromState(state: GovernedRunState): WorkingState {
  return cloneCanonical({
    schemaVersion: 1,
    runId: state.runId,
    workflowRef: state.workflowRef,
    bindings: state.bindings,
    limits: state.limits,
    status: state.status,
    ...(state.currentStage === undefined ? {} : { currentStage: state.currentStage }),
    nextInputArtifacts: state.nextInputArtifacts,
    attempts: state.attempts,
    budgetUsage: state.budgetUsage,
    repairHistory: state.repairHistory,
    ...(state.approval === undefined ? {} : { approval: state.approval }),
    ...(state.failure === undefined ? {} : { failure: state.failure }),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  }) as WorkingState;
}

function readNow(runtime: RuntimeInput, notBefore?: string): string {
  const timestamp = requireTimestamp(runtime.now(), "now()");
  if (notBefore !== undefined && timestamp < notBefore) {
    throw new GovernedLoopInputError("now() must be monotonic across checkpoints");
  }
  return timestamp;
}

async function persist(runtime: RuntimeInput, state: WorkingState): Promise<GovernedRunState> {
  const sealed = sealState(state);
  try {
    await runtime.onCheckpoint(sealed);
  } catch (error) {
    throw new LoopPersistenceError("governed loop checkpoint could not be persisted", {
      cause: error
    });
  }
  return sealed;
}

function nextStage(stage: RunStageName): RunStageName | undefined {
  const index = STAGES.indexOf(stage);
  return index < 0 ? undefined : STAGES[index + 1];
}

function attemptNumber(state: WorkingState, stage: RunStageName): number {
  return state.attempts.filter((attempt) => attempt.stage === stage).length + 1;
}

function attemptId(runId: string, stage: RunStageName, attempt: number): string {
  return `${runId}:${stage}:${attempt}`;
}

function addUsage(usage: RunBudgetUsage, delta: LoopBudgetDelta): RunBudgetUsage {
  return {
    durationSeconds: usage.durationSeconds + delta.durationSeconds,
    tokens: usage.tokens + delta.tokens,
    costUsd: usage.costUsd + delta.costUsd,
    repairAttempts: usage.repairAttempts,
    changedFiles: usage.changedFiles + delta.changedFiles,
    changedLines: usage.changedLines + delta.changedLines
  };
}

function exceededBudget(usage: RunBudgetUsage, limits: LoopBudgetLimits): string | undefined {
  const checks: Array<[number, number | undefined, string]> = [
    [usage.durationSeconds, limits.maxDurationSeconds, "duration"],
    [usage.tokens, limits.maxTokens, "tokens"],
    [usage.costUsd, limits.maxCostUsd, "cost"],
    [usage.repairAttempts, limits.maxRepairAttempts, "repair attempts"],
    [usage.changedFiles, limits.maxChangedFiles, "changed files"],
    [usage.changedLines, limits.maxChangedLines, "changed lines"]
  ];
  return checks.find(([actual, limit]) => limit !== undefined && actual > limit)?.[2];
}

function parseStageResult(value: unknown, stage: RunStageName): StageHandlerResult {
  const baseAllowed = ["status", "artifacts", "budgetDelta"];
  const baseRequired = ["status", "artifacts"];
  if (value === null || typeof value !== "object") throw new TypeError("handler result must be an object");
  const status = ownValue(value, "status");
  let allowed = baseAllowed;
  let required = baseRequired;
  if (status === "completed") allowed = [...baseAllowed, "diffDigest"];
  else if (status === "failed") {
    allowed = [...baseAllowed, "failure", "failureSignature", "diffDigest"];
    required = [...baseRequired, "failure"];
  } else if (status === "cancelled") {
    allowed = [...baseAllowed, "reason"];
    required = [...baseRequired, "reason"];
  } else if (status !== "waiting_approval") {
    throw new TypeError("handler result status is invalid");
  }
  const record = exact(value, allowed, required, "handlerResult");
  const artifacts = parseArtifacts(ownValue(record, "artifacts"), "handlerResult.artifacts");
  const budgetDelta = parseBudgetDelta(optionalOwnValue(record, "budgetDelta"), "handlerResult.budgetDelta");
  if (status === "completed") {
    const diffDigest = optionalOwnValue(record, "diffDigest");
    return cloneAndFreeze({
      status,
      artifacts,
      budgetDelta,
      ...(diffDigest === undefined ? {} : { diffDigest: requireDigest(diffDigest, "handlerResult.diffDigest") })
    });
  }
  if (status === "waiting_approval") {
    if (stage !== "approval_demo") throw new TypeError("only approval_demo may wait for approval");
    return cloneAndFreeze({ status, artifacts, budgetDelta });
  }
  if (status === "cancelled") {
    return cloneAndFreeze({
      status,
      artifacts,
      budgetDelta,
      reason: requireString(ownValue(record, "reason"), "handlerResult.reason")
    });
  }
  const failureRecord = exact(
    ownValue(record, "failure"),
    ["kind", "retryable", "reason"],
    ["kind", "retryable", "reason"],
    "handlerResult.failure"
  );
  if (ownValue(failureRecord, "kind") !== "stage_failure") {
    throw new TypeError("handlerResult.failure.kind must be stage_failure");
  }
  const retryable = ownValue(failureRecord, "retryable");
  if (typeof retryable !== "boolean") throw new TypeError("handlerResult.failure.retryable must be boolean");
  const failureSignature = optionalOwnValue(record, "failureSignature");
  const diffDigest = optionalOwnValue(record, "diffDigest");
  return cloneAndFreeze({
    status,
    artifacts,
    budgetDelta,
    failure: {
      kind: "stage_failure",
      retryable,
      reason: requireString(ownValue(failureRecord, "reason"), "handlerResult.failure.reason")
    },
    ...(failureSignature === undefined
      ? {}
      : { failureSignature: requireDigest(failureSignature, "handlerResult.failureSignature") }),
    ...(diffDigest === undefined ? {} : { diffDigest: requireDigest(diffDigest, "handlerResult.diffDigest") })
  });
}

function resultArtifacts(result: StageHandlerResult): readonly LoopArtifact[] {
  return result.artifacts;
}

function outputDigest(result: StageHandlerResult): string {
  return sha256Canonical(result.artifacts);
}

function latestBudgetMeasurement(
  state: WorkingState
): LoopBudgetMeasurementProof | undefined {
  for (let index = state.attempts.length - 1; index >= 0; index -= 1) {
    const measurement = state.attempts[index]?.budgetMeasurement;
    if (measurement) return measurement;
  }
  return undefined;
}

async function measureStageBudget(
  runtime: RuntimeInput,
  state: WorkingState,
  input: Omit<LoopBudgetMeasurementRequest, "previousMeasurement">
): Promise<{
  readonly delta: LoopBudgetDelta;
  readonly measurement?: LoopBudgetMeasurementProof;
}> {
  if (!runtime.measureBudgetDelta) return { delta: input.proposedDelta };
  const previousMeasurement = latestBudgetMeasurement(state);
  let raw: AuthoritativeLoopBudgetMeasurement;
  try {
    raw = await runtime.measureBudgetDelta({
      ...input,
      ...(previousMeasurement ? { previousMeasurement } : {})
    });
  } catch (error) {
    throw new LoopMeasurementError(
      `authoritative budget measurement failed for ${input.stageAttemptId}`,
      { cause: error }
    );
  }
  try {
    const record = exact(
      raw,
      ["delta", "proof"],
      ["delta", "proof"],
      "measurementResult"
    );
    const delta = parseBudgetDelta(
      ownValue(record, "delta"),
      "measurementResult.delta"
    );
    const proof = validateLoopBudgetMeasurementProof(
      ownValue(record, "proof"),
      "measurementResult.proof"
    );
    if (
      proof.runId !== input.runId ||
      proof.stageAttemptId !== input.stageAttemptId ||
      proof.stage !== input.stage ||
      proof.attempt !== input.attempt
    ) {
      throw new TypeError("measurement proof is bound to another stage attempt");
    }
    if (proof.previousMeasurementDigest !== previousMeasurement?.digest) {
      throw new TypeError("measurement proof does not extend the previous measurement");
    }
    if (canonicalJson(proof.delta) !== canonicalJson(delta)) {
      throw new TypeError("measurement proof delta does not match authoritative delta");
    }
    return { delta, measurement: proof };
  } catch (error) {
    throw new LoopMeasurementError(
      `authoritative budget measurement was invalid for ${input.stageAttemptId}`,
      { cause: error }
    );
  }
}

function replaceLastAttempt(state: WorkingState, attempt: LoopStageAttempt): void {
  state.attempts = [...state.attempts.slice(0, -1), cloneAndFreeze(attempt)];
}

function terminalFailure(
  state: WorkingState,
  status: "failed" | "cancelled" | "needs_human",
  failure: LoopFailureClassification,
  timestamp: string
): void {
  state.status = status;
  delete state.currentStage;
  state.failure = failureSemantic(failure);
  state.updatedAt = timestamp;
}

async function checkpointHandlerFailure(
  runtime: RuntimeInput,
  state: WorkingState,
  attempt: LoopStageAttempt,
  kind: "handler_error" | "invalid_handler_result" | "cancelled",
  reason: string
): Promise<GovernedRunState> {
  const finishedAt = readNow(runtime, state.updatedAt);
  const cancelled = kind === "cancelled";
  const failure = failureSemantic({ kind, retryable: false, reason });
  const elapsed = Math.max(
    0,
    (Date.parse(finishedAt) - Date.parse(attempt.startedAt)) / 1_000
  );
  const measured = await measureStageBudget(runtime, state, {
    runId: state.runId,
    stageAttemptId: attempt.id,
    stage: attempt.stage,
    attempt: attempt.attempt,
    resultStatus: kind,
    startedAt: attempt.startedAt,
    finishedAt,
    artifacts: [],
    proposedDelta: { ...ZERO_DELTA, durationSeconds: elapsed }
  });
  state.budgetUsage = addUsage(state.budgetUsage, measured.delta);
  const overBudget = exceededBudget(state.budgetUsage, state.limits);
  const terminal = overBudget === undefined
    ? failure
    : failureSemantic({
        kind: "budget_exhausted",
        retryable: false,
        reason: `Loop ${overBudget} budget was exhausted by ${attempt.stage}`
      });
  replaceLastAttempt(state, {
    ...attempt,
    status: cancelled && overBudget === undefined ? "cancelled" : "failed",
    failure: terminal,
    outputArtifacts: [],
    outputDigest: sha256Canonical([]),
    budgetUsage: state.budgetUsage,
    budgetDelta: measured.delta,
    ...(measured.measurement
      ? { budgetMeasurement: measured.measurement }
      : {}),
    finishedAt
  });
  terminalFailure(
    state,
    cancelled && overBudget === undefined ? "cancelled" : "failed",
    terminal,
    finishedAt
  );
  return persist(runtime, state);
}

function validateBindings(runtime: RuntimeInput, state: GovernedRunState): void {
  if (state.runId !== runtime.runId) throw new TypeError("resumeFrom belongs to another run");
  if (!refsEqual(state.bindings.specRef, runtime.specRef)) {
    throw new TypeError("resumeFrom binds a different Spec revision");
  }
  if (
    state.bindings.governanceDigest !== runtime.governanceSnapshot.digest ||
    state.bindings.harnessDigest !== runtime.harnessManifest.digest
  ) {
    throw new TypeError("resumeFrom binds different Governance or Harness content");
  }
  if (canonicalJson(state.limits) !== canonicalJson(runtime.limits)) {
    throw new TypeError("resumeFrom budget limits cannot change during a run");
  }
}

function validateLearningResult(result: StageHandlerResult): void {
  if (result.status !== "completed") return;
  if (
    result.artifacts.length === 0 ||
    result.artifacts.some((artifact) => artifact.kind !== "learning_proposal")
  ) {
    throw new TypeError("Learning may only emit one or more learning_proposal artifacts");
  }
}

async function checkpointCancellation(
  runtime: RuntimeInput,
  state: WorkingState,
  reason: string
): Promise<GovernedRunState> {
  const stage = state.currentStage ?? "discovery";
  const timestamp = readNow(runtime, state.updatedAt);
  const inputDigest = sha256Canonical(state.nextInputArtifacts);
  const number = attemptNumber(state, stage);
  const stageAttemptId = attemptId(state.runId, stage, number);
  const failure = failureSemantic({ kind: "cancelled", retryable: false, reason });
  const measured = await measureStageBudget(runtime, state, {
    runId: state.runId,
    stageAttemptId,
    stage,
    attempt: number,
    resultStatus: "cancelled",
    startedAt: timestamp,
    finishedAt: timestamp,
    artifacts: [],
    proposedDelta: ZERO_DELTA
  });
  state.budgetUsage = addUsage(state.budgetUsage, measured.delta);
  const overBudget = exceededBudget(state.budgetUsage, state.limits);
  const terminal = overBudget === undefined
    ? failure
    : failureSemantic({
        kind: "budget_exhausted",
        retryable: false,
        reason: `Loop ${overBudget} budget was exhausted by ${stage}`
      });
  state.attempts.push(
    cloneAndFreeze({
      id: stageAttemptId,
      runId: state.runId,
      stage,
      attempt: number,
      status: overBudget === undefined ? "cancelled" : "failed",
      inputArtifacts: state.nextInputArtifacts,
      outputArtifacts: [],
      inputDigest,
      outputDigest: sha256Canonical([]),
      budgetUsage: state.budgetUsage,
      budgetDelta: measured.delta,
      ...(measured.measurement
        ? { budgetMeasurement: measured.measurement }
        : {}),
      failure: terminal,
      startedAt: timestamp,
      finishedAt: timestamp
    })
  );
  terminalFailure(
    state,
    overBudget === undefined ? "cancelled" : "failed",
    terminal,
    timestamp
  );
  return persist(runtime, state);
}

async function recoverIndeterminateAttempt(runtime: RuntimeInput, state: WorkingState): Promise<void> {
  const last = state.attempts.at(-1);
  if (!last || last.status !== "running") return;
  const timestamp = readNow(runtime, state.updatedAt);
  const failure = failureSemantic({
    kind: "interrupted",
    retryable: true,
    reason: "The previous handler outcome was not durably checkpointed; resumed from the last definitely completed stage"
  });
  const elapsed = Math.max(
    0,
    (Date.parse(timestamp) - Date.parse(last.startedAt)) / 1_000
  );
  const measured = await measureStageBudget(runtime, state, {
    runId: state.runId,
    stageAttemptId: last.id,
    stage: last.stage,
    attempt: last.attempt,
    resultStatus: "handler_error",
    startedAt: last.startedAt,
    finishedAt: timestamp,
    artifacts: [],
    proposedDelta: { ...ZERO_DELTA, durationSeconds: elapsed }
  });
  state.budgetUsage = addUsage(state.budgetUsage, measured.delta);
  replaceLastAttempt(state, {
    ...last,
    status: "failed",
    failure,
    outputArtifacts: [],
    outputDigest: sha256Canonical([]),
    budgetUsage: state.budgetUsage,
    budgetDelta: measured.delta,
    ...(measured.measurement
      ? { budgetMeasurement: measured.measurement }
      : {}),
    finishedAt: timestamp
  });
  state.status = "running";
  state.currentStage = last.stage;
  state.nextInputArtifacts = [...last.inputArtifacts];
  state.updatedAt = timestamp;
  delete state.failure;
  await persist(runtime, state);
}

async function resolveWaitingApproval(
  runtime: RuntimeInput,
  state: WorkingState
): Promise<GovernedRunState | undefined> {
  if (state.status !== "waiting_approval") return undefined;
  if (runtime.approvalDecision === undefined) return sealState(state);
  const decision = runtime.approvalDecision;
  const last = state.attempts.at(-1);
  if (!last || last.stage !== "approval_demo" || last.status !== "waiting_approval") {
    throw new GovernedLoopInputError("approval resume has no matching waiting approval attempt");
  }
  if (decision.runId !== state.runId || decision.stageAttemptId !== last.id) {
    throw new GovernedLoopInputError("approval decision is not bound to this run and attempt");
  }
  if (decision.decidedAt < state.updatedAt) {
    throw new GovernedLoopInputError("approval decision predates the approval request");
  }
  state.approval = decision;
  state.updatedAt = decision.decidedAt;
  if (decision.decision === "reject") {
    const failure = failureSemantic({
      kind: "approval_rejected",
      retryable: false,
      reason: `Approval was rejected by ${decision.actorId}`
    });
    replaceLastAttempt(state, {
      ...last,
      status: "failed",
      failure,
      finishedAt: decision.decidedAt
    });
    terminalFailure(state, "failed", failure, decision.decidedAt);
    return persist(runtime, state);
  }
  replaceLastAttempt(state, {
    ...last,
    status: "completed",
    finishedAt: decision.decidedAt
  });
  state.status = "running";
  state.currentStage = "learning";
  state.nextInputArtifacts = [...last.outputArtifacts];
  delete state.failure;
  await persist(runtime, state);
  return undefined;
}

/**
 * Executes or resumes one immutable governed increment. Every handler has a
 * durable pre-checkpoint and a durable post-checkpoint. The returned state and
 * all checkpoint values are deeply frozen canonical snapshots.
 */
export async function executeGovernedIncrement(
  input: ExecuteGovernedRunInput
): Promise<GovernedRunState> {
  const runtime = parseRuntimeInput(input);
  let state: WorkingState;
  if (runtime.resumeFrom !== undefined) {
    try {
      validateBindings(runtime, runtime.resumeFrom);
    } catch (error) {
      inputError(error);
    }
    state = workingFromState(runtime.resumeFrom);
    if (TERMINAL_STATUSES.has(state.status)) return sealState(state);
    await recoverIndeterminateAttempt(runtime, state);
    const approvalState = await resolveWaitingApproval(runtime, state);
    if (approvalState !== undefined) return approvalState;
  } else {
    if (runtime.approvalDecision !== undefined) {
      throw new GovernedLoopInputError("approvalDecision is only valid when resuming a waiting run");
    }
    const now = readNow(runtime);
    state = {
      schemaVersion: 1,
      runId: runtime.runId,
      workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
      bindings: cloneAndFreeze({
        specRef: runtime.specRef,
        governanceDigest: runtime.governanceSnapshot.digest,
        harnessDigest: runtime.harnessManifest.digest
      }),
      limits: runtime.limits,
      status: "running",
      currentStage: "discovery",
      nextInputArtifacts: [...runtime.initialArtifacts],
      attempts: [],
      budgetUsage: { ...ZERO_USAGE },
      repairHistory: [],
      createdAt: now,
      updatedAt: now
    };
  }

  while (state.status === "running") {
    if (runtime.signal?.aborted) {
      return checkpointCancellation(runtime, state, "Run was cancelled before the stage handler started");
    }
    const stage = state.currentStage;
    if (stage === undefined) {
      throw new GovernedLoopInputError("running state has no current stage");
    }
    const alreadyExceeded = exceededBudget(state.budgetUsage, state.limits);
    if (alreadyExceeded !== undefined) {
      const now = readNow(runtime, state.updatedAt);
      const failure = failureSemantic({
        kind: "budget_exhausted",
        retryable: false,
        reason: `Loop ${alreadyExceeded} budget was exhausted before ${stage}`
      });
      terminalFailure(state, "failed", failure, now);
      return persist(runtime, state);
    }

    const number = attemptNumber(state, stage);
    const startedAt = readNow(runtime, state.updatedAt);
    const inputArtifacts = parseArtifacts(state.nextInputArtifacts, "stage.inputArtifacts");
    const inputDigest = sha256Canonical(inputArtifacts);
    const runningAttempt: LoopStageAttempt = cloneAndFreeze({
      id: attemptId(state.runId, stage, number),
      runId: state.runId,
      stage,
      attempt: number,
      status: "running",
      inputArtifacts,
      outputArtifacts: [],
      inputDigest,
      budgetUsage: state.budgetUsage,
      budgetDelta: ZERO_DELTA,
      startedAt
    });
    state.attempts.push(runningAttempt);
    state.updatedAt = startedAt;
    await persist(runtime, state);

    const contextBase = cloneAndFreeze({
      runId: state.runId,
      workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
      bindings: state.bindings,
      stage,
      attempt: number,
      isRepair: stage === "implementation" && state.budgetUsage.repairAttempts > 0,
      inputArtifacts,
      inputDigest,
      budgetUsage: state.budgetUsage,
      limits: state.limits
    });
    const context: StageHandlerContext = Object.freeze({
      ...contextBase,
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal })
    });

    let rawResult: unknown;
    try {
      rawResult = await runtime.handlers[stage](context);
    } catch (error) {
      if (error instanceof GovernedLoopInterruptionError) throw error;
      return checkpointHandlerFailure(
        runtime,
        state,
        runningAttempt,
        runtime.signal?.aborted === true ? "cancelled" : "handler_error",
        runtime.signal?.aborted === true
          ? "Run was cancelled while the stage handler was active"
          : "The stage handler threw before producing a valid result"
      );
    }
    if (runtime.signal?.aborted === true) {
      return checkpointHandlerFailure(
        runtime,
        state,
        runningAttempt,
        "cancelled",
        "Run was cancelled while the stage handler was active"
      );
    }

    let result: StageHandlerResult;
    try {
      result = parseStageResult(rawResult, stage);
      if (stage === "approval_demo" && result.status !== "waiting_approval") {
        throw new TypeError("approval_demo must persist a waiting_approval result before any decision");
      }
      if (stage === "learning") validateLearningResult(result);
    } catch {
      return checkpointHandlerFailure(
        runtime,
        state,
        runningAttempt,
        "invalid_handler_result",
        "The stage handler returned a non-canonical or policy-invalid result"
      );
    }

    const finishedAt = readNow(runtime, state.updatedAt);
    const elapsed = Math.max(
      0,
      (Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000
    );
    const parsedDelta = parseBudgetDelta(result.budgetDelta, "handlerResult.budgetDelta");
    const proposedDelta: LoopBudgetDelta = {
      ...parsedDelta,
      durationSeconds: Math.max(parsedDelta.durationSeconds, elapsed)
    };
    const measured = await measureStageBudget(runtime, state, {
      runId: state.runId,
      stageAttemptId: runningAttempt.id,
      stage,
      attempt: number,
      resultStatus: result.status,
      startedAt,
      finishedAt,
      artifacts: result.artifacts,
      proposedDelta
    });
    const delta = measured.delta;
    state.budgetUsage = addUsage(state.budgetUsage, delta);
    const artifacts = [...resultArtifacts(result)];
    const digest = outputDigest(result);
    const overBudget = exceededBudget(state.budgetUsage, state.limits);
    if (overBudget !== undefined) {
      const failure = failureSemantic({
        kind: "budget_exhausted",
        retryable: false,
        reason: `Loop ${overBudget} budget was exhausted by ${stage}`
      });
      replaceLastAttempt(state, {
        ...runningAttempt,
        status: "failed",
        outputArtifacts: artifacts,
        outputDigest: digest,
        budgetUsage: state.budgetUsage,
        budgetDelta: delta,
        ...(measured.measurement
          ? { budgetMeasurement: measured.measurement }
          : {}),
        failure,
        finishedAt
      });
      terminalFailure(state, "failed", failure, finishedAt);
      return persist(runtime, state);
    }

    if (result.status === "cancelled") {
      const failure = failureSemantic({
        kind: "cancelled",
        retryable: false,
        reason: result.reason
      });
      replaceLastAttempt(state, {
        ...runningAttempt,
        status: "cancelled",
        outputArtifacts: artifacts,
        outputDigest: digest,
        budgetUsage: state.budgetUsage,
        budgetDelta: delta,
        ...(measured.measurement
          ? { budgetMeasurement: measured.measurement }
          : {}),
        failure,
        finishedAt
      });
      terminalFailure(state, "cancelled", failure, finishedAt);
      return persist(runtime, state);
    }

    if (result.status === "failed") {
      const failureSignature =
        result.failureSignature ?? sha256Canonical({ reason: result.failure.reason });
      const diffDigest = result.diffDigest ?? sha256Canonical(artifacts);
      const failure = failureSemantic({
        ...result.failure,
        failureSignature,
        diffDigest
      });
      replaceLastAttempt(state, {
        ...runningAttempt,
        status: "failed",
        outputArtifacts: artifacts,
        outputDigest: digest,
        budgetUsage: state.budgetUsage,
        budgetDelta: delta,
        ...(measured.measurement
          ? { budgetMeasurement: measured.measurement }
          : {}),
        failure,
        finishedAt
      });
      state.updatedAt = finishedAt;
      if (stage !== "verification" || !result.failure.retryable) {
        terminalFailure(state, "failed", failure, finishedAt);
        return persist(runtime, state);
      }
      const observation: RepairObservation = cloneAndFreeze({
        verificationAttemptId: runningAttempt.id,
        failureSignature,
        diffDigest
      });
      state.repairHistory.push(observation);
      const previous = state.repairHistory.at(-2);
      if (
        previous !== undefined &&
        previous.failureSignature === observation.failureSignature &&
        previous.diffDigest === observation.diffDigest
      ) {
        const noProgress = failureSemantic({
          kind: "no_progress",
          retryable: false,
          reason: "Two consecutive repair rounds produced the same failure signature and diff",
          failureSignature,
          diffDigest
        });
        terminalFailure(state, "needs_human", noProgress, finishedAt);
        return persist(runtime, state);
      }
      if (state.budgetUsage.repairAttempts >= state.limits.maxRepairAttempts) {
        const exhausted = failureSemantic({
          kind: "budget_exhausted",
          retryable: false,
          reason: "Verification repair attempt budget was exhausted",
          failureSignature,
          diffDigest
        });
        terminalFailure(state, "failed", exhausted, finishedAt);
        return persist(runtime, state);
      }
      state.budgetUsage = {
        ...state.budgetUsage,
        repairAttempts: state.budgetUsage.repairAttempts + 1
      };
      state.status = "running";
      state.currentStage = "implementation";
      state.nextInputArtifacts = artifacts;
      delete state.failure;
      await persist(runtime, state);
      continue;
    }

    if (result.status === "waiting_approval") {
      replaceLastAttempt(state, {
        ...runningAttempt,
        status: "waiting_approval",
        outputArtifacts: artifacts,
        outputDigest: digest,
        budgetUsage: state.budgetUsage,
        budgetDelta: delta,
        ...(measured.measurement
          ? { budgetMeasurement: measured.measurement }
          : {})
      });
      state.status = "waiting_approval";
      state.currentStage = "approval_demo";
      state.nextInputArtifacts = artifacts;
      state.updatedAt = finishedAt;
      delete state.failure;
      return persist(runtime, state);
    }

    replaceLastAttempt(state, {
      ...runningAttempt,
      status: "completed",
      outputArtifacts: artifacts,
      outputDigest: digest,
      budgetUsage: state.budgetUsage,
      budgetDelta: delta,
      ...(measured.measurement
        ? { budgetMeasurement: measured.measurement }
        : {}),
      finishedAt
    });
    state.nextInputArtifacts = artifacts;
    state.updatedAt = finishedAt;
    delete state.failure;
    const next = nextStage(stage);
    if (next === undefined) {
      state.status = "completed";
      delete state.currentStage;
      return persist(runtime, state);
    }
    state.currentStage = next;
    await persist(runtime, state);
  }
  return sealState(state);
}
