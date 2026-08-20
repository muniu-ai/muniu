// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { LoopBudgetDiffArtifactBinding } from "@mn/loop";
import { executionStateFromEnterpriseClaim } from "./enterpriseClaimState.js";
import type { EnterpriseClaimSnapshot } from "./enterprisePostgres.js";
import { LOOP_DIFF_MANIFEST_CONTENT_TYPE } from "./loopDiffMeasurement.js";
import { verifyLoopBudgetMeasurement } from "./loopBudgetMeasurement.js";
import type { RunScopedCasObjectRef } from "./runScopedCas.js";

export interface ResumeDiffRequestBinding {
  readonly stageAttemptId: string;
  readonly candidateId: string;
  readonly digest: string;
}

export interface EnterpriseResumeDiffBinding {
  readonly ref: RunScopedCasObjectRef;
  readonly artifact: LoopBudgetDiffArtifactBinding;
}

/** Selects one already accepted implementation proof from the active durable
 * claim. A worker cannot use this route as a general CAS oracle. */
export function enterpriseResumeDiffFromClaim(
  claim: EnterpriseClaimSnapshot,
  request: ResumeDiffRequestBinding,
  signingKey: string
): EnterpriseResumeDiffBinding {
  const durable = executionStateFromEnterpriseClaim(claim);
  const state = durable.governedLoopState;
  if (!state) throw new TypeError("run has no durable governed resume state");
  const attempts = state.attempts.filter((attempt) => attempt.id === request.stageAttemptId);
  if (attempts.length !== 1) {
    throw new TypeError("resume diff stage attempt is not uniquely bound");
  }
  const attempt = attempts[0]!;
  if (attempt.stage !== "implementation" || attempt.status !== "completed") {
    throw new TypeError("resume diff requires a completed implementation attempt");
  }
  const verification = verifyLoopBudgetMeasurement(attempt.budgetMeasurement, {
    tenantId: claim.item.tenantId!,
    runId: claim.item.runId,
    signingKey
  });
  if (!verification.valid || !verification.proof) {
    throw new TypeError(
      `resume diff measurement is invalid: ${verification.reason ?? "verification failed"}`
    );
  }
  const artifact = verification.proof.diffArtifact;
  if (
    !artifact ||
    artifact.candidateId !== request.candidateId ||
    artifact.digest !== request.digest ||
    artifact.uri !== `mn://cas/loop-diffs/${encodeURIComponent(artifact.id)}`
  ) {
    throw new TypeError("resume diff request does not match its measurement proof");
  }
  const candidate = durable.run.candidates.find((entry) => entry.id === artifact.candidateId);
  if (
    !candidate ||
    durable.run.winnerCandidateId !== artifact.candidateId ||
    candidate.worktreePath !== artifact.workspaceUri
  ) {
    throw new TypeError("resume diff is not bound to the durable Run winner");
  }
  if (!objectKeyMatchesScope(
    artifact.id,
    claim.item.tenantId!,
    claim.item.projectId,
    claim.item.runId,
    artifact.digest
  )) {
    throw new TypeError("resume diff CAS object is outside the active run scope");
  }
  return Object.freeze({
    ref: Object.freeze({
      schemaVersion: 1,
      objectKey: artifact.id,
      digest: artifact.digest,
      byteLength: artifact.byteLength,
      contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE
    }),
    artifact
  });
}

function objectKeyMatchesScope(
  objectKey: string,
  tenantId: string,
  projectId: string,
  runId: string,
  digest: string
): boolean {
  const hashedScope = [tenantId, projectId, runId]
    .map((value) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24))
    .join("/");
  const suffix = `cas/v1/${hashedScope}/${digest.slice(0, 2)}/${digest}`;
  if (objectKey === suffix) return true;
  const prefix = objectKey.slice(0, -(suffix.length + 1));
  return /^[a-f0-9]{24}$/u.test(prefix) && objectKey === `${prefix}/${suffix}`;
}
