#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  AgentProvider,
  AgentTask,
  GateArtifactV2,
  Project,
  RunEvent,
  RunRecord
} from "@mn/core";
import {
  BuiltinAgentExecutor,
  createDefaultExecutors,
  MockExecutor
} from "@mn/executors";
import type {
  SandboxExecutionEvidence,
  SandboxLeaseAttestation,
  SandboxRuntimeProof
} from "@mn/harness";
import type {
  ApprovalDecision,
  GovernedRunState,
  LoopBudgetMeasurer
} from "@mn/loop";
import {
  canonicalJson,
  digestSpecRevision,
  importSpecKitDirectory,
  parseNativeSpecYaml,
  serializeNativeSpecYaml,
  validateSpecRevision,
  type SpecRevision,
  type SpecSet
} from "@mn/specs";
import {
  DockerEnforcedSandboxBackend,
  DockerSandboxAgentExecutor,
  GovernedRunOrchestrator,
  KubernetesSandboxPodBackend,
  RunOrchestrator,
  gateResultV2OutputDigest,
  prepareSnapshotCandidateWorkspace,
  projectAtSnapshot
} from "@mn/worker";
import { parse as parseYaml } from "yaml";
import { agentCommand } from "./agent-commands.js";
import { runEnterpriseBuiltinAgentCandidate as runRemoteEnterpriseBuiltinAgentCandidate } from "./enterprise-builtin-runner.js";
import { pluginCommand, profileCommand } from "./runtime-commands.js";

const defaultApiUrl = "http://127.0.0.1:7318";
const execFileAsync = promisify(execFile);

const allowedProviders = ["claude", "codex"] as const;
const allowedArtifactKinds = [
  "log",
  "diff",
  "summary",
  "test-report",
  "trace",
  "security-report",
  "verifier-report"
] as const;
const allowedGates = [
  "unit_test",
  "lint",
  "typecheck",
  "contract",
  "migration_safety",
  "security",
  "llm_verifier",
  "human_approval"
] as const;
const allowedApprovalModes = ["never", "on-risk", "before-merge"] as const;
const allowedProviderApps = ["claude", "codex", "unified"] as const;
const allowedManagedApps = ["claude", "codex"] as const;
const allowedProviderKinds = [
  "official",
  "openai_compatible",
  "anthropic_compatible",
  "relay",
  "custom"
] as const;
const allowedApiFormats = [
  "anthropic_messages",
  "openai_responses",
  "openai_chat"
] as const;
const allowedWireApis = ["responses", "chat"] as const;
const allowedCodexModes = [
  "official",
  "third_party_preserve_auth",
  "api_key_auth_file",
  "local_route"
] as const;
const allowedProviderModelCatalogSyncModes = ["replace", "merge"] as const;
const allowedSkillSyncModes = ["copy", "symlink"] as const;
const allowedManagedEnvNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY"
] as const;
const allowedEnvCleanupSources = ["shell", "launchd", "ide", "all"] as const;
const allowedRunJobWorkerStates = ["idle", "running", "stale"] as const;
const allowedGovernanceScopes = [
  "organization",
  "team",
  "project",
  "service",
  "task"
] as const;

const enterpriseGateRunnerIds = [
  "spec_schema",
  "spec_approval",
  "acceptance_coverage",
  "diff_scope",
  "protected_path",
  "contract",
  "migration_safety",
  "security",
  "unit",
  "unit_test",
  "integration",
  "lint",
  "typecheck",
  "llm_verifier"
] as const;
const enterpriseSandboxCapabilities = [
  "mount-policy",
  "network-policy",
  "resource-limits",
  "secret-injection",
  "tool-allowlist",
  "read-only-root-filesystem",
  "runtime-inspection"
] as const;

interface RuntimeCapabilityDescriptor {
  kind: "provider" | "gate" | "workflow" | "harness_profile";
  id: string;
  version: string;
  status: "available" | "unavailable" | "declared";
  displayName?: string;
  reason?: string;
  digest?: string;
}

interface CapabilitiesResponse {
  providers: RuntimeCapabilityDescriptor[];
  gates: RuntimeCapabilityDescriptor[];
  workflows: RuntimeCapabilityDescriptor[];
  harnessProfiles: RuntimeCapabilityDescriptor[];
}

interface EffectiveGovernanceResponse {
  snapshot: {
    digest: string;
    specRef?: {
      specSetId: string;
      revision: number;
      digest: string;
    };
    policy: {
      requiredGates: string[];
      allowedProviders?: Array<"claude" | "codex">;
      budgets: {
        maxCandidates?: number;
        maxDurationSeconds?: number;
      };
      approvalMode: "never" | "on-risk" | "before-merge";
    };
  };
}

interface MnConfig {
  apiUrl: string;
  projectId?: string;
}

interface HealthResponse {
  ok: boolean;
  service: string;
  executorMode: "mock" | "real";
  workspaceRoot: string;
}

interface RunJobQueueItem {
  version?: 1 | 2;
  runId: string;
  projectId: string;
  taskId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  ownerId?: string;
  requirements?: WorkerRequirements;
}

interface RunJobClaimResponse {
  item: RunJobQueueItem | null;
  claimToken: string | null;
  reason?: string;
  sandboxAttestation?: SandboxLeaseAttestation;
  payload?: EnterpriseRunJobPayload;
  proxyBaseUrl?: string;
}

interface EnterpriseWorkerBudgetStop {
  kind: "budget_exhausted";
  dimension:
    | "duration"
    | "tokens"
    | "cost"
    | "repair_attempts"
    | "changed_files"
    | "changed_lines";
  actual: number;
  limit: number;
  evaluatedAt: string;
}

interface EnterpriseWorkerHeartbeatResponse {
  item: RunJobQueueItem;
  stop?: EnterpriseWorkerBudgetStop;
}

interface WorkerRequirements {
  requiredProviders: WorkerRuntimeId[];
  requiredLanguages: string[];
  requiredGateRunnerIds: string[];
  sandbox: {
    allowedBackendIds: string[];
    minEnforcement: "none" | "postcheck" | "enforced";
    requiredCapabilities: string[];
  };
  requiredTools: string[];
}

interface WorkerCapabilities {
  providers: WorkerRuntimeId[];
  languages: string[];
  gateRunnerIds: string[];
  sandboxBackends: Array<{
    backendId: string;
    enforcement: "enforced";
    capabilities: string[];
  }>;
  tenantIds: string[];
  tools: string[];
}

type WorkerRuntimeId = "builtin" | AgentProvider;

interface EnterpriseSourceSnapshotRef {
  schemaVersion: 1;
  objectKey: string;
  digest: string;
  byteLength: number;
  contentType: "application/vnd.muniu.workspace-snapshot.v1+json";
}

interface EnterpriseWorkerExecutionContext {
  schemaVersion: 1 | 2;
  project: Project;
  task: AgentTask;
  specRevision: SpecRevision;
  sourceSnapshot?: EnterpriseSourceSnapshotRef;
  bindings: {
    tenantId: string;
    runId: string;
    projectId: string;
    taskId: string;
    specRef: NonNullable<AgentTask["specRef"]>;
    governanceDigest: string;
    harnessDigest: string;
    workflowRef?: AgentTask["workflowRef"];
  };
  digest: string;
}

interface EnterpriseRunJobPayload {
  version: 1 | 2;
  run: RunRecord;
  executionContext?: EnterpriseWorkerExecutionContext;
  governedResumeState?: GovernedRunState;
  approvalDecision?: ApprovalDecision;
}

interface RunJobWorkerListResponse {
  workers: Array<{
    ownerId: string;
    state: "idle" | "running" | "stale";
    status: "idle" | "running";
    activeRunId?: string;
    activeRunIds?: string[];
    capacity?: number;
    activeRunCount?: number;
    availableSlots?: number;
    lastSeenAt: string;
    heartbeatExpiresAt: string;
    completedRunCount: number;
    failedRunCount: number;
    cancelledRunCount: number;
    releasedRunCount: number;
  }>;
  summary: {
    total: number;
    idle: number;
    running: number;
    stale: number;
    capacity?: number;
    activeRunCount?: number;
    availableSlots?: number;
  };
}

async function main(): Promise<void> {
  const [, , command, subcommand, ...args] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    await init();
    return;
  }

  if (command === "agent") {
    await agentCommand(subcommand, args);
    return;
  }

  if (command === "plugin") {
    await pluginCommand(subcommand, args);
    return;
  }

  if (command === "profile") {
    await profileCommand(subcommand, args);
    return;
  }

  if (command === "doctor") {
    if (subcommand === "env-cleanup") {
      await doctorEnvCleanup(args);
      return;
    }
    await doctor();
    return;
  }

  if (command === "diagnostics" || command === "diagnostic") {
    await diagnosticsCommand(subcommand, args);
    return;
  }

  if (command === "provider") {
    await providerCommand(subcommand, args);
    return;
  }

  if (command === "proxy") {
    await proxyCommand(subcommand, args);
    return;
  }

  if (command === "usage") {
    await usageCommand(subcommand, args);
    return;
  }

  if (command === "session" || command === "sessions") {
    await sessionCommand(subcommand, args);
    return;
  }

  if (command === "artifact-store") {
    await artifactStoreCommand(subcommand, args);
    return;
  }

  if (command === "mcp") {
    await mcpCommand(subcommand, args);
    return;
  }

  if (command === "prompt") {
    await promptCommand(subcommand, args);
    return;
  }

  if (command === "skill") {
    await skillCommand(subcommand, args);
    return;
  }

  if (command === "standards") {
    await standardsCommand(subcommand, args);
    return;
  }

  if (command === "spec") {
    await specCommand(subcommand, args);
    return;
  }

  if (command === "policy") {
    await policyCommand(subcommand, args);
    return;
  }

  if (command === "workflow") {
    await workflowCommand(subcommand, args);
    return;
  }

  if (command === "audit") {
    await auditCommand(subcommand, args);
    return;
  }

  if (command === "project" && subcommand === "register") {
    await registerProject(args);
    return;
  }

  if (command === "project" && subcommand === "index") {
    await indexProject();
    return;
  }

  if (command === "task" && subcommand === "create") {
    await createTask(args);
    return;
  }

  if (command === "run" && subcommand === "artifacts") {
    await showRunArtifacts(args);
    return;
  }

  if (command === "run" && subcommand === "worker") {
    await runWorker(args);
    return;
  }

  if (command === "run" && subcommand === "workers") {
    await listRunWorkers(args);
    return;
  }

  if (command === "run" && subcommand === "artifacts-download") {
    await downloadRunArtifactsArchive(args);
    return;
  }

  if (command === "run" && subcommand === "artifact") {
    await downloadRunArtifact(args);
    return;
  }

  if (command === "run" && subcommand === "resume") {
    await resumeRun(args);
    return;
  }

  if (command === "run" && subcommand === "cleanup") {
    await cleanupRunWorkspaces(args);
    return;
  }

  if (command === "run" && subcommand === "watch") {
    await watchRun(args[0]);
    return;
  }

  if (command === "run") {
    await runTask(subcommand === undefined ? args : [subcommand, ...args]);
    return;
  }

  if (command === "gates" && subcommand === "report") {
    await reportGates(args[0]);
    return;
  }

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

async function init(): Promise<void> {
  await mkdir(".mn", { recursive: true });
  const config: MnConfig = { apiUrl: process.env.MN_API_URL ?? defaultApiUrl };
  await writeFile(".mn/config.json", `${JSON.stringify(config, null, 2)}\n`);
  console.log("Initialized .mn/config.json");
}

async function doctor(): Promise<void> {
  const targetApiUrl = await resolveApiUrl();
  const health = await fetchJson<HealthResponse>("/healthz");
  const [claude, codex] = await Promise.all([
    probeBinary(process.env.MN_CLAUDE_BINARY ?? "claude", ["--version"]),
    probeBinary(process.env.MN_CODEX_BINARY ?? "codex", ["--version"])
  ]);

  console.log(`API: ${health.ok ? "ok" : "failed"} (${health.service})`);
  console.log(`API URL: ${targetApiUrl}`);
  console.log(`Executor mode: ${health.executorMode}`);
  console.log(`Workspace root: ${health.workspaceRoot}`);
  console.log(formatProbe("Claude Code", claude));
  console.log(formatProbe("Codex CLI", codex));

  try {
    const doctorResult = await fetchJson<{
      envConflicts?: Array<{
        name: string;
        maskedValue: string;
        source: string;
        sourcePath?: string;
        line?: number;
      }>;
      configDirectories?: Array<{
        app: string;
        configDir: string;
        exists: boolean;
        primaryConfigPath: string;
        primaryConfigExists: boolean;
      }>;
    }>("/v1/system/doctor");
    for (const item of doctorResult.configDirectories ?? []) {
      console.log(
        `${item.app} config: ${item.exists ? "ok" : "missing"} (${item.primaryConfigPath}: ${item.primaryConfigExists ? "found" : "missing"})`
      );
    }
    for (const conflict of doctorResult.envConflicts ?? []) {
      const line = conflict.line ? `:${conflict.line}` : "";
      const location = conflict.sourcePath ? ` ${conflict.sourcePath}${line}` : "";
      console.log(
        `Env conflict: ${conflict.name}=${conflict.maskedValue} (${conflict.source}${location})`
      );
    }
  } catch {
    // Older mn-api versions only expose /healthz; keep doctor backward-compatible.
  }
}

async function doctorEnvCleanup(args: string[]): Promise<void> {
  const names = readRepeatedOptions(args, "--name");
  const sourceOptions = readRepeatedOptions(args, "--source");
  for (const name of names) {
    if (!allowedManagedEnvNames.includes(name as (typeof allowedManagedEnvNames)[number])) {
      throw new Error(
        `Unknown env name: ${name}. Expected one of ${allowedManagedEnvNames.join(", ")}.`
      );
    }
  }
  for (const source of sourceOptions) {
    if (
      !allowedEnvCleanupSources.includes(
        source as (typeof allowedEnvCleanupSources)[number]
      )
    ) {
      throw new Error(
        `Unknown env cleanup source: ${source}. Expected one of ${allowedEnvCleanupSources.join(", ")}.`
      );
    }
  }
  const sources = envCleanupSourcesFromOptions(sourceOptions);
  const dryRun = readFlag(args, "--dry-run") || !readFlag(args, "--yes");
  const result = await postJson("/v1/system/env-cleanup", {
    dryRun,
    ...(names.length > 0 ? { names } : {}),
    ...(sources.length > 0 ? { sources } : {})
  });
  console.log(JSON.stringify(result, null, 2));
}

async function diagnosticsCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  const action = !subcommand || subcommand.startsWith("-") ? "export" : subcommand;
  const effectiveArgs = subcommand?.startsWith("-") ? [subcommand, ...args] : args;
  if (action !== "export") {
    throw new Error(`Unknown diagnostics command: ${subcommand ?? ""}`);
  }
  const document = await fetchJson("/v1/system/diagnostics");
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const outputPath = readOption(effectiveArgs, "--out");
  if (outputPath) {
    await writeFile(outputPath, content);
    console.log(`Exported diagnostics to ${outputPath}`);
    return;
  }
  process.stdout.write(content);
}

function envCleanupSourcesFromOptions(options: string[]): string[] {
  if (options.length === 0) return [];
  const sources = new Set<string>();
  for (const option of options) {
    if (option === "all") {
      sources.add("shell_profile");
      sources.add("launch_agent");
      sources.add("ide_settings");
    } else if (option === "shell") {
      sources.add("shell_profile");
    } else if (option === "launchd") {
      sources.add("launch_agent");
    } else if (option === "ide") {
      sources.add("ide_settings");
    }
  }
  return [...sources];
}

function readRepeatedOptions(args: string[], key: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === key) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${key} requires a value.`);
      }
      values.push(value);
    }
  }
  return values;
}

function parseTrustedPublicKeyOptions(
  values: string[]
): Array<{ id: string; publicKey: string }> {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error("--trusted-public-key entries must use id=base64-spki.");
    }
    const id = value.slice(0, separator).trim();
    const publicKey = value.slice(separator + 1).trim();
    if (!id || !publicKey) {
      throw new Error("--trusted-public-key entries must include both id and public key.");
    }
    return { id, publicKey };
  });
}

async function providerCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "list") {
    await listProviders(args);
    return;
  }
  if (subcommand === "add") {
    await addProvider(args);
    return;
  }
  if (subcommand === "export") {
    await exportProviders(args);
    return;
  }
  if (subcommand === "import") {
    await importProviders(args);
    return;
  }
  if (subcommand === "model-catalog") {
    await providerModelCatalogCommand(args[0], args.slice(1));
    return;
  }
  if (subcommand === "enable") {
    await enableProvider(args);
    return;
  }
  if (subcommand === "restore") {
    await restoreProvider(args);
    return;
  }
  if (subcommand === "delete") {
    await deleteProvider(args);
    return;
  }
  if (subcommand === "test") {
    await testProvider(args);
    return;
  }
  throw new Error(`Unknown provider command: ${subcommand ?? ""}`);
}

async function providerModelCatalogCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "sync") {
    await syncProviderModelCatalog(args);
    return;
  }
  if (subcommand === "audit") {
    await auditProviderModelCatalog(args);
    return;
  }
  if (subcommand === "sync-due") {
    await syncDueProviderModelCatalogs(args);
    return;
  }
  throw new Error(`Unknown provider model-catalog command: ${subcommand ?? ""}`);
}

async function proxyCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "status") {
    console.log(JSON.stringify(await fetchJson("/v1/proxy/status"), null, 2));
    return;
  }
  if (subcommand === "start") {
    const port = readPositiveIntOrZeroOption(args, "--port");
    const result = await postJson("/v1/proxy/start", {
      ...(port !== undefined ? { port } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "stop") {
    console.log(JSON.stringify(await postJson("/v1/proxy/stop", {}), null, 2));
    return;
  }
  if (subcommand === "takeover") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app") ?? args[0];
    if (app !== "claude" && app !== "codex") throw new Error("Missing app.");
    const homeDir = readOption(args, "--home");
    const dryRun = readFlag(args, "--dry-run");
    console.log(
      JSON.stringify(
        await postJson(`/v1/proxy/apps/${app}/takeover`, {
          ...(homeDir ? { homeDir } : {}),
          dryRun
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "restore") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app") ?? args[0];
    if (app !== "claude" && app !== "codex") throw new Error("Missing app.");
    const homeDir = readOption(args, "--home");
    const dryRun = readFlag(args, "--dry-run");
    console.log(
      JSON.stringify(
        await postJson(`/v1/proxy/apps/${app}/restore`, {
          ...(homeDir ? { homeDir } : {}),
          dryRun
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "logs") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    const query = app ? `?app=${encodeURIComponent(app)}` : "";
    console.log(JSON.stringify(await fetchJson(`/v1/proxy/logs${query}`), null, 2));
    return;
  }
  if (subcommand === "health") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    const query = app ? `?app=${encodeURIComponent(app)}` : "";
    console.log(JSON.stringify(await fetchJson(`/v1/proxy/health${query}`), null, 2));
    return;
  }
  if (subcommand === "health-reset") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    const providerId =
      readOption(args, "--provider") ??
      readFirstPositionalArg(args, new Set(["--app", "--provider"]));
    if (!providerId) throw new Error("Missing provider id.");
    console.log(
      JSON.stringify(
        await postJson("/v1/proxy/health/reset", {
          providerId,
          ...(app ? { app } : {})
        }),
        null,
        2
      )
    );
    return;
  }
  throw new Error(`Unknown proxy command: ${subcommand ?? ""}`);
}

async function usageCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  const action = subcommand ?? "summary";
  const app = readEnumOption(args, "--app", allowedManagedApps, "app");
  const providerId = readOption(args, "--provider");
  const runId = readOption(args, "--run");
  const candidateId = readOption(args, "--candidate");
  const limit = readPositiveIntOption(args, "--limit");
  const query = buildQuery({
    ...(app ? { app } : {}),
    ...(providerId ? { providerId } : {}),
    ...(runId ? { runId } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(limit !== undefined ? { limit: String(limit) } : {})
  });
  if (action === "summary") {
    console.log(JSON.stringify(await fetchJson(`/v1/usage/summary${query}`), null, 2));
    return;
  }
  if (action === "requests") {
    console.log(JSON.stringify(await fetchJson(`/v1/usage/requests${query}`), null, 2));
    return;
  }
  if (action === "models") {
    console.log(JSON.stringify(await fetchJson(`/v1/usage/models${query}`), null, 2));
    return;
  }
  throw new Error(`Unknown usage command: ${subcommand ?? ""}`);
}

async function sessionCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  const action = subcommand ?? "list";
  const app = readEnumOption(args, "--app", allowedManagedApps, "app");
  const homeDir = readOption(args, "--home");
  const limit = readPositiveIntOption(args, "--limit");
  const offset = readPositiveIntOrZeroOption(args, "--offset");
  const queryText = readOption(args, "--query");
  const redact = readFlag(args, "--redact");
  const raw = readFlag(args, "--raw");
  const sharedQuery = {
    ...(app ? { app } : {}),
    ...(homeDir ? { homeDir } : {}),
    ...(limit !== undefined ? { limit: String(limit) } : {}),
    ...(offset !== undefined ? { offset: String(offset) } : {}),
    ...(queryText ? { query: queryText } : {})
  };
  if (action === "list") {
    const query = buildQuery({
      ...sharedQuery,
      ...(redact ? { redact: "true" } : {})
    });
    console.log(JSON.stringify(await fetchJson(`/v1/sessions${query}`), null, 2));
    return;
  }
  if (action === "show") {
    const id = args[0];
    if (!id) throw new Error("Missing session id.");
    const query = buildQuery({
      ...sharedQuery,
      ...(redact ? { redact: "true" } : {})
    });
    console.log(
      JSON.stringify(
        await fetchJson(`/v1/sessions/${encodeURIComponent(id)}${query}`),
        null,
        2
      )
    );
    return;
  }
  if (action === "export") {
    const id = args[0];
    if (!id) throw new Error("Missing session id.");
    if (raw && redact) throw new Error("Use either --raw or --redact, not both.");
    const query = buildQuery({
      ...sharedQuery,
      redact: raw ? "false" : "true"
    });
    const document = await fetchJson(
      `/v1/sessions/${encodeURIComponent(id)}/export${query}`
    );
    const content = `${JSON.stringify(document, null, 2)}\n`;
    const outputPath = readOption(args, "--out");
    if (outputPath) {
      await writeFile(outputPath, content);
      console.log(`Exported session ${id} to ${outputPath}`);
      return;
    }
    process.stdout.write(content);
    return;
  }
  throw new Error(`Unknown session command: ${subcommand ?? ""}`);
}

async function artifactStoreCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "summary" || subcommand === "status") {
    console.log(JSON.stringify(await fetchJson("/v1/artifacts/store"), null, 2));
    return;
  }

  if (subcommand === "cleanup") {
    const keepLatestRuns = readPositiveIntOrZeroOption(args, "--keep-latest-runs");
    const maxAgeDays = readPositiveIntOrZeroOption(args, "--max-age-days");
    const maxBytes = readPositiveIntOrZeroOption(args, "--max-bytes");
    const scope = readOption(args, "--scope");
    if (scope !== undefined && !["local", "remote", "both"].includes(scope)) {
      throw new Error("artifact-store cleanup --scope must be local, remote or both.");
    }
    if (keepLatestRuns === undefined && maxAgeDays === undefined && maxBytes === undefined) {
      throw new Error(
        "artifact-store cleanup requires --keep-latest-runs, --max-age-days or --max-bytes."
      );
    }
    const result = await postJson("/v1/artifacts/store/cleanup", {
      dryRun: readFlag(args, "--dry-run") || !readFlag(args, "--yes"),
      scope,
      keepLatestRuns,
      maxAgeDays,
      maxBytes
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown artifact-store command: ${subcommand ?? ""}`);
}

async function mcpCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "list") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    const query = app ? `?app=${encodeURIComponent(app)}` : "";
    console.log(JSON.stringify(await fetchJson(`/v1/mcp/servers${query}`), null, 2));
    return;
  }
  if (subcommand === "add") {
    const name = readOption(args, "--name");
    const command = readOption(args, "--command");
    if (!name) throw new Error("Missing MCP server name.");
    if (!command) throw new Error("Missing MCP server command.");
    const apps = readEnumList(args, "--apps", allowedManagedApps, "app");
    const mcpArgs = readStringListOption(args, "--args");
    const env = readKeyValueRecordOption(args, "--env");
    const result = await postJson("/v1/mcp/servers", {
      name,
      command,
      ...(mcpArgs ? { args: mcpArgs } : {}),
      ...(env ? { env } : {}),
      ...(apps ? { apps } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "project") {
    const serverId = args[0];
    if (!serverId) throw new Error("Missing MCP server id.");
    const homeDir = readOption(args, "--home");
    const apps = readEnumList(args, "--apps", allowedManagedApps, "app");
    const dryRun = readFlag(args, "--dry-run");
    const result = await postJson(`/v1/mcp/servers/${serverId}/project`, {
      ...(homeDir ? { homeDir } : {}),
      ...(apps ? { apps } : {}),
      dryRun
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown mcp command: ${subcommand ?? ""}`);
}

async function promptCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "list") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    const query = app ? `?app=${encodeURIComponent(app)}` : "";
    console.log(JSON.stringify(await fetchJson(`/v1/prompts/presets${query}`), null, 2));
    return;
  }
  if (subcommand === "add") {
    const name = readOption(args, "--name");
    const content = readOption(args, "--content");
    if (!name) throw new Error("Missing prompt name.");
    if (content === undefined) throw new Error("Missing prompt content.");
    const apps = readEnumList(args, "--apps", allowedManagedApps, "app");
    const result = await postJson("/v1/prompts/presets", {
      name,
      content,
      ...(apps ? { apps } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "activate") {
    const promptId = args[0];
    if (!promptId) throw new Error("Missing prompt id.");
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    if (!app) throw new Error("Missing app.");
    const homeDir = readOption(args, "--home");
    const dryRun = readFlag(args, "--dry-run");
    const result = await postJson(`/v1/prompts/presets/${promptId}/activate`, {
      app,
      ...(homeDir ? { homeDir } : {}),
      dryRun
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown prompt command: ${subcommand ?? ""}`);
}

async function skillCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "discover") {
    const homeDir = readOption(args, "--home");
    const query = buildQuery({
      ...(homeDir ? { homeDir } : {})
    });
    console.log(JSON.stringify(await fetchJson(`/v1/skills/discover${query}`), null, 2));
    return;
  }
  if (subcommand === "list") {
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    const query = app ? `?app=${encodeURIComponent(app)}` : "";
    console.log(JSON.stringify(await fetchJson(`/v1/skills${query}`), null, 2));
    return;
  }
  if (subcommand === "add") {
    const name = readOption(args, "--name");
    const sourcePath = readOption(args, "--source");
    if (!name) throw new Error("Missing skill name.");
    if (!sourcePath) throw new Error("Missing skill source path.");
    const apps = readEnumList(args, "--apps", allowedManagedApps, "app");
    const description = readOption(args, "--description");
    const version = readOption(args, "--version");
    const result = await postJson("/v1/skills", {
      name,
      sourcePath,
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(apps ? { apps } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "registry-profile") {
    await skillRegistryProfileCommand(args[0], args.slice(1));
    return;
  }
  if (subcommand === "registry-sync") {
    const registryUrl = readOption(args, "--url");
    if (!registryUrl) throw new Error("Missing registry URL.");
    const dryRun = readFlag(args, "--dry-run") || !readFlag(args, "--yes");
    const requireSignature = readFlag(args, "--require-signature");
    const requireReleaseMetadata = readFlag(args, "--require-release-metadata");
    const publicKey = readOption(args, "--public-key");
    const trustedPublicKeys = parseTrustedPublicKeyOptions(
      readRepeatedOptions(args, "--trusted-public-key")
    );
    const revokedPublicKeyIds = readRepeatedOptions(args, "--revoked-public-key-id");
    const result = await postJson("/v1/skills/registry/sync", {
      registryUrl,
      dryRun,
      requireSignature,
      requireReleaseMetadata,
      ...(publicKey ? { publicKey } : {}),
      ...(trustedPublicKeys.length > 0 ? { trustedPublicKeys } : {}),
      ...(revokedPublicKeyIds.length > 0 ? { revokedPublicKeyIds } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "install") {
    const skillId = args[0];
    if (!skillId) throw new Error("Missing skill id.");
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    if (!app) throw new Error("Missing app.");
    const mode = readEnumOption(args, "--mode", allowedSkillSyncModes, "skill sync mode");
    const homeDir = readOption(args, "--home");
    const dryRun = readFlag(args, "--dry-run");
    const result = await postJson(`/v1/skills/${skillId}/install`, {
      app,
      ...(mode ? { mode } : {}),
      ...(homeDir ? { homeDir } : {}),
      dryRun
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "uninstall") {
    const skillId = args[0];
    if (!skillId) throw new Error("Missing skill id.");
    const app = readEnumOption(args, "--app", allowedManagedApps, "app");
    if (!app) throw new Error("Missing app.");
    const homeDir = readOption(args, "--home");
    const dryRun = readFlag(args, "--dry-run");
    const result = await postJson(`/v1/skills/${skillId}/uninstall`, {
      app,
      ...(homeDir ? { homeDir } : {}),
      dryRun
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "delete") {
    const skillId = args[0];
    if (!skillId) throw new Error("Missing skill id.");
    await deleteJson(`/v1/skills/${skillId}`);
    console.log(`Deleted skill ${skillId}`);
    return;
  }
  throw new Error(`Unknown skill command: ${subcommand ?? ""}`);
}

async function skillRegistryProfileCommand(
  action: string | undefined,
  args: string[]
): Promise<void> {
  if (action === "list") {
    console.log(
      JSON.stringify(await fetchJson("/v1/skills/registry/profiles"), null, 2)
    );
    return;
  }
  if (action === "add") {
    const name = readOption(args, "--name");
    const registryUrl = readOption(args, "--url");
    if (!name) throw new Error("Missing registry profile name.");
    if (!registryUrl) throw new Error("Missing registry profile URL.");
    const requireSignature = readFlag(args, "--require-signature");
    const requireReleaseMetadata = readFlag(args, "--require-release-metadata");
    const publicKey = readOption(args, "--public-key");
    const trustedPublicKeys = parseTrustedPublicKeyOptions(
      readRepeatedOptions(args, "--trusted-public-key")
    );
    const revokedPublicKeyIds = readRepeatedOptions(args, "--revoked-public-key-id");
    const result = await postJson("/v1/skills/registry/profiles", {
      name,
      registryUrl,
      requireSignature,
      requireReleaseMetadata,
      ...(publicKey ? { publicKey } : {}),
      ...(trustedPublicKeys.length > 0 ? { trustedPublicKeys } : {}),
      ...(revokedPublicKeyIds.length > 0 ? { revokedPublicKeyIds } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "sync") {
    const profileId = args[0];
    if (!profileId) throw new Error("Missing registry profile id.");
    const dryRun = readFlag(args, "--dry-run") || !readFlag(args, "--yes");
    const result = await postJson(
      `/v1/skills/registry/profiles/${encodeURIComponent(profileId)}/sync`,
      { dryRun }
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "delete") {
    const profileId = args[0];
    if (!profileId) throw new Error("Missing registry profile id.");
    await deleteJson(`/v1/skills/registry/profiles/${encodeURIComponent(profileId)}`);
    console.log(`Deleted registry profile ${profileId}`);
    return;
  }
  throw new Error(`Unknown skill registry-profile command: ${action ?? ""}`);
}

async function listProviders(args: string[]): Promise<void> {
  const app = readEnumOption(args, "--app", allowedManagedApps, "app");
  const query = app ? `?app=${encodeURIComponent(app)}` : "";
  const result = await fetchJson(`/v1/providers${query}`);
  console.log(JSON.stringify(result, null, 2));
}

async function addProvider(args: string[]): Promise<void> {
  const presetId = readOption(args, "--preset");
  const app = readEnumOption(args, "--app", allowedProviderApps, "app");
  const name = readOption(args, "--name");
  const kind = readEnumOption(args, "--kind", allowedProviderKinds, "provider kind");
  const apiFormat = readEnumOption(args, "--api-format", allowedApiFormats, "api format");
  const baseUrl = readOption(args, "--base-url");
  const defaultModel = readOption(args, "--model");
  const wireApi = readEnumOption(args, "--wire-api", allowedWireApis, "wire api");
  const apiKey = readOption(args, "--api-key");
  const apiKeyEnv = readOption(args, "--api-key-env");
  const config = providerConfigFromCliOptions(args);

  const provider = await postJson("/v1/providers", {
    ...(presetId ? { presetId } : {}),
    ...(app ? { app } : {}),
    ...(name ? { name } : {}),
    ...(kind ? { kind } : {}),
    ...(apiFormat ? { apiFormat } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(wireApi ? { wireApi } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {})
  });
  console.log(JSON.stringify(provider, null, 2));
}

function providerConfigFromCliOptions(args: string[]): Record<string, unknown> {
  const replayToolCalls = readFlag(args, "--replay-tool-calls");
  const readonlyTools = parseToolNameOptions(readRepeatedOptions(args, "--tool-readonly"));
  const idempotentTools = parseToolNameOptions(readRepeatedOptions(args, "--tool-idempotent"));
  const sideEffectTools = parseToolNameOptions(readRepeatedOptions(args, "--tool-side-effect"));
  const config: Record<string, unknown> = {};
  if (replayToolCalls) config.replayToolCalls = true;
  const toolReplayPolicy = replayPolicyToolsFromCli({
    readonlyTools,
    idempotentTools,
    sideEffectTools
  });
  if (Object.keys(toolReplayPolicy).length > 0) {
    config.toolReplayPolicy = { tools: toolReplayPolicy };
  }
  return config;
}

function replayPolicyToolsFromCli(options: {
  readonlyTools: string[];
  idempotentTools: string[];
  sideEffectTools: string[];
}): Record<string, string> {
  const buckets = [
    { effect: "readonly", tools: options.readonlyTools },
    { effect: "idempotent", tools: options.idempotentTools },
    { effect: "side_effect", tools: options.sideEffectTools }
  ];
  const result: Record<string, string> = {};
  for (const bucket of buckets) {
    for (const tool of bucket.tools) {
      const previous = result[tool];
      if (previous && previous !== bucket.effect) {
        throw new Error(`${tool} cannot be both ${previous} and ${bucket.effect}.`);
      }
      result[tool] = bucket.effect;
    }
  }
  return result;
}

function parseToolNameOptions(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => value.split(/[,\s]+/))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

async function exportProviders(args: string[]): Promise<void> {
  const app = readEnumOption(args, "--app", allowedManagedApps, "app");
  const out = readOption(args, "--out");
  const query = app ? buildQuery({ app }) : "";
  const result = await fetchJson(`/v1/providers/export${query}`);
  if (out) {
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Exported providers to ${out}`);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function importProviders(args: string[]): Promise<void> {
  const file = readOption(args, "--file") ?? args[0];
  if (!file) throw new Error("Missing provider import file.");
  const dryRun = readFlag(args, "--dry-run") || !readFlag(args, "--yes");
  const input = JSON.parse(await readFile(file, "utf8")) as unknown;
  const body = Array.isArray(input)
    ? { providers: input, dryRun }
    : { ...(input as Record<string, unknown>), dryRun };
  const result = await postJson("/v1/providers/import", {
    ...body
  });
  console.log(JSON.stringify(result, null, 2));
}

async function syncProviderModelCatalog(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) throw new Error("Missing provider id.");
  const file = readOption(args, "--file");
  const sourceUrl = readOption(args, "--url");
  if (Boolean(file) === Boolean(sourceUrl)) {
    throw new Error("Exactly one of --file or --url is required.");
  }
  const mode =
    readEnumOption(
      args,
      "--mode",
      allowedProviderModelCatalogSyncModes,
      "model catalog sync mode"
    ) ?? "replace";
  const dryRun = readFlag(args, "--dry-run") || !readFlag(args, "--yes");
  const maxAgeDays = readPositiveIntOption(args, "--max-age-days");
  const savePolicy = readFlag(args, "--save-policy");
  const refreshIntervalHours = readPositiveIntOption(args, "--refresh-interval-hours");
  const catalog = file ? JSON.parse(await readFile(file, "utf8")) as unknown : undefined;
  const result = await postJson(`/v1/providers/${providerId}/model-catalog/sync`, {
    dryRun,
    mode,
    ...(maxAgeDays ? { maxAgeDays } : {}),
    ...(savePolicy ? { savePolicy } : {}),
    ...(refreshIntervalHours ? { refreshIntervalHours } : {}),
    ...(catalog ? { catalog } : {}),
    ...(sourceUrl ? { sourceUrl } : {})
  });
  console.log(JSON.stringify(result, null, 2));
}

async function auditProviderModelCatalog(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) throw new Error("Missing provider id.");
  const maxAgeDays = readPositiveIntOption(args, "--max-age-days");
  const query = maxAgeDays ? buildQuery({ maxAgeDays: String(maxAgeDays) }) : "";
  const result = await fetchJson(
    `/v1/providers/${encodeURIComponent(providerId)}/model-catalog/audit${query}`
  );
  console.log(JSON.stringify(result, null, 2));
}

async function syncDueProviderModelCatalogs(args: string[]): Promise<void> {
  const app = readEnumOption(args, "--app", allowedManagedApps, "app");
  const providerId = readOption(args, "--provider");
  const limit = readPositiveIntOption(args, "--limit");
  const dryRun = readFlag(args, "--dry-run") || !readFlag(args, "--yes");
  const result = await postJson("/v1/providers/model-catalog/sync-due", {
    dryRun,
    ...(app ? { app } : {}),
    ...(providerId ? { providerIds: [providerId] } : {}),
    ...(limit ? { limit } : {})
  });
  console.log(JSON.stringify(result, null, 2));
}

async function enableProvider(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) throw new Error("Missing provider id.");
  const app = readEnumOption(args, "--app", allowedManagedApps, "app");
  const homeDir = readOption(args, "--home");
  const mode = readEnumOption(args, "--mode", allowedCodexModes, "Codex mode");
  const dryRun = readFlag(args, "--dry-run");
  const result = await postJson(`/v1/providers/${providerId}/enable`, {
    ...(app ? { app } : {}),
    ...(homeDir ? { homeDir } : {}),
    ...(mode ? { mode } : {}),
    dryRun
  });
  console.log(JSON.stringify(result, null, 2));
}

async function restoreProvider(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) throw new Error("Missing provider id.");
  const app = readEnumOption(args, "--app", allowedManagedApps, "app");
  const dryRun = readFlag(args, "--dry-run") || !readFlag(args, "--yes");
  const result = await postJson(`/v1/providers/${providerId}/restore`, {
    ...(app ? { app } : {}),
    dryRun
  });
  console.log(JSON.stringify(result, null, 2));
}

async function deleteProvider(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) throw new Error("Missing provider id.");
  await deleteJson(`/v1/providers/${providerId}`);
  console.log(`Deleted provider ${providerId}`);
}

async function testProvider(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) throw new Error("Missing provider id.");
  const result = await postJson(`/v1/providers/${providerId}/test-endpoint`, {});
  console.log(JSON.stringify(result, null, 2));
}

async function standardsCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "validate") {
    const file = requireOption(args, "--file");
    await printOrWriteJson(
      await postJson("/v1/standard-packs/validate", await readYamlOrJson(file)),
      args
    );
    return;
  }
  if (subcommand === "import") {
    const file = requireOption(args, "--file");
    await printOrWriteJson(
      await postJson("/v1/standard-packs/import", {
        manifest: await readYamlOrJson(file),
        importedBy: readOption(args, "--actor") ?? "local-user"
      }),
      args
    );
    return;
  }
  if (subcommand === "diff") {
    await printOrWriteJson(
      await postJson("/v1/standard-packs/diff", {
        from: requireOption(args, "--from"),
        to: requireOption(args, "--to")
      }),
      args
    );
    return;
  }
  if (subcommand === "activate") {
    const rawRef = readFirstPositionalArg(
      args,
      new Set(["--scope", "--scope-id", "--project", "--actor", "--out"])
    );
    if (!rawRef) {
      throw new Error("Missing standard pack reference. Use <id>@<version>.");
    }
    const packRef = parseNamedVersionRef(rawRef, "standard pack");
    const scope = readEnumOption(
      args,
      "--scope",
      allowedGovernanceScopes,
      "governance scope"
    );
    if (!scope) throw new Error("--scope is required.");
    const config = await readConfig();
    const projectId = readOption(args, "--project") ?? config.projectId;
    const scopeId =
      readOption(args, "--scope-id") ??
      (scope === "project" ? projectId : undefined);
    if (!scopeId) throw new Error("--scope-id is required for the selected scope.");
    await printOrWriteJson(
      await postJson("/v1/standard-packs/activate", {
        id: packRef.id,
        version: packRef.version,
        scope,
        scopeId,
        ...(projectId ? { projectId } : {}),
        activatedBy: readOption(args, "--actor") ?? "local-user"
      }),
      args
    );
    return;
  }
  if (subcommand === "lock") {
    const config = await readConfig();
    const projectId = readOption(args, "--project") ?? config.projectId;
    if (!projectId) {
      throw new Error("No projectId. Run mn project register or pass --project.");
    }
    await printOrWriteJson(
      await fetchJson(
        `/v1/projects/${encodeURIComponent(projectId)}/standards-lock`
      ),
      args
    );
    return;
  }
  throw new Error(`Unknown standards command: ${subcommand ?? ""}`);
}

async function specCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand === "init") {
    const revision = createDraftSpecRevision(args);
    const outputPath =
      readOption(args, "--out") ??
      join("specs", revision.specSetId, "spec.yaml");
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, serializeNativeSpecYaml(revision));
    console.log(`Initialized Spec ${revision.specSetId}@${revision.revision} at ${outputPath}`);
    return;
  }
  if (subcommand === "validate") {
    const value = await readSpecCandidate(args);
    const validation = validateSpecRevision(value);
    await printOrWriteJson(validation, args);
    if (!validation.valid) {
      throw new Error("Spec validation failed.");
    }
    return;
  }
  if (subcommand === "import") {
    const revision = await readValidatedSpec(args);
    const now = revision.createdAt;
    const specSet: SpecSet = {
      id: revision.specSetId,
      title: revision.title,
      latestRevision: revision.revision,
      createdAt: now,
      updatedAt: now
    };
    await printOrWriteJson(
      await postJson("/v1/spec-sets", {
        specSet,
        initialRevision: revision
      }),
      args
    );
    return;
  }
  if (subcommand === "diff") {
    const beforeFile = requireOption(args, "--from");
    const afterFile = requireOption(args, "--to");
    const [before, after] = await Promise.all([
      readValidatedSpecFile(beforeFile),
      readValidatedSpecFile(afterFile)
    ]);
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(
        (field) => {
          const beforeRecord = before as unknown as Record<string, unknown>;
          const afterRecord = after as unknown as Record<string, unknown>;
          const beforeValue = Object.hasOwn(beforeRecord, field)
            ? { present: true, value: beforeRecord[field] }
            : { present: false };
          const afterValue = Object.hasOwn(afterRecord, field)
            ? { present: true, value: afterRecord[field] }
            : { present: false };
          return canonicalJson(beforeValue) !== canonicalJson(afterValue);
        }
      )
      .sort(compareStrings);
    await printOrWriteJson(
      {
        from: specReference(before),
        to: specReference(after),
        changed: fields.length > 0,
        changedFields: fields
      },
      args
    );
    return;
  }
  if (subcommand === "approve") {
    const rawRef = readFirstPositionalArg(args, new Set(["--by", "--at", "--out"]));
    if (!rawRef) throw new Error("Missing Spec reference. Use <id>@<revision>.");
    const ref = parseSpecRevisionRef(rawRef);
    const approvedBy = requireOption(args, "--by");
    await printOrWriteJson(
      await postJson(
        `/v1/spec-sets/${encodeURIComponent(ref.specSetId)}/revisions/${ref.revision}/approve`,
        {
          approvedBy,
          ...(readOption(args, "--at")
            ? { approvedAt: readOption(args, "--at") }
            : {})
        }
      ),
      args
    );
    return;
  }
  if (subcommand === "status") {
    const specSetId = readFirstPositionalArg(args, new Set(["--out"]));
    await printOrWriteJson(
      await fetchJson(
        specSetId
          ? `/v1/spec-sets/${encodeURIComponent(specSetId)}`
          : "/v1/spec-sets"
      ),
      args
    );
    return;
  }
  throw new Error(`Unknown spec command: ${subcommand ?? ""}`);
}

async function policyCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand !== "explain") {
    throw new Error(`Unknown policy command: ${subcommand ?? ""}`);
  }
  const config = await readConfig();
  const projectId = readOption(args, "--project") ?? config.projectId;
  if (!projectId) {
    throw new Error("No projectId. Run mn project register or pass --project.");
  }
  const query: Record<string, string> = {};
  addQueryOption(query, "organizationId", readOption(args, "--organization"));
  addQueryOption(query, "teamId", readOption(args, "--team"));
  addQueryOption(query, "serviceId", readOption(args, "--service"));
  addQueryOption(query, "taskId", readOption(args, "--task"));
  const spec = readOption(args, "--spec");
  if (spec) {
    const ref = parseSpecRevisionRef(spec);
    query.specSetId = ref.specSetId;
    query.specRevision = String(ref.revision);
  }
  addVersionedGovernanceQuery(query, "workflow", readOption(args, "--workflow"), readOption(args, "--workflow-digest"));
  addVersionedGovernanceQuery(
    query,
    "harnessProfile",
    readOption(args, "--harness-profile"),
    readOption(args, "--harness-profile-digest")
  );
  await printOrWriteJson(
    await fetchJson(
      `/v1/projects/${encodeURIComponent(projectId)}/policy/explain${buildQuery(query)}`
    ),
    args
  );
}

async function workflowCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  const document = await fetchJson<{ workflows: RuntimeCapabilityDescriptor[] }>(
    "/v1/workflows"
  );
  if (subcommand === "list") {
    await printOrWriteJson(document, args);
    return;
  }
  if (subcommand === "show") {
    const rawRef = readFirstPositionalArg(args, new Set(["--out"]));
    if (!rawRef) throw new Error("Missing workflow id.");
    const parsed = parseOptionalVersionRef(rawRef, "workflow");
    const candidates = document.workflows.filter(
      (item) =>
        item.id === parsed.id &&
        (parsed.version === undefined || item.version === parsed.version)
    );
    if (candidates.length === 0) {
      throw new Error(`Workflow not found: ${rawRef}.`);
    }
    await printOrWriteJson(
      candidates.length === 1 ? candidates[0] : { workflows: candidates },
      args
    );
    return;
  }
  throw new Error(`Unknown workflow command: ${subcommand ?? ""}`);
}

async function auditCommand(
  subcommand: string | undefined,
  args: string[]
): Promise<void> {
  if (subcommand !== "export") {
    throw new Error(`Unknown audit command: ${subcommand ?? ""}`);
  }
  const config = await readConfig();
  const projectId = readOption(args, "--project") ?? config.projectId;
  const query: Record<string, string> = {};
  addQueryOption(query, "projectId", projectId);
  addQueryOption(query, "after", readOption(args, "--after"));
  const limit = readPositiveIntOption(args, "--limit");
  if (limit !== undefined) query.limit = String(limit);
  await printOrWriteJson(
    await fetchJson(`/v1/audit-events${buildQuery(query)}`),
    args
  );
}

async function registerProject(args: string[]): Promise<void> {
  const root = readOption(args, "--root") ?? ".";
  const name = readOption(args, "--name") ?? rootName(root);
  const project = await postJson<{ id: string }>("/v1/projects", {
    name,
    rootPath: resolve(root),
    defaultBranch: "main"
  });
  const config = await readConfig();
  await writeConfig({ ...config, projectId: project.id });
  console.log(JSON.stringify(project, null, 2));
}

async function indexProject(): Promise<void> {
  const config = await readConfig();
  if (!config.projectId) throw new Error("No projectId. Run mn project register first.");
  const result = await postJson(`/v1/projects/${config.projectId}/index`, {});
  console.log(JSON.stringify(result, null, 2));
}

async function createTask(args: string[]): Promise<void> {
  const config = await readConfig();
  if (!config.projectId) throw new Error("No projectId. Run mn project register first.");
  const title = readOption(args, "--title") ?? "Untitled task";
  const service = readOption(args, "--service");
  const prompt = readOption(args, "--prompt") ?? title;
  const acceptance = readOption(args, "--acceptance");
  let strategy: Record<string, unknown>;
  let workflowRef: { id: string; version: string; digest?: string };
  let controlPlane: TaskControlPlane | undefined;
  let discoveryError: unknown;
  try {
    controlPlane = await loadTaskControlPlane(config.projectId);
  } catch (error) {
    discoveryError = error;
  }
  if (controlPlane) {
    strategy = deriveDynamicStrategy(args, controlPlane);
    workflowRef = capabilityReference(
      resolveRuntimeCapability(
        controlPlane.capabilities.workflows,
        readOption(args, "--workflow") ?? "classic-v1",
        "workflow"
      )
    );
  } else {
    if (!readFlag(args, "--classic-fallback")) {
      throw new Error(
        `Runtime capabilities or effective governance could not be resolved: ${errorDetail(discoveryError)}. ` +
          "Re-run with --classic-fallback only when intentionally targeting a legacy API."
      );
    }
    console.error(
      `Warning: using explicit classic-v1 fallback because runtime discovery failed: ${errorDetail(discoveryError)}`
    );
    strategy = classicFallbackStrategy(args);
    workflowRef = { id: "classic-v1", version: "1" };
  }
  const task = await postJson("/v1/tasks", {
    projectId: config.projectId,
    title,
    intent: "implement",
    targetServices: service ? [service] : [],
    prompt,
    acceptanceCriteria: acceptance ? [acceptance] : [],
    workflowRef,
    strategy
  });
  console.log(JSON.stringify(task, null, 2));
}

async function runTask(args: string[]): Promise<void> {
  if (readOption(args, "--spec")) {
    await runSpecTask(args);
    return;
  }
  const taskId = readOption(args, "--task") ?? args[0];
  if (!taskId) throw new Error("Missing task id. Use mn run --task <id>.");
  const priority = readIntOption(args, "--priority", -1_000, 1_000);
  const run = await postJson(`/v1/tasks/${taskId}/runs`, {
    queueOnly: readFlag(args, "--queue-only"),
    wait: readFlag(args, "--wait"),
    ...(priority !== undefined ? { queuePriority: priority } : {})
  });
  console.log(JSON.stringify(run, null, 2));
}

interface TaskControlPlane {
  capabilities: CapabilitiesResponse;
  governance: EffectiveGovernanceResponse;
}

async function loadTaskControlPlane(
  projectId: string,
  governanceQuery = ""
): Promise<TaskControlPlane> {
  const capabilities = await fetchJson<CapabilitiesResponse>("/v1/capabilities");
  validateCapabilitiesDocument(capabilities);
  const governance = await fetchJson<EffectiveGovernanceResponse>(
    `/v1/projects/${encodeURIComponent(projectId)}/effective-governance${governanceQuery}`
  );
  if (!governance.snapshot?.policy) {
    throw new TypeError("effective governance response does not contain snapshot.policy");
  }
  return { capabilities, governance };
}

function deriveDynamicStrategy(
  args: string[],
  controlPlane: TaskControlPlane
): Record<string, unknown> {
  const { capabilities, governance } = controlPlane;
  const policy = governance.snapshot.policy;
  const availableProviderIds = capabilities.providers
    .filter(
      (item) =>
        item.status === "available" &&
        (item.id === "claude" || item.id === "codex")
    )
    .map((item) => item.id as "claude" | "codex");
  const policyProviders = policy.allowedProviders ?? availableProviderIds;
  const requestedProviders = readStringListOption(args, "--providers");
  const providers = [
    ...new Set(
      (requestedProviders ?? policyProviders).filter(
        (provider): provider is "claude" | "codex" =>
          (provider === "claude" || provider === "codex") &&
          availableProviderIds.includes(provider) &&
          policyProviders.includes(provider)
      )
    )
  ].sort(compareStrings);
  if (
    requestedProviders?.some(
      (provider) => !providers.includes(provider as "claude" | "codex")
    )
  ) {
    throw new Error(
      `Requested providers are unavailable or denied: ${requestedProviders
        .filter((provider) => !providers.includes(provider as "claude" | "codex"))
        .join(", ")}.`
    );
  }
  if (providers.length === 0) {
    throw new Error("No available provider satisfies effective governance.");
  }

  const knownGateIds = new Set(capabilities.gates.map((item) => item.id));
  const requestedGates = readStringListOption(args, "--gates") ?? [];
  const unknownRequestedGates = requestedGates.filter(
    (gate) => !knownGateIds.has(gate)
  );
  if (unknownRequestedGates.length > 0) {
    throw new Error(
      `Unknown gate capability: ${unknownRequestedGates.join(", ")}.`
    );
  }
  const requiredGates = [
    ...new Set([...policy.requiredGates, ...requestedGates])
  ].sort(compareStrings);

  const candidateLimit = policy.budgets.maxCandidates;
  const requestedCandidates = readPositiveIntOption(args, "--candidates");
  if (
    requestedCandidates !== undefined &&
    candidateLimit !== undefined &&
    requestedCandidates > candidateLimit
  ) {
    throw new Error(
      `--candidates ${requestedCandidates} exceeds effective governance limit ${candidateLimit}.`
    );
  }
  const timeoutLimit = policy.budgets.maxDurationSeconds;
  const requestedTimeout = readPositiveIntOption(args, "--timeout");
  if (
    requestedTimeout !== undefined &&
    timeoutLimit !== undefined &&
    requestedTimeout > timeoutLimit
  ) {
    throw new Error(
      `--timeout ${requestedTimeout} exceeds effective governance limit ${timeoutLimit}.`
    );
  }
  const requestedApproval = readEnumOption(
    args,
    "--approval",
    allowedApprovalModes,
    "approval mode"
  );
  if (
    requestedApproval !== undefined &&
    approvalRank(requestedApproval) < approvalRank(policy.approvalMode)
  ) {
    throw new Error(
      `--approval ${requestedApproval} is weaker than effective governance ${policy.approvalMode}.`
    );
  }
  return {
    providers,
    ...((requestedCandidates ?? candidateLimit) === undefined
      ? {}
      : { candidates: requestedCandidates ?? candidateLimit }),
    sandbox: "isolated-worktree",
    humanApproval: requestedApproval ?? policy.approvalMode,
    requiredGates,
    ...((requestedTimeout ?? timeoutLimit) === undefined
      ? {}
      : { timeoutSeconds: requestedTimeout ?? timeoutLimit })
  };
}

function classicFallbackStrategy(args: string[]): Record<string, unknown> {
  return {
    providers:
      readEnumList(args, "--providers", allowedProviders, "provider") ?? [
        "claude",
        "codex"
      ],
    candidates: readPositiveIntOption(args, "--candidates") ?? 2,
    sandbox: "isolated-worktree",
    humanApproval:
      readEnumOption(args, "--approval", allowedApprovalModes, "approval mode") ??
      "on-risk",
    requiredGates:
      readEnumList(args, "--gates", allowedGates, "gate") ?? [
        "unit_test",
        "lint",
        "typecheck",
        "contract",
        "security",
        "llm_verifier"
      ],
    timeoutSeconds: readPositiveIntOption(args, "--timeout") ?? 3600
  };
}

async function runSpecTask(args: string[]): Promise<void> {
  const config = await readConfig();
  if (!config.projectId) {
    throw new Error("No projectId. Run mn project register first.");
  }
  const rawSpec = requireOption(args, "--spec");
  const specRefInput = parseSpecRevisionRef(rawSpec);
  const workflowInput = requireOption(args, "--workflow");
  const spec = await fetchJson<SpecRevision>(
    `/v1/spec-sets/${encodeURIComponent(specRefInput.specSetId)}/revisions/${specRefInput.revision}`
  );
  const validation = validateSpecRevision(spec);
  if (!validation.valid || spec.status !== "approved" || !spec.digest) {
    throw new Error(
      `mn run --spec requires an approved, valid Spec revision: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ") || `status is ${spec.status}`}`
    );
  }
  const governanceQuery = buildQuery({
    specSetId: spec.specSetId,
    specRevision: String(spec.revision)
  });
  const controlPlane = await loadTaskControlPlane(
    config.projectId,
    governanceQuery
  );
  const resolvedSpec = controlPlane.governance.snapshot.specRef;
  if (
    resolvedSpec &&
    (resolvedSpec.specSetId !== spec.specSetId ||
      resolvedSpec.revision !== spec.revision ||
      resolvedSpec.digest !== spec.digest)
  ) {
    throw new Error("Effective governance resolved a different Spec revision.");
  }
  const workflow = resolveRuntimeCapability(
    controlPlane.capabilities.workflows,
    workflowInput,
    "workflow"
  );
  const harnessInput = readOption(args, "--harness-profile");
  const harness = harnessInput
    ? resolveRuntimeCapability(
        controlPlane.capabilities.harnessProfiles,
        harnessInput,
        "harness profile"
      )
    : selectOnlyAvailableHarness(controlPlane.capabilities.harnessProfiles);
  if (!harness) {
    throw new Error(
      "No available harness profile. Pass --harness-profile after registering one."
    );
  }
  const acceptanceCriteria = [
    ...new Set(
      spec.acceptanceCases.flatMap((acceptance) => acceptance.then)
    )
  ];
  const task = await postJson<{ id: string }>("/v1/tasks", {
    projectId: config.projectId,
    title: readOption(args, "--title") ?? spec.title,
    intent: "implement",
    targetServices: spec.targetServices,
    prompt: readOption(args, "--prompt") ?? spec.hypothesis,
    acceptanceCriteria:
      acceptanceCriteria.length > 0 ? acceptanceCriteria : spec.outcomes,
    specRef: specReference(spec),
    workflowRef: capabilityReference(workflow),
    harnessProfileRef: capabilityReference(harness),
    strategy: deriveDynamicStrategy(args, controlPlane)
  });
  const priority = readIntOption(args, "--priority", -1_000, 1_000);
  const run = await postJson(`/v1/tasks/${encodeURIComponent(task.id)}/runs`, {
    queueOnly: readFlag(args, "--queue-only"),
    wait: readFlag(args, "--wait"),
    ...(priority !== undefined ? { queuePriority: priority } : {})
  });
  console.log(JSON.stringify(run, null, 2));
}

async function runWorker(args: string[]): Promise<void> {
  const enterprise = readFlag(args, "--enterprise");
  const useMockExecutors = readFlag(args, "--mock");
  const workerInstanceId = process.env.MN_WORKER_INSTANCE_ID?.trim();
  const ownerId =
    readOption(args, "--owner") ??
    (enterprise && workerInstanceId
      ? enterpriseWorkerInstanceOwner(workerSubjectFromApiToken(), workerInstanceId)
      : undefined) ??
    process.env.MN_WORKER_ID?.trim() ??
    (enterprise ? workerSubjectFromApiToken() : `mn-cli-worker-${process.pid}`);
  const ttlMs = readPositiveIntOption(args, "--ttl-ms") ?? 30_000;
  const pollMs = readPositiveIntOption(args, "--poll-ms") ?? 2_000;
  const capacity = readPositiveIntOption(args, "--capacity") ?? 1;
  const once = readFlag(args, "--once");
  const capabilities = enterprise
    ? enterpriseWorkerCapabilities(args)
    : undefined;
  const sandboxDriver = (
    readOption(args, "--sandbox-driver") ??
    process.env.MN_WORKER_SANDBOX_DRIVER?.trim() ??
    "docker"
  );
  if (sandboxDriver !== "docker" && sandboxDriver !== "kubernetes") {
    throw new Error("--sandbox-driver must be docker or kubernetes.");
  }

  if (enterprise) {
    if (!process.env.MN_API_TOKEN?.trim()) {
      throw new Error("Enterprise worker requires a machine JWT in MN_API_TOKEN.");
    }
    if (!useMockExecutors && capabilities?.providers.some((provider) => provider !== "builtin")) {
      throw new Error(
        "Enterprise Claude/Codex compatibility execution is unavailable in the " +
        "network-denied candidate runtime. Use the builtin provider broker, or --mock " +
        "only for the deterministic acceptance fixture."
      );
    }
    await postJson("/v1/run-jobs/workers/heartbeat", {
      ownerId,
      status: "idle",
      capacity,
      ttlMs,
      capabilities
    });
  }

  do {
    const claimed = await postJson<RunJobClaimResponse>("/v1/run-jobs/queue/claim", {
      ownerId,
      capacity,
      ttlMs,
      ...(capabilities ? { capabilities } : {})
    });
    if (!claimed.item || !claimed.claimToken) {
      if (once) {
        console.log("No claimable run jobs.");
        return;
      }
      await sleep(pollMs);
      continue;
    }

    const requestedSandboxImage =
      readOption(args, "--sandbox-image") ??
      process.env.MN_ENTERPRISE_SANDBOX_IMAGE?.trim();
    const approvedSandboxImage = claimed.sandboxAttestation?.policy.runtimeImage?.reference;
    if (enterprise && !approvedSandboxImage) {
      throw new Error(
        "Enterprise claim has no API-approved content-addressed sandbox image."
      );
    }
    if (
      enterprise &&
      requestedSandboxImage &&
      requestedSandboxImage !== approvedSandboxImage
    ) {
      throw new Error(
        "--sandbox-image is only an assertion and does not match the API-approved image."
      );
    }

    try {
      await runClaimedJob(claimed.item, {
        ownerId,
        claimToken: claimed.claimToken,
        ttlMs,
        capacity,
        useMockExecutors,
        mockRepair: readFlag(args, "--mock-repair"),
        enterprise,
        claimPayload: claimed.payload,
        sandboxAttestation: claimed.sandboxAttestation,
        sandboxImage: approvedSandboxImage ?? requestedSandboxImage ?? "node:22-alpine",
        dockerBinary:
          readOption(args, "--docker-binary") ??
          process.env.MN_DOCKER_BINARY,
        sandboxDriver,
        kubernetesNamespace:
          readOption(args, "--kubernetes-namespace") ??
          process.env.MN_KUBERNETES_NAMESPACE,
        kubernetesSharedVolumeClaim:
          readOption(args, "--kubernetes-shared-volume-claim") ??
          process.env.MN_KUBERNETES_SHARED_VOLUME_CLAIM,
        kubernetesSharedWorkspaceRoot:
          readOption(args, "--kubernetes-shared-root") ??
          process.env.MN_KUBERNETES_SHARED_ROOT,
        kubernetesCandidateServiceAccount:
          readOption(args, "--kubernetes-candidate-service-account") ??
          process.env.MN_KUBERNETES_CANDIDATE_SERVICE_ACCOUNT,
        kubernetesRuntimeClass:
          readOption(args, "--kubernetes-runtime-class") ??
          process.env.MN_KUBERNETES_RUNTIME_CLASS,
        workspaceRoot:
          readOption(args, "--workspace-root") ?? join(process.cwd(), ".mn", "worktrees"),
        proxyBaseUrl: readOption(args, "--proxy-base-url") ?? claimed.proxyBaseUrl
      });
    } catch (error) {
      if (once) throw error;
      const cause = nestedErrorCauseSummary(error);
      console.error(
        `[mn worker retry] ${errorDetail(error)}${cause ? ` <- ${cause}` : ""}`
      );
      await sleep(pollMs);
      continue;
    }

    if (once) return;
  } while (true);
}

function enterpriseWorkerInstanceOwner(actorId: string, instanceId: string): string {
  if (
    instanceId.length < 1 ||
    instanceId.length > 253 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(instanceId)
  ) {
    throw new Error("MN_WORKER_INSTANCE_ID must be a printable instance name.");
  }
  const ownerId = `${actorId}@${instanceId}`;
  if (ownerId.length > 256) {
    throw new Error("Enterprise worker principal and instance identity is too long.");
  }
  return ownerId;
}

function workerSubjectFromApiToken(): string {
  const token = process.env.MN_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Enterprise worker requires --owner or a machine JWT in MN_API_TOKEN."
    );
  }
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as { sub?: unknown };
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.sub !== payload.sub.trim()
    ) {
      throw new Error("JWT sub is missing");
    }
    return payload.sub;
  } catch (error) {
    throw new Error(
      "Cannot infer enterprise worker owner from MN_API_TOKEN; pass --owner explicitly.",
      { cause: error }
    );
  }
}

function repeatedStringOptions(
  args: readonly string[],
  option: string,
  environmentName: string,
  defaults: readonly string[]
): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== option) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    values.push(...value.split(","));
    index += 1;
  }
  if (values.length === 0 && process.env[environmentName]?.trim()) {
    values.push(...process.env[environmentName]!.split(","));
  }
  if (values.length === 0) values.push(...defaults);
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (
    normalized.some(
      (value) =>
        value.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/+:-]*$/u.test(value)
    )
  ) {
    throw new Error(`${option} contains an unsafe capability identifier.`);
  }
  return [...new Set(normalized)].sort();
}

function enterpriseWorkerCapabilities(args: readonly string[]): WorkerCapabilities {
  const providers = repeatedStringOptions(
    args,
    "--provider",
    "MN_WORKER_PROVIDERS",
    ["builtin"]
  );
  if (providers.some((provider) => provider !== "builtin" && provider !== "claude" && provider !== "codex")) {
    throw new Error("Enterprise worker providers must be builtin, claude or codex.");
  }
  const backendId =
    readOption([...args], "--sandbox-backend") ??
    process.env.MN_WORKER_SANDBOX_BACKEND?.trim() ??
    "enterprise-container";
  return {
    providers: providers as WorkerRuntimeId[],
    languages: repeatedStringOptions(
      args,
      "--language",
      "MN_WORKER_LANGUAGES",
      ["javascript", "typescript"]
    ),
    gateRunnerIds: repeatedStringOptions(
      args,
      "--gate-runner",
      "MN_WORKER_GATE_RUNNERS",
      enterpriseGateRunnerIds
    ),
    sandboxBackends: [
      {
        backendId,
        enforcement: "enforced",
        capabilities: repeatedStringOptions(
          args,
          "--sandbox-capability",
          "MN_WORKER_SANDBOX_CAPABILITIES",
          enterpriseSandboxCapabilities
        )
      }
    ],
    tenantIds: [],
    tools: repeatedStringOptions(
      args,
      "--tool",
      "MN_WORKER_TOOLS",
      ["node", "npm"]
    )
  };
}

async function listRunWorkers(args: string[]): Promise<void> {
  const state = readEnumOption(
    args,
    "--state",
    allowedRunJobWorkerStates,
    "worker state"
  );
  const ownerId = readOption(args, "--owner");
  const query = buildQuery({
    ...(state ? { state } : {}),
    ...(ownerId ? { ownerId } : {})
  });
  const result = await fetchJson<RunJobWorkerListResponse>(
    `/v1/run-jobs/workers${query}`
  );
  console.log(JSON.stringify(result, null, 2));
}

interface ClaimedJobOptions {
  ownerId: string;
  claimToken: string;
  ttlMs: number;
  capacity: number;
  useMockExecutors: boolean;
  mockRepair: boolean;
  enterprise: boolean;
  claimPayload?: EnterpriseRunJobPayload;
  sandboxAttestation?: SandboxLeaseAttestation;
  sandboxImage: string;
  dockerBinary?: string;
  sandboxDriver: "docker" | "kubernetes";
  kubernetesNamespace?: string;
  kubernetesSharedVolumeClaim?: string;
  kubernetesSharedWorkspaceRoot?: string;
  kubernetesCandidateServiceAccount?: string;
  kubernetesRuntimeClass?: string;
  workspaceRoot: string;
  proxyBaseUrl?: string;
}

async function runClaimedJob(
  item: RunJobQueueItem,
  options: ClaimedJobOptions
): Promise<void> {
  if (options.enterprise) {
    await runEnterpriseClaimedJob(item, options);
    return;
  }
  await mkdir(options.workspaceRoot, { recursive: true });
  const [project, task, run] = await Promise.all([
    fetchJson<Project>(`/v1/projects/${encodeURIComponent(item.projectId)}`),
    fetchJson<AgentTask>(`/v1/tasks/${encodeURIComponent(item.taskId)}`),
    fetchJson<RunRecord>(`/v1/runs/${encodeURIComponent(item.runId)}`)
  ]);
  const abortController = new AbortController();
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    void postJson(`/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/heartbeat`, {
      ownerId: options.ownerId,
      claimToken: options.claimToken,
      capacity: options.capacity,
      ttlMs: options.ttlMs
    }).catch((error) => {
      heartbeatError = error;
      abortController.abort();
    });
  }, Math.max(1_000, Math.floor(options.ttlMs / 2)));
  heartbeat.unref?.();

  let updateChain = Promise.resolve();
  const enqueueWorkerPost = (path: string, body: unknown): void => {
    updateChain = updateChain.then(async () => {
      await postJson(path, body);
    });
  };

  try {
    const orchestrator = new RunOrchestrator({
      workspaceRoot: options.workspaceRoot,
      executors: options.useMockExecutors
        ? {
            claude: new MockExecutor("claude"),
            codex: new MockExecutor("codex")
          }
        : createDefaultExecutors(),
      proxyBaseUrl: options.proxyBaseUrl,
      onEvent: (event: RunEvent) => {
        enqueueWorkerPost(
          `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/events`,
          {
            ownerId: options.ownerId,
            claimToken: options.claimToken,
            capacity: options.capacity,
            ttlMs: options.ttlMs,
            event: cloneJson(event)
          }
        );
      },
      onUpdate: (record: RunRecord) => {
        enqueueWorkerPost(
          `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/update`,
          {
            ownerId: options.ownerId,
            claimToken: options.claimToken,
            capacity: options.capacity,
            ttlMs: options.ttlMs,
            run: cloneJson(record)
          }
        );
      }
    });
    const finalRun = await orchestrator.run(project, task, {
      runId: item.runId,
      resumeFrom: run,
      abortSignal: abortController.signal
    });
    await updateChain;
    if (heartbeatError) throw heartbeatError;
    const result = await postJson(
      `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/finish`,
      {
        ownerId: options.ownerId,
        claimToken: options.claimToken,
        capacity: options.capacity,
        ttlMs: options.ttlMs,
        run: cloneJson(finalRun)
      }
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    abortController.abort();
    await updateChain.catch(() => undefined);
    const cause = nestedErrorCauseSummary(error);
    if (cause) console.error(`[mn enterprise worker cause] ${cause}`);
    await postJson(`/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/release`, {
      ownerId: options.ownerId,
      claimToken: options.claimToken,
      capacity: options.capacity,
      ttlMs: options.ttlMs
    }).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function runEnterpriseClaimedJob(
  item: RunJobQueueItem,
  options: ClaimedJobOptions
): Promise<void> {
  const {
    project,
    task,
    run,
    specRevision,
    sourceSnapshot,
    resumeFrom,
    approvalDecision
  } =
    validateEnterpriseClaimPayload(item, options);
  const attestation = options.sandboxAttestation!;
  const abortController = new AbortController();
  let heartbeatError: unknown;
  let budgetStop: EnterpriseWorkerBudgetStop | undefined;
  const claimBody = {
    ownerId: options.ownerId,
    claimToken: options.claimToken,
    capacity: options.capacity,
    ttlMs: options.ttlMs
  };
  const heartbeat = setInterval(() => {
    void postJson<EnterpriseWorkerHeartbeatResponse>(
      `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/heartbeat`,
      claimBody
    )
      .then((response) => {
        if (!response.stop) return;
        budgetStop = response.stop;
        clearInterval(heartbeat);
        abortController.abort("budget_exhausted");
      })
      .catch((error) => {
        heartbeatError = error;
        abortController.abort(error);
      });
  }, Math.min(5_000, Math.max(1_000, Math.floor(options.ttlMs / 3))));
  heartbeat.unref?.();

  let backend: DockerEnforcedSandboxBackend | KubernetesSandboxPodBackend | undefined;
  let leaseId: string | undefined;
  let updateChain = Promise.resolve();
  try {
    const runtimeProofAuthority = async ({
      attestation: issued,
      runtimeId
    }: {
      attestation: SandboxLeaseAttestation;
      runtimeId: string;
    }): Promise<SandboxRuntimeProof> => {
      const response = await postJson<{
        sandboxExecution: SandboxExecutionEvidence;
        runtimeProof: SandboxRuntimeProof;
      }>(
        `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/sandbox-runtime-proof`,
        { ...claimBody, attestation: issued, runtimeId }
      );
      if (response.sandboxExecution.runtimeProof.digest !== response.runtimeProof.digest) {
        throw new Error("Sandbox authority returned inconsistent runtime proof envelopes.");
      }
      return response.runtimeProof;
    };
    if (options.sandboxDriver === "kubernetes") {
      if (!sourceSnapshot) {
        throw new Error("Kubernetes enterprise claim has no content-addressed source snapshot.");
      }
      const snapshotContent = await postBytes(
        `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/source-snapshot`,
        claimBody,
        sourceSnapshot
      );
      backend = new KubernetesSandboxPodBackend({
        image: options.sandboxImage,
        attestation,
        expected: {
          runId: run.id,
          tenantId: attestation.tenantId,
          workerId: options.ownerId,
          harnessDigest: run.harnessManifest!.digest
        },
        sourceSnapshot: { ...sourceSnapshot, content: snapshotContent },
        namespace: requireWorkerSetting(
          options.kubernetesNamespace,
          "MN_KUBERNETES_NAMESPACE"
        ),
        sharedVolumeClaimName: requireWorkerSetting(
          options.kubernetesSharedVolumeClaim,
          "MN_KUBERNETES_SHARED_VOLUME_CLAIM"
        ),
        sharedWorkspaceRoot: requireWorkerSetting(
          options.kubernetesSharedWorkspaceRoot,
          "MN_KUBERNETES_SHARED_ROOT"
        ),
        serviceAccountName: requireWorkerSetting(
          options.kubernetesCandidateServiceAccount,
          "MN_KUBERNETES_CANDIDATE_SERVICE_ACCOUNT"
        ),
        runtimeClassName: requireWorkerSetting(
          options.kubernetesRuntimeClass,
          "MN_KUBERNETES_RUNTIME_CLASS"
        ),
        runtimeProofAuthority
      });
    } else {
      backend = new DockerEnforcedSandboxBackend({
        image: options.sandboxImage,
        attestation,
        expected: {
          runId: run.id,
          tenantId: attestation.tenantId,
          workerId: options.ownerId,
          harnessDigest: run.harnessManifest!.digest
        },
        ...(options.dockerBinary ? { dockerBinary: options.dockerBinary } : {}),
        runtimeProofAuthority
      });
    }
    const prepared = await backend.prepare({
      projectRoot: project.rootPath,
      taskId: task.id,
      commandAllowlist: run.harnessManifest!.executionPolicy.commandAllowlist ?? [],
      networkAllowlist: []
    });
    if (!prepared.leaseId) {
      throw new Error("Enforced Docker backend did not return a sandbox lease id.");
    }
    leaseId = prepared.leaseId;
    const builtinBackend = backend;
    const builtinLeaseId = leaseId;
    const sandboxExecution = backend.executionEvidence(leaseId);
    const sandboxWorkspaceRoot = backend.workspaceRoot(leaseId);
    const sandboxProject = projectAtSnapshot(project, backend.sourceRoot(leaseId));
    const history: NonNullable<RunRecord["sandboxEvidenceHistory"]> =
      cloneJson(run.sandboxEvidenceHistory ?? []);
    let checkpointState: GovernedRunState | undefined;
    let latestRun: RunRecord | undefined;

    const enqueueWorkerPost = (path: string, body: unknown): void => {
      updateChain = updateChain.then(async () => {
        await postJson(path, body);
      });
    };
    const artifactPublisher = async (request: {
      runId: string;
      candidateId: string;
      gateId: string;
      gateResultId: string;
      artifact: Omit<GateArtifactV2, "handle" | "path">;
      content: Uint8Array;
    }): Promise<GateArtifactV2> => {
      const response = await postJson<{ artifact: GateArtifactV2 }>(
        `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/artifacts`,
        {
          ...claimBody,
          candidateId: request.candidateId,
          gateResultId: request.gateResultId,
          gateId: request.gateId,
          artifact: {
            ...request.artifact,
            contentBase64: Buffer.from(request.content).toString("base64")
          }
        }
      );
      return response.artifact;
    };
    const measureBudgetDelta: LoopBudgetMeasurer = async (request) => {
      // A stage's running checkpoint must become durable before the API can
      // issue a measurement bound to that exact attempt.
      await updateChain;
      const response = await postJson<{
        measurement: Awaited<ReturnType<LoopBudgetMeasurer>>;
      }>(`/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/measurements`, {
        ...claimBody,
        stageAttemptId: request.stageAttemptId,
        stage: request.stage,
        attempt: request.attempt,
        resultStatus: request.resultStatus,
        ...(request.workspaceUri && request.candidateId
          ? {
              workspaceUri: request.workspaceUri,
              candidateId: request.candidateId
            }
          : {})
      });
      return response.measurement;
    };
    const sandboxExecutors = {
      builtin: new BuiltinAgentExecutor({
        run: (input) => runRemoteEnterpriseBuiltinAgentCandidate({
          runId: item.runId,
          ownerId: options.ownerId,
          claimToken: options.claimToken,
          backend: builtinBackend,
          leaseId: builtinLeaseId,
          attestation,
          sandboxExecution,
          input,
          transport: { post: (path, body) => postJson(path, body) }
        })
      }),
      claude: new DockerSandboxAgentExecutor({
        provider: "claude",
        backend,
        leaseId,
        mock: options.useMockExecutors,
        mockRepair: options.mockRepair
      }),
      codex: new DockerSandboxAgentExecutor({
        provider: "codex",
        backend,
        leaseId,
        mock: options.useMockExecutors,
        mockRepair: options.mockRepair
      })
    };
    const baseRun: RunRecord = {
      ...run,
      sandboxAttestation: attestation,
      sandboxExecution,
      sandboxEvidenceHistory: history
    };
    const orchestrator = new GovernedRunOrchestrator({
      workspaceRoot: sandboxWorkspaceRoot,
      candidateWorkspacePreparer: prepareSnapshotCandidateWorkspace,
      executors: sandboxExecutors,
      gateCommandExecutor: backend.gateCommandExecutor(leaseId),
      requireEnforcedGateExecutor: true,
      artifactPublisher,
      measureBudgetDelta,
      measurementWorkspaceUri: ({ workspacePath }) =>
        sandboxWorkspaceUri(leaseId!, sandboxWorkspaceRoot, workspacePath),
      ...(options.proxyBaseUrl
        ? {
            proxyBaseUrl: options.proxyBaseUrl,
            resolveProxyAssociationReceipt: async (request: {
              candidateId: string;
              provider: AgentProvider;
            }) => {
              const issued = await postJson<{ receipt: string }>(
                `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/usage-receipts`,
                {
                  ...claimBody,
                  candidateId: request.candidateId,
                  app: request.provider
                }
              );
              if (!issued.receipt) {
                throw new Error("Provider usage receipt authority returned no receipt.");
              }
              return issued.receipt;
            }
          }
        : {}),
      resolveSpecRevision: async (ref) =>
        ref.specSetId === specRevision.specSetId &&
        ref.revision === specRevision.revision &&
        ref.digest === specRevision.digest
          ? specRevision
          : undefined,
      onLoopCheckpoint: (state) => {
        checkpointState = cloneJson(state);
      },
      onEvent: (event: RunEvent) => {
        enqueueWorkerPost(
          `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/events`,
          { ...claimBody, event: cloneJson(event) }
        );
      },
      onUpdate: (record) => {
        if (!checkpointState) return;
        latestRun = externalizeEnterpriseRun({
          record,
          state: checkpointState,
          attestation,
          execution: sandboxExecution,
          history,
          sandboxWorkspaceRoot
        });
        if (!terminalGovernedState(checkpointState.status)) {
          enqueueWorkerPost(
            `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/update`,
            {
              ...claimBody,
              run: cloneJson(latestRun),
              governedLoopState: cloneJson(checkpointState)
            }
          );
        }
      }
    });
    const completed = await orchestrator.run(sandboxProject, task, baseRun, {
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(approvalDecision ? { approvalDecision } : {}),
      abortSignal: abortController.signal
    });
    await updateChain;
    if (heartbeatError) throw heartbeatError;
    if (
      budgetStop &&
      !(
        completed.state.status === "failed" &&
        completed.state.failure?.kind === "budget_exhausted"
      )
    ) {
      throw new Error(
        `API stopped the claim for ${budgetStop.dimension} budget exhaustion, ` +
        "but the governed Loop did not persist a budget_exhausted terminal state."
      );
    }
    latestRun ??= externalizeEnterpriseRun({
      record: completed.run,
      state: completed.state,
      attestation,
      execution: sandboxExecution,
      history,
      sandboxWorkspaceRoot
    });
    if (completed.state.status === "waiting_approval") {
      // The waiting checkpoint is already durable because every queued update
      // completed above. Release only after that boundary so approval can
      // atomically enqueue the same immutable resume payload immediately,
      // without waiting for the active claim TTL to expire.
      clearInterval(heartbeat);
      const released = await postJson(
        `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/release`,
        claimBody
      );
      console.log(
        JSON.stringify(
          {
            run: latestRun,
            governedLoopState: completed.state,
            disposition: "waiting_approval",
            release: released
          },
          null,
          2
        )
      );
      return;
    }
    const result = await postJson(
      `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/finish`,
      {
        ...claimBody,
        run: cloneJson(latestRun),
        governedLoopState: cloneJson(completed.state)
      }
    );
    console.log(
      JSON.stringify(
        { ...(result as Record<string, unknown>), governedLoopState: completed.state },
        null,
        2
      )
    );
  } catch (error) {
    abortController.abort();
    await updateChain.catch(() => undefined);
    // A server budget stop intentionally does not renew the lease. Releasing
    // it would make an over-budget job claimable again. Normal transport or
    // execution failures retain the classic release/retry behavior.
    if (!budgetStop) {
      await postJson(
        `/v1/run-jobs/queue/${encodeURIComponent(item.runId)}/release`,
        claimBody
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (backend && leaseId) await backend.release(leaseId).catch(() => undefined);
  }
}

function nestedErrorCauseSummary(error: unknown): string | undefined {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current instanceof Error &&
    current.cause !== undefined &&
    !seen.has(current.cause) &&
    messages.length < 4
  ) {
    seen.add(current.cause);
    current = current.cause;
    if (current instanceof Error) messages.push(current.message);
  }
  if (messages.length === 0) return undefined;
  return messages
    .join(" <- ")
    .replace(/[\0\r\n]+/gu, " ")
    .slice(0, 4_000);
}

function validateEnterpriseClaimPayload(
  item: RunJobQueueItem,
  options: ClaimedJobOptions
): {
  project: Project;
  task: AgentTask;
  run: RunRecord;
  specRevision: SpecRevision;
  sourceSnapshot?: EnterpriseSourceSnapshotRef;
  resumeFrom?: GovernedRunState;
  approvalDecision?: ApprovalDecision;
} {
  const payload = options.claimPayload;
  const context = payload?.executionContext;
  const run = payload?.run;
  const attestation = options.sandboxAttestation;
  if (item.version !== 2 || !item.requirements) {
    throw new Error("Enterprise worker requires a capability-bound v2 queue item.");
  }
  if (
    !payload ||
    (payload.version !== 1 && payload.version !== 2) ||
    !context ||
    !run ||
    !attestation
  ) {
    throw new Error(
      "Enterprise claim is missing its execution context, Run payload, or sandbox attestation."
    );
  }
  const { digest, ...semantic } = context;
  const computedDigest = createHash("sha256")
    .update(canonicalJson(semantic))
    .digest("hex");
  if (digest !== computedDigest) {
    throw new Error("Enterprise execution context digest is invalid.");
  }
  const specValidation = validateSpecRevision(context.specRevision);
  if (!specValidation.valid || context.specRevision.status !== "approved") {
    throw new Error("Enterprise execution context does not contain an approved Spec revision.");
  }
  const bindings = context.bindings;
  const ref = context.task.specRef;
  if (
    (context.schemaVersion !== 1 && context.schemaVersion !== 2) ||
    (payload.version === 2 && context.schemaVersion !== 2) ||
    bindings.runId !== item.runId ||
    bindings.projectId !== item.projectId ||
    bindings.taskId !== item.taskId ||
    run.id !== item.runId ||
    run.projectId !== context.project.id ||
    run.taskId !== context.task.id ||
    !ref ||
    ref.specSetId !== context.specRevision.specSetId ||
    ref.revision !== context.specRevision.revision ||
    ref.digest !== context.specRevision.digest ||
    bindings.specRef.specSetId !== ref.specSetId ||
    bindings.specRef.revision !== ref.revision ||
    bindings.specRef.digest !== ref.digest ||
    run.governanceSnapshot?.digest !== bindings.governanceDigest ||
    run.harnessManifest?.digest !== bindings.harnessDigest ||
    run.harnessManifest.specRef.digest !== ref.digest ||
    attestation.runId !== run.id ||
    attestation.workerId !== options.ownerId ||
    attestation.tenantId !== bindings.tenantId ||
    attestation.harnessDigest !== bindings.harnessDigest
  ) {
    throw new Error("Enterprise claim execution bindings are inconsistent.");
  }
  if (context.schemaVersion === 2) validateSourceSnapshotRef(context.sourceSnapshot);
  if (options.sandboxDriver === "kubernetes" && context.schemaVersion !== 2) {
    throw new Error("Kubernetes enterprise execution requires a v2 source snapshot context.");
  }
  return {
    project: cloneJson(context.project),
    task: cloneJson(context.task),
    run: cloneJson(run),
    specRevision: cloneJson(context.specRevision),
    ...(context.sourceSnapshot
      ? { sourceSnapshot: cloneJson(context.sourceSnapshot) }
      : {}),
    ...(payload.governedResumeState
      ? { resumeFrom: cloneJson(payload.governedResumeState) }
      : {}),
    ...(payload.approvalDecision
      ? { approvalDecision: cloneJson(payload.approvalDecision) }
      : {})
  };
}

function validateSourceSnapshotRef(
  value: EnterpriseSourceSnapshotRef | undefined
): asserts value is EnterpriseSourceSnapshotRef {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.objectKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    value.byteLength > 256 * 1024 * 1024 ||
    value.contentType !== "application/vnd.muniu.workspace-snapshot.v1+json"
  ) {
    throw new Error("Enterprise execution context source snapshot reference is invalid.");
  }
}

function requireWorkerSetting(value: string | undefined, environmentName: string): string {
  if (!value?.trim() || value !== value.trim() || /[\0\r\n]/u.test(value)) {
    throw new Error(`Kubernetes sandbox requires ${environmentName}.`);
  }
  return value;
}

function terminalGovernedState(status: GovernedRunState["status"]): boolean {
  return ["completed", "failed", "needs_human", "cancelled"].includes(status);
}

function externalizeEnterpriseRun(input: {
  record: RunRecord;
  state: GovernedRunState;
  attestation: SandboxLeaseAttestation;
  execution: SandboxExecutionEvidence;
  history: NonNullable<RunRecord["sandboxEvidenceHistory"]>;
  sandboxWorkspaceRoot: string;
}): RunRecord {
  const record = cloneJson(input.record);
  const existingGateIds = new Set(
    input.history.flatMap((binding) => binding.gateResultIds)
  );
  const existingStageIds = new Set(
    input.history.flatMap((binding) => binding.stageAttemptIds)
  );
  const currentLeasePresent = input.history.some(
    (binding) =>
      binding.attestation.digest === input.attestation.digest &&
      binding.execution.runtimeProof.digest === input.execution.runtimeProof.digest
  );
  const newGateIds = (record.gateResultsV2 ?? [])
    .filter(
      (gate) =>
        gate.sandboxExecution?.runtimeProof.digest ===
          input.execution.runtimeProof.digest &&
        !existingGateIds.has(gate.id)
    )
    .map((gate) => gate.id);
  let newStageIds = input.state.attempts
    .map((attempt) => attempt.id)
    .filter((id) => !existingStageIds.has(id));
  if ((newGateIds.length > 0 || !currentLeasePresent) && newStageIds.length === 0) {
    const currentStageId = input.state.attempts.at(-1)?.id;
    if (!currentStageId) {
      throw new Error("Sandbox evidence cannot be bound before a Loop stage exists.");
    }
    newStageIds = [currentStageId];
  }
  if (newGateIds.length > 0 || newStageIds.length > 0 || !currentLeasePresent) {
    input.history.push({
      attestation: cloneJson(input.attestation),
      execution: cloneJson(input.execution),
      gateResultIds: [...newGateIds],
      stageAttemptIds: [...newStageIds]
    });
  }
  const candidates = record.candidates.map((candidate) => {
    const external = {
      ...candidate,
      worktreePath: sandboxWorkspaceUri(
        input.attestation.leaseId,
        input.sandboxWorkspaceRoot,
        candidate.worktreePath
      )
    };
    delete external.outputCheckpoint;
    return external;
  });
  const gateResultsV2 = (record.gateResultsV2 ?? []).map((gate) => {
    const external: typeof gate = {
      ...gate,
      workingDirectory: sandboxWorkspaceUri(
        gate.sandboxExecution?.leaseId ?? input.attestation.leaseId,
        input.sandboxWorkspaceRoot,
        gate.workingDirectory
      ),
      artifacts: gate.artifacts.map(({ path: _path, ...artifact }) => artifact)
    };
    return { ...external, outputDigest: gateResultV2OutputDigest(external) };
  });
  return {
    ...record,
    candidates,
    gateResultsV2,
    sandboxAttestation: cloneJson(input.attestation),
    sandboxExecution: cloneJson(input.execution),
    sandboxEvidenceHistory: cloneJson(input.history)
  };
}

function sandboxWorkspaceUri(
  leaseId: string,
  sandboxWorkspaceRoot: string,
  hostPath: string
): string {
  if (hostPath.startsWith("mn://sandbox/")) return hostPath;
  const workspaceRoot = resolve(sandboxWorkspaceRoot);
  const absolute = resolve(hostPath);
  const child = relative(workspaceRoot, absolute);
  if (child === ".." || child.startsWith(`..${sep}`) || child.startsWith("/")) {
    throw new Error("Worker attempted to report a path outside its sandbox scratch workspace.");
  }
  const suffix = (child || ".")
    .split(sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `mn://sandbox/${encodeURIComponent(leaseId)}/${suffix}`;
}

async function watchRun(runId?: string): Promise<void> {
  if (!runId) throw new Error("Missing run id.");
  const targetApiUrl = await resolveApiUrl();
  const response = await fetch(`${targetApiUrl}/v1/runs/${runId}/events/stream`, {
    headers: apiRequestHeaders()
  });
  if (!response.ok || !response.body) {
    const events = await fetchJson(`/v1/runs/${runId}/events`);
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        console.log(dataLine.slice("data: ".length));
      }
    }
  }
}

async function showRunArtifacts(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) throw new Error("Missing run id.");
  const query = runArtifactFilterQuery(args);
  const result = await fetchJson(`/v1/runs/${encodeURIComponent(runId)}/artifacts${query}`);
  console.log(JSON.stringify(result, null, 2));
}

async function downloadRunArtifact(args: string[]): Promise<void> {
  const runId = args[0];
  const artifactId = args[1];
  if (!runId || !artifactId) {
    throw new Error("Missing run id or artifact id.");
  }
  const targetApiUrl = await resolveApiUrl();
  const response = await fetch(
    `${targetApiUrl}/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { headers: apiRequestHeaders() }
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  const outputPath = readOption(args, "--out");
  if (outputPath) {
    await writeFile(outputPath, content);
    console.log(outputPath);
    return;
  }
  process.stdout.write(content);
}

async function downloadRunArtifactsArchive(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) throw new Error("Missing run id.");
  const targetApiUrl = await resolveApiUrl();
  const query = runArtifactFilterQuery(args);
  const response = await fetch(
    `${targetApiUrl}/v1/runs/${encodeURIComponent(runId)}/artifacts/archive${query}`,
    { headers: apiRequestHeaders() }
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  const outputPath = readOption(args, "--out");
  if (outputPath) {
    await writeFile(outputPath, content);
    console.log(outputPath);
    return;
  }
  process.stdout.write(content);
}

function runArtifactFilterQuery(args: string[]): string {
  const candidateId = readOption(args, "--candidate") ?? readOption(args, "--candidate-id");
  const provider = readEnumOption(args, "--provider", allowedProviders, "provider");
  const kind = readEnumOption(args, "--kind", allowedArtifactKinds, "artifact kind");
  const gate = readOption(args, "--gate");
  const source = readOption(args, "--source");
  const persisted = readBooleanStringOption(args, "--persisted");
  return buildQuery({
    ...(candidateId ? { candidateId } : {}),
    ...(provider ? { provider } : {}),
    ...(kind ? { kind } : {}),
    ...(gate ? { gate } : {}),
    ...(source ? { source } : {}),
    ...(persisted ? { persisted } : {})
  });
}

function readBooleanStringOption(args: string[], key: string): string | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return "true";
  if (["0", "false", "no"].includes(normalized)) return "false";
  throw new Error(`${key} must be true or false.`);
}

async function resumeRun(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) throw new Error("Missing run id.");
  const result = await postJson(`/v1/runs/${encodeURIComponent(runId)}/resume`, {});
  console.log(JSON.stringify(result, null, 2));
}

async function cleanupRunWorkspaces(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) throw new Error("Missing run id.");
  if (!readFlag(args, "--yes")) {
    throw new Error("Refusing to clean workspaces without --yes.");
  }
  const result = await postJson(
    `/v1/runs/${encodeURIComponent(runId)}/workspaces/cleanup`,
    {}
  );
  console.log(JSON.stringify(result, null, 2));
}

async function reportGates(runId?: string): Promise<void> {
  if (!runId) throw new Error("Missing run id.");
  const run = await fetchJson<{ gates: unknown[] }>(`/v1/runs/${runId}`);
  console.log(JSON.stringify(run.gates, null, 2));
}

function createDraftSpecRevision(args: string[]): SpecRevision {
  const specSetId = requireOption(args, "--id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(specSetId)) {
    throw new Error(
      "--id must use letters, numbers, dot, underscore, or hyphen and cannot contain a path."
    );
  }
  const title = requireOption(args, "--title").trim();
  const hypothesis =
    readOption(args, "--hypothesis")?.trim() ||
    `Deliver the ${title} increment according to its acceptance cases.`;
  const outcomes = readRepeatedOptions(args, "--outcome");
  const effectiveOutcomes = outcomes.length > 0 ? outcomes : [hypothesis];
  const acceptance = readRepeatedOptions(args, "--acceptance");
  const acceptanceStatements =
    acceptance.length > 0 ? acceptance : effectiveOutcomes;
  const nonGoals = readRepeatedOptions(args, "--non-goal");
  const createdAt = new Date().toISOString();
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId,
    revision: 1,
    status: "draft",
    source: "native",
    title,
    hypothesis,
    outcomes: effectiveOutcomes,
    nonGoals:
      nonGoals.length > 0
        ? nonGoals
        : ["Do not infer scope beyond this Spec revision."],
    targetServices: readRepeatedOptions(args, "--service"),
    contracts: {
      interface: {},
      data: {},
      state: {},
      permission: {},
      exception: {},
      quality: {},
      observability: {}
    },
    acceptanceCases: acceptanceStatements.map((statement, index) => ({
      id: `acceptance-${index + 1}`,
      kind: "positive",
      title: statement,
      given: ["The approved Spec context is available."],
      when: "The increment is implemented.",
      then: [statement]
    })),
    risks: [],
    unknowns: [],
    createdAt,
    createdBy: readOption(args, "--actor") ?? "local-user"
  };
  const revision: SpecRevision = {
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  };
  const validation = validateSpecRevision(revision);
  if (!validation.valid) {
    throw new Error(
      `Cannot initialize Spec: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return revision;
}

async function readSpecCandidate(args: string[]): Promise<unknown> {
  if (readFlag(args, "--spec-kit")) {
    const directory =
      readOption(args, "--directory") ?? requireOption(args, "--file");
    return importSpecKitDirectory(directory, {
      ...(readOption(args, "--id")
        ? { specSetId: readOption(args, "--id") }
        : {}),
      ...(readOption(args, "--actor")
        ? { createdBy: readOption(args, "--actor") }
        : {})
    });
  }
  const document = await readYamlOrJson(requireOption(args, "--file"));
  if (isNativeSpecEnvelope(document)) return document.revision;
  return document;
}

async function readValidatedSpec(args: string[]): Promise<SpecRevision> {
  if (readFlag(args, "--spec-kit")) {
    const directory =
      readOption(args, "--directory") ?? requireOption(args, "--file");
    return importSpecKitDirectory(directory, {
      ...(readOption(args, "--id")
        ? { specSetId: readOption(args, "--id") }
        : {}),
      ...(readOption(args, "--actor")
        ? { createdBy: readOption(args, "--actor") }
        : {})
    });
  }
  return readValidatedSpecFile(requireOption(args, "--file"));
}

async function readValidatedSpecFile(file: string): Promise<SpecRevision> {
  const document = await readYamlOrJson(file);
  if (isNativeSpecEnvelope(document)) {
    return parseNativeSpecYaml(JSON.stringify(document));
  }
  const validation = validateSpecRevision(document);
  if (!validation.valid) {
    throw new Error(
      `Invalid Spec file ${file}: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return document as SpecRevision;
}

function isNativeSpecEnvelope(
  value: unknown
): value is { apiVersion: "mn.dev/spec/v1"; kind: "SpecRevision"; revision: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).apiVersion === "mn.dev/spec/v1" &&
    (value as Record<string, unknown>).kind === "SpecRevision" &&
    Object.hasOwn(value, "revision")
  );
}

async function readYamlOrJson(file: string): Promise<unknown> {
  let value: unknown;
  try {
    value = parseYaml(await readFile(file, "utf8"), {
      maxAliasCount: 0,
      uniqueKeys: true
    });
  } catch (error) {
    throw new Error(`Cannot parse YAML/JSON file ${file}: ${errorDetail(error)}`);
  }
  if (value === undefined || value === null) {
    throw new Error(`YAML/JSON file is empty: ${file}.`);
  }
  return value;
}

async function printOrWriteJson(value: unknown, args: string[]): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const output = readOption(args, "--out");
  if (!output) {
    process.stdout.write(content);
    return;
  }
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, content);
  console.log(`Wrote ${output}`);
}

function requireOption(args: string[], key: string): string {
  const value = readOption(args, key);
  if (!value || value.startsWith("--")) {
    throw new Error(`${key} requires a value.`);
  }
  return value;
}

function parseNamedVersionRef(
  value: string,
  label: string
): { id: string; version: string } {
  const parsed = parseOptionalVersionRef(value, label);
  if (!parsed.version) {
    throw new Error(`${label} reference must use <id>@<version>.`);
  }
  return { id: parsed.id, version: parsed.version };
}

function parseOptionalVersionRef(
  value: string,
  label: string
): { id: string; version?: string } {
  const separator = value.lastIndexOf("@");
  if (separator < 0) {
    if (value.trim().length === 0) throw new Error(`${label} id cannot be empty.`);
    return { id: value };
  }
  const id = value.slice(0, separator);
  const version = value.slice(separator + 1);
  if (!id || !version) {
    throw new Error(`${label} reference must use <id>@<version>.`);
  }
  return { id, version };
}

function parseSpecRevisionRef(value: string): {
  specSetId: string;
  revision: number;
} {
  const parsed = parseNamedVersionRef(value, "Spec");
  if (!/^[1-9]\d*$/u.test(parsed.version)) {
    throw new Error("Spec reference revision must be a positive integer.");
  }
  const revision = Number(parsed.version);
  if (!Number.isSafeInteger(revision)) {
    throw new Error("Spec revision exceeds the safe integer range.");
  }
  return { specSetId: parsed.id, revision };
}

function specReference(revision: SpecRevision): {
  specSetId: string;
  revision: number;
  digest: string;
} {
  return {
    specSetId: revision.specSetId,
    revision: revision.revision,
    digest: revision.digest ?? digestSpecRevision(revision)
  };
}

function addQueryOption(
  query: Record<string, string>,
  key: string,
  value: string | undefined
): void {
  if (value !== undefined) query[key] = value;
}

function addVersionedGovernanceQuery(
  query: Record<string, string>,
  prefix: "workflow" | "harnessProfile",
  rawRef: string | undefined,
  digest: string | undefined
): void {
  if (!rawRef && !digest) return;
  if (!rawRef || !digest || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(
      `--${prefix === "workflow" ? "workflow" : "harness-profile"} and a lowercase SHA-256 digest must be supplied together.`
    );
  }
  const ref = parseNamedVersionRef(rawRef, prefix);
  query[`${prefix}Id`] = ref.id;
  query[`${prefix}Version`] = ref.version;
  query[`${prefix}Digest`] = digest;
}

function validateCapabilitiesDocument(value: CapabilitiesResponse): void {
  if (
    !value ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.gates) ||
    !Array.isArray(value.workflows) ||
    !Array.isArray(value.harnessProfiles)
  ) {
    throw new TypeError("capabilities response is missing one or more registries");
  }
}

function resolveRuntimeCapability(
  capabilities: RuntimeCapabilityDescriptor[],
  rawRef: string,
  label: string
): RuntimeCapabilityDescriptor {
  const ref = parseOptionalVersionRef(rawRef, label);
  const matching = capabilities
    .filter(
      (item) =>
        item.id === ref.id &&
        (ref.version === undefined || item.version === ref.version)
    )
    .sort((left, right) => compareVersions(right.version, left.version));
  const available = matching.find((item) => item.status === "available");
  if (available) return available;
  const detail = matching[0]?.reason ?? matching[0]?.status ?? "not registered";
  throw new Error(`${label} ${rawRef} is not available: ${detail}.`);
}

function capabilityReference(capability: RuntimeCapabilityDescriptor): {
  id: string;
  version: string;
  digest?: string;
} {
  return {
    id: capability.id,
    version: capability.version,
    ...(capability.digest ? { digest: capability.digest } : {})
  };
}

function selectOnlyAvailableHarness(
  capabilities: RuntimeCapabilityDescriptor[]
): RuntimeCapabilityDescriptor | undefined {
  const available = capabilities
    .filter((item) => item.status === "available")
    .sort(
      (left, right) =>
        compareStrings(left.id, right.id) || compareVersions(left.version, right.version)
    );
  if (available.length > 1) {
    throw new Error(
      `Multiple harness profiles are available (${available
        .map((item) => `${item.id}@${item.version}`)
        .join(", ")}); pass --harness-profile explicitly.`
    );
  }
  return available[0];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.match(/\d+|\D+/gu) ?? [left];
  const rightParts = right.match(/\d+|\D+/gu) ?? [right];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const normalizedLeft = leftPart.replace(/^0+(?=\d)/u, "");
      const normalizedRight = rightPart.replace(/^0+(?=\d)/u, "");
      const lengthComparison = normalizedLeft.length - normalizedRight.length;
      if (lengthComparison !== 0) return lengthComparison;
      const numericComparison = compareStrings(normalizedLeft, normalizedRight);
      if (numericComparison !== 0) return numericComparison;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? 1 : -1;
    const comparison = compareStrings(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function approvalRank(value: "never" | "on-risk" | "before-merge"): number {
  return allowedApprovalModes.indexOf(value);
}

async function readConfig(): Promise<MnConfig> {
  try {
    const raw = await readFile(".mn/config.json", "utf8");
    return JSON.parse(raw) as MnConfig;
  } catch {
    return { apiUrl: defaultApiUrl };
  }
}

async function writeConfig(config: MnConfig): Promise<void> {
  await mkdir(".mn", { recursive: true });
  await writeFile(".mn/config.json", `${JSON.stringify(config, null, 2)}\n`);
}

async function fetchJson<T = unknown>(path: string): Promise<T> {
  const targetApiUrl = await resolveApiUrl();
  const response = await fetch(`${targetApiUrl}${path}`, {
    headers: apiRequestHeaders()
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const targetApiUrl = await resolveApiUrl();
  const response = await fetch(`${targetApiUrl}${path}`, {
    method: "POST",
    headers: apiRequestHeaders(true),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function postBytes(
  path: string,
  body: unknown,
  expected: EnterpriseSourceSnapshotRef
): Promise<Buffer> {
  validateSourceSnapshotRef(expected);
  const targetApiUrl = await resolveApiUrl();
  const response = await fetch(`${targetApiUrl}${path}`, {
    method: "POST",
    headers: apiRequestHeaders(true),
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const announcedLength = Number(response.headers.get("content-length"));
  if (
    response.headers.get("x-muniu-content-digest") !== expected.digest ||
    response.headers.get("content-type")?.split(";", 1)[0] !== expected.contentType ||
    announcedLength !== expected.byteLength
  ) {
    throw new Error("Source snapshot response headers do not match the queue binding.");
  }
  const content = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(content).digest("hex");
  if (content.byteLength !== expected.byteLength || digest !== expected.digest) {
    throw new Error("Source snapshot response bytes do not match the queue binding.");
  }
  return content;
}

async function deleteJson(path: string): Promise<void> {
  const targetApiUrl = await resolveApiUrl();
  const response = await fetch(`${targetApiUrl}${path}`, {
    method: "DELETE",
    headers: apiRequestHeaders()
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
}

function apiRequestHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["content-type"] = "application/json";

  const token = process.env.MN_API_TOKEN?.trim();
  if (!token) return headers;
  if (/\r|\n/.test(token)) {
    throw new Error("MN_API_TOKEN must not contain line breaks.");
  }
  if (/^Bearer\s/i.test(token)) {
    throw new Error("MN_API_TOKEN must contain the token only, without the Bearer prefix.");
  }
  headers.authorization = `Bearer ${token}`;
  return headers;
}

async function resolveApiUrl(): Promise<string> {
  if (process.env.MN_API_URL) return process.env.MN_API_URL;
  const config = await readConfig();
  return config.apiUrl || defaultApiUrl;
}

function readOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index < 0) return undefined;
  return args[index + 1];
}

function readFlag(args: string[], key: string): boolean {
  return args.includes(key);
}

function readFirstPositionalArg(
  args: string[],
  optionsWithValues = new Set<string>()
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return value;
  }
  return undefined;
}

function readPositiveIntOption(args: string[], key: string): number | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

function readIntOption(
  args: string[],
  key: string,
  min: number,
  max: number
): number | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readPositiveIntOrZeroOption(
  args: string[],
  key: string
): number | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
}

function readEnumOption<const T extends readonly string[]>(
  args: string[],
  key: string,
  allowed: T,
  label: string
): T[number] | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  if (!allowed.includes(raw)) {
    throw new Error(
      `Unknown ${label}: ${raw}. Allowed values: ${allowed.join(", ")}.`
    );
  }
  return raw;
}

function readEnumList<const T extends readonly string[]>(
  args: string[],
  key: string,
  allowed: T,
  label: string
): T[number][] | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${key} must include at least one ${label}.`);
  }

  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new Error(
        `Unknown ${label}: ${value}. Allowed values: ${allowed.join(", ")}.`
      );
    }
  }

  return values;
}

function readStringListOption(args: string[], key: string): string[] | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function readKeyValueRecordOption(
  args: string[],
  key: string
): Record<string, string> | undefined {
  const raw = readOption(args, key);
  if (!raw) return undefined;
  const entries = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        throw new Error(`${key} entries must use KEY=VALUE.`);
      }
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    })
  );
}

function buildQuery(values: Record<string, string>): string {
  const params = new URLSearchParams(values);
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function probeBinary(
  binary: string,
  args: string[]
): Promise<{ ok: boolean; binary: string; detail: string }> {
  try {
    const result = await execFileAsync(binary, args, { timeout: 5000 });
    return {
      ok: true,
      binary,
      detail: firstLine(`${result.stdout}${result.stderr}`) || "available"
    };
  } catch (error) {
    const detail = errorDetail(error);
    return { ok: false, binary, detail };
  }
}

function formatProbe(
  label: string,
  probe: { ok: boolean; binary: string; detail: string }
): string {
  return `${label}: ${probe.ok ? "ok" : "failed"} (${probe.binary}: ${probe.detail})`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const withOutput = error as Error & { stdout?: string; stderr?: string };
    return firstLine(`${withOutput.stdout ?? ""}${withOutput.stderr ?? ""}`) ||
      error.message;
  }
  return String(error);
}

function rootName(root: string): string {
  const resolved = resolve(root);
  return resolved.split("/").filter(Boolean).pop() ?? "mn-project";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  console.log(`mn - enterprise AI coding agent control plane

Commands:
  mn init
  mn agent run --provider <id> --model <id> --prompt "..." [--cwd .]
  mn agent chat --provider <id> --model <id> [--prompt "..."] [--cwd .]
  mn agent resume <session-id> --prompt "..."
  mn agent sessions [--limit 100]
  mn plugin list
  mn plugin install <local-path|name@x.y.z>
  mn plugin remove <id|specifier>
  mn plugin reload
  mn profile validate [--file profile.yml]
  mn profile inspect
  mn doctor
  mn doctor env-cleanup [--name OPENAI_API_KEY] [--source shell|launchd|ide|all] [--dry-run] [--yes]
  mn diagnostics export [--out mniu-diagnostics.json]
  mn provider list [--app claude|codex]
  mn provider add --preset deepseek [--api-key-env OPENAI_API_KEY] [--replay-tool-calls] [--tool-readonly name] [--tool-idempotent name] [--tool-side-effect name]
  mn provider export [--app claude|codex] [--out providers.json]
  mn provider import --file providers.json [--dry-run] [--yes]
  mn provider model-catalog sync <provider-id> (--file catalog.json|--url URL) [--mode replace|merge] [--max-age-days 30] [--save-policy] [--refresh-interval-hours 24] [--dry-run] [--yes]
  mn provider model-catalog audit <provider-id> [--max-age-days 30]
  mn provider model-catalog sync-due [--app claude|codex] [--provider provider-id] [--limit 10] [--dry-run] [--yes]
  mn provider enable <provider-id> [--app claude|codex] [--home /tmp/home] [--dry-run]
  mn provider restore <provider-id> [--app claude|codex] [--dry-run|--yes]
  mn provider test <provider-id>
  mn provider delete <provider-id>
  mn proxy status
  mn proxy start [--port 15721]
  mn proxy stop
  mn proxy logs [--app claude|codex]
  mn proxy health [--app claude|codex]
  mn proxy health-reset <provider-id> [--app claude|codex]
  mn proxy takeover claude|codex [--home /tmp/home] [--dry-run]
  mn proxy restore claude|codex [--dry-run]
  mn usage summary [--app claude|codex] [--provider id] [--run run-id] [--candidate candidate-id] [--limit 100]
  mn usage requests [--app claude|codex] [--provider id] [--run run-id] [--candidate candidate-id] [--limit 100]
  mn usage models [--app claude|codex] [--provider id] [--run run-id] [--candidate candidate-id] [--limit 100]
  mn session list [--app claude|codex] [--home /tmp/home] [--query text] [--offset 0] [--limit 100] [--redact]
  mn session show <session-id> [--app claude|codex] [--home /tmp/home] [--redact]
  mn session export <session-id> [--app claude|codex] [--home /tmp/home] [--out session.json] [--raw]
  mn artifact-store summary
  mn artifact-store cleanup [--scope local|remote|both] [--keep-latest-runs 10] [--max-age-days 30] [--max-bytes 104857600] [--dry-run] [--yes]
  mn mcp list [--app claude|codex]
  mn mcp add --name weather --command node [--args server.js] [--env KEY=VALUE] [--apps claude,codex]
  mn mcp project <server-id> [--apps claude,codex] [--home /tmp/home] [--dry-run]
  mn prompt list [--app claude|codex]
  mn prompt add --name review --content "..." [--apps claude,codex]
  mn prompt activate <prompt-id> --app claude|codex [--home /tmp/home] [--dry-run]
  mn skill discover [--home /tmp/home]
  mn skill list [--app claude|codex]
  mn skill add --name review --source /path/to/skill [--apps claude,codex]
  mn skill registry-sync --url registry.json [--require-signature] [--require-release-metadata] [--public-key base64-spki] [--trusted-public-key id=base64-spki] [--revoked-public-key-id id] [--dry-run] [--yes]
  mn skill registry-profile list
  mn skill registry-profile add --name trusted --url registry.json [--require-signature] [--require-release-metadata] [--public-key base64-spki] [--trusted-public-key id=base64-spki] [--revoked-public-key-id id]
  mn skill registry-profile sync <profile-id> [--dry-run] [--yes]
  mn skill registry-profile delete <profile-id>
  mn skill install <skill-id> --app claude|codex [--mode copy|symlink] [--home /tmp/home] [--dry-run]
  mn skill uninstall <skill-id> --app claude|codex [--home /tmp/home] [--dry-run]
  mn skill delete <skill-id>
  mn project register --root . [--name demo]
  mn project index
  mn standards validate --file pack.yaml [--out result.json]
  mn standards import --file pack.yaml [--actor user] [--out record.json]
  mn standards diff --from id@version --to id@version [--out diff.json]
  mn standards activate <id@version> --scope organization|team|project|service|task --scope-id id [--project id] [--actor user]
  mn standards lock [--project id] [--out .mn/standards.lock]
  mn spec init --id increment-id --title "..." [--hypothesis "..."] [--outcome "..."] [--non-goal "..."] [--acceptance "..."] [--service service] [--out specs/id/spec.yaml]
  mn spec import --file spec.yaml [--spec-kit] [--id increment-id] [--actor user]
  mn spec validate --file spec.yaml [--spec-kit] [--out validation.json]
  mn spec diff --from old.yaml --to new.yaml [--out diff.json]
  mn spec approve <id@revision> --by reviewer [--at RFC3339]
  mn spec status [id] [--out status.json]
  mn policy explain [--project id] [--organization id] [--team id] [--service id] [--task id] [--spec id@revision]
  mn workflow list [--out workflows.json]
  mn workflow show <id[@version]> [--out workflow.json]
  mn audit export [--project id] [--after cursor] [--limit 100] [--out audit.json]
  mn task create --title "..." [--service api] [--prompt "..."] [--acceptance "..."]
                 [--providers claude,codex] [--candidates n] [--gates registry,id]
                 [--timeout seconds] [--approval never|on-risk|before-merge]
                 [--workflow id[@version]] [--classic-fallback]
  mn run --task <task-id> [--wait] [--queue-only] [--priority -1000..1000]
  mn run --spec <id@revision> --workflow <id[@version]> [--harness-profile id[@version]]
         [--title "..."] [--prompt "..."] [--wait] [--queue-only] [--priority -1000..1000]
  mn run worker [--once] [--mock] [--owner worker-id] [--capacity 1] [--ttl-ms 30000] [--workspace-root .mn/worktrees] [--proxy-base-url http://127.0.0.1:15721]
  mn run worker --enterprise [--once] [--owner machine-jwt-sub[@instance]] [--sandbox-image approved-image-assertion] [--sandbox-backend id] [--sandbox-capability id] [--provider builtin|claude|codex] [--language javascript] [--gate-runner id] [--tool executable]
  mn run workers [--state idle|running|stale] [--owner worker-id]
  mn run artifacts <run-id> [--candidate candidate-id] [--provider claude|codex] [--kind log|summary|test-report] [--gate gate] [--source source] [--persisted true|false]
  mn run artifacts-download <run-id> [--candidate candidate-id] [--provider claude|codex] [--kind log|summary|test-report] [--gate gate] [--source source] [--persisted true|false] [--out artifacts.tar]
  mn run artifact <run-id> <artifact-id> [--out artifact.txt]
  mn run resume <run-id>
  mn run cleanup <run-id> --yes
  mn run watch <run-id>
  mn gates report <run-id>
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const cause = nestedErrorCauseSummary(error);
  console.error(cause ? `${message}\nCaused by: ${cause}` : message);
  process.exitCode = 1;
});
