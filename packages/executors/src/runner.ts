import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CandidateOutputCheckpoint, RunEvent } from "@mn/core";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutSeconds: number;
  onEvent?: (event: RunEvent) => void;
  runId: string;
  candidateId: string;
  signal?: AbortSignal;
  outputCheckpoint?: CandidateOutputCheckpoint;
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve) => {
    initializeOutputCheckpoint(spec.outputCheckpoint);
    if (spec.signal?.aborted) {
      appendOutputCheckpoint(
        spec.outputCheckpoint?.stderrPath,
        "Command cancelled before start."
      );
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "Command cancelled before start."
      });
      return;
    }

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const emit = (
      type: "stdout" | "stderr" | "error",
      message: string,
      data?: unknown
    ): void => {
      spec.onEvent?.({
        runId: spec.runId,
        candidateId: spec.candidateId,
        type,
        message,
        timestamp: new Date().toISOString(),
        data
      });
    };

    const abort = (): void => {
      if (finished) return;
      stderr += "\nCommand cancelled.";
      appendOutputCheckpoint(spec.outputCheckpoint?.stderrPath, "\nCommand cancelled.");
      emit("error", "Command cancelled.");
      child.kill("SIGTERM");
    };
    spec.signal?.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(() => {
      if (!finished) {
        const message = `\nCommand timed out after ${spec.timeoutSeconds}s`;
        stderr += message;
        appendOutputCheckpoint(spec.outputCheckpoint?.stderrPath, message);
        emit("error", `Command timed out after ${spec.timeoutSeconds}s`);
        child.kill("SIGTERM");
      }
    }, spec.timeoutSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      appendOutputCheckpoint(spec.outputCheckpoint?.stdoutPath, text);
      emit("stdout", text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      appendOutputCheckpoint(spec.outputCheckpoint?.stderrPath, text);
      emit("stderr", text);
    });

    child.on("error", (error) => {
      const message = `\n${error.message}`;
      stderr += message;
      appendOutputCheckpoint(spec.outputCheckpoint?.stderrPath, message);
      emit("error", error.message, { code: (error as NodeJS.ErrnoException).code });
    });

    child.on("close", (exitCode) => {
      finished = true;
      clearTimeout(timeout);
      spec.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, stdout, stderr });
    });

    if (spec.stdin) {
      child.stdin.write(spec.stdin);
    }

    child.stdin.end();
  });
}

function initializeOutputCheckpoint(
  checkpoint: CandidateOutputCheckpoint | undefined
): void {
  if (!checkpoint) return;
  try {
    mkdirSync(dirname(checkpoint.stdoutPath), { recursive: true });
    mkdirSync(dirname(checkpoint.stderrPath), { recursive: true });
    writeFileSync(checkpoint.stdoutPath, "", "utf8");
    writeFileSync(checkpoint.stderrPath, "", "utf8");
  } catch {
    // Output checkpointing is best-effort; command execution remains authoritative.
  }
}

function appendOutputCheckpoint(path: string | undefined, text: string): void {
  if (!path || !text) return;
  try {
    appendFileSync(path, text, "utf8");
  } catch {
    // Best-effort checkpoint writes should not mask executor results.
  }
}
