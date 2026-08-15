import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentTask, Project, RunRecord } from "@mn/core";
import { parseProjectManifest } from "@mn/connectors";
import {
  CapabilityRegistry,
  builtinHarnessProfile,
  compileHarnessManifest,
  createStaticContextSource,
  type ContextFragmentInput,
  type GateRunner,
  type SandboxBackend,
  type SandboxRuntimeImage
} from "@mn/harness";
import type { FileSpecRepository, SpecRevision } from "@mn/specs";
import type { MemoryStore } from "./store.js";
import {
  resolveProjectGovernance,
  type ControlPlaneRouteOptions
} from "./controlPlane.js";
import type { RuntimeCapabilityCatalog } from "./capabilities.js";

export interface PrepareGovernedRunBindingsOptions {
  readonly store: MemoryStore;
  readonly specRepository: FileSpecRepository;
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  readonly enterpriseSandboxImage?: SandboxRuntimeImage;
}

const CONTEXT_FILES = [
  ".mn/project.yaml",
  ".mn/standards.lock",
  "AGENTS.md",
  "CLAUDE.md",
  "CODEOWNERS",
  ".github/CODEOWNERS",
  ".gitlab/CODEOWNERS"
] as const;

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function repositoryContextFragments(
  project: Project,
  selectedServiceIds: readonly string[]
): Promise<ContextFragmentInput[]> {
  const root = await realpath(project.rootPath);
  const fragments: ContextFragmentInput[] = [];
  for (const [index, relativePath] of CONTEXT_FILES.entries()) {
    const candidate = resolve(root, relativePath);
    if (!pathInside(root, candidate)) continue;
    try {
      const stats = await lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      fragments.push({
        id: `repository:${relativePath}`,
        kind: relativePath.includes("CODEOWNERS") ? "ownership" : "repository-rule",
        source: candidate,
        content: await readFile(candidate, "utf8"),
        priority: 1_000 - index,
        required: relativePath === ".mn/project.yaml",
        metadata: { relativePath }
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  const contracts = project.services
    .filter((service) => selectedServiceIds.includes(service.id))
    .flatMap((service) =>
      service.contracts.map((contract) => ({ serviceId: service.id, contract }))
    )
    .sort(
      (left, right) =>
        left.serviceId.localeCompare(right.serviceId) ||
        left.contract.path.localeCompare(right.contract.path)
    );
  const seenContracts = new Set<string>();
  for (const { serviceId, contract } of contracts) {
    const declared = isAbsolute(contract.path)
      ? resolve(contract.path)
      : resolve(root, contract.path);
    const canonical = await realpath(declared);
    if (!pathInside(root, canonical)) {
      throw new TypeError(`Contract ${contract.path} escapes the project root`);
    }
    const stats = await lstat(declared);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new TypeError(`Contract ${contract.path} must be a regular non-symlink file`);
    }
    const relativePath = relative(root, canonical);
    const identity = `${serviceId}\0${relativePath}`;
    if (seenContracts.has(identity)) continue;
    seenContracts.add(identity);
    fragments.push({
      id: `contract:${serviceId}:${relativePath}`,
      kind: "contract",
      source: canonical,
      content: await readFile(canonical, "utf8"),
      priority: 800,
      required: true,
      metadata: {
        relativePath,
        serviceId,
        contractType: contract.type
      }
    });
  }
  return fragments;
}

function selectedServiceIds(project: Project, task: AgentTask, spec: SpecRevision): string[] {
  const selected = spec.targetServices.length > 0
    ? [...spec.targetServices]
    : task.targetServices.length > 0
      ? [...task.targetServices]
      : project.services.map((service) => service.id);
  if (
    spec.targetServices.length > 0 &&
    task.targetServices.some((service) => !spec.targetServices.includes(service))
  ) {
    throw new TypeError("Task targetServices cannot expand the approved Spec scope");
  }
  const available = new Set(project.services.map((service) => service.id));
  const missing = selected.filter((service) => !available.has(service));
  if (missing.length > 0) {
    throw new TypeError(
      `Approved Spec targets services missing from the project index: ${missing.join(", ")}`
    );
  }
  return [...new Set(selected)].sort();
}

function compileRegistry(
  catalog: RuntimeCapabilityCatalog,
  requiredGateIds: readonly string[],
  languages: readonly string[],
  profileId: string,
  projectRoot: string,
  fragments: readonly ContextFragmentInput[],
  enterpriseSandboxImage?: SandboxRuntimeImage
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const runnerLanguages = languages.length > 0 ? [...languages] : ["*"];
  const declaredGates = declaredProjectGates(fragments);
  for (const gateId of requiredGateIds) {
    const descriptor = catalog.gates.find(
      (candidate) => candidate.id === gateId && candidate.status === "available"
    );
    if (!descriptor && !declaredGates.has(gateId)) continue;
    const runner: GateRunner = {
      id: gateId,
      version: descriptor?.version ?? "1",
      languages: runnerLanguages,
      async run() {
        return {
          id: gateId,
          status: "unsupported",
          summary: "Harness compilation metadata adapter; execution uses GateRegistryV2",
          evidence: []
        };
      }
    };
    registry.registerGateRunner(runner);
  }
  const enterprise = profileId === "enterprise";
  const backend: SandboxBackend = enterprise
    ? {
        id: "enterprise-container",
        version: "1",
        enforcement: "enforced",
        capabilities: [
          "mount-policy",
          "network-policy",
          "resource-limits",
          "secret-injection",
          "tool-allowlist"
        ],
        ...(enterpriseSandboxImage
          ? { runtimeImage: { ...enterpriseSandboxImage } }
          : {}),
        async prepare() {
          throw new Error("Enterprise sandbox must be provisioned by a remote worker");
        }
      }
    : {
        id: "worktree-postcheck",
        version: "1",
        enforcement: "postcheck",
        capabilities: ["source-isolation", "diff-postcheck"],
        async prepare() {
          return {
            backendId: "worktree-postcheck",
            workspacePath: projectRoot
          };
        }
      };
  registry.registerSandboxBackend(backend);
  if (fragments.length > 0) {
    registry.registerContextSource(
      createStaticContextSource("repository-governance", fragments)
    );
  }
  return registry;
}

function declaredProjectGates(
  fragments: readonly ContextFragmentInput[]
): ReadonlySet<string> {
  const fragment = fragments.find(
    (candidate) => candidate.id === "repository:.mn/project.yaml"
  );
  if (!fragment) return new Set();
  const manifest = parseProjectManifest(fragment.content);
  const gates = new Set<string>();
  for (const service of manifest.services) {
    for (const command of Object.keys(service.commands)) gates.add(command);
    if (service.commands.test) {
      gates.add("unit");
      gates.add("unit_test");
    }
  }
  return gates;
}

export async function prepareGovernedRunBindings(
  project: Project,
  task: AgentTask,
  options: PrepareGovernedRunBindingsOptions
): Promise<Pick<RunRecord, "governanceSnapshot" | "harnessManifest" | "trace">> {
  if (!task.specRef || !task.workflowRef) {
    throw new TypeError("Governed run requires Spec and Workflow references");
  }
  const harnessProfileId = task.harnessProfileRef?.id ?? "local";
  const profile = builtinHarnessProfile(harnessProfileId);
  if (!profile || !profile.digest) {
    throw new TypeError(`Harness profile ${harnessProfileId} is not registered`);
  }
  if (
    task.harnessProfileRef &&
    (task.harnessProfileRef.version !== profile.version ||
      task.harnessProfileRef.digest !== profile.digest)
  ) {
    throw new TypeError("Task Harness profile reference does not match its immutable definition");
  }

  const record = await options.specRepository.get(task.specRef.specSetId);
  const spec = record?.revisions.find(
    (candidate) => candidate.revision === task.specRef!.revision
  );
  if (
    !spec ||
    spec.status !== "approved" ||
    spec.digest !== task.specRef.digest
  ) {
    throw new TypeError("Governed run requires the exact persisted approved Spec revision");
  }
  const selectedServices = selectedServiceIds(project, task, spec);
  const languageByService = Object.fromEntries(
    project.services
      .filter((service) => selectedServices.includes(service.id))
      .map((service) => [service.id, service.language])
  );
  const now = new Date().toISOString();
  const controlPlaneOptions: ControlPlaneRouteOptions = {
    store: options.store,
    specRepository: options.specRepository
  };
  const resolution = await resolveProjectGovernance(
    project.id,
    {
      now,
      taskId: task.id,
      specSetId: task.specRef.specSetId,
      specRevision: task.specRef.revision,
      workflowId: task.workflowRef.id,
      workflowVersion: task.workflowRef.version,
      workflowDigest: task.workflowRef.digest,
      harnessProfileId: profile.id,
      harnessProfileVersion: profile.version,
      harnessProfileDigest: profile.digest
    },
    controlPlaneOptions
  );
  if (resolution.notFound) throw new TypeError("Project was removed before governance resolution");
  const fragments = await repositoryContextFragments(project, selectedServices);
  const languages = [...new Set(Object.values(languageByService))].sort();
  const registry = compileRegistry(
    options.capabilityCatalog,
    resolution.snapshot.policy.requiredGates,
    languages,
    profile.id,
    project.rootPath,
    fragments,
    options.enterpriseSandboxImage
  );
  const harnessManifest = await compileHarnessManifest({
    spec,
    governance: resolution.snapshot,
    registry,
    context: {
      taskId: task.id,
      projectRoot: project.rootPath,
      selectedServices,
      languageByService
    },
    profile,
    now
  });
  return {
    governanceSnapshot: resolution.snapshot,
    harnessManifest,
    trace: {
      traceId: task.id,
      specDigest: task.specRef.digest,
      governanceDigest: resolution.snapshot.digest,
      harnessDigest: harnessManifest.digest,
      evidenceIds: []
    }
  };
}
