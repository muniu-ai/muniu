import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  GateArtifactV2,
  GateId,
  GateResult,
  GateResultV2,
  GateResultV2Status,
  RunEvent
} from "@mn/core";
import type {
  SandboxExecutionEvidence,
  SandboxRuntimeProof
} from "@mn/harness";
import { runCommand } from "@mn/executors";
import {
  GateRegistryV2,
  type GateCommandResolution,
  type GateEvaluationFacts,
  type GateEvaluationResult
} from "./gateRegistry.js";
import { createDefaultProjectGateRunners } from "./projectGateRunners.js";
import { createPolicyGateRunners } from "./policyGateRunners.js";

const execFileAsync = promisify(execFile);

export interface GatePlanItemV2 {
  readonly id: GateId;
  readonly required: boolean;
  readonly language: string;
  readonly specClauseIds?: readonly string[];
  readonly declaredCommands?: Readonly<
    Record<string, Readonly<{ executable: string; args: readonly string[] }>>
  >;
  readonly timeoutSeconds?: number;
  readonly freshnessSeconds?: number;
  readonly facts?: GateEvaluationFacts;
  /** Immutable capability binding emitted by the Harness compiler. The
   * capability id is the gate registry id; the concrete executor identity is
   * recorded separately on GateResultV2.runnerId. */
  readonly capabilityBinding?: Readonly<{
    id: string;
    version: string;
    languages: readonly string[];
  }>;
}

export interface GateEngineV2Input {
  readonly cwd: string;
  /** Stable logical path recorded in evidence. Resolution, evaluation and
   * execution continue to use cwd; this prevents authority snapshot temp paths
   * from changing otherwise identical evidence digests. */
  readonly evidenceCwd?: string;
  readonly gates: readonly GatePlanItemV2[];
  readonly registry: GateRegistryV2;
  readonly runId: string;
  readonly candidateId: string;
  readonly failClosed: boolean;
  readonly commandAllowlist?: readonly string[];
  readonly onEvent?: (event: RunEvent) => void;
  readonly abortSignal?: AbortSignal;
  /** Enterprise runs provide a lease-bound executor. When present, command
   * Gates never spawn the resolved tool on the API/worker host. */
  readonly commandExecutor?: GateCommandExecutor;
  /** Enterprise workers publish every artifact byte sequence to the API before
   * the GateResult is checkpointed. Classic/local callers may omit this and
   * keep the historical mn:// path metadata. */
  readonly artifactPublisher?: GateArtifactPublisher;
}

export interface GateArtifactPublishRequest {
  readonly runId: string;
  readonly candidateId: string;
  readonly gateId: GateId;
  readonly gateResultId: string;
  readonly artifact: Readonly<Omit<GateArtifactV2, "handle" | "path">>;
  readonly content: Uint8Array;
}

export type GateArtifactPublisher = (
  request: GateArtifactPublishRequest
) => Promise<GateArtifactV2>;

export interface GateCommandExecutionRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly runId: string;
  readonly candidateId: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RunEvent) => void;
}

export interface GateCommandExecutionResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GateResolvedToolIdentity {
  readonly schemaVersion: 1;
  readonly requestedExecutable: string;
  readonly resolvedExecutable: string;
  readonly contentDigest: string;
  readonly imageDigest: string;
}

export interface GateCommandExecutor {
  readonly id: string;
  readonly version: string;
  readonly sandboxExecution: SandboxExecutionEvidence;
  execute(request: GateCommandExecutionRequest): Promise<GateCommandExecutionResult>;
  /** Resolves a bare allowlisted name inside the trusted runtime and binds the
   * exact image executable bytes. Enterprise fail-closed Gates require it. */
  resolveToolIdentity?(
    executable: string,
    cwd: string
  ): Promise<GateResolvedToolIdentity>;
  probeVersion?(
    executable: string,
    versionArgs: readonly string[],
    cwd: string
  ): Promise<string>;
}

export interface GateEngineInput {
  cwd: string;
  requiredGates: GateId[];
  stdout: string;
  stderr: string;
  language?: string;
  runId?: string;
  candidateId?: string;
  onEvent?: (event: RunEvent) => void;
  abortSignal?: AbortSignal;
}

export function createDefaultGateRegistry(): GateRegistryV2 {
  const registry = new GateRegistryV2();
  for (const runner of createDefaultProjectGateRunners()) registry.register(runner);
  for (const runner of createPolicyGateRunners()) registry.register(runner);
  return registry;
}

function createClassicGateRegistry(): GateRegistryV2 {
  const registry = new GateRegistryV2();
  for (const runner of createDefaultProjectGateRunners()) registry.register(runner);
  return registry;
}

export async function runGateEngineV2(
  input: GateEngineV2Input
): Promise<GateResultV2[]> {
  const results: GateResultV2[] = [];
  for (const plan of input.gates) {
    if (input.abortSignal?.aborted) {
      results.push(
        syntheticResult(input, plan, "cancelled", "Gate execution was cancelled before start.")
      );
      continue;
    }
    const bindingError = validateCapabilityBinding(plan);
    if (bindingError) {
      results.push(
        syntheticResult(
          input,
          plan,
          plan.required && input.failClosed ? "error" : "unsupported",
          bindingError,
          "harness-capability-binding"
        )
      );
      continue;
    }
    const runner = input.registry.resolve(plan.id, plan.language);
    if (!runner) {
      results.push(
        syntheticResult(
          input,
          plan,
          plan.required && input.failClosed ? "error" : "unsupported",
          `No runner supports gate ${plan.id} for ${plan.language}.`
        )
      );
      continue;
    }

    if (runner.evaluate) {
      try {
        const evaluated = await runner.evaluate({
          gateId: plan.id,
          cwd: input.cwd,
          language: plan.language,
          declaredCommands: plan.declaredCommands,
          facts: plan.facts,
          signal: input.abortSignal
        });
        const normalized =
          plan.required &&
          input.failClosed &&
          (evaluated.status === "skipped" || evaluated.status === "unsupported")
            ? {
                ...evaluated,
                status: "error" as const,
                summary: `Required gate ${plan.id} cannot be ${evaluated.status}: ${evaluated.summary}`
              }
            : evaluated;
        results.push(
          await evaluationResult(input, plan, runner.id, runner.version, normalized)
        );
      } catch (error) {
        results.push(
          syntheticResult(
            input,
            plan,
            "error",
            `Gate evaluator ${runner.id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            runner.id
          )
        );
      }
      continue;
    }

    let resolved: GateCommandResolution | undefined;
    try {
      resolved = await runner.resolveCommand?.({
        gateId: plan.id,
        cwd: input.cwd,
        language: plan.language,
        declaredCommands: plan.declaredCommands
      });
    } catch (error) {
      results.push(
        syntheticResult(
          input,
          plan,
          "error",
          `Gate runner ${runner.id} failed to resolve a command: ${
            error instanceof Error ? error.message : String(error)
          }`,
          runner.id
        )
      );
      continue;
    }
    if (!resolved) {
      results.push(
        syntheticResult(
          input,
          plan,
          plan.required && input.failClosed ? "error" : "skipped",
          `Gate ${plan.id} has no declared or discoverable command.`,
          runner.id
        )
      );
      continue;
    }
    let prepared: PreparedEvidenceCommand;
    try {
      prepared = await prepareEvidenceCommand(resolved, input.cwd);
    } catch (error) {
      results.push(
        syntheticResult(
          input,
          plan,
          "error",
          `Gate ${plan.id} command is not provenance-safe: ${
            error instanceof Error ? error.message : String(error)
          }`,
          runner.id
        )
      );
      continue;
    }
    if (!commandIsAllowed(prepared.command.executable, input.commandAllowlist)) {
      results.push(
        syntheticResult(
          input,
          plan,
          "error",
          `Gate ${plan.id} resolved executable ${prepared.command.executable}, which is not in the immutable command allowlist.`,
          runner.id
        )
      );
      continue;
    }
    let toolIdentity: GateResolvedToolIdentity | undefined;
    if (input.commandExecutor && input.failClosed) {
      try {
        if (!input.commandExecutor.resolveToolIdentity) {
          throw new Error("leased command executor cannot resolve executable content identity");
        }
        toolIdentity = validateResolvedToolIdentity(
          await input.commandExecutor.resolveToolIdentity(
            prepared.command.executable,
            input.cwd
          ),
          prepared.command.executable,
          input.commandExecutor.sandboxExecution.imageDigest
        );
      } catch (error) {
        results.push(
          syntheticResult(
            input,
            plan,
            "error",
            `Gate ${plan.id} executable identity is not authoritative: ${
              error instanceof Error ? error.message : String(error)
            }`,
            runner.id
          )
        );
        continue;
      }
    }
    const command = toolIdentity
      ? Object.freeze({
          ...prepared.command,
          executable: toolIdentity.resolvedExecutable,
          display: [toolIdentity.resolvedExecutable, ...prepared.command.args].join(" ")
        })
      : prepared.command;
    results.push(
      await executeCommandGate(
        input,
        plan,
        runner.id,
        runner.version,
        command,
        prepared.canonicalization,
        toolIdentity
      )
    );
  }
  return results;
}

async function evaluationResult(
  input: GateEngineV2Input,
  plan: GatePlanItemV2,
  runnerId: string,
  runnerVersion: string,
  result: GateEvaluationResult
): Promise<GateResultV2> {
  const reportedRunnerId = plan.capabilityBinding?.id ?? runnerId;
  const reportedRunnerVersion = plan.capabilityBinding?.version ?? runnerVersion;
  const evidenceCwd = input.evidenceCwd ?? input.cwd;
  const timestamp = new Date().toISOString();
  const gateResultId = randomUUID();
  const artifacts: GateArtifactV2[] = [];
  for (const [index, artifact] of (result.artifacts ?? []).entries()) {
    artifacts.push(await materializeGateArtifact(
      input,
      plan,
      gateResultId,
      {
        id: `${plan.id}-${artifact.kind}-${index + 1}`,
        kind: artifact.kind,
        contentType: artifact.contentType
      },
      artifact.content,
      `${artifact.kind}-${index + 1}`
    ));
  }
  if (result.log !== undefined) {
    artifacts.push(await materializeGateArtifact(
      input,
      plan,
      gateResultId,
      {
        id: `${plan.id}-log`,
        kind: "log",
        contentType: "text/plain; charset=utf-8"
      },
      result.log,
      "log"
    ));
  }
  if (artifacts.length === 0) {
    const fallbackLog = result.summary;
    artifacts.push(await materializeGateArtifact(
      input,
      plan,
      gateResultId,
      {
        id: `${plan.id}-log`,
        kind: "log",
        contentType: "text/plain; charset=utf-8"
      },
      fallbackLog,
      "log"
    ));
  }
  const inputSemantic = {
    gateId: plan.id,
    runnerId: reportedRunnerId,
    runnerVersion: reportedRunnerVersion,
    executionRunner: { id: runnerId, version: runnerVersion },
    required: plan.required,
    language: plan.language,
    specClauseIds: [...(plan.specClauseIds ?? [])].sort(compareCodeUnits),
    facts: plan.facts ?? null,
    capabilityBinding: plan.capabilityBinding ?? null,
    workingDirectory: evidenceCwd,
    sandboxExecution: input.commandExecutor?.sandboxExecution ?? null
  };
  const outputSemantic = gateOutputSemantic({
    status: result.status,
    summary: result.summary,
    exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : null,
    artifacts,
    sandboxExecution: input.commandExecutor?.sandboxExecution
  });
  const freshnessSeconds = plan.freshnessSeconds ?? 3600;
  return deepFreeze({
    schemaVersion: 2,
    id: gateResultId,
    runId: input.runId,
    candidateId: input.candidateId,
    gateId: plan.id,
    runnerId: reportedRunnerId,
    runnerVersion: reportedRunnerVersion,
    required: plan.required,
    status: result.status,
    summary: result.summary,
    specClauseIds: [...(plan.specClauseIds ?? [])].sort(compareCodeUnits),
    tool: { id: runnerId, version: runnerVersion },
    workingDirectory: evidenceCwd,
    exitCode: result.status === "pass" ? 0 : result.status === "fail" ? 1 : null,
    inputDigest: sha256Canonical(inputSemantic),
    outputDigest: sha256Canonical(outputSemantic),
    artifacts,
    startedAt: timestamp,
    finishedAt: timestamp,
    freshUntil: new Date(Date.parse(timestamp) + freshnessSeconds * 1000).toISOString(),
    ...(input.commandExecutor
      ? { sandboxExecution: input.commandExecutor.sandboxExecution }
      : {})
  });
}

async function materializeGateArtifact(
  input: GateEngineV2Input,
  plan: GatePlanItemV2,
  gateResultId: string,
  identity: Pick<GateArtifactV2, "id" | "kind" | "contentType">,
  text: string,
  localName: string
): Promise<GateArtifactV2> {
  const content = Buffer.from(text, "utf8");
  const declared: Omit<GateArtifactV2, "handle" | "path"> = {
    ...identity,
    digest: sha256Text(text),
    byteLength: content.byteLength
  };
  if (!input.artifactPublisher) {
    return {
      ...declared,
      path: `mn://runs/${encodeURIComponent(input.runId)}/candidates/${encodeURIComponent(
        input.candidateId
      )}/gates/${encodeURIComponent(plan.id)}/${encodeURIComponent(localName)}`
    };
  }
  const published = await input.artifactPublisher({
    runId: input.runId,
    candidateId: input.candidateId,
    gateId: plan.id,
    gateResultId,
    artifact: declared,
    content
  });
  if (
    published.id !== declared.id ||
    published.kind !== declared.kind ||
    published.contentType !== declared.contentType ||
    published.digest !== declared.digest ||
    published.byteLength !== declared.byteLength ||
    !published.handle ||
    published.path !== undefined
  ) {
    throw new Error(
      `Gate artifact publisher returned a mismatched registration for ${declared.id}`
    );
  }
  return { ...published };
}

export async function runGateEngine(input: GateEngineInput): Promise<GateResult[]> {
  const language = input.language ?? (await detectProjectLanguage(input.cwd));
  const v2 = await runGateEngineV2({
    cwd: input.cwd,
    gates: input.requiredGates.map((id) => ({ id, required: true, language })),
    // classic-v1 does not have immutable Spec/diff/contract facts. Keep its
    // historical adapter semantics and reserve policy evaluators for governed
    // runs, where their required inputs are compiled into the Harness.
    registry: createClassicGateRegistry(),
    runId: input.runId ?? `gate-${randomUUID()}`,
    candidateId: input.candidateId ?? "candidate",
    failClosed: false,
    onEvent: input.onEvent,
    abortSignal: input.abortSignal
  });
  const legacy = v2.map(toLegacyGateResult);
  for (let index = 0; index < v2.length; index += 1) {
    const result = v2[index];
    if (
      result?.status === "skipped" &&
      (language === "javascript" || language === "typescript") &&
      ["unit_test", "lint", "typecheck"].includes(result.gateId)
    ) {
      const script =
        result.gateId === "unit_test" ? "test" : result.gateId;
      legacy[index] = {
        gate: result.gateId,
        status: "skipped",
        summary: `No npm script named "${script}" in package.json.`,
        evidence: []
      };
    }
  }
  for (const gate of input.requiredGates) {
    if (gate !== "llm_verifier" && gate !== "human_approval") continue;
    const index = input.requiredGates.indexOf(gate);
    legacy[index] =
      gate === "human_approval"
        ? {
            gate,
            status: "skipped",
            summary: "Human approval is handled by run state, not automated gates.",
            evidence: []
          }
        : {
            gate,
            status: input.stderr.toLowerCase().includes("error") ? "warn" : "pass",
            summary: "Candidate output verifier compatibility gate completed.",
            evidence: []
          };
  }
  return legacy;
}

async function executeCommandGate(
  input: GateEngineV2Input,
  plan: GatePlanItemV2,
  runnerId: string,
  runnerVersion: string,
  command: GateCommandResolution,
  evidenceCanonicalization: GateEvidenceCanonicalization,
  resolvedToolIdentity?: GateResolvedToolIdentity
): Promise<GateResultV2> {
  const reportedRunnerId = plan.capabilityBinding?.id ?? runnerId;
  const reportedRunnerVersion = plan.capabilityBinding?.version ?? runnerVersion;
  const evidenceCwd = input.evidenceCwd ?? input.cwd;
  const startedAt = new Date().toISOString();
  const inputSemantic = {
    gateId: plan.id,
    runnerId: reportedRunnerId,
    runnerVersion: reportedRunnerVersion,
    executionRunner: { id: runnerId, version: runnerVersion },
    required: plan.required,
    language: plan.language,
    specClauseIds: [...(plan.specClauseIds ?? [])].sort(compareCodeUnits),
    command: {
      executable: command.executable,
      args: command.args,
      display: command.display
    },
    resolvedToolIdentity: resolvedToolIdentity ?? null,
    evidenceCanonicalization,
    facts: plan.facts ?? null,
    capabilityBinding: plan.capabilityBinding ?? null,
    commandAllowlist: input.commandAllowlist ?? null,
    workingDirectory: evidenceCwd,
    sandboxExecution: input.commandExecutor?.sandboxExecution ?? null
  };
  const result = input.commandExecutor
    ? await input.commandExecutor.execute({
        executable: command.executable,
        args: [...command.args],
        cwd: input.cwd,
        timeoutSeconds: plan.timeoutSeconds ?? 600,
        runId: input.runId,
        candidateId: input.candidateId,
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
        ...(input.abortSignal ? { signal: input.abortSignal } : {})
      })
    : await runCommand({
        command: command.executable,
        args: [...command.args],
        cwd: input.cwd,
        timeoutSeconds: plan.timeoutSeconds ?? 600,
        onEvent: input.onEvent,
        runId: input.runId,
        candidateId: input.candidateId,
        signal: input.abortSignal
      });
  const finishedAt = new Date().toISOString();
  let status: GateResultV2Status = input.abortSignal?.aborted
    ? "cancelled"
    : result.exitCode === 0
      ? "pass"
      : result.exitCode === null
        ? "error"
        : "fail";
  // Command events retain the raw process stream for live diagnostics. The
  // durable Gate artifact is a versioned evidence projection so an API
  // authority can independently execute the same Gate and compare exact CAS
  // bytes without treating reporter wall-clock jitter as a semantic change.
  const gateResultId = randomUUID();
  const artifacts: GateArtifactV2[] = [];
  let reporterError: string | undefined;
  if (evidenceCanonicalization.profile === "node-test-junit-v2") {
    const reporterDocument = canonicalizeNodeTestJunit(result.stdout);
    if (!reporterDocument) {
      status = "error";
      reporterError = "trusted Node reporter did not emit one complete JUnit document";
      artifacts.push(await materializeGateArtifact(
        input,
        plan,
        gateResultId,
        {
          id: `${plan.id}-log`,
          kind: "log",
          contentType: "text/plain; charset=utf-8"
        },
        `${result.stdout}${result.stderr}`,
        "log"
      ));
    } else {
      artifacts.push(await materializeGateArtifact(
        input,
        plan,
        gateResultId,
        {
          id: `${plan.id}-junit`,
          kind: "junit",
          contentType: "application/junit+xml; charset=utf-8"
        },
        reporterDocument,
        "junit"
      ));
      if (result.stderr.length > 0) {
        artifacts.push(await materializeGateArtifact(
          input,
          plan,
          gateResultId,
          {
            id: `${plan.id}-stderr`,
            kind: "log",
            contentType: "text/plain; charset=utf-8"
          },
          result.stderr,
          "stderr"
        ));
      }
    }
  } else {
    artifacts.push(await materializeGateArtifact(
      input,
      plan,
      gateResultId,
      {
        id: `${plan.id}-log`,
        kind: "log",
        contentType: "text/plain; charset=utf-8"
      },
      `${result.stdout}${result.stderr}`,
      "log"
    ));
  }
  const toolVersion = input.commandExecutor?.probeVersion
    ? await input.commandExecutor.probeVersion(
        command.executable,
        command.versionArgs,
        input.cwd
      )
    : await probeToolVersion(command.executable, command.versionArgs);
  const freshnessSeconds = plan.freshnessSeconds ?? 3600;
  const summary = reporterError
    ? `${command.display} produced invalid structured evidence: ${reporterError}.`
    : status === "pass"
      ? `${command.display} passed.`
      : `${command.display} ${status === "fail" ? "failed" : status} with exit code ${
          result.exitCode ?? "null"
        }.`;
  const outputSemantic = gateOutputSemantic({
    status,
    summary,
    exitCode: result.exitCode,
    artifacts,
    sandboxExecution: input.commandExecutor?.sandboxExecution
  });
  return deepFreeze({
    schemaVersion: 2,
    id: gateResultId,
    runId: input.runId,
    candidateId: input.candidateId,
    gateId: plan.id,
    runnerId: reportedRunnerId,
    runnerVersion: reportedRunnerVersion,
    required: plan.required,
    status,
    summary,
    specClauseIds: [...(plan.specClauseIds ?? [])].sort(compareCodeUnits),
    command: {
      executable: command.executable,
      args: [...command.args],
      display: command.display
    },
    tool: resolvedToolIdentity
      ? {
          id: resolvedToolIdentity.requestedExecutable,
          version: toolVersion,
          identitySchema: "container-executable-v1",
          resolvedExecutable: resolvedToolIdentity.resolvedExecutable,
          contentDigest: resolvedToolIdentity.contentDigest,
          imageDigest: resolvedToolIdentity.imageDigest
        }
      : { id: command.executable, version: toolVersion },
    workingDirectory: evidenceCwd,
    exitCode: result.exitCode,
    inputDigest: sha256Canonical(inputSemantic),
    outputDigest: sha256Canonical(outputSemantic),
    artifacts,
    startedAt,
    finishedAt,
    freshUntil: new Date(Date.parse(finishedAt) + freshnessSeconds * 1000).toISOString(),
    ...(input.commandExecutor
      ? { sandboxExecution: input.commandExecutor.sandboxExecution }
      : {})
  });
}

export type GateEvidenceCanonicalizationProfile =
  | "exact-v1"
  | "node-test-v1"
  | "node-test-junit-v2";

type GateEvidenceCanonicalization = Readonly<
  | { profile: "exact-v1"; version: 1 }
  | {
      profile: "node-test-junit-v2";
      version: 2;
      channel: "stdout";
      isolation: "process";
    }
>;

interface PreparedEvidenceCommand {
  readonly command: GateCommandResolution;
  readonly canonicalization: GateEvidenceCanonicalization;
}

/**
 * Canonicalizes only fields that a trusted command resolver has identified as
 * non-semantic reporter timing. This function deliberately does not inspect a
 * log to decide its profile: callers must bind the profile to the resolved
 * executable/arguments before the command is run.
 */
export function canonicalizeGateEvidenceLog(
  text: string,
  profile: GateEvidenceCanonicalizationProfile
): string {
  // node-test-v1 is retained as a source-compatible type only. Its historical
  // whole-log regular expressions were not provenance-safe, so legacy callers
  // now receive exact bytes rather than an unsafe best-effort normalization.
  if (profile !== "node-test-junit-v2") return text;
  return canonicalizeNodeTestJunit(text) ?? text;
}

async function prepareEvidenceCommand(
  command: GateCommandResolution,
  cwd: string
): Promise<PreparedEvidenceCommand> {
  const executable = basename(command.executable).toLowerCase();
  const direct = executable === "node" || executable === "node.exe"
    ? command
    : executable === "npm" || executable === "npm.cmd"
      ? await resolveDirectNodeTestNpmScript(command.args, cwd)
      : undefined;
  const junitCommand = direct ? forceNodeTestJunitReporter(direct) : undefined;
  if (!junitCommand) {
    return Object.freeze({
      command,
      canonicalization: Object.freeze({ profile: "exact-v1", version: 1 })
    });
  }
  return Object.freeze({
    command: junitCommand,
    canonicalization: Object.freeze({
      profile: "node-test-junit-v2",
      version: 2,
      channel: "stdout",
      isolation: "process"
    })
  });
}

async function resolveDirectNodeTestNpmScript(
  args: readonly string[],
  cwd: string
): Promise<GateCommandResolution | undefined> {
  const script = npmScriptName(args);
  if (!script) return undefined;
  try {
    const parsed = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as unknown;
    if (!plainRecord(parsed) || !plainRecord(parsed.scripts)) return undefined;
    const scripts = parsed.scripts;
    const body = scripts[script];
    if (
      typeof body !== "string" ||
      typeof scripts[`pre${script}`] === "string" ||
      typeof scripts[`post${script}`] === "string"
    ) {
      return undefined;
    }
    const words = parseSafeNpmScriptCommand(body);
    if (!words) return undefined;
    const executable = words[0]!;
    const executableName = basename(executable).toLowerCase();
    if (executableName !== "node" && executableName !== "node.exe") return undefined;
    return Object.freeze({
      executable,
      args: Object.freeze(words.slice(1)),
      display: words.join(" "),
      versionArgs: Object.freeze(["--version"])
    });
  } catch {
    return undefined;
  }
}

function npmScriptName(args: readonly string[]): string | undefined {
  const script = args.length === 1 && args[0] === "test"
    ? "test"
    : args.length === 2 &&
        (args[0] === "run" || args[0] === "run-script")
      ? args[1]
      : undefined;
  return script && /^[A-Za-z0-9:_-]+$/u.test(script) ? script : undefined;
}

function parseSafeNpmScriptCommand(value: string): readonly string[] | undefined {
  if (value.length === 0 || value !== value.trim() || /[\0\r\n]/u.test(value)) {
    return undefined;
  }
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else if (/[|&;<>()$`\\#%!^~{}]/u.test(character)) return undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        if (current.length === 0) return undefined;
        words.push(current);
        current = "";
        tokenStarted = false;
      }
    } else if (/[|&;<>()$`\\#%!^~{}]/u.test(character)) {
      return undefined;
    } else {
      current += character;
      tokenStarted = true;
    }
  }
  if (quote) return undefined;
  if (tokenStarted) {
    if (current.length === 0) return undefined;
    words.push(current);
  }
  return words.length > 0 ? Object.freeze(words) : undefined;
}

function forceNodeTestJunitReporter(
  command: GateCommandResolution
): GateCommandResolution | undefined {
  if (command.args.includes("--")) return undefined;
  const withoutReporter: string[] = [];
  let reporterSeen = false;
  let destinationSeen = false;
  for (let index = 0; index < command.args.length; index += 1) {
    const argument = command.args[index]!;
    if (
      argument === "--test-isolation" ||
      argument === "--experimental-test-isolation"
    ) {
      const value = command.args[index + 1];
      if (value === "none") {
        throw new TypeError("Node test isolation=none lets candidate code take over the reporter channel");
      }
      if (value !== "process") return undefined;
      index += 1;
      continue;
    }
    if (
      argument.startsWith("--test-isolation=") ||
      argument.startsWith("--experimental-test-isolation=")
    ) {
      const value = argument.slice(argument.indexOf("=") + 1);
      if (value === "none") {
        throw new TypeError("Node test isolation=none lets candidate code take over the reporter channel");
      }
      if (value !== "process") return undefined;
      continue;
    }
    if (argument === "--test-reporter" || argument === "--test-reporter-destination") {
      return undefined;
    }
    if (argument.startsWith("--test-reporter=")) {
      if (reporterSeen || argument !== "--test-reporter=junit") return undefined;
      reporterSeen = true;
      continue;
    }
    if (argument.startsWith("--test-reporter-destination=")) {
      if (
        destinationSeen ||
        argument !== "--test-reporter-destination=stdout"
      ) {
        return undefined;
      }
      destinationSeen = true;
      continue;
    }
    withoutReporter.push(argument);
  }
  const testFlagIndexes = withoutReporter
    .map((argument, index) =>
      argument === "--test" || argument.startsWith("--test=") ? index : -1
    )
    .filter((index) => index >= 0);
  const testFlagIndex = testFlagIndexes[0] ?? -1;
  if (
    testFlagIndexes.length !== 1 ||
    withoutReporter.slice(0, testFlagIndex).some((argument) => !argument.startsWith("-"))
  ) {
    return undefined;
  }
  const args = [...withoutReporter];
  args.splice(
    testFlagIndex + 1,
    0,
    "--experimental-test-isolation=process",
    "--test-reporter=junit",
    "--test-reporter-destination=stdout"
  );
  return Object.freeze({
    executable: command.executable,
    args: Object.freeze(args),
    display: [command.executable, ...args].join(" "),
    versionArgs: Object.freeze(["--version"])
  });
}

interface XmlAttributeToken {
  readonly name: string;
  readonly value: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface XmlOpenTagToken {
  readonly name: string;
  readonly attributes: readonly XmlAttributeToken[];
  readonly selfClosing: boolean;
  readonly end: number;
}

interface TextReplacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

type RootJunitChild =
  | Readonly<{ kind: "element"; name: string }>
  | Readonly<{
      kind: "comment";
      content: string;
      contentStart: number;
      contentEnd: number;
    }>;

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';
const JUNIT_DURATION = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const JUNIT_COUNT = /^(?:0|[1-9]\d*)$/u;
const JUNIT_SUMMARY_FIELDS = [
  "tests",
  "suites",
  "pass",
  "fail",
  "cancelled",
  "skipped",
  "todo",
  "duration_ms"
] as const;

/** Returns undefined unless every byte is a complete, narrowly accepted Node
 * JUnit document. Only reporter-owned testcase time attributes and the final
 * root summary duration are then replaced. Arbitrary TAP/spec-looking text is
 * never interpreted as evidence structure. */
function canonicalizeNodeTestJunit(text: string): string | undefined {
  if (!text.startsWith(XML_DECLARATION)) return undefined;
  let cursor = XML_DECLARATION.length;
  let rootSeen = false;
  let rootClosed = false;
  let testcaseCount = 0;
  let testsuiteCount = 0;
  const stack: string[] = [];
  const rootChildren: RootJunitChild[] = [];
  const replacements: TextReplacement[] = [];

  while (cursor < text.length) {
    if (text[cursor] !== "<") {
      const next = text.indexOf("<", cursor);
      const end = next < 0 ? text.length : next;
      const content = text.slice(cursor, end);
      const parent = stack.at(-1);
      if (
        !validXmlValue(content, false) ||
        (!junitElementAllowsText(parent) && !/^\s*$/u.test(content))
      ) {
        return undefined;
      }
      cursor = end;
      continue;
    }

    if (text.startsWith("<!--", cursor)) {
      if (rootClosed || stack.length === 0) return undefined;
      const end = text.indexOf("-->", cursor + 4);
      if (end < 0) return undefined;
      const content = text.slice(cursor + 4, end);
      if (
        content.includes("--") ||
        content.endsWith("-") ||
        !validXmlCharacters(content)
      ) {
        return undefined;
      }
      if (stack.length === 1 && stack[0] === "testsuites") {
        rootChildren.push({
          kind: "comment",
          content,
          contentStart: cursor + 4,
          contentEnd: end
        });
      }
      cursor = end + 3;
      continue;
    }

    if (text.startsWith("</", cursor)) {
      const closing = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)[\t\n\r ]*>/u.exec(
        text.slice(cursor)
      );
      if (!closing || stack.at(-1) !== closing[1]) return undefined;
      stack.pop();
      cursor += closing[0].length;
      if (stack.length === 0) rootClosed = true;
      continue;
    }

    if (text.startsWith("<?", cursor) || text.startsWith("<!", cursor)) {
      return undefined;
    }
    const opened = parseXmlOpenTag(text, cursor);
    if (!opened || rootClosed) return undefined;
    if (stack.length === 0) {
      if (
        rootSeen ||
        opened.name !== "testsuites" ||
        opened.selfClosing ||
        opened.attributes.length !== 0
      ) {
        return undefined;
      }
      rootSeen = true;
    } else {
      const parent = stack.at(-1)!;
      if (!allowedJunitChild(parent, opened.name)) return undefined;
      if (stack.length === 1 && parent === "testsuites") {
        rootChildren.push({ kind: "element", name: opened.name });
      }
      if (opened.name === "testcase") {
        testcaseCount += 1;
        const attributes = new Map(
          opened.attributes.map((attribute) => [attribute.name, attribute] as const)
        );
        if (attributes.size !== opened.attributes.length) return undefined;
        const time = attributes.get("time");
        if (
          !attributes.has("name") ||
          !attributes.has("classname") ||
          !time ||
          !JUNIT_DURATION.test(time.value)
        ) {
          return undefined;
        }
        replacements.push({ start: time.valueStart, end: time.valueEnd, value: "0" });
      } else if (opened.name === "testsuite") {
        testsuiteCount += 1;
      }
    }
    cursor = opened.end;
    if (!opened.selfClosing) stack.push(opened.name);
  }

  if (!rootSeen || !rootClosed || stack.length !== 0) return undefined;
  if (rootChildren.length < JUNIT_SUMMARY_FIELDS.length) return undefined;
  const summaryStart = rootChildren.length - JUNIT_SUMMARY_FIELDS.length;
  if (rootChildren.slice(0, summaryStart).some((child) => child.kind !== "element")) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const [index, field] of JUNIT_SUMMARY_FIELDS.entries()) {
    const child = rootChildren[summaryStart + index];
    if (!child || child.kind !== "comment") return undefined;
    const prefix = ` ${field} `;
    if (!child.content.startsWith(prefix) || !child.content.endsWith(" ")) {
      return undefined;
    }
    const value = child.content.slice(prefix.length, -1);
    const expected = field === "duration_ms" ? JUNIT_DURATION : JUNIT_COUNT;
    if (!expected.test(value)) return undefined;
    if (field === "duration_ms") {
      replacements.push({
        start: child.contentStart + prefix.length,
        end: child.contentEnd - 1,
        value: "0"
      });
    } else {
      counts.set(field, Number(value));
    }
  }
  if (counts.get("tests") !== testcaseCount || counts.get("suites") !== testsuiteCount) {
    return undefined;
  }
  return applyTextReplacements(text, replacements);
}

function parseXmlOpenTag(text: string, start: number): XmlOpenTagToken | undefined {
  let cursor = start + 1;
  const name = readXmlName(text, cursor);
  if (!name) return undefined;
  cursor = name.end;
  const attributes: XmlAttributeToken[] = [];
  const attributeNames = new Set<string>();
  while (cursor < text.length) {
    if (text.startsWith("/>", cursor)) {
      return { name: name.value, attributes, selfClosing: true, end: cursor + 2 };
    }
    if (text[cursor] === ">") {
      return { name: name.value, attributes, selfClosing: false, end: cursor + 1 };
    }
    const spaced = skipXmlWhitespace(text, cursor);
    if (spaced === cursor) return undefined;
    cursor = spaced;
    if (text.startsWith("/>", cursor)) {
      return { name: name.value, attributes, selfClosing: true, end: cursor + 2 };
    }
    if (text[cursor] === ">") {
      return { name: name.value, attributes, selfClosing: false, end: cursor + 1 };
    }
    const attributeName = readXmlName(text, cursor);
    if (!attributeName || attributeNames.has(attributeName.value)) return undefined;
    attributeNames.add(attributeName.value);
    cursor = skipXmlWhitespace(text, attributeName.end);
    if (text[cursor] !== "=") return undefined;
    cursor = skipXmlWhitespace(text, cursor + 1);
    const quote = text[cursor];
    if (quote !== '"' && quote !== "'") return undefined;
    const valueStart = cursor + 1;
    const valueEnd = text.indexOf(quote, valueStart);
    if (valueEnd < 0) return undefined;
    const value = text.slice(valueStart, valueEnd);
    if (!validXmlValue(value, true)) return undefined;
    attributes.push({
      name: attributeName.value,
      value,
      valueStart,
      valueEnd
    });
    cursor = valueEnd + 1;
  }
  return undefined;
}

function readXmlName(
  text: string,
  start: number
): Readonly<{ value: string; end: number }> | undefined {
  if (!/[A-Za-z_]/u.test(text[start] ?? "")) return undefined;
  let end = start + 1;
  while (/[A-Za-z0-9_.:-]/u.test(text[end] ?? "")) end += 1;
  return { value: text.slice(start, end), end };
}

function skipXmlWhitespace(text: string, start: number): number {
  let cursor = start;
  while (/[\t\n\r ]/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function validXmlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || !validXmlCodePoint(codePoint)) return false;
    if (codePoint > 0xffff) index += 1;
  }
  return true;
}

function validXmlValue(value: string, attribute: boolean): boolean {
  if (
    !validXmlCharacters(value) ||
    value.includes("]]>") ||
    (attribute && value.includes("<"))
  ) {
    return false;
  }
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("&", cursor);
    if (start < 0) return true;
    const end = value.indexOf(";", start + 1);
    if (end < 0) return false;
    const entity = value.slice(start + 1, end);
    if (!["amp", "lt", "gt", "quot", "apos"].includes(entity)) {
      const numeric = entity.startsWith("#x")
        ? /^[0-9A-Fa-f]+$/u.test(entity.slice(2))
          ? Number.parseInt(entity.slice(2), 16)
          : undefined
        : entity.startsWith("#") && /^\d+$/u.test(entity.slice(1))
          ? Number.parseInt(entity.slice(1), 10)
          : undefined;
      if (numeric === undefined || !validXmlCodePoint(numeric)) return false;
    }
    cursor = end + 1;
  }
  return true;
}

function validXmlCodePoint(value: number): boolean {
  return value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff);
}

function junitElementAllowsText(name: string | undefined): boolean {
  return name === "failure" ||
    name === "error" ||
    name === "skipped" ||
    name === "system-out" ||
    name === "system-err" ||
    name === "property";
}

function allowedJunitChild(parent: string, child: string): boolean {
  if (parent === "testsuites") return child === "testsuite" || child === "testcase";
  if (parent === "testsuite") {
    return child === "testsuite" ||
      child === "testcase" ||
      child === "properties" ||
      child === "system-out" ||
      child === "system-err";
  }
  if (parent === "properties") return child === "property";
  if (parent === "testcase") {
    return child === "failure" ||
      child === "error" ||
      child === "skipped" ||
      child === "system-out" ||
      child === "system-err";
  }
  return false;
}

function applyTextReplacements(
  text: string,
  replacements: readonly TextReplacement[]
): string {
  let result = text;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function syntheticResult(
  input: GateEngineV2Input,
  plan: GatePlanItemV2,
  status: GateResultV2Status,
  summary: string,
  runnerId = "unavailable"
): GateResultV2 {
  const timestamp = new Date().toISOString();
  const evidenceCwd = input.evidenceCwd ?? input.cwd;
  const semantic = {
    gateId: plan.id,
    runnerId: plan.capabilityBinding?.id ?? runnerId,
    runnerVersion:
      plan.capabilityBinding?.version ??
      (runnerId === "unavailable" ? "unavailable" : "unknown"),
    required: plan.required,
    language: plan.language,
    status,
    summary,
    specClauseIds: [...(plan.specClauseIds ?? [])].sort(compareCodeUnits),
    facts: plan.facts ?? null,
    capabilityBinding: plan.capabilityBinding ?? null,
    commandAllowlist: input.commandAllowlist ?? null,
    workingDirectory: evidenceCwd,
    sandboxExecution: input.commandExecutor?.sandboxExecution ?? null
  };
  return deepFreeze({
    schemaVersion: 2,
    id: randomUUID(),
    runId: input.runId,
    candidateId: input.candidateId,
    gateId: plan.id,
    runnerId: semantic.runnerId,
    runnerVersion: semantic.runnerVersion,
    required: plan.required,
    status,
    summary,
    specClauseIds: semantic.specClauseIds,
    workingDirectory: evidenceCwd,
    exitCode: null,
    inputDigest: sha256Canonical({ ...semantic, status: undefined, summary: undefined }),
    outputDigest: sha256Canonical(
      gateOutputSemantic({
        status,
        summary,
        exitCode: null,
        artifacts: [],
        sandboxExecution: input.commandExecutor?.sandboxExecution
      })
    ),
    artifacts: [],
    startedAt: timestamp,
    finishedAt: timestamp,
    freshUntil: new Date(
      Date.parse(timestamp) + (plan.freshnessSeconds ?? 3600) * 1000
    ).toISOString(),
    ...(input.commandExecutor
      ? { sandboxExecution: input.commandExecutor.sandboxExecution }
      : {})
  });
}

function validateCapabilityBinding(plan: GatePlanItemV2): string | undefined {
  const binding = plan.capabilityBinding;
  if (!binding) return undefined;
  if (
    typeof binding.id !== "string" ||
    typeof binding.version !== "string" ||
    binding.id !== plan.id ||
    binding.version.length === 0 ||
    binding.version !== binding.version.trim() ||
    !Array.isArray(binding.languages) ||
    binding.languages.length === 0 ||
    binding.languages.some(
      (language) =>
        typeof language !== "string" ||
        language.length === 0 ||
        language !== language.trim()
    ) ||
    new Set(binding.languages).size !== binding.languages.length
  ) {
    return `Harness capability binding for ${plan.id} is invalid.`;
  }
  if (
    !binding.languages.includes("*") &&
    !binding.languages.includes(plan.language)
  ) {
    return `Harness capability ${binding.id}@${binding.version} does not bind language ${plan.language}.`;
  }
  return undefined;
}

function commandIsAllowed(
  executable: string,
  allowlist: readonly string[] | undefined
): boolean {
  if (allowlist === undefined) return true;
  return bareExecutable(executable) && allowlist.includes(executable);
}

function bareExecutable(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value);
}

function validateResolvedToolIdentity(
  value: GateResolvedToolIdentity,
  requestedExecutable: string,
  expectedImageDigest: string | undefined
): GateResolvedToolIdentity {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.requestedExecutable !== requestedExecutable ||
    !bareExecutable(requestedExecutable) ||
    !trustedRuntimeExecutable(value.resolvedExecutable) ||
    !/^[a-f0-9]{64}$/u.test(value.contentDigest) ||
    !/^[a-f0-9]{64}$/u.test(value.imageDigest) ||
    !expectedImageDigest ||
    value.imageDigest !== expectedImageDigest
  ) {
    throw new TypeError("resolved executable path, content digest or runtime image binding is invalid");
  }
  return deepFreeze(structuredClone(value));
}

function trustedRuntimeExecutable(value: string): boolean {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("/../") ||
    value.endsWith("/..")
  ) {
    return false;
  }
  return ["/bin/", "/sbin/", "/usr/", "/opt/"].some((root) => value.startsWith(root));
}

function gateOutputSemantic(input: {
  status: GateResultV2Status;
  summary: string;
  exitCode: number | null;
  artifacts: readonly GateArtifactV2[];
  sandboxExecution?: SandboxExecutionEvidence;
}): unknown {
  return {
    status: input.status,
    summary: input.summary,
    exitCode: input.exitCode,
    artifacts: input.artifacts,
    sandboxExecution: input.sandboxExecution ?? null
  };
}

/** Recomputes the digest over the persisted GateResultV2 output fields. */
export function gateResultV2OutputDigest(result: GateResultV2): string {
  return sha256Canonical(
    gateOutputSemantic({
      status: result.status,
      summary: result.summary,
      exitCode: result.exitCode,
      artifacts: result.artifacts,
      sandboxExecution: result.sandboxExecution
    })
  );
}

export interface GateResultV2Validation {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly result?: GateResultV2;
}

const GATE_RESULT_FIELDS = [
  "schemaVersion",
  "id",
  "runId",
  "candidateId",
  "gateId",
  "runnerId",
  "runnerVersion",
  "required",
  "status",
  "summary",
  "specClauseIds",
  "command",
  "tool",
  "workingDirectory",
  "exitCode",
  "inputDigest",
  "outputDigest",
  "artifacts",
  "startedAt",
  "finishedAt",
  "freshUntil",
  "sandboxExecution"
] as const;
const GATE_RESULT_REQUIRED_FIELDS = GATE_RESULT_FIELDS.filter(
  (field) => field !== "command" && field !== "tool" && field !== "sandboxExecution"
);
const GATE_RESULT_STATUSES = new Set<GateResultV2Status>([
  "pass",
  "fail",
  "error",
  "skipped",
  "unsupported",
  "cancelled"
]);
const GATE_ARTIFACT_KINDS = new Set<GateArtifactV2["kind"]>([
  "log",
  "sarif",
  "junit",
  "coverage",
  "contract",
  "other"
]);

/** Parses untrusted worker JSON into an exact, deeply frozen GateResultV2. */
export function parseGateResultV2(
  value: unknown,
  now = new Date().toISOString()
): GateResultV2 {
  const validation = validateGateResultV2(value, now);
  if (!validation.valid || !validation.result) {
    throw new TypeError(`Invalid GateResultV2: ${validation.issues.join("; ")}`);
  }
  return validation.result;
}

/** Exact fail-closed validation boundary for externally reported Gate V2
 * evidence. It never throws for malformed input. */
export function validateGateResultV2(
  value: unknown,
  now = new Date().toISOString()
): GateResultV2Validation {
  try {
    const result = parseGateResultV2Structure(value);
    const issues = gateResultV2IntegrityIssues(result, now);
    return deepFreeze(
      issues.length === 0
        ? { valid: true, issues: [], result }
        : { valid: false, issues }
    );
  } catch (error) {
    return deepFreeze({
      valid: false,
      issues: [error instanceof Error ? error.message : "malformed GateResultV2"]
    });
  }
}

/** Compatibility helper returning only issues. It accepts unknown input so a
 * malformed external artifacts array cannot escape as a raw exception. */
export function validateGateResultV2Integrity(
  result: unknown,
  now = new Date().toISOString()
): readonly string[] {
  return validateGateResultV2(result, now).issues;
}

function gateResultV2IntegrityIssues(
  result: GateResultV2,
  now: string
): string[] {
  const issues: string[] = [];
  const digest = /^[a-f0-9]{64}$/u;
  if (!digest.test(result.inputDigest)) issues.push("inputDigest is not SHA-256");
  if (!digest.test(result.outputDigest)) issues.push("outputDigest is not SHA-256");
  if (result.sandboxExecution) {
    for (const [field, value] of [
      ["attestationDigest", result.sandboxExecution.attestationDigest],
      ["runtimeId", result.sandboxExecution.runtimeId],
      ["runtimeDigest", result.sandboxExecution.runtimeDigest],
      ...(result.sandboxExecution.imageDigest
        ? [["imageDigest", result.sandboxExecution.imageDigest] as const]
        : [])
    ] as const) {
      if (!digest.test(value)) issues.push(`sandboxExecution.${field} is not SHA-256`);
    }
    const proof = result.sandboxExecution.runtimeProof;
    for (const [field, value] of [
      ["claimDigest", proof.claimDigest],
      ["attestationDigest", proof.attestationDigest],
      ["runtimeId", proof.runtimeId],
      ["runtimeDigest", proof.runtimeDigest],
      ...(proof.imageDigest ? [["imageDigest", proof.imageDigest] as const] : []),
      ["digest", proof.digest],
      ["signature", proof.signature]
    ] as const) {
      if (!digest.test(value)) issues.push(`sandboxExecution.runtimeProof.${field} is not SHA-256`);
    }
    const { digest: proofDigest, signature: _proofSignature, ...proofSemantic } = proof;
    if (proofDigest !== sha256Canonical(proofSemantic)) {
      issues.push("sandboxExecution.runtimeProof.digest does not match proof content");
    }
    if (
      proof.attestationDigest !== result.sandboxExecution.attestationDigest ||
      proof.runtimeId !== result.sandboxExecution.runtimeId ||
      proof.runtimeDigest !== result.sandboxExecution.runtimeDigest ||
      proof.imageDigest !== result.sandboxExecution.imageDigest
    ) {
      issues.push("sandboxExecution runtime values do not match authority proof");
    }
  }
  if (result.outputDigest !== gateResultV2OutputDigest(result)) {
    issues.push("outputDigest does not match persisted output evidence");
  }
  if (result.status === "pass" && result.exitCode !== 0) {
    issues.push("pass evidence must have exitCode 0");
  }
  if (result.status === "fail" && (result.exitCode === null || result.exitCode === 0)) {
    issues.push("fail evidence must have a non-zero exitCode");
  }
  if (
    !["pass", "fail"].includes(result.status) &&
    result.exitCode !== null &&
    result.status !== "error"
  ) {
    issues.push(`${result.status} evidence must have a null exitCode`);
  }
  if (["pass", "fail"].includes(result.status)) {
    if (!result.tool) issues.push(`${result.status} evidence requires tool identity`);
    if (result.runnerId === "unavailable") {
      issues.push(`${result.status} evidence cannot use the unavailable runner`);
    }
    if (result.artifacts.length === 0) {
      issues.push(`${result.status} evidence requires at least one artifact`);
    }
  }
  if (result.command && !result.tool) {
    issues.push("command evidence requires tool identity");
  }
  if (result.command && result.sandboxExecution?.imageDigest) {
    if (
      result.tool?.identitySchema !== "container-executable-v1" ||
      !result.tool.resolvedExecutable ||
      !result.tool.contentDigest ||
      !result.tool.imageDigest
    ) {
      issues.push("enterprise command evidence requires executable content identity");
    } else {
      if (!trustedRuntimeExecutable(result.tool.resolvedExecutable)) {
        issues.push("enterprise command evidence resolved executable is outside trusted runtime roots");
      }
      if (!digest.test(result.tool.contentDigest)) {
        issues.push("enterprise command evidence contentDigest is not SHA-256");
      }
      if (result.tool.imageDigest !== result.sandboxExecution.imageDigest) {
        issues.push("enterprise command evidence imageDigest does not match sandbox runtime");
      }
      if (result.command.executable !== result.tool.resolvedExecutable) {
        issues.push("enterprise command executable does not match resolved tool identity");
      }
    }
  }
  for (const artifact of result.artifacts) {
    if (!digest.test(artifact.digest)) {
      issues.push(`artifact ${artifact.id} digest is not SHA-256`);
    }
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) {
      issues.push(`artifact ${artifact.id} byteLength is invalid`);
    }
  }
  const started = Date.parse(result.startedAt);
  const finished = Date.parse(result.finishedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    issues.push("gate timestamps are invalid or out of order");
  }
  const freshUntil = Date.parse(result.freshUntil);
  if (!Number.isFinite(freshUntil) || freshUntil < finished) {
    issues.push("freshUntil is invalid or precedes finishedAt");
  } else if (!Number.isFinite(current)) {
    issues.push("validation time is invalid");
  } else if (started > current + 300_000 || finished > current + 300_000) {
    issues.push("gate evidence timestamp is too far in the future");
  } else if (freshUntil - finished > 86_400_000) {
    issues.push("gate evidence freshness exceeds the 24 hour maximum");
  } else if (current > freshUntil) {
    issues.push("gate evidence is stale");
  }
  return issues;
}

function parseGateResultV2Structure(value: unknown): GateResultV2 {
  const record = exactDataRecord(
    value,
    GATE_RESULT_FIELDS,
    GATE_RESULT_REQUIRED_FIELDS,
    "gateResult"
  );
  if (dataValue(record, "schemaVersion") !== 2) {
    throw new TypeError("gateResult.schemaVersion must be 2");
  }
  const status = requiredString(dataValue(record, "status"), "gateResult.status");
  if (!GATE_RESULT_STATUSES.has(status as GateResultV2Status)) {
    throw new TypeError("gateResult.status is unsupported");
  }
  const required = dataValue(record, "required");
  if (typeof required !== "boolean") {
    throw new TypeError("gateResult.required must be boolean");
  }
  const exitCodeValue = dataValue(record, "exitCode");
  if (
    exitCodeValue !== null &&
    (!Number.isSafeInteger(exitCodeValue) || (exitCodeValue as number) < 0)
  ) {
    throw new TypeError("gateResult.exitCode must be null or a non-negative safe integer");
  }
  const clauses = stringArray(
    dataValue(record, "specClauseIds"),
    "gateResult.specClauseIds",
    { unique: true, sorted: true, allowEmptyStrings: false }
  );
  const artifacts = artifactArray(dataValue(record, "artifacts"));
  const commandValue = optionalDataValue(record, "command");
  const toolValue = optionalDataValue(record, "tool");
  const sandboxExecutionValue = optionalDataValue(record, "sandboxExecution");
  const result: GateResultV2 = {
    schemaVersion: 2,
    id: requiredString(dataValue(record, "id"), "gateResult.id"),
    runId: requiredString(dataValue(record, "runId"), "gateResult.runId"),
    candidateId: requiredString(
      dataValue(record, "candidateId"),
      "gateResult.candidateId"
    ),
    gateId: requiredString(dataValue(record, "gateId"), "gateResult.gateId"),
    runnerId: requiredString(dataValue(record, "runnerId"), "gateResult.runnerId"),
    runnerVersion: requiredString(
      dataValue(record, "runnerVersion"),
      "gateResult.runnerVersion"
    ),
    required,
    status: status as GateResultV2Status,
    summary: requiredString(dataValue(record, "summary"), "gateResult.summary"),
    specClauseIds: clauses,
    ...(commandValue === undefined ? {} : { command: parseGateCommand(commandValue) }),
    ...(toolValue === undefined ? {} : { tool: parseGateTool(toolValue) }),
    workingDirectory: requiredString(
      dataValue(record, "workingDirectory"),
      "gateResult.workingDirectory"
    ),
    exitCode: exitCodeValue as number | null,
    inputDigest: digestString(dataValue(record, "inputDigest"), "gateResult.inputDigest"),
    outputDigest: digestString(dataValue(record, "outputDigest"), "gateResult.outputDigest"),
    artifacts,
    startedAt: timestampString(dataValue(record, "startedAt"), "gateResult.startedAt"),
    finishedAt: timestampString(dataValue(record, "finishedAt"), "gateResult.finishedAt"),
    freshUntil: timestampString(dataValue(record, "freshUntil"), "gateResult.freshUntil"),
    ...(sandboxExecutionValue === undefined
      ? {}
      : { sandboxExecution: parseSandboxExecution(sandboxExecutionValue) })
  };
  return deepFreeze(result);
}

function parseSandboxExecution(value: unknown): SandboxExecutionEvidence {
  const record = exactDataRecord(
    value,
    [
      "backendId",
      "backendVersion",
      "leaseId",
      "attestationDigest",
      "runtimeId",
      "runtimeDigest",
      "imageDigest",
      "runtimeProof"
    ],
    [
      "backendId",
      "backendVersion",
      "leaseId",
      "attestationDigest",
      "runtimeId",
      "runtimeDigest",
      "runtimeProof"
    ],
    "gateResult.sandboxExecution"
  );
  return {
    backendId: requiredString(dataValue(record, "backendId"), "gateResult.sandboxExecution.backendId"),
    backendVersion: requiredString(dataValue(record, "backendVersion"), "gateResult.sandboxExecution.backendVersion"),
    leaseId: requiredString(dataValue(record, "leaseId"), "gateResult.sandboxExecution.leaseId"),
    attestationDigest: digestString(dataValue(record, "attestationDigest"), "gateResult.sandboxExecution.attestationDigest"),
    runtimeId: digestString(dataValue(record, "runtimeId"), "gateResult.sandboxExecution.runtimeId"),
    runtimeDigest: digestString(dataValue(record, "runtimeDigest"), "gateResult.sandboxExecution.runtimeDigest"),
    ...(optionalDataValue(record, "imageDigest") === undefined
      ? {}
      : {
          imageDigest: digestString(
            optionalDataValue(record, "imageDigest"),
            "gateResult.sandboxExecution.imageDigest"
          )
        }),
    runtimeProof: parseSandboxRuntimeProof(dataValue(record, "runtimeProof"))
  };
}

function parseSandboxRuntimeProof(value: unknown): SandboxRuntimeProof {
  const record = exactDataRecord(
    value,
    [
      "schemaVersion",
      "issuer",
      "issuedAt",
      "expiresAt",
      "tenantId",
      "runId",
      "workerId",
      "claimDigest",
      "attestationDigest",
      "runtimeId",
      "runtimeDigest",
      "imageDigest",
      "digest",
      "signature"
    ],
    [
      "schemaVersion",
      "issuer",
      "issuedAt",
      "expiresAt",
      "tenantId",
      "runId",
      "workerId",
      "claimDigest",
      "attestationDigest",
      "runtimeId",
      "runtimeDigest",
      "digest",
      "signature"
    ],
    "gateResult.sandboxExecution.runtimeProof"
  );
  if (dataValue(record, "schemaVersion") !== 1) {
    throw new TypeError("gateResult.sandboxExecution.runtimeProof.schemaVersion must be 1");
  }
  if (dataValue(record, "issuer") !== "mn-api") {
    throw new TypeError("gateResult.sandboxExecution.runtimeProof.issuer must be mn-api");
  }
  return {
    schemaVersion: 1,
    issuer: "mn-api",
    issuedAt: timestampString(
      dataValue(record, "issuedAt"),
      "gateResult.sandboxExecution.runtimeProof.issuedAt"
    ),
    expiresAt: timestampString(
      dataValue(record, "expiresAt"),
      "gateResult.sandboxExecution.runtimeProof.expiresAt"
    ),
    tenantId: requiredString(dataValue(record, "tenantId"), "gateResult.sandboxExecution.runtimeProof.tenantId"),
    runId: requiredString(dataValue(record, "runId"), "gateResult.sandboxExecution.runtimeProof.runId"),
    workerId: requiredString(dataValue(record, "workerId"), "gateResult.sandboxExecution.runtimeProof.workerId"),
    claimDigest: digestString(dataValue(record, "claimDigest"), "gateResult.sandboxExecution.runtimeProof.claimDigest"),
    attestationDigest: digestString(dataValue(record, "attestationDigest"), "gateResult.sandboxExecution.runtimeProof.attestationDigest"),
    runtimeId: digestString(dataValue(record, "runtimeId"), "gateResult.sandboxExecution.runtimeProof.runtimeId"),
    runtimeDigest: digestString(dataValue(record, "runtimeDigest"), "gateResult.sandboxExecution.runtimeProof.runtimeDigest"),
    ...(optionalDataValue(record, "imageDigest") === undefined
      ? {}
      : {
          imageDigest: digestString(
            optionalDataValue(record, "imageDigest"),
            "gateResult.sandboxExecution.runtimeProof.imageDigest"
          )
        }),
    digest: digestString(dataValue(record, "digest"), "gateResult.sandboxExecution.runtimeProof.digest"),
    signature: digestString(dataValue(record, "signature"), "gateResult.sandboxExecution.runtimeProof.signature")
  };
}

function parseGateCommand(value: unknown): NonNullable<GateResultV2["command"]> {
  const record = exactDataRecord(
    value,
    ["executable", "args", "display"],
    ["executable", "args", "display"],
    "gateResult.command"
  );
  return {
    executable: requiredString(
      dataValue(record, "executable"),
      "gateResult.command.executable"
    ),
    args: stringArray(dataValue(record, "args"), "gateResult.command.args", {
      unique: false,
      sorted: false,
      allowEmptyStrings: true
    }),
    display: requiredString(dataValue(record, "display"), "gateResult.command.display")
  };
}

function parseGateTool(value: unknown): NonNullable<GateResultV2["tool"]> {
  const record = exactDataRecord(
    value,
    [
      "id",
      "version",
      "identitySchema",
      "resolvedExecutable",
      "contentDigest",
      "imageDigest"
    ],
    ["id", "version"],
    "gateResult.tool"
  );
  const identitySchema = optionalDataValue(record, "identitySchema");
  const resolvedExecutable = optionalDataValue(record, "resolvedExecutable");
  const contentDigest = optionalDataValue(record, "contentDigest");
  const imageDigest = optionalDataValue(record, "imageDigest");
  const provenance = [identitySchema, resolvedExecutable, contentDigest, imageDigest];
  if (provenance.some((item) => item !== undefined) && provenance.some((item) => item === undefined)) {
    throw new TypeError("gateResult.tool executable provenance must be complete");
  }
  if (identitySchema !== undefined && identitySchema !== "container-executable-v1") {
    throw new TypeError("gateResult.tool.identitySchema is unsupported");
  }
  return {
    id: requiredString(dataValue(record, "id"), "gateResult.tool.id"),
    version: requiredString(dataValue(record, "version"), "gateResult.tool.version"),
    ...(identitySchema === undefined
      ? {}
      : {
          identitySchema: "container-executable-v1" as const,
          resolvedExecutable: requiredString(
            resolvedExecutable,
            "gateResult.tool.resolvedExecutable"
          ),
          contentDigest: digestString(contentDigest, "gateResult.tool.contentDigest"),
          imageDigest: digestString(imageDigest, "gateResult.tool.imageDigest")
        })
  };
}

function artifactArray(value: unknown): GateArtifactV2[] {
  const values = denseDataArray(value, "gateResult.artifacts");
  const identifiers = new Set<string>();
  return values.map((artifact, index) => {
    const path = `gateResult.artifacts[${index}]`;
    const record = exactDataRecord(
      artifact,
      ["id", "kind", "contentType", "digest", "byteLength", "handle", "path"],
      ["id", "kind", "contentType", "digest", "byteLength"],
      path
    );
    const id = requiredString(dataValue(record, "id"), `${path}.id`);
    if (identifiers.has(id)) throw new TypeError("gateResult.artifacts contains duplicate ids");
    identifiers.add(id);
    const kind = requiredString(dataValue(record, "kind"), `${path}.kind`);
    if (!GATE_ARTIFACT_KINDS.has(kind as GateArtifactV2["kind"])) {
      throw new TypeError(`${path}.kind is unsupported`);
    }
    const byteLength = dataValue(record, "byteLength");
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
      throw new TypeError(`${path}.byteLength must be a non-negative safe integer`);
    }
    const artifactHandle = optionalDataValue(record, "handle");
    const artifactPath = optionalDataValue(record, "path");
    return {
      id,
      kind: kind as GateArtifactV2["kind"],
      contentType: requiredString(dataValue(record, "contentType"), `${path}.contentType`),
      digest: digestString(dataValue(record, "digest"), `${path}.digest`),
      byteLength: byteLength as number,
      ...(artifactHandle === undefined
        ? {}
        : { handle: requiredString(artifactHandle, `${path}.handle`) }),
      ...(artifactPath === undefined
        ? {}
        : { path: requiredString(artifactPath, `${path}.path`) })
    };
  });
}

function exactDataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain data object`);
  }
  const allowedSet = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      throw new TypeError(`${path} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
    if (descriptor.value === undefined) {
      throw new TypeError(`${path}.${key} must be omitted instead of undefined`);
    }
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${path}.${field} is required`);
    }
  }
  return value as Record<string, unknown>;
}

function dataValue(record: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${field} is missing or unsafe`);
  }
  return descriptor.value;
}

function optionalDataValue(
  record: Record<string, unknown>,
  field: string
): unknown | undefined {
  return Object.prototype.hasOwnProperty.call(record, field)
    ? dataValue(record, field)
    : undefined;
}

function denseDataArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const result: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= value.length
    ) {
      throw new TypeError(`${path} contains a non-index property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${path} must be dense data array`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function stringArray(
  value: unknown,
  path: string,
  options: { unique: boolean; sorted: boolean; allowEmptyStrings: boolean }
): string[] {
  const strings = denseDataArray(value, path).map((item, index) => {
    if (typeof item !== "string" || item.includes("\0")) {
      throw new TypeError(`${path}[${index}] must be a string without NUL`);
    }
    if (!options.allowEmptyStrings && (item.length === 0 || item !== item.trim())) {
      throw new TypeError(`${path}[${index}] must be a trimmed non-empty string`);
    }
    return item;
  });
  if (options.unique && new Set(strings).size !== strings.length) {
    throw new TypeError(`${path} must not contain duplicates`);
  }
  if (
    options.sorted &&
    strings.some((item, index) => index > 0 && compareCodeUnits(strings[index - 1]!, item) > 0)
  ) {
    throw new TypeError(`${path} must be sorted deterministically`);
  }
  return strings;
}

function requiredString(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new TypeError(`${path} must be a trimmed non-empty string without NUL`);
  }
  return value;
}

function digestString(value: unknown, path: string): string {
  const digest = requiredString(value, path);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError(`${path} must be lowercase SHA-256`);
  }
  return digest;
}

function timestampString(value: unknown, path: string): string {
  const timestamp = requiredString(value, path);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${path} must be a canonical UTC timestamp`);
  }
  return timestamp;
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
      kind: "test-report",
      path: artifact.path ?? `mn://gate-artifacts/${artifact.id}`,
      sha256: artifact.digest,
      contentType: artifact.contentType
    }))
  };
}

async function detectProjectLanguage(cwd: string): Promise<string> {
  const candidates: ReadonlyArray<readonly [string, string]> = [
    ["package.json", "typescript"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["pom.xml", "java"],
    ["build.gradle", "java"],
    ["build.gradle.kts", "kotlin"]
  ];
  const { access } = await import("node:fs/promises");
  for (const [marker, language] of candidates) {
    try {
      await access(`${cwd.replace(/\/+$/u, "")}/${marker}`);
      return language;
    } catch {
      // Continue to the next marker.
    }
  }
  return "unknown";
}

async function probeToolVersion(
  executable: string,
  args: readonly string[]
): Promise<string> {
  try {
    const result = await execFileAsync(executable, [...args], {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    return `${result.stdout}${result.stderr}`.split(/\r?\n/u).find(Boolean)?.trim() ?? "unknown";
  } catch {
    return "unknown";
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
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
  throw new TypeError("Gate evidence must contain canonical JSON values");
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
