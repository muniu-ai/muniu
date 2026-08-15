import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProxyRequestLog } from "@mn/provider-catalog";
import {
  sha256Canonical,
  validateLoopBudgetMeasurementProof,
  type LoopBudgetDelta,
  type LoopBudgetDiffArtifactBinding,
  type LoopBudgetMeasurementProof
} from "@mn/loop";

const SIGNATURE_DOMAIN = "mn-loop-budget-measurement-v1\0";

export interface IssueLoopBudgetMeasurementInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly stageAttemptId: string;
  readonly stage: LoopBudgetMeasurementProof["stage"];
  readonly attempt: number;
  readonly intervalStartedAt: string;
  readonly measuredAt: string;
  readonly usageRequestIds: readonly string[];
  readonly usageDigest: string;
  readonly diffArtifact?: LoopBudgetDiffArtifactBinding;
  readonly delta: LoopBudgetDelta;
  readonly previousMeasurement?: LoopBudgetMeasurementProof;
  readonly signingKey: string;
}

export interface LoopBudgetMeasurementTrustBinding {
  readonly tenantId: string;
  readonly runId: string;
  readonly signingKey: string;
  readonly workerId?: string;
  readonly claimDigest?: string;
}

export interface LoopBudgetMeasurementVerification {
  readonly valid: boolean;
  readonly proof?: LoopBudgetMeasurementProof;
  readonly reason?: string;
}

export interface AuthoritativeProxyUsage {
  readonly requestIds: readonly string[];
  readonly tokens: number;
  readonly costUsd: number;
  readonly allRequestsPriced: boolean;
  /** A conservative human reconciliation must stop further provider work. */
  readonly requiresBudgetStop?: boolean;
  readonly digest: string;
}

export function issueLoopBudgetMeasurement(
  input: IssueLoopBudgetMeasurementInput
): LoopBudgetMeasurementProof {
  const previous = input.previousMeasurement;
  const delta = budget(input.delta, "delta");
  const cumulative = addBudget(
    previous?.cumulative ?? zeroBudget(),
    delta
  );
  const usageRequestIds = uniqueSortedIdentities(
    input.usageRequestIds,
    "usageRequestIds"
  );
  const semantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    tenantId: identity(input.tenantId, "tenantId"),
    runId: identity(input.runId, "runId"),
    workerId: identity(input.workerId, "workerId"),
    claimDigest: digest(input.claimDigest, "claimDigest"),
    stageAttemptId: identity(input.stageAttemptId, "stageAttemptId"),
    stage: input.stage,
    attempt: positiveInteger(input.attempt, "attempt"),
    ...(previous ? { previousMeasurementDigest: previous.digest } : {}),
    intervalStartedAt: timestamp(input.intervalStartedAt, "intervalStartedAt"),
    measuredAt: timestamp(input.measuredAt, "measuredAt"),
    usageRequestIds,
    usageDigest: digest(input.usageDigest, "usageDigest"),
    ...(input.diffArtifact
      ? { diffArtifact: diffArtifact(input.diffArtifact) }
      : {}),
    delta,
    cumulative
  };
  if (semantic.measuredAt < semantic.intervalStartedAt) {
    throw new TypeError("measuredAt cannot precede intervalStartedAt");
  }
  if (
    previous &&
    (previous.runId !== semantic.runId ||
      previous.tenantId !== semantic.tenantId ||
      previous.measuredAt > semantic.intervalStartedAt)
  ) {
    throw new TypeError("previous measurement is not a valid predecessor");
  }
  const proofDigest = sha256Canonical(semantic);
  return validateLoopBudgetMeasurementProof({
    ...semantic,
    digest: proofDigest,
    signature: sign(proofDigest, signingKey(input.signingKey))
  });
}

export function verifyLoopBudgetMeasurement(
  value: unknown,
  binding: LoopBudgetMeasurementTrustBinding
): LoopBudgetMeasurementVerification {
  try {
    const proof = validateLoopBudgetMeasurementProof(value);
    if (
      proof.tenantId !== binding.tenantId ||
      proof.runId !== binding.runId
    ) {
      return { valid: false, reason: "measurement tenant or run binding mismatch" };
    }
    if (
      binding.workerId !== undefined &&
      proof.workerId !== binding.workerId
    ) {
      return { valid: false, reason: "measurement worker binding mismatch" };
    }
    if (
      binding.claimDigest !== undefined &&
      proof.claimDigest !== binding.claimDigest
    ) {
      return { valid: false, reason: "measurement claim binding mismatch" };
    }
    const expected = sign(proof.digest, signingKey(binding.signingKey));
    if (!safeEqual(proof.signature, expected)) {
      return { valid: false, reason: "measurement signature mismatch" };
    }
    return { valid: true, proof };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "invalid loop budget measurement"
    };
  }
}

/** Builds a stable, server-owned usage semantic. Cost is supplied by the
 * control-plane pricing catalog; a caller can fail closed when any request is
 * unpriced and the Harness has a cost limit. */
export function authoritativeProxyUsage(
  logs: readonly ProxyRequestLog[],
  costsByRequestId: ReadonlyMap<string, number | undefined>
): AuthoritativeProxyUsage {
  const normalized = [...logs]
    .map((log) => ({
      id: identity(log.id, "proxy usage request id"),
      app: log.app,
      providerId: log.providerId,
      model: log.model,
      inputTokens: nonNegativeInteger(log.inputTokens, "inputTokens"),
      outputTokens: nonNegativeInteger(log.outputTokens, "outputTokens"),
      cacheCreationInputTokens: nonNegativeInteger(
        log.cacheCreationInputTokens ?? 0,
        "cacheCreationInputTokens"
      ),
      cacheReadInputTokens: nonNegativeInteger(
        log.cacheReadInputTokens ?? 0,
        "cacheReadInputTokens"
      ),
      statusCode: nonNegativeInteger(log.statusCode, "statusCode"),
      createdAt: timestamp(log.createdAt, "proxy usage createdAt"),
      ...(costsByRequestId.get(log.id) === undefined
        ? {}
        : { costUsd: costsByRequestId.get(log.id)! }),
      requiresBudgetStop: log.usageResolution?.requiresBudgetStop === true
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
    throw new TypeError("proxy usage contains duplicate request ids");
  }
  const priced = normalized.every((entry) => entry.costUsd !== undefined);
  const costUsd = roundCost(
    normalized.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
  );
  return Object.freeze({
    requestIds: Object.freeze(normalized.map((entry) => entry.id)),
    tokens: normalized.reduce(
      (sum, entry) =>
        sum +
        entry.inputTokens +
        entry.outputTokens +
        entry.cacheCreationInputTokens +
        entry.cacheReadInputTokens,
      0
    ),
    costUsd,
    allRequestsPriced: priced,
    requiresBudgetStop: normalized.some((entry) => entry.requiresBudgetStop),
    digest: sha256Canonical(normalized)
  });
}

/** Convert unknown enterprise pricing into a signed, completable budget
 * exhaustion instead of returning a retrying 409 with no terminal proof. */
export function applyFailClosedUnpricedCost(
  usage: AuthoritativeProxyUsage,
  maxCostUsd: number | undefined
): AuthoritativeProxyUsage {
  if (
    maxCostUsd === undefined ||
    usage.allRequestsPriced ||
    usage.requestIds.length === 0
  ) {
    return usage;
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new TypeError("maxCostUsd must be a non-negative finite number");
  }
  const costUsd = roundCost(maxCostUsd + 0.00000001);
  return Object.freeze({
    ...usage,
    costUsd,
    digest: sha256Canonical({
      sourceUsageDigest: usage.digest,
      pricingDecision: "unpriced-fail-closed",
      maxCostUsd,
      costUsd
    })
  });
}

function diffArtifact(
  value: LoopBudgetDiffArtifactBinding
): LoopBudgetDiffArtifactBinding {
  return Object.freeze({
    id: identity(value.id, "diffArtifact.id"),
    uri: identity(value.uri, "diffArtifact.uri"),
    digest: digest(value.digest, "diffArtifact.digest"),
    byteLength: nonNegativeInteger(value.byteLength, "diffArtifact.byteLength"),
    candidateId: identity(value.candidateId, "diffArtifact.candidateId"),
    workspaceUri: identity(value.workspaceUri, "diffArtifact.workspaceUri"),
    leaseId: identity(value.leaseId, "diffArtifact.leaseId"),
    runtimeId: digest(value.runtimeId, "diffArtifact.runtimeId"),
    runtimeProofDigest: digest(
      value.runtimeProofDigest,
      "diffArtifact.runtimeProofDigest"
    ),
    projectSnapshotDigest: digest(
      value.projectSnapshotDigest,
      "diffArtifact.projectSnapshotDigest"
    ),
    candidateSnapshotDigest: digest(
      value.candidateSnapshotDigest,
      "diffArtifact.candidateSnapshotDigest"
    )
  });
}

function zeroBudget(): LoopBudgetDelta {
  return {
    durationSeconds: 0,
    tokens: 0,
    costUsd: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

function addBudget(left: LoopBudgetDelta, right: LoopBudgetDelta): LoopBudgetDelta {
  return Object.freeze({
    durationSeconds: left.durationSeconds + right.durationSeconds,
    tokens: left.tokens + right.tokens,
    costUsd: roundCost(left.costUsd + right.costUsd),
    changedFiles: left.changedFiles + right.changedFiles,
    changedLines: left.changedLines + right.changedLines
  });
}

function budget(value: LoopBudgetDelta, field: string): LoopBudgetDelta {
  return Object.freeze({
    durationSeconds: nonNegativeNumber(value.durationSeconds, `${field}.durationSeconds`),
    tokens: nonNegativeInteger(value.tokens, `${field}.tokens`),
    costUsd: roundCost(nonNegativeNumber(value.costUsd, `${field}.costUsd`)),
    changedFiles: nonNegativeInteger(value.changedFiles, `${field}.changedFiles`),
    changedLines: nonNegativeInteger(value.changedLines, `${field}.changedLines`)
  });
}

function uniqueSortedIdentities(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  const normalized = values.map((value, index) => identity(value, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} contains duplicates`);
  }
  return normalized.sort();
}

function sign(value: string, key: string): string {
  return createHmac("sha256", key)
    .update(SIGNATURE_DOMAIN, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function signingKey(value: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) < 32) {
    throw new TypeError("loop measurement signing key must contain at least 32 bytes");
  }
  return value;
}

function identity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a non-empty safe identifier`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
