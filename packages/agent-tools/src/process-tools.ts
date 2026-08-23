// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { defineTool, type ToolDefinition, type ToolRunContext } from "./define-tool.js";

export interface ProcessLaunchInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly pty: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessExitResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error?: boolean;
}

export interface ManagedProcess {
  readonly pid?: number;
  write(data: string, close: boolean): void | Promise<void>;
  resize?(columns: number, rows: number): void | Promise<void>;
  terminate(signal: NodeJS.Signals): void | Promise<void>;
  onData(listener: (stream: "stdout" | "stderr", text: string) => void): () => void;
  onExit(listener: (result: ProcessExitResult) => void): () => void;
}

export interface ProcessBackend {
  launch(input: ProcessLaunchInput): ManagedProcess | Promise<ManagedProcess>;
}

export interface ProcessSupervisorOptions {
  readonly allowedExecutables: readonly string[];
  readonly ptyBackend?: ProcessBackend;
  readonly maxProcessesPerSession?: number;
  readonly maxOutputBytesPerProcess?: number;
  readonly maxInputBytes?: number;
}

export interface ProcessStartRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly pty?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export interface ProcessOutputEntry {
  readonly cursor: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

interface ProcessRecord {
  readonly processId: string;
  readonly sessionId: string;
  readonly process: ManagedProcess;
  readonly entries: ProcessOutputEntry[];
  readonly settled: Promise<ProcessExitResult>;
  resolve: (result: ProcessExitResult) => void;
  status: "running" | "completed" | "terminated" | "failed";
  outputBytes: number;
  nextCursor: number;
  truncated: boolean;
  exit?: ProcessExitResult;
  cleanup?: () => void;
}

const SIGNALS = new Set<NodeJS.Signals>(["SIGTERM", "SIGINT", "SIGKILL"]);

function inside(root: string, target: string): boolean {
  const candidate = relative(root, target);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

async function boundDirectory(workspace: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || isAbsolute(input)) {
    throw new Error("process cwd must be a non-empty relative path");
  }
  const root = await realpath(resolve(workspace));
  const lexical = resolve(root, input);
  if (!inside(root, lexical)) throw new Error("process cwd is outside the workspace");
  const canonical = await realpath(lexical);
  if (!inside(root, canonical)) throw new Error("process cwd is outside the workspace");
  const stats = await lstat(canonical);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("process cwd must be a directory");
  return canonical;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function argumentsList(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("process arguments must be strings without NUL bytes");
  }
  return Object.freeze([...value]);
}

class NodePipeProcess implements ManagedProcess {
  constructor(readonly child: ChildProcessWithoutNullStreams) {}

  get pid(): number | undefined { return this.child.pid; }

  write(data: string, close: boolean): void {
    if (this.child.stdin.destroyed) throw new Error("process stdin is closed");
    if (data.length > 0) this.child.stdin.write(data, "utf8");
    if (close) this.child.stdin.end();
  }

  terminate(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  onData(listener: (stream: "stdout" | "stderr", text: string) => void): () => void {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    const stdout = (text: string) => listener("stdout", text);
    const stderr = (text: string) => listener("stderr", text);
    this.child.stdout.on("data", stdout);
    this.child.stderr.on("data", stderr);
    return () => {
      this.child.stdout.off("data", stdout);
      this.child.stderr.off("data", stderr);
    };
  }

  onExit(listener: (result: ProcessExitResult) => void): () => void {
    let settled = false;
    const finish = (result: ProcessExitResult) => {
      if (settled) return;
      settled = true;
      listener(result);
    };
    const close = (exitCode: number | null, signal: NodeJS.Signals | null) => finish({ exitCode, signal });
    const error = () => finish({ exitCode: null, signal: null, error: true });
    this.child.once("close", close);
    this.child.once("error", error);
    return () => {
      this.child.off("close", close);
      this.child.off("error", error);
    };
  }
}

class NodePipeBackend implements ProcessBackend {
  launch(input: ProcessLaunchInput): ManagedProcess {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return new NodePipeProcess(child);
  }
}

export class ProcessSupervisor {
  readonly #allowedExecutables: ReadonlySet<string>;
  readonly #pipeBackend: ProcessBackend = new NodePipeBackend();
  readonly #ptyBackend?: ProcessBackend;
  readonly #maxProcessesPerSession: number;
  readonly #maxOutputBytesPerProcess: number;
  readonly #maxInputBytes: number;
  readonly #records = new Map<string, ProcessRecord>();

  constructor(options: ProcessSupervisorOptions) {
    if (!Array.isArray(options.allowedExecutables) || options.allowedExecutables.length === 0
      || options.allowedExecutables.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new TypeError("at least one allowed process executable is required");
    }
    this.#allowedExecutables = new Set(options.allowedExecutables);
    this.#ptyBackend = options.ptyBackend;
    this.#maxProcessesPerSession = positiveInteger(options.maxProcessesPerSession, 8, "process limit");
    this.#maxOutputBytesPerProcess = positiveInteger(
      options.maxOutputBytesPerProcess,
      1024 * 1024,
      "process output limit"
    );
    this.#maxInputBytes = positiveInteger(options.maxInputBytes, 1024 * 1024, "process input limit");
  }

  async start(
    context: Readonly<{ sessionId: string; cwd?: string; signal?: AbortSignal }>,
    request: ProcessStartRequest
  ): Promise<{ readonly processId: string; readonly pid: number | null; readonly pty: boolean }> {
    if (!context.sessionId || !context.cwd) throw new Error("process start requires session and workspace bindings");
    if (context.signal?.aborted) throw new Error("process start was cancelled");
    if (!this.#allowedExecutables.has(request.executable)) {
      throw new Error(`process executable ${request.executable} is not allowlisted`);
    }
    if (request.executable.includes("\0")) throw new TypeError("process executable contains a NUL byte");
    const active = [...this.#records.values()]
      .filter((record) => record.sessionId === context.sessionId && record.status === "running").length;
    if (active >= this.#maxProcessesPerSession) throw new Error("session process limit is exhausted");
    const pty = request.pty ?? false;
    const backend = pty ? this.#ptyBackend : this.#pipeBackend;
    if (backend === undefined) throw new Error("PTY backend is unavailable");
    const cwd = await boundDirectory(context.cwd, request.cwd ?? ".");
    const args = argumentsList(request.args);
    const process = await backend.launch({
      executable: request.executable,
      args,
      cwd,
      pty,
      ...(pty ? {
        columns: positiveInteger(request.columns, 80, "PTY columns"),
        rows: positiveInteger(request.rows, 24, "PTY rows")
      } : {}),
      ...(context.signal === undefined ? {} : { signal: context.signal })
    });
    const processId = `process-${randomUUID()}`;
    let resolve!: (result: ProcessExitResult) => void;
    const settled = new Promise<ProcessExitResult>((complete) => { resolve = complete; });
    const record: ProcessRecord = {
      processId,
      sessionId: context.sessionId,
      process,
      entries: [],
      settled,
      resolve,
      status: "running",
      outputBytes: 0,
      nextCursor: 0,
      truncated: false
    };
    let removeData: () => void = () => {};
    let removeExit: () => void = () => {};
    let registrationsComplete = false;
    const abort = () => { void process.terminate("SIGTERM"); };
    record.cleanup = () => {
      removeData();
      if (!registrationsComplete) return;
      removeExit();
      context.signal?.removeEventListener("abort", abort);
      record.cleanup = undefined;
    };
    removeData = process.onData((stream, text) => this.#recordOutput(record, stream, text));
    removeExit = process.onExit((result) => {
      if (record.status !== "running") return;
      record.exit = result;
      record.status = result.error ? "failed" : result.signal === null ? "completed" : "terminated";
      record.cleanup?.();
      record.resolve(result);
    });
    context.signal?.addEventListener("abort", abort, { once: true });
    registrationsComplete = true;
    if (record.status !== "running") record.cleanup?.();
    this.#records.set(processId, record);
    if (context.signal?.aborted) abort();
    return Object.freeze({ processId, pid: process.pid ?? null, pty });
  }

  async read(
    sessionId: string,
    processId: string,
    cursor: number
  ): Promise<{
    readonly entries: readonly ProcessOutputEntry[];
    readonly nextCursor: number;
    readonly truncated: boolean;
    readonly status: ProcessRecord["status"];
  }> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("process output cursor is invalid");
    const record = this.#owned(sessionId, processId);
    return Object.freeze({
      entries: Object.freeze(record.entries.filter((entry) => entry.cursor > cursor).map((entry) => ({ ...entry }))),
      nextCursor: record.nextCursor,
      truncated: record.truncated,
      status: record.status
    });
  }

  async write(sessionId: string, processId: string, data: string, close = false): Promise<void> {
    const record = this.#running(sessionId, processId);
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > this.#maxInputBytes) {
      throw new TypeError("process input exceeds its bound");
    }
    await record.process.write(data, close);
  }

  async resize(sessionId: string, processId: string, columns: number, rows: number): Promise<void> {
    const record = this.#running(sessionId, processId);
    if (record.process.resize === undefined) throw new Error("process is not attached to a PTY");
    await record.process.resize(
      positiveInteger(columns, 80, "PTY columns"),
      positiveInteger(rows, 24, "PTY rows")
    );
  }

  async terminate(sessionId: string, processId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!SIGNALS.has(signal)) throw new TypeError("process termination signal is not allowed");
    const record = this.#running(sessionId, processId);
    await record.process.terminate(signal);
  }

  async wait(
    sessionId: string,
    processId: string,
    signal?: AbortSignal
  ): Promise<{ readonly exitCode: number | null; readonly signal: string | null; readonly status: ProcessRecord["status"] }> {
    const record = this.#owned(sessionId, processId);
    const exit = record.exit ?? await this.#cancelable(record.settled, signal);
    return Object.freeze({ exitCode: exit.exitCode, signal: exit.signal, status: record.status });
  }

  async close(sessionId: string, processId: string): Promise<void> {
    const record = this.#owned(sessionId, processId);
    if (record.status === "running") throw new Error("running process cannot be closed");
    record.cleanup?.();
    this.#records.delete(processId);
  }

  async dispose(): Promise<void> {
    const running = [...this.#records.values()].filter((record) => record.status === "running");
    await Promise.allSettled(running.map((record) => record.process.terminate("SIGTERM")));
    await Promise.allSettled(running.map((record) => record.settled));
    for (const record of this.#records.values()) record.cleanup?.();
    this.#records.clear();
  }

  #recordOutput(record: ProcessRecord, stream: "stdout" | "stderr", text: string): void {
    if (record.status !== "running" || text.length === 0) return;
    const remaining = this.#maxOutputBytesPerProcess - record.outputBytes;
    if (remaining <= 0) {
      record.truncated = true;
      return;
    }
    const bytes = Buffer.from(text, "utf8");
    let retained = bytes.byteLength <= remaining ? text : bytes.subarray(0, remaining).toString("utf8");
    while (Buffer.byteLength(retained, "utf8") > remaining) retained = retained.slice(0, -1);
    record.truncated ||= retained !== text;
    record.outputBytes += Buffer.byteLength(retained, "utf8");
    record.nextCursor += 1;
    record.entries.push(Object.freeze({ cursor: record.nextCursor, stream, text: retained }));
  }

  #owned(sessionId: string, processId: string): ProcessRecord {
    const record = this.#records.get(processId);
    if (!record) throw new Error("process was not found");
    if (record.sessionId !== sessionId) throw new Error("process does not belong to the session");
    return record;
  }

  #running(sessionId: string, processId: string): ProcessRecord {
    const record = this.#owned(sessionId, processId);
    if (record.status !== "running") throw new Error("process is not running");
    return record;
  }

  #cancelable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return operation;
    if (signal.aborted) return Promise.reject(new Error("process wait was cancelled"));
    return new Promise<T>((resolvePromise, reject) => {
      const abort = () => reject(new Error("process wait was cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      void operation.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}

export function createProcessTools(supervisor: ProcessSupervisor): readonly ToolDefinition[] {
  return Object.freeze([
    defineTool({
      name: "process_start",
      description: "Start an allowlisted process without shell interpolation.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: {
          executable: { type: "string" },
          args: { type: "array", items: { type: "string" }, default: [] },
          cwd: { type: "string", default: "." },
          pty: { type: "boolean", default: false },
          columns: { type: "integer", default: 80 },
          rows: { type: "integer", default: 24 }
        },
        required: ["executable"],
        additionalProperties: false
      },
      execute: (args, context) => supervisor.start(context, {
        executable: String(args.executable),
        args: args.args as string[] | undefined,
        cwd: args.cwd as string | undefined,
        pty: args.pty as boolean | undefined,
        columns: args.columns as number | undefined,
        rows: args.rows as number | undefined
      })
    }),
    defineTool({
      name: "process_read",
      description: "Read ordered process output after a cursor.",
      risk: "read-only",
      parameters: {
        type: "object",
        properties: { processId: { type: "string" }, cursor: { type: "integer", default: 0 } },
        required: ["processId"],
        additionalProperties: false
      },
      async execute(args, context) {
        const output = await supervisor.read(
          context.sessionId,
          String(args.processId),
          Number(args.cursor ?? 0)
        );
        return {
          entries: output.entries.map((entry) => ({ ...entry })),
          nextCursor: output.nextCursor,
          truncated: output.truncated,
          status: output.status
        };
      }
    }),
    defineTool({
      name: "process_write_stdin",
      description: "Write bounded UTF-8 input to a running process.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: {
          processId: { type: "string" },
          data: { type: "string" },
          close: { type: "boolean", default: false }
        },
        required: ["processId", "data"],
        additionalProperties: false
      },
      async execute(args, context) {
        await supervisor.write(context.sessionId, String(args.processId), String(args.data), Boolean(args.close));
        return {};
      }
    }),
    defineTool({
      name: "process_resize",
      description: "Resize a running pseudo-terminal.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: {
          processId: { type: "string" },
          columns: { type: "integer" },
          rows: { type: "integer" }
        },
        required: ["processId", "columns", "rows"],
        additionalProperties: false
      },
      async execute(args, context) {
        await supervisor.resize(
          context.sessionId,
          String(args.processId),
          Number(args.columns),
          Number(args.rows)
        );
        return {};
      }
    }),
    defineTool({
      name: "process_terminate",
      description: "Terminate a running process with an allowed signal.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: {
          processId: { type: "string" },
          signal: { type: "string", enum: ["SIGTERM", "SIGINT", "SIGKILL"], default: "SIGTERM" }
        },
        required: ["processId"],
        additionalProperties: false
      },
      async execute(args, context) {
        await supervisor.terminate(
          context.sessionId,
          String(args.processId),
          String(args.signal ?? "SIGTERM") as NodeJS.Signals
        );
        return {};
      }
    }),
    defineTool({
      name: "process_wait",
      description: "Wait for a process and return its terminal state.",
      risk: "read-only",
      parameters: {
        type: "object",
        properties: { processId: { type: "string" } },
        required: ["processId"],
        additionalProperties: false
      },
      execute: (args, context) => supervisor.wait(
        context.sessionId,
        String(args.processId),
        context.signal
      )
    }),
    defineTool({
      name: "process_close",
      description: "Release a completed process record.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: { processId: { type: "string" } },
        required: ["processId"],
        additionalProperties: false
      },
      async execute(args, context) {
        await supervisor.close(context.sessionId, String(args.processId));
        return {};
      }
    })
  ]);
}
