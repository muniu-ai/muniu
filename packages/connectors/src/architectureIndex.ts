import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import type { ContractRef } from "@mn/core";
import { sha256Digest } from "@mn/specs";
import type {
  ArchitectureDependency,
  ArchitectureIndex,
  ArchitectureIssue,
  ArchitectureService,
  ConsistencyBoundary,
  ManifestDataResource,
  ProjectManifest,
  ProjectManifestService
} from "./architectureTypes.js";
import {
  normalizeRepositoryRelativePath,
  parseProjectManifest
} from "./projectManifest.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".mn",
  ".cache",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  "dist-test",
  "node_modules",
  "target",
  "vendor"
]);
const SERVICE_MARKERS = new Set([
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "proto"
]);
const CODEOWNERS_CANDIDATES = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS"
] as const;
const ROOT_CI_FILES = [
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  ".circleci/config.yml",
  ".circleci/config.yaml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  ".buildkite/pipeline.yml",
  ".buildkite/pipeline.yaml"
] as const;
const CONTRACT_DOCUMENT_LIMIT = 5 * 1024 * 1024;
const MAX_WALK_ENTRIES = 20_000;

interface WalkFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
}

interface CodeOwnerRule {
  readonly pattern: string;
  readonly owners: readonly string[];
}

interface ServiceDraft {
  readonly id: string;
  readonly relativePath: string;
  readonly owners: readonly string[];
  readonly language?: string;
  readonly manifest?: ProjectManifestService;
}

export async function indexArchitectureRepository(
  rootPath: string
): Promise<ArchitectureIndex> {
  const root = await validateRepositoryRoot(rootPath);
  const warnings: string[] = [];
  const manifestDocument = await readOptionalRepositoryFile(
    root,
    ".mn/project.yaml"
  );
  const manifest = manifestDocument
    ? parseProjectManifest(manifestDocument)
    : undefined;
  if (!manifest) {
    warnings.push(
      "No .mn/project.yaml found; service discovery is heuristic and owners may be incomplete."
    );
  }

  const codeowners = await loadCodeOwners(root);
  const serviceDrafts = manifest
    ? await manifestServiceDrafts(root, manifest)
    : await discoveredServiceDrafts(root, codeowners.rules, warnings);
  const ciFiles = await discoverCiFiles(root, warnings);
  const services = await buildServices(root, serviceDrafts, codeowners.rules, warnings);
  const consistency = normalizeConsistency(manifest?.consistency ?? []);
  const issues = buildArchitectureIssues(services, consistency);
  const indexWithoutDigest: Omit<ArchitectureIndex, "digest"> = {
    schemaVersion: 1,
    projectId: manifest?.metadata.id ?? repositoryIdentifier(root),
    ...(manifest?.metadata.owner ? { projectOwner: manifest.metadata.owner } : {}),
    rootPath: root,
    ...(manifest ? { manifestPath: ".mn/project.yaml" } : {}),
    ...(manifest ? { manifestDigest: sha256Digest(manifestSemanticValue(manifest)) } : {}),
    ...(codeowners.path ? { codeownersPath: codeowners.path } : {}),
    ciFiles,
    services,
    consistency,
    issues,
    warnings: uniqueSorted(warnings)
  };
  return deepFreeze({
    ...indexWithoutDigest,
    digest: digestArchitectureIndex(indexWithoutDigest)
  });
}

export function digestArchitectureIndex(
  index: ArchitectureIndex | Omit<ArchitectureIndex, "digest">
): string {
  return sha256Digest(architectureSemanticValue(index));
}

async function validateRepositoryRoot(input: string): Promise<string> {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim() ||
    input.includes("\0")
  ) {
    throw new TypeError("Repository root must be a non-empty trimmed path");
  }
  const absolute = resolve(input);
  const initial = await lstat(absolute).catch(() => undefined);
  if (!initial?.isDirectory()) {
    throw new TypeError(`Repository root is not a directory: ${input}`);
  }
  if (initial.isSymbolicLink()) {
    throw new TypeError("Repository root must not be a symbolic link");
  }
  return realpath(absolute);
}

async function manifestServiceDrafts(
  root: string,
  manifest: ProjectManifest
): Promise<ServiceDraft[]> {
  const drafts: ServiceDraft[] = [];
  for (const service of manifest.services) {
    const inspected = await inspectRepositoryPath(root, service.path);
    if (!inspected?.stats.isDirectory()) {
      throw new TypeError(
        `Manifest service ${service.id} path must resolve to a directory within the repository: ${service.path}`
      );
    }
    drafts.push({
      id: service.id,
      relativePath: service.path,
      owners: sorted(service.owners),
      ...(service.language ? { language: service.language } : {}),
      manifest: service
    });
  }
  return drafts.sort((left, right) => compareCodeUnits(left.id, right.id));
}

async function discoveredServiceDrafts(
  root: string,
  rules: readonly CodeOwnerRule[],
  warnings: string[]
): Promise<ServiceDraft[]> {
  const candidatePaths = await collectCandidateDirectories(root, warnings);
  const servicePaths: string[] = [];
  for (const candidate of candidatePaths) {
    if (await hasServiceMarker(root, candidate)) servicePaths.push(candidate);
  }
  if (servicePaths.length === 0) {
    warnings.push("No services detected. Add .mn/project.yaml or standard service markers.");
    return [];
  }
  const usedIds = new Set<string>();
  return servicePaths
    .sort(compareCodeUnits)
    .map((relativePath) => {
      const baseId = relativePath === "." ? repositoryIdentifier(root) : basename(relativePath);
      let id = baseId;
      if (usedIds.has(id)) id = relativePath.replaceAll("/", "-");
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      return {
        id,
        relativePath,
        owners: ownersForPath(rules, relativePath)
      };
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

async function collectCandidateDirectories(
  root: string,
  warnings: string[]
): Promise<string[]> {
  const result = ["."];
  let visited = 0;
  const visit = async (relativeDirectory: string, depth: number): Promise<void> => {
    if (depth >= 3 || visited >= MAX_WALK_ENTRIES) return;
    const absolute = relativeDirectory === "." ? root : join(root, relativeDirectory);
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((left, right) =>
      compareCodeUnits(left.name, right.name)
    );
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) {
        warnings.push(`Repository discovery stopped after ${MAX_WALK_ENTRIES} entries.`);
        return;
      }
      const child = relativeDirectory === "."
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link during discovery: ${child}`);
        continue;
      }
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      result.push(child);
      await visit(child, depth + 1);
    }
  };
  await visit(".", 0);
  return result;
}

async function hasServiceMarker(root: string, relativeDirectory: string): Promise<boolean> {
  const absolute = relativeDirectory === "." ? root : join(root, relativeDirectory);
  const entries = await readdir(absolute, { withFileTypes: true });
  return entries.some(
    (entry) =>
      !entry.isSymbolicLink() &&
      SERVICE_MARKERS.has(entry.name) &&
      (entry.isFile() || entry.isDirectory())
  );
}

async function buildServices(
  root: string,
  drafts: readonly ServiceDraft[],
  codeOwnerRules: readonly CodeOwnerRule[],
  warnings: string[]
): Promise<ArchitectureService[]> {
  const prepared: Array<{
    draft: ServiceDraft;
    files: readonly WalkFile[];
    contracts: ContractRef[];
    migrations: readonly string[];
    language: string;
    packageName?: string;
    packageDependencies: readonly string[];
  }> = [];
  for (const draft of drafts) {
    const files = await walkServiceFiles(root, draft.relativePath, warnings);
    const discoveredContracts = await discoverContracts(files, draft.id);
    const manifestContracts = await validateManifestContracts(
      root,
      draft.manifest?.contracts ?? [],
      draft.id,
      warnings
    );
    const packageInfo = await readPackageInfo(root, draft.relativePath, warnings);
    prepared.push({
      draft,
      files,
      contracts: uniqueContracts([...manifestContracts, ...discoveredContracts]),
      migrations: sorted(
        files
          .filter(({ relativePath }) => isMigrationPath(relativePath))
          .map(({ relativePath }) => relativePath)
      ),
      language:
        draft.language ?? (await detectLanguage(root, draft.relativePath)) ?? "unknown",
      ...(packageInfo.name ? { packageName: packageInfo.name } : {}),
      packageDependencies: packageInfo.dependencies
    });
  }

  const packageToService = new Map<string, string>();
  for (const entry of prepared) {
    if (entry.packageName) {
      const existing = packageToService.get(entry.packageName);
      if (existing && existing !== entry.draft.id) {
        throw new TypeError(
          `Duplicate local package name ${entry.packageName} for services ${existing} and ${entry.draft.id}`
        );
      }
      packageToService.set(entry.packageName, entry.draft.id);
    }
  }

  return prepared
    .map((entry) => {
      const manifestDependencies: ArchitectureDependency[] = (
        entry.draft.manifest?.dependencies ?? []
      ).map((dependency) => ({
        ...dependency,
        source: entry.draft.id,
        discoveredFrom: "manifest"
      }));
      const existingTargets = new Set(
        manifestDependencies.map((dependency) => dependency.service)
      );
      const packageDependencies: ArchitectureDependency[] = entry.packageDependencies
        .map((packageName) => packageToService.get(packageName))
        .filter((service): service is string => Boolean(service))
        .filter(
          (service) =>
            service !== entry.draft.id && !existingTargets.has(service)
        )
        .map((service) => ({
          source: entry.draft.id,
          service,
          kind: "sync",
          discoveredFrom: "package"
        }));
      const manifest = entry.draft.manifest;
      const owners = manifest
        ? sorted(manifest.owners)
        : sorted(
            entry.draft.owners.length > 0
              ? entry.draft.owners
              : ownersForPath(codeOwnerRules, entry.draft.relativePath)
          );
      return {
        id: entry.draft.id,
        name: entry.draft.id,
        path:
          entry.draft.relativePath === "."
            ? root
            : join(root, entry.draft.relativePath),
        relativePath: entry.draft.relativePath,
        owners,
        language: entry.language,
        contracts: entry.contracts,
        dependencies: uniqueDependencies([
          ...manifestDependencies,
          ...packageDependencies
        ]),
        data: sortedData(manifest?.data ?? []),
        migrations: entry.migrations,
        commands: sortedRecord(manifest?.commands ?? {}),
        observability: sortedObservability(
          manifest?.observability ?? emptyObservability()
        ),
        ...(manifest?.deployment ? { deployment: manifest.deployment } : {})
      } satisfies ArchitectureService;
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

async function walkServiceFiles(
  root: string,
  servicePath: string,
  warnings: string[]
): Promise<WalkFile[]> {
  const start = servicePath === "." ? root : join(root, servicePath);
  const files: WalkFile[] = [];
  let visited = 0;
  const visit = async (absoluteDirectory: string, depth: number): Promise<void> => {
    if (depth > 12 || visited >= MAX_WALK_ENTRIES) return;
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort(
      (left, right) => compareCodeUnits(left.name, right.name)
    );
    for (const entry of entries) {
      visited += 1;
      const absolute = join(absoluteDirectory, entry.name);
      const repositoryPath = toRepositoryRelative(root, absolute);
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link during service discovery: ${repositoryPath}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink() || !stats.isFile()) continue;
      files.push({ relativePath: repositoryPath, absolutePath: absolute, size: stats.size });
    }
  };
  await visit(start, 0);
  if (visited >= MAX_WALK_ENTRIES) {
    warnings.push(
      `Service discovery for ${servicePath} stopped after ${MAX_WALK_ENTRIES} entries.`
    );
  }
  return files.sort((left, right) =>
    compareCodeUnits(left.relativePath, right.relativePath)
  );
}

async function discoverContracts(
  files: readonly WalkFile[],
  serviceId: string
): Promise<ContractRef[]> {
  const contracts: ContractRef[] = [];
  for (const file of files) {
    const lower = basename(file.relativePath).toLowerCase();
    if (lower.endsWith(".proto")) {
      contracts.push({ type: "protobuf", path: file.relativePath, serviceName: serviceId });
      continue;
    }
    if (!/\.(?:ya?ml|json)$/u.test(lower)) continue;
    let type: "openapi" | "asyncapi" | undefined;
    if (lower.includes("asyncapi")) type = "asyncapi";
    else if (lower.includes("openapi") || lower.includes("swagger")) type = "openapi";
    else if (file.size <= CONTRACT_DOCUMENT_LIMIT) {
      const content = await readFile(file.absolutePath, "utf8");
      if (/(?:^|\n)\s*(?:["']?asyncapi["']?\s*:|\{\s*["']asyncapi["']\s*:)/u.test(content)) {
        type = "asyncapi";
      } else if (
        /(?:^|\n)\s*(?:["']?(?:openapi|swagger)["']?\s*:|\{\s*["'](?:openapi|swagger)["']\s*:)/u.test(
          content
        )
      ) {
        type = "openapi";
      }
    }
    if (type) contracts.push({ type, path: file.relativePath, serviceName: serviceId });
  }
  return contracts;
}

async function validateManifestContracts(
  root: string,
  contracts: readonly ContractRef[],
  serviceId: string,
  warnings: string[]
): Promise<ContractRef[]> {
  const result: ContractRef[] = [];
  for (const contract of contracts) {
    const path = normalizeRepositoryRelativePath(
      contract.path,
      `service ${serviceId} contract path`
    );
    const inspected = await inspectRepositoryPath(root, path);
    if (!inspected?.stats.isFile()) {
      warnings.push(`Declared contract does not exist as a regular file: ${path}`);
    }
    result.push({
      ...contract,
      path,
      serviceName: contract.serviceName ?? serviceId
    });
  }
  return result;
}

async function detectLanguage(
  root: string,
  servicePath: string
): Promise<string | undefined> {
  const checks: ReadonlyArray<readonly [string, string]> = [
    ["package.json", "typescript"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["pom.xml", "java"],
    ["build.gradle", "java"],
    ["build.gradle.kts", "kotlin"]
  ];
  for (const [marker, language] of checks) {
    const path = servicePath === "." ? marker : `${servicePath}/${marker}`;
    const inspected = await inspectRepositoryPath(root, path);
    if (inspected?.stats.isFile()) return language;
  }
  return undefined;
}

async function readPackageInfo(
  root: string,
  servicePath: string,
  warnings: string[]
): Promise<{ name?: string; dependencies: string[] }> {
  const path = servicePath === "." ? "package.json" : `${servicePath}/package.json`;
  const content = await readOptionalRepositoryFile(root, path);
  if (content === undefined) return { dependencies: [] };
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainRecord(parsed)) throw new TypeError("root must be an object");
    const name =
      typeof parsed.name === "string" && parsed.name.length > 0
        ? parsed.name
        : undefined;
    const dependencies = [
      ...dependencyKeys(parsed.dependencies),
      ...dependencyKeys(parsed.devDependencies),
      ...dependencyKeys(parsed.peerDependencies),
      ...dependencyKeys(parsed.optionalDependencies)
    ];
    return {
      ...(name ? { name } : {}),
      dependencies: uniqueSorted(dependencies)
    };
  } catch (error) {
    warnings.push(
      `Ignored invalid package metadata at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { dependencies: [] };
  }
}

function dependencyKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isPlainRecord(value)) throw new TypeError("dependency map must be an object");
  const result: string[] = [];
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") {
      throw new TypeError(`dependency ${name} version must be a string`);
    }
    result.push(name);
  }
  return result;
}

async function discoverCiFiles(root: string, warnings: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const candidate of ROOT_CI_FILES) {
    if ((await inspectRepositoryPath(root, candidate))?.stats.isFile()) paths.push(candidate);
  }
  const workflows = await inspectRepositoryPath(root, ".github/workflows");
  if (workflows?.stats.isDirectory()) {
    const entries = (await readdir(workflows.absolutePath, { withFileTypes: true })).sort(
      (left, right) => compareCodeUnits(left.name, right.name)
    );
    for (const entry of entries) {
      const path = `.github/workflows/${entry.name}`;
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link during CI discovery: ${path}`);
      } else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) {
        paths.push(path);
      }
    }
  }
  return uniqueSorted(paths);
}

async function loadCodeOwners(
  root: string
): Promise<{ path?: string; rules: readonly CodeOwnerRule[] }> {
  for (const candidate of CODEOWNERS_CANDIDATES) {
    const content = await readOptionalRepositoryFile(root, candidate);
    if (content === undefined) continue;
    const rules: CodeOwnerRule[] = [];
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const tokens = line.split(/\s+/u);
      const pattern = tokens.shift();
      const owners = tokens.filter((token) => token.startsWith("@"));
      if (pattern && owners.length > 0) {
        rules.push({ pattern, owners: uniqueSorted(owners) });
      }
    }
    return { path: candidate, rules: deepFreeze(rules) };
  }
  return { rules: [] };
}

function ownersForPath(
  rules: readonly CodeOwnerRule[],
  servicePath: string
): string[] {
  let owners: readonly string[] = [];
  const candidate = servicePath === "." ? "" : `${servicePath}/`;
  for (const rule of rules) {
    if (codeOwnerPatternMatches(rule.pattern, candidate)) owners = rule.owners;
  }
  return sorted(owners);
}

function codeOwnerPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.startsWith("/");
  const raw = (anchored ? pattern.slice(1) : pattern).replace(/\/$/u, "");
  let expression = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === "*" && raw[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/u, "\\$&");
    }
  }
  const hasSlash = raw.includes("/");
  const prefix = anchored || hasSlash ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${expression}(?:/.*)?$`, "u").test(
    path.replace(/\/$/u, "")
  );
}

function buildArchitectureIssues(
  services: readonly ArchitectureService[],
  consistency: readonly ConsistencyBoundary[]
): ArchitectureIssue[] {
  const issues: ArchitectureIssue[] = [];
  const serviceIds = new Set(services.map(({ id }) => id));
  for (const service of services) {
    if (service.owners.length === 0) {
      issues.push({
        code: "MISSING_OWNER",
        level: "L3",
        message: `Service ${service.id} has no owner.`,
        services: [service.id]
      });
    }
    for (const dependency of service.dependencies) {
      if (!serviceIds.has(dependency.service)) {
        issues.push({
          code: "UNKNOWN_DEPENDENCY",
          level: "L4",
          message: `Service ${service.id} depends on unknown service ${dependency.service}.`,
          services: sorted([service.id, dependency.service])
        });
      }
    }
    if (
      service.migrations.length > 0 &&
      !service.deployment?.rollbackCommand
    ) {
      issues.push({
        code: "MISSING_ROLLBACK",
        level: "L4",
        message: `Service ${service.id} has migrations but no rollback command.`,
        services: [service.id]
      });
    } else if (service.deployment && !service.deployment.rollbackCommand) {
      issues.push({
        code: "MISSING_ROLLBACK",
        level: "L4",
        message: `Service ${service.id} declares a deployment unit without a rollback command.`,
        services: [service.id]
      });
    }
    if (
      service.observability.metrics.length === 0 &&
      service.observability.traces.length === 0
    ) {
      issues.push({
        code: "MISSING_OBSERVABILITY",
        level: "L2",
        message: `Service ${service.id} declares neither metrics nor traces.`,
        services: [service.id]
      });
    }
  }

  const resources = groupDataResources(services);
  for (const [identity, entries] of resources) {
    const [kind, name] = identity.split(":", 2) as [ManifestDataResource["kind"], string];
    const participants = uniqueSorted(entries.map(({ service }) => service));
    if (kind === "database" && participants.length > 1) {
      issues.push({
        code: "SHARED_DATABASE",
        level: "L4",
        message: `Database ${name} is shared by ${participants.join(", ")}.`,
        services: participants,
        resource: name
      });
    }
    if (kind === "redis" && participants.length > 1) {
      issues.push({
        code: "SHARED_REDIS_NAMESPACE",
        level: "L3",
        message: `Redis namespace ${name} is shared by ${participants.join(", ")}.`,
        services: participants,
        resource: name
      });
    }
    if (kind === "topic") {
      const publishers = uniqueSorted(
        entries
          .filter(({ resource }) =>
            resource.role === "publisher" || resource.role === "owner"
          )
          .map(({ service }) => service)
      );
      if (publishers.length > 1) {
        issues.push({
          code: "TOPIC_MULTI_OWNER",
          level: "L4",
          message: `Topic ${name} has multiple publishing owners: ${publishers.join(", ")}.`,
          services: publishers,
          resource: name
        });
      }
    }
    if (
      participants.length > 1 &&
      (kind === "database" || kind === "redis" || kind === "topic") &&
      !hasConsistencyBoundary(consistency, participants)
    ) {
      issues.push({
        code: "CROSS_SERVICE_WITHOUT_CONSISTENCY",
        level: "L4",
        message: `Shared ${kind} ${name} has no declared consistency boundary.`,
        services: participants,
        resource: name
      });
    }
  }
  for (const service of services) {
    for (const dependency of service.dependencies) {
      if (
        (dependency.kind === "async" || dependency.kind === "data") &&
        serviceIds.has(dependency.service) &&
        !hasConsistencyBoundary(consistency, [service.id, dependency.service])
      ) {
        issues.push({
          code: "CROSS_SERVICE_WITHOUT_CONSISTENCY",
          level: "L4",
          message: `${dependency.kind} dependency ${service.id} -> ${dependency.service} has no declared consistency boundary.`,
          services: sorted([service.id, dependency.service])
        });
      }
    }
  }
  return uniqueIssues(issues);
}

function groupDataResources(services: readonly ArchitectureService[]) {
  const resources = new Map<
    string,
    Array<{ service: string; resource: ManifestDataResource }>
  >();
  for (const service of services) {
    for (const resource of service.data) {
      const key = `${resource.kind}:${resource.name}`;
      const entries = resources.get(key) ?? [];
      entries.push({ service: service.id, resource });
      resources.set(key, entries);
    }
  }
  return [...resources.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
}

function hasConsistencyBoundary(
  boundaries: readonly ConsistencyBoundary[],
  participants: readonly string[]
): boolean {
  return boundaries.some((boundary) => {
    const declared = new Set(boundary.participants);
    return participants.every((participant) => declared.has(participant));
  });
}

function normalizeConsistency(
  boundaries: readonly ConsistencyBoundary[]
): ConsistencyBoundary[] {
  return boundaries
    .map((boundary) => ({
      ...boundary,
      participants: uniqueSorted(boundary.participants)
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

async function readOptionalRepositoryFile(
  root: string,
  repositoryPath: string
): Promise<string | undefined> {
  const inspected = await inspectRepositoryPath(root, repositoryPath);
  if (!inspected) return undefined;
  if (!inspected.stats.isFile()) {
    throw new TypeError(`Repository path must be a regular file: ${repositoryPath}`);
  }
  return readFile(inspected.absolutePath, "utf8");
}

async function inspectRepositoryPath(
  root: string,
  repositoryPath: string
): Promise<
  | {
      readonly absolutePath: string;
      readonly stats: Awaited<ReturnType<typeof lstat>>;
    }
  | undefined
> {
  const normalized = normalizeRepositoryRelativePath(repositoryPath, "repository path");
  const absolute = resolve(root, normalized);
  assertWithinRepository(root, absolute);
  let current = root;
  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) return undefined;
    if (stats.isSymbolicLink()) {
      throw new TypeError(`Symbolic links are not allowed in repository paths: ${repositoryPath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) return undefined;
    if (index === segments.length - 1) return { absolutePath: current, stats };
  }
  return undefined;
}

function assertWithinRepository(root: string, absolute: string): void {
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`Path must remain within repository: ${absolute}`);
  }
}

function toRepositoryRelative(root: string, absolute: string): string {
  assertWithinRepository(root, absolute);
  const value = relative(root, absolute).split(sep).join("/");
  return normalizeRepositoryRelativePath(value, "discovered repository path");
}

function isMigrationPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const inMigrationDirectory = segments.some(
    (segment) =>
      segment === "migrate" || segment === "migration" || segment === "migrations"
  );
  return (
    inMigrationDirectory &&
    /\.(?:sql|xml|ya?ml|json|js|cjs|mjs|ts|py)$/u.test(path.toLowerCase())
  );
}

function uniqueContracts(contracts: readonly ContractRef[]): ContractRef[] {
  const byIdentity = new Map<string, ContractRef>();
  for (const contract of contracts) {
    const identity = `${contract.type}:${contract.path}:${contract.serviceName ?? ""}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, { ...contract });
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      compareCodeUnits(left.type, right.type) ||
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.serviceName ?? "", right.serviceName ?? "")
  );
}

function uniqueDependencies(
  dependencies: readonly ArchitectureDependency[]
): ArchitectureDependency[] {
  const byIdentity = new Map<string, ArchitectureDependency>();
  for (const dependency of dependencies) {
    const identity = `${dependency.source}:${dependency.service}:${dependency.kind}:${
      dependency.contract ?? ""
    }`;
    const existing = byIdentity.get(identity);
    if (!existing || existing.discoveredFrom === "package") {
      byIdentity.set(identity, { ...dependency });
    }
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      compareCodeUnits(left.source, right.source) ||
      compareCodeUnits(left.service, right.service) ||
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.contract ?? "", right.contract ?? "")
  );
}

function sortedData(resources: readonly ManifestDataResource[]): ManifestDataResource[] {
  return resources
    .map((resource) => ({ ...resource }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.kind, right.kind) ||
        compareCodeUnits(left.name, right.name) ||
        compareCodeUnits(left.role, right.role)
    );
}

function emptyObservability() {
  return { metrics: [], traces: [], logs: [], alerts: [] } as const;
}

function sortedObservability(value: ArchitectureService["observability"]) {
  return {
    metrics: uniqueSorted(value.metrics),
    traces: uniqueSorted(value.traces),
    logs: uniqueSorted(value.logs),
    alerts: uniqueSorted(value.alerts)
  };
}

function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))
  );
}

function uniqueIssues(issues: readonly ArchitectureIssue[]): ArchitectureIssue[] {
  const byIdentity = new Map<string, ArchitectureIssue>();
  for (const issue of issues) {
    const normalized = { ...issue, services: uniqueSorted(issue.services) };
    const identity = `${normalized.code}:${normalized.services.join(",")}:${
      normalized.resource ?? ""
    }:${normalized.message}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, normalized);
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.services.join("\0"), right.services.join("\0")) ||
      compareCodeUnits(left.resource ?? "", right.resource ?? "") ||
      compareCodeUnits(left.message, right.message)
  );
}

function architectureSemanticValue(
  index: ArchitectureIndex | Omit<ArchitectureIndex, "digest">
): unknown {
  return {
    schemaVersion: index.schemaVersion,
    projectId: index.projectId,
    ...(index.projectOwner ? { projectOwner: index.projectOwner } : {}),
    ...(index.manifestPath ? { manifestPath: index.manifestPath } : {}),
    ...(index.manifestDigest ? { manifestDigest: index.manifestDigest } : {}),
    ...(index.codeownersPath ? { codeownersPath: index.codeownersPath } : {}),
    ciFiles: index.ciFiles,
    services: index.services.map((service) => ({
      id: service.id,
      name: service.name,
      relativePath: service.relativePath,
      owners: service.owners,
      language: service.language,
      contracts: service.contracts,
      dependencies: service.dependencies,
      data: service.data,
      migrations: service.migrations,
      commands: service.commands,
      observability: service.observability,
      ...(service.deployment ? { deployment: service.deployment } : {})
    })),
    consistency: index.consistency,
    issues: index.issues,
    warnings: index.warnings
  };
}

function manifestSemanticValue(manifest: ProjectManifest): unknown {
  return {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: manifest.metadata,
    services: manifest.services
      .map((service) => ({
        id: service.id,
        path: service.path,
        owners: uniqueSorted(service.owners),
        ...(service.language ? { language: service.language } : {}),
        contracts: uniqueContracts(service.contracts ?? []),
        dependencies: [...service.dependencies]
          .map((dependency) => ({ ...dependency }))
          .sort(
            (left, right) =>
              compareCodeUnits(left.service, right.service) ||
              compareCodeUnits(left.kind, right.kind) ||
              compareCodeUnits(left.contract ?? "", right.contract ?? "")
          ),
        data: sortedData(service.data),
        commands: sortedRecord(service.commands),
        observability: sortedObservability(service.observability),
        ...(service.deployment ? { deployment: service.deployment } : {})
      }))
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
    consistency: normalizeConsistency(manifest.consistency)
  };
}

function repositoryIdentifier(root: string): string {
  const value = basename(root).replace(/[^A-Za-z0-9._-]/gu, "-");
  return value.length > 0 ? value.slice(0, 128) : "repository";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareCodeUnits);
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
