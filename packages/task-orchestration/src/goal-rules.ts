// SPDX-License-Identifier: Apache-2.0
import type { GoalBudgetV2, GoalDeliverableSpecV2, GoalUsageV2 } from "@mn/contracts";

export class GoalRuleError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "GoalRuleError"; }
}
function fail(code: string, message: string): never { throw new GoalRuleError(code, message); }
function integer(value: number, minimum = 0): boolean { return Number.isSafeInteger(value) && value >= minimum; }
function key(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)) fail("GOAL_INPUT_INVALID", "目标标识无效");
}
/** These pure rules preserve the 0.2 single-executor validation and error codes. */
export function validateGoalUsage(value: GoalUsageV2): void {
  if (!value || !integer(value.tokens) || typeof value.costMinorUnits !== "string" || !/^(0|[1-9][0-9]{0,23})$/u.test(value.costMinorUnits)
    || typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) fail("GOAL_BUDGET_INVALID", "预算与用量必须是非负整数及有效币种");
}
export function validateGoalBudget(value: GoalBudgetV2): void {
  validateGoalUsage({ tokens: value?.maxTokens, costMinorUnits: value?.maxCostMinorUnits, currency: value?.currency });
  if (!integer(value.maxDurationMs, 1)) fail("GOAL_BUDGET_INVALID", "执行期限必须是正整数");
}
export function validateDeliverableSpecs(items: readonly GoalDeliverableSpecV2[]): void {
  if (!Array.isArray(items) || !items.length || items.length > 20 || !items.some(item => item?.required)
    || new Set(items.map(item => item?.key)).size !== items.length) fail("GOAL_INPUT_INVALID", "目标需要唯一且明确的必需交付项");
  for (const item of items) {
    key(item?.key);
    if (!item.title?.trim() || item.title.length > 200 || typeof item.required !== "boolean" || !Array.isArray(item.criteria)
      || !item.criteria.length || item.criteria.length > 20 || new Set(item.criteria.map((criterion: GoalDeliverableSpecV2["criteria"][number]) => criterion?.id)).size !== item.criteria.length) fail("GOAL_INPUT_INVALID", "交付项需要明确验收标准");
    for (const criterion of item.criteria) { key(criterion?.id); if (!criterion.description?.trim() || criterion.description.length > 2000) fail("GOAL_INPUT_INVALID", "验收标准无效"); }
  }
}
