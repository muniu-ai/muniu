// SPDX-License-Identifier: Apache-2.0

import type { AgentTask, Project, RunRecord } from "@mn/core";
import type { GovernedRunState } from "@mn/loop";

import type { EnterpriseClaimSnapshot } from "./enterprisePostgres.js";

export interface EnterpriseClaimExecutionState {
  readonly run: RunRecord;
  readonly project?: Project;
  readonly task?: AgentTask;
  readonly governedLoopState?: GovernedRunState;
}

/**
 * Resolves the current execution read model from the PostgreSQL-authenticated
 * claim payload. This is the cross-replica authority for worker routes; an
 * API process's startup snapshot may legitimately predate another replica's
 * latest checkpoint.
 */
export function executionStateFromEnterpriseClaim(
  claim: EnterpriseClaimSnapshot
): EnterpriseClaimExecutionState {
  const run = objectRecord(claim.payload.run, "run") as unknown as RunRecord;
  if (
    run.id !== claim.item.runId ||
    run.projectId !== claim.item.projectId ||
    run.taskId !== claim.item.taskId ||
    (run.tenantId !== undefined && run.tenantId !== claim.item.tenantId)
  ) {
    throw new TypeError("enterprise claim Run binding is invalid");
  }

  const governedLoopState = optionalObjectRecord(
    claim.payload.governedResumeState,
    "governedResumeState"
  ) as unknown as GovernedRunState | undefined;
  if (governedLoopState && governedLoopState.runId !== run.id) {
    throw new TypeError("enterprise claim governed Loop binding is invalid");
  }

  const context = optionalObjectRecord(claim.payload.executionContext, "executionContext");
  if (!context) {
    return {
      run,
      ...(governedLoopState ? { governedLoopState } : {})
    };
  }
  const bindings = objectRecord(context.bindings, "executionContext.bindings");
  if (
    bindings.tenantId !== claim.item.tenantId ||
    bindings.runId !== run.id ||
    bindings.projectId !== run.projectId ||
    bindings.taskId !== run.taskId
  ) {
    throw new TypeError("enterprise claim execution context binding is invalid");
  }
  const project = objectRecord(context.project, "executionContext.project") as unknown as Project;
  const task = objectRecord(context.task, "executionContext.task") as unknown as AgentTask;
  if (
    project.id !== run.projectId ||
    task.id !== run.taskId ||
    task.projectId !== project.id ||
    (project.tenantId !== undefined && project.tenantId !== claim.item.tenantId) ||
    (task.tenantId !== undefined && task.tenantId !== claim.item.tenantId)
  ) {
    throw new TypeError("enterprise claim Project or Task binding is invalid");
  }
  return {
    run,
    project,
    task,
    ...(governedLoopState ? { governedLoopState } : {})
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`enterprise claim ${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function optionalObjectRecord(
  value: unknown,
  label: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return objectRecord(value, label);
}
