import type {
  AgentExecutionBindingV1,
  AgentProvider,
  AgentRuntimeId,
  AgentRunInput,
  AgentRunResult
} from "@mn/core";
import { buildRunPrompt } from "@mn/core";
import { runCommand } from "./runner.js";

export interface AgentExecutor {
  provider: AgentRuntimeId;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface BuiltinAgentExecutionInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly timeoutSeconds: number;
  readonly executionBinding: AgentExecutionBindingV1;
  readonly signal?: AbortSignal;
}

export interface BuiltinAgentExecutionOutput {
  readonly reason: "completed" | "cancelled" | "budget-exceeded" | "error" | string;
  readonly summary: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly executionBinding?: AgentExecutionBindingV1;
}

export interface BuiltinAgentRunner {
  run(input: BuiltinAgentExecutionInput): Promise<BuiltinAgentExecutionOutput>;
}

export class BuiltinAgentExecutor implements AgentExecutor {
  readonly provider = "builtin" as const;

  constructor(private readonly runner: BuiltinAgentRunner) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const providerId = input.providerId;
    const modelId = input.modelId ?? input.model;
    const sessionId = input.sessionId;
    const executionBinding = input.executionBinding;
    if (!providerId || !modelId || !sessionId || !executionBinding) {
      throw new TypeError("builtin executor requires provider, model, session, and execution bindings");
    }
    const output = await this.runner.run({
      sessionId,
      runId: input.runId,
      candidateId: input.candidateId,
      cwd: input.cwd,
      prompt: input.prompt,
      providerId,
      modelId,
      timeoutSeconds: input.timeoutSeconds,
      executionBinding,
      ...(input.abortSignal === undefined ? {} : { signal: input.abortSignal })
    });
    const resolvedProviderId = output.providerId ?? providerId;
    const resolvedModelId = output.modelId ?? modelId;
    const resolvedBinding = output.executionBinding ?? executionBinding;
    const cancelled = input.abortSignal?.aborted || output.reason === "cancelled";
    const completed = output.reason === "completed";
    const summary = output.summary || `Embedded Agent finished after ${output.steps} steps and ${output.toolCalls} tool calls.`;
    input.onEvent?.({
      runId: input.runId,
      candidateId: input.candidateId,
      type: completed ? "stdout" : "error",
      message: summary,
      timestamp: new Date().toISOString(),
      data: { sessionId, steps: output.steps, toolCalls: output.toolCalls, reason: output.reason }
    });
    return {
      provider: "builtin",
      runtimeId: "builtin",
      providerId: resolvedProviderId,
      modelId: resolvedModelId,
      sessionId,
      executionBinding: resolvedBinding,
      candidateId: input.candidateId,
      status: cancelled ? "cancelled" : completed ? "completed" : "failed",
      exitCode: cancelled ? null : completed ? 0 : 1,
      stdout: completed ? summary : "",
      stderr: completed ? "" : summary,
      summary,
      artifacts: [],
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

export interface ClaudeCodeArgsOptions {
  model?: string;
  permissionMode?: string;
}

export interface CodexArgsOptions {
  cwd: string;
  prompt: string;
  model?: string;
  sandbox?: string;
  approvalMode?: string;
}

function summarize(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return "No output captured.";
  return combined.slice(-4000);
}

export function buildClaudeCodeArgs(options: ClaudeCodeArgsOptions = {}): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    options.permissionMode ?? "default"
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  return args;
}

export function buildCodexArgs(options: CodexArgsOptions): string[] {
  const args = [
    "--ask-for-approval",
    options.approvalMode ?? "never"
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(
    "exec",
    "--cd",
    options.cwd,
    "--sandbox",
    options.sandbox ?? "workspace-write",
    "--skip-git-repo-check",
    "--ephemeral",
    options.prompt
  );

  return args;
}

export class ClaudeCodeExecutor implements AgentExecutor {
  provider = "claude" as const;

  constructor(
    private readonly binary = process.env.MN_CLAUDE_BINARY ?? "claude",
    private readonly permissionMode =
      process.env.MN_CLAUDE_PERMISSION_MODE ?? "default"
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const args = buildClaudeCodeArgs({
      model: input.model,
      permissionMode: this.permissionMode
    });

    const result = await runCommand({
      command: this.binary,
      args,
      cwd: input.cwd,
      env: input.env,
      stdin: buildRunPrompt(input.context),
      timeoutSeconds: input.timeoutSeconds,
      onEvent: input.onEvent,
      runId: input.runId,
      candidateId: input.candidateId,
      signal: input.abortSignal,
      outputCheckpoint: input.outputCheckpoint
    });

    return {
      provider: this.provider,
      candidateId: input.candidateId,
      status: result.exitCode === 0 ? "completed" : "failed",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: summarize(result.stdout, result.stderr),
      artifacts: [],
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

export class CodexExecutor implements AgentExecutor {
  provider = "codex" as const;

  constructor(
    private readonly binary = process.env.MN_CODEX_BINARY ?? "codex",
    private readonly sandbox = process.env.MN_CODEX_SANDBOX ?? "workspace-write",
    private readonly approvalMode = process.env.MN_CODEX_APPROVAL ?? "never"
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const args = buildCodexArgs({
      cwd: input.cwd,
      prompt: buildRunPrompt(input.context),
      model: input.model,
      sandbox: this.sandbox,
      approvalMode: this.approvalMode
    });

    const result = await runCommand({
      command: this.binary,
      args,
      cwd: input.cwd,
      env: input.env,
      timeoutSeconds: input.timeoutSeconds,
      onEvent: input.onEvent,
      runId: input.runId,
      candidateId: input.candidateId,
      signal: input.abortSignal,
      outputCheckpoint: input.outputCheckpoint
    });

    return {
      provider: this.provider,
      candidateId: input.candidateId,
      status: result.exitCode === 0 ? "completed" : "failed",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: summarize(result.stdout, result.stderr),
      artifacts: [],
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

export class MockExecutor implements AgentExecutor {
  constructor(
    public readonly provider: AgentRuntimeId,
    private readonly exitCode = 0
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    if (input.abortSignal?.aborted) {
      return {
        provider: this.provider,
        candidateId: input.candidateId,
        status: "cancelled",
        exitCode: null,
        stdout: "",
        stderr: "Mock executor cancelled before start.",
        summary: `Mock ${this.provider} executor cancelled candidate ${input.candidateId}`,
        artifacts: [],
        startedAt,
        finishedAt: new Date().toISOString()
      };
    }

    input.onEvent?.({
      runId: input.runId,
      candidateId: input.candidateId,
      type: "stdout",
      message: `mock ${this.provider} completed`,
      timestamp: startedAt
    });

    return {
      provider: this.provider,
      candidateId: input.candidateId,
      status: this.exitCode === 0 ? "completed" : "failed",
      exitCode: this.exitCode,
      stdout: `mock ${this.provider} completed`,
      stderr: "",
      summary: `Mock ${this.provider} executor completed candidate ${input.candidateId}`,
      artifacts: [],
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

export function createDefaultExecutors(
  builtinRunner?: BuiltinAgentRunner
): Partial<Record<AgentRuntimeId, AgentExecutor>> {
  return {
    ...(builtinRunner ? { builtin: new BuiltinAgentExecutor(builtinRunner) } : {}),
    claude: new ClaudeCodeExecutor(),
    codex: new CodexExecutor()
  };
}
