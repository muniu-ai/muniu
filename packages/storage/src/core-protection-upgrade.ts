// SPDX-License-Identifier: Apache-2.0
import { PROTECTED_CORE_PROJECTION_NAMESPACES, replayCoreProjections, type KernelEventV1 } from "@mn/contracts";
import {
  assertIdempotencyReplayCoverage, protectedIdempotencyReceipts, isJournalNamespace, prepareProtectedProjection, verifyProjectionJournalHistory, unprotectedCoreProjectionFacts,
  type ProjectionJournalFact, type ProjectionJournalOptions, type ProtectedProjectionReference,
} from "./projection-journal.js";

import type { KernelIdempotencyRecordLike } from "./types.js";

export interface CoreProjectionProtectionUpgradeInput {
  readonly actorId: string;
  readonly expectedPosition: number;
}

export interface CoreProjectionProtectionUpgradeResult {
  readonly tenantId: string;
  readonly fromPosition: number;
  readonly position: number;
  readonly upgradedRecords: number;
  readonly alreadyCurrent: boolean;
}

export interface PreparedCoreProjectionProtectionUpgrade {
  readonly fromPosition: number;
  readonly fromDigest: string | null;
  readonly idempotency: readonly KernelIdempotencyRecordLike[];
  readonly changes: readonly {
    readonly fact: ProjectionJournalFact;
    readonly reference: ProtectedProjectionReference;
  }[];
}

/** Called only while an offline maintenance transaction holds the tenant event head. */
export async function prepareCoreProjectionProtectionUpgrade(options: ProjectionJournalOptions & CoreProjectionProtectionUpgradeInput & {
  readonly tenantId: string;
  readonly events: readonly KernelEventV1[];
  readonly hmacKey: Uint8Array;
  readonly idempotencyEntries: readonly KernelIdempotencyRecordLike[];
}): Promise<PreparedCoreProjectionProtectionUpgrade> {
  if (!options.actorId.trim()) throw new TypeError("Core protection upgrade requires an actor");
  if (options.events.length > 1_000_000) throw new Error("Core protection upgrade exceeds the event limit");
  if (!Number.isSafeInteger(options.expectedPosition) || options.expectedPosition < 0
    || (options.events.at(-1)?.position ?? 0) !== options.expectedPosition) {
    throw new Error("Core protection upgrade event position does not match the expected position");
  }
  if (PROTECTED_CORE_PROJECTION_NAMESPACES.some(namespace => !isJournalNamespace(namespace, options))) {
    throw new Error("Core protection upgrade requires the complete current protection policy");
  }
  replayCoreProjections(options.events, options.tenantId, options.hmacKey);
  const facts = await verifyProjectionJournalHistory(options);
  const idempotency = protectedIdempotencyReceipts(options.tenantId, options.events, facts);
  assertIdempotencyReplayCoverage(options, options.idempotencyEntries, idempotency);
  const pending = unprotectedCoreProjectionFacts(options, options.events);
  const changes: { fact: ProjectionJournalFact; reference: ProtectedProjectionReference }[] = [];
  for (const fact of pending) {
    const { reference } = await prepareProtectedProjection(options, options.tenantId, fact);
    changes.push({ fact, reference });
  }
  return { fromPosition: options.expectedPosition, fromDigest: options.events.at(-1)?.digest ?? null, changes, idempotency };
}
