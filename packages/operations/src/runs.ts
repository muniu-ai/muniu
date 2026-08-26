// SPDX-License-Identifier: Apache-2.0

import type {
  OperationBindingExpectationV1,
  OperationRunV1,
  SubjectRefV1,
  VersionedDigestRefV1
} from "./types.js";
import {
  canonicalFrozenClone,
  requireDigest,
  requireIdentifier,
  requireTimestamp
} from "./shared.js";

export interface CreateOperationRunInput {
  readonly id: string;
  readonly tenantId: string;
  readonly domainId: string;
  readonly subjectRefs: readonly SubjectRefV1[];
  readonly specRef: VersionedDigestRefV1;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly domainModuleRef: VersionedDigestRefV1;
  readonly workflowRef: VersionedDigestRefV1;
  readonly currentStage: string;
  readonly budgetUsage?: Readonly<Record<string, number>>;
  readonly createdAt: string;
}

export interface ResumeOperationRunInput {
  readonly updatedAt: string;
  readonly expected: OperationBindingExpectationV1;
}

function digestRef(value: VersionedDigestRefV1, field: string): VersionedDigestRefV1 {
  return {
    id: requireIdentifier(value.id, `${field}.id`),
    version: requireIdentifier(value.version, `${field}.version`),
    digest: requireDigest(value.digest, `${field}.digest`)
  };
}

function subjectRefs(values: readonly SubjectRefV1[]): readonly SubjectRefV1[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("subjectRefs must contain at least one reference");
  }
  const result = values.map((value, index) => ({
    kind: requireIdentifier(value.kind, `subjectRefs[${index}].kind`),
    id: requireIdentifier(value.id, `subjectRefs[${index}].id`),
    digest: requireDigest(value.digest, `subjectRefs[${index}].digest`)
  }));
  const keys = result.map((value) => `${value.kind}:${value.id}`);
  if (new Set(keys).size !== keys.length) throw new TypeError("subjectRefs contains duplicates");
  return result;
}

function budgetUsage(value: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value ?? {})) {
    requireIdentifier(key, `budgetUsage.${key}`);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new TypeError(`budgetUsage.${key} must be a non-negative finite number`);
    }
    result[key] = amount;
  }
  return result;
}

export function createOperationRun(input: CreateOperationRunInput): OperationRunV1 {
  const createdAt = requireTimestamp(input.createdAt, "createdAt");
  return canonicalFrozenClone({
    schemaVersion: 1,
    id: requireIdentifier(input.id, "id"),
    tenantId: requireIdentifier(input.tenantId, "tenantId"),
    domainId: requireIdentifier(input.domainId, "domainId"),
    subjectRefs: subjectRefs(input.subjectRefs),
    specRef: digestRef(input.specRef, "specRef"),
    governanceDigest: requireDigest(input.governanceDigest, "governanceDigest"),
    harnessDigest: requireDigest(input.harnessDigest, "harnessDigest"),
    domainModuleRef: digestRef(input.domainModuleRef, "domainModuleRef"),
    workflowRef: digestRef(input.workflowRef, "workflowRef"),
    generation: 1,
    status: "queued",
    currentStage: requireIdentifier(input.currentStage, "currentStage"),
    budgetUsage: budgetUsage(input.budgetUsage),
    createdAt,
    updatedAt: createdAt
  });
}

export function resumeOperationRun(
  current: OperationRunV1,
  input: ResumeOperationRunInput
): OperationRunV1 {
  if (current.status === "completed" || current.status === "cancelled") {
    throw new Error(`cannot resume terminal operation run ${current.status}`);
  }
  if (current.generation >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("operation generation cannot exceed Number.MAX_SAFE_INTEGER");
  }
  const expected = input.expected;
  const actual = [
    current.specRef.digest,
    current.governanceDigest,
    current.harnessDigest,
    current.domainModuleRef.digest,
    current.workflowRef.digest
  ];
  const supplied = [
    requireDigest(expected.specDigest, "expected.specDigest"),
    requireDigest(expected.governanceDigest, "expected.governanceDigest"),
    requireDigest(expected.harnessDigest, "expected.harnessDigest"),
    requireDigest(expected.domainModuleDigest, "expected.domainModuleDigest"),
    requireDigest(expected.workflowDigest, "expected.workflowDigest")
  ];
  if (actual.some((digest, index) => digest !== supplied[index])) {
    throw new Error("immutable operation binding changed");
  }
  const updatedAt = requireTimestamp(input.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw new TypeError("updatedAt must not precede the current operation state");
  }
  return canonicalFrozenClone({
    ...current,
    generation: current.generation + 1,
    status: "queued" as const,
    updatedAt
  });
}
