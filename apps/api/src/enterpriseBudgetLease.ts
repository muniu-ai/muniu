import type { RunRecord } from "@mn/core";
import type { GovernedRunState } from "@mn/loop";
import type { AuthoritativeProxyUsage } from "./loopBudgetMeasurement.js";
import type { RunJobQueueItem } from "./runJobQueue.js";

export interface EnterpriseBudgetLeaseStop {
  readonly kind: "budget_exhausted";
  readonly dimension: "duration" | "tokens" | "cost";
  readonly observed: number;
  readonly limit: number;
  readonly usageDigest: string;
  readonly reason: string;
}

export interface EnterpriseBudgetLeaseDecision {
  readonly ttlMs: number;
  readonly observed: Readonly<{
    durationSeconds: number;
    tokens: number;
    costUsd: number;
  }>;
  readonly stop?: EnterpriseBudgetLeaseStop;
}

/**
 * Evaluates the live, API-owned budget before any enterprise lease renewal.
 * Duration includes the unmeasured running interval; token/cost come only
 * from the trusted provider usage ledger. The renewed TTL is capped so it
 * cannot itself extend beyond the duration limit.
 */
export function evaluateEnterpriseBudgetLease(input: {
  readonly run: RunRecord;
  readonly state: GovernedRunState | undefined;
  readonly item: RunJobQueueItem;
  readonly usage: AuthoritativeProxyUsage;
  readonly requestedTtlMs: number;
  readonly now?: string;
}): EnterpriseBudgetLeaseDecision {
  const now = canonicalTime(input.now ?? new Date().toISOString(), "now");
  if (!Number.isSafeInteger(input.requestedTtlMs) || input.requestedTtlMs < 1_000) {
    throw new TypeError("requestedTtlMs must be a safe integer of at least 1000");
  }
  const limits = input.run.harnessManifest?.stopConditions ?? {};
  const measuredDuration = input.state?.budgetUsage.durationSeconds ?? 0;
  const running = input.state?.attempts.at(-1);
  const intervalStart = running?.status === "running"
    ? running.startedAt
    : input.state
      ? undefined
      : input.item.claimedAt;
  const liveSeconds = intervalStart
    ? Math.max(0, (Date.parse(now) - Date.parse(canonicalTime(intervalStart, "intervalStart"))) / 1_000)
    : 0;
  const observed = Object.freeze({
    durationSeconds: measuredDuration + liveSeconds,
    tokens: input.usage.tokens,
    costUsd: input.usage.costUsd
  });
  if (input.usage.requiresBudgetStop) {
    const costLimit = limits.maxCostUsd;
    const tokenLimit = limits.maxTokens;
    const dimension = costLimit !== undefined ? "cost" as const : "tokens" as const;
    const limit = costLimit ?? tokenLimit ?? 0;
    const actual = dimension === "cost" ? observed.costUsd : observed.tokens;
    return {
      ttlMs: 0,
      observed,
      stop: Object.freeze({
        kind: "budget_exhausted" as const,
        dimension,
        observed: actual,
        limit,
        usageDigest: input.usage.digest,
        reason: "Enterprise Loop conservative provider-usage hold requires a budget stop"
      })
    };
  }
  for (const [dimension, actual, limit] of [
    ["duration", observed.durationSeconds, limits.maxDurationSeconds],
    ["tokens", observed.tokens, limits.maxTokens],
    ["cost", observed.costUsd, limits.maxCostUsd]
  ] as const) {
    if (limit !== undefined && actual > limit) {
      return {
        ttlMs: 0,
        observed,
        stop: Object.freeze({
          kind: "budget_exhausted",
          dimension,
          observed: actual,
          limit,
          usageDigest: input.usage.digest,
          reason: `Enterprise Loop ${dimension} budget is exhausted`
        })
      };
    }
  }
  let ttlMs = input.requestedTtlMs;
  if (limits.maxDurationSeconds !== undefined) {
    const remainingMs = Math.floor(
      (limits.maxDurationSeconds - observed.durationSeconds) * 1_000
    );
    if (remainingMs < 1_000) {
      return {
        ttlMs: 0,
        observed,
        stop: Object.freeze({
          kind: "budget_exhausted",
          dimension: "duration",
          observed: observed.durationSeconds,
          limit: limits.maxDurationSeconds,
          usageDigest: input.usage.digest,
          reason: "Enterprise Loop duration budget cannot authorize another lease interval"
        })
      };
    }
    ttlMs = Math.min(ttlMs, remainingMs);
  }
  return { ttlMs, observed };
}

function canonicalTime(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}
