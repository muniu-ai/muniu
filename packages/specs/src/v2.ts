// SPDX-License-Identifier: Apache-2.0

import {
  canonicalFrozenClone,
  sha256Digest
} from "./canonical.js";
import type {
  AcceptanceCase,
  CreateSpecRevisionV2Input,
  SpecRevisionV2,
  SpecValidationIssue,
  SpecValidationResult
} from "./types.js";
import { isStrictTimestamp } from "./validation.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const STATUSES = new Set(["draft", "approved", "superseded"]);
const ACCEPTANCE_KINDS = new Set(["positive", "negative", "boundary"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const ACCEPTANCE_FIELDS = new Set(["id", "kind", "title", "given", "when", "then", "targetService"]);
const RISK_FIELDS = new Set(["id", "level", "description", "mitigation"]);
const UNKNOWN_FIELDS = new Set(["id", "description", "owner", "resolutionCriteria"]);
const FIELDS = new Set([
  "schemaVersion",
  "specSetId",
  "revision",
  "status",
  "domainId",
  "subjectRefs",
  "title",
  "objective",
  "outcomes",
  "nonGoals",
  "contracts",
  "acceptanceCases",
  "risks",
  "unknowns",
  "domainExtension",
  "createdAt",
  "createdBy",
  "approvedAt",
  "approvedBy",
  "previousDigest",
  "digest"
]);
const INPUT_FIELDS = new Set([...FIELDS].filter((field) => field !== "schemaVersion" && field !== "digest"));
const CONTRACT_FIELDS = [
  "interface",
  "data",
  "state",
  "permission",
  "exception",
  "quality",
  "observability"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function issue(
  issues: SpecValidationIssue[],
  path: string,
  code: SpecValidationIssue["code"],
  message: string
): void {
  issues.push({ path, code, message });
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(
  value: unknown,
  path: string,
  issues: SpecValidationIssue[],
  minimum: number
): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "invalid_type", `${path} must be an array`);
    return;
  }
  if (value.length < minimum) issue(issues, path, "required", `${path} is incomplete`);
  value.forEach((item, index) => {
    if (!nonEmptyString(item)) issue(issues, `${path}[${index}]`, "invalid_value", `${path} contains an empty value`);
  });
}

function validateSubjectRefs(value: unknown, issues: SpecValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, "subjectRefs", "required", "subjectRefs must contain at least one reference");
    return;
  }
  const identities = new Set<string>();
  value.forEach((item, index) => {
    const path = `subjectRefs[${index}]`;
    if (!isRecord(item)) {
      issue(issues, path, "invalid_type", `${path} must be a record`);
      return;
    }
    if (Object.keys(item).some((key) => !["kind", "id", "digest"].includes(key))) {
      issue(issues, path, "invalid_value", `${path} contains unsupported fields`);
    }
    if (!identifier(item.kind)) issue(issues, `${path}.kind`, "invalid_value", `${path}.kind is invalid`);
    if (!identifier(item.id)) issue(issues, `${path}.id`, "invalid_value", `${path}.id is invalid`);
    if (!digest(item.digest)) issue(issues, `${path}.digest`, "invalid_value", `${path}.digest is invalid`);
    if (identifier(item.kind) && identifier(item.id)) {
      const identity = `${item.kind}:${item.id}`;
      if (identities.has(identity)) issue(issues, path, "duplicate", `duplicate subject reference ${identity}`);
      identities.add(identity);
    }
  });
}

function validateContracts(value: unknown, issues: SpecValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, "contracts", "invalid_type", "contracts must be a record");
    return;
  }
  for (const field of CONTRACT_FIELDS) {
    if (!isRecord(value[field])) issue(issues, `contracts.${field}`, "required", `contracts.${field} must be a record`);
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    issue(issues, "contracts.metadata", "invalid_type", "contracts.metadata must be a record");
  }
  if (Object.keys(value).some((key) => ![...CONTRACT_FIELDS, "metadata"].includes(key as typeof CONTRACT_FIELDS[number] | "metadata"))) {
    issue(issues, "contracts", "invalid_value", "contracts contains unsupported fields");
  }
}

function validateAcceptance(value: unknown, issues: SpecValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, "acceptanceCases", "required", "acceptanceCases must contain at least one case");
    return;
  }
  const identities = new Set<string>();
  value.forEach((candidate, index) => {
    const item = candidate as AcceptanceCase;
    const path = `acceptanceCases[${index}]`;
    if (!isRecord(candidate)) {
      issue(issues, path, "invalid_type", `${path} must be a record`);
      return;
    }
    if (Object.keys(candidate).some((key) => !ACCEPTANCE_FIELDS.has(key))) {
      issue(issues, path, "invalid_value", `${path} contains unsupported fields`);
    }
    if (!identifier(item.id)) issue(issues, `${path}.id`, "invalid_value", `${path}.id is invalid`);
    if (identifier(item.id)) {
      if (identities.has(item.id)) issue(issues, `${path}.id`, "duplicate", `duplicate acceptance case ${item.id}`);
      identities.add(item.id);
    }
    if (!ACCEPTANCE_KINDS.has(item.kind)) issue(issues, `${path}.kind`, "invalid_value", `${path}.kind is invalid`);
    if (!nonEmptyString(item.title)) issue(issues, `${path}.title`, "required", `${path}.title is required`);
    if (!nonEmptyString(item.when)) issue(issues, `${path}.when`, "required", `${path}.when is required`);
    stringArray(item.given, `${path}.given`, issues, 1);
    stringArray(item.then, `${path}.then`, issues, 1);
    if (item.targetService !== undefined && !identifier(item.targetService)) {
      issue(issues, `${path}.targetService`, "invalid_value", `${path}.targetService is invalid`);
    }
  });
}

function validateRisks(value: unknown, issues: SpecValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, "risks", "invalid_type", "risks must be an array");
    return;
  }
  const identities = new Set<string>();
  value.forEach((candidate, index) => {
    const path = `risks[${index}]`;
    if (!isRecord(candidate)) {
      issue(issues, path, "invalid_type", `${path} must be a record`);
      return;
    }
    if (Object.keys(candidate).some((key) => !RISK_FIELDS.has(key))) {
      issue(issues, path, "invalid_value", `${path} contains unsupported fields`);
    }
    if (!identifier(candidate.id)) issue(issues, `${path}.id`, "invalid_value", `${path}.id is invalid`);
    if (identifier(candidate.id)) {
      if (identities.has(candidate.id)) issue(issues, `${path}.id`, "duplicate", `duplicate risk ${candidate.id}`);
      identities.add(candidate.id);
    }
    if (!RISK_LEVELS.has(candidate.level as string)) issue(issues, `${path}.level`, "invalid_value", `${path}.level is invalid`);
    if (!nonEmptyString(candidate.description)) issue(issues, `${path}.description`, "required", `${path}.description is required`);
    if (!nonEmptyString(candidate.mitigation)) issue(issues, `${path}.mitigation`, "required", `${path}.mitigation is required`);
  });
}

function validateUnknowns(value: unknown, issues: SpecValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, "unknowns", "invalid_type", "unknowns must be an array");
    return;
  }
  const identities = new Set<string>();
  value.forEach((candidate, index) => {
    const path = `unknowns[${index}]`;
    if (!isRecord(candidate)) {
      issue(issues, path, "invalid_type", `${path} must be a record`);
      return;
    }
    if (Object.keys(candidate).some((key) => !UNKNOWN_FIELDS.has(key))) {
      issue(issues, path, "invalid_value", `${path} contains unsupported fields`);
    }
    if (!identifier(candidate.id)) issue(issues, `${path}.id`, "invalid_value", `${path}.id is invalid`);
    if (identifier(candidate.id)) {
      if (identities.has(candidate.id)) issue(issues, `${path}.id`, "duplicate", `duplicate unknown ${candidate.id}`);
      identities.add(candidate.id);
    }
    for (const field of ["description", "owner", "resolutionCriteria"] as const) {
      if (!nonEmptyString(candidate[field])) issue(issues, `${path}.${field}`, "required", `${path}.${field} is required`);
    }
  });
}

export function digestSpecRevisionV2(
  revision: SpecRevisionV2 | Omit<SpecRevisionV2, "digest">
): string {
  const { digest: _digest, ...unsigned } = revision as SpecRevisionV2;
  return sha256Digest(unsigned);
}

export function validateSpecRevisionV2(value: unknown): SpecValidationResult {
  const issues: SpecValidationIssue[] = [];
  try {
    value = canonicalFrozenClone(value);
  } catch {
    return {
      valid: false,
      issues: [{ path: "$", code: "invalid_value", message: "SpecRevisionV2 must be canonical JSON without accessors" }]
    };
  }
  if (!isRecord(value)) return { valid: false, issues: [{ path: "$", code: "invalid_type", message: "SpecRevisionV2 must be a record" }] };
  for (const field of Object.keys(value)) {
    if (!FIELDS.has(field)) issue(issues, field, "invalid_value", `${field} is not supported`);
  }
  if (value.schemaVersion !== 2) issue(issues, "schemaVersion", "invalid_value", "schemaVersion must be 2");
  if (!identifier(value.specSetId)) issue(issues, "specSetId", "invalid_value", "specSetId is invalid");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) issue(issues, "revision", "invalid_value", "revision is invalid");
  if (!STATUSES.has(value.status as string)) issue(issues, "status", "invalid_value", "status is invalid");
  if (!identifier(value.domainId)) issue(issues, "domainId", "invalid_value", "domainId is invalid");
  validateSubjectRefs(value.subjectRefs, issues);
  for (const field of ["title", "objective", "createdBy"] as const) {
    if (!nonEmptyString(value[field])) issue(issues, field, "required", `${field} is required`);
  }
  stringArray(value.outcomes, "outcomes", issues, 1);
  stringArray(value.nonGoals, "nonGoals", issues, 0);
  validateContracts(value.contracts, issues);
  validateAcceptance(value.acceptanceCases, issues);
  validateRisks(value.risks, issues);
  validateUnknowns(value.unknowns, issues);
  if (!isStrictTimestamp(value.createdAt)) issue(issues, "createdAt", "invalid_value", "createdAt must be strict RFC3339");

  const approved = value.status === "approved" || value.status === "superseded";
  const hasApprovedAt = value.approvedAt !== undefined;
  const hasApprovedBy = value.approvedBy !== undefined;
  if ((approved && !(hasApprovedAt && hasApprovedBy))
    || (!approved && (hasApprovedAt || hasApprovedBy))) {
    issue(issues, "status", "invalid_value", "approval metadata must match status");
  }
  if (hasApprovedAt && !isStrictTimestamp(value.approvedAt)) issue(issues, "approvedAt", "invalid_value", "approvedAt must be strict RFC3339");
  if (hasApprovedBy && !identifier(value.approvedBy)) issue(issues, "approvedBy", "invalid_value", "approvedBy is invalid");
  if (isStrictTimestamp(value.createdAt) && isStrictTimestamp(value.approvedAt)
    && Date.parse(value.approvedAt) < Date.parse(value.createdAt)) {
    issue(issues, "approvedAt", "invalid_value", "approvedAt must not precede createdAt");
  }

  const revision = Number(value.revision);
  if ((revision === 1 && value.previousDigest !== undefined)
    || (revision > 1 && !digest(value.previousDigest))) {
    issue(issues, "previousDigest", "invalid_value", "previousDigest must match the revision lineage");
  }
  if (!digest(value.digest)) {
    issue(issues, "digest", "invalid_value", "digest must be a lowercase SHA-256 digest");
  } else {
    try {
      if (digestSpecRevisionV2(value as unknown as SpecRevisionV2) !== value.digest) {
        issue(issues, "digest", "digest_mismatch", "digest does not match SpecRevisionV2 content");
      }
    } catch {
      issue(issues, "digest", "invalid_value", "SpecRevisionV2 content is not canonical JSON");
    }
  }
  return { valid: issues.length === 0, issues };
}

export function createSpecRevisionV2(input: CreateSpecRevisionV2Input): SpecRevisionV2 {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !INPUT_FIELDS.has(key)) {
      throw new TypeError(`SpecRevisionV2 input field ${String(key)} is not supported`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`SpecRevisionV2 input field ${key} must not be an accessor`);
    }
  }
  const unsigned = canonicalFrozenClone({
    schemaVersion: 2 as const,
    specSetId: input.specSetId,
    revision: input.revision,
    status: input.status,
    domainId: input.domainId,
    subjectRefs: input.subjectRefs,
    title: input.title,
    objective: input.objective,
    outcomes: input.outcomes,
    nonGoals: input.nonGoals,
    contracts: input.contracts,
    acceptanceCases: input.acceptanceCases,
    risks: input.risks,
    unknowns: input.unknowns,
    ...(input.domainExtension === undefined ? {} : { domainExtension: input.domainExtension }),
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    ...(input.approvedAt === undefined ? {} : { approvedAt: input.approvedAt }),
    ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
    ...(input.previousDigest === undefined ? {} : { previousDigest: input.previousDigest })
  });
  const revision = canonicalFrozenClone({ ...unsigned, digest: digestSpecRevisionV2(unsigned) });
  const result = validateSpecRevisionV2(revision);
  if (!result.valid) {
    throw new TypeError(`Invalid SpecRevisionV2: ${result.issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  }
  return revision;
}
