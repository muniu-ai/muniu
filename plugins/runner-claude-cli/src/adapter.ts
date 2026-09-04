import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  assertRunnerIdentity,
  copySafeEnvironment,
  RunnerSecurityError,
  verifyRunnerBinaryIdentity,
  type RunnerBinaryIdentity,
} from "./identity.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;

export interface RunnerInvocationInput {
  readonly mode: "start" | "resume";
  readonly preparedInput: string;
  readonly externalSessionId?: string;
}

export interface SafeInvocation {
  readonly args: readonly string[];
  readonly stdin: string;
  readonly shell: false;
}

export function buildClaudeInvocation(input: RunnerInvocationInput): SafeInvocation {
  assertPreparedInput(input.preparedInput);
  if (input.mode === "resume") assertExternalSessionId(input.externalSessionId);
  return Object.freeze({
    args: input.mode === "start"
      ? ["-p", "--output-format", "stream-json", "--verbose"]
      : [
        "-p",
        "--resume",
        input.externalSessionId!,
        "--output-format",
        "stream-json",
        "--verbose",
      ],
    stdin: input.preparedInput,
    shell: false as const,
  });
}

export interface RepositoryIdentity {
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface SafeSpawnSpec extends SafeInvocation {
  readonly executable: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ManagedRunnerProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly completed: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface RunnerStartRequest {
  readonly executionId: string;
  readonly repositoryPath: string;
  readonly expectedRepositoryRealPath: string;
  readonly resourceDigest: string;
  readonly preparedInput: string;
  readonly explicitlySelected: boolean;
}

export interface RunnerResumeRequest {
  readonly preparedInput: string;
  readonly explicitlySelected: boolean;
}

export type RunnerAdapterEvent =
  | { readonly type: "runner_event"; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly type: "diagnostic"; readonly message: string }
  | {
    readonly type: "result";
    readonly status: "completed" | "failed" | "cancelled" | "unknown";
    readonly reason?: string;
    readonly reconciliationRequired?: boolean;
  };

export interface ClaudeCliRunner {
  readonly id: "claude-cli";
  readonly external: true;
  start(input: RunnerStartRequest): Promise<{ readonly sessionId: string }>;
  events(sessionId: string): AsyncIterable<RunnerAdapterEvent>;
  cancel(sessionId: string): Promise<void>;
  resume(sessionId: string, input: RunnerResumeRequest): Promise<void>;
}

export interface CreateClaudeCliRunnerOptions {
  readonly binaryPath: string;
  readonly confirmedIdentity: RunnerBinaryIdentity;
  readonly inspectIdentity?: (path: string) => Promise<RunnerBinaryIdentity>;
  readonly inspectRepository?: (path: string) => Promise<RepositoryIdentity>;
  readonly launch?: (spec: SafeSpawnSpec) => ManagedRunnerProcess;
  readonly createSessionId?: () => string;
  readonly cancelGraceMs?: number;
}

interface SessionState {
  readonly id: string;
  readonly input: RunnerStartRequest;
  process: ManagedRunnerProcess;
  externalSessionId?: string;
  cancelled: boolean;
  eventsConsumed: boolean;
}

export function createClaudeCliRunner(options: CreateClaudeCliRunnerOptions): ClaudeCliRunner {
  const inspectIdentity = options.inspectIdentity
    ?? (() => verifyRunnerBinaryIdentity(options.confirmedIdentity));
  const inspectRepository = options.inspectRepository ?? inspectRepositoryPath;
  const launch = options.launch ?? launchRunner;
  const createSessionId = options.createSessionId ?? randomUUID;
  const cancelGraceMs = options.cancelGraceMs ?? 2_000;
  if (!Number.isSafeInteger(cancelGraceMs) || cancelGraceMs < 1) {
    throw new Error("Runner 取消宽限期必须是正整数");
  }
  const sessions = new Map<string, SessionState>();

  async function prepare(
    input: RunnerStartRequest,
    invocation: SafeInvocation,
  ): Promise<ManagedRunnerProcess> {
    assertStartRequest(input);
    const repositoryBefore = await inspectRepository(input.repositoryPath);
    assertExpectedRepository(input.expectedRepositoryRealPath, repositoryBefore);
    const currentIdentity = await inspectIdentity(options.binaryPath);
    assertRunnerIdentity(options.confirmedIdentity, currentIdentity);
    const repositoryAfter = await inspectRepository(input.repositoryPath);
    assertSameRepository(repositoryBefore, repositoryAfter);
    assertExpectedRepository(input.expectedRepositoryRealPath, repositoryAfter);
    return launch({
      executable: currentIdentity.realPath,
      cwd: repositoryAfter.realPath,
      args: invocation.args,
      stdin: invocation.stdin,
      shell: false,
      env: copySafeEnvironment({
        MN_EXECUTION_ID: input.executionId,
        MN_RESOURCE_DIGEST: input.resourceDigest,
      }),
    });
  }

  return {
    id: "claude-cli",
    external: true,
    async start(input) {
      if (!input.explicitlySelected) throw selectionRequired();
      const process = await prepare(input, buildClaudeInvocation({
        mode: "start",
        preparedInput: input.preparedInput,
      }));
      const sessionId = createSessionId();
      if (!sessionId || sessions.has(sessionId)) {
        await terminateRunnerProcess(process, cancelGraceMs);
        throw new Error("Runner 会话 ID 无效或重复");
      }
      sessions.set(sessionId, {
        id: sessionId,
        input: { ...input },
        process,
        cancelled: false,
        eventsConsumed: false,
      });
      return Object.freeze({ sessionId });
    },
    async *events(sessionId) {
      const session = requireSession(sessions, sessionId);
      if (session.eventsConsumed) throw new Error("Runner 事件流只能读取一次");
      session.eventsConsumed = true;
      let buffer = "";
      let terminal: "completed" | "failed" | undefined;
      let malformed = false;
      for await (const chunk of session.process.stdout) {
        buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_LINE_BYTES && !buffer.includes("\n")) {
          malformed = true;
          buffer = "";
          yield { type: "diagnostic", message: "Runner 事件超过 1 MiB，已忽略" };
          continue;
        }
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
            malformed = true;
            yield { type: "diagnostic", message: "Runner 事件超过 1 MiB，已忽略" };
            continue;
          }
          const parsed = parseEvent(line);
          if (!parsed) {
            if (line.trim()) {
              malformed = true;
              yield { type: "diagnostic", message: "Runner 返回了无效事件，内容未记录" };
            }
            continue;
          }
          session.externalSessionId = claudeSessionId(parsed) ?? session.externalSessionId;
          terminal = claudeTerminal(parsed) ?? terminal;
          yield { type: "runner_event", payload: parsed };
        }
      }
      if (buffer.trim()) {
        const parsed = Buffer.byteLength(buffer, "utf8") <= MAX_EVENT_LINE_BYTES
          ? parseEvent(buffer)
          : undefined;
        if (parsed) {
          session.externalSessionId = claudeSessionId(parsed) ?? session.externalSessionId;
          terminal = claudeTerminal(parsed) ?? terminal;
          yield { type: "runner_event", payload: parsed };
        } else {
          malformed = true;
          yield { type: "diagnostic", message: "Runner 返回了无效事件，内容未记录" };
        }
      }
      let completion: { code: number | null; signal: string | null };
      try {
        completion = await session.process.completed;
      } catch {
        completion = { code: null, signal: null };
      }
      if (session.cancelled) {
        yield { type: "result", status: "cancelled", reason: "Runner 已取消" };
      } else if (terminal === "failed") {
        yield { type: "result", status: "failed", reason: "Runner 明确报告失败" };
      } else if (terminal === "completed" && completion.code === 0 && !malformed) {
        yield { type: "result", status: "completed" };
      } else {
        yield {
          type: "result",
          status: "unknown",
          reason: "Runner 未返回可确认的完整终态",
          reconciliationRequired: true,
        };
      }
    },
    async cancel(sessionId) {
      const session = requireSession(sessions, sessionId);
      session.cancelled = true;
      await terminateRunnerProcess(session.process, cancelGraceMs);
    },
    async resume(sessionId, input) {
      const session = requireSession(sessions, sessionId);
      if (!input.explicitlySelected) throw selectionRequired();
      if (session.cancelled) throw new Error("已取消的 Runner 会话不能恢复");
      assertExternalSessionId(session.externalSessionId);
      session.process = await prepare(
        { ...session.input, preparedInput: input.preparedInput, explicitlySelected: true },
        buildClaudeInvocation({
          mode: "resume",
          preparedInput: input.preparedInput,
          externalSessionId: session.externalSessionId,
        }),
      );
      session.eventsConsumed = false;
    },
  };
}

async function terminateRunnerProcess(process: ManagedRunnerProcess, graceMs: number): Promise<void> {
  process.kill("SIGTERM");
  if (await settlesWithin(process.completed, graceMs)) return;
  process.kill("SIGKILL");
  if (!await settlesWithin(process.completed, graceMs)) {
    throw new Error("Runner 在 SIGKILL 后仍未退出");
  }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function inspectRepositoryPath(path: string): Promise<RepositoryIdentity> {
  if (!path || path.includes("\0")) throw resourceChanged("仓库路径无效");
  const resolvedPath = await realpath(resolve(path));
  const info = await stat(resolvedPath);
  if (!info.isDirectory()) throw resourceChanged("仓库路径不是目录");
  return Object.freeze({ realPath: resolvedPath, device: String(info.dev), inode: String(info.ino) });
}

function assertExpectedRepository(expected: string, current: RepositoryIdentity): void {
  if (!expected || resolve(expected) !== current.realPath) {
    throw resourceChanged("仓库真实路径与已批准资源不一致");
  }
}

function assertSameRepository(before: RepositoryIdentity, after: RepositoryIdentity): void {
  if (before.realPath !== after.realPath || before.device !== after.device || before.inode !== after.inode) {
    throw resourceChanged("启动前仓库路径发生变化");
  }
}

function assertStartRequest(input: RunnerStartRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.executionId)) {
    throw new Error("Execution ID 无效");
  }
  if (!SHA256.test(input.resourceDigest)) throw new Error("资源摘要必须是 SHA-256");
  assertPreparedInput(input.preparedInput);
}

function assertPreparedInput(input: string): void {
  if (!input.trim()) throw new Error("Runner 输入不能为空");
  if (input.includes("\0") || Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Runner 输入无效或超过 8 MiB 限制");
  }
}

function assertExternalSessionId(value: string | undefined): asserts value is string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
    throw new Error("Runner 外部会话 ID 无效");
  }
}

function parseEvent(line: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.freeze(value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function claudeSessionId(event: Readonly<Record<string, unknown>>): string | undefined {
  return event.type === "system" && event.subtype === "init" && typeof event.session_id === "string"
    ? event.session_id
    : undefined;
}

function claudeTerminal(event: Readonly<Record<string, unknown>>): "completed" | "failed" | undefined {
  if (event.type !== "result") return undefined;
  return event.is_error === true ? "failed" : "completed";
}

function requireSession(sessions: Map<string, SessionState>, id: string): SessionState {
  const session = sessions.get(id);
  if (!session) throw new Error(`Runner 会话不存在：${id}`);
  return session;
}

function selectionRequired(): RunnerSecurityError {
  return new RunnerSecurityError(
    "RUNNER_RECONFIRMATION_REQUIRED",
    "外部 Runner 必须由用户显式选择",
    "显式选择 Runner 并确认二进制身份",
  );
}

function resourceChanged(message: string): RunnerSecurityError {
  return new RunnerSecurityError("RUNNER_RESOURCE_CHANGED", message, "重新审阅资源后再执行");
}

function launchRunner(spec: SafeSpawnSpec): ManagedRunnerProcess {
  const child = spawn(spec.executable, [...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env },
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const killChild = (signal: "SIGTERM" | "SIGKILL") => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The root process may already have exited; fall back to the child handle.
      }
    }
    child.kill(signal);
  };
  let inputSettled = false;
  let resolveInput: (accepted: boolean) => void = () => {};
  const inputAccepted = new Promise<boolean>((resolve) => {
    resolveInput = resolve;
  });
  const settleInput = (accepted: boolean) => {
    if (inputSettled) return;
    inputSettled = true;
    resolveInput(accepted);
  };
  child.stdin.once("finish", () => settleInput(true));
  child.stdin.once("error", () => {
    settleInput(false);
    killChild("SIGTERM");
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveCompletion) => {
    let settled = false;
    child.once("error", () => {
      settleInput(false);
      if (!settled) {
        settled = true;
        resolveCompletion({ code: null, signal: null });
      }
    });
    child.once("close", (code, signal) => {
      settleInput(false);
      if (!settled) {
        settled = true;
        resolveCompletion({ code, signal });
      }
    });
  });
  const completed = Promise.all([exited, inputAccepted]).then(([result, accepted]) => accepted
    ? result
    : { code: null, signal: result.signal });
  child.stdin.end(spec.stdin, "utf8");
  return {
    stdout: child.stdout,
    completed,
    kill: killChild,
  };
}
