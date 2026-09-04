// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { isAbsolute } from "node:path";

interface SupervisorConfig {
  readonly protocol: "mn-runner-supervisor-v1";
  readonly statePath: string;
  readonly token: string;
  readonly executable: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface SupervisorState {
  readonly protocol: "mn-runner-supervisor-v1";
  readonly token: string;
  readonly status: "prepared" | "running" | "terminated" | "unconfirmed";
  readonly supervisorPid?: number;
  readonly runnerPid?: number;
  readonly reason?: string;
  readonly updatedAt: string;
}

const config = parseConfig(process.env.MN_RUNNER_SUPERVISOR_CONFIG);
delete process.env.MN_RUNNER_SUPERVISOR_CONFIG;
const prepared = parseState(await readFile(config.statePath, "utf8"));
if (prepared.protocol !== config.protocol || prepared.token !== config.token || prepared.status !== "prepared") {
  throw new Error("Runner 监督记录与启动配置不一致");
}

let child: ChildProcess | undefined;
let stopping = false;
let finalized = false;
let childSpawned: Promise<boolean> = Promise.resolve(false);
let stopOperation: Promise<void> | undefined;
let groupTermination: Promise<boolean> | undefined;
const control = new Socket({ fd: 3, readable: true, writable: false });
control.resume();
control.once("end", () => { void stop("parent_disconnected"); });
control.once("error", () => { void stop("parent_control_failed"); });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void stop(`supervisor_${signal.toLowerCase()}`); });
}

try {
  child = spawn(config.executable, [...config.args], {
    cwd: config.cwd,
    env: { ...config.env },
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  childSpawned = new Promise<boolean>((resolveSpawned) => {
    child!.once("spawn", () => resolveSpawned(true));
    child!.once("error", () => resolveSpawned(false));
  });
  const runnerClosed = new Promise<{ readonly reason: string }>((resolveClose) => {
    let settled = false;
    child!.once("error", () => {
      if (settled) return;
      settled = true;
      resolveClose({ reason: "runner_spawn_failed" });
    });
    child!.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolveClose({ reason: signal ? `signal:${signal}` : `exit:${code ?? "unknown"}` });
    });
  });
  if (!await childSpawned || !child.pid) throw new Error("Runner 进程没有可验证的 PID");
  const runningStateWritten = writeState({
    protocol: config.protocol,
    token: config.token,
    status: "running",
    supervisorPid: process.pid,
    runnerPid: child.pid,
    updatedAt: new Date().toISOString(),
  });
  process.stdin.pipe(child.stdin!);
  child.stdin!.once("error", () => { void stop("runner_stdin_failed"); });
  child.stdout!.pipe(process.stdout, { end: false });
  void runnerClosed.then(async ({ reason }) => {
    await runningStateWritten;
    const terminated = child?.pid ? await ensureRunnerGroupStopped(child.pid) : true;
    await finish(
      terminated ? "terminated" : "unconfirmed",
      terminated ? reason : `${reason}:process_group_alive`,
    );
  });
  await runningStateWritten;
  if (stopping) await stop("parent_disconnected_before_spawn");
} catch (error) {
  await finish("terminated", `spawn_failed:${safeMessage(error)}`);
}

async function stop(reason: string): Promise<void> {
  if (finalized) return;
  if (stopOperation) return stopOperation;
  stopping = true;
  stopOperation = (async () => {
    if (!await childSpawned || !child?.pid) {
      await finish("terminated", reason);
      return;
    }
    const terminated = await ensureRunnerGroupStopped(child.pid);
    await finish(
      terminated ? "terminated" : "unconfirmed",
      terminated ? reason : `${reason}:sigkill_timeout`,
    );
  })();
  return stopOperation;
}

function ensureRunnerGroupStopped(pid: number): Promise<boolean> {
  groupTermination ??= terminateRunnerGroup(pid);
  return groupTermination;
}

async function terminateRunnerGroup(pid: number): Promise<boolean> {
  signalRunner(pid, "SIGTERM");
  if (await waitForProcessGroupGone(pid, 500)) return true;
  signalRunner(pid, "SIGKILL");
  return waitForProcessGroupGone(pid, 500);
}

async function finish(status: "terminated" | "unconfirmed", reason: string): Promise<void> {
  if (finalized) return;
  finalized = true;
  await writeState({
    protocol: config.protocol,
    token: config.token,
    status,
    supervisorPid: process.pid,
    ...(child?.pid ? { runnerPid: child.pid } : {}),
    reason,
    updatedAt: new Date().toISOString(),
  }).catch(() => undefined);
  control.destroy();
  process.stdin.unpipe();
  await flushStdout();
  process.exit(status === "terminated" ? 0 : 1);
}

async function flushStdout(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolveFlush) => process.stdout.write("", () => resolveFlush())),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, 1_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalRunner(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

async function waitForProcessGroupGone(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await delay(20);
  }
  return !processGroupExists(pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function writeState(state: SupervisorState): Promise<void> {
  const temporary = `${config.statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, config.statePath);
}

function parseConfig(encoded: string | undefined): SupervisorConfig {
  if (!encoded) throw new Error("Runner 监督配置缺失");
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("Runner 监督配置无效");
  const candidate = value as Partial<SupervisorConfig>;
  if (candidate.protocol !== "mn-runner-supervisor-v1"
    || typeof candidate.statePath !== "string" || !isAbsolute(candidate.statePath)
    || typeof candidate.token !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.token)
    || typeof candidate.executable !== "string" || !isAbsolute(candidate.executable)
    || typeof candidate.cwd !== "string" || !isAbsolute(candidate.cwd)
    || !Array.isArray(candidate.args) || candidate.args.some((item) => typeof item !== "string")
    || !candidate.env || typeof candidate.env !== "object") {
    throw new Error("Runner 监督配置字段无效");
  }
  const env = Object.fromEntries(Object.entries(candidate.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { ...candidate, args: [...candidate.args], env } as SupervisorConfig;
}

function parseState(serialized: string): SupervisorState {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object") throw new Error("Runner 监督状态无效");
  return value as SupervisorState;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown").replace(/[\r\n]/gu, " ").slice(0, 160);
}
