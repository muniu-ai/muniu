import { createHash, randomUUID } from "node:crypto";
import type {
  AgentExecutionBindingV1,
  AgentProvider,
  AgentRuntimeId,
  AgentTask,
  CandidateOutputCheckpoint,
  Project,
  RunEvent,
  RunRecord
} from "@mn/core";
import {
  buildArchitectureBrief,
  createRunContext,
  executionTargets,
  requiresHumanApproval,
  selectWinner,
  transitionRun
} from "@mn/core";
import type { AgentExecutor } from "@mn/executors";
import { compareCandidates } from "@mn/verifier";
import { runGateEngine } from "./gateEngine.js";
import {
  prepareCandidateWorkspace,
  type CandidateWorkspacePreparer
} from "./workspace.js";

export interface RunOrchestratorOptions {
  workspaceRoot: string;
  executors: Partial<Record<AgentRuntimeId, AgentExecutor>>;
  proxyBaseUrl?: string;
  /** API-issued enterprise receipt resolved for the exact candidate before
   * the managed app can contact the provider proxy. */
  resolveProxyAssociationReceipt?: (input: {
    runId: string;
    candidateId: string;
    provider: AgentProvider;
  }) => Promise<string>;
  candidateWorkspacePreparer?: CandidateWorkspacePreparer;
  onEvent?: (event: RunEvent) => void;
  onUpdate?: (record: RunRecord) => void;
}

export interface RunExecutionOptions {
  runId?: string;
  resumeFrom?: RunRecord;
  abortSignal?: AbortSignal;
  /** Reuse an Agent session for a bounded repair attempt while issuing a new
   * execution binding for the current run/candidate record. */
  sessionIds?: readonly (string | undefined)[];
  /** Reuse the exact candidate workspace that the failed Gate inspected. */
  candidateWorkspacePaths?: readonly (string | undefined)[];
}

export class RunOrchestrator {
  constructor(private readonly options: RunOrchestratorOptions) {}

  async run(
    project: Project,
    task: AgentTask,
    execution: RunExecutionOptions = {}
  ): Promise<RunRecord> {
    const runId = execution.runId ?? randomUUID();
    const now = new Date().toISOString();
    const record: RunRecord = execution.resumeFrom
      ? cloneRunForResume(execution.resumeFrom, runId, now)
      : {
          id: runId,
          taskId: task.id,
          projectId: project.id,
          status: "queued",
          candidates: [],
          gates: [],
          createdAt: now,
          updatedAt: now
        };
    this.update(record);

    if (execution.abortSignal?.aborted) {
      return this.cancel(record, "Run cancelled before start");
    }

    record.status = transitionRun(record.status, "preparing");
    record.updatedAt = new Date().toISOString();
    this.update(record);
    this.emit(runId, "status", "Preparing run");

    const context = createRunContext({ project, task });
    context.architectureBrief = buildArchitectureBrief(context);

    if (execution.abortSignal?.aborted) {
      return this.cancel(record, "Run cancelled while preparing");
    }

    record.status = transitionRun(record.status, "running");
    record.updatedAt = new Date().toISOString();
    this.update(record);
    this.emit(runId, "status", "Running candidates");

    const targets = selectExecutionTargets(task);

    for (let index = 0; index < targets.length; index += 1) {
      if (execution.abortSignal?.aborted) {
        return this.cancel(record, "Run cancelled before next candidate");
      }

      const target = targets[index]!;
      const provider = target.runtimeId;
      const candidateId = `${provider}-${index + 1}`;
      let candidate = record.candidates.find(
        (candidate) => candidate.id === candidateId
      );
      if (candidate) {
        if (
          candidate.status === "completed" &&
          candidate.result
        ) {
          this.emit(
            runId,
            "status",
            `Skipping checkpointed candidate ${candidateId}`,
            candidateId,
            { checkpointed: true }
          );
          continue;
        }

        if (candidate.status !== "queued" || candidate.result) {
          throw new Error(
            `Cannot checkpoint-resume started candidate ${candidateId}`
          );
        }

        this.emit(
          runId,
          "status",
          `Resuming queued checkpointed candidate ${candidateId}`,
          candidateId,
          { checkpointed: true }
        );
      }

      const executor = this.options.executors[provider];
      if (!executor) throw new Error(`No executor configured for ${provider}`);

      if (!candidate) {
        const reusedWorkspacePath = execution.candidateWorkspacePaths?.[index];
        const workspace = reusedWorkspacePath === undefined
          ? await (
              this.options.candidateWorkspacePreparer ?? prepareCandidateWorkspace
            )({
              projectRoot: project.rootPath,
              workspaceRoot: this.options.workspaceRoot,
              runId,
              candidateId,
              isolated: task.strategy.sandbox === "isolated-worktree"
            })
          : { path: reusedWorkspacePath };

        candidate = {
          id: candidateId,
          runId,
          provider,
          runtimeId: target.runtimeId,
          ...(target.providerId === undefined ? {} : { providerId: target.providerId }),
          ...(target.modelId === undefined ? {} : { modelId: target.modelId }),
          worktreePath: workspace.path,
          outputCheckpoint: buildCandidateOutputCheckpoint({
            workspaceRoot: this.options.workspaceRoot,
            runId,
            candidateId
          }),
          status: "queued",
          gates: []
        };
        record.candidates.push(candidate);
        record.updatedAt = new Date().toISOString();
        this.update(record);
        this.emit(runId, "status", `Candidate ${candidateId} queued`, candidateId);
      }

      candidate.outputCheckpoint ??= buildCandidateOutputCheckpoint({
        workspaceRoot: this.options.workspaceRoot,
        runId,
        candidateId
      });
      candidate.executionBinding ??= createExecutionBinding({
        runId,
        candidateId,
        target,
        task,
        ...(execution.sessionIds?.[index] === undefined
          ? {}
          : { sessionId: execution.sessionIds[index] })
      });
      candidate.status = "running";
      candidate.outputCheckpoint = {
        ...candidate.outputCheckpoint,
        startedAt: candidate.outputCheckpoint.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      record.updatedAt = new Date().toISOString();
      this.update(record);

      try {
        const proxyAssociationReceipt =
          provider !== "builtin" && this.options.proxyBaseUrl && this.options.resolveProxyAssociationReceipt
            ? await this.options.resolveProxyAssociationReceipt({
                runId,
                candidateId,
                provider
              })
            : undefined;
        const result = await executor.run({
          runId,
          candidateId,
          provider,
          runtimeId: target.runtimeId,
          ...(target.providerId === undefined ? {} : { providerId: target.providerId }),
          ...(target.modelId === undefined ? {} : { modelId: target.modelId }),
          model: target.modelId,
          sessionId: candidate.executionBinding.sessionId,
          executionBinding: candidate.executionBinding,
          cwd: candidate.worktreePath,
          prompt: task.prompt,
          context,
          timeoutSeconds: task.strategy.timeoutSeconds,
          env: buildCandidateExecutionEnv({
            provider,
            runId,
            candidateId,
            proxyBaseUrl: this.options.proxyBaseUrl,
            proxyAssociationReceipt
          }),
          outputCheckpoint: candidate.outputCheckpoint,
          onEvent: this.options.onEvent,
          abortSignal: execution.abortSignal
        });

        if (execution.abortSignal?.aborted || result.status === "cancelled") {
          candidate.result = result;
          candidate.status = "cancelled";
          record.updatedAt = new Date().toISOString();
          this.update(record);
          return this.cancel(record, "Run cancelled during candidate execution");
        }

        candidate.result = result;
        if (result.providerId !== undefined) candidate.providerId = result.providerId;
        if (result.modelId !== undefined) candidate.modelId = result.modelId;
        if (result.executionBinding !== undefined) {
          candidate.executionBinding = result.executionBinding;
        }
        candidate.status = result.status;
        candidate.gates = await runGateEngine({
          cwd: candidate.worktreePath,
          requiredGates: task.strategy.requiredGates,
          stdout: result.stdout,
          stderr: result.stderr,
          runId,
          candidateId,
          onEvent: this.options.onEvent,
          abortSignal: execution.abortSignal
        });

        if (execution.abortSignal?.aborted) {
          candidate.status = "cancelled";
          record.updatedAt = new Date().toISOString();
          this.update(record);
          return this.cancel(record, "Run cancelled during gates");
        }

        for (const gate of candidate.gates) {
          this.emit(
            runId,
            "gate",
            `${candidate.id} ${gate.gate}: ${gate.status}`,
            candidate.id,
            gate
          );
        }
      } catch (error) {
        candidate.status = "failed";
        candidate.gates.push({
          gate: "llm_verifier",
          status: "fail",
          summary: error instanceof Error ? error.message : String(error),
          evidence: []
        });
      }

      record.updatedAt = new Date().toISOString();
      this.update(record);
    }

    if (execution.abortSignal?.aborted) {
      return this.cancel(record, "Run cancelled before verification");
    }

    record.status = transitionRun(record.status, "verifying");
    record.updatedAt = new Date().toISOString();
    this.update(record);
    this.emit(runId, "status", "Verifying candidates");

    const comparison = compareCandidates(record.candidates);
    record.winnerCandidateId =
      comparison.winnerCandidateId ?? selectWinner(record.candidates)?.id;
    record.gates = record.candidates.flatMap((candidate) => candidate.gates);

    if (requiresHumanApproval(task) && record.winnerCandidateId) {
      record.status = transitionRun(record.status, "waiting_approval");
    } else {
      record.status = transitionRun(
        record.status,
        record.winnerCandidateId ? "completed" : "failed"
      );
    }

    record.updatedAt = new Date().toISOString();
    this.update(record);
    this.emit(runId, "status", `Run ${record.status}`);
    return record;
  }

  private cancel(record: RunRecord, message: string): RunRecord {
    record.status = transitionRun(record.status, "cancelled");
    for (const candidate of record.candidates) {
      if (candidate.status === "queued" || candidate.status === "running") {
        candidate.status = "cancelled";
      }
    }
    record.updatedAt = new Date().toISOString();
    this.update(record);
    this.emit(record.id, "status", message);
    return record;
  }

  private update(record: RunRecord): void {
    this.options.onUpdate?.(record);
  }

  private emit(
    runId: string,
    type: RunEvent["type"],
    message: string,
    candidateId?: string,
    data?: unknown
  ): void {
    this.options.onEvent?.({
      runId,
      candidateId,
      type,
      message,
      timestamp: new Date().toISOString(),
      data
    });
  }
}

interface SelectedExecutionTarget {
  readonly runtimeId: AgentRuntimeId;
  readonly providerId?: string;
  readonly modelId?: string;
}

function selectExecutionTargets(task: AgentTask): SelectedExecutionTarget[] {
  return executionTargets(task.strategy).flatMap((target) =>
    Array.from({ length: target.candidates }, () => ({
      runtimeId: target.runtimeId,
      ...(target.providerId === undefined ? {} : { providerId: target.providerId }),
      ...(target.modelId === undefined ? {} : { modelId: target.modelId })
    }))
  );
}

function semanticDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function createExecutionBinding(input: {
  readonly runId: string;
  readonly candidateId: string;
  readonly target: SelectedExecutionTarget;
  readonly task: AgentTask;
  readonly sessionId?: string;
}): AgentExecutionBindingV1 {
  const sessionId = input.sessionId ?? `agent-${semanticDigest({
    runId: input.runId,
    candidateId: input.candidateId
  }).slice(0, 40)}`;
  return Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    candidateId: input.candidateId,
    sessionId,
    runtimeId: input.target.runtimeId,
    ...(input.target.providerId === undefined ? {} : { providerId: input.target.providerId }),
    ...(input.target.modelId === undefined ? {} : { modelId: input.target.modelId }),
    harnessDigest: input.task.harnessProfileRef?.digest ?? semanticDigest({
      harnessProfileRef: input.task.harnessProfileRef ?? "classic"
    }),
    governanceDigest: input.task.workflowRef?.digest ?? semanticDigest({
      workflowRef: input.task.workflowRef ?? "classic-v1",
      specRef: input.task.specRef ?? null
    }),
    effectPolicyDigest: semanticDigest({
      sandbox: input.task.strategy.sandbox,
      requiredGates: input.task.strategy.requiredGates,
      humanApproval: input.task.strategy.humanApproval,
      timeoutSeconds: input.task.strategy.timeoutSeconds
    }),
    sandboxCapabilityId: input.task.strategy.sandbox
  });
}

function buildCandidateOutputCheckpoint(input: {
  workspaceRoot: string;
  runId: string;
  candidateId: string;
}): CandidateOutputCheckpoint {
  const base = `${input.workspaceRoot.replace(/\/+$/, "")}/checkpoints/${encodeURIComponent(input.runId)}/${encodeURIComponent(input.candidateId)}`;
  return {
    stdoutPath: `${base}/stdout.txt`,
    stderrPath: `${base}/stderr.txt`
  };
}

function cloneRunForResume(
  run: RunRecord,
  runId: string,
  updatedAt: string
): RunRecord {
  return {
    ...run,
    id: runId,
    status: "queued",
    gates: [],
    candidates: run.candidates.map((candidate) => {
      const { executionBinding: _binding, result, ...base } = candidate;
      return {
        ...base,
        runId,
        gates: candidate.gates.map((gate) => ({
          ...gate,
          evidence: gate.evidence.map((artifact) => ({ ...artifact }))
        })),
        ...(result === undefined
          ? {}
          : {
              result: {
                ...result,
                artifacts: result.artifacts.map((artifact) => ({ ...artifact }))
              }
            })
      };
    }),
    updatedAt
  };
}

function buildCandidateExecutionEnv(input: {
  provider: AgentRuntimeId;
  runId: string;
  candidateId: string;
  proxyBaseUrl?: string;
  proxyAssociationReceipt?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    MN_RUN_ID: input.runId,
    MN_CANDIDATE_ID: input.candidateId
  };
  if (!input.proxyBaseUrl || input.provider === "builtin") return env;

  const proxyRoot = input.proxyBaseUrl.replace(/\/+$/, "");
  const associatedRoot = input.proxyAssociationReceipt
    ? `${proxyRoot}/mn/usage-receipts/${encodeURIComponent(input.proxyAssociationReceipt)}`
    : `${proxyRoot}/mn/runs/${encodeURIComponent(input.runId)}/candidates/${encodeURIComponent(input.candidateId)}`;
  env.MN_PROXY_BASE_URL = proxyRoot;
  env.MN_ASSOCIATED_PROXY_BASE_URL = associatedRoot;

  if (input.provider === "claude") {
    env.ANTHROPIC_BASE_URL = associatedRoot;
  } else if (input.provider === "codex") {
    const codexBaseUrl = `${associatedRoot}/v1`;
    env.OPENAI_BASE_URL = codexBaseUrl;
    env.OPENAI_API_BASE = codexBaseUrl;
    env.CODEX_BASE_URL = codexBaseUrl;
    env.MN_CODEX_BASE_URL = codexBaseUrl;
  }

  return env;
}
