// SPDX-License-Identifier: Apache-2.0
import type { Execution, ExecutionAuthority, ExecutionMeteringView } from "@mn/contracts";
import { reduceModelBudget, type RuntimeRecord } from "@mn/agent-runtime";

export function executionMetering(execution: Execution, authority: ExecutionAuthority,
  records: readonly RuntimeRecord[]): ExecutionMeteringView {
  const budget = reduceModelBudget(records, authority.budget);
  const status = execution.runnerId && execution.runnerId !== "builtin" ? "external_runner"
    : budget.overrun ? "overrun" : budget.pendingRequests ? "pending"
    : records.some(record => record.type === "model/settled") ? "estimated" : "not_started";
  return { status, currency: budget.limits.currency, knownTokens: budget.knownTokens,
    estimatedCostNanoMinorUnits: budget.knownCostNanoMinorUnits,
    maxTokens: budget.limits.maxTokens, maxCostMinorUnits: budget.limits.maxCostMinorUnits,
    pendingRequests: budget.pendingRequests,
    inputCountEstimated: records.some(record => record.type === "model/reserved"
      && record.payload.inputTokenLimitBasis === "conservative_utf8_estimate"),
    billingGuarantee: false };
}

export function meteringCostSummary(view: ExecutionMeteringView): string {
  if (view.status === "external_runner") return "外部 Runner 费用请在厂商账单核对";
  if (view.status === "not_started") return "尚无已结算用量";
  const cents = (BigInt(view.estimatedCostNanoMinorUnits) + 999_999_999n) / 1_000_000_000n;
  const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  return `预估 ${view.currency} ${amount}${view.status === "pending" ? "，另有待核对用量" : view.status === "overrun" ? "，用量超出预留" : ""}`;
}
