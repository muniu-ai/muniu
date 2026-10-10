// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { GoalRuleError, validateGoalBudget, validateGoalUsage, validateDeliverableSpecs } from "../src/index.js";

test("single goal budget preserves zero allowance and rejects malformed money or duration", () => {
  const budget = { maxTokens: 0, maxCostMinorUnits: "0", currency: "CNY", maxDurationMs: 1 };
  assert.doesNotThrow(() => validateGoalBudget(budget));
  for (const delta of [{ maxTokens: -1 }, { maxTokens: 1.5 }, { maxCostMinorUnits: "01" }, { maxCostMinorUnits: "1".repeat(25) }, { currency: "cny" }, { maxDurationMs: 0 }]) {
    assert.throws(() => validateGoalBudget({ ...budget, ...delta }), (error: unknown) => error instanceof GoalRuleError && error.code === "GOAL_BUDGET_INVALID");
  }
  assert.doesNotThrow(() => validateGoalUsage({ tokens: 0, costMinorUnits: "0", currency: "USD" }));
});
test("single goal deliverables retain identifier, required item and acceptance rules", () => {
  const item = { key: "report", title: "报告", required: true, criteria: [{ id: "source", description: "依据可回溯" }] };
  assert.doesNotThrow(() => validateDeliverableSpecs([item]));
  for (const items of [[], [item, item], [{ ...item, required: false }], [{ ...item, key: "空 格" }], [{ ...item, title: " " }], [{ ...item, criteria: [] }], [{ ...item, criteria: [...item.criteria, ...item.criteria] }]]) {
    assert.throws(() => validateDeliverableSpecs(items), (error: unknown) => error instanceof GoalRuleError && error.code === "GOAL_INPUT_INVALID");
  }
});
