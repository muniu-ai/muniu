import type {
  AgentProvider,
  AgentRunInput,
  AgentRunResult
} from "@mn/core";
import { buildRunPrompt } from "@mn/core";
import {
  buildClaudeCodeArgs,
  buildCodexArgs,
  type AgentExecutor
} from "@mn/executors";
import type {
  DockerSandboxCommandResult,
  DockerSandboxExecuteRequest
} from "./dockerSandboxBackend.js";

/** Structural surface intentionally shared with remote/container brokers. */
export interface DockerAgentSandbox {
  workspaceRoot(leaseId: string): string;
  containerPath(leaseId: string, hostPath: string): string;
  execute(
    leaseId: string,
    request: DockerSandboxExecuteRequest & { readonly stdin?: string }
  ): Promise<DockerSandboxCommandResult>;
}

export interface DockerSandboxAgentExecutorOptions {
  readonly provider: AgentProvider;
  readonly backend: DockerAgentSandbox;
  readonly leaseId: string;
  readonly binary?: string;
  readonly mock?: boolean;
  /** E2E-only deterministic repair: first attempt touches a protected file,
   * second attempt changes an owned service file. Both commands still execute
   * inside the inspected runtime. */
  readonly mockRepair?: boolean;
}

/** Runs the managed coding application through the exact same inspected
 * sandbox lease used by governed command Gates. */
export class DockerSandboxAgentExecutor implements AgentExecutor {
  readonly provider: AgentProvider;
  readonly #backend: DockerAgentSandbox;
  readonly #leaseId: string;
  readonly #binary: string;
  readonly #mock: boolean;
  readonly #mockRepair: boolean;
  #invocations = 0;

  constructor(options: DockerSandboxAgentExecutorOptions) {
    this.provider = options.provider;
    this.#backend = options.backend;
    this.#leaseId = options.leaseId;
    this.#binary = options.binary ??
      (options.provider === "claude"
        ? process.env.MN_CLAUDE_BINARY ?? "claude"
        : process.env.MN_CODEX_BINARY ?? "codex");
    this.#mock = options.mock ?? false;
    this.#mockRepair = options.mockRepair ?? false;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    if (input.abortSignal?.aborted) {
      return resultFromCommand(
        input,
        { exitCode: null, stdout: "", stderr: "Sandbox candidate cancelled." },
        startedAt,
        "cancelled"
      );
    }
    this.#invocations += 1;
    const command = this.#command(input);
    const execution = await this.#backend.execute(this.#leaseId, {
      executable: command.executable,
      args: command.args,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds,
      env: safeCandidateEnvironment(input.env),
      ...(command.stdin ? { stdin: command.stdin } : {}),
      ...(input.abortSignal ? { signal: input.abortSignal } : {})
    });
    const timestamp = new Date().toISOString();
    if (execution.stdout) {
      input.onEvent?.({
        runId: input.runId,
        candidateId: input.candidateId,
        type: "stdout",
        message: execution.stdout,
        timestamp
      });
    }
    if (execution.stderr) {
      input.onEvent?.({
        runId: input.runId,
        candidateId: input.candidateId,
        type: "stderr",
        message: execution.stderr,
        timestamp
      });
    }
    const status = input.abortSignal?.aborted
      ? "cancelled" as const
      : execution.exitCode === 0
        ? "completed" as const
        : "failed" as const;
    return resultFromCommand(input, execution, startedAt, status);
  }

  #command(input: AgentRunInput): {
    executable: string;
    args: string[];
    stdin?: string;
  } {
    if (this.#mock) {
      const script = this.#mockRepair
        ? this.#invocations === 1
          ? [
              "const fs=require('node:fs');",
              "fs.appendFileSync('.github/CODEOWNERS','\\n# governed sandbox repair probe\\n');",
              "process.stdout.write('mock protected-path attempt\\n');"
            ].join("")
          : [
              "const fs=require('node:fs');",
              "fs.appendFileSync('services/orders/src/server.mjs','\\n// governed sandbox repair\\n');",
              "process.stdout.write('mock governed repair completed\\n');"
            ].join("")
        : "process.stdout.write('mock governed candidate completed\\n')";
      return { executable: "node", args: ["-e", script] };
    }
    const prompt = buildRunPrompt(input.context);
    if (this.provider === "claude") {
      return {
        executable: this.#binary,
        args: buildClaudeCodeArgs({ model: input.model }),
        stdin: prompt
      };
    }
    return {
      executable: this.#binary,
      args: buildCodexArgs({
        cwd: this.#backend.containerPath(this.#leaseId, input.cwd),
        prompt,
        model: input.model,
        sandbox: "workspace-write",
        approvalMode: "never"
      })
    };
  }
}

function safeCandidateEnvironment(
  environment: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  if (!environment) return {};
  const allowed = new Set([
    "MN_RUN_ID",
    "MN_CANDIDATE_ID",
    "MN_PROXY_BASE_URL",
    "MN_ASSOCIATED_PROXY_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "CODEX_BASE_URL",
    "MN_CODEX_BASE_URL"
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => allowed.has(name))
  );
}

function resultFromCommand(
  input: AgentRunInput,
  command: DockerSandboxCommandResult,
  startedAt: string,
  status: AgentRunResult["status"]
): AgentRunResult {
  const combined = `${command.stdout}\n${command.stderr}`.trim();
  return {
    provider: input.provider,
    candidateId: input.candidateId,
    status,
    exitCode: command.exitCode,
    stdout: command.stdout,
    stderr: command.stderr,
    summary: combined ? combined.slice(-4_000) : "No output captured.",
    artifacts: [],
    startedAt,
    finishedAt: new Date().toISOString()
  };
}
