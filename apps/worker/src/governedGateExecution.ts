import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentTask,
  GateResult,
  GateResultV2,
  Project,
  RunEvent,
  Service
} from "@mn/core";
import type { HarnessManifest } from "@mn/harness";
import type { SpecRevision } from "@mn/specs";
import { parseDocument } from "yaml";
import {
  createDefaultGateRegistry,
  runGateEngineV2,
  validateGateResultV2Integrity,
  type GateArtifactPublisher,
  type GateCommandExecutor,
  type GatePlanItemV2
} from "./gateEngine.js";
import {
  GateRegistryV2,
  type GateContractDocument,
  type GateEvaluationFacts,
  type GateRunnerV2
} from "./gateRegistry.js";

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  ".cache",
  "target",
  ".gradle"
]);
const MAX_SNAPSHOT_FILES = 100_000;
const MAX_HASHED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_TEXT_FILE_BYTES = 4 * 1024 * 1024;

export type WorkspaceSnapshot = ReadonlyMap<string, string>;
export type WorkspaceContentSnapshot = ReadonlyMap<string, string | null>;

export interface GovernedGateExecutionInput {
  readonly project: Project;
  readonly task: AgentTask;
  readonly manifest: HarnessManifest;
  readonly candidateRoot: string;
  /** Optional logical root recorded in evidence while all reads and command
   * execution continue to use candidateRoot. API authority uses this to run
   * against a private immutable copy without changing receipt semantics. */
  readonly evidenceRoot?: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly changedPaths: readonly string[];
  readonly spec?: SpecRevision;
  readonly contractBaseline?: Readonly<Record<string, string>>;
  readonly registry?: GateRegistryV2;
  readonly onEvent?: (event: RunEvent) => void;
  readonly abortSignal?: AbortSignal;
  readonly commandExecutor?: GateCommandExecutor;
  readonly artifactPublisher?: GateArtifactPublisher;
}

export interface GovernedGateExecutionResult {
  readonly results: readonly GateResultV2[];
  readonly legacyResults: readonly GateResult[];
  readonly successful: boolean;
  readonly failureSignature: string;
}

interface DeclaredCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

type WorkspaceGatePlan = GatePlanItemV2 & { readonly __cwd?: string };

type DeclaredCommandsByService = Readonly<
  Record<string, Readonly<Record<string, DeclaredCommand>>>
>;

export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const result = new Map<string, string>();
  const absoluteRoot = resolve(root);
  let files = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const repositoryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        result.set(repositoryPath, sha256(`symlink:${await readlink(absolute)}`));
        continue;
      }
      if (stats.isDirectory()) {
        await visit(absolute, repositoryPath);
        continue;
      }
      if (!stats.isFile()) continue;
      files += 1;
      if (files > MAX_SNAPSHOT_FILES) {
        throw new Error(`Workspace snapshot exceeds ${MAX_SNAPSHOT_FILES} files`);
      }
      const digest =
        stats.size <= MAX_HASHED_FILE_BYTES
          ? sha256(await readFile(absolute))
          : sha256(`large:${stats.size}:${stats.mtimeMs}`);
      result.set(repositoryPath, digest);
    }
  }
  await visit(absoluteRoot, "");
  return result;
}

/** Captures full UTF-8 bytes for authoritative changed-line measurement.
 * `null` marks a symlink, binary, or oversized file and must fail closed if
 * that path later changes. */
export async function snapshotWorkspaceContents(
  root: string
): Promise<WorkspaceContentSnapshot> {
  const result = new Map<string, string | null>();
  const absoluteRoot = resolve(root);
  let files = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const repositoryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        result.set(repositoryPath, null);
        continue;
      }
      if (stats.isDirectory()) {
        await visit(absolute, repositoryPath);
        continue;
      }
      if (!stats.isFile()) continue;
      files += 1;
      if (files > MAX_SNAPSHOT_FILES) {
        throw new Error(`Workspace content snapshot exceeds ${MAX_SNAPSHOT_FILES} files`);
      }
      if (stats.size > MAX_DIFF_TEXT_FILE_BYTES) {
        result.set(repositoryPath, null);
        continue;
      }
      const content = await readFile(absolute);
      if (content.includes(0)) {
        result.set(repositoryPath, null);
        continue;
      }
      const text = content.toString("utf8");
      result.set(
        repositoryPath,
        Buffer.from(text, "utf8").equals(content) ? text : null
      );
    }
  }
  await visit(absoluteRoot, "");
  return result;
}

export function changedWorkspacePaths(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
): readonly string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort(compareCodeUnits);
}

export async function captureContractBaseline(
  project: Project
): Promise<Readonly<Record<string, string>>> {
  const canonicalProject = await canonicalProjectPaths(project);
  const baseline: Record<string, string> = {};
  for (const service of canonicalProject.services) {
    for (const contract of service.contracts) {
      if (contract.type !== "openapi" && contract.type !== "asyncapi") continue;
      const repositoryPath = await contractRepositoryPath(
        canonicalProject,
        service,
        contract.path
      );
      try {
        baseline[repositoryPath] = await readSafeText(
          canonicalProject.rootPath,
          repositoryPath
        );
      } catch {
        // The contract gate will fail closed when the current declared document
        // cannot be read. An absent baseline simply disables compatibility diff.
      }
    }
  }
  return Object.freeze({ ...baseline });
}

export async function runGovernedGatePlan(
  input: GovernedGateExecutionInput
): Promise<GovernedGateExecutionResult> {
  validateHarnessExecutionBinding(input);
  const project = await canonicalProjectPaths(input.project);
  const normalizedInput = { ...input, project };
  const selectedServices = project.services.filter((service) =>
    input.manifest.selectedServices.includes(service.id)
  );
  const acceptanceIds = (input.spec?.acceptanceCases ?? [])
    .map((acceptance) => acceptance.id)
    .sort(compareCodeUnits);
  const declaredCommands = parseDeclaredCommands(input.manifest);
  const registry = input.registry ?? buildRuntimeRegistry(
    input.manifest,
    selectedServices,
    declaredCommands
  );
  const facts = await buildFacts(normalizedInput, selectedServices, acceptanceIds);
  const normalPlans: WorkspaceGatePlan[] = [];
  const coveragePlans: WorkspaceGatePlan[] = [];
  for (const gate of input.manifest.gatePlan) {
    const plans = plansForGate(
      gate,
      selectedServices,
      normalizedInput,
      declaredCommands,
      acceptanceIds,
      facts,
      registry
    );
    if (gate.id === "acceptance_coverage") coveragePlans.push(...plans);
    else normalPlans.push(...plans);
  }

  const firstResults = await executePlans(normalizedInput, registry, normalPlans);
  const coveredSpecClauseIds = uniqueSorted(
    firstResults
      .filter((result) =>
        result.status === "pass" && evidenceBearingGate(result.gateId)
      )
      .flatMap((result) => result.specClauseIds)
  );
  const coverageResults = coveragePlans.length === 0
    ? []
    : await executePlans(
        normalizedInput,
        registry,
        coveragePlans.map((plan) => ({
          ...plan,
          facts: { ...plan.facts, coveredSpecClauseIds }
        }))
      );
  const results = [...firstResults, ...coverageResults];
  const now = new Date().toISOString();
  const integrityFailures = results.flatMap((result) =>
    validateGateResultV2Integrity(result, now).map(
      (issue) => `${result.gateId}/${result.id}: ${issue}`
    )
  );
  const successful =
    results.length === normalPlans.length + coveragePlans.length &&
    results.every((result) => result.status === "pass") &&
    integrityFailures.length === 0;
  const signatureSemantic = {
    results: results.map((result) => ({
      gateId: result.gateId,
      runnerId: result.runnerId,
      runnerVersion: result.runnerVersion,
      status: result.status,
      outputDigest: result.outputDigest
    })),
    integrityFailures
  };
  return Object.freeze({
    results: Object.freeze(results),
    legacyResults: Object.freeze(results.map(toLegacyGateResult)),
    successful,
    failureSignature: sha256Canonical(signatureSemantic)
  });
}

function validateHarnessExecutionBinding(input: GovernedGateExecutionInput): void {
  const manifest = input.manifest;
  if (
    manifest.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(manifest.digest) ||
    !/^[a-f0-9]{64}$/u.test(manifest.governanceDigest)
  ) {
    throw new TypeError("HarnessManifest identity or digest is invalid");
  }
  const { generatedAt: _generatedAt, digest: _digest, ...semantic } = manifest;
  if (sha256Canonical(semantic) !== manifest.digest) {
    throw new TypeError("HarnessManifest digest does not match immutable content");
  }
  if (manifest.task.taskId !== input.task.id) {
    throw new TypeError("HarnessManifest task binding does not match execution task");
  }
  if (
    !input.task.specRef ||
    manifest.specRef.specSetId !== input.task.specRef.specSetId ||
    manifest.specRef.revision !== input.task.specRef.revision ||
    manifest.specRef.digest !== input.task.specRef.digest
  ) {
    throw new TypeError("HarnessManifest Spec binding does not match execution task");
  }
  if (new Set(manifest.selectedServices).size !== manifest.selectedServices.length) {
    throw new TypeError("HarnessManifest selectedServices contains duplicates");
  }
  const projectServices = new Map(input.project.services.map((service) => [service.id, service]));
  for (const serviceId of manifest.selectedServices) {
    const service = projectServices.get(serviceId);
    if (!service || manifest.languageByService[serviceId] !== service.language) {
      throw new TypeError(`HarnessManifest service/language binding is invalid for ${serviceId}`);
    }
  }
  const gateIds = new Set<string>();
  for (const gate of manifest.gatePlan) {
    if (
      !gate.required ||
      gate.runnerId !== gate.id ||
      gateIds.has(gate.id) ||
      gate.languages.length === 0 ||
      new Set(gate.languages).size !== gate.languages.length
    ) {
      throw new TypeError(`HarnessManifest Gate binding is invalid for ${gate.id}`);
    }
    gateIds.add(gate.id);
  }
  const context = manifest.context;
  const { digest: _contextDigest, ...contextSemantic } = context;
  if (sha256Canonical(contextSemantic) !== context.digest) {
    throw new TypeError("HarnessManifest context digest does not match immutable content");
  }
  for (const fragment of context.fragments) {
    if (sha256(fragment.content) !== fragment.contentDigest) {
      throw new TypeError(`Harness context fragment ${fragment.id} contentDigest is invalid`);
    }
    const { digest, ...fragmentSemantic } = fragment;
    if (sha256Canonical(fragmentSemantic) !== digest) {
      throw new TypeError(`Harness context fragment ${fragment.id} digest is invalid`);
    }
  }
  for (const omitted of context.omitted) {
    const { digest, ...omittedSemantic } = omitted;
    if (sha256Canonical(omittedSemantic) !== digest) {
      throw new TypeError(`Harness omitted context ${omitted.id} digest is invalid`);
    }
  }
}

async function canonicalProjectPaths(project: Project): Promise<Project> {
  const rootPath = await realpath(resolve(project.rootPath));
  const services = await Promise.all(project.services.map(async (service) => {
    const declared = isAbsolute(service.path)
      ? resolve(service.path)
      : resolve(rootPath, normalizeRelativePath(service.path, true));
    const canonical = await realpath(declared);
    if (!pathInside(rootPath, canonical)) {
      throw new TypeError(`Service ${service.id} path escapes project root`);
    }
    return { ...service, path: canonical };
  }));
  return { ...project, rootPath, services };
}

async function executePlans(
  input: GovernedGateExecutionInput,
  registry: GateRegistryV2,
  plans: readonly WorkspaceGatePlan[]
): Promise<GateResultV2[]> {
  const results: GateResultV2[] = [];
  // One plan per invocation lets each service gate execute at its immutable
  // service working directory while keeping deterministic manifest order.
  for (const plan of plans) {
    const { __cwd, ...gatePlan } = plan;
    const cwd = __cwd ?? input.candidateRoot;
    results.push(...await runGateEngineV2({
      cwd,
      ...(input.evidenceRoot
        ? { evidenceCwd: logicalEvidenceCwd(input.candidateRoot, input.evidenceRoot, cwd) }
        : {}),
      gates: [gatePlan],
      registry,
      runId: input.runId,
      candidateId: input.candidateId,
      failClosed: true,
      ...(input.manifest.executionPolicy.commandAllowlist
        ? { commandAllowlist: input.manifest.executionPolicy.commandAllowlist }
        : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.commandExecutor ? { commandExecutor: input.commandExecutor } : {}),
      ...(input.artifactPublisher ? { artifactPublisher: input.artifactPublisher } : {})
    }));
  }
  return results;
}

function logicalEvidenceCwd(
  physicalRoot: string,
  logicalRoot: string,
  physicalCwd: string
): string {
  const physical = resolve(physicalRoot);
  const cwd = resolve(physicalCwd);
  const child = relative(physical, cwd);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new TypeError("Gate working directory escapes the physical candidate root");
  }
  return child === "" ? resolve(logicalRoot) : resolve(logicalRoot, child);
}

function plansForGate(
  gate: HarnessManifest["gatePlan"][number],
  services: readonly Service[],
  input: GovernedGateExecutionInput,
  declaredCommands: DeclaredCommandsByService,
  acceptanceIds: readonly string[],
  facts: GateEvaluationFacts,
  registry: GateRegistryV2
): WorkspaceGatePlan[] {
  const binding = {
    id: gate.runnerId,
    version: gate.runnerVersion,
    languages: gate.languages
  };
  const firstLanguage = services[0]?.language ?? "unknown";
  const resolved = registry.resolve(gate.id, firstLanguage);
  if (resolved?.languages.includes("*")) {
    return [{
      id: gate.id,
      required: true,
      language: firstLanguage,
      specClauseIds: [...acceptanceIds],
      timeoutSeconds: gateTimeoutSeconds(input),
      freshnessSeconds: 3600,
      facts,
      capabilityBinding: binding
    }];
  }
  const declaredTargets = resolved?.id === "builtin/declared-project-command"
    ? services.filter((service) => declaredCommands[service.id]?.[gate.id])
    : services;
  const targets = declaredTargets.length > 0
    ? declaredTargets
    : [{ id: "project", name: "project", path: ".", owners: [], language: "unknown", contracts: [] }];
  return targets.map((service) => {
    const cwd = serviceWorkspacePath(input.project, input.candidateRoot, service);
    const command = declaredCommands[service.id]?.[gate.id];
    return {
      id: gate.id,
      required: true,
      language: service.language,
      specClauseIds: [...acceptanceIds],
      ...(command
        ? { declaredCommands: { [gate.id]: command } }
        : {}),
      timeoutSeconds: gateTimeoutSeconds(input),
      freshnessSeconds: 3600,
      facts,
      capabilityBinding: binding,
      // runGateEngineV2 accepts one cwd for a batch. Attach the desired cwd as
      // an internal data property and group plans before execution below.
      __cwd: cwd
    } as WorkspaceGatePlan;
  });
}

function gateTimeoutSeconds(input: GovernedGateExecutionInput): number {
  const limits = [
    input.task.strategy.timeoutSeconds,
    input.manifest.stopConditions.maxDurationSeconds
  ].filter((value): value is number => value !== undefined && value > 0);
  return Math.max(1, Math.min(...limits));
}

function buildRuntimeRegistry(
  manifest: HarnessManifest,
  services: readonly Service[],
  commands: DeclaredCommandsByService
): GateRegistryV2 {
  const registry = createDefaultGateRegistry();
  const dynamicGates = manifest.gatePlan
    .map((gate) => gate.id)
    .filter((gateId) =>
      services.some(
        (service) =>
          registry.resolve(gateId, service.language) === undefined &&
          commands[service.id]?.[gateId] !== undefined
      )
    );
  if (dynamicGates.length === 0) return registry;
  const runner: GateRunnerV2 = {
    id: "builtin/declared-project-command",
    version: "1",
    gateIds: uniqueSorted(dynamicGates),
    languages: uniqueSorted(services.map((service) => service.language)),
    resolveCommand(context) {
      const declared = context.declaredCommands?.[context.gateId];
      if (!declared) return undefined;
      return {
        executable: declared.executable,
        args: declared.args,
        display: [declared.executable, ...declared.args].join(" "),
        versionArgs: ["--version"]
      };
    }
  };
  registry.register(runner);
  return registry;
}

async function buildFacts(
  input: GovernedGateExecutionInput,
  services: readonly Service[],
  acceptanceIds: readonly string[]
): Promise<GateEvaluationFacts> {
  const contractDocuments: GateContractDocument[] = [];
  for (const service of services) {
    for (const contract of service.contracts) {
      if (contract.type !== "openapi" && contract.type !== "asyncapi") continue;
      const path = await contractRepositoryPath(input.project, service, contract.path);
      contractDocuments.push({
        type: contract.type,
        path,
        content: await readSafeText(input.candidateRoot, path),
        ...(input.contractBaseline?.[path] === undefined
          ? {}
          : { previousContent: input.contractBaseline[path] })
      });
    }
  }
  return {
    ...(input.spec ? { spec: input.spec } : {}),
    coveredSpecClauseIds: [...acceptanceIds],
    changedPaths: [...input.changedPaths],
    allowedPaths: allowedPathsForServices(input.project, services, input.changedPaths),
    protectedPaths: [...input.manifest.executionPolicy.protectedPaths],
    contractDocuments,
    rollbackPaths: await discoverRollbackPaths(input.candidateRoot, services, input.project)
  };
}

function parseDeclaredCommands(manifest: HarnessManifest): DeclaredCommandsByService {
  const fragment = manifest.context.fragments.find((candidate) =>
    candidate.id === "repository:.mn/project.yaml" ||
    candidate.metadata?.relativePath === ".mn/project.yaml"
  );
  if (!fragment) return Object.freeze({});
  const document = parseDocument(fragment.content, { schema: "core", uniqueKeys: true });
  if (document.errors.length > 0) return Object.freeze({});
  const root = plainRecord(document.toJS({ maxAliasCount: 50 }));
  if (!root || !Array.isArray(root.services)) return Object.freeze({});
  const byService: Record<string, Readonly<Record<string, DeclaredCommand>>> = {};
  for (const item of root.services) {
    const service = plainRecord(item);
    if (!service || typeof service.id !== "string") continue;
    const rawCommands = plainRecord(service.commands);
    if (!rawCommands) continue;
    const normalized: Record<string, DeclaredCommand> = {};
    for (const [name, raw] of Object.entries(rawCommands)) {
      if (typeof raw !== "string") continue;
      const parsed = parseCommand(raw);
      normalized[name] = parsed;
      if (name === "test") {
        normalized.unit_test ??= parsed;
        normalized.unit ??= parsed;
      }
    }
    byService[service.id] = Object.freeze(normalized);
  }
  return Object.freeze(byService);
}

function parseCommand(value: string): DeclaredCommand {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError("Declared project command contains shell control syntax");
  }
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else if (/[|&;<>()$`]/u.test(character)) {
      throw new TypeError("Declared project command contains shell control syntax");
    } else if (character === "\\") {
      throw new TypeError("Declared project commands cannot contain escapes");
    } else {
      current += character;
    }
  }
  if (quote) throw new TypeError("Declared project command contains an unclosed quote");
  if (current) words.push(current);
  if (words.length === 0) throw new TypeError("Declared project command is empty");
  return Object.freeze({ executable: words[0]!, args: Object.freeze(words.slice(1)) });
}

function serviceWorkspacePath(
  project: Project,
  candidateRoot: string,
  service: Service
): string {
  const path = serviceRelativePath(project, service);
  const workspace = path === "" ? resolve(candidateRoot) : resolve(candidateRoot, path);
  if (!pathInside(resolve(candidateRoot), workspace)) {
    throw new TypeError(`Service ${service.id} escapes the candidate workspace`);
  }
  return workspace;
}

function serviceRelativePath(project: Project, service: Service): string {
  if (!isAbsolute(service.path)) return normalizeRelativePath(service.path, true);
  const path = relative(resolve(project.rootPath), resolve(service.path));
  if (!pathInside(resolve(project.rootPath), resolve(service.path))) {
    throw new TypeError(`Service ${service.id} path escapes project root`);
  }
  return path === "" ? "" : normalizeRelativePath(path, false);
}

function allowedPathsForServices(
  project: Project,
  services: readonly Service[],
  changedPaths: readonly string[] = []
): readonly string[] {
  if (services.some((service) => serviceRelativePath(project, service) === "")) {
    // The policy matcher intentionally supports prefixes rather than arbitrary
    // glob syntax. A root-scoped service owns every observed changed path.
    return changedPaths.length > 0 ? uniqueSorted(changedPaths) : ["__mn_no_changes__"];
  }
  return services
    .map((service) => `${serviceRelativePath(project, service)}/**`)
    .sort(compareCodeUnits);
}

async function contractRepositoryPath(
  project: Project,
  service: Service,
  contractPath: string
): Promise<string> {
  let direct: string;
  if (isAbsolute(contractPath)) {
    const [root, absolute] = await Promise.all([
      realpath(resolve(project.rootPath)),
      realpath(resolve(contractPath))
    ]);
    if (!pathInside(root, absolute)) {
      throw new TypeError(`Contract path escapes project root: ${contractPath}`);
    }
    direct = normalizeRelativePath(relative(root, absolute), false);
  } else {
    direct = normalizeRelativePath(contractPath, false);
  }
  const servicePath = serviceRelativePath(project, service);
  if (servicePath === "" || direct === servicePath || direct.startsWith(`${servicePath}/`)) {
    return direct;
  }
  return `${servicePath}/${direct}`;
}

async function discoverRollbackPaths(
  candidateRoot: string,
  services: readonly Service[],
  project: Project
): Promise<readonly string[]> {
  const result: string[] = [];
  for (const service of services) {
    const servicePath = serviceRelativePath(project, service);
    const root = servicePath ? resolve(candidateRoot, servicePath) : resolve(candidateRoot);
    async function visit(directory: string, prefix: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(join(directory, entry.name), path);
        else if (
          entry.isFile() &&
          /(?:^|[._-])(?:down|rollback|revert)(?:[._-]|$)/iu.test(entry.name)
        ) {
          result.push(servicePath ? `${servicePath}/${path}` : path);
        }
      }
    }
    await visit(root, "");
  }
  return uniqueSorted(result);
}

async function readSafeText(root: string, repositoryPath: string): Promise<string> {
  const normalized = normalizeRelativePath(repositoryPath, false);
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, normalized);
  if (!pathInside(absoluteRoot, absolute)) {
    throw new TypeError(`Gate path escapes workspace: ${repositoryPath}`);
  }
  const stats = await lstat(absolute);
  const [realRoot, realFile] = await Promise.all([
    realpath(absoluteRoot),
    realpath(absolute)
  ]);
  if (!pathInside(realRoot, realFile)) {
    throw new TypeError(`Gate path escapes workspace through a symlink: ${repositoryPath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) {
    throw new TypeError(`Gate path is not a safe bounded file: ${repositoryPath}`);
  }
  return readFile(absolute, "utf8");
}

function normalizeRelativePath(value: string, allowRoot: boolean): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new TypeError(`Invalid repository-relative path: ${String(value)}`);
  }
  if (allowRoot && value === ".") return "";
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`Repository path contains traversal: ${value}`);
  }
  return segments.join("/");
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function evidenceBearingGate(gateId: string): boolean {
  return !new Set([
    "spec_schema",
    "spec_approval",
    "acceptance_coverage",
    "protected_path",
    "diff_scope"
  ]).has(gateId);
}

function toLegacyGateResult(result: GateResultV2): GateResult {
  return {
    gate: result.gateId,
    status:
      result.status === "pass"
        ? "pass"
        : result.status === "fail" || result.status === "error"
          ? "fail"
          : "skipped",
    summary: result.summary,
    evidence: result.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind === "sarif" ? "security-report" : "test-report",
      path: artifact.path ?? `mn://gate-artifacts/${artifact.id}`,
      sha256: artifact.digest,
      contentType: artifact.contentType
    }))
  };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Governed Gate evidence must be canonical JSON");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
