import { canonicalJson, digestSpecRevision } from "./canonical.js";
import { isSafeSpecSetId } from "./fileUtils.js";
import type {
  SpecRevision,
  SpecValidationIssue,
  SpecValidationResult
} from "./types.js";

const SPEC_STATUSES = new Set([
  "draft",
  "in_review",
  "approved",
  "rejected",
  "superseded"
]);
const SPEC_SOURCES = new Set(["native", "legacy", "spec-kit"]);
const ACCEPTANCE_KINDS = new Set(["positive", "negative", "boundary"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const CONTRACT_DIMENSIONS = [
  "interface",
  "data",
  "state",
  "permission",
  "exception",
  "quality",
  "observability"
] as const;
const SPEC_REVISION_FIELDS = new Set([
  "specSetId",
  "revision",
  "status",
  "source",
  "title",
  "hypothesis",
  "outcomes",
  "nonGoals",
  "targetServices",
  "contracts",
  "acceptanceCases",
  "risks",
  "unknowns",
  "createdAt",
  "createdBy",
  "approvedAt",
  "approvedBy",
  "digest"
]);
const CONTRACT_FIELDS = new Set([...CONTRACT_DIMENSIONS, "metadata"]);
const ACCEPTANCE_FIELDS = new Set([
  "id",
  "kind",
  "title",
  "given",
  "when",
  "then",
  "targetService"
]);
const RISK_FIELDS = new Set(["id", "level", "description", "mitigation"]);
const UNKNOWN_FIELDS = new Set([
  "id",
  "description",
  "owner",
  "resolutionCriteria"
]);

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/u;

export function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === "Z" ? 0 : Number(match[8]);
  const offsetMinute = match[7] === "Z" ? 0 : Number(match[9]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: SpecValidationIssue[],
  path: string,
  code: SpecValidationIssue["code"],
  message: string
): void {
  issues.push({ path, code, message });
}

function validateKnownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: SpecValidationIssue[]
): void {
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      const fieldPath = path === "$" ? field : `${path}.${field}`;
      addIssue(
        issues,
        fieldPath,
        "invalid_value",
        `${fieldPath} is not a supported field`
      );
    }
  }
}

function validateRequiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: SpecValidationIssue[]
): void {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, path, "required", `${path} must be a non-empty string`);
  }
}

function validateIdentityString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: SpecValidationIssue[]
): void {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    addIssue(
      issues,
      path,
      "invalid_value",
      `${path} must be a non-empty trimmed identity string`
    );
  }
}

function validateDateString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: SpecValidationIssue[],
  required: boolean
): void {
  const value = record[key];
  if (value === undefined && !required) {
    return;
  }
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !isStrictTimestamp(value)
  ) {
    addIssue(issues, path, required ? "required" : "invalid_value", `${path} must be an ISO date string`);
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: SpecValidationIssue[],
  minimumLength: number
): void {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", `${path} must be an array`);
    return;
  }
  if (value.length < minimumLength) {
    addIssue(
      issues,
      path,
      "required",
      `${path} must contain at least ${minimumLength} item(s)`
    );
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      addIssue(
        issues,
        `${path}[${index}]`,
        "invalid_value",
        `${path}[${index}] must be a non-empty string`
      );
    }
  });
}

function validateIdentityStringArray(
  value: unknown,
  path: string,
  issues: SpecValidationIssue[]
): void {
  validateStringArray(value, path, issues, 0);
  if (!Array.isArray(value)) return;
  const identities = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string") return;
    const identity = item.trim();
    if (identity.length === 0 || item !== identity) {
      addIssue(
        issues,
        `${path}[${index}]`,
        "invalid_value",
        `${path}[${index}] must be a trimmed identity string`
      );
    }
    if (identity.length > 0 && identities.has(identity)) {
      addIssue(
        issues,
        `${path}[${index}]`,
        "duplicate",
        `${path} contains duplicate identity ${identity}`
      );
    }
    identities.add(identity);
  });
}

function validateContracts(
  value: unknown,
  issues: SpecValidationIssue[]
): void {
  if (!isRecord(value)) {
    addIssue(
      issues,
      "contracts",
      "invalid_type",
      "contracts must be a structured record"
    );
    return;
  }

  validateKnownFields(value, CONTRACT_FIELDS, "contracts", issues);

  for (const dimension of CONTRACT_DIMENSIONS) {
    if (!isRecord(value[dimension])) {
      addIssue(
        issues,
        `contracts.${dimension}`,
        "required",
        `contracts.${dimension} must be a structured record`
      );
    }
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    addIssue(
      issues,
      "contracts.metadata",
      "invalid_type",
      "contracts.metadata must be a structured record when provided"
    );
  }
}

function validateAcceptanceCases(
  value: unknown,
  issues: SpecValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      "acceptanceCases",
      "invalid_type",
      "acceptanceCases must be an array"
    );
    return;
  }
  if (value.length === 0) {
    addIssue(
      issues,
      "acceptanceCases",
      "required",
      "acceptanceCases must contain at least one case"
    );
  }

  const identifiers = new Set<string>();
  value.forEach((item, index) => {
    const path = `acceptanceCases[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, path, "invalid_type", `${path} must be a record`);
      return;
    }
    validateKnownFields(item, ACCEPTANCE_FIELDS, path, issues);
    validateIdentityString(item, "id", `${path}.id`, issues);
    validateRequiredString(item, "title", `${path}.title`, issues);
    validateRequiredString(item, "when", `${path}.when`, issues);
    validateStringArray(item.given, `${path}.given`, issues, 1);
    validateStringArray(item.then, `${path}.then`, issues, 1);

    if (typeof item.kind !== "string" || !ACCEPTANCE_KINDS.has(item.kind)) {
      addIssue(
        issues,
        `${path}.kind`,
        "invalid_value",
        `${path}.kind must be positive, negative, or boundary`
      );
    }

    if (typeof item.id === "string" && item.id.trim().length > 0) {
      const identity = item.id.trim();
      if (identifiers.has(identity)) {
        addIssue(
          issues,
          `${path}.id`,
          "duplicate",
          `Acceptance id ${item.id} is duplicated`
        );
      }
      identifiers.add(identity);
    }

    if (
      item.targetService !== undefined &&
      (typeof item.targetService !== "string" ||
        item.targetService.trim().length === 0 ||
        item.targetService !== item.targetService.trim())
    ) {
      addIssue(
        issues,
        `${path}.targetService`,
        "invalid_value",
        `${path}.targetService must be a non-empty string when provided`
      );
    }
  });
}

function validateRisks(value: unknown, issues: SpecValidationIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, "risks", "invalid_type", "risks must be an array");
    return;
  }

  const identifiers = new Set<string>();
  value.forEach((item, index) => {
    const path = `risks[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, path, "invalid_type", `${path} must be a record`);
      return;
    }
    validateKnownFields(item, RISK_FIELDS, path, issues);
    validateIdentityString(item, "id", `${path}.id`, issues);
    validateRequiredString(item, "description", `${path}.description`, issues);
    validateRequiredString(item, "mitigation", `${path}.mitigation`, issues);
    if (typeof item.level !== "string" || !RISK_LEVELS.has(item.level)) {
      addIssue(
        issues,
        `${path}.level`,
        "invalid_value",
        `${path}.level must be low, medium, high, or critical`
      );
    }
    if (typeof item.id === "string" && item.id.trim().length > 0) {
      const identity = item.id.trim();
      if (identifiers.has(identity)) {
        addIssue(
          issues,
          `${path}.id`,
          "duplicate",
          `Risk id ${item.id} is duplicated`
        );
      }
      identifiers.add(identity);
    }
  });
}

function validateUnknowns(value: unknown, issues: SpecValidationIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, "unknowns", "invalid_type", "unknowns must be an array");
    return;
  }

  const identifiers = new Set<string>();
  value.forEach((item, index) => {
    const path = `unknowns[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, path, "invalid_type", `${path} must be a record`);
      return;
    }
    validateKnownFields(item, UNKNOWN_FIELDS, path, issues);
    validateIdentityString(item, "id", `${path}.id`, issues);
    validateRequiredString(item, "description", `${path}.description`, issues);
    validateIdentityString(item, "owner", `${path}.owner`, issues);
    validateRequiredString(
      item,
      "resolutionCriteria",
      `${path}.resolutionCriteria`,
      issues
    );
    if (typeof item.id === "string" && item.id.trim().length > 0) {
      const identity = item.id.trim();
      if (identifiers.has(identity)) {
        addIssue(
          issues,
          `${path}.id`,
          "duplicate",
          `Unknown id ${item.id} is duplicated`
        );
      }
      identifiers.add(identity);
    }
  });
}

export function validateSpecRevision(input: unknown): SpecValidationResult {
  const issues: SpecValidationIssue[] = [];
  let value: unknown;
  try {
    // Clone through the descriptor-aware canonical serializer before reading
    // any field. Public validators receive untrusted values and must never
    // execute accessors or retain mutable aliases supplied by callers.
    value = JSON.parse(canonicalJson(input)) as unknown;
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          path: "$",
          code: "invalid_value",
          message: `Revision must contain canonical JSON values: ${
            error instanceof Error ? error.message : String(error)
          }`
        }
      ]
    };
  }
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [
        {
          path: "$",
          code: "invalid_type",
          message: "Spec revision must be a record"
        }
      ]
    };
  }

  validateKnownFields(value, SPEC_REVISION_FIELDS, "$", issues);

  validateRequiredString(value, "specSetId", "specSetId", issues);
  if (
    typeof value.specSetId === "string" &&
    !isSafeSpecSetId(value.specSetId)
  ) {
    addIssue(
      issues,
      "specSetId",
      "invalid_value",
      "specSetId must be a repository-safe identifier"
    );
  }
  validateRequiredString(value, "title", "title", issues);
  validateRequiredString(value, "hypothesis", "hypothesis", issues);
  validateIdentityString(value, "createdBy", "createdBy", issues);
  validateDateString(value, "createdAt", "createdAt", issues, true);

  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    addIssue(
      issues,
      "revision",
      "invalid_value",
      "revision must be a positive safe integer"
    );
  }
  if (typeof value.status !== "string" || !SPEC_STATUSES.has(value.status)) {
    addIssue(issues, "status", "invalid_value", "status is not supported");
  }
  if (typeof value.source !== "string" || !SPEC_SOURCES.has(value.source)) {
    addIssue(issues, "source", "invalid_value", "source is not supported");
  }

  validateStringArray(value.outcomes, "outcomes", issues, 1);
  validateStringArray(value.nonGoals, "nonGoals", issues, 1);
  validateIdentityStringArray(value.targetServices, "targetServices", issues);
  validateContracts(value.contracts, issues);
  validateAcceptanceCases(value.acceptanceCases, issues);
  validateRisks(value.risks, issues);
  validateUnknowns(value.unknowns, issues);

  if (value.status === "approved") {
    validateIdentityString(value, "approvedBy", "approvedBy", issues);
    validateDateString(value, "approvedAt", "approvedAt", issues, true);
    validateRequiredString(value, "digest", "digest", issues);
    if (
      typeof value.approvedAt === "string" &&
      typeof value.createdAt === "string" &&
      !Number.isNaN(Date.parse(value.approvedAt)) &&
      !Number.isNaN(Date.parse(value.createdAt)) &&
      Date.parse(value.approvedAt) < Date.parse(value.createdAt)
    ) {
      addIssue(
        issues,
        "approvedAt",
        "invalid_value",
        "approvedAt must be at or after createdAt"
      );
    }
  } else {
    if (value.approvedAt !== undefined || value.approvedBy !== undefined) {
      addIssue(
        issues,
        "approvedAt",
        "invalid_value",
        "approval metadata is only allowed on approved revisions"
      );
    }
  }

  if (value.digest !== undefined) {
    if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) {
      addIssue(
        issues,
        "digest",
        "invalid_value",
        "digest must be a lowercase SHA-256 hex value"
      );
    } else {
      try {
        const expected = digestSpecRevision(value as unknown as SpecRevision);
        if (value.digest !== expected) {
          addIssue(
            issues,
            "digest",
            "digest_mismatch",
            "digest does not match the canonical revision content"
          );
        }
      } catch (error) {
        addIssue(
          issues,
          "digest",
          "invalid_value",
          `Revision cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
