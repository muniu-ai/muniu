import {
  createHash,
  createPublicKey,
  verify
} from "node:crypto";
import { canonicalJson, deepFreeze } from "./canonical.js";
import {
  comparePackVersions,
  createPackLock,
  isValidPackVersion,
  validatePackLock
} from "./packLock.js";
import {
  APPROVAL_MODE_ORDER,
  GOVERNANCE_SCOPE_ORDER
} from "./types.js";
import { isStrictRfc3339Timestamp as isStrictTimestamp } from "./timestamp.js";
import type {
  GovernanceBudgetField,
  PackLock,
  PackLockEntry,
  StandardPackManifest,
  StandardPackSignature
} from "./types.js";
import type {
  PublicKey,
  RegistryKeyStatus,
  RegistryEntry,
  RegistryIndex,
  RegistryIssue,
  ReleaseMetadata,
  ReleaseVerification,
  StandardPackValidationResult,
  SyncPlan,
  SyncPlanDiff,
  SyncPlanEntry,
  SyncPlanStatus,
  TrustProfile
} from "./registryTypes.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const EXECUTABLE_FIELD_NAMES = new Set([
  "code",
  "command",
  "commands",
  "entrypoint",
  "execute",
  "executable",
  "executor",
  "handler",
  "hook",
  "hooks",
  "module",
  "postinstall",
  "preinstall",
  "runtime",
  "script",
  "scripts"
]);
const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "id",
  "name",
  "version",
  "description",
  "rules",
  "specTemplates",
  "architectureRules",
  "harnessProfiles",
  "workflows",
  "release",
  "signature"
]);
const RULE_FIELDS = new Set([
  "requiredGates",
  "deny",
  "protectedPaths",
  "allowedProviders",
  "commandAllowlist",
  "networkAllowlist",
  "budgets",
  "approvalMode",
  "waivableRules"
]);
const BUDGET_FIELDS = new Set<GovernanceBudgetField>([
  "maxCandidates",
  "maxDurationSeconds",
  "maxTokens",
  "maxCostUsd",
  "maxRepairAttempts",
  "maxChangedFiles",
  "maxChangedLines"
]);
const RELEASE_FIELDS = new Set([
  "sequence",
  "publishedAt",
  "expiresAt",
  "previousDigest",
  "changelog"
]);
const SIGNATURE_FIELDS = new Set(["algorithm", "keyId", "value"]);
const REGISTRY_FIELDS = new Set([
  "schemaVersion",
  "entries",
  "publicKeys",
  "revokedPublicKeyIds",
  "release"
]);
const REGISTRY_ENTRY_FIELDS = new Set([
  "manifest",
  "digest",
  "scope",
  "scopeId",
  "source"
]);
const PUBLIC_KEY_FIELDS = new Set(["id", "publicKey", "status", "retiredAt"]);
const REGISTRY_RELEASE_FIELDS = new Set([
  "schemaVersion",
  "sequence",
  "issuedAt",
  "expiresAt",
  "registryDigest",
  "signature"
]);
const TRUST_PROFILE_FIELDS = new Set([
  "id",
  "requireSignature",
  "requireReleaseMetadata",
  "requireReleaseSignature",
  "trustedPublicKeys",
  "revokedPublicKeyIds",
  "minimumReleaseSequence",
  "verificationTime"
]);
const COUNT_BUDGET_FIELDS = new Set<GovernanceBudgetField>([
  "maxCandidates",
  "maxDurationSeconds",
  "maxTokens",
  "maxRepairAttempts",
  "maxChangedFiles",
  "maxChangedLines"
]);
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function strictCanonicalJson(value: unknown): string {
  return canonicalJson(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutSignature(manifest: StandardPackManifest): Record<string, unknown> {
  const normalized = JSON.parse(strictCanonicalJson(manifest)) as unknown;
  if (!isPlainObject(normalized)) {
    throw new TypeError("Standard pack manifest must be a plain object");
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (key !== "signature") payload[key] = value;
  }
  return payload;
}

export function standardPackSignaturePayload(
  manifest: StandardPackManifest
): string {
  return strictCanonicalJson(withoutSignature(manifest));
}

export function hashStandardPackManifest(
  manifest: StandardPackManifest
): string {
  return sha256Text(standardPackSignaturePayload(manifest));
}

export function standardPackReleaseSignaturePayload(
  metadata: ReleaseMetadata
): string {
  const normalized = JSON.parse(strictCanonicalJson(metadata)) as unknown;
  if (!isPlainObject(normalized)) {
    throw new TypeError("Standard pack registry release metadata must be a plain object");
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (key !== "signature") payload[key] = value;
  }
  return strictCanonicalJson(payload);
}

function registrySemanticPayload(index: RegistryIndex): Record<string, unknown> {
  const entries = [...(index.entries ?? [])]
    .map((entry) => ({
      manifest: entry.manifest,
      digest: entry.digest,
      scope: entry.scope,
      scopeId: entry.scopeId,
      ...(entry.source ? { source: entry.source } : {})
    }))
    .sort((left, right) =>
      compareStrings(left.scope, right.scope) ||
      compareStrings(left.scopeId, right.scopeId) ||
      compareStrings(left.manifest.id, right.manifest.id) ||
      compareStrings(left.manifest.version, right.manifest.version) ||
      compareStrings(left.digest, right.digest) ||
      compareStrings(left.source ?? "", right.source ?? "")
    );
  const publicKeys = [...(index.publicKeys ?? [])]
    .map((key) => ({
      id: key.id,
      publicKey: key.publicKey,
      status: key.status ?? "active",
      ...(key.retiredAt ? { retiredAt: key.retiredAt } : {})
    }))
    .sort((left, right) =>
      compareStrings(left.id, right.id) ||
      compareStrings(left.publicKey, right.publicKey) ||
      compareStrings(left.status, right.status) ||
      compareStrings(left.retiredAt ?? "", right.retiredAt ?? "")
    );
  return {
    schemaVersion: index.schemaVersion,
    entries,
    publicKeys,
    revokedPublicKeyIds: [...new Set(index.revokedPublicKeyIds ?? [])].sort(
      compareStrings
    )
  };
}

export function hashRegistryIndex(index: RegistryIndex): string {
  const normalized = JSON.parse(strictCanonicalJson(index)) as RegistryIndex;
  return sha256Text(strictCanonicalJson(registrySemanticPayload(normalized)));
}

function issue(
  issues: RegistryIssue[],
  code: RegistryIssue["code"],
  message: string,
  options: Omit<RegistryIssue, "code" | "message"> = {}
): void {
  issues.push({ code, message, ...options });
}

function scanDeclarative(
  value: unknown,
  path: string,
  issues: RegistryIssue[],
  ancestors: Set<object>
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issue(issues, "NON_DECLARATIVE_VALUE", `${path} must be a finite number`, {
        path
      });
    }
    return;
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    issue(
      issues,
      "NON_DECLARATIVE_VALUE",
      `${path} contains unsupported ${typeof value} value`,
      { path }
    );
    return;
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    issue(
      issues,
      "NON_DECLARATIVE_VALUE",
      `${path} must contain only plain JSON objects`,
      { path }
    );
    return;
  }
  if (ancestors.has(value)) {
    issue(issues, "NON_DECLARATIVE_VALUE", `${path} contains a circular reference`, {
      path
    });
    return;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanDeclarative(entry, `${path}[${index}]`, issues, ancestors)
    );
  } else {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
      if (
        EXECUTABLE_FIELD_NAMES.has(normalizedKey) ||
        DANGEROUS_OBJECT_KEYS.has(key)
      ) {
        issue(
          issues,
          "EXECUTABLE_FIELD_FORBIDDEN",
          `${path}.${key} is an executable or unsafe field`,
          { path: `${path}.${key}` }
        );
      }
      scanDeclarative(child, `${path}.${key}`, issues, ancestors);
    }
  }
  ancestors.delete(value);
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: RegistryIssue[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issue(issues, "UNKNOWN_FIELD", `${path}.${key} is not supported`, {
        path: `${path}.${key}`
      });
    }
  }
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: RegistryIssue[]
): value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    issue(issues, "INVALID_MANIFEST", `${path} must be a trimmed non-empty string`, {
      path
    });
    return false;
  }
  return true;
}

function validateStringList(
  value: unknown,
  path: string,
  issues: RegistryIssue[],
  options: { allowed?: readonly string[]; allowEmpty?: boolean } = {}
): value is readonly string[] {
  if (!Array.isArray(value)) {
    issue(issues, "INVALID_MANIFEST", `${path} must be an array`, { path });
    return false;
  }
  if (!options.allowEmpty && value.length === 0) {
    issue(issues, "INVALID_MANIFEST", `${path} cannot be empty`, { path });
  }
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!validateNonEmptyString(entry, entryPath, issues)) continue;
    if (options.allowed && !options.allowed.includes(entry)) {
      issue(
        issues,
        "INVALID_MANIFEST",
        `${entryPath} has unsupported value ${entry}`,
        { path: entryPath }
      );
    }
  }
  return true;
}

function validatePolicy(value: unknown, issues: RegistryIssue[]): void {
  if (!isPlainObject(value)) {
    issue(issues, "INVALID_MANIFEST", "$.rules must be a plain object", {
      path: "$.rules"
    });
    return;
  }
  unknownFields(value, RULE_FIELDS, "$.rules", issues);
  for (const field of ["requiredGates", "deny", "protectedPaths"] as const) {
    if (value[field] !== undefined) {
      validateStringList(value[field], `$.rules.${field}`, issues, { allowEmpty: true });
    }
  }
  if (value.allowedProviders !== undefined) {
    validateStringList(value.allowedProviders, "$.rules.allowedProviders", issues, {
      allowed: ["builtin", "claude", "codex"]
    });
  }
  for (const field of ["commandAllowlist", "networkAllowlist"] as const) {
    if (value[field] !== undefined) {
      validateStringList(value[field], `$.rules.${field}`, issues);
    }
  }
  if (value.approvalMode !== undefined) {
    if (!(APPROVAL_MODE_ORDER as readonly unknown[]).includes(value.approvalMode)) {
      issue(
        issues,
        "INVALID_MANIFEST",
        "$.rules.approvalMode is unsupported",
        { path: "$.rules.approvalMode" }
      );
    }
  }
  if (value.budgets !== undefined) {
    if (!isPlainObject(value.budgets)) {
      issue(issues, "INVALID_MANIFEST", "$.rules.budgets must be an object", {
        path: "$.rules.budgets"
      });
    } else {
      for (const [field, budget] of Object.entries(value.budgets)) {
        if (!BUDGET_FIELDS.has(field as GovernanceBudgetField)) {
          issue(
            issues,
            "UNKNOWN_FIELD",
            `$.rules.budgets.${field} is unsupported`,
            { path: `$.rules.budgets.${field}` }
          );
        } else if (
          typeof budget !== "number" ||
          !Number.isFinite(budget) ||
          budget < 0 ||
          (COUNT_BUDGET_FIELDS.has(field as GovernanceBudgetField) &&
            !Number.isSafeInteger(budget))
        ) {
          issue(
            issues,
            "INVALID_MANIFEST",
            COUNT_BUDGET_FIELDS.has(field as GovernanceBudgetField)
              ? `$.rules.budgets.${field} must be a non-negative safe integer`
              : `$.rules.budgets.${field} must be a finite non-negative number`,
            { path: `$.rules.budgets.${field}` }
          );
        }
      }
    }
  }
  if (value.waivableRules !== undefined) {
    if (!Array.isArray(value.waivableRules)) {
      issue(
        issues,
        "INVALID_MANIFEST",
        "$.rules.waivableRules must be an array",
        { path: "$.rules.waivableRules" }
      );
    } else {
      value.waivableRules.forEach((target, index) => {
        const path = `$.rules.waivableRules[${index}]`;
        if (!isPlainObject(target)) {
          issue(issues, "INVALID_MANIFEST", `${path} must be an object`, { path });
          return;
        }
        unknownFields(target, new Set(["field", "value"]), path, issues);
        if (
          !["requiredGates", "deny", "protectedPaths"].includes(
            String(target.field)
          )
        ) {
          issue(issues, "INVALID_MANIFEST", `${path}.field is unsupported`, {
            path: `${path}.field`
          });
        }
        validateNonEmptyString(target.value, `${path}.value`, issues);
        if (
          ["requiredGates", "deny", "protectedPaths"].includes(
            String(target.field)
          ) &&
          typeof target.value === "string" &&
          !(
            Array.isArray(value[target.field as keyof typeof value]) &&
            (value[target.field as keyof typeof value] as unknown[]).includes(
              target.value
            )
          )
        ) {
          issue(
            issues,
            "INVALID_MANIFEST",
            `${path} must target a rule declared by the same policy layer`,
            { path }
          );
        }
      });
    }
  }
}

function validateManifestRelease(value: unknown, issues: RegistryIssue[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    issue(issues, "INVALID_MANIFEST", "$.release must be an object", {
      path: "$.release"
    });
    return;
  }
  unknownFields(value, RELEASE_FIELDS, "$.release", issues);
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) {
    issue(
      issues,
      "INVALID_MANIFEST",
      "$.release.sequence must be a positive safe integer",
      { path: "$.release.sequence" }
    );
  }
  for (const field of ["publishedAt", "expiresAt"] as const) {
    const raw = value[field];
    if (
      (field === "publishedAt" || raw !== undefined) &&
      !isStrictTimestamp(raw)
    ) {
      issue(issues, "INVALID_MANIFEST", `$.release.${field} must be a timestamp`, {
        path: `$.release.${field}`
      });
    }
  }
  if (
    value.previousDigest !== undefined &&
    (typeof value.previousDigest !== "string" || !HEX_SHA256.test(value.previousDigest))
  ) {
    issue(
      issues,
      "INVALID_MANIFEST",
      "$.release.previousDigest must be lowercase SHA-256",
      { path: "$.release.previousDigest" }
    );
  }
  if (
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) === 1 &&
    value.previousDigest !== undefined
  ) {
    issue(
      issues,
      "INVALID_MANIFEST",
      "$.release.previousDigest must be absent for sequence 1",
      { path: "$.release.previousDigest" }
    );
  }
  if (
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) > 1 &&
    value.previousDigest === undefined
  ) {
    issue(
      issues,
      "INVALID_MANIFEST",
      "$.release.previousDigest is required after sequence 1",
      { path: "$.release.previousDigest" }
    );
  }
  if (
    isStrictTimestamp(value.publishedAt) &&
    isStrictTimestamp(value.expiresAt) &&
    Date.parse(value.expiresAt) <= Date.parse(value.publishedAt)
  ) {
    issue(
      issues,
      "INVALID_MANIFEST",
      "$.release.expiresAt must be later than publishedAt",
      { path: "$.release.expiresAt" }
    );
  }
  if (value.changelog !== undefined) {
    validateNonEmptyString(value.changelog, "$.release.changelog", issues);
  }
}

function validateSignatureShape(
  value: unknown,
  path: string,
  issues: RegistryIssue[]
): value is StandardPackSignature {
  if (!isPlainObject(value)) {
    issue(issues, "INVALID_MANIFEST", `${path} must be an object`, { path });
    return false;
  }
  unknownFields(value, SIGNATURE_FIELDS, path, issues);
  if (value.algorithm !== "ed25519") {
    issue(issues, "INVALID_MANIFEST", `${path}.algorithm must be ed25519`, {
      path: `${path}.algorithm`
    });
  }
  validateNonEmptyString(value.keyId, `${path}.keyId`, issues);
  validateNonEmptyString(value.value, `${path}.value`, issues);
  return true;
}

export function validateStandardPack(value: unknown): StandardPackValidationResult {
  const issues: RegistryIssue[] = [];
  let normalized: unknown;
  try {
    normalized = JSON.parse(strictCanonicalJson(value));
  } catch (error) {
    issue(
      issues,
      "NON_DECLARATIVE_VALUE",
      error instanceof Error ? error.message : "Standard pack must be declarative JSON",
      { path: "$" }
    );
    return deepFreeze({ valid: false, issues });
  }
  scanDeclarative(normalized, "$", issues, new Set());
  if (!isPlainObject(normalized)) {
    issue(issues, "INVALID_MANIFEST", "Standard pack must be a plain object", {
      path: "$"
    });
    return deepFreeze({ valid: false, issues });
  }
  const candidate = normalized;
  unknownFields(candidate, TOP_LEVEL_FIELDS, "$", issues);
  if (candidate.schemaVersion !== 1) {
    issue(issues, "INVALID_MANIFEST", "$.schemaVersion must be 1", {
      path: "$.schemaVersion"
    });
  }
  validateNonEmptyString(candidate.id, "$.id", issues);
  validateNonEmptyString(candidate.name, "$.name", issues);
  if (validateNonEmptyString(candidate.version, "$.version", issues)) {
    if (!isValidPackVersion(candidate.version)) {
      issue(issues, "INVALID_MANIFEST", "$.version must be semantic version x.y.z", {
        path: "$.version"
      });
    }
  }
  if (candidate.description !== undefined) {
    validateNonEmptyString(candidate.description, "$.description", issues);
  }
  validatePolicy(candidate.rules, issues);
  for (const field of [
    "specTemplates",
    "architectureRules",
    "harnessProfiles",
    "workflows"
  ] as const) {
    if (candidate[field] !== undefined) {
      validateStringList(candidate[field], `$.${field}`, issues);
    }
  }
  validateManifestRelease(candidate.release, issues);
  if (candidate.signature !== undefined) {
    validateSignatureShape(candidate.signature, "$.signature", issues);
  }
  if (issues.length > 0) return deepFreeze({ valid: false, issues });
  const manifest = candidate as unknown as StandardPackManifest;
  return deepFreeze({ valid: true, issues: [], manifest });
}

function validatePublicKeyShape(
  value: unknown,
  path: string,
  issues: RegistryIssue[]
): value is PublicKey {
  if (!isPlainObject(value)) {
    issue(issues, "INVALID_REGISTRY", `${path} must be an object`, { path });
    return false;
  }
  unknownFields(value, PUBLIC_KEY_FIELDS, path, issues);
  const idValid =
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id === value.id.trim();
  const keyValid =
    typeof value.publicKey === "string" &&
    value.publicKey.trim().length > 0;
  if (!idValid) {
    issue(issues, "INVALID_REGISTRY", `${path}.id must be trimmed and non-empty`, {
      path: `${path}.id`
    });
  }
  if (!keyValid) {
    issue(
      issues,
      "INVALID_REGISTRY",
      `${path}.publicKey must be trimmed and non-empty`,
      { path: `${path}.publicKey` }
    );
  }
  const status = value.status ?? "active";
  if (!(status === "active" || status === "retired" || status === "revoked")) {
    issue(issues, "INVALID_REGISTRY", `${path}.status is unsupported`, {
      path: `${path}.status`
    });
  }
  if (status === "retired" && !isStrictTimestamp(value.retiredAt)) {
    issue(issues, "KEY_RETIRED", `${path}.retiredAt is required for a retired key`, {
      path: `${path}.retiredAt`,
      ...(idValid ? { keyId: value.id as string } : {})
    });
  } else if (value.retiredAt !== undefined && !isStrictTimestamp(value.retiredAt)) {
    issue(issues, "INVALID_REGISTRY", `${path}.retiredAt must be a timestamp`, {
      path: `${path}.retiredAt`,
      ...(idValid ? { keyId: value.id as string } : {})
    });
  }
  return idValid && keyValid;
}

function validateReleaseMetadataShape(
  value: unknown,
  issues: RegistryIssue[]
): value is ReleaseMetadata {
  if (!isPlainObject(value)) {
    issue(issues, "RELEASE_INVALID", "Registry release metadata must be an object", {
      path: "$.release"
    });
    return false;
  }
  unknownFields(value, REGISTRY_RELEASE_FIELDS, "$.release", issues);
  let valid = true;
  if (value.schemaVersion !== 1) valid = false;
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) valid = false;
  if (!isStrictTimestamp(value.issuedAt)) valid = false;
  if (value.expiresAt !== undefined && !isStrictTimestamp(value.expiresAt)) valid = false;
  if (typeof value.registryDigest !== "string" || !HEX_SHA256.test(value.registryDigest)) {
    valid = false;
  }
  if (
    isStrictTimestamp(value.issuedAt) &&
    isStrictTimestamp(value.expiresAt) &&
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  ) {
    valid = false;
  }
  if (value.signature !== undefined) {
    if (!isPlainObject(value.signature)) {
      valid = false;
    } else {
      unknownFields(value.signature, SIGNATURE_FIELDS, "$.release.signature", issues);
      if (
        value.signature.algorithm !== "ed25519" ||
        typeof value.signature.keyId !== "string" ||
        !value.signature.keyId ||
        value.signature.keyId !== value.signature.keyId.trim() ||
        typeof value.signature.value !== "string" ||
        !value.signature.value ||
        value.signature.value !== value.signature.value.trim()
      ) {
        valid = false;
      }
    }
  }
  if (!valid) {
    issue(issues, "RELEASE_INVALID", "Registry release metadata is malformed", {
      path: "$.release"
    });
  }
  return valid;
}

function validateTrustProfileEnvelope(
  profile: TrustProfile,
  issues: RegistryIssue[]
): void {
  if (!isPlainObject(profile)) {
    issue(issues, "INVALID_REGISTRY", "Trust profile must be an object");
    return;
  }
  unknownFields(profile, TRUST_PROFILE_FIELDS, "$.trustProfile", issues);
  if (
    typeof profile.id !== "string" ||
    !profile.id ||
    profile.id !== profile.id.trim() ||
    typeof profile.requireSignature !== "boolean" ||
    typeof profile.requireReleaseMetadata !== "boolean" ||
    (profile.requireReleaseSignature !== undefined &&
      typeof profile.requireReleaseSignature !== "boolean") ||
    !Array.isArray(profile.trustedPublicKeys)
  ) {
    issue(issues, "INVALID_REGISTRY", "Trust profile is malformed");
  }
  if (Array.isArray(profile.trustedPublicKeys)) {
    profile.trustedPublicKeys.forEach((key, index) =>
      validatePublicKeyShape(key, `$.trustProfile.trustedPublicKeys[${index}]`, issues)
    );
  }
  if (
    profile.revokedPublicKeyIds !== undefined &&
    !Array.isArray(profile.revokedPublicKeyIds)
  ) {
    issue(issues, "INVALID_REGISTRY", "Trust profile revocations must be an array");
  }
  if (
    profile.minimumReleaseSequence !== undefined &&
    (!Number.isSafeInteger(profile.minimumReleaseSequence) ||
      profile.minimumReleaseSequence < 0)
  ) {
    issue(
      issues,
      "INVALID_REGISTRY",
      "Trust profile minimumReleaseSequence must be a non-negative safe integer"
    );
  }
  if (
    profile.verificationTime !== undefined &&
    !isStrictTimestamp(profile.verificationTime)
  ) {
    issue(issues, "INVALID_REGISTRY", "Trust profile verificationTime is invalid");
  }
}

interface TrustState {
  readonly keys: ReadonlyMap<string, PublicKey>;
  readonly ambiguousKeyIds: ReadonlySet<string>;
  readonly revokedKeyIds: ReadonlySet<string>;
  readonly issues: readonly RegistryIssue[];
}

function normalizeKeyStatus(key: PublicKey): RegistryKeyStatus {
  return key.status ?? "active";
}

function buildTrustState(index: RegistryIndex, trust: TrustProfile): TrustState {
  const issues: RegistryIssue[] = [];
  const ambiguousKeyIds = new Set<string>();
  const statusRank: Readonly<Record<RegistryKeyStatus, number>> = {
    active: 0,
    retired: 1,
    revoked: 2
  };

  const collapse = (
    declarations: readonly PublicKey[],
    origin: "trusted" | "registry"
  ): Map<string, PublicKey> => {
    const grouped = new Map<string, PublicKey[]>();
    for (const key of declarations) {
      if (
        !key ||
        typeof key.id !== "string" ||
        !key.id ||
        typeof key.publicKey !== "string" ||
        !key.publicKey
      ) {
        continue;
      }
      const group = grouped.get(key.id) ?? [];
      group.push(key);
      grouped.set(key.id, group);
    }
    const collapsed = new Map<string, PublicKey>();
    for (const id of [...grouped.keys()].sort(compareStrings)) {
      const group = grouped.get(id)!;
      const publicKeys = [...new Set(group.map((key) => key.publicKey))].sort(compareStrings);
      if (publicKeys.length !== 1) {
        ambiguousKeyIds.add(id);
        issue(
          issues,
          "KEY_AMBIGUOUS",
          `${origin === "trusted" ? "Trusted" : "Registry"} key id ${id} maps to multiple public keys`,
          { keyId: id }
        );
        continue;
      }
      const statuses = [...new Set(group.map(normalizeKeyStatus))].sort(
        (left, right) => statusRank[left] - statusRank[right]
      );
      if (statuses.length > 1) {
        issue(
          issues,
          "KEY_STATUS_CONFLICT",
          `Key ${id} has conflicting status declarations`,
          { keyId: id, details: { statuses } }
        );
      }
      const status = statuses[statuses.length - 1] ?? "active";
      const retirementDates = group
        .map((key) => key.retiredAt)
        .filter((date): date is string => typeof date === "string")
        .sort(compareStrings);
      if (status === "retired" && retirementDates.length === 0) {
        issue(issues, "KEY_RETIRED", `Retired key ${id} requires retiredAt`, {
          keyId: id
        });
      }
      if (new Set(retirementDates).size > 1) {
        issue(
          issues,
          "KEY_STATUS_CONFLICT",
          `Key ${id} has conflicting retirement instants`,
          { keyId: id }
        );
      }
      collapsed.set(id, {
        id,
        publicKey: publicKeys[0]!,
        status,
        ...(retirementDates[0] ? { retiredAt: retirementDates[0] } : {})
      });
    }
    return collapsed;
  };

  const trustedDeclarations = Array.isArray(trust.trustedPublicKeys)
    ? trust.trustedPublicKeys
    : [];
  const registryDeclarations = Array.isArray(index.publicKeys)
    ? index.publicKeys
    : [];
  const keys = collapse(trustedDeclarations, "trusted");
  const registryKeys = collapse(registryDeclarations, "registry");

  for (const [id, key] of registryKeys) {
    const trusted = keys.get(id);
    if (trusted && trusted.publicKey !== key.publicKey) {
      ambiguousKeyIds.add(id);
      issue(
        issues,
        "KEY_AMBIGUOUS",
        `Registry and trust profile disagree on key ${id}`,
        { keyId: id }
      );
    }
  }
  const declaredRevocations = [
    ...(Array.isArray(trust.revokedPublicKeyIds)
      ? trust.revokedPublicKeyIds
      : []),
    ...(Array.isArray(index.revokedPublicKeyIds)
      ? index.revokedPublicKeyIds
      : [])
  ];
  const validRevocations = declaredRevocations.filter((keyId): keyId is string => {
    if (typeof keyId === "string" && keyId.trim() === keyId && keyId.length > 0) {
      return true;
    }
    issue(issues, "INVALID_REGISTRY", "Revoked public key ids must be trimmed strings");
    return false;
  });
  const revokedKeyIds = new Set([
    ...validRevocations,
    ...trustedDeclarations
      .filter(
        (key): key is PublicKey =>
          isPlainObject(key) &&
          typeof key.id === "string" &&
          typeof key.publicKey === "string" &&
          (key.status ?? "active") === "revoked"
      )
      .map((key) => key.id),
    ...registryDeclarations
      .filter(
        (key): key is PublicKey =>
          isPlainObject(key) &&
          typeof key.id === "string" &&
          typeof key.publicKey === "string" &&
          (key.status ?? "active") === "revoked"
      )
      .map((key) => key.id)
  ]);
  return { keys, ambiguousKeyIds, revokedKeyIds, issues };
}

function cryptoPublicKey(publicKey: string) {
  return publicKey.includes("BEGIN")
    ? createPublicKey(publicKey)
    : createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki"
      });
}

function verifyDetached(
  payload: string,
  signature: string,
  publicKey: string
): boolean {
  try {
    return verify(
      null,
      Buffer.from(payload),
      cryptoPublicKey(publicKey),
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

function verifySignature(input: {
  signature: StandardPackSignature | undefined;
  payload: string;
  trust: TrustState;
  required: boolean;
  entryId?: string;
  publishedAt?: string;
  release: boolean;
}): {
  readonly verified: boolean;
  readonly publicKeyId?: string;
  readonly issues: readonly RegistryIssue[];
} {
  const issues: RegistryIssue[] = [];
  if (!input.signature) {
    if (input.required) {
      issue(
        issues,
        input.release ? "RELEASE_SIGNATURE_REQUIRED" : "SIGNATURE_REQUIRED",
        input.release
          ? "Registry release signature is required"
          : `Signature is required for ${input.entryId ?? "standard pack"}`,
        input.entryId ? { entryId: input.entryId } : {}
      );
    }
    return { verified: false, issues };
  }
  if (input.signature.algorithm !== "ed25519") {
    issue(
      issues,
      input.release ? "RELEASE_SIGNATURE_INVALID" : "SIGNATURE_INVALID",
      "Signature algorithm must be exactly ed25519",
      input.entryId ? { entryId: input.entryId } : {}
    );
    return { verified: false, issues };
  }
  const keyId = input.signature.keyId;
  if (!keyId?.trim()) {
    issue(issues, "SIGNATURE_KEY_REQUIRED", "Signature keyId is required", {
      ...(input.entryId ? { entryId: input.entryId } : {})
    });
    return { verified: false, issues };
  }
  if (input.trust.ambiguousKeyIds.has(keyId)) {
    issue(issues, "KEY_AMBIGUOUS", `Signature key ${keyId} is ambiguous`, {
      keyId,
      ...(input.entryId ? { entryId: input.entryId } : {})
    });
    return { verified: false, publicKeyId: keyId, issues };
  }
  if (input.trust.revokedKeyIds.has(keyId)) {
    issue(issues, "KEY_REVOKED", `Signature key ${keyId} is revoked`, {
      keyId,
      ...(input.entryId ? { entryId: input.entryId } : {})
    });
    return { verified: false, publicKeyId: keyId, issues };
  }
  const key = input.trust.keys.get(keyId);
  if (!key) {
    issue(issues, "KEY_NOT_TRUSTED", `Signature key ${keyId} is not trusted`, {
      keyId,
      ...(input.entryId ? { entryId: input.entryId } : {})
    });
    return { verified: false, publicKeyId: keyId, issues };
  }
  if (normalizeKeyStatus(key) === "retired") {
    const publishedAt = input.publishedAt ? Date.parse(input.publishedAt) : NaN;
    const retiredAt = key.retiredAt ? Date.parse(key.retiredAt) : NaN;
    const historicalEntry =
      !input.release &&
      key.retiredAt !== undefined &&
      !Number.isNaN(retiredAt) &&
      !Number.isNaN(publishedAt) &&
      publishedAt < retiredAt;
    if (!historicalEntry) {
      issue(issues, "KEY_RETIRED", `Signature key ${keyId} is retired`, {
        keyId,
        ...(input.entryId ? { entryId: input.entryId } : {})
      });
      return { verified: false, publicKeyId: keyId, issues };
    }
  }
  const verified = verifyDetached(input.payload, input.signature.value, key.publicKey);
  if (!verified) {
    issue(
      issues,
      input.release ? "RELEASE_SIGNATURE_INVALID" : "SIGNATURE_INVALID",
      input.release
        ? "Registry release signature is invalid"
        : `Signature is invalid for ${input.entryId ?? "standard pack"}`,
      {
        keyId,
        ...(input.entryId ? { entryId: input.entryId } : {})
      }
    );
  }
  return { verified, publicKeyId: keyId, issues };
}

function verificationTimestamp(trust: TrustProfile, issues: RegistryIssue[]): number {
  if (!trust.verificationTime) return Date.now();
  const timestamp = Date.parse(trust.verificationTime);
  if (Number.isNaN(timestamp)) {
    issue(
      issues,
      "INVALID_REGISTRY",
      "Trust profile verificationTime must be a timestamp"
    );
    return Date.now();
  }
  return timestamp;
}

function verifyRelease(
  index: RegistryIndex,
  trustProfile: TrustProfile,
  trustState: TrustState,
  registryDigest: string,
  verificationTime: number,
  issues: RegistryIssue[]
): ReleaseVerification | undefined {
  const metadata = index.release;
  if (!metadata) {
    if (
      trustProfile.requireReleaseMetadata ||
      trustProfile.requireReleaseSignature === true ||
      trustProfile.minimumReleaseSequence !== undefined
    ) {
      issue(issues, "RELEASE_REQUIRED", "Registry release metadata is required");
    }
    return undefined;
  }
  if (
    metadata.schemaVersion !== 1 ||
    !Number.isSafeInteger(metadata.sequence) ||
    metadata.sequence < 0 ||
    Number.isNaN(Date.parse(metadata.issuedAt)) ||
    (metadata.expiresAt !== undefined && Number.isNaN(Date.parse(metadata.expiresAt))) ||
    !HEX_SHA256.test(metadata.registryDigest)
  ) {
    issue(issues, "RELEASE_INVALID", "Registry release metadata is malformed");
    return undefined;
  }
  if (metadata.registryDigest !== registryDigest) {
    issue(
      issues,
      "RELEASE_DIGEST_MISMATCH",
      "Registry release digest does not match registry content",
      {
        details: {
          expected: registryDigest,
          actual: metadata.registryDigest
        }
      }
    );
  }
  const now = verificationTime;
  if (Date.parse(metadata.issuedAt) > now) {
    issue(
      issues,
      "RELEASE_INVALID",
      "Registry release issuedAt is after the verification time"
    );
  }
  if (metadata.expiresAt && now >= Date.parse(metadata.expiresAt)) {
    issue(issues, "RELEASE_EXPIRED", "Registry release metadata is expired");
  }
  if (
    trustProfile.minimumReleaseSequence !== undefined &&
    metadata.sequence < trustProfile.minimumReleaseSequence
  ) {
    issue(
      issues,
      "RELEASE_SEQUENCE_ROLLBACK",
      `Registry release sequence ${metadata.sequence} is below trusted minimum ${trustProfile.minimumReleaseSequence}`
    );
  }
  const verification = verifySignature({
    signature: metadata.signature,
    payload: standardPackReleaseSignaturePayload(metadata),
    trust: trustState,
    required:
      trustProfile.requireReleaseSignature ?? trustProfile.requireSignature,
    publishedAt: metadata.issuedAt,
    release: true
  });
  issues.push(...verification.issues);
  return {
    sequence: metadata.sequence,
    issuedAt: metadata.issuedAt,
    ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
    registryDigest: metadata.registryDigest,
    signatureVerified: verification.verified,
    ...(verification.publicKeyId
      ? { publicKeyId: verification.publicKeyId }
      : {})
  };
}

function currentEntries(
  currentLocks: readonly PackLock[] | PackLock,
  issues: RegistryIssue[]
): Map<string, PackLockEntry> {
  const locks = Array.isArray(currentLocks)
    ? currentLocks
    : [currentLocks as PackLock];
  const candidates: PackLockEntry[] = [];
  for (const lock of locks) {
    const lockIssues = validatePackLock(lock);
    issues.push(...lockIssues);
    if (
      lockIssues.length > 0 ||
      !isPlainObject(lock) ||
      !Array.isArray(lock.packs)
    ) {
      continue;
    }
    candidates.push(...lock.packs.map((entry) => ({ ...entry })));
  }
  candidates.sort((left, right) =>
    compareStrings(left.scope, right.scope) ||
    compareStrings(left.scopeId, right.scopeId) ||
    compareStrings(left.id, right.id) ||
    compareStrings(left.version, right.version) ||
    compareStrings(left.digest, right.digest) ||
    (left.sequence ?? -1) - (right.sequence ?? -1) ||
    compareStrings(left.source ?? "", right.source ?? "")
  );
  const entries = new Map<string, PackLockEntry>();
  const releaseByVersionIdentity = new Map<
    string,
    { digest: string; sequence?: number }
  >();
  for (const entry of candidates) {
    const versionIdentity = `${entry.id}@${entry.version}`;
    const knownRelease = releaseByVersionIdentity.get(versionIdentity);
    if (
      knownRelease !== undefined &&
      (knownRelease.digest !== entry.digest ||
        (knownRelease.sequence !== undefined &&
          entry.sequence !== undefined &&
          knownRelease.sequence !== entry.sequence))
    ) {
      issue(
        issues,
        "VERSION_DIGEST_CONFLICT",
        `Current locks map ${versionIdentity} to conflicting release identities`,
        { entryId: entry.id }
      );
    } else {
      releaseByVersionIdentity.set(versionIdentity, {
        digest: entry.digest,
        sequence: knownRelease?.sequence ?? entry.sequence
      });
    }
    const key = `${entry.scope}\0${entry.scopeId}\0${entry.id}`;
    const previous = entries.get(key);
    if (
      previous &&
      (previous.version !== entry.version ||
        previous.digest !== entry.digest ||
        previous.sequence !== entry.sequence ||
        previous.source !== entry.source)
    ) {
      issue(
        issues,
        "LOCK_INVALID",
        `Current locks conflict for ${entry.id} at ${entry.scope}:${entry.scopeId}`,
        { entryId: entry.id }
      );
    } else if (!previous) {
      entries.set(key, { ...entry });
    }
  }
  return entries;
}

function targetEntry(entry: RegistryEntry): PackLockEntry {
  return {
    id: entry.manifest.id,
    version: entry.manifest.version,
    digest: entry.digest,
    ...(entry.manifest.release
      ? { sequence: entry.manifest.release.sequence }
      : {}),
    scope: entry.scope,
    scopeId: entry.scopeId,
    ...(entry.source ? { source: entry.source } : {})
  };
}

function lockDiff(
  current: PackLockEntry | undefined,
  target: PackLockEntry
): readonly SyncPlanDiff[] {
  const fields = [
    "version",
    "digest",
    "sequence",
    "scope",
    "scopeId",
    "source"
  ] as const;
  return fields.flatMap((field): SyncPlanDiff[] => {
    const before = current?.[field];
    const after = target[field];
    return before === after
      ? []
      : [
          {
            field,
            ...(before !== undefined ? { before } : {}),
            ...(after !== undefined ? { after } : {})
          }
        ];
  });
}

function syncStatus(
  current: PackLockEntry | undefined,
  target: PackLockEntry
): SyncPlanStatus {
  if (!current) return "new";
  const versionOrder = comparePackVersions(target.version, current.version);
  if (versionOrder < 0) return "downgrade";
  if (
    versionOrder === 0 &&
    target.digest === current.digest &&
    target.sequence === current.sequence &&
    target.source === current.source
  ) {
    return "current";
  }
  return "update";
}

function validatePackLifecycle(
  manifest: StandardPackManifest,
  current: PackLockEntry | undefined,
  targetDigest: string,
  registryRelease: ReleaseMetadata | undefined,
  verificationTime: number,
  issues: RegistryIssue[]
): void {
  const release = manifest.release;
  if (!release) {
    issue(
      issues,
      "PACK_RELEASE_INVALID",
      `Registry pack ${manifest.id}@${manifest.version} requires release metadata`,
      { entryId: manifest.id }
    );
    return;
  }
  const publishedAt = Date.parse(release.publishedAt);
  if (publishedAt > verificationTime) {
    issue(
      issues,
      "PACK_RELEASE_INVALID",
      `Pack ${manifest.id}@${manifest.version} is published in the future`,
      { entryId: manifest.id }
    );
  }
  if (release.expiresAt && verificationTime >= Date.parse(release.expiresAt)) {
    issue(
      issues,
      "PACK_RELEASE_EXPIRED",
      `Pack ${manifest.id}@${manifest.version} is expired`,
      { entryId: manifest.id }
    );
  }
  if (
    registryRelease &&
    publishedAt > Date.parse(registryRelease.issuedAt)
  ) {
    issue(
      issues,
      "PACK_RELEASE_INVALID",
      `Pack ${manifest.id}@${manifest.version} was published after the registry release`,
      { entryId: manifest.id }
    );
  }
  if (current?.sequence !== undefined) {
    if (current.digest === targetDigest) {
      if (release.sequence !== current.sequence) {
        issue(
          issues,
          "PACK_RELEASE_CHAIN_INVALID",
          `Pack ${manifest.id}@${manifest.version} release sequence does not match the locked revision`,
          {
            entryId: manifest.id,
            details: {
              expectedSequence: current.sequence,
              actualSequence: release.sequence
            }
          }
        );
      }
      return;
    }

    // Registry sync never applies downgrades directly; the trusted rollback
    // planner validates the historical lock and its older sequence instead.
    if (comparePackVersions(manifest.version, current.version) < 0) {
      return;
    }

    const expectedSequence = current.sequence + 1;
    if (
      !Number.isSafeInteger(expectedSequence) ||
      release.sequence !== expectedSequence
    ) {
      issue(
        issues,
        "PACK_RELEASE_CHAIN_INVALID",
        `Pack ${manifest.id}@${manifest.version} must advance the locked release sequence by exactly one`,
        {
          entryId: manifest.id,
          details: {
            currentSequence: current.sequence,
            expectedSequence: Number.isSafeInteger(expectedSequence)
              ? expectedSequence
              : "unrepresentable",
            actualSequence: release.sequence
          }
        }
      );
    }
    if (release.previousDigest !== current.digest) {
      issue(
        issues,
        "PACK_RELEASE_CHAIN_INVALID",
        `Pack ${manifest.id}@${manifest.version} does not reference the locked predecessor`,
        {
          entryId: manifest.id,
          details: {
            expected: current.digest,
            actual: release.previousDigest
          }
        }
      );
    }
    return;
  }

  if (
    current &&
    current.digest !== targetDigest &&
    comparePackVersions(manifest.version, current.version) > 0 &&
    release.previousDigest !== current.digest
  ) {
    issue(
      issues,
      "PACK_RELEASE_CHAIN_INVALID",
      `Pack ${manifest.id}@${manifest.version} does not reference the locked predecessor`,
      {
        entryId: manifest.id,
        details: {
          expected: current.digest,
          actual: release.previousDigest
        }
      }
    );
  }
}

function validateRegistryEnvelope(index: RegistryIndex): readonly RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  if (!isPlainObject(index) || index.schemaVersion !== 1) {
    issue(issues, "INVALID_REGISTRY", "Registry schemaVersion must be 1");
    return issues;
  }
  unknownFields(index, REGISTRY_FIELDS, "$", issues);
  if (!Array.isArray(index.entries)) {
    issue(issues, "INVALID_REGISTRY", "Registry entries must be an array");
  } else {
    index.entries.forEach((entry, position) => {
      const path = `$.entries[${position}]`;
      if (!isPlainObject(entry)) {
        issue(issues, "INVALID_REGISTRY", `${path} must be an object`, { path });
        return;
      }
      unknownFields(entry, REGISTRY_ENTRY_FIELDS, path, issues);
      if (!isPlainObject(entry.manifest)) {
        issue(issues, "INVALID_REGISTRY", `${path}.manifest must be an object`, {
          path: `${path}.manifest`
        });
      }
      if (typeof entry.digest !== "string" || !HEX_SHA256.test(entry.digest)) {
        issue(issues, "INVALID_REGISTRY", `${path}.digest must be lowercase SHA-256`, {
          path: `${path}.digest`
        });
      }
      if (!(GOVERNANCE_SCOPE_ORDER as readonly unknown[]).includes(entry.scope)) {
        issue(issues, "INVALID_REGISTRY", `${path}.scope is unsupported`, {
          path: `${path}.scope`
        });
      }
      if (
        typeof entry.scopeId !== "string" ||
        !entry.scopeId ||
        entry.scopeId !== entry.scopeId.trim()
      ) {
        issue(issues, "INVALID_REGISTRY", `${path}.scopeId must be trimmed`, {
          path: `${path}.scopeId`
        });
      }
      if (
        entry.source !== undefined &&
        (typeof entry.source !== "string" ||
          !entry.source ||
          entry.source !== entry.source.trim())
      ) {
        issue(issues, "INVALID_REGISTRY", `${path}.source must be trimmed`, {
          path: `${path}.source`
        });
      }
    });
  }
  if (index.publicKeys !== undefined && !Array.isArray(index.publicKeys)) {
    issue(issues, "INVALID_REGISTRY", "Registry publicKeys must be an array");
  } else if (Array.isArray(index.publicKeys)) {
    index.publicKeys.forEach((key, position) =>
      validatePublicKeyShape(key, `$.publicKeys[${position}]`, issues)
    );
  }
  if (
    index.revokedPublicKeyIds !== undefined &&
    !Array.isArray(index.revokedPublicKeyIds)
  ) {
    issue(
      issues,
      "INVALID_REGISTRY",
      "Registry revokedPublicKeyIds must be an array"
    );
  } else if (Array.isArray(index.revokedPublicKeyIds)) {
    const seen = new Set<string>();
    index.revokedPublicKeyIds.forEach((keyId, position) => {
      if (
        typeof keyId !== "string" ||
        !keyId ||
        keyId !== keyId.trim() ||
        seen.has(keyId)
      ) {
        issue(
          issues,
          "INVALID_REGISTRY",
          `$.revokedPublicKeyIds[${position}] must be a unique trimmed string`,
          { path: `$.revokedPublicKeyIds[${position}]` }
        );
      }
      if (typeof keyId === "string") seen.add(keyId);
    });
  }
  if (index.release !== undefined) {
    validateReleaseMetadataShape(index.release, issues);
  }
  return issues;
}

export function planStandardPackSync(
  currentLocks: readonly PackLock[] | PackLock,
  registry: RegistryIndex,
  trustProfile: TrustProfile,
  dryRun: boolean
): SyncPlan {
  const ingressIssues: RegistryIssue[] = [];
  let safeRegistryValue: unknown;
  let safeTrustValue: unknown;
  let safeLocksValue: unknown;
  try {
    safeRegistryValue = JSON.parse(strictCanonicalJson(registry));
  } catch (error) {
    issue(
      ingressIssues,
      "INVALID_REGISTRY",
      error instanceof Error ? error.message : "Registry must be declarative JSON"
    );
  }
  try {
    safeTrustValue = JSON.parse(strictCanonicalJson(trustProfile));
  } catch (error) {
    issue(
      ingressIssues,
      "INVALID_REGISTRY",
      error instanceof Error ? error.message : "Trust profile must be declarative JSON"
    );
  }
  try {
    safeLocksValue = JSON.parse(strictCanonicalJson(currentLocks));
  } catch (error) {
    issue(
      ingressIssues,
      "LOCK_INVALID",
      error instanceof Error ? error.message : "Current locks must be declarative JSON"
    );
  }
  if (!isPlainObject(safeRegistryValue) || !isPlainObject(safeTrustValue)) {
    if (!isPlainObject(safeRegistryValue)) {
      issue(ingressIssues, "INVALID_REGISTRY", "Registry must be an object");
    }
    if (!isPlainObject(safeTrustValue)) {
      issue(ingressIssues, "INVALID_REGISTRY", "Trust profile must be an object");
    }
    return deepFreeze({
      schemaVersion: 1 as const,
      dryRun,
      applied: false as const,
      valid: false,
      changed: false,
      registryDigest: "0".repeat(64),
      entries: [],
      issues: ingressIssues
    });
  }
  const safeRegistry = safeRegistryValue as unknown as RegistryIndex;
  const safeTrustProfile = safeTrustValue as unknown as TrustProfile;
  const safeCurrentLocks =
    Array.isArray(safeLocksValue) || isPlainObject(safeLocksValue)
      ? (safeLocksValue as unknown as readonly PackLock[] | PackLock)
      : ([] as readonly PackLock[]);
  if (!(Array.isArray(safeLocksValue) || isPlainObject(safeLocksValue))) {
    issue(ingressIssues, "LOCK_INVALID", "Current locks must be a lock or lock array");
  }

  const globalIssues: RegistryIssue[] = [
    ...ingressIssues,
    ...validateRegistryEnvelope(safeRegistry)
  ];
  validateTrustProfileEnvelope(safeTrustProfile, globalIssues);
  let registryDigest = "0".repeat(64);
  try {
    registryDigest = hashRegistryIndex(safeRegistry);
  } catch (error) {
    issue(
      globalIssues,
      "INVALID_REGISTRY",
      error instanceof Error ? error.message : String(error)
    );
  }
  const trustState = buildTrustState(safeRegistry, safeTrustProfile);
  globalIssues.push(...trustState.issues);
  const verificationTime = verificationTimestamp(safeTrustProfile, globalIssues);
  const release = verifyRelease(
    safeRegistry,
    safeTrustProfile,
    trustState,
    registryDigest,
    verificationTime,
    globalIssues
  );
  const current = currentEntries(safeCurrentLocks, globalIssues);
  const seenTargets = new Set<string>();
  const sourceDigests = new Map<string, string>();
  for (const entry of current.values()) {
    sourceDigests.set(`${entry.id}@${entry.version}`, entry.digest);
  }
  const entries: SyncPlanEntry[] = [];
  const registryEntries = Array.isArray(safeRegistry.entries)
    ? safeRegistry.entries
    : [];

  for (const [index, rawEntry] of registryEntries.entries()) {
    const entryIssues: RegistryIssue[] = [];
    const rawRecord = isPlainObject(rawEntry) ? rawEntry : undefined;
    const rawManifest = rawRecord?.manifest;
    const rawManifestRecord = isPlainObject(rawManifest) ? rawManifest : undefined;
    const id =
      rawManifestRecord && typeof rawManifestRecord.id === "string"
        ? rawManifestRecord.id
        : `invalid-entry-${index}`;
    const version =
      rawManifestRecord && typeof rawManifestRecord.version === "string"
        ? rawManifestRecord.version
        : "0.0.0";
    if (
      !rawRecord ||
      !(GOVERNANCE_SCOPE_ORDER as readonly unknown[]).includes(rawRecord.scope) ||
      typeof rawRecord.scopeId !== "string" ||
      !rawRecord.scopeId.trim()
    ) {
      issue(entryIssues, "INVALID_REGISTRY", `Registry entry ${index} is malformed`, {
        entryId: id
      });
    }
    const validation = validateStandardPack(rawManifest);
    entryIssues.push(
      ...validation.issues.map((candidate) => ({ ...candidate, entryId: id }))
    );
    let expectedDigest: string | undefined;
    if (validation.manifest) {
      expectedDigest = hashStandardPackManifest(validation.manifest);
      if (rawRecord?.digest !== expectedDigest) {
        issue(
          entryIssues,
          "DIGEST_MISMATCH",
          `Registry digest mismatch for ${id}`,
          {
            entryId: id,
            details: { expected: expectedDigest, actual: rawRecord?.digest }
          }
        );
      }
    }
    const signatureVerification = validation.manifest
      ? verifySignature({
          signature: validation.manifest.signature,
          payload: standardPackSignaturePayload(validation.manifest),
          trust: trustState,
          required: safeTrustProfile.requireSignature,
          entryId: id,
          publishedAt: validation.manifest.release?.publishedAt,
          release: false
        })
      : { verified: false, issues: [] as readonly RegistryIssue[] };
    entryIssues.push(...signatureVerification.issues);

    const target = validation.manifest && rawRecord
      ? targetEntry({
          manifest: validation.manifest,
          digest: typeof rawRecord.digest === "string" ? rawRecord.digest : "0".repeat(64),
          scope: (GOVERNANCE_SCOPE_ORDER as readonly unknown[]).includes(rawRecord.scope)
            ? rawRecord.scope as RegistryEntry["scope"]
            : "builtin",
          scopeId: typeof rawRecord.scopeId === "string" ? rawRecord.scopeId : "invalid",
          ...(typeof rawRecord.source === "string" ? { source: rawRecord.source } : {})
        })
      : undefined;
    if (validation.manifest && expectedDigest) {
      const identity = `${validation.manifest.id}@${validation.manifest.version}`;
      const previousDigest = sourceDigests.get(identity);
      if (previousDigest !== undefined && previousDigest !== expectedDigest) {
        issue(
          entryIssues,
          "VERSION_DIGEST_CONFLICT",
          `Standard pack ${identity} maps to multiple digests`,
          { entryId: validation.manifest.id }
        );
      } else {
        sourceDigests.set(identity, expectedDigest);
      }
    }
    const key = target
      ? `${target.scope}\0${target.scopeId}\0${target.id}`
      : `invalid\0${index}`;
    if (seenTargets.has(key)) {
      issue(
        entryIssues,
        "INVALID_REGISTRY",
        `Registry contains duplicate target ${id}`,
        { entryId: id }
      );
    }
    seenTargets.add(key);
    const currentEntry = target ? current.get(key) : undefined;
    if (validation.manifest && expectedDigest) {
      validatePackLifecycle(
        validation.manifest,
        currentEntry,
        expectedDigest,
        safeRegistry.release,
        verificationTime,
        entryIssues
      );
    }
    if (
      target &&
      currentEntry &&
      target.version === currentEntry.version &&
      target.digest !== currentEntry.digest
    ) {
      issue(
        entryIssues,
        "VERSION_DIGEST_CONFLICT",
        `Locked version ${target.id}@${target.version} has a different digest`,
        { entryId: target.id }
      );
    }
    let status: SyncPlanStatus = entryIssues.length > 0 || !target
      ? "invalid"
      : syncStatus(currentEntry, target);
    if (status === "downgrade") {
      issue(
        entryIssues,
        "DOWNGRADE_REQUIRES_ROLLBACK",
        `Downgrade ${id} from ${currentEntry?.version} to ${target?.version} requires a trusted rollback plan`,
        { entryId: id }
      );
    }
    if (entryIssues.some((candidate) => candidate.code !== "DOWNGRADE_REQUIRES_ROLLBACK")) {
      status = "invalid";
    }
    if (globalIssues.length > 0) {
      status = "invalid";
    }
    const material = target ?? {
      id,
      version,
      digest: typeof rawRecord?.digest === "string" ? rawRecord.digest : "0".repeat(64),
      scope:
        rawRecord &&
        (GOVERNANCE_SCOPE_ORDER as readonly unknown[]).includes(rawRecord.scope)
          ? rawRecord.scope as RegistryEntry["scope"]
          : "builtin",
      scopeId:
        rawRecord && typeof rawRecord.scopeId === "string"
          ? rawRecord.scopeId
          : "invalid"
    };
    entries.push({
      id: material.id,
      version: material.version,
      digest: material.digest,
      ...(material.sequence !== undefined ? { sequence: material.sequence } : {}),
      scope: material.scope,
      scopeId: material.scopeId,
      ...(material.source ? { source: material.source } : {}),
      status,
      ...(currentEntry ? { current: { ...currentEntry } } : {}),
      ...(target ? { target: { ...target } } : {}),
      diff: target ? lockDiff(currentEntry, target) : [],
      signatureVerified: signatureVerification.verified,
      ...(signatureVerification.publicKeyId
        ? { publicKeyId: signatureVerification.publicKeyId }
        : {}),
      issues: entryIssues
    });
  }

  entries.sort((left, right) =>
    GOVERNANCE_SCOPE_ORDER.indexOf(left.scope) -
      GOVERNANCE_SCOPE_ORDER.indexOf(right.scope) ||
    compareStrings(left.scopeId, right.scopeId) ||
    compareStrings(left.id, right.id)
  );
  const sequenceBackfillRequired = entries.some(
    (entry) =>
      entry.target?.sequence !== undefined &&
      [...current.values()].some(
        (candidate) =>
          candidate.id === entry.target!.id &&
          candidate.version === entry.target!.version &&
          candidate.digest === entry.target!.digest &&
          candidate.sequence === undefined
      )
  );
  const changed = sequenceBackfillRequired || entries.some(
    (entry) => entry.status === "new" || entry.status === "update" || entry.status === "downgrade"
  );
  const valid =
    globalIssues.length === 0 &&
    entries.every(
      (entry) =>
        entry.status !== "invalid" &&
        entry.status !== "downgrade" &&
        entry.issues.length === 0
    );
  let proposedLock: PackLock | undefined;
  if (valid && changed) {
    const nextEntries = new Map(current);
    for (const entry of entries) {
      if (!entry.target) continue;
      nextEntries.set(
        `${entry.target.scope}\0${entry.target.scopeId}\0${entry.target.id}`,
        entry.target
      );
    }
    for (const target of entries.map((entry) => entry.target).filter(
      (entry): entry is PackLockEntry => entry !== undefined && entry.sequence !== undefined
    )) {
      for (const [key, candidate] of nextEntries) {
        if (
          candidate.id === target.id &&
          candidate.version === target.version &&
          candidate.digest === target.digest &&
          candidate.sequence === undefined
        ) {
          nextEntries.set(key, { ...candidate, sequence: target.sequence });
        }
      }
    }
    const latestCurrentGeneratedAt = (Array.isArray(safeCurrentLocks)
      ? safeCurrentLocks
      : [safeCurrentLocks]
    ).reduce(
      (latest, lock) =>
        isPlainObject(lock) && isStrictTimestamp(lock.generatedAt)
          ? Math.max(latest, Date.parse(lock.generatedAt))
          : latest,
      0
    );
    proposedLock = createPackLock(
      [...nextEntries.values()],
      new Date(Math.max(verificationTime, latestCurrentGeneratedAt)).toISOString()
    );
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    dryRun,
    applied: false as const,
    valid,
    changed,
    registryDigest,
    ...(release ? { release } : {}),
    entries,
    issues: globalIssues,
    ...(proposedLock ? { proposedLock } : {})
  });
}
