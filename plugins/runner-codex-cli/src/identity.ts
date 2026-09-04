import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { RunnerBinaryIdentityV1, RunnerBinaryInspectionV1 } from "@mn/contracts";

export type RunnerBinaryIdentity = RunnerBinaryIdentityV1;
export type RunnerBinaryInspection = RunnerBinaryInspectionV1;

export interface InspectRunnerBinaryOptions {
  readonly readVersion?: (realPath: string) => Promise<string>;
}

export class RunnerSecurityError extends Error {
  readonly code: "RUNNER_BINARY_INVALID" | "RUNNER_RECONFIRMATION_REQUIRED" | "RUNNER_RESOURCE_CHANGED";
  readonly action: string;

  constructor(
    code: "RUNNER_BINARY_INVALID" | "RUNNER_RECONFIRMATION_REQUIRED" | "RUNNER_RESOURCE_CHANGED",
    message: string,
    action: string,
  ) {
    super(message);
    this.name = "RunnerSecurityError";
    this.code = code;
    this.action = action;
  }
}

export async function inspectRunnerBinary(
  binaryPath: string,
  options: InspectRunnerBinaryOptions = {},
): Promise<RunnerBinaryIdentity> {
  const first = await passivelyInspectRunnerBinary(binaryPath);
  const rawVersion = await (options.readVersion ?? readBinaryVersion)(first.realPath);
  const second = await passivelyInspectRunnerBinary(binaryPath);
  if (passiveIdentityChanged(first, second)) throw resourceChanged("读取身份期间 Runner 二进制发生变化");
  const version = normalizedVersion(rawVersion);
  return Object.freeze({ ...second, version });
}

export async function passivelyInspectRunnerBinary(
  binaryPath: string,
): Promise<RunnerBinaryInspection> {
  if (!binaryPath || binaryPath.includes("\0")) throw invalidBinary("Runner 路径无效");
  if (!isAbsolute(binaryPath)) throw invalidBinary("Runner 必须使用绝对路径");
  const requestedPath = resolve(binaryPath);
  const resolvedPath = await realpath(requestedPath);
  const before = await stat(resolvedPath);
  if (!before.isFile() || (before.mode & 0o111) === 0) {
    throw invalidBinary("Runner 必须是可执行的普通文件");
  }
  if (before.size > 512 * 1024 * 1024) throw invalidBinary("Runner 二进制超过 512 MiB 限制");
  const bytes = await readFile(resolvedPath);
  const after = await stat(resolvedPath);
  if (!sameFile(before, after)) throw resourceChanged("读取摘要期间 Runner 二进制发生变化");
  return Object.freeze({
    requestedPath,
    realPath: resolvedPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    device: String(after.dev),
    inode: String(after.ino),
    byteLength: after.size,
    modifiedAtMs: after.mtimeMs,
  });
}

export async function verifyRunnerBinaryIdentity(
  confirmed: RunnerBinaryIdentity,
  options: InspectRunnerBinaryOptions = {},
): Promise<RunnerBinaryIdentity> {
  const first = await passivelyInspectRunnerBinary(confirmed.requestedPath);
  if (passiveIdentityChanged(confirmed, first)) throw reconfirmationRequired();

  // Execute --version only after passive file identity matches the confirmed binary.
  const rawVersion = await (options.readVersion ?? readBinaryVersion)(first.realPath);
  const second = await passivelyInspectRunnerBinary(confirmed.requestedPath);
  if (passiveIdentityChanged(first, second)) throw resourceChanged("复核身份期间 Runner 二进制发生变化");
  const current = Object.freeze({ ...second, version: normalizedVersion(rawVersion) });
  assertRunnerIdentity(confirmed, current);
  return current;
}

export function assertRunnerIdentity(
  confirmed: RunnerBinaryIdentity,
  current: RunnerBinaryIdentity,
): void {
  const fields = [
    "requestedPath",
    "realPath",
    "version",
    "sha256",
    "device",
    "inode",
    "byteLength",
    "modifiedAtMs",
  ] as const;
  if (fields.some((field) => confirmed[field] !== current[field])) {
    throw new RunnerSecurityError(
      "RUNNER_RECONFIRMATION_REQUIRED",
      "Runner 路径、版本或二进制摘要已变化",
      "检查新身份并重新确认后再执行",
    );
  }
}

function passiveIdentityChanged(
  confirmed: RunnerBinaryInspection,
  current: RunnerBinaryInspection,
): boolean {
  const fields = [
    "requestedPath",
    "realPath",
    "sha256",
    "device",
    "inode",
    "byteLength",
    "modifiedAtMs",
  ] as const;
  return fields.some((field) => confirmed[field] !== current[field]);
}

function normalizedVersion(rawVersion: string): string {
  const version = rawVersion.trim().split(/\r?\n/u)[0]?.slice(0, 256) ?? "";
  if (!version) throw invalidBinary("Runner 未返回版本");
  return version;
}

function resourceChanged(message: string): RunnerSecurityError {
  return new RunnerSecurityError(
    "RUNNER_RESOURCE_CHANGED",
    message,
    "重新选择二进制并确认身份",
  );
}

function reconfirmationRequired(): RunnerSecurityError {
  return new RunnerSecurityError(
    "RUNNER_RECONFIRMATION_REQUIRED",
    "Runner 路径、版本或二进制摘要已变化",
    "检查新身份并重新确认后再执行",
  );
}

async function readBinaryVersion(path: string): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    const child = spawn(path, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: copySafeEnvironment(),
      windowsHide: true,
    });
    let output = "";
    let exceeded = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(invalidBinary("Runner 版本探测超时"));
    }, 5_000);
    const collect = (chunk: Buffer) => {
      if (output.length + chunk.length > 65_536) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(invalidBinary(`Runner 版本探测失败：${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded) return reject(invalidBinary("Runner 版本输出超过限制"));
      if (code !== 0) return reject(invalidBinary("Runner 版本探测失败"));
      resolveVersion(output);
    });
  });
}

export function copySafeEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "NO_COLOR"] as const) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...extra };
}

function sameFile(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

function invalidBinary(message: string): RunnerSecurityError {
  return new RunnerSecurityError("RUNNER_BINARY_INVALID", message, "选择可信的 Runner 可执行文件");
}
