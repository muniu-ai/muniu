// SPDX-License-Identifier: Apache-2.0

import type { MoneyV1, SettlementRecordV1 } from "./types.js";
import { createMoney } from "./money.js";
import {
  canonicalFrozenClone,
  requireIdentifier,
  requireStrings,
  requireTimestamp
} from "./shared.js";

export type CreateSettlementRecordInput = Omit<SettlementRecordV1, "schemaVersion">;

function optionalMoney(value: MoneyV1 | undefined): MoneyV1 | undefined {
  return value === undefined ? undefined : createMoney(value.currency, value.minorUnits);
}

export function createSettlementRecord(input: CreateSettlementRecordInput): SettlementRecordV1 {
  if (!Number.isSafeInteger(input.humanMinutes) || input.humanMinutes < 0) {
    throw new TypeError("humanMinutes must be a non-negative safe integer");
  }
  const contracted = optionalMoney(input.contracted);
  const invoiced = optionalMoney(input.invoiced);
  const received = optionalMoney(input.received);
  const modelCost = optionalMoney(input.modelCost);
  const externalCost = optionalMoney(input.externalCost);
  return canonicalFrozenClone({
    schemaVersion: 1,
    id: requireIdentifier(input.id, "id"),
    commitmentRef: requireIdentifier(input.commitmentRef, "commitmentRef"),
    ...(contracted === undefined ? {} : { contracted }),
    ...(invoiced === undefined ? {} : { invoiced }),
    ...(received === undefined ? {} : { received }),
    ...(modelCost === undefined ? {} : { modelCost }),
    ...(externalCost === undefined ? {} : { externalCost }),
    humanMinutes: input.humanMinutes,
    sourceRefs: requireStrings(input.sourceRefs, "sourceRefs", 1, true),
    recordedAt: requireTimestamp(input.recordedAt, "recordedAt"),
    recordedBy: requireIdentifier(input.recordedBy, "recordedBy")
  });
}
