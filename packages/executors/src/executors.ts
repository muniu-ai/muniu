import type {
  AgentProvider,
  AgentRunInput,
  AgentRunResult
} from "@mn/core";
import { buildRunPrompt } from "@mn/core";
import { runCommand } from "./runner.js";

export interface AgentExecutor {
  provider: AgentProvider;
  run(input: AgentRunInput): Promise<AgentRunResult>;
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
    public readonly provider: AgentProvider,
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

export function createDefaultExecutors(): Record<AgentProvider, AgentExecutor> {
  return {
    claude: new ClaudeCodeExecutor(),
    codex: new CodexExecutor()
  };
}
