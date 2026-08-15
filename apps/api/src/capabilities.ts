import { createHash } from "node:crypto";
import {
  CLASSIC_WORKFLOW_REF,
  GOVERNED_INCREMENT_WORKFLOW_REF
} from "@mn/core";
import {
  ENTERPRISE_HARNESS_PROFILE,
  LOCAL_HARNESS_PROFILE
} from "@mn/harness";

export type RuntimeCapabilityKind =
  | "provider"
  | "gate"
  | "workflow"
  | "harness_profile";

export type RuntimeCapabilityStatus =
  | "available"
  | "unavailable"
  | "declared";

export interface RuntimeCapabilityDescriptor {
  readonly kind: RuntimeCapabilityKind;
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly status: RuntimeCapabilityStatus;
  readonly description?: string;
  readonly runnerId?: string;
  readonly capabilities?: readonly string[];
  readonly languages?: readonly string[];
  readonly evidenceFormats?: readonly string[];
  readonly reason?: string;
  /** Immutable digest of the versioned capability definition. */
  readonly digest?: string;
}

export interface RuntimeCapabilityCatalog {
  readonly providers: readonly RuntimeCapabilityDescriptor[];
  readonly gates: readonly RuntimeCapabilityDescriptor[];
  readonly workflows: readonly RuntimeCapabilityDescriptor[];
  readonly harnessProfiles: readonly RuntimeCapabilityDescriptor[];
}

export interface CapabilitiesDocument extends RuntimeCapabilityCatalog {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly digest: string;
}

export interface WorkflowsDocument {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly digest: string;
  readonly workflows: readonly RuntimeCapabilityDescriptor[];
}

export interface HarnessProfilesDocument {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly digest: string;
  readonly harnessProfiles: readonly RuntimeCapabilityDescriptor[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createDefaultRuntimeCapabilityCatalog(): RuntimeCapabilityCatalog {
  return normalizeRuntimeCapabilityCatalog({
    providers: [
      {
        kind: "provider",
        id: "claude",
        version: "1",
        displayName: "Claude Code",
        status: "available",
        runnerId: "claude-code-executor",
        capabilities: ["managed-coding-app"]
      },
      {
        kind: "provider",
        id: "codex",
        version: "1",
        displayName: "Codex",
        status: "available",
        runnerId: "codex-executor",
        capabilities: ["managed-coding-app"]
      }
    ],
    gates: [
      availableGate("unit_test", "Unit test", "npm-script:test"),
      availableGate("lint", "Lint", "npm-script:lint"),
      availableGate("typecheck", "Typecheck", "npm-script:typecheck"),
      availablePolicyGate("acceptance_coverage", "Acceptance coverage", "builtin/acceptance-coverage", ["other"]),
      availablePolicyGate("contract", "Contract", "builtin/contract", ["contract"]),
      availablePolicyGate("diff_scope", "Diff scope", "builtin/diff-scope", ["other"]),
      availablePolicyGate("migration_safety", "Migration safety", "builtin/migration-safety", ["log"]),
      availablePolicyGate("protected_path", "Protected path", "builtin/protected-path", ["other"]),
      availablePolicyGate("security", "Security", "builtin/security", ["sarif"]),
      availablePolicyGate("spec_approval", "Spec approval", "builtin/spec-approval", ["other"]),
      availablePolicyGate("spec_schema", "Spec schema", "builtin/spec-schema", ["other"]),
      {
        kind: "gate",
        id: "llm_verifier",
        version: "1",
        displayName: "LLM verifier",
        status: "available",
        runnerId: "classic-output-verifier",
        evidenceFormats: ["artifact-ref-v1"]
      },
      {
        kind: "gate",
        id: "human_approval",
        version: "1",
        displayName: "Human approval",
        status: "available",
        runnerId: "api-human-approval",
        evidenceFormats: ["run-event-v1"]
      }
    ],
    workflows: [
      {
        kind: "workflow",
        id: "classic-v1",
        version: "1",
        displayName: "Classic candidate workflow",
        status: "available",
        runnerId: "classic-orchestrator",
        digest: CLASSIC_WORKFLOW_REF.digest,
        capabilities: ["candidate-comparison", "legacy-prompt"]
      },
      {
        kind: "workflow",
        id: "governed-increment-v1",
        version: "1",
        displayName: "Governed increment workflow",
        status: "available",
        runnerId: "governed-loop-orchestrator",
        digest: GOVERNED_INCREMENT_WORKFLOW_REF.digest,
        capabilities: [
          "approval-gates",
          "bounded-repair-loop",
          "immutable-snapshots",
          "stage-checkpoints"
        ]
      }
    ],
    harnessProfiles: [
      {
        kind: "harness_profile",
        id: "local",
        version: "1",
        displayName: "Local",
        status: "available",
        digest: LOCAL_HARNESS_PROFILE.digest,
        capabilities: ["implicit-local-tenant", "worktree-postcheck"]
      },
      {
        kind: "harness_profile",
        id: "enterprise",
        version: "1",
        displayName: "Enterprise",
        status: "declared",
        digest: ENTERPRISE_HARNESS_PROFILE.digest,
        capabilities: [
          "container-or-remote-sandbox",
          "oidc-jwt",
          "postgresql",
          "remote-artifacts"
        ],
        reason: "The enterprise profile contract is declared but is not runnable yet."
      }
    ]
  });
}

export function normalizeRuntimeCapabilityCatalog(
  catalog: RuntimeCapabilityCatalog
): RuntimeCapabilityCatalog {
  const normalized = {
    providers: normalizeDescriptors(catalog.providers, "provider"),
    gates: normalizeDescriptors(catalog.gates, "gate"),
    workflows: normalizeDescriptors(catalog.workflows, "workflow"),
    harnessProfiles: normalizeDescriptors(
      catalog.harnessProfiles,
      "harness_profile"
    )
  };
  return deepFreeze(normalized);
}

export function buildCapabilitiesDocument(
  catalog: RuntimeCapabilityCatalog,
  generatedAt = new Date().toISOString()
): CapabilitiesDocument {
  const normalized = normalizeRuntimeCapabilityCatalog(catalog);
  const semantic = {
    schemaVersion: 1 as const,
    providers: normalized.providers,
    gates: normalized.gates,
    workflows: normalized.workflows,
    harnessProfiles: normalized.harnessProfiles
  };
  return deepFreeze({
    ...semantic,
    generatedAt: validateGeneratedAt(generatedAt),
    digest: semanticDigest(semantic)
  });
}

export function buildWorkflowsDocument(
  catalog: RuntimeCapabilityCatalog,
  generatedAt = new Date().toISOString()
): WorkflowsDocument {
  const workflows = normalizeRuntimeCapabilityCatalog(catalog).workflows;
  const semantic = { schemaVersion: 1 as const, workflows };
  return deepFreeze({
    ...semantic,
    generatedAt: validateGeneratedAt(generatedAt),
    digest: semanticDigest(semantic)
  });
}

export function buildHarnessProfilesDocument(
  catalog: RuntimeCapabilityCatalog,
  generatedAt = new Date().toISOString()
): HarnessProfilesDocument {
  const harnessProfiles = normalizeRuntimeCapabilityCatalog(catalog).harnessProfiles;
  const semantic = { schemaVersion: 1 as const, harnessProfiles };
  return deepFreeze({
    ...semantic,
    generatedAt: validateGeneratedAt(generatedAt),
    digest: semanticDigest(semantic)
  });
}

function availableGate(
  id: string,
  displayName: string,
  runnerId: string
): RuntimeCapabilityDescriptor {
  return {
    kind: "gate",
    id,
    version: "1",
    displayName,
    status: "available",
    runnerId,
    languages: ["go", "java", "javascript", "kotlin", "python", "rust", "typescript"],
    evidenceFormats: ["gate-result-v2", "log"]
  };
}

function availablePolicyGate(
  id: string,
  displayName: string,
  runnerId: string,
  evidenceFormats: readonly string[]
): RuntimeCapabilityDescriptor {
  return {
    kind: "gate",
    id,
    version: "2",
    displayName,
    status: "available",
    runnerId,
    languages: ["*"],
    evidenceFormats: ["gate-result-v2", ...evidenceFormats]
  };
}

function normalizeDescriptors(
  descriptors: readonly RuntimeCapabilityDescriptor[],
  expectedKind: RuntimeCapabilityKind
): readonly RuntimeCapabilityDescriptor[] {
  if (!Array.isArray(descriptors)) {
    throw new TypeError(`${expectedKind} capabilities must be an array`);
  }
  const seen = new Set<string>();
  const normalized = descriptors.map((descriptor, index) => {
    if (!descriptor || typeof descriptor !== "object") {
      throw new TypeError(`${expectedKind}[${index}] must be an object`);
    }
    if (descriptor.kind !== expectedKind) {
      throw new TypeError(
        `${expectedKind}[${index}].kind must be ${expectedKind}`
      );
    }
    const id = nonEmptyTrimmed(descriptor.id, `${expectedKind}[${index}].id`);
    const version = nonEmptyTrimmed(
      descriptor.version,
      `${expectedKind}[${index}].version`
    );
    const identity = `${id}@${version}`;
    if (seen.has(identity)) {
      throw new TypeError(`duplicate ${expectedKind} capability: ${identity}`);
    }
    seen.add(identity);
    if (
      descriptor.status !== "available" &&
      descriptor.status !== "unavailable" &&
      descriptor.status !== "declared"
    ) {
      throw new TypeError(`${expectedKind}[${index}].status is invalid`);
    }
    const compact = compactDescriptor({
      kind: descriptor.kind,
      id,
      version,
      displayName: nonEmptyTrimmed(
        descriptor.displayName,
        `${expectedKind}[${index}].displayName`
      ),
      status: descriptor.status,
      description: optionalTrimmed(
        descriptor.description,
        `${expectedKind}[${index}].description`
      ),
      runnerId: optionalTrimmed(
        descriptor.runnerId,
        `${expectedKind}[${index}].runnerId`
      ),
      capabilities: normalizeStringList(
        descriptor.capabilities,
        `${expectedKind}[${index}].capabilities`
      ),
      languages: normalizeStringList(
        descriptor.languages,
        `${expectedKind}[${index}].languages`
      ),
      evidenceFormats: normalizeStringList(
        descriptor.evidenceFormats,
        `${expectedKind}[${index}].evidenceFormats`
      ),
      reason: optionalTrimmed(
        descriptor.reason,
        `${expectedKind}[${index}].reason`
      )
    });
    const suppliedDigest = descriptor.digest;
    if (
      suppliedDigest !== undefined &&
      (typeof suppliedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(suppliedDigest))
    ) {
      throw new TypeError(`${expectedKind}[${index}].digest must be lowercase SHA-256`);
    }
    return {
      ...compact,
      digest: suppliedDigest ?? capabilityDefinitionDigest(compact)
    };
  });
  normalized.sort(
    (left, right) =>
      compareCodeUnits(left.id, right.id) ||
      compareCodeUnits(left.version, right.version)
  );
  return deepFreeze(normalized);
}

function compactDescriptor(input: {
  kind: RuntimeCapabilityKind;
  id: string;
  version: string;
  displayName: string;
  status: RuntimeCapabilityStatus;
  description?: string;
  runnerId?: string;
  capabilities?: readonly string[];
  languages?: readonly string[];
  evidenceFormats?: readonly string[];
  reason?: string;
}): RuntimeCapabilityDescriptor {
  return {
    kind: input.kind,
    id: input.id,
    version: input.version,
    displayName: input.displayName,
    status: input.status,
    ...(input.description ? { description: input.description } : {}),
    ...(input.runnerId ? { runnerId: input.runnerId } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.languages ? { languages: input.languages } : {}),
    ...(input.evidenceFormats ? { evidenceFormats: input.evidenceFormats } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  };
}

function capabilityDefinitionDigest(
  descriptor: RuntimeCapabilityDescriptor
): string {
  return semanticDigest({
    kind: descriptor.kind,
    id: descriptor.id,
    version: descriptor.version,
    runnerId: descriptor.runnerId ?? null,
    capabilities: descriptor.capabilities ?? [],
    languages: descriptor.languages ?? [],
    evidenceFormats: descriptor.evidenceFormats ?? []
  });
}

function normalizeStringList(
  value: readonly string[] | undefined,
  field: string
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const normalized = value.map((item, index) =>
    nonEmptyTrimmed(item, `${field}[${index}]`)
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} must not contain duplicates`);
  }
  return deepFreeze(normalized.sort(compareCodeUnits));
}

function nonEmptyTrimmed(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function optionalTrimmed(
  value: unknown,
  field: string
): string | undefined {
  return value === undefined ? undefined : nonEmptyTrimmed(value, field);
}

function validateGeneratedAt(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("generatedAt must be an ISO-compatible timestamp");
  }
  return value;
}

function semanticDigest(value: unknown): string {
  return createHash("sha256")
    .update(strictStableSerialize(value))
    .digest("hex");
}

function strictStableSerialize(value: unknown): string {
  const stack = new Set<object>();
  const serialize = (current: unknown, path: string): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError(`${path} must contain only finite numbers`);
      }
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (stack.has(current)) throw new TypeError(`${path} must not be circular`);
      stack.add(current);
      const result = `[${current
        .map((item, index) => serialize(item, `${path}[${index}]`))
        .join(",")}]`;
      stack.delete(current);
      return result;
    }
    if (typeof current === "object") {
      const object = current as Record<string, unknown>;
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} must contain only plain objects`);
      }
      if (stack.has(object)) throw new TypeError(`${path} must not be circular`);
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw new TypeError(`${path} must not contain symbol keys`);
      }
      stack.add(object);
      const keys = Object.keys(object).sort(compareCodeUnits);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || descriptor.get || descriptor.set) {
          stack.delete(object);
          throw new TypeError(`${path}.${key} must be a plain data property`);
        }
      }
      const result = `{${keys
        .map(
          (key) =>
            `${JSON.stringify(key)}:${serialize(object[key], `${path}.${key}`)}`
        )
        .join(",")}}`;
      stack.delete(object);
      return result;
    }
    throw new TypeError(`${path} contains a non-JSON value`);
  };
  return serialize(value, "$");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
