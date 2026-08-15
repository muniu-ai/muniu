import { createHash } from "node:crypto";
import { sha256Canonical, type GovernanceSnapshot } from "@mn/governance";
import { canonicalJson, sha256Digest, validateSpecRevision } from "@mn/specs";
import { HarnessCompilationError } from "./errors.js";
import {
  cloneSafeJsonValue,
  deepFreezeJson,
  redactContextContent,
  redactSensitiveValue,
  safeRedactedErrorMessage
} from "./redaction.js";
import type {
  ContextCollectionRequest,
  ContextFragmentInput,
  ContextSource,
  CapabilityRegistryLike,
  GateRunner,
  HarnessCompilationIssue,
  HarnessCompileInput,
  HarnessContextFragment,
  HarnessContextManifest,
  HarnessGatePlanItem,
  HarnessManifest,
  HarnessProfile,
  HarnessSandboxPlan,
  OmittedContextFragment,
  SandboxBackend,
  SandboxEnforcement
} from "./types.js";

const ENFORCEMENT_VALUES = [
  "advisory",
  "postcheck",
  "isolated",
  "enforced"
] as const;
const ENFORCEMENT_RANK: Readonly<Record<SandboxEnforcement, number>> = {
  advisory: 0,
  postcheck: 1,
  isolated: 2,
  enforced: 3
};
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GOVERNANCE_BUDGET_FIELDS = [
  "maxCandidates",
  "maxDurationSeconds",
  "maxTokens",
  "maxCostUsd",
  "maxRepairAttempts",
  "maxChangedFiles",
  "maxChangedLines"
] as const;
const COUNT_GOVERNANCE_BUDGET_FIELDS = new Set<string>([
  "maxCandidates",
  "maxDurationSeconds",
  "maxTokens",
  "maxRepairAttempts",
  "maxChangedFiles",
  "maxChangedLines"
]);
const DEFAULT_CONTEXT_SOURCE_TIMEOUT_MS = 30_000;
const PROFILE_FIELDS = Object.freeze([
  "id",
  "version",
  "digest",
  "sandboxBackendId",
  "minimumSandboxEnforcement",
  "requiredSandboxCapabilities",
  "maxContextBytes",
  "maxContextTokens",
  "contextSourceTimeoutMs",
  "requiredContextSourceIds",
  "requiredContextFragmentIds",
  "failOnMissingRequiredGates",
  "redactSensitiveContext",
  "outputSchema"
] as const);
const REQUIRED_PROFILE_FIELDS = Object.freeze([
  "id",
  "version",
  "sandboxBackendId",
  "minimumSandboxEnforcement",
  "maxContextBytes",
  "maxContextTokens",
  "failOnMissingRequiredGates",
  "redactSensitiveContext",
  "outputSchema"
] as const);
const RAW_CONTEXT_ABSOLUTE_LIMIT_BYTES = 16 * 1024 * 1024;
const RAW_CONTEXT_MINIMUM_LIMIT_BYTES = 1024 * 1024;
const TOKEN_ESTIMATOR = Object.freeze({
  id: "utf8-byte-upper-bound" as const,
  version: "1" as const
});
const RFC3339_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneCanonical<T>(value: T): T {
  // @mn/specs canonicalization rejects accessors/sparse arrays, while this
  // package additionally requires every array index to be enumerable.
  const strictSnapshot = cloneSafeJsonValue(value);
  return JSON.parse(canonicalJson(strictSnapshot)) as T;
}

function issue(
  code: HarnessCompilationIssue["code"],
  message: string,
  field?: string,
  details?: Readonly<Record<string, unknown>>
): HarnessCompilationIssue {
  return {
    code,
    message,
    ...(field === undefined ? {} : { field }),
    ...(details === undefined ? {} : { details })
  };
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function containsSensitiveMaterial(value: string): boolean {
  const redacted = redactContextContent(value);
  return redacted !== value && redacted.includes("[REDACTED");
}

function ownEnumerableDataProperty<T>(value: object, key: PropertyKey): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${String(key)} must be an own enumerable data property`);
  }
  return descriptor.value as T;
}

function optionalOwnDataProperty<T>(value: object, key: PropertyKey): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${String(key)} must be an own enumerable data property`);
  }
  return descriptor.value as T;
}

function callableDataProperty<T>(value: object, key: PropertyKey): T {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${String(key)} must be a data function`);
      }
      return descriptor.value as T;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new TypeError(`${String(key)} must be a data function`);
}

function isSandboxEnforcement(value: unknown): value is SandboxEnforcement {
  return typeof value === "string" &&
    (ENFORCEMENT_VALUES as readonly string[]).includes(value);
}

function isEnterpriseProfileId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  return normalized === "enterprise" || /^enterprise[-_/:.]/u.test(normalized);
}

function normalizedDigestList(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return [...value].sort(compareCodeUnits);
}

function assertExactDataObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string
): asserts value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${field} must be a plain object`);
  }
  const allowedSet = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new TypeError(`${field} cannot contain symbol keys`);
  }
  for (const key of keys as string[]) {
    if (!allowedSet.has(key)) throw new TypeError(`${field}.${key} is not allowed`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${field}.${key} must be an enumerable data property`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${field}.${key} is required`);
  }
}

function snapshotProfileForDigest(
  profile: HarnessProfile | Omit<HarnessProfile, "digest">
): HarnessProfile | Omit<HarnessProfile, "digest"> {
  const snapshot = cloneSafeJsonValue(profile);
  assertExactDataObject(snapshot, PROFILE_FIELDS, REQUIRED_PROFILE_FIELDS, "profile");
  return snapshot;
}

function profileSemanticMaterial(
  profile: HarnessProfile | Omit<HarnessProfile, "digest">
): Readonly<Record<string, unknown>> {
  return {
    id: profile.id,
    version: profile.version,
    sandboxBackendId: profile.sandboxBackendId,
    minimumSandboxEnforcement: profile.minimumSandboxEnforcement,
    requiredSandboxCapabilities: normalizedDigestList(
      profile.requiredSandboxCapabilities
    ),
    maxContextBytes: profile.maxContextBytes,
    maxContextTokens: profile.maxContextTokens,
    contextSourceTimeoutMs:
      profile.contextSourceTimeoutMs ?? DEFAULT_CONTEXT_SOURCE_TIMEOUT_MS,
    requiredContextSourceIds: normalizedDigestList(
      profile.requiredContextSourceIds
    ),
    requiredContextFragmentIds: normalizedDigestList(
      profile.requiredContextFragmentIds
    ),
    failOnMissingRequiredGates: profile.failOnMissingRequiredGates,
    redactSensitiveContext: profile.redactSensitiveContext,
    outputSchema: profile.outputSchema
  };
}

/** Compute the immutable identity used by GovernanceSnapshot.harnessProfileRef. */
export function digestHarnessProfile(
  profile: HarnessProfile | Omit<HarnessProfile, "digest">
): string {
  return sha256Digest(profileSemanticMaterial(snapshotProfileForDigest(profile)));
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function strictTimestampMillis(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const offset = match[7]!;
  if (
    year === 0 ||
    day > daysInMonth(year, month) ||
    ((offset.startsWith("+") || offset.startsWith("-")) &&
      offset.slice(1, 3) === "14" &&
      offset.slice(4, 6) !== "00")
  ) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function parseGeneratedAt(value: Date | string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (value instanceof Date) {
    const time = Reflect.apply(Date.prototype.getTime, value, []) as number;
    if (!Number.isFinite(time)) {
      throw new HarnessCompilationError([
        issue("INVALID_GENERATED_AT", "now must be a valid Date", "now")
      ]);
    }
    return new Date(time).toISOString();
  }
  if (typeof value !== "string") {
    throw new HarnessCompilationError([
      issue("INVALID_GENERATED_AT", "now must be a Date or RFC3339 string", "now")
    ]);
  }
  const time = strictTimestampMillis(value);
  if (time === undefined) {
    throw new HarnessCompilationError([
      issue("INVALID_GENERATED_AT", "now must be a strict RFC3339 timestamp", "now")
    ]);
  }
  return new Date(time).toISOString();
}

function validateStringSet(
  value: unknown,
  field: string,
  issues: HarnessCompilationIssue[]
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_PROFILE", `${field} must be an array`, field));
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isTrimmedNonEmptyString(entry)) {
      issues.push(issue("INVALID_PROFILE", `${field}[${index}] must be a non-empty trimmed string`, `${field}[${index}]`));
      return;
    }
    if (containsSensitiveMaterial(entry)) {
      issues.push(issue("INVALID_PROFILE", `${field}[${index}] contains sensitive material`, `${field}[${index}]`));
      return;
    }
    if (seen.has(entry)) {
      issues.push(issue("INVALID_PROFILE", `${field} cannot contain duplicate ${entry}`, field));
    }
    seen.add(entry);
  });
}

function validateProfile(profile: HarnessProfile): HarnessCompilationIssue[] {
  const issues: HarnessCompilationIssue[] = [];
  try {
    assertExactDataObject(
      profile,
      PROFILE_FIELDS,
      [...REQUIRED_PROFILE_FIELDS, "digest"],
      "profile"
    );
  } catch {
    issues.push(issue(
      "INVALID_PROFILE",
      "Harness profile must use the exact declarative schema",
      "profile"
    ));
  }
  for (const [field, value] of [
    ["profile.id", profile.id],
    ["profile.version", profile.version],
    ["profile.sandboxBackendId", profile.sandboxBackendId],
    ["profile.outputSchema", profile.outputSchema]
  ] as const) {
    if (!isTrimmedNonEmptyString(value)) {
      issues.push(issue("INVALID_PROFILE", `${field} must be a non-empty trimmed string`, field));
    } else if (containsSensitiveMaterial(value)) {
      issues.push(issue("INVALID_PROFILE", `${field} cannot contain credentials or sensitive material`, field));
    }
  }
  if (!isSandboxEnforcement(profile.minimumSandboxEnforcement)) {
    issues.push(issue("INVALID_PROFILE", "profile.minimumSandboxEnforcement is unsupported", "profile.minimumSandboxEnforcement"));
  }
  if (
    isEnterpriseProfileId(profile.id) &&
    profile.minimumSandboxEnforcement !== "enforced"
  ) {
    issues.push(issue(
      "INVALID_PROFILE",
      "Enterprise Harness profiles require enforced sandbox isolation",
      "profile.minimumSandboxEnforcement"
    ));
  }
  if (!Number.isSafeInteger(profile.maxContextBytes) || profile.maxContextBytes < 0) {
    issues.push(issue("INVALID_PROFILE", "profile.maxContextBytes must be a non-negative safe integer", "profile.maxContextBytes"));
  }
  if (!Number.isSafeInteger(profile.maxContextTokens) || profile.maxContextTokens < 0) {
    issues.push(issue("INVALID_PROFILE", "profile.maxContextTokens must be a non-negative safe integer", "profile.maxContextTokens"));
  }
  const timeout = profile.contextSourceTimeoutMs ?? DEFAULT_CONTEXT_SOURCE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    issues.push(issue("INVALID_PROFILE", "profile.contextSourceTimeoutMs must be a positive safe integer", "profile.contextSourceTimeoutMs"));
  }
  if (typeof profile.failOnMissingRequiredGates !== "boolean") {
    issues.push(issue("INVALID_PROFILE", "profile.failOnMissingRequiredGates must be boolean", "profile.failOnMissingRequiredGates"));
  }
  if (typeof profile.redactSensitiveContext !== "boolean") {
    issues.push(issue("INVALID_PROFILE", "profile.redactSensitiveContext must be boolean", "profile.redactSensitiveContext"));
  }
  if (!isTrimmedNonEmptyString(profile.digest) || !SHA256_PATTERN.test(profile.digest)) {
    issues.push(issue("INVALID_PROFILE", "profile.digest must be a lowercase SHA-256 digest", "profile.digest"));
  }
  validateStringSet(profile.requiredSandboxCapabilities, "profile.requiredSandboxCapabilities", issues);
  validateStringSet(profile.requiredContextSourceIds, "profile.requiredContextSourceIds", issues);
  validateStringSet(profile.requiredContextFragmentIds, "profile.requiredContextFragmentIds", issues);
  return issues;
}

interface NormalizedCompileContext {
  readonly taskId: string;
  readonly projectRoot: string;
  readonly selectedServices: readonly string[];
  readonly languageByService: Readonly<Record<string, string>>;
}

function normalizeCompileContext(
  input: HarnessCompileInput
): { readonly context?: NormalizedCompileContext; readonly issues: readonly HarnessCompilationIssue[] } {
  const issues: HarnessCompilationIssue[] = [];
  const context = cloneSafeJsonValue(input.context);
  if (!isTrimmedNonEmptyString(context.taskId)) {
    issues.push(issue("INVALID_CONTEXT", "context.taskId must be a non-empty trimmed string", "context.taskId"));
  } else if (containsSensitiveMaterial(context.taskId)) {
    issues.push(issue("INVALID_CONTEXT", "context.taskId cannot contain credentials or sensitive material", "context.taskId"));
  }
  if (!isTrimmedNonEmptyString(context.projectRoot)) {
    issues.push(issue("INVALID_CONTEXT", "context.projectRoot must be a non-empty trimmed string", "context.projectRoot"));
  } else if (containsSensitiveMaterial(context.projectRoot)) {
    issues.push(issue("INVALID_CONTEXT", "context.projectRoot cannot contain credentials or sensitive material", "context.projectRoot"));
  }
  if (!Array.isArray(context.selectedServices)) {
    issues.push(issue("INVALID_CONTEXT", "context.selectedServices must be an array", "context.selectedServices"));
    return { issues };
  }
  const selectedServices: string[] = [];
  const selectedSet = new Set<string>();
  context.selectedServices.forEach((service, index) => {
    if (!isTrimmedNonEmptyString(service)) {
      issues.push(issue("INVALID_CONTEXT", `context.selectedServices[${index}] must be a non-empty trimmed string`, `context.selectedServices[${index}]`));
      return;
    }
    if (containsSensitiveMaterial(service)) {
      issues.push(issue("INVALID_CONTEXT", "context.selectedServices cannot contain credentials or sensitive material", `context.selectedServices[${index}]`));
      return;
    }
    if (selectedSet.has(service)) {
      issues.push(issue("INVALID_CONTEXT", `context.selectedServices contains duplicate ${service}`, "context.selectedServices"));
      return;
    }
    selectedSet.add(service);
    selectedServices.push(service);
  });

  const languageMap = context.languageByService;
  if (
    typeof languageMap !== "object" ||
    languageMap === null ||
    Array.isArray(languageMap) ||
    (Object.getPrototypeOf(languageMap) !== Object.prototype &&
      Object.getPrototypeOf(languageMap) !== null)
  ) {
    issues.push(issue("INVALID_CONTEXT", "context.languageByService must be a plain object", "context.languageByService"));
    return { issues };
  }
  const normalizedLanguages: Record<string, string> = {};
  for (const service of selectedServices) {
    const language = languageMap[service];
    if (!isTrimmedNonEmptyString(language)) {
      issues.push(issue("INVALID_CONTEXT", `Selected service ${service} requires a language mapping`, `context.languageByService.${service}`));
      continue;
    }
    if (containsSensitiveMaterial(language)) {
      issues.push(issue("INVALID_CONTEXT", "Service language cannot contain credentials or sensitive material", `context.languageByService.${service}`));
      continue;
    }
    normalizedLanguages[service] = language;
  }
  for (const service of Object.keys(languageMap)) {
    if (!selectedSet.has(service)) {
      issues.push(issue("INVALID_CONTEXT", `Language mapping for unselected service ${service} is not allowed`, `context.languageByService.${service}`));
    }
  }
  for (const targetService of input.spec.targetServices) {
    if (!selectedSet.has(targetService)) {
      issues.push(issue("INVALID_CONTEXT", `Spec target service ${targetService} is not selected`, "context.selectedServices"));
    }
  }
  if (issues.length > 0) return { issues };
  selectedServices.sort(compareCodeUnits);
  const sortedLanguages: Record<string, string> = {};
  for (const service of selectedServices) sortedLanguages[service] = normalizedLanguages[service]!;
  return {
    issues,
    context: {
      taskId: context.taskId,
      projectRoot: context.projectRoot,
      selectedServices: Object.freeze(selectedServices),
      languageByService: deepFreezeJson(sortedLanguages)
    }
  };
}

function validateSpecBinding(input: HarnessCompileInput): HarnessCompilationIssue[] {
  const issues: HarnessCompilationIssue[] = [];
  const validation = validateSpecRevision(input.spec);
  if (!validation.valid) {
    issues.push(issue("SPEC_INVALID", "Spec revision failed validation", "spec", {
      issues: validation.issues
    }));
  }
  if (input.spec.status !== "approved") {
    issues.push(issue("SPEC_NOT_APPROVED", "Harness compilation requires an approved Spec revision", "spec.status"));
  }
  if (
    isTrimmedNonEmptyString(input.spec.specSetId) &&
    containsSensitiveMaterial(input.spec.specSetId)
  ) {
    issues.push(issue("SPEC_INVALID", "Spec set id cannot contain credentials or sensitive material", "spec.specSetId"));
  }
  const ref = input.governance.specRef;
  if (
    ref === undefined ||
    ref.specSetId !== input.spec.specSetId ||
    ref.revision !== input.spec.revision ||
    ref.digest !== input.spec.digest
  ) {
    issues.push(issue("SPEC_REF_MISMATCH", "Governance snapshot does not bind the exact Spec revision", "governance.specRef"));
  }
  return issues;
}

function governanceSemanticMaterial(snapshot: GovernanceSnapshot): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: snapshot.schemaVersion,
    layers: snapshot.layers,
    policy: snapshot.policy,
    appliedWaivers: snapshot.appliedWaivers,
    decisions: snapshot.decisions,
    ...(snapshot.specRef === undefined ? {} : { specRef: snapshot.specRef }),
    ...(snapshot.workflowRef === undefined ? {} : { workflowRef: snapshot.workflowRef }),
    ...(snapshot.harnessProfileRef === undefined
      ? {}
      : { harnessProfileRef: snapshot.harnessProfileRef })
  };
}

function validateGovernanceDigest(snapshot: GovernanceSnapshot): HarnessCompilationIssue[] {
  if (!isTrimmedNonEmptyString(snapshot.digest) || !SHA256_PATTERN.test(snapshot.digest)) {
    return [issue("GOVERNANCE_DIGEST_MISMATCH", "Governance snapshot digest is invalid", "governance.digest")];
  }
  try {
    const expected = sha256Canonical(governanceSemanticMaterial(snapshot));
    if (expected !== snapshot.digest) {
      return [issue("GOVERNANCE_DIGEST_MISMATCH", "Governance snapshot semantic digest does not match its content", "governance.digest")];
    }
  } catch {
    return [issue("GOVERNANCE_DIGEST_MISMATCH", "Governance snapshot cannot be canonicalized safely", "governance")];
  }
  return [];
}

function validateGovernanceStringArray(
  value: unknown,
  field: string,
  issues: HarnessCompilationIssue[],
  options: { readonly nonEmpty?: boolean; readonly allowed?: ReadonlySet<string> } = {}
): void {
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_GOVERNANCE", `${field} must be an array`, field));
    return;
  }
  if (options.nonEmpty === true && value.length === 0) {
    issues.push(issue("INVALID_GOVERNANCE", `${field} cannot be empty`, field));
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (
      !isTrimmedNonEmptyString(entry) ||
      containsSensitiveMaterial(entry) ||
      (options.allowed !== undefined && !options.allowed.has(entry))
    ) {
      issues.push(issue("INVALID_GOVERNANCE", `${field} contains an invalid or sensitive value`, `${field}[${index}]`));
      continue;
    }
    if (seen.has(entry)) {
      issues.push(issue("INVALID_GOVERNANCE", `${field} cannot contain duplicates`, field));
    }
    seen.add(entry);
  }
  const sorted = [...seen].sort(compareCodeUnits);
  if (
    sorted.length === value.length &&
    sorted.some((entry, index) => entry !== value[index])
  ) {
    issues.push(issue("INVALID_GOVERNANCE", `${field} must use canonical code-unit ordering`, field));
  }
}

function validateGovernanceReference(
  value: unknown,
  field: string,
  issues: HarnessCompilationIssue[]
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(issue("INVALID_GOVERNANCE", `${field} must be a versioned reference`, field));
    return;
  }
  const ref = value as Readonly<Record<string, unknown>>;
  try {
    assertExactDataObject(
      ref,
      ["id", "version", "digest"],
      ["id", "version", "digest"],
      field
    );
  } catch {
    issues.push(issue("INVALID_GOVERNANCE", `${field} contains unsupported fields`, field));
  }
  if (
    !isTrimmedNonEmptyString(ref.id) ||
    containsSensitiveMaterial(ref.id) ||
    !isTrimmedNonEmptyString(ref.version) ||
    containsSensitiveMaterial(ref.version) ||
    !isTrimmedNonEmptyString(ref.digest) ||
    !SHA256_PATTERN.test(ref.digest)
  ) {
    issues.push(issue("INVALID_GOVERNANCE", `${field} contains an invalid or sensitive reference`, field));
  }
}

const GOVERNANCE_SCOPES = Object.freeze([
  "builtin",
  "organization",
  "team",
  "project",
  "service",
  "task"
] as const);
const GOVERNANCE_DECISION_FIELDS = new Set<string>([
  "requiredGates",
  "deny",
  "protectedPaths",
  "allowedProviders",
  "commandAllowlist",
  "networkAllowlist",
  "approvalMode",
  ...GOVERNANCE_BUDGET_FIELDS.map((field) => `budgets.${field}`)
]);

function governanceExactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
  issues: HarnessCompilationIssue[]
): Readonly<Record<string, unknown>> | undefined {
  try {
    assertExactDataObject(value, allowed, required, field);
    return value;
  } catch {
    issues.push(issue(
      "INVALID_GOVERNANCE",
      `${field} must use the exact governance schema`,
      field
    ));
    return undefined;
  }
}

function governanceSourceIdentity(layer: Readonly<Record<string, unknown>>): string | undefined {
  const source = layer.source as Readonly<Record<string, unknown>> | undefined;
  if (source === undefined || !isTrimmedNonEmptyString(source.id)) return undefined;
  const version = isTrimmedNonEmptyString(source.version) ? `@${source.version}` : "";
  const digest = isTrimmedNonEmptyString(source.digest) ? `#${source.digest}` : "";
  return `${String(layer.scope)}:${String(layer.scopeId)}:${source.id}${version}${digest}`;
}

function validateGovernanceLayers(
  value: unknown,
  issues: HarnessCompilationIssue[]
): ReadonlySet<string> {
  const identities = new Set<string>();
  const activeScopeIds = new Map<string, string>();
  const sourceIdentities = new Set<string>();
  let previousSortKey: string | undefined;
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_GOVERNANCE", "governance.layers must be an array", "governance.layers"));
    return identities;
  }
  value.forEach((rawLayer, index) => {
    const field = `governance.layers[${index}]`;
    const layer = governanceExactRecord(
      rawLayer,
      ["scope", "scopeId", "source", "policyDigest"],
      ["scope", "scopeId", "source", "policyDigest"],
      field,
      issues
    );
    if (layer === undefined) return;
    if (!(GOVERNANCE_SCOPES as readonly unknown[]).includes(layer.scope)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance layer scope is invalid", `${field}.scope`));
    }
    if (
      !isTrimmedNonEmptyString(layer.scopeId) ||
      containsSensitiveMaterial(layer.scopeId)
    ) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance layer scope id is invalid or sensitive", `${field}.scopeId`));
    }
    if (isTrimmedNonEmptyString(layer.scope) && isTrimmedNonEmptyString(layer.scopeId)) {
      const activeId = activeScopeIds.get(layer.scope);
      if (activeId !== undefined && activeId !== layer.scopeId) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance scope has multiple active ids", `${field}.scopeId`));
      } else {
        activeScopeIds.set(layer.scope, layer.scopeId);
      }
    }
    if (!isTrimmedNonEmptyString(layer.policyDigest) || !SHA256_PATTERN.test(layer.policyDigest)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance layer policy digest is invalid", `${field}.policyDigest`));
    }
    const source = governanceExactRecord(
      layer.source,
      ["id", "version", "digest"],
      ["id"],
      `${field}.source`,
      issues
    );
    if (source !== undefined) {
      if (!isTrimmedNonEmptyString(source.id) || containsSensitiveMaterial(source.id)) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance layer source id is invalid or sensitive", `${field}.source.id`));
      }
      if (
        source.version !== undefined &&
        (!isTrimmedNonEmptyString(source.version) || containsSensitiveMaterial(source.version))
      ) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance layer source version is invalid or sensitive", `${field}.source.version`));
      }
      if (
        source.digest !== undefined &&
        (!isTrimmedNonEmptyString(source.digest) || !SHA256_PATTERN.test(source.digest))
      ) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance layer source digest is invalid", `${field}.source.digest`));
      }
      if (isTrimmedNonEmptyString(source.id)) {
        const sourceIdentity = `${source.id}${
          isTrimmedNonEmptyString(source.version) ? `@${source.version}` : ""
        }`;
        if (sourceIdentities.has(sourceIdentity)) {
          issues.push(issue("INVALID_GOVERNANCE", "Governance source id and version may only be applied once", `${field}.source`));
        } else {
          sourceIdentities.add(sourceIdentity);
        }
      }
    }
    const identity = governanceSourceIdentity(layer);
    if (identity !== undefined) {
      if (identities.has(identity)) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance layers contain a duplicate source identity", field));
      }
      identities.add(identity);
      const scopeRank = GOVERNANCE_SCOPES.indexOf(
        layer.scope as (typeof GOVERNANCE_SCOPES)[number]
      );
      const sortKey = `${String(scopeRank).padStart(2, "0")}\0${String(layer.scopeId)}\0${identity}`;
      if (previousSortKey !== undefined && compareCodeUnits(previousSortKey, sortKey) > 0) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance layers are not canonically ordered", field));
      }
      previousSortKey = sortKey;
    }
  });
  return identities;
}

interface ValidatedGovernanceWaivers {
  readonly ids: ReadonlySet<string>;
  readonly targets: ReadonlyMap<string, Readonly<{ field: string; value: string }>>;
}

function validateGovernanceWaivers(
  value: unknown,
  resolvedAt: number | undefined,
  layerSourceIds: ReadonlySet<string>,
  issues: HarnessCompilationIssue[]
): ValidatedGovernanceWaivers {
  const waiverIds = new Set<string>();
  const targets = new Map<string, Readonly<{ field: string; value: string }>>();
  let previousOrder: string | undefined;
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_GOVERNANCE", "governance.appliedWaivers must be an array", "governance.appliedWaivers"));
    return { ids: waiverIds, targets };
  }
  value.forEach((rawWaiver, index) => {
    const field = `governance.appliedWaivers[${index}]`;
    const waiver = governanceExactRecord(
      rawWaiver,
      ["id", "target", "scope", "reason", "approvedBy", "approvedAt", "expiresAt", "sourceIds"],
      ["id", "target", "scope", "reason", "approvedBy", "approvedAt", "expiresAt", "sourceIds"],
      field,
      issues
    );
    if (waiver === undefined) return;
    if (!isTrimmedNonEmptyString(waiver.id) || containsSensitiveMaterial(waiver.id)) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver id is invalid or sensitive", `${field}.id`));
    } else if (waiverIds.has(waiver.id)) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver ids must be unique", `${field}.id`));
    } else {
      waiverIds.add(waiver.id);
    }
    const target = governanceExactRecord(
      waiver.target,
      ["field", "value"],
      ["field", "value"],
      `${field}.target`,
      issues
    );
    if (
      target !== undefined &&
      (!new Set(["requiredGates", "deny", "protectedPaths"]).has(target.field as string) ||
        !isTrimmedNonEmptyString(target.value) ||
        containsSensitiveMaterial(target.value))
    ) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver target is invalid or sensitive", `${field}.target`));
    } else if (
      target !== undefined &&
      isTrimmedNonEmptyString(waiver.id) &&
      isTrimmedNonEmptyString(target.field) &&
      isTrimmedNonEmptyString(target.value)
    ) {
      targets.set(waiver.id, { field: target.field, value: target.value });
      const order = `${waiver.id}\0${target.field}\0${target.value}`;
      if (previousOrder !== undefined && compareCodeUnits(previousOrder, order) > 0) {
        issues.push(issue("INVALID_GOVERNANCE", "Applied waivers are not canonically ordered", field));
      }
      previousOrder = order;
    }
    const scope = governanceExactRecord(
      waiver.scope,
      ["level", "id"],
      ["level", "id"],
      `${field}.scope`,
      issues
    );
    if (
      scope !== undefined &&
      (!(GOVERNANCE_SCOPES as readonly unknown[]).includes(scope.level) ||
        !isTrimmedNonEmptyString(scope.id) ||
        containsSensitiveMaterial(scope.id))
    ) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver scope is invalid or sensitive", `${field}.scope`));
    }
    for (const property of ["reason", "approvedBy"] as const) {
      if (!isTrimmedNonEmptyString(waiver[property]) || containsSensitiveMaterial(waiver[property])) {
        issues.push(issue("INVALID_GOVERNANCE", `Applied waiver ${property} is invalid or sensitive`, `${field}.${property}`));
      }
    }
    const approvedAt = strictTimestampMillis(waiver.approvedAt);
    const expiresAt = strictTimestampMillis(waiver.expiresAt);
    if (
      approvedAt === undefined ||
      expiresAt === undefined ||
      approvedAt >= expiresAt ||
      (resolvedAt !== undefined && (approvedAt > resolvedAt || expiresAt <= resolvedAt))
    ) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver is not active at the governance resolution time", field));
    }
    validateGovernanceStringArray(waiver.sourceIds, `${field}.sourceIds`, issues, { nonEmpty: true });
    if (
      Array.isArray(waiver.sourceIds) &&
      waiver.sourceIds.some((sourceId) => !layerSourceIds.has(sourceId))
    ) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver references an unknown layer source", `${field}.sourceIds`));
    }
  });
  return { ids: waiverIds, targets };
}

function expectedDecisionValue(
  field: string,
  policy: Readonly<Record<string, unknown>>
): unknown {
  if (field.startsWith("budgets.")) {
    return (policy.budgets as Readonly<Record<string, unknown>> | undefined)?.[
      field.slice("budgets.".length)
    ];
  }
  return policy[field];
}

function expectedDecisionStrategy(field: string): string {
  if (["requiredGates", "deny", "protectedPaths"].includes(field)) return "union";
  if (["allowedProviders", "commandAllowlist", "networkAllowlist"].includes(field)) return "intersection";
  if (field.startsWith("budgets.")) return "minimum";
  return "strictest";
}

function validateGovernanceDecisions(
  value: unknown,
  policy: Readonly<Record<string, unknown>>,
  layerSourceIds: ReadonlySet<string>,
  waivers: ValidatedGovernanceWaivers,
  issues: HarnessCompilationIssue[]
): void {
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_GOVERNANCE", "governance.decisions must be an array", "governance.decisions"));
    return;
  }
  const fields = new Set<string>();
  const orderedFields: string[] = [];
  const referencedWaivers = new Map<string, string>();
  value.forEach((rawDecision, index) => {
    const fieldPath = `governance.decisions[${index}]`;
    const decision = governanceExactRecord(
      rawDecision,
      ["field", "strategy", "effectiveValue", "sourceIds", "waiverIds", "summary"],
      ["field", "strategy", "effectiveValue", "sourceIds", "summary"],
      fieldPath,
      issues
    );
    if (decision === undefined) return;
    if (!isTrimmedNonEmptyString(decision.field) || !GOVERNANCE_DECISION_FIELDS.has(decision.field)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance decision field is invalid", `${fieldPath}.field`));
      return;
    }
    if (fields.has(decision.field)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance decision fields must be unique", `${fieldPath}.field`));
    }
    fields.add(decision.field);
    orderedFields.push(decision.field);
    if (decision.strategy !== expectedDecisionStrategy(decision.field)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance decision strategy does not match its field", `${fieldPath}.strategy`));
    }
    const expected = expectedDecisionValue(decision.field, policy);
    if (expected === undefined || canonicalJson(expected) !== canonicalJson(decision.effectiveValue)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance decision value does not match effective policy", `${fieldPath}.effectiveValue`));
    }
    validateGovernanceStringArray(decision.sourceIds, `${fieldPath}.sourceIds`, issues);
    if (
      Array.isArray(decision.sourceIds) &&
      decision.sourceIds.some((sourceId) => !layerSourceIds.has(sourceId))
    ) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance decision references an unknown layer source", `${fieldPath}.sourceIds`));
    }
    if (decision.waiverIds !== undefined) {
      validateGovernanceStringArray(decision.waiverIds, `${fieldPath}.waiverIds`, issues, { nonEmpty: true });
      if (
        !Array.isArray(decision.waiverIds) ||
        decision.waiverIds.some((waiverId) => !waivers.ids.has(waiverId))
      ) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance decision references an unknown waiver", `${fieldPath}.waiverIds`));
      }
      if (Array.isArray(decision.waiverIds)) {
        for (const waiverId of decision.waiverIds) {
          if (isTrimmedNonEmptyString(waiverId)) referencedWaivers.set(waiverId, decision.field);
        }
      }
    }
    if (!isTrimmedNonEmptyString(decision.summary) || containsSensitiveMaterial(decision.summary)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance decision summary is invalid or sensitive", `${fieldPath}.summary`));
    }
  });
  const expectedFields = ["requiredGates", "deny", "protectedPaths"];
  for (const optional of ["allowedProviders", "commandAllowlist", "networkAllowlist"]) {
    if (policy[optional] !== undefined) expectedFields.push(optional);
  }
  if (typeof policy.budgets === "object" && policy.budgets !== null) {
    for (const budget of GOVERNANCE_BUDGET_FIELDS) {
      if (Object.hasOwn(policy.budgets, budget)) expectedFields.push(`budgets.${budget}`);
    }
  }
  expectedFields.push("approvalMode");
  if (
    expectedFields.length !== orderedFields.length ||
    expectedFields.some((field, index) => orderedFields[index] !== field)
  ) {
    issues.push(issue("INVALID_GOVERNANCE", "Governance decisions do not cover the effective policy", "governance.decisions"));
  }
  for (const [waiverId, target] of waivers.targets) {
    const effectiveValues = policy[target.field];
    if (Array.isArray(effectiveValues) && effectiveValues.includes(target.value)) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver target remains active in effective policy", "governance.appliedWaivers"));
    }
    if (referencedWaivers.get(waiverId) !== target.field) {
      issues.push(issue("INVALID_GOVERNANCE", "Applied waiver is not traced by its target decision", "governance.decisions"));
    }
  }
}

function validateGovernanceSemantics(
  snapshot: GovernanceSnapshot
): HarnessCompilationIssue[] {
  const issues: HarnessCompilationIssue[] = [];
  governanceExactRecord(
    snapshot,
    ["schemaVersion", "resolvedAt", "layers", "policy", "appliedWaivers", "decisions", "specRef", "workflowRef", "harnessProfileRef", "digest"],
    ["schemaVersion", "resolvedAt", "layers", "policy", "appliedWaivers", "decisions", "specRef", "workflowRef", "harnessProfileRef", "digest"],
    "governance",
    issues
  );
  if (snapshot.schemaVersion !== 1) {
    issues.push(issue("INVALID_GOVERNANCE", "Governance schemaVersion must be 1", "governance.schemaVersion"));
  }
  const policy = snapshot.policy as unknown as Readonly<Record<string, unknown>>;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [issue("INVALID_GOVERNANCE", "Governance policy must be an object", "governance.policy")];
  }
  const allowedPolicyFields = new Set([
    "requiredGates",
    "deny",
    "protectedPaths",
    "allowedProviders",
    "commandAllowlist",
    "networkAllowlist",
    "budgets",
    "approvalMode"
  ]);
  if (Object.keys(policy).some((field) => !allowedPolicyFields.has(field))) {
    issues.push(issue("INVALID_GOVERNANCE", "Governance policy contains unsupported fields", "governance.policy"));
  }
  for (const required of ["requiredGates", "deny", "protectedPaths", "budgets", "approvalMode"]) {
    if (!Object.hasOwn(policy, required)) {
      issues.push(issue("INVALID_GOVERNANCE", "Governance policy is missing a required field", `governance.policy.${required}`));
    }
  }
  validateGovernanceStringArray(policy.requiredGates, "governance.policy.requiredGates", issues);
  validateGovernanceStringArray(policy.deny, "governance.policy.deny", issues);
  validateGovernanceStringArray(policy.protectedPaths, "governance.policy.protectedPaths", issues);
  if (policy.allowedProviders !== undefined) {
    validateGovernanceStringArray(
      policy.allowedProviders,
      "governance.policy.allowedProviders",
      issues,
      { nonEmpty: true, allowed: new Set(["claude", "codex"]) }
    );
  }
  if (policy.commandAllowlist !== undefined) {
    validateGovernanceStringArray(
      policy.commandAllowlist,
      "governance.policy.commandAllowlist",
      issues,
      { nonEmpty: true }
    );
  }
  if (policy.networkAllowlist !== undefined) {
    validateGovernanceStringArray(
      policy.networkAllowlist,
      "governance.policy.networkAllowlist",
      issues,
      { nonEmpty: true }
    );
  }
  if (!new Set(["never", "on-risk", "before-merge"]).has(policy.approvalMode as string)) {
    issues.push(issue("INVALID_GOVERNANCE", "Governance approvalMode is invalid", "governance.policy.approvalMode"));
  }

  const budgets = policy.budgets;
  if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) {
    issues.push(issue("INVALID_GOVERNANCE", "Governance budgets must be an object", "governance.policy.budgets"));
  } else {
    for (const [field, value] of Object.entries(budgets)) {
      if (!(GOVERNANCE_BUDGET_FIELDS as readonly string[]).includes(field)) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance budgets contain an unsupported field", `governance.policy.budgets.${field}`));
        continue;
      }
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (COUNT_GOVERNANCE_BUDGET_FIELDS.has(field) && !Number.isSafeInteger(value))
      ) {
        issues.push(issue("INVALID_GOVERNANCE", "Governance budget value violates numeric invariants", `governance.policy.budgets.${field}`));
      }
    }
  }

  const resolvedAt = strictTimestampMillis(snapshot.resolvedAt);
  if (resolvedAt === undefined) {
    issues.push(issue("INVALID_GOVERNANCE", "Governance resolvedAt must be a strict RFC3339 timestamp", "governance.resolvedAt"));
  }
  const layerSourceIds = validateGovernanceLayers(snapshot.layers, issues);
  const waivers = validateGovernanceWaivers(
    snapshot.appliedWaivers,
    resolvedAt,
    layerSourceIds,
    issues
  );
  validateGovernanceDecisions(
    snapshot.decisions,
    policy,
    layerSourceIds,
    waivers,
    issues
  );

  const specRef = snapshot.specRef;
  governanceExactRecord(
    specRef,
    ["specSetId", "revision", "digest"],
    ["specSetId", "revision", "digest"],
    "governance.specRef",
    issues
  );
  if (
    specRef === undefined ||
    !isTrimmedNonEmptyString(specRef.specSetId) ||
    containsSensitiveMaterial(specRef.specSetId) ||
    !Number.isSafeInteger(specRef.revision) ||
    specRef.revision < 1 ||
    !isTrimmedNonEmptyString(specRef.digest) ||
    !SHA256_PATTERN.test(specRef.digest)
  ) {
    issues.push(issue("INVALID_GOVERNANCE", "Governance specRef is invalid or sensitive", "governance.specRef"));
  }
  validateGovernanceReference(snapshot.workflowRef, "governance.workflowRef", issues);
  validateGovernanceReference(snapshot.harnessProfileRef, "governance.harnessProfileRef", issues);
  return issues;
}

function validateProfileBinding(input: HarnessCompileInput): HarnessCompilationIssue[] {
  let expected: string;
  try {
    expected = digestHarnessProfile(input.profile);
  } catch {
    return [issue("PROFILE_REF_MISMATCH", "Harness profile cannot be canonicalized safely", "profile")];
  }
  const ref = input.governance.harnessProfileRef;
  if (
    input.profile.digest !== expected ||
    ref === undefined ||
    ref.id !== input.profile.id ||
    ref.version !== input.profile.version ||
    ref.digest === undefined ||
    ref.digest !== expected
  ) {
    return [issue("PROFILE_REF_MISMATCH", "Governance snapshot must bind the exact Harness profile id, version and digest", "governance.harnessProfileRef")];
  }
  return [];
}

function validateTemporalOrdering(
  input: HarnessCompileInput,
  generatedAt: string
): HarnessCompilationIssue[] {
  const generatedTime = strictTimestampMillis(generatedAt);
  const createdTime = strictTimestampMillis(input.spec.createdAt);
  const approvedTime = strictTimestampMillis(input.spec.approvedAt);
  const resolvedTime = strictTimestampMillis(input.governance.resolvedAt);
  const predecessors = [createdTime, approvedTime, resolvedTime].filter(
    (value): value is number => value !== undefined
  );
  if (
    generatedTime === undefined ||
    predecessors.some((predecessor) => generatedTime < predecessor)
  ) {
    return [issue(
      "INVALID_GENERATED_AT",
      "Harness generatedAt cannot precede Spec creation/approval or Governance resolution",
      "now"
    )];
  }
  return [];
}

function normalizeFragment(
  sourceId: string,
  fragment: unknown,
  requiredByProfile: ReadonlySet<string>
): HarnessContextFragment {
  const snapshot = cloneSafeJsonValue(fragment);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", `Context source ${sourceId} returned a non-object fragment`, `contextSources.${sourceId}`)
    ]);
  }
  const candidate = snapshot as unknown as ContextFragmentInput;
  if (
    !isTrimmedNonEmptyString(candidate.id) ||
    !isTrimmedNonEmptyString(candidate.kind) ||
    !isTrimmedNonEmptyString(candidate.source) ||
    typeof candidate.content !== "string" ||
    !Number.isFinite(candidate.priority) ||
    (candidate.required !== undefined && typeof candidate.required !== "boolean") ||
    (candidate.metadata !== undefined &&
      (typeof candidate.metadata !== "object" ||
        candidate.metadata === null ||
        Array.isArray(candidate.metadata)))
  ) {
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", `Context fragment from ${sourceId} is invalid`, `contextSources.${sourceId}`)
    ]);
  }
  if (
    containsSensitiveMaterial(candidate.id) ||
    containsSensitiveMaterial(candidate.kind)
  ) {
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", "Context fragment identifiers cannot contain sensitive material", `contextSources.${sourceId}`)
    ]);
  }
  const sanitizedSource = redactContextContent(candidate.source);
  // Secret material is never allowed in a persisted HarnessManifest. The
  // profile flag is retained in the signed profile identity for compatibility,
  // but cannot weaken this bottom-line boundary.
  const content = redactContextContent(candidate.content);
  const contentDigest = createHash("sha256").update(content, "utf8").digest("hex");
  const metadata = candidate.metadata === undefined
    ? undefined
    : redactSensitiveValue(candidate.metadata);
  const payload = {
    id: candidate.id,
    kind: candidate.kind,
    source: sanitizedSource,
    sourceId,
    content,
    priority: candidate.priority,
    // A collector may carry the legacy `required` hint, but only the signed
    // profile is authoritative for fail-closed budget behavior.
    required: requiredByProfile.has(candidate.id),
    contentDigest,
    ...(metadata === undefined ? {} : { metadata })
  };
  // Account for the complete serialized persisted fragment, including source,
  // metadata, structural keys and digests. byteLength participates in the
  // digest, so converge the small decimal-width fixed point deterministically.
  let byteLength = 0;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const semantic = {
      ...payload,
      byteLength,
      tokenEstimate: byteLength
    };
    const normalized = {
      ...cloneCanonical(semantic),
      digest: sha256Digest(semantic)
    };
    const serializedBytes = Buffer.byteLength(canonicalJson(normalized), "utf8");
    if (serializedBytes === byteLength) return normalized;
    byteLength = serializedBytes;
  }
  throw new HarnessCompilationError([
    issue("INVALID_CONTEXT", "Context fragment size did not converge safely", `contextSources.${sourceId}`)
  ]);
}

function serializedFragmentArrayBytes(
  fragments: readonly HarnessContextFragment[]
): number {
  if (fragments.length === 0) return 0;
  return Buffer.byteLength(canonicalJson(fragments), "utf8");
}

class CollectionBoundaryError extends Error {
  constructor(readonly kind: "timeout" | "cancelled") {
    super(kind);
  }
}

function collectorRequest(
  context: NormalizedCompileContext,
  signal: AbortSignal
): ContextCollectionRequest {
  const snapshot = deepFreezeJson(cloneSafeJsonValue({
    taskId: context.taskId,
    projectRoot: context.projectRoot,
    selectedServices: context.selectedServices,
    languageByService: context.languageByService
  }));
  return Object.freeze({ ...snapshot, signal });
}

async function collectSource(
  source: ContextSource,
  context: NormalizedCompileContext,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<readonly ContextFragmentInput[]> {
  if (externalSignal?.aborted === true) {
    throw new HarnessCompilationError([
      issue("COMPILATION_CANCELLED", "Harness compilation was cancelled", "signal")
    ]);
  }
  const controller = new AbortController();
  let rejectBoundary: ((reason: CollectionBoundaryError) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const cancel = (): void => {
    rejectBoundary?.(new CollectionBoundaryError("cancelled"));
    controller.abort();
  };
  externalSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    rejectBoundary?.(new CollectionBoundaryError("timeout"));
    controller.abort();
  }, timeoutMs);
  try {
    const request = collectorRequest(context, controller.signal);
    const collection = Promise.resolve().then(() => source.collect(request));
    return await Promise.race([collection, boundary]);
  } catch (error) {
    if (error instanceof HarnessCompilationError) throw error;
    if (error instanceof CollectionBoundaryError) {
      if (error.kind === "cancelled") {
        throw new HarnessCompilationError([
          issue("COMPILATION_CANCELLED", "Harness compilation was cancelled", "signal")
        ]);
      }
      throw new HarnessCompilationError([
        issue("CONTEXT_SOURCE_TIMEOUT", `Context source ${source.id} exceeded its collection timeout`, `contextSources.${source.id}`)
      ]);
    }
    throw new HarnessCompilationError([
      issue("CONTEXT_SOURCE_FAILED", `Context source ${source.id} failed`, `contextSources.${source.id}`, {
        cause: safeRedactedErrorMessage(error)
      })
    ]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", cancel);
  }
}

function snapshotCollectedFragments(
  value: readonly ContextFragmentInput[],
  sourceId: string
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", "Context collector must return an array", `contextSources.${sourceId}`)
    ]);
  }
  const result: unknown[] = [];
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (
        typeof key === "symbol" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
        Number(key) >= value.length
      ) {
        throw new TypeError("unsafe array property");
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      result.push(ownEnumerableDataProperty(value, String(index)));
    }
  } catch {
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", "Context collector array must contain only enumerable data indices", `contextSources.${sourceId}`)
    ]);
  }
  return Object.freeze(result);
}

async function compileContextUnsafe(
  input: HarnessCompileInput,
  normalized: NormalizedCompileContext
): Promise<HarnessContextManifest> {
  if (input.signal?.aborted === true) {
    throw new HarnessCompilationError([
      issue("COMPILATION_CANCELLED", "Harness compilation was cancelled", "signal")
    ]);
  }
  const listedSources = input.registry.listContextSources();
  if (!Array.isArray(listedSources)) {
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", "Capability registry did not return a context source array", "registry.contextSources")
    ]);
  }
  const sources: ContextSource[] = [];
  const sourceIds = new Set<string>();
  for (const source of listedSources) {
    if (
      typeof source !== "object" ||
      source === null ||
      !isTrimmedNonEmptyString(source.id) ||
      containsSensitiveMaterial(source.id) ||
      typeof source.collect !== "function"
    ) {
      throw new HarnessCompilationError([
        issue("INVALID_CONTEXT", "Capability registry contains an invalid context source", "registry.contextSources")
      ]);
    }
    if (sourceIds.has(source.id)) {
      throw new HarnessCompilationError([
        issue("INVALID_CONTEXT", `Context source ${source.id} appears more than once`, `contextSources.${source.id}`)
      ]);
    }
    sourceIds.add(source.id);
    sources.push(source);
  }
  sources.sort((left, right) => compareCodeUnits(left.id, right.id));

  const requiredSources = new Set(input.profile.requiredContextSourceIds ?? []);
  const missingSources = [...requiredSources]
    .filter((sourceId) => !sourceIds.has(sourceId))
    .sort(compareCodeUnits);
  if (missingSources.length > 0) {
    throw new HarnessCompilationError(missingSources.map((sourceId) =>
      issue("MISSING_REQUIRED_CONTEXT_SOURCE", `Required context source ${sourceId} is not registered`, `contextSources.${sourceId}`)
    ));
  }

  const requiredFragments = new Set(input.profile.requiredContextFragmentIds ?? []);
  const fragments: HarnessContextFragment[] = [];
  const identifiers = new Map<string, string>();
  let rawAggregateBytes = 0;
  const scaledRawLimit = Number.isSafeInteger(input.profile.maxContextBytes * 16)
    ? input.profile.maxContextBytes * 16
    : RAW_CONTEXT_ABSOLUTE_LIMIT_BYTES;
  const rawAggregateLimit = Math.min(
    RAW_CONTEXT_ABSOLUTE_LIMIT_BYTES,
    Math.max(RAW_CONTEXT_MINIMUM_LIMIT_BYTES, scaledRawLimit)
  );
  const timeoutMs = input.profile.contextSourceTimeoutMs ?? DEFAULT_CONTEXT_SOURCE_TIMEOUT_MS;
  for (const source of sources) {
    const collected = await collectSource(source, normalized, timeoutMs, input.signal);
    const candidates = snapshotCollectedFragments(collected, source.id);
    for (const candidate of candidates) {
      const rawBytes = Buffer.byteLength(canonicalJson(candidate), "utf8");
      rawAggregateBytes += rawBytes + (rawAggregateBytes === 0 ? 2 : 1);
      if (!Number.isSafeInteger(rawAggregateBytes) || rawAggregateBytes > rawAggregateLimit) {
        throw new HarnessCompilationError([
          issue(
            "INVALID_CONTEXT",
            "Raw context aggregate exceeds the hard collection boundary",
            `contextSources.${source.id}`
          )
        ]);
      }
      const fragment = normalizeFragment(
        source.id,
        candidate,
        requiredFragments
      );
      const previous = identifiers.get(fragment.id);
      if (previous !== undefined) {
        throw new HarnessCompilationError([
          issue("DUPLICATE_CONTEXT", `Context fragment ${fragment.id} is declared by both ${previous} and ${source.id}`, `context.${fragment.id}`)
        ]);
      }
      identifiers.set(fragment.id, source.id);
      fragments.push(fragment);
    }
  }

  const missingFragments = [...requiredFragments]
    .filter((fragmentId) => !identifiers.has(fragmentId))
    .sort(compareCodeUnits);
  if (missingFragments.length > 0) {
    throw new HarnessCompilationError(missingFragments.map((fragmentId) =>
      issue("MISSING_REQUIRED_CONTEXT_FRAGMENT", `Required context fragment ${fragmentId} was not produced`, `context.${fragmentId}`)
    ));
  }

  fragments.sort((left, right) =>
    left.priority === right.priority
      ? compareCodeUnits(left.id, right.id) || compareCodeUnits(left.sourceId, right.sourceId)
      : left.priority > right.priority ? -1 : 1
  );
  const selected: HarnessContextFragment[] = [];
  const omitted: OmittedContextFragment[] = [];
  let usedBytes = 0;
  let usedTokens = 0;
  for (const fragment of fragments) {
    const candidateBytes = serializedFragmentArrayBytes([...selected, fragment]);
    const candidateTokens = candidateBytes;
    const exceedsBytes = candidateBytes > input.profile.maxContextBytes;
    const exceedsTokens = candidateTokens > input.profile.maxContextTokens;
    if (exceedsBytes || exceedsTokens) {
      if (fragment.required) {
        throw new HarnessCompilationError([
          issue("REQUIRED_CONTEXT_BUDGET", `Required context fragment ${fragment.id} exceeds the configured context budget`, `context.${fragment.id}`)
        ]);
      }
      omitted.push({
        id: fragment.id,
        sourceId: fragment.sourceId,
        reason: exceedsBytes ? "byte_budget" : "token_budget",
        byteLength: fragment.byteLength,
        tokenEstimate: fragment.tokenEstimate,
        contentDigest: fragment.contentDigest,
        digest: fragment.digest
      });
      continue;
    }
    selected.push(fragment);
    usedBytes = candidateBytes;
    usedTokens = candidateTokens;
  }
  const semantic = {
    fragments: selected,
    omitted,
    usedBytes,
    usedTokens,
    maxBytes: input.profile.maxContextBytes,
    maxTokens: input.profile.maxContextTokens,
    tokenEstimator: TOKEN_ESTIMATOR
  };
  return {
    ...cloneCanonical(semantic),
    digest: sha256Digest(semantic)
  };
}

async function compileContext(
  input: HarnessCompileInput,
  normalized: NormalizedCompileContext
): Promise<HarnessContextManifest> {
  try {
    return await compileContextUnsafe(input, normalized);
  } catch (error) {
    if (error instanceof HarnessCompilationError) throw error;
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", "Context collection contained an unsafe value", "context", {
        cause: safeRedactedErrorMessage(error)
      })
    ]);
  }
}

function compileGatePlan(
  input: HarnessCompileInput,
  normalized: NormalizedCompileContext
): HarnessGatePlanItem[] {
  const issues: HarnessCompilationIssue[] = [];
  const plan: HarnessGatePlanItem[] = [];
  const languages = [...new Set(Object.values(normalized.languageByService))]
    .sort(compareCodeUnits);
  // A gate resolved into `requiredGates` is never optional. The legacy profile
  // flag remains part of the signed profile identity, but cannot weaken this
  // invariant (and therefore cannot weaken enterprise/enforced execution).
  const requiredGateFailureIsMandatory = true;
  for (const gateId of [...input.governance.policy.requiredGates].sort(compareCodeUnits)) {
    const runner = input.registry.getGateRunner(gateId);
    if (runner === undefined) {
      if (requiredGateFailureIsMandatory) {
        issues.push(issue("MISSING_REQUIRED_GATE", `No runner is registered for required gate ${gateId}`, `gates.${gateId}`));
      }
      continue;
    }
    if (
      runner.id !== gateId ||
      containsSensitiveMaterial(runner.id) ||
      !isTrimmedNonEmptyString(runner.version) ||
      containsSensitiveMaterial(runner.version) ||
      !Array.isArray(runner.languages) ||
      runner.languages.length === 0 ||
      runner.languages.some((language) =>
        !isTrimmedNonEmptyString(language) || containsSensitiveMaterial(language)
      ) ||
      new Set(runner.languages).size !== runner.languages.length ||
      typeof runner.run !== "function"
    ) {
      issues.push(issue("MISSING_REQUIRED_GATE", `Runner for required gate ${gateId} has invalid capabilities`, `gates.${gateId}`));
      continue;
    }
    const runnerLanguages = [...runner.languages].sort(compareCodeUnits);
    const unsupported = languages.filter((language) => !runnerLanguages.includes(language));
    if (unsupported.length > 0) {
      if (requiredGateFailureIsMandatory) {
        issues.push(issue("MISSING_REQUIRED_GATE", `Gate ${gateId} does not support required languages: ${unsupported.join(", ")}`, `gates.${gateId}`, { unsupported }));
      }
      continue;
    }
    plan.push({
      id: gateId,
      runnerId: runner.id,
      runnerVersion: runner.version,
      languages: runnerLanguages,
      required: true
    });
  }
  if (issues.length > 0) throw new HarnessCompilationError(issues);
  return plan;
}

function compileSandboxPlan(
  input: HarnessCompileInput,
  sandbox: SandboxBackend
): HarnessSandboxPlan {
  const issues: HarnessCompilationIssue[] = [];
  if (
    sandbox.id !== input.profile.sandboxBackendId ||
    !isTrimmedNonEmptyString(sandbox.id) ||
    containsSensitiveMaterial(sandbox.id) ||
    !isTrimmedNonEmptyString(sandbox.version) ||
    containsSensitiveMaterial(sandbox.version) ||
    !isSandboxEnforcement(sandbox.enforcement) ||
    !Array.isArray(sandbox.capabilities) ||
    sandbox.capabilities.some((capability) =>
      !isTrimmedNonEmptyString(capability) || containsSensitiveMaterial(capability)
    ) ||
    new Set(sandbox.capabilities).size !== sandbox.capabilities.length ||
    typeof sandbox.prepare !== "function"
  ) {
    issues.push(issue("INVALID_SANDBOX", `Sandbox ${input.profile.sandboxBackendId} has invalid capability metadata`, "sandbox"));
  }
  if (issues.length === 0 && isSandboxEnforcement(input.profile.minimumSandboxEnforcement)) {
    if (ENFORCEMENT_RANK[sandbox.enforcement] < ENFORCEMENT_RANK[input.profile.minimumSandboxEnforcement]) {
      issues.push(issue("INSUFFICIENT_SANDBOX", `Sandbox ${sandbox.id} provides ${sandbox.enforcement}, below required ${input.profile.minimumSandboxEnforcement}`, "sandbox.enforcement"));
    }
  }
  if (
    issues.length === 0 &&
    isEnterpriseProfileId(input.profile.id) &&
    sandbox.enforcement !== "enforced"
  ) {
    issues.push(issue(
      "INSUFFICIENT_SANDBOX",
      "Enterprise Harness profiles cannot use a non-enforced sandbox",
      "sandbox.enforcement"
    ));
  }
  const runtimeImage = sandbox.runtimeImage;
  if (
    issues.length === 0 &&
    runtimeImage !== undefined &&
    (
      !isTrimmedNonEmptyString(runtimeImage.reference) ||
      containsSensitiveMaterial(runtimeImage.reference) ||
      !SHA256_PATTERN.test(runtimeImage.digest)
    )
  ) {
    issues.push(issue(
      "INVALID_SANDBOX",
      "Sandbox runtime image must have a safe reference and content-addressed SHA-256 digest",
      "sandbox.runtimeImage"
    ));
  }
  if (
    issues.length === 0 &&
    isEnterpriseProfileId(input.profile.id) &&
    runtimeImage === undefined
  ) {
    issues.push(issue(
      "INVALID_SANDBOX",
      "Enterprise Harness profiles require a content-addressed runtime image",
      "sandbox.runtimeImage"
    ));
  }
  const capabilities = Array.isArray(sandbox.capabilities)
    ? [...sandbox.capabilities].sort(compareCodeUnits)
    : [];
  const missingCapabilities = (input.profile.requiredSandboxCapabilities ?? [])
    .filter((capability) => !capabilities.includes(capability))
    .sort(compareCodeUnits);
  for (const capability of missingCapabilities) {
    issues.push(issue("MISSING_SANDBOX_CAPABILITY", `Sandbox ${sandbox.id} lacks required capability ${capability}`, `sandbox.capabilities.${capability}`));
  }
  if (issues.length > 0) throw new HarnessCompilationError(issues);
  return {
    backendId: sandbox.id,
    backendVersion: sandbox.version,
    enforcement: sandbox.enforcement,
    capabilities,
    ...(runtimeImage ? { runtimeImage: { ...runtimeImage } } : {})
  };
}

function invalidCapabilityRegistry(message: string, field: string): never {
  throw new HarnessCompilationError([
    issue("INVALID_CAPABILITY_REGISTRY", message, field)
  ]);
}

function snapshotGateRunner(
  raw: GateRunner | undefined,
  gateId: string
): GateRunner | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    return invalidCapabilityRegistry("Gate runner must be an object", `gates.${gateId}`);
  }
  let metadata: Readonly<{ id: string; version: string; languages: readonly string[] }>;
  let run: GateRunner["run"];
  try {
    metadata = deepFreezeJson(cloneCanonical({
      id: ownEnumerableDataProperty(raw, "id"),
      version: ownEnumerableDataProperty(raw, "version"),
      languages: ownEnumerableDataProperty(raw, "languages")
    }));
    run = callableDataProperty<GateRunner["run"]>(raw, "run");
  } catch {
    return invalidCapabilityRegistry("Gate runner metadata cannot be snapshotted safely", `gates.${gateId}`);
  }
  if (
    metadata.id !== gateId ||
    !isTrimmedNonEmptyString(metadata.id) ||
    containsSensitiveMaterial(metadata.id) ||
    !isTrimmedNonEmptyString(metadata.version) ||
    containsSensitiveMaterial(metadata.version) ||
    !Array.isArray(metadata.languages) ||
    metadata.languages.length === 0 ||
    metadata.languages.some((language) =>
      !isTrimmedNonEmptyString(language) ||
      containsSensitiveMaterial(language)
    ) ||
    new Set(metadata.languages).size !== metadata.languages.length ||
    typeof run !== "function"
  ) {
    return invalidCapabilityRegistry("Gate runner capability metadata or operation is invalid", `gates.${gateId}`);
  }
  const languages = Object.freeze([...metadata.languages].sort(compareCodeUnits));
  return Object.freeze({
    id: metadata.id,
    version: metadata.version,
    languages,
    run(request: Parameters<GateRunner["run"]>[0]) {
      return Reflect.apply(run, raw, [request]);
    }
  });
}

function snapshotSandboxBackend(
  raw: SandboxBackend | undefined,
  expectedId: string
): SandboxBackend | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    return invalidCapabilityRegistry("Sandbox backend must be an object", `sandboxes.${expectedId}`);
  }
  let metadata: Readonly<{
    id: string;
    version: string;
    enforcement: SandboxEnforcement;
    capabilities: readonly string[];
    runtimeImage?: Readonly<{ reference: string; digest: string }>;
  }>;
  let prepare: SandboxBackend["prepare"];
  try {
    metadata = deepFreezeJson(cloneCanonical({
      id: ownEnumerableDataProperty(raw, "id"),
      version: ownEnumerableDataProperty(raw, "version"),
      enforcement: ownEnumerableDataProperty(raw, "enforcement"),
      capabilities: ownEnumerableDataProperty(raw, "capabilities"),
      ...(Object.hasOwn(raw, "runtimeImage")
        ? { runtimeImage: ownEnumerableDataProperty(raw, "runtimeImage") }
        : {})
    }));
    prepare = callableDataProperty<SandboxBackend["prepare"]>(raw, "prepare");
  } catch {
    return invalidCapabilityRegistry("Sandbox metadata cannot be snapshotted safely", `sandboxes.${expectedId}`);
  }
  if (
    metadata.id !== expectedId ||
    !isTrimmedNonEmptyString(metadata.id) ||
    containsSensitiveMaterial(metadata.id) ||
    !isTrimmedNonEmptyString(metadata.version) ||
    containsSensitiveMaterial(metadata.version) ||
    !isSandboxEnforcement(metadata.enforcement) ||
    !Array.isArray(metadata.capabilities) ||
    metadata.capabilities.some((capability) =>
      !isTrimmedNonEmptyString(capability) ||
      containsSensitiveMaterial(capability)
    ) ||
    new Set(metadata.capabilities).size !== metadata.capabilities.length
  ) {
    throw new HarnessCompilationError([
      issue("INVALID_SANDBOX", "Sandbox capability metadata is invalid", `sandboxes.${expectedId}`)
    ]);
  }
  if (typeof prepare !== "function") {
    return invalidCapabilityRegistry("Sandbox prepare operation is invalid", `sandboxes.${expectedId}`);
  }
  if (
    metadata.runtimeImage !== undefined &&
    (
      !isTrimmedNonEmptyString(metadata.runtimeImage.reference) ||
      containsSensitiveMaterial(metadata.runtimeImage.reference) ||
      !SHA256_PATTERN.test(metadata.runtimeImage.digest)
    )
  ) {
    throw new HarnessCompilationError([
      issue("INVALID_SANDBOX", "Sandbox runtime image identity is invalid", `sandboxes.${expectedId}.runtimeImage`)
    ]);
  }
  const capabilities = Object.freeze(
    [...metadata.capabilities].sort(compareCodeUnits)
  );
  return Object.freeze({
    id: metadata.id,
    version: metadata.version,
    enforcement: metadata.enforcement,
    capabilities,
    ...(metadata.runtimeImage ? { runtimeImage: metadata.runtimeImage } : {}),
    prepare(request: Parameters<SandboxBackend["prepare"]>[0]) {
      return Reflect.apply(prepare, raw, [request]);
    }
  });
}

function snapshotContextSource(raw: ContextSource, index: number): ContextSource {
  if (typeof raw !== "object" || raw === null) {
    return invalidCapabilityRegistry("Context source must be an object", `contextSources[${index}]`);
  }
  let id: string;
  let collect: ContextSource["collect"];
  try {
    id = cloneCanonical(ownEnumerableDataProperty(raw, "id"));
    collect = callableDataProperty<ContextSource["collect"]>(raw, "collect");
  } catch {
    return invalidCapabilityRegistry("Context source cannot be snapshotted safely", `contextSources[${index}]`);
  }
  if (
    !isTrimmedNonEmptyString(id) ||
    containsSensitiveMaterial(id) ||
    typeof collect !== "function"
  ) {
    return invalidCapabilityRegistry("Context source id or operation is invalid", `contextSources[${index}]`);
  }
  return Object.freeze({
    id,
    collect(request: Parameters<ContextSource["collect"]>[0]) {
      return Reflect.apply(collect, raw, [request]);
    }
  });
}

function snapshotCapabilityRegistry(
  raw: CapabilityRegistryLike,
  requiredGateIds: readonly string[],
  sandboxBackendId: string | undefined
): CapabilityRegistryLike {
  // Functions cannot participate in canonical JSON. Capture each callable once
  // as a data function, while canonical-cloning and freezing all capability
  // metadata before any collector is invoked.
  if (typeof raw !== "object" || raw === null) {
    return invalidCapabilityRegistry("Capability registry must be an object", "registry");
  }
  let getGateRunner: CapabilityRegistryLike["getGateRunner"];
  let getSandboxBackend: CapabilityRegistryLike["getSandboxBackend"];
  let listContextSources: CapabilityRegistryLike["listContextSources"];
  try {
    const methods = [
      "registerGateRunner",
      "registerSandboxBackend",
      "registerContextSource",
      "getGateRunner",
      "getSandboxBackend",
      "listContextSources"
    ] as const;
    for (const method of methods) {
      callableDataProperty(raw, method);
    }
    const rawGetGateRunner = callableDataProperty<CapabilityRegistryLike["getGateRunner"]>(raw, "getGateRunner");
    const rawGetSandboxBackend = callableDataProperty<CapabilityRegistryLike["getSandboxBackend"]>(raw, "getSandboxBackend");
    const rawListContextSources = callableDataProperty<CapabilityRegistryLike["listContextSources"]>(raw, "listContextSources");
    getGateRunner = (id) => Reflect.apply(rawGetGateRunner, raw, [id]);
    getSandboxBackend = (id) => Reflect.apply(rawGetSandboxBackend, raw, [id]);
    listContextSources = () => Reflect.apply(rawListContextSources, raw, []);
  } catch {
    return invalidCapabilityRegistry("Capability registry methods cannot be snapshotted safely", "registry");
  }

  let listedSources: readonly ContextSource[];
  try {
    listedSources = listContextSources();
  } catch {
    return invalidCapabilityRegistry("Context source registry lookup failed", "registry.listContextSources");
  }
  if (!Array.isArray(listedSources)) {
    return invalidCapabilityRegistry("Context source registry must return an array", "registry.listContextSources");
  }
  const sources: ContextSource[] = [];
  try {
    for (const key of Reflect.ownKeys(listedSources)) {
      if (key === "length") continue;
      if (
        typeof key === "symbol" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
        Number(key) >= listedSources.length
      ) {
        return invalidCapabilityRegistry("Context source array contains unsafe properties", "registry.listContextSources");
      }
    }
    for (let index = 0; index < listedSources.length; index += 1) {
      const source = ownEnumerableDataProperty<ContextSource>(
        listedSources,
        String(index)
      );
      sources.push(snapshotContextSource(source, index));
    }
  } catch (error) {
    if (error instanceof HarnessCompilationError) throw error;
    return invalidCapabilityRegistry("Context source array cannot be snapshotted safely", "registry.listContextSources");
  }
  sources.sort((left, right) => compareCodeUnits(left.id, right.id));
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      return invalidCapabilityRegistry("Context source ids must be unique", "registry.listContextSources");
    }
    sourceIds.add(source.id);
  }
  const frozenSources = Object.freeze(sources);

  const gates = new Map<string, GateRunner | undefined>();
  for (const gateId of [...new Set(requiredGateIds)].sort(compareCodeUnits)) {
    let rawRunner: GateRunner | undefined;
    try {
      rawRunner = getGateRunner(gateId);
    } catch {
      return invalidCapabilityRegistry("Gate runner registry lookup failed", `gates.${gateId}`);
    }
    gates.set(gateId, snapshotGateRunner(rawRunner, gateId));
  }

  let sandbox: SandboxBackend | undefined;
  if (sandboxBackendId !== undefined) {
    let rawSandbox: SandboxBackend | undefined;
    try {
      rawSandbox = getSandboxBackend(sandboxBackendId);
    } catch {
      return invalidCapabilityRegistry("Sandbox registry lookup failed", `sandboxes.${sandboxBackendId}`);
    }
    sandbox = snapshotSandboxBackend(rawSandbox, sandboxBackendId);
  }

  const immutableMutation = (): never =>
    invalidCapabilityRegistry("Capability snapshot is immutable", "registry");
  return Object.freeze({
    registerGateRunner: immutableMutation,
    registerSandboxBackend: immutableMutation,
    registerContextSource: immutableMutation,
    getGateRunner(id: string) {
      return gates.get(id);
    },
    getSandboxBackend(id: string) {
      return sandbox?.id === id ? sandbox : undefined;
    },
    listContextSources() {
      return frozenSources;
    }
  });
}

function snapshotCompileInput(input: HarnessCompileInput): HarnessCompileInput {
  let registry: CapabilityRegistryLike;
  let signal: AbortSignal | undefined;
  let capturedNow: Date | string | undefined;
  let declarative: Readonly<{
    spec: HarnessCompileInput["spec"];
    governance: HarnessCompileInput["governance"];
    context: HarnessCompileInput["context"];
    profile: HarnessCompileInput["profile"];
  }>;
  try {
    registry = ownEnumerableDataProperty(input, "registry");
    signal = optionalOwnDataProperty(input, "signal");
    capturedNow = optionalOwnDataProperty(input, "now");
    // This is the single mutable-input crossing: all declarative domains are
    // cloned together so aliases, accessors and post-await rebinding cannot
    // change the compilation view.
    declarative = deepFreezeJson(cloneCanonical({
      spec: ownEnumerableDataProperty(input, "spec"),
      governance: ownEnumerableDataProperty(input, "governance"),
      context: ownEnumerableDataProperty(input, "context"),
      profile: ownEnumerableDataProperty(input, "profile")
    }));
  } catch {
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", "Harness declarative input cannot be snapshotted safely", "input")
    ]);
  }
  const generatedAt = parseGeneratedAt(capturedNow);
  const requiredGateIds = Array.isArray(declarative.governance.policy?.requiredGates)
    ? declarative.governance.policy.requiredGates.filter((gateId) =>
        isTrimmedNonEmptyString(gateId) && !containsSensitiveMaterial(gateId)
      )
    : [];
  const sandboxBackendId =
    isTrimmedNonEmptyString(declarative.profile.sandboxBackendId) &&
    !containsSensitiveMaterial(declarative.profile.sandboxBackendId)
    ? declarative.profile.sandboxBackendId
    : undefined;
  const capabilitySnapshot = snapshotCapabilityRegistry(
    registry,
    requiredGateIds,
    sandboxBackendId
  );
  return Object.freeze({
    spec: declarative.spec,
    governance: declarative.governance,
    context: declarative.context,
    profile: declarative.profile,
    registry: capabilitySnapshot,
    now: generatedAt,
    ...(signal === undefined ? {} : { signal })
  });
}

async function compileHarnessManifestInternal(
  input: HarnessCompileInput
): Promise<HarnessManifest> {
  const generatedAt = parseGeneratedAt(input.now);
  let normalizedResult: ReturnType<typeof normalizeCompileContext>;
  const initialIssues: HarnessCompilationIssue[] = [];
  try {
    initialIssues.push(...validateProfile(input.profile));
  } catch {
    initialIssues.push(issue("INVALID_PROFILE", "Harness profile could not be inspected safely", "profile"));
  }
  try {
    initialIssues.push(...validateSpecBinding(input));
  } catch {
    initialIssues.push(issue("SPEC_INVALID", "Spec revision could not be inspected safely", "spec"));
  }
  try {
    initialIssues.push(...validateGovernanceDigest(input.governance));
    initialIssues.push(...validateGovernanceSemantics(input.governance));
  } catch {
    initialIssues.push(issue("INVALID_GOVERNANCE", "Governance snapshot could not be inspected safely", "governance"));
  }
  try {
    initialIssues.push(...validateProfileBinding(input));
  } catch {
    initialIssues.push(issue("PROFILE_REF_MISMATCH", "Harness profile binding could not be inspected safely", "profile"));
  }
  initialIssues.push(...validateTemporalOrdering(input, generatedAt));
  try {
    normalizedResult = normalizeCompileContext(input);
    initialIssues.push(...normalizedResult.issues);
  } catch {
    normalizedResult = { issues: [] };
    initialIssues.push(issue("INVALID_CONTEXT", "Harness compile context could not be inspected safely", "context"));
  }
  if (initialIssues.length > 0 || normalizedResult.context === undefined) {
    throw new HarnessCompilationError(initialIssues);
  }

  let sandbox: SandboxBackend | undefined;
  try {
    sandbox = input.registry.getSandboxBackend(input.profile.sandboxBackendId);
  } catch {
    throw new HarnessCompilationError([
      issue("INVALID_SANDBOX", "Sandbox registry lookup failed safely", "profile.sandboxBackendId")
    ]);
  }
  if (sandbox === undefined) {
    throw new HarnessCompilationError([
      issue("MISSING_SANDBOX", `Sandbox backend ${input.profile.sandboxBackendId} is not registered`, "profile.sandboxBackendId")
    ]);
  }
  const sandboxPlan = compileSandboxPlan(input, sandbox);
  const gatePlan = compileGatePlan(input, normalizedResult.context);
  const context = await compileContext(input, normalizedResult.context);
  const sourcePolicy = input.governance.policy;
  const policy: GovernanceSnapshot["policy"] = cloneCanonical({
    requiredGates: sourcePolicy.requiredGates,
    deny: sourcePolicy.deny,
    protectedPaths: sourcePolicy.protectedPaths,
    ...(sourcePolicy.allowedProviders === undefined
      ? {}
      : { allowedProviders: sourcePolicy.allowedProviders }),
    ...(sourcePolicy.commandAllowlist === undefined
      ? {}
      : { commandAllowlist: sourcePolicy.commandAllowlist }),
    ...(sourcePolicy.networkAllowlist === undefined
      ? {}
      : { networkAllowlist: sourcePolicy.networkAllowlist }),
    budgets: sourcePolicy.budgets,
    approvalMode: sourcePolicy.approvalMode
  });
  const semantic = {
    schemaVersion: 1 as const,
    profile: {
      id: input.profile.id,
      version: input.profile.version,
      digest: input.profile.digest!
    },
    task: {
      taskId: normalizedResult.context.taskId,
      projectRoot: normalizedResult.context.projectRoot
    },
    specRef: {
      specSetId: input.spec.specSetId,
      revision: input.spec.revision,
      digest: input.spec.digest as string
    },
    governanceDigest: input.governance.digest,
    ...(input.governance.workflowRef === undefined
      ? {}
      : {
          workflowRef: {
            id: input.governance.workflowRef.id,
            version: input.governance.workflowRef.version,
            digest: input.governance.workflowRef.digest
          }
        }),
    ...(input.governance.harnessProfileRef === undefined
      ? {}
      : {
          harnessProfileRef: {
            id: input.governance.harnessProfileRef.id,
            version: input.governance.harnessProfileRef.version,
            digest: input.governance.harnessProfileRef.digest
          }
        }),
    selectedServices: normalizedResult.context.selectedServices,
    languageByService: normalizedResult.context.languageByService,
    policy,
    executionPolicy: {
      ...(policy.allowedProviders === undefined ? {} : { allowedProviders: policy.allowedProviders }),
      ...(policy.commandAllowlist === undefined ? {} : { commandAllowlist: policy.commandAllowlist }),
      ...(policy.networkAllowlist === undefined ? {} : { networkAllowlist: policy.networkAllowlist }),
      deny: policy.deny,
      protectedPaths: policy.protectedPaths
    },
    context,
    gatePlan,
    sandbox: sandboxPlan,
    stopConditions: cloneCanonical(policy.budgets),
    outputSchema: input.profile.outputSchema
  };
  const manifest: HarnessManifest = {
    ...cloneCanonical(semantic),
    generatedAt,
    digest: sha256Digest(semantic)
  };
  return deepFreezeJson(manifest);
}

export async function compileHarnessManifest(
  input: HarnessCompileInput
): Promise<HarnessManifest> {
  try {
    const snapshot = snapshotCompileInput(input);
    return await compileHarnessManifestInternal(snapshot);
  } catch (error) {
    if (error instanceof HarnessCompilationError) throw error;
    throw new HarnessCompilationError([
      issue("INVALID_CONTEXT", "Harness input could not be processed safely", "input", {
        cause: safeRedactedErrorMessage(error)
      })
    ]);
  }
}
