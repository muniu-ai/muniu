import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  canonicalJson,
  sha256Digest,
  validateSpecRevision,
  type SpecRevision,
  type StructuredContract
} from "@mn/specs";
import type {
  ArchitectureIndex,
  ArchitectureIssue,
  ImpactDimension,
  ImpactFinding,
  ImpactLevel,
  ImpactMatrixEntry,
  SpecImpactReport
} from "./architectureTypes.js";
import { digestArchitectureIndex } from "./architectureIndex.js";
import { normalizeRepositoryRelativePath } from "./projectManifest.js";

const DIRECT_DIMENSIONS = [
  "interface",
  "data",
  "state",
  "permission",
  "exception",
  "quality",
  "observability"
] as const;
const ALL_DIMENSIONS: readonly ImpactDimension[] = [
  ...DIRECT_DIMENSIONS,
  "compatibility",
  "regression",
  "release"
];
const LEVEL_RANK: Readonly<Record<ImpactLevel, number>> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4
};

export function analyzeSpecImpact(
  architecture: ArchitectureIndex,
  spec: SpecRevision,
  previousSpec?: SpecRevision
): SpecImpactReport {
  assertArchitectureIndex(architecture);
  assertImpactSpec(spec, "spec", ["approved"]);
  if (previousSpec) {
    assertImpactSpec(previousSpec, "previousSpec", ["approved", "superseded"]);
  }

  const specDigest = spec.digest!;
  const predecessorMatches = Boolean(
    previousSpec &&
      previousSpec.specSetId === spec.specSetId &&
      previousSpec.revision < spec.revision
  );
  const comparisonSpec = predecessorMatches ? previousSpec : undefined;
  const requestedServices = requestedTargetServices(spec);
  const knownServiceIds = new Set(architecture.services.map(({ id }) => id));
  const unknownServices = requestedServices.filter(
    (service) => !knownServiceIds.has(service)
  );
  const initiallyKnown =
    requestedServices.length === 0
      ? architecture.services.map(({ id }) => id)
      : requestedServices.filter((service) => knownServiceIds.has(service));
  const expandedKnown = expandImpactedServices(architecture, initiallyKnown);
  const impactedServices = uniqueSorted([...expandedKnown, ...unknownServices]);
  const crossService = expandedKnown.length > 1;
  const changedDirect = new Map<(typeof DIRECT_DIMENSIONS)[number], boolean>();
  for (const dimension of DIRECT_DIMENSIONS) {
    changedDirect.set(
      dimension,
      contractDimensionChanged(
        spec.contracts[dimension],
        comparisonSpec?.contracts[dimension]
      )
    );
  }
  const acceptanceChanged =
    !comparisonSpec ||
    canonicalJson(spec.acceptanceCases) !==
      canonicalJson(comparisonSpec.acceptanceCases);
  const scopeChanged =
    !comparisonSpec ||
    canonicalJson(specScopeValue(spec)) !==
      canonicalJson(specScopeValue(comparisonSpec));
  const scopeOnly =
    scopeChanged &&
    !acceptanceChanged &&
    ![...changedDirect.values()].some(Boolean);
  const breakingContract =
    changedDirect.get("interface") === true &&
    containsBreakingContractSignal(spec.contracts.interface);

  const findings = buildFindings({
    architecture,
    impactedServices,
    unknownServices,
    crossService,
    breakingContract,
    previousSpec,
    predecessorMatches
  });
  const relevantArchitectureIssues = architecture.issues.filter((issue) =>
    issueApplies(issue, impactedServices)
  );
  const matrix = ALL_DIMENSIONS.map((dimension) =>
    buildMatrixEntry({
      dimension,
      spec,
      impactedServices,
      crossService,
      breakingContract,
      changedDirect,
      acceptanceChanged,
      scopeChanged,
      scopeOnly,
      architecture,
      relevantArchitectureIssues
    })
  ).sort((left, right) => compareCodeUnits(left.dimension, right.dimension));

  const overallLevel = maxLevel([
    ...matrix.map(({ level }) => level),
    ...findings.map(({ level }) => level)
  ]);
  const requiredGates = uniqueSorted(
    matrix.flatMap((entry) => (entry.level === "L0" ? [] : entry.requiredGates))
  );
  const requiredApprovals = buildRequiredApprovals({
    crossService,
    breakingContract,
    dataChanged: changedDirect.get("data") === true,
    overallLevel,
    unknownServices,
    relevantArchitectureIssues
  });
  const traceDimensions = DIRECT_DIMENSIONS.filter(
    (dimension) => changedDirect.get(dimension) === true
  ).sort(compareCodeUnits);

  const withoutDigest: Omit<SpecImpactReport, "digest"> = {
    schemaVersion: 1,
    specRef: {
      specSetId: spec.specSetId,
      revision: spec.revision,
      digest: specDigest
    },
    architectureDigest: architecture.digest,
    ...(previousSpec?.digest
      ? { previousSpecDigest: previousSpec.digest }
      : {}),
    overallLevel,
    impactedServices,
    matrix,
    findings,
    requiredGates,
    requiredApprovals,
    trace: {
      acceptanceCaseIds: uniqueSorted(
        spec.acceptanceCases.map(({ id }) => id)
      ),
      contractDimensions: traceDimensions
    }
  };
  return deepFreeze({
    ...withoutDigest,
    digest: sha256Digest(withoutDigest)
  });
}

function assertArchitectureIndex(index: ArchitectureIndex): void {
  if (!index || typeof index !== "object" || index.schemaVersion !== 1) {
    throw new TypeError("Architecture index must use schemaVersion 1");
  }
  if (
    typeof index.projectId !== "string" ||
    index.projectId.length === 0 ||
    index.projectId !== index.projectId.trim()
  ) {
    throw new TypeError("Architecture index projectId is invalid");
  }
  if (
    typeof index.rootPath !== "string" ||
    !isAbsolute(index.rootPath) ||
    !Array.isArray(index.services) ||
    !Array.isArray(index.issues) ||
    !Array.isArray(index.consistency)
  ) {
    throw new TypeError("Architecture index structure is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(index.digest)) {
    throw new TypeError("Architecture index digest is invalid");
  }
  const serviceIds = index.services.map(({ id }) => id);
  if (new Set(serviceIds).size !== serviceIds.length) {
    throw new TypeError("Architecture index contains duplicate service ids");
  }
  for (const service of index.services) {
    const relativePath = normalizeArchitecturePath(service.relativePath, true);
    const absoluteServicePath = resolve(index.rootPath, relativePath);
    assertPathWithinRoot(index.rootPath, absoluteServicePath);
    if (
      typeof service.id !== "string" ||
      service.id.length === 0 ||
      typeof service.relativePath !== "string" ||
      typeof service.path !== "string" ||
      absoluteServicePath !== resolve(service.path)
    ) {
      throw new TypeError(`Architecture service ${String(service.id)} path is invalid`);
    }
    for (const contract of service.contracts) {
      normalizeArchitecturePath(contract.path, false);
    }
    for (const migration of service.migrations) {
      normalizeArchitecturePath(migration, false);
    }
  }
  for (const path of index.ciFiles) normalizeArchitecturePath(path, false);
  if (index.manifestPath) normalizeArchitecturePath(index.manifestPath, false);
  if (index.codeownersPath) normalizeArchitecturePath(index.codeownersPath, false);
  let expected: string;
  try {
    expected = digestArchitectureIndex(index);
  } catch (error) {
    throw new TypeError(
      `Architecture index cannot be canonicalized: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (expected !== index.digest) {
    throw new TypeError("Architecture index digest does not match its semantic content");
  }
}

function assertImpactSpec(
  spec: SpecRevision,
  field: string,
  allowedStatuses: readonly SpecRevision["status"][]
): void {
  const validation = validateSpecRevision(spec);
  if (!validation.valid) {
    throw new TypeError(
      `Invalid ${field}: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }
  if (!allowedStatuses.includes(spec.status)) {
    throw new TypeError(
      `${field} must have status ${allowedStatuses.join(" or ")}`
    );
  }
  if (!spec.digest || !/^[a-f0-9]{64}$/u.test(spec.digest)) {
    throw new TypeError(`${field} must have a canonical digest`);
  }
  if (new Set(spec.targetServices).size !== spec.targetServices.length) {
    throw new TypeError(`${field}.targetServices must not contain duplicates`);
  }
}

function requestedTargetServices(spec: SpecRevision): string[] {
  return uniqueSorted([
    ...spec.targetServices,
    ...spec.acceptanceCases.flatMap((acceptance) =>
      acceptance.targetService ? [acceptance.targetService] : []
    )
  ]);
}

function expandImpactedServices(
  architecture: ArchitectureIndex,
  initial: readonly string[]
): string[] {
  const impacted = new Set(initial);
  let changed = true;
  while (changed) {
    changed = false;
    const include = (service: string) => {
      if (!impacted.has(service)) {
        impacted.add(service);
        changed = true;
      }
    };
    for (const service of architecture.services) {
      for (const dependency of service.dependencies) {
        if (impacted.has(service.id) || impacted.has(dependency.service)) {
          include(service.id);
          include(dependency.service);
        }
      }
    }
    for (const boundary of architecture.consistency) {
      if (boundary.participants.some((participant) => impacted.has(participant))) {
        boundary.participants.forEach(include);
      }
    }
    const resources = new Map<string, string[]>();
    for (const service of architecture.services) {
      for (const resource of service.data) {
        const key = `${resource.kind}:${resource.name}`;
        const services = resources.get(key) ?? [];
        services.push(service.id);
        resources.set(key, services);
      }
    }
    for (const services of resources.values()) {
      if (services.some((service) => impacted.has(service))) services.forEach(include);
    }
  }
  return [...impacted].sort(compareCodeUnits);
}

function contractDimensionChanged(
  current: StructuredContract,
  previous: StructuredContract | undefined
): boolean {
  if (previous === undefined) return Object.keys(current).length > 0;
  return canonicalJson(current) !== canonicalJson(previous);
}

function buildFindings(input: {
  architecture: ArchitectureIndex;
  impactedServices: readonly string[];
  unknownServices: readonly string[];
  crossService: boolean;
  breakingContract: boolean;
  previousSpec: SpecRevision | undefined;
  predecessorMatches: boolean;
}): ImpactFinding[] {
  const findings: ImpactFinding[] = input.architecture.issues
    .filter((issue) => issueApplies(issue, input.impactedServices))
    .map((issue) => ({
      code: issue.code,
      level: issue.level,
      message: issue.message,
      services: uniqueSorted(issue.services)
    }));
  for (const service of input.unknownServices) {
    findings.push({
      code: "UNKNOWN_TARGET_SERVICE",
      level: "L4",
      message: `Spec targets unknown service ${service}; impact cannot be bounded.`,
      services: [service]
    });
  }
  if (input.crossService) {
    findings.push({
      code: "CROSS_SERVICE_CHANGE",
      level: "L3",
      message: `Change impacts multiple services: ${input.impactedServices.join(", ")}.`,
      services: uniqueSorted(input.impactedServices)
    });
  }
  if (input.breakingContract) {
    findings.push({
      code: "BREAKING_CONTRACT",
      level: "L4",
      message: "Spec declares a breaking interface contract change.",
      services: uniqueSorted(input.impactedServices)
    });
  }
  if (input.previousSpec && !input.predecessorMatches) {
    findings.push({
      code: "SPEC_REVISION_MISMATCH",
      level: "L4",
      message:
        "Previous Spec must belong to the same SpecSet and have a lower revision.",
      services: uniqueSorted(input.impactedServices)
    });
  }
  return uniqueFindings(findings);
}

function issueApplies(
  issue: ArchitectureIssue,
  impactedServices: readonly string[]
): boolean {
  if (impactedServices.length === 0) return true;
  const impacted = new Set(impactedServices);
  return issue.services.some((service) => impacted.has(service));
}

function buildMatrixEntry(input: {
  dimension: ImpactDimension;
  spec: SpecRevision;
  impactedServices: readonly string[];
  crossService: boolean;
  breakingContract: boolean;
  changedDirect: ReadonlyMap<(typeof DIRECT_DIMENSIONS)[number], boolean>;
  acceptanceChanged: boolean;
  scopeChanged: boolean;
  scopeOnly: boolean;
  architecture: ArchitectureIndex;
  relevantArchitectureIssues: readonly ArchitectureIssue[];
}): ImpactMatrixEntry {
  const changed = dimensionChanged(
    input.dimension,
    input.changedDirect,
    input.acceptanceChanged,
    input.scopeChanged
  );
  if (!changed) {
    return {
      dimension: input.dimension,
      level: "L0",
      services: uniqueSorted(input.impactedServices),
      clauseIds: [],
      reasons: ["No semantic change detected for this dimension."],
      requiredGates: []
    };
  }

  const level = dimensionLevel(input.dimension, input);
  return {
    dimension: input.dimension,
    level,
    services: uniqueSorted(input.impactedServices),
    clauseIds: clauseIds(input.dimension, input.spec),
    reasons: dimensionReasons(input.dimension, input, level),
    requiredGates: gatesForDimension(input.dimension, input, level)
  };
}

function dimensionChanged(
  dimension: ImpactDimension,
  changedDirect: ReadonlyMap<(typeof DIRECT_DIMENSIONS)[number], boolean>,
  acceptanceChanged: boolean,
  scopeChanged: boolean
): boolean {
  if ((DIRECT_DIMENSIONS as readonly string[]).includes(dimension)) {
    return changedDirect.get(dimension as (typeof DIRECT_DIMENSIONS)[number]) === true;
  }
  if (dimension === "compatibility") return changedDirect.get("interface") === true;
  if (dimension === "regression") {
    return acceptanceChanged || scopeChanged || [...changedDirect.values()].some(Boolean);
  }
  return [...changedDirect.values()].some(Boolean) || acceptanceChanged || scopeChanged;
}

function dimensionLevel(
  dimension: ImpactDimension,
  input: {
    crossService: boolean;
    breakingContract: boolean;
    changedDirect: ReadonlyMap<(typeof DIRECT_DIMENSIONS)[number], boolean>;
    architecture: ArchitectureIndex;
    impactedServices: readonly string[];
    relevantArchitectureIssues: readonly ArchitectureIssue[];
    scopeOnly: boolean;
  }
): ImpactLevel {
  const hasL4ArchitectureRisk = input.relevantArchitectureIssues.some(
    ({ level }) => level === "L4"
  );
  switch (dimension) {
    case "interface":
    case "compatibility":
      return input.breakingContract ? "L4" : input.crossService ? "L3" : "L2";
    case "data":
      return input.crossService || hasL4ArchitectureRisk ? "L4" : "L3";
    case "state":
      return input.crossService ? "L3" : "L2";
    case "permission":
      return "L3";
    case "exception":
    case "quality":
    case "observability":
      return input.crossService ? "L3" : "L2";
    case "regression":
      if (input.scopeOnly) return "L1";
      return input.crossService ? "L3" : "L2";
    case "release": {
      if (input.scopeOnly) return "L1";
      const hasMigrations = input.architecture.services.some(
        (service) =>
          input.impactedServices.includes(service.id) && service.migrations.length > 0
      );
      if (
        input.breakingContract ||
        (input.changedDirect.get("data") === true && hasMigrations)
      ) {
        return "L4";
      }
      return input.crossService ? "L3" : "L2";
    }
  }
}

function gatesForDimension(
  dimension: ImpactDimension,
  input: {
    crossService: boolean;
    changedDirect: ReadonlyMap<(typeof DIRECT_DIMENSIONS)[number], boolean>;
  },
  level: ImpactLevel
): string[] {
  if (level === "L1") return [];
  const gates: string[] = [];
  switch (dimension) {
    case "interface":
    case "compatibility":
      gates.push("contract");
      break;
    case "data":
      gates.push("migration_safety");
      break;
    case "state":
      gates.push("contract", "unit_test");
      break;
    case "permission":
      gates.push("security");
      break;
    case "exception":
    case "quality":
    case "observability":
      gates.push("unit_test");
      break;
    case "regression":
      gates.push("unit_test");
      if (input.crossService) gates.push("contract");
      break;
    case "release":
      if (input.changedDirect.get("data")) gates.push("migration_safety");
      if (input.crossService || level === "L4") gates.push("human_approval");
      break;
  }
  return uniqueSorted(gates);
}

function clauseIds(dimension: ImpactDimension, spec: SpecRevision): string[] {
  if ((DIRECT_DIMENSIONS as readonly string[]).includes(dimension)) {
    return [`contracts.${dimension}`];
  }
  if (dimension === "compatibility") return ["contracts.interface"];
  if (dimension === "regression") {
    return uniqueSorted(
      spec.acceptanceCases.map(({ id }) => `acceptanceCases.${id}`)
    );
  }
  return uniqueSorted([
    "contracts.interface",
    "contracts.data",
    "contracts.observability"
  ]);
}

function dimensionReasons(
  dimension: ImpactDimension,
  input: {
    crossService: boolean;
    breakingContract: boolean;
    relevantArchitectureIssues: readonly ArchitectureIssue[];
  },
  level: ImpactLevel
): string[] {
  const reasons = [`${dimension} changed and is classified ${level}.`];
  if (input.breakingContract && (dimension === "interface" || dimension === "compatibility")) {
    reasons.push("The interface contract explicitly declares a breaking change.");
  }
  if (input.crossService) reasons.push("The dependency/data graph expands impact across services.");
  if (
    (dimension === "data" || dimension === "release") &&
    input.relevantArchitectureIssues.length > 0
  ) {
    reasons.push(
      `Architecture risks: ${uniqueSorted(
        input.relevantArchitectureIssues.map(({ code }) => code)
      ).join(", ")}.`
    );
  }
  return uniqueSorted(reasons);
}

function buildRequiredApprovals(input: {
  crossService: boolean;
  breakingContract: boolean;
  dataChanged: boolean;
  overallLevel: ImpactLevel;
  unknownServices: readonly string[];
  relevantArchitectureIssues: readonly ArchitectureIssue[];
}): string[] {
  const approvals: string[] = [];
  if (input.crossService) approvals.push("cross_service_owner");
  if (input.breakingContract) approvals.push("contract_owner");
  if (input.dataChanged) approvals.push("data_owner");
  if (
    input.overallLevel === "L4" ||
    input.relevantArchitectureIssues.some(({ level }) => level === "L4")
  ) {
    approvals.push("architecture_review");
  }
  if (input.unknownServices.length > 0) approvals.push("manual_triage");
  return uniqueSorted(approvals);
}

function containsBreakingContractSignal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsBreakingContractSignal);
  if (!isPlainRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized === "breaking" && nested === true) return true;
    if (
      (normalized === "backwardcompatible" ||
        normalized === "backward_compatible") &&
      nested === false
    ) {
      return true;
    }
    if (
      (normalized === "compatibility" || normalized === "change") &&
      typeof nested === "string" &&
      nested.toLowerCase() === "breaking"
    ) {
      return true;
    }
    if (containsBreakingContractSignal(nested)) return true;
  }
  return false;
}

function specScopeValue(spec: SpecRevision): unknown {
  return {
    title: spec.title,
    hypothesis: spec.hypothesis,
    outcomes: spec.outcomes,
    nonGoals: spec.nonGoals,
    targetServices: spec.targetServices
  };
}

function normalizeArchitecturePath(value: string, allowRoot: boolean): string {
  if (allowRoot && value === ".") return value;
  return normalizeRepositoryRelativePath(value, "architecture path");
}

function assertPathWithinRoot(root: string, path: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError("Architecture path must remain within the repository root");
  }
}

function uniqueFindings(findings: readonly ImpactFinding[]): ImpactFinding[] {
  const byIdentity = new Map<string, ImpactFinding>();
  for (const finding of findings) {
    const normalized = { ...finding, services: uniqueSorted(finding.services) };
    const identity = `${normalized.code}:${normalized.services.join("\0")}:${normalized.message}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, normalized);
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.services.join("\0"), right.services.join("\0")) ||
      compareCodeUnits(left.message, right.message)
  );
}

function maxLevel(levels: readonly ImpactLevel[]): ImpactLevel {
  let maximum: ImpactLevel = "L0";
  for (const level of levels) {
    if (LEVEL_RANK[level] > LEVEL_RANK[maximum]) maximum = level;
  }
  return maximum;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
