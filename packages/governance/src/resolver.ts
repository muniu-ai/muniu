import { canonicalJson, deepFreeze, sha256Canonical } from "./canonical.js";
import { GovernanceResolutionError } from "./errors.js";
import { isStrictRfc3339Timestamp as isStrictTimestamp } from "./timestamp.js";
import {
  APPROVAL_MODE_ORDER,
  GOVERNANCE_SCOPE_ORDER,
  type AppliedWaiver,
  type ApprovalMode,
  type GovernanceBudget,
  type GovernanceBudgetField,
  type GovernanceDecision,
  type GovernanceIssue,
  type GovernanceLayerSnapshot,
  type GovernanceProvider,
  type GovernanceScope,
  type GovernanceSnapshot,
  type PolicyRuleSet,
  type PolicyRuleTarget,
  type ResolveGovernanceOptions,
  type ResolvedPolicyRuleSet,
  type ScopedGovernanceLayer,
  type Waiver,
  type WaivablePolicyField
} from "./types.js";

const UNION_FIELDS = [
  "requiredGates",
  "deny",
  "protectedPaths"
] as const satisfies readonly WaivablePolicyField[];

const ALLOWLIST_FIELDS = [
  "allowedProviders",
  "commandAllowlist",
  "networkAllowlist"
] as const;

const BUDGET_FIELDS = [
  "maxCandidates",
  "maxDurationSeconds",
  "maxTokens",
  "maxCostUsd",
  "maxRepairAttempts",
  "maxChangedFiles",
  "maxChangedLines"
] as const satisfies readonly GovernanceBudgetField[];

const COUNT_BUDGET_FIELDS = new Set<GovernanceBudgetField>([
  "maxCandidates",
  "maxDurationSeconds",
  "maxTokens",
  "maxRepairAttempts",
  "maxChangedFiles",
  "maxChangedLines"
]);

const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_SPEC_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LAYER_FIELDS = new Set(["scope", "scopeId", "source", "policy"]);
const SOURCE_FIELDS = new Set(["id", "version", "digest"]);
const POLICY_FIELDS = new Set([
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
const POLICY_TARGET_FIELDS = new Set(["field", "value"]);
const OPTIONS_FIELDS = new Set([
  "now",
  "waivers",
  "scopeBindings",
  "specRef",
  "workflowRef",
  "harnessProfileRef"
]);
const WAIVER_FIELDS = new Set([
  "id",
  "target",
  "scope",
  "reason",
  "approvedBy",
  "approvedAt",
  "expiresAt"
]);
const WAIVER_SCOPE_FIELDS = new Set(["level", "id"]);
const SPEC_REF_FIELDS = new Set(["specSetId", "revision", "digest"]);
const VERSIONED_REF_FIELDS = new Set(["id", "version", "digest"]);

type AllowlistField = (typeof ALLOWLIST_FIELDS)[number];

interface PreparedPolicy {
  readonly requiredGates: readonly string[];
  readonly deny: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly allowedProviders?: readonly GovernanceProvider[];
  readonly commandAllowlist?: readonly string[];
  readonly networkAllowlist?: readonly string[];
  readonly budgets: Readonly<GovernanceBudget>;
  readonly approvalMode?: ApprovalMode;
  readonly waivableRules: readonly PolicyRuleTarget[];
}

interface PreparedLayer {
  readonly scope: GovernanceScope;
  readonly scopeId: string;
  readonly source: ScopedGovernanceLayer["source"];
  readonly sourceId: string;
  readonly policy: PreparedPolicy;
}

interface RuleOrigin {
  readonly sourceId: string;
  readonly waivable: boolean;
}

interface WaiverApplication {
  readonly waiver: Waiver;
  readonly sourceIds: readonly string[];
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ingressIssue(
  issues: GovernanceIssue[],
  code: GovernanceIssue["code"],
  field: string,
  message: string
): void {
  issues.push({ code, field, message });
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  code: GovernanceIssue["code"],
  issues: GovernanceIssue[]
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      ingressIssue(
        issues,
        code,
        `${path}.${field}`,
        `${path}.${field} is not supported`
      );
    }
  }
}

function cloneLayerIngress(
  value: unknown,
  issues: GovernanceIssue[]
): readonly ScopedGovernanceLayer[] {
  let normalized: unknown;
  try {
    normalized = JSON.parse(canonicalJson(value));
  } catch (error) {
    ingressIssue(
      issues,
      "INVALID_LAYER",
      "layers",
      error instanceof Error ? error.message : "layers must be declarative JSON"
    );
    return [];
  }
  if (!Array.isArray(normalized)) {
    ingressIssue(issues, "INVALID_LAYER", "layers", "layers must be an array");
    return [];
  }
  return normalized as ScopedGovernanceLayer[];
}

function cloneOptionsIngress(
  value: unknown,
  issues: GovernanceIssue[]
): ResolveGovernanceOptions {
  if (!isPlainObject(value)) {
    ingressIssue(
      issues,
      "INVALID_REFERENCE",
      "options",
      "Resolver options must be a plain object"
    );
    return {};
  }

  const declarativeOptions: Record<string, unknown> = {};
  let clonedDate: Date | undefined;
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    ingressIssue(
      issues,
      "INVALID_REFERENCE",
      "options",
      error instanceof Error ? error.message : "Resolver options cannot be inspected"
    );
    return {};
  }
  for (const key of keys) {
    if (typeof key === "symbol") {
      ingressIssue(
        issues,
        "INVALID_REFERENCE",
        "options",
        "Resolver options cannot contain symbol keys"
      );
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      ingressIssue(
        issues,
        "INVALID_REFERENCE",
        `options.${key}`,
        `options.${key} cannot be an accessor`
      );
      continue;
    }
    if (!descriptor.enumerable) {
      ingressIssue(
        issues,
        "INVALID_REFERENCE",
        `options.${key}`,
        `options.${key} must be enumerable`
      );
      continue;
    }
    if (key === "now" && descriptor.value instanceof Date) {
      if (
        Object.getPrototypeOf(descriptor.value) !== Date.prototype ||
        Reflect.ownKeys(descriptor.value).length > 0
      ) {
        ingressIssue(
          issues,
          "INVALID_RESOLUTION_TIME",
          "now",
          "Resolution Date must not contain custom properties"
        );
        continue;
      }
      try {
        clonedDate = new Date(Date.prototype.getTime.call(descriptor.value));
      } catch (error) {
        ingressIssue(
          issues,
          "INVALID_RESOLUTION_TIME",
          "now",
          error instanceof Error ? error.message : "Resolution Date is invalid"
        );
      }
      continue;
    }
    declarativeOptions[key] = descriptor.value;
  }

  let normalized: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(canonicalJson(declarativeOptions)) as unknown;
    if (!isPlainObject(candidate)) {
      throw new TypeError("Resolver options must be an object");
    }
    normalized = candidate;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Resolver options must be declarative JSON";
    const waiverInput = /(?:^|\.)waivers(?:\[|\.|$)/.test(message);
    ingressIssue(
      issues,
      waiverInput ? "WAIVER_INVALID" : "INVALID_REFERENCE",
      waiverInput ? "options.waivers" : "options",
      message
    );
  }
  if (clonedDate) normalized.now = clonedDate;
  return normalized as ResolveGovernanceOptions;
}

function validateExactResolverIngress(
  layers: readonly ScopedGovernanceLayer[],
  options: ResolveGovernanceOptions,
  issues: GovernanceIssue[]
): void {
  layers.forEach((rawLayer, index) => {
    const path = `layers[${index}]`;
    if (!isPlainObject(rawLayer)) {
      ingressIssue(issues, "INVALID_LAYER", path, `${path} must be an object`);
      return;
    }
    rejectUnknownFields(rawLayer, LAYER_FIELDS, path, "INVALID_LAYER", issues);
    if (!isPlainObject(rawLayer.source)) {
      ingressIssue(
        issues,
        "INVALID_LAYER",
        `${path}.source`,
        `${path}.source must be an object`
      );
    } else {
      rejectUnknownFields(
        rawLayer.source,
        SOURCE_FIELDS,
        `${path}.source`,
        "INVALID_LAYER",
        issues
      );
    }
    if (!isPlainObject(rawLayer.policy)) {
      ingressIssue(
        issues,
        "INVALID_LAYER",
        `${path}.policy`,
        `${path}.policy must be an object`
      );
      return;
    }
    rejectUnknownFields(
      rawLayer.policy,
      POLICY_FIELDS,
      `${path}.policy`,
      "INVALID_LAYER",
      issues
    );
    if (Array.isArray(rawLayer.policy.waivableRules)) {
      rawLayer.policy.waivableRules.forEach((target, targetIndex) => {
        const targetPath = `${path}.policy.waivableRules[${targetIndex}]`;
        if (!isPlainObject(target)) {
          ingressIssue(
            issues,
            "INVALID_LAYER",
            targetPath,
            `${targetPath} must be an object`
          );
          return;
        }
        rejectUnknownFields(
          target,
          POLICY_TARGET_FIELDS,
          targetPath,
          "INVALID_LAYER",
          issues
        );
      });
    }
  });

  if (!isPlainObject(options)) {
    ingressIssue(issues, "INVALID_REFERENCE", "options", "options must be an object");
    return;
  }
  rejectUnknownFields(options, OPTIONS_FIELDS, "options", "INVALID_REFERENCE", issues);

  if (options.scopeBindings !== undefined) {
    if (!isPlainObject(options.scopeBindings)) {
      ingressIssue(
        issues,
        "SCOPE_BINDING_MISMATCH",
        "options.scopeBindings",
        "scopeBindings must be an object"
      );
    } else {
      rejectUnknownFields(
        options.scopeBindings,
        new Set(GOVERNANCE_SCOPE_ORDER),
        "options.scopeBindings",
        "SCOPE_BINDING_MISMATCH",
        issues
      );
    }
  }

  for (const [field, ref, allowed] of [
    ["specRef", options.specRef, SPEC_REF_FIELDS],
    ["workflowRef", options.workflowRef, VERSIONED_REF_FIELDS],
    ["harnessProfileRef", options.harnessProfileRef, VERSIONED_REF_FIELDS]
  ] as const) {
    if (ref === undefined) continue;
    if (!isPlainObject(ref)) {
      ingressIssue(
        issues,
        "INVALID_REFERENCE",
        `options.${field}`,
        `${field} must be an object`
      );
      continue;
    }
    rejectUnknownFields(
      ref,
      allowed,
      `options.${field}`,
      "INVALID_REFERENCE",
      issues
    );
  }

  if (options.waivers !== undefined) {
    if (!Array.isArray(options.waivers)) {
      ingressIssue(
        issues,
        "WAIVER_INVALID",
        "options.waivers",
        "waivers must be an array"
      );
    } else {
      options.waivers.forEach((waiver, index) => {
        const path = `options.waivers[${index}]`;
        if (!isPlainObject(waiver)) {
          ingressIssue(issues, "WAIVER_INVALID", path, `${path} must be an object`);
          return;
        }
        rejectUnknownFields(waiver, WAIVER_FIELDS, path, "WAIVER_INVALID", issues);
        for (const [field, allowed] of [
          ["target", POLICY_TARGET_FIELDS],
          ["scope", WAIVER_SCOPE_FIELDS]
        ] as const) {
          const child = waiver[field];
          if (!isPlainObject(child)) {
            ingressIssue(
              issues,
              "WAIVER_INVALID",
              `${path}.${field}`,
              `${path}.${field} must be an object`
            );
          } else {
            rejectUnknownFields(
              child,
              allowed,
              `${path}.${field}`,
              "WAIVER_INVALID",
              issues
            );
          }
        }
      });
    }
  }
}

function isGovernanceScope(value: unknown): value is GovernanceScope {
  return (GOVERNANCE_SCOPE_ORDER as readonly unknown[]).includes(value);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return (APPROVAL_MODE_ORDER as readonly unknown[]).includes(value);
}

function isWaivableField(value: unknown): value is WaivablePolicyField {
  return (UNION_FIELDS as readonly unknown[]).includes(value);
}

function isBudgetField(value: string): value is GovernanceBudgetField {
  return (BUDGET_FIELDS as readonly string[]).includes(value);
}

function sourceKey(layer: {
  scope: GovernanceScope;
  scopeId: string;
  source: ScopedGovernanceLayer["source"];
}): string {
  const version = layer.source.version ? `@${layer.source.version}` : "";
  const digest = layer.source.digest ? `#${layer.source.digest}` : "";
  return `${layer.scope}:${layer.scopeId}:${layer.source.id}${version}${digest}`;
}

function sourceIdentity(source: ScopedGovernanceLayer["source"]): string {
  const version = source.version ? `@${source.version}` : "";
  return `${source.id}${version}`;
}

function addInvalidLayerIssue(
  issues: GovernanceIssue[],
  sourceId: string | undefined,
  field: string,
  message: string
): void {
  issues.push({
    code: "INVALID_LAYER",
    message,
    field,
    ...(sourceId ? { sourceId } : {})
  });
}

function normalizeStringList(
  rawValue: unknown,
  field: string,
  sourceId: string,
  issues: GovernanceIssue[],
  allowedValues?: readonly string[]
): readonly string[] | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawValue)) {
    addInvalidLayerIssue(
      issues,
      sourceId,
      field,
      `${field} must be an array of non-empty strings`
    );
    return [];
  }

  const values: string[] = [];
  for (const [index, value] of rawValue.entries()) {
    if (!isTrimmedNonEmptyString(value)) {
      addInvalidLayerIssue(
        issues,
        sourceId,
        `${field}[${index}]`,
        `${field} entries must be trimmed non-empty strings`
      );
      continue;
    }
    if (allowedValues && !allowedValues.includes(value)) {
      addInvalidLayerIssue(
        issues,
        sourceId,
        `${field}[${index}]`,
        `Unsupported ${field} value: ${value}`
      );
      continue;
    }
    values.push(value);
  }
  return uniqueSorted(values);
}

function normalizeBudgets(
  rawValue: unknown,
  sourceId: string,
  issues: GovernanceIssue[]
): GovernanceBudget {
  if (rawValue === undefined) {
    return {};
  }
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    issues.push({
      code: "INVALID_BUDGET",
      message: "budgets must be an object",
      field: "budgets",
      sourceId
    });
    return {};
  }

  const budgets: Partial<Record<GovernanceBudgetField, number>> = {};
  for (const [field, value] of Object.entries(rawValue)) {
    if (!isBudgetField(field)) {
      issues.push({
        code: "INVALID_BUDGET",
        message: `Unsupported budget field: ${field}`,
        field: `budgets.${field}`,
        sourceId
      });
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (COUNT_BUDGET_FIELDS.has(field) && !Number.isSafeInteger(value))
    ) {
      issues.push({
        code: "INVALID_BUDGET",
        message: COUNT_BUDGET_FIELDS.has(field)
          ? `${field} must be a non-negative safe integer`
          : `${field} must be a finite non-negative number`,
        field: `budgets.${field}`,
        sourceId
      });
      continue;
    }
    budgets[field] = value;
  }
  return budgets;
}

function normalizeWaivableRules(
  rawValue: unknown,
  policy: Pick<PreparedPolicy, (typeof UNION_FIELDS)[number]>,
  sourceId: string,
  issues: GovernanceIssue[]
): readonly PolicyRuleTarget[] {
  if (rawValue === undefined) {
    return [];
  }
  if (!Array.isArray(rawValue)) {
    addInvalidLayerIssue(
      issues,
      sourceId,
      "waivableRules",
      "waivableRules must be an array of policy rule targets"
    );
    return [];
  }

  const targets = new Map<string, PolicyRuleTarget>();
  for (const [index, rawTarget] of rawValue.entries()) {
    if (!rawTarget || typeof rawTarget !== "object") {
      addInvalidLayerIssue(
        issues,
        sourceId,
        `waivableRules[${index}]`,
        "Waivable rule target must be an object"
      );
      continue;
    }
    const target = rawTarget as Partial<PolicyRuleTarget>;
    if (!isWaivableField(target.field) || !isTrimmedNonEmptyString(target.value)) {
      addInvalidLayerIssue(
        issues,
        sourceId,
        `waivableRules[${index}]`,
        "Waivable rule target must contain a supported field and non-empty value"
      );
      continue;
    }
    if (!policy[target.field].includes(target.value)) {
      addInvalidLayerIssue(
        issues,
        sourceId,
        `waivableRules[${index}]`,
        "A layer can only mark one of its own rules as waivable"
      );
      continue;
    }
    targets.set(`${target.field}\0${target.value}`, {
      field: target.field,
      value: target.value
    });
  }

  return [...targets.values()].sort((left, right) => {
    const byField = compareStrings(left.field, right.field);
    return byField || compareStrings(left.value, right.value);
  });
}

function prepareLayer(
  rawLayer: ScopedGovernanceLayer,
  index: number,
  issues: GovernanceIssue[]
): PreparedLayer | undefined {
  if (!rawLayer || typeof rawLayer !== "object") {
    addInvalidLayerIssue(issues, undefined, `layers[${index}]`, "Layer must be an object");
    return undefined;
  }
  if (!isGovernanceScope(rawLayer.scope)) {
    addInvalidLayerIssue(
      issues,
      undefined,
      `layers[${index}].scope`,
      `Unsupported governance scope: ${String(rawLayer.scope)}`
    );
    return undefined;
  }
  if (!isTrimmedNonEmptyString(rawLayer.scopeId)) {
    addInvalidLayerIssue(
      issues,
      undefined,
      `layers[${index}].scopeId`,
      "Layer scopeId is required"
    );
    return undefined;
  }
  if (!rawLayer.source || !isTrimmedNonEmptyString(rawLayer.source.id)) {
    addInvalidLayerIssue(
      issues,
      undefined,
      `layers[${index}].source.id`,
      "Layer source id is required"
    );
    return undefined;
  }
  if (
    !isTrimmedNonEmptyString(rawLayer.source.version)
  ) {
    addInvalidLayerIssue(
      issues,
      undefined,
      `layers[${index}].source.version`,
      "Layer source version is required and must be a trimmed non-empty string"
    );
    return undefined;
  }
  if (
    !isTrimmedNonEmptyString(rawLayer.source.digest) ||
    !SHA256_DIGEST.test(rawLayer.source.digest)
  ) {
    addInvalidLayerIssue(
      issues,
      undefined,
      `layers[${index}].source.digest`,
      "Layer source digest must be lowercase SHA-256"
    );
    return undefined;
  }

  const source = {
    id: rawLayer.source.id,
    version: rawLayer.source.version,
    digest: rawLayer.source.digest
  };
  const sourceId = sourceKey({
    scope: rawLayer.scope,
    scopeId: rawLayer.scopeId,
    source
  });
  const rawPolicy = rawLayer.policy as PolicyRuleSet | undefined;
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
    addInvalidLayerIssue(
      issues,
      sourceId,
      "policy",
      "Layer policy must be an object"
    );
    return undefined;
  }

  const requiredGates =
    normalizeStringList(
      rawPolicy.requiredGates,
      "requiredGates",
      sourceId,
      issues
    ) ?? [];
  const deny =
    normalizeStringList(rawPolicy.deny, "deny", sourceId, issues) ?? [];
  const protectedPaths =
    normalizeStringList(
      rawPolicy.protectedPaths,
      "protectedPaths",
      sourceId,
      issues
    ) ?? [];
  const allowedProviders = normalizeStringList(
    rawPolicy.allowedProviders,
    "allowedProviders",
    sourceId,
    issues,
    ["claude", "codex"]
  ) as readonly GovernanceProvider[] | undefined;
  const commandAllowlist = normalizeStringList(
    rawPolicy.commandAllowlist,
    "commandAllowlist",
    sourceId,
    issues
  );
  const networkAllowlist = normalizeStringList(
    rawPolicy.networkAllowlist,
    "networkAllowlist",
    sourceId,
    issues
  );
  const budgets = normalizeBudgets(rawPolicy.budgets, sourceId, issues);

  let approvalMode = rawPolicy.approvalMode;
  if (approvalMode !== undefined && !isApprovalMode(approvalMode)) {
    addInvalidLayerIssue(
      issues,
      sourceId,
      "approvalMode",
      `Unsupported approval mode: ${String(approvalMode)}`
    );
    approvalMode = undefined;
  }

  const policyBase = { requiredGates, deny, protectedPaths };
  const waivableRules = normalizeWaivableRules(
    rawPolicy.waivableRules,
    policyBase,
    sourceId,
    issues
  );

  return {
    scope: rawLayer.scope,
    scopeId: rawLayer.scopeId,
    source,
    sourceId,
    policy: {
      ...policyBase,
      ...(allowedProviders !== undefined ? { allowedProviders } : {}),
      ...(commandAllowlist !== undefined ? { commandAllowlist } : {}),
      ...(networkAllowlist !== undefined ? { networkAllowlist } : {}),
      budgets,
      ...(approvalMode !== undefined ? { approvalMode } : {}),
      waivableRules
    }
  };
}

function compareLayers(left: PreparedLayer, right: PreparedLayer): number {
  const leftRank = GOVERNANCE_SCOPE_ORDER.indexOf(left.scope);
  const rightRank = GOVERNANCE_SCOPE_ORDER.indexOf(right.scope);
  return (
    leftRank - rightRank ||
    compareStrings(left.scopeId, right.scopeId) ||
    compareStrings(left.sourceId, right.sourceId)
  );
}

function intersectLists(
  current: readonly string[] | undefined,
  next: readonly string[]
): readonly string[] {
  if (current === undefined) {
    return [...next];
  }
  const nextValues = new Set(next);
  return current.filter((value) => nextValues.has(value));
}

function waiverTargetKey(target: PolicyRuleTarget): string {
  return `${target.field}\0${target.value}`;
}

function validateWaiverShape(rawWaiver: Waiver, now: Date): string[] {
  const invalidFields: string[] = [];
  const value = rawWaiver as Partial<Waiver>;
  if (!isTrimmedNonEmptyString(value.id)) invalidFields.push("id");
  if (
    !value.target ||
    !isWaivableField(value.target.field) ||
    !isTrimmedNonEmptyString(value.target.value)
  ) {
    invalidFields.push("target");
  }
  if (
    !value.scope ||
    !isGovernanceScope(value.scope.level) ||
    !isTrimmedNonEmptyString(value.scope.id)
  ) {
    invalidFields.push("scope");
  }
  if (!isTrimmedNonEmptyString(value.reason)) invalidFields.push("reason");
  if (!isTrimmedNonEmptyString(value.approvedBy)) invalidFields.push("approvedBy");
  if (!isStrictTimestamp(value.expiresAt)) {
    invalidFields.push("expiresAt");
  }
  if (!isStrictTimestamp(value.approvedAt)) {
    invalidFields.push("approvedAt");
  }
  if (isStrictTimestamp(value.approvedAt) && Date.parse(value.approvedAt) > now.getTime()) {
    invalidFields.push("approvedAt.future");
  }
  if (
    isStrictTimestamp(value.approvedAt) &&
    isStrictTimestamp(value.expiresAt) &&
    Date.parse(value.approvedAt) >= Date.parse(value.expiresAt)
  ) {
    invalidFields.push("approvalWindow");
  }
  return invalidFields;
}

function copyWaiver(waiver: Waiver, sourceIds: readonly string[]): AppliedWaiver {
  return {
    id: waiver.id,
    target: { field: waiver.target.field, value: waiver.target.value },
    scope: { level: waiver.scope.level, id: waiver.scope.id },
    reason: waiver.reason,
    approvedBy: waiver.approvedBy,
    approvedAt: waiver.approvedAt,
    expiresAt: waiver.expiresAt,
    sourceIds: [...sourceIds]
  };
}

function decisionSummary(
  field: GovernanceDecision["field"],
  strategy: GovernanceDecision["strategy"],
  effectiveValue: unknown,
  sourceCount: number,
  waiverIds: readonly string[] = []
): string {
  const value = JSON.stringify(effectiveValue);
  const waiverSuffix =
    waiverIds.length > 0 ? ` after waivers ${waiverIds.join(", ")}` : "";
  return `${field} resolved by ${strategy} from ${sourceCount} source(s) to ${value}${waiverSuffix}`;
}

function normalizeNow(
  value: ResolveGovernanceOptions["now"],
  issues: GovernanceIssue[]
): Date {
  if (value === undefined) return new Date();
  let date: Date;
  if (value instanceof Date) {
    date = new Date(Date.prototype.getTime.call(value));
  } else if (isStrictTimestamp(value)) {
    date = new Date(value);
  } else {
    issues.push({
      code: "INVALID_RESOLUTION_TIME",
      message: "Resolution time must be a valid Date or strict RFC3339 timestamp",
      field: "now"
    });
    return new Date(0);
  }
  if (!Number.isFinite(date.getTime())) {
    issues.push({
      code: "INVALID_RESOLUTION_TIME",
      message: "Resolution Date must be valid",
      field: "now"
    });
    return new Date(0);
  }
  return date;
}

function validateImmutableRefs(
  options: ResolveGovernanceOptions,
  issues: GovernanceIssue[]
): void {
  if (options.specRef) {
    const ref = options.specRef;
    if (
      !isTrimmedNonEmptyString(ref.specSetId) ||
      !SAFE_SPEC_SET_ID.test(ref.specSetId) ||
      !Number.isSafeInteger(ref.revision) ||
      ref.revision <= 0 ||
      !isTrimmedNonEmptyString(ref.digest) ||
      !SHA256_DIGEST.test(ref.digest)
    ) {
      issues.push({
        code: "INVALID_REFERENCE",
        message: "specRef requires specSetId, a positive revision, and SHA-256 digest",
        field: "specRef"
      });
    }
  }

  for (const [field, ref] of [
    ["workflowRef", options.workflowRef],
    ["harnessProfileRef", options.harnessProfileRef]
  ] as const) {
    if (!ref) continue;
    if (
      !isTrimmedNonEmptyString(ref.id) ||
      !isTrimmedNonEmptyString(ref.version) ||
      !isTrimmedNonEmptyString(ref.digest) ||
      !SHA256_DIGEST.test(ref.digest)
    ) {
      issues.push({
        code: "INVALID_REFERENCE",
        message: `${field} requires trimmed id/version and a SHA-256 digest`,
        field
      });
    }
  }
}

export function resolveGovernance(
  layers: readonly ScopedGovernanceLayer[],
  options: ResolveGovernanceOptions = {}
): GovernanceSnapshot {
  const issues: GovernanceIssue[] = [];
  layers = cloneLayerIngress(layers, issues);
  options = cloneOptionsIngress(options, issues);
  validateExactResolverIngress(layers, options, issues);
  const now = normalizeNow(options.now, issues);
  validateImmutableRefs(options, issues);
  if (issues.length > 0) {
    throw new GovernanceResolutionError(issues);
  }
  const preparedLayers = layers
    .map((layer, index) => prepareLayer(layer, index, issues))
    .filter((layer): layer is PreparedLayer => layer !== undefined)
    .sort(compareLayers);

  const activeScopeIds = new Map<GovernanceScope, string>();
  const sourceIdentities = new Set<string>();
  for (const layer of preparedLayers) {
    const activeScopeId = activeScopeIds.get(layer.scope);
    if (activeScopeId !== undefined && activeScopeId !== layer.scopeId) {
      issues.push({
        code: "SCOPE_CONFLICT",
        message: `Governance scope ${layer.scope} has multiple active ids`,
        field: `scopeBindings.${layer.scope}`,
        sourceId: layer.sourceId,
        details: { activeScopeId, conflictingScopeId: layer.scopeId }
      });
    } else {
      activeScopeIds.set(layer.scope, layer.scopeId);
    }

    const identity = sourceIdentity(layer.source);
    if (sourceIdentities.has(identity)) {
      issues.push({
        code: "DUPLICATE_LAYER_SOURCE",
        message: `Governance source ${identity} is applied more than once`,
        sourceId: layer.sourceId
      });
    } else {
      sourceIdentities.add(identity);
    }
  }

  if (options.scopeBindings) {
    for (const [scope, id] of Object.entries(options.scopeBindings)) {
      if (!isGovernanceScope(scope) || !isTrimmedNonEmptyString(id)) {
        issues.push({
          code: "SCOPE_BINDING_MISMATCH",
          message: `Scope binding ${scope} must use a supported scope and trimmed id`,
          field: `scopeBindings.${scope}`
        });
        continue;
      }
      const layerScopeId = activeScopeIds.get(scope);
      if (layerScopeId !== undefined && layerScopeId !== id) {
        issues.push({
          code: "SCOPE_BINDING_MISMATCH",
          message: `Scope binding ${scope}:${id} does not match active layer ${layerScopeId}`,
          field: `scopeBindings.${scope}`,
          details: { bindingId: id, layerScopeId }
        });
      } else {
        activeScopeIds.set(scope, id);
      }
    }
  }

  const unionValues: Record<WaivablePolicyField, Set<string>> = {
    requiredGates: new Set<string>(),
    deny: new Set<string>(),
    protectedPaths: new Set<string>()
  };
  const origins: Record<
    WaivablePolicyField,
    Map<string, RuleOrigin[]>
  > = {
    requiredGates: new Map<string, RuleOrigin[]>(),
    deny: new Map<string, RuleOrigin[]>(),
    protectedPaths: new Map<string, RuleOrigin[]>()
  };
  const unionSourceIds: Record<WaivablePolicyField, Set<string>> = {
    requiredGates: new Set<string>(),
    deny: new Set<string>(),
    protectedPaths: new Set<string>()
  };
  const allowlists: Partial<Record<AllowlistField, readonly string[]>> = {};
  const allowlistSourceIds: Record<AllowlistField, Set<string>> = {
    allowedProviders: new Set<string>(),
    commandAllowlist: new Set<string>(),
    networkAllowlist: new Set<string>()
  };
  const effectiveBudgets: Partial<Record<GovernanceBudgetField, number>> = {};
  const budgetSourceIds = new Map<GovernanceBudgetField, Set<string>>();
  let approvalMode: ApprovalMode = "never";
  const approvalSourceIds = new Set<string>();

  for (const layer of preparedLayers) {
    const waivableTargets = new Set(layer.policy.waivableRules.map(waiverTargetKey));
    for (const field of UNION_FIELDS) {
      for (const value of layer.policy[field]) {
        unionValues[field].add(value);
        unionSourceIds[field].add(layer.sourceId);
        const valueOrigins = origins[field].get(value) ?? [];
        valueOrigins.push({
          sourceId: layer.sourceId,
          waivable: waivableTargets.has(waiverTargetKey({ field, value }))
        });
        origins[field].set(value, valueOrigins);
      }
    }

    for (const field of ALLOWLIST_FIELDS) {
      const declared = layer.policy[field];
      if (declared !== undefined) {
        allowlists[field] = intersectLists(allowlists[field], declared);
        allowlistSourceIds[field].add(layer.sourceId);
      }
    }

    for (const field of BUDGET_FIELDS) {
      const declared = layer.policy.budgets[field];
      if (declared === undefined) continue;
      const current = effectiveBudgets[field];
      effectiveBudgets[field] = current === undefined ? declared : Math.min(current, declared);
      const sources = budgetSourceIds.get(field) ?? new Set<string>();
      sources.add(layer.sourceId);
      budgetSourceIds.set(field, sources);
    }

    if (layer.policy.approvalMode !== undefined) {
      approvalSourceIds.add(layer.sourceId);
      if (
        APPROVAL_MODE_ORDER.indexOf(layer.policy.approvalMode) >
        APPROVAL_MODE_ORDER.indexOf(approvalMode)
      ) {
        approvalMode = layer.policy.approvalMode;
      }
    }
  }

  for (const field of ALLOWLIST_FIELDS) {
    if (allowlists[field] !== undefined && allowlists[field]?.length === 0) {
      issues.push({
        code: "EMPTY_ALLOWLIST",
        message: `${field} is empty after intersecting explicit policy layers`,
        field,
        details: {
          sourceIds: uniqueSorted([...allowlistSourceIds[field]])
        }
      });
    }
  }

  const waiverApplications: WaiverApplication[] = [];
  const waiverIds = new Set<string>();
  for (const waiver of options.waivers ?? []) {
    if (isTrimmedNonEmptyString((waiver as Partial<Waiver>).id)) {
      if (waiverIds.has(waiver.id)) {
        issues.push({
          code: "DUPLICATE_WAIVER_ID",
          message: `Waiver id ${waiver.id} appears more than once`,
          waiverId: waiver.id
        });
        continue;
      }
      waiverIds.add(waiver.id);
    }
    const invalidFields = validateWaiverShape(waiver, now);
    if (invalidFields.length > 0) {
      issues.push({
        code: "WAIVER_INVALID",
        message: "Waiver is missing required, valid approval metadata",
        ...(isNonEmptyString((waiver as Partial<Waiver>).id)
          ? { waiverId: waiver.id }
          : {}),
        details: { invalidFields }
      });
      continue;
    }

    if (Date.parse(waiver.expiresAt) <= now.getTime()) {
      issues.push({
        code: "WAIVER_EXPIRED",
        message: `Waiver ${waiver.id} expired at ${waiver.expiresAt}`,
        waiverId: waiver.id,
        field: waiver.target.field
      });
      continue;
    }

    if (activeScopeIds.get(waiver.scope.level) !== waiver.scope.id) {
      issues.push({
        code: "WAIVER_SCOPE_MISMATCH",
        message: `Waiver ${waiver.id} is outside the active governance scope`,
        waiverId: waiver.id,
        field: waiver.target.field,
        details: { scope: waiver.scope }
      });
      continue;
    }

    const targetOrigins = origins[waiver.target.field].get(waiver.target.value);
    if (!targetOrigins || targetOrigins.length === 0) {
      issues.push({
        code: "WAIVER_TARGET_NOT_FOUND",
        message: `Waiver ${waiver.id} targets a rule that is not effective`,
        waiverId: waiver.id,
        field: waiver.target.field,
        details: { target: waiver.target }
      });
      continue;
    }

    const nonWaivableSources = targetOrigins
      .filter((origin) => !origin.waivable)
      .map((origin) => origin.sourceId);
    if (nonWaivableSources.length > 0) {
      issues.push({
        code: "WAIVER_TARGET_NON_WAIVABLE",
        message: `Waiver ${waiver.id} cannot relax a non-waivable rule`,
        waiverId: waiver.id,
        field: waiver.target.field,
        details: { sourceIds: uniqueSorted(nonWaivableSources) }
      });
      continue;
    }

    waiverApplications.push({
      waiver,
      sourceIds: uniqueSorted(targetOrigins.map((origin) => origin.sourceId))
    });
  }

  if (issues.length > 0) {
    throw new GovernanceResolutionError(issues);
  }

  for (const application of waiverApplications) {
    unionValues[application.waiver.target.field].delete(
      application.waiver.target.value
    );
  }

  const appliedWaivers = waiverApplications
    .map((application) => copyWaiver(application.waiver, application.sourceIds))
    .sort((left, right) =>
      compareStrings(left.id, right.id) ||
      compareStrings(waiverTargetKey(left.target), waiverTargetKey(right.target))
    );
  const waiverIdsByField: Record<WaivablePolicyField, string[]> = {
    requiredGates: [],
    deny: [],
    protectedPaths: []
  };
  for (const waiver of appliedWaivers) {
    waiverIdsByField[waiver.target.field].push(waiver.id);
  }

  const requiredGates = uniqueSorted([...unionValues.requiredGates]);
  const deny = uniqueSorted([...unionValues.deny]);
  const protectedPaths = uniqueSorted([...unionValues.protectedPaths]);
  const allowedProviders = allowlists.allowedProviders as
    | readonly GovernanceProvider[]
    | undefined;
  const commandAllowlist = allowlists.commandAllowlist;
  const networkAllowlist = allowlists.networkAllowlist;
  const budgets: GovernanceBudget = Object.fromEntries(
    BUDGET_FIELDS.flatMap((field) => {
      const value = effectiveBudgets[field];
      return value === undefined ? [] : [[field, value]];
    })
  );

  const policy: ResolvedPolicyRuleSet = {
    requiredGates,
    deny,
    protectedPaths,
    ...(allowedProviders !== undefined ? { allowedProviders: [...allowedProviders] } : {}),
    ...(commandAllowlist !== undefined ? { commandAllowlist: [...commandAllowlist] } : {}),
    ...(networkAllowlist !== undefined ? { networkAllowlist: [...networkAllowlist] } : {}),
    budgets,
    approvalMode
  };

  const decisions: GovernanceDecision[] = [];
  for (const field of UNION_FIELDS) {
    const effectiveValue = [...policy[field]];
    const sourceIds = uniqueSorted([...unionSourceIds[field]]);
    const waiverIds = uniqueSorted(waiverIdsByField[field]);
    decisions.push({
      field,
      strategy: "union",
      effectiveValue,
      sourceIds,
      ...(waiverIds.length > 0 ? { waiverIds } : {}),
      summary: decisionSummary(field, "union", effectiveValue, sourceIds.length, waiverIds)
    });
  }
  for (const field of ALLOWLIST_FIELDS) {
    const effectiveValue = policy[field];
    if (effectiveValue === undefined) continue;
    const sourceIds = uniqueSorted([...allowlistSourceIds[field]]);
    decisions.push({
      field,
      strategy: "intersection",
      effectiveValue: [...effectiveValue],
      sourceIds,
      summary: decisionSummary(field, "intersection", effectiveValue, sourceIds.length)
    });
  }
  for (const field of BUDGET_FIELDS) {
    const effectiveValue = policy.budgets[field];
    if (effectiveValue === undefined) continue;
    const sourceIds = uniqueSorted([...(budgetSourceIds.get(field) ?? [])]);
    const decisionField = `budgets.${field}` as const;
    decisions.push({
      field: decisionField,
      strategy: "minimum",
      effectiveValue,
      sourceIds,
      summary: decisionSummary(decisionField, "minimum", effectiveValue, sourceIds.length)
    });
  }
  const approvalSources = uniqueSorted([...approvalSourceIds]);
  decisions.push({
    field: "approvalMode",
    strategy: "strictest",
    effectiveValue: approvalMode,
    sourceIds: approvalSources,
    summary: decisionSummary(
      "approvalMode",
      "strictest",
      approvalMode,
      approvalSources.length
    )
  });

  const layerSnapshots: GovernanceLayerSnapshot[] = preparedLayers.map((layer) => ({
    scope: layer.scope,
    scopeId: layer.scopeId,
    source: { ...layer.source },
    policyDigest: sha256Canonical(layer.policy)
  }));
  const semanticSnapshot = {
    schemaVersion: 1 as const,
    layers: layerSnapshots,
    policy,
    appliedWaivers,
    decisions,
    ...(options.specRef
      ? {
          specRef: {
            specSetId: options.specRef.specSetId,
            revision: options.specRef.revision,
            digest: options.specRef.digest
          }
        }
      : {}),
    ...(options.workflowRef
      ? { workflowRef: { ...options.workflowRef } }
      : {}),
    ...(options.harnessProfileRef
      ? { harnessProfileRef: { ...options.harnessProfileRef } }
      : {})
  };
  const snapshot: GovernanceSnapshot = {
    ...semanticSnapshot,
    resolvedAt: now.toISOString(),
    digest: sha256Canonical(semanticSnapshot)
  };
  return deepFreeze(snapshot);
}
