// SPDX-License-Identifier: Apache-2.0

import type {
  ActionIntentV1,
  AuthorityDecisionKindV1,
  AuthorityDecisionV1
} from "./types.js";
import {
  canonicalFrozenClone,
  requireIdentifier,
  requireTimestamp
} from "./shared.js";

export interface CreateAuthorityDecisionInput {
  readonly id: string;
  readonly decision: AuthorityDecisionKindV1;
  readonly actor: string;
  readonly actorRole: string;
  readonly decidedAt: string;
  readonly deferUntil?: string;
}

const DECISIONS = new Set<AuthorityDecisionKindV1>([
  "approve",
  "reject",
  "request_changes",
  "defer"
]);

export function createAuthorityDecision(
  action: ActionIntentV1,
  input: CreateAuthorityDecisionInput
): AuthorityDecisionV1 {
  if (!DECISIONS.has(input.decision)) throw new TypeError("authority decision is invalid");
  const decidedAt = requireTimestamp(input.decidedAt, "decidedAt");
  const createdAt = requireTimestamp(action.createdAt, "action.createdAt");
  const expiresAt = requireTimestamp(action.expiresAt, "action.expiresAt");
  if (Date.parse(decidedAt) < Date.parse(createdAt)) {
    throw new TypeError("authority decision cannot precede the action intent");
  }
  if (Date.parse(decidedAt) >= Date.parse(expiresAt)) {
    throw new TypeError("authority decision cannot approve an expired action intent");
  }
  if (input.decision === "defer" && input.deferUntil === undefined) {
    throw new TypeError("deferUntil is required for a deferred authority decision");
  }
  const deferUntil = input.deferUntil === undefined
    ? undefined
    : requireTimestamp(input.deferUntil, "deferUntil");
  if (deferUntil !== undefined && Date.parse(deferUntil) <= Date.parse(decidedAt)) {
    throw new TypeError("deferUntil must be after decidedAt");
  }
  return canonicalFrozenClone({
    schemaVersion: 1,
    id: requireIdentifier(input.id, "id"),
    tenantId: action.tenantId,
    runId: action.runId,
    actionId: action.id,
    generation: action.generation,
    inputDigest: action.inputDigest,
    governanceDigest: action.governanceDigest,
    idempotencyKey: action.idempotencyKey,
    decision: input.decision,
    actor: requireIdentifier(input.actor, "actor"),
    actorRole: requireIdentifier(input.actorRole, "actorRole"),
    decidedAt,
    ...(deferUntil === undefined ? {} : { deferUntil })
  });
}

export function assertAuthorityDecisionCurrent(
  decision: AuthorityDecisionV1,
  action: ActionIntentV1,
  now: string
): boolean {
  const checkedAt = requireTimestamp(now, "now");
  if (Date.parse(checkedAt) >= Date.parse(requireTimestamp(action.expiresAt, "action.expiresAt"))) {
    throw new Error("action intent expired");
  }
  if (Date.parse(checkedAt) < Date.parse(requireTimestamp(decision.decidedAt, "decision.decidedAt"))) {
    throw new Error("authority decision is not yet effective");
  }
  const current = decision.tenantId === action.tenantId
    && decision.runId === action.runId
    && decision.actionId === action.id
    && decision.generation === action.generation
    && decision.inputDigest === action.inputDigest
    && decision.governanceDigest === action.governanceDigest
    && decision.idempotencyKey === action.idempotencyKey;
  if (!current) throw new Error("stale authority decision");
  return decision.decision === "approve";
}
