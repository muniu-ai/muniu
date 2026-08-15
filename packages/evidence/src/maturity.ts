import { deepFreeze, digestCanonical, exactFields } from "./shared.js";
import { canonicalJson } from "@mn/specs";

export interface MaturityMeasurementInput {
  readonly incrementCycleSeconds: readonly number[];
  readonly totalRuns: number;
  readonly failedRuns: number;
  readonly requiredContractClauses: number;
  readonly coveredContractClauses: number;
  readonly regressionRuns: number;
  readonly regressionHits: number;
  readonly contextComparisons: number;
  readonly contextDrifts: number;
  readonly aiChanges: number;
  readonly aiReworks: number;
  readonly completedRetrospectives: number;
  readonly retainedLearnings: number;
  readonly feedbackClosureSeconds: readonly number[];
}

export interface MaturityReport {
  readonly schemaVersion: 1;
  readonly verifiableIncrementCycleSeconds: number;
  readonly failureRate: number;
  readonly contractCoverageRate: number;
  readonly automaticRegressionHitRate: number;
  readonly contextDriftRate: number;
  readonly aiReworkRate: number;
  readonly retrospectiveRetentionRate: number;
  readonly feedbackClosureSeconds: number;
  readonly samples: Readonly<{
    cycles: number;
    runs: number;
    contractClauses: number;
    regressions: number;
    contextComparisons: number;
    aiChanges: number;
    retrospectives: number;
    feedbackClosures: number;
  }>;
  readonly digest: string;
}

const INPUT_FIELDS = new Set([
  "incrementCycleSeconds",
  "totalRuns",
  "failedRuns",
  "requiredContractClauses",
  "coveredContractClauses",
  "regressionRuns",
  "regressionHits",
  "contextComparisons",
  "contextDrifts",
  "aiChanges",
  "aiReworks",
  "completedRetrospectives",
  "retainedLearnings",
  "feedbackClosureSeconds"
]);

export function buildMaturityReport(
  input: MaturityMeasurementInput
): MaturityReport {
  const safe = JSON.parse(canonicalJson(input)) as unknown as Record<string, unknown>;
  exactFields(safe, INPUT_FIELDS, "maturity");
  const cycles = durations(safe.incrementCycleSeconds, "incrementCycleSeconds");
  const closures = durations(safe.feedbackClosureSeconds, "feedbackClosureSeconds");
  const totalRuns = count(safe.totalRuns, "totalRuns");
  const failedRuns = boundedCount(safe.failedRuns, totalRuns, "failedRuns");
  const contractClauses = count(safe.requiredContractClauses, "requiredContractClauses");
  const coveredContracts = boundedCount(
    safe.coveredContractClauses,
    contractClauses,
    "coveredContractClauses"
  );
  const regressionRuns = count(safe.regressionRuns, "regressionRuns");
  const regressionHits = boundedCount(safe.regressionHits, regressionRuns, "regressionHits");
  const contextComparisons = count(safe.contextComparisons, "contextComparisons");
  const contextDrifts = boundedCount(safe.contextDrifts, contextComparisons, "contextDrifts");
  const aiChanges = count(safe.aiChanges, "aiChanges");
  const aiReworks = boundedCount(safe.aiReworks, aiChanges, "aiReworks");
  const retrospectives = count(safe.completedRetrospectives, "completedRetrospectives");
  const retainedLearnings = boundedCount(
    safe.retainedLearnings,
    retrospectives,
    "retainedLearnings"
  );
  const semantic = {
    schemaVersion: 1 as const,
    verifiableIncrementCycleSeconds: average(cycles),
    failureRate: ratio(failedRuns, totalRuns),
    contractCoverageRate: ratio(coveredContracts, contractClauses),
    automaticRegressionHitRate: ratio(regressionHits, regressionRuns),
    contextDriftRate: ratio(contextDrifts, contextComparisons),
    aiReworkRate: ratio(aiReworks, aiChanges),
    retrospectiveRetentionRate: ratio(retainedLearnings, retrospectives),
    feedbackClosureSeconds: average(closures),
    samples: {
      cycles: cycles.length,
      runs: totalRuns,
      contractClauses,
      regressions: regressionRuns,
      contextComparisons,
      aiChanges,
      retrospectives,
      feedbackClosures: closures.length
    }
  };
  return deepFreeze({ ...semantic, digest: digestCanonical(semantic) });
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function boundedCount(value: unknown, maximum: number, field: string): number {
  const result = count(value, field);
  if (result > maximum) throw new TypeError(`${field} cannot exceed its denominator`);
  return result;
}

function durations(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
      throw new TypeError(`${field}[${index}] must be a non-negative finite number`);
    }
    return item;
  });
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}
