import type { AgentTask } from "./types.js";
import type { VersionedGovernanceRef } from "@mn/governance";

export const CLASSIC_WORKFLOW_REF: Readonly<VersionedGovernanceRef> = Object.freeze({
  id: "classic-v1",
  version: "1",
  // SHA-256 of the canonical builtin workflow identity {id, version}.
  digest: "0ed2b39284ffdd24df8d01f74135b8c6db07b43e6ce0f13f792d5459ad0ae8e0"
});

export const GOVERNED_INCREMENT_WORKFLOW_REF: Readonly<VersionedGovernanceRef> =
  Object.freeze({
    id: "governed-increment-v1",
    version: "1",
    // SHA-256 of the complete immutable governed workflow definition.
    digest: "4a97b059493fb3c482bd92a074b68b8a9e37c79543813d1ee49b60571cdd734f"
  });

function isNonEmptyTrimmed(value: string): boolean {
  return value.length > 0 && value === value.trim();
}

function validateVersionedRef(
  ref: VersionedGovernanceRef,
  field: string,
  errors: string[]
): void {
  if (!isNonEmptyTrimmed(ref.id)) {
    errors.push(`${field}.id must be a non-empty trimmed string`);
  }
  if (!isNonEmptyTrimmed(ref.version)) {
    errors.push(`${field}.version must be a non-empty trimmed string`);
  }
  if (!/^[a-f0-9]{64}$/.test(ref.digest)) {
    errors.push(`${field}.digest must be a lowercase SHA-256 digest`);
  }
}

export function resolveTaskWorkflowRef(
  task: Pick<AgentTask, "specRef" | "workflowRef">
): Readonly<VersionedGovernanceRef> {
  if (task.workflowRef !== undefined) {
    return Object.freeze({ ...task.workflowRef });
  }
  return task.specRef === undefined
    ? CLASSIC_WORKFLOW_REF
    : GOVERNED_INCREMENT_WORKFLOW_REF;
}

export function isGovernedTask(
  task: Pick<AgentTask, "specRef" | "workflowRef">
): boolean {
  return resolveTaskWorkflowRef(task).id !== CLASSIC_WORKFLOW_REF.id;
}

/**
 * Runtime guard used at API/store boundaries. It deliberately leaves all
 * legacy prompt + acceptanceCriteria tasks valid and fail-closes malformed
 * governed references.
 */
export function validateTaskWorkflowBindings(
  task: Pick<AgentTask, "specRef" | "workflowRef" | "harnessProfileRef">
): string[] {
  const errors: string[] = [];
  if (task.specRef !== undefined) {
    if (!isNonEmptyTrimmed(task.specRef.specSetId)) {
      errors.push("specRef.specSetId must be a non-empty trimmed string");
    }
    if (!Number.isSafeInteger(task.specRef.revision) || task.specRef.revision < 1) {
      errors.push("specRef.revision must be a positive safe integer");
    }
    if (!/^[a-f0-9]{64}$/.test(task.specRef.digest)) {
      errors.push("specRef.digest must be a lowercase SHA-256 digest");
    }
  }
  if (task.workflowRef !== undefined) {
    validateVersionedRef(task.workflowRef, "workflowRef", errors);
  }
  if (task.harnessProfileRef !== undefined) {
    validateVersionedRef(task.harnessProfileRef, "harnessProfileRef", errors);
  }

  const workflow = resolveTaskWorkflowRef(task);
  if (workflow.id === GOVERNED_INCREMENT_WORKFLOW_REF.id && task.specRef === undefined) {
    errors.push("governed-increment-v1 requires specRef");
  }
  return errors;
}
