// SPDX-License-Identifier: Apache-2.0

import type { CustomerCommitmentV1 } from "./types.js";
import { createMoney } from "./money.js";
import {
  canonicalFrozenClone,
  requireIdentifier,
  requireStrings,
  requireText,
  requireTimestamp
} from "./shared.js";

export type CreateCustomerCommitmentInput = Omit<CustomerCommitmentV1, "schemaVersion">;

export function createCustomerCommitment(
  input: CreateCustomerCommitmentInput
): CustomerCommitmentV1 {
  return canonicalFrozenClone({
    schemaVersion: 1,
    accountRef: requireIdentifier(input.accountRef, "accountRef"),
    promisedOutcome: requireText(input.promisedOutcome, "promisedOutcome"),
    scope: requireStrings(input.scope, "scope", 1),
    nonGoals: requireStrings(input.nonGoals, "nonGoals", 1),
    price: createMoney(input.price.currency, input.price.minorUnits),
    dueAt: requireTimestamp(input.dueAt, "dueAt"),
    dataAuthorizationRefs: requireStrings(input.dataAuthorizationRefs, "dataAuthorizationRefs", 1, true),
    acceptanceCriteria: requireStrings(input.acceptanceCriteria, "acceptanceCriteria", 1),
    customerResponsibilities: requireStrings(input.customerResponsibilities, "customerResponsibilities", 1),
    providerResponsibilities: requireStrings(input.providerResponsibilities, "providerResponsibilities", 1),
    approverRefs: requireStrings(input.approverRefs, "approverRefs", 1, true)
  });
}
