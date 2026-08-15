import { randomUUID } from "node:crypto";
import type {
  AgentProvider,
  AgentTask,
  CandidateOutputCheckpoint,
  Project,
  RunEvent,
  RunRecord
} from "@mn/core";
import {
  buildArchitectureBrief,
  createRunContext,
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
  executors: Record<AgentProvider, AgentExecutor>;
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

    const providers = selectProviders(task.strategy.providers, task.strategy.candidates);

    for (let index = 0; index < providers.length; index += 1) {
      if (execution.abortSignal?.aborted) {
        return this.cancel(record, "Run cancelled before next candidate");
      }

      const provider = providers[index]!;
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
        const workspace = await (
          this.options.candidateWorkspacePreparer ?? prepareCandidateWorkspace
        )({
          projectRoot: project.rootPath,
          workspaceRoot: this.options.workspaceRoot,
          runId,
          candidateId,
          isolated: task.strategy.sandbox === "isolated-worktree"
        });

        candidate = {
          id: candidateId,
          runId,
          provider,
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
          this.options.proxyBaseUrl && this.options.resolveProxyAssociationReceipt
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

function selectProviders(
  providers: AgentProvider[],
  candidates: number
): AgentProvider[] {
  const selected: AgentProvider[] = [];
  for (let index = 0; index < candidates; index += 1) {
    selected.push(providers[index % providers.length]!);
  }
  return selected;
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
    candidates: run.candidates.map((candidate) => ({
      ...candidate,
      runId,
      gates: candidate.gates.map((gate) => ({
        ...gate,
        evidence: gate.evidence.map((artifact) => ({ ...artifact }))
      })),
      result: candidate.result
        ? {
            ...candidate.result,
            artifacts: candidate.result.artifacts.map((artifact) => ({
              ...artifact
            }))
          }
        : undefined
    })),
    updatedAt
  };
}

function buildCandidateExecutionEnv(input: {
  provider: AgentProvider;
  runId: string;
  candidateId: string;
  proxyBaseUrl?: string;
  proxyAssociationReceipt?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    MN_RUN_ID: input.runId,
    MN_CANDIDATE_ID: input.candidateId
  };
  if (!input.proxyBaseUrl) return env;

  const proxyRoot = input.proxyBaseUrl.replace(/\/+$/, "");
  const associatedRoot = input.proxyAssociationReceipt
    ? `${proxyRoot}/mn/usage-receipts/${encodeURIComponent(input.proxyAssociationReceipt)}`
    : `${proxyRoot}/mn/runs/${encodeURIComponent(input.runId)}/candidates/${encodeURIComponent(input.candidateId)}`;
  env.MN_PROXY_BASE_URL = proxyRoot;
  env.MN_ASSOCIATED_PROXY_BASE_URL = associatedRoot;

  if (input.provider === "claude") {
    env.ANTHROPIC_BASE_URL = associatedRoot;
  } else {
    const codexBaseUrl = `${associatedRoot}/v1`;
    env.OPENAI_BASE_URL = codexBaseUrl;
    env.OPENAI_API_BASE = codexBaseUrl;
    env.CODEX_BASE_URL = codexBaseUrl;
    env.MN_CODEX_BASE_URL = codexBaseUrl;
  }

  return env;
}
