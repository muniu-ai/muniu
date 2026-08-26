// SPDX-License-Identifier: Apache-2.0

import type { AttentionItemV1, ConsequenceTierV1 } from "./types.js";
import { canonicalFrozenClone, compareCodeUnits, requireTimestamp } from "./shared.js";

const CONSEQUENCE_RANK: Readonly<Record<ConsequenceTierV1, number>> = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
});

function timestamp(value: string | undefined): number {
  return value === undefined ? Number.POSITIVE_INFINITY : Date.parse(value);
}

export function sortAttentionItems(
  items: readonly AttentionItemV1[],
  now: string
): readonly AttentionItemV1[] {
  const nowTimestamp = Date.parse(requireTimestamp(now, "now"));
  const snapshot = items.map((item, index) => {
    requireTimestamp(item.dueAt, `items[${index}].dueAt`);
    requireTimestamp(item.createdAt, `items[${index}].createdAt`);
    if (item.earliestCommitmentDueAt !== undefined) {
      requireTimestamp(item.earliestCommitmentDueAt, `items[${index}].earliestCommitmentDueAt`);
    }
    if (!(item.consequenceTier in CONSEQUENCE_RANK)) {
      throw new TypeError(`items[${index}].consequenceTier is invalid`);
    }
    if (!Number.isSafeInteger(item.estimatedHumanMinutes) || item.estimatedHumanMinutes < 0) {
      throw new TypeError(`items[${index}].estimatedHumanMinutes must be a non-negative safe integer`);
    }
    return canonicalFrozenClone(item);
  });
  snapshot.sort((left, right) => {
    const overdueDifference = Number(Date.parse(right.dueAt) < nowTimestamp)
      - Number(Date.parse(left.dueAt) < nowTimestamp);
    if (overdueDifference !== 0) return overdueDifference;
    const consequenceDifference = CONSEQUENCE_RANK[right.consequenceTier]
      - CONSEQUENCE_RANK[left.consequenceTier];
    if (consequenceDifference !== 0) return consequenceDifference;
    const commitmentDueDifference = timestamp(left.earliestCommitmentDueAt)
      - timestamp(right.earliestCommitmentDueAt);
    if (commitmentDueDifference !== 0) return commitmentDueDifference;
    const blockedDifference = right.blockedCommitmentIds.length - left.blockedCommitmentIds.length;
    if (blockedDifference !== 0) return blockedDifference;
    const createdDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (createdDifference !== 0) return createdDifference;
    return compareCodeUnits(left.id, right.id);
  });
  return Object.freeze(snapshot);
}
