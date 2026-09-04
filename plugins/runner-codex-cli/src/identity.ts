import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface RunnerBinaryIdentity {
  readonly requestedPath: string;
  readonly realPath: string;
  readonly version: string;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly byteLength: number;
  readonly modifiedAtMs: number;
}

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
  if (!binaryPath || binaryPath.includes("\0")) throw invalidBinary("Runner 路径无效");
  const requestedPath = resolve(binaryPath);
  const resolvedPath = await realpath(requestedPath);
  const before = await stat(resolvedPath);
  if (!before.isFile() || (before.mode & 0o111) === 0) {
    throw invalidBinary("Runner 必须是可执行的普通文件");
  }
  if (before.size > 512 * 1024 * 1024) throw invalidBinary("Runner 二进制超过 512 MiB 限制");
  const firstBytes = await readFile(resolvedPath);
  const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
  const rawVersion = await (options.readVersion ?? readBinaryVersion)(resolvedPath);
  const secondBytes = await readFile(resolvedPath);
  const secondDigest = createHash("sha256").update(secondBytes).digest("hex");
  const after = await stat(resolvedPath);
  if (firstDigest !== secondDigest || !sameFile(before, after)) {
    throw new RunnerSecurityError(
      "RUNNER_RESOURCE_CHANGED",
      "读取身份期间 Runner 二进制发生变化",
      "重新选择二进制并确认身份",
    );
  }
  const version = rawVersion.trim().split(/\r?\n/u)[0]?.slice(0, 256) ?? "";
  if (!version) throw invalidBinary("Runner 未返回版本");
  return Object.freeze({
    requestedPath,
    realPath: resolvedPath,
    version,
    sha256: firstDigest,
    device: String(after.dev),
    inode: String(after.ino),
    byteLength: after.size,
    modifiedAtMs: after.mtimeMs,
  });
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
