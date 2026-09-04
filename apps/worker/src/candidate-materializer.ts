// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_CANDIDATE_TREE_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxPathBytes: 4_096,
});

export interface CandidateTreeLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
  readonly maxPathBytes: number;
}

export interface CandidateTreeManifest {
  readonly digest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface ControlledCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CandidateOperationAbortedError extends Error {
  constructor(message = "候选处理已因 Job 失去租约或被取消而中断") {
    super(message);
    this.name = "AbortError";
  }
}

export class ControlledCommandTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`受控命令超过 ${timeoutMs} 毫秒时限`);
    this.name = "ControlledCommandTimeoutError";
  }
}

export function isCandidateOperationAborted(error: unknown): boolean {
  return error instanceof CandidateOperationAbortedError
    || (error instanceof Error && error.name === "AbortError")
    || (typeof error === "object" && error !== null && "code" in error
      && (error as { readonly code?: unknown }).code === "ABORT_ERR");
}

export async function copyCandidateTree(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly signal: AbortSignal;
  readonly ignoreRootGit?: boolean;
  readonly limits?: CandidateTreeLimits;
}): Promise<CandidateTreeManifest> {
  const sourceRoot = await checkedDirectoryRoot(input.sourceRoot, "候选源目录", input.signal);
  const targetRoot = resolve(input.targetRoot);
  if (!isAbsolute(input.targetRoot) || targetRoot !== input.targetRoot) {
    throw new Error("候选快照目录必须是规范化绝对路径");
  }
  assertOutside(sourceRoot, targetRoot, "候选快照目录不能位于不可信源目录内");
  await mkdir(targetRoot, { mode: 0o700 });
  const actualTarget = await realpath(targetRoot);
  if (actualTarget !== targetRoot) throw new Error("候选快照目录真实路径已变化");
  const state = createWalkState(input.limits ?? DEFAULT_CANDIDATE_TREE_LIMITS);
  try {
    await walkTree({
      sourceRoot,
      sourceDirectory: sourceRoot,
      targetDirectory: targetRoot,
      relativeSegments: [],
      signal: input.signal,
      ignoreRootGit: input.ignoreRootGit ?? false,
      state,
    });
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true });
    throw error;
  }
  return manifest(state);
}

export async function inspectCandidateTree(input: {
  readonly root: string;
  readonly signal: AbortSignal;
  readonly limits?: CandidateTreeLimits;
}): Promise<CandidateTreeManifest> {
  const root = await checkedDirectoryRoot(input.root, "Worker 候选快照", input.signal);
  const state = createWalkState(input.limits ?? DEFAULT_CANDIDATE_TREE_LIMITS);
  await walkTree({
    sourceRoot: root,
    sourceDirectory: root,
    relativeSegments: [],
    signal: input.signal,
    ignoreRootGit: false,
    state,
  });
  return manifest(state);
}

export function runControlledCommand(input: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes?: number;
}): Promise<ControlledCommandResult> {
  assertNotAborted(input.signal);
  if (!isAbsolute(input.executable)) throw new Error("受控命令必须使用绝对可执行路径");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("受控命令必须配置正整数时限");
  }
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(input.executable, [...input.arguments], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      encoding: "utf8",
      maxBuffer: input.maxBufferBytes ?? 32 * 1024 * 1024,
      timeout: input.timeoutMs,
      killSignal: "SIGKILL",
      signal: input.signal,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LC_ALL: "C",
        ...input.environment,
      },
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveCommand({ exitCode: 0, stdout, stderr });
        return;
      }
      if (input.signal.aborted || isCandidateOperationAborted(error)) {
        rejectCommand(new CandidateOperationAbortedError());
        return;
      }
      const commandError = error as Error & {
        readonly code?: string | number | null;
        readonly killed?: boolean;
        readonly signal?: string | null;
      };
      if (commandError.killed && commandError.signal === "SIGKILL") {
        rejectCommand(new ControlledCommandTimeoutError(input.timeoutMs));
        return;
      }
      if (typeof commandError.code === "number") {
        resolveCommand({ exitCode: commandError.code, stdout, stderr });
        return;
      }
      rejectCommand(new Error("受控命令无法启动", { cause: error }));
    });
  });
}

interface ManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly executable?: boolean;
  readonly byteLength?: number;
  readonly digest?: string;
}

interface WalkState {
  readonly limits: CandidateTreeLimits;
  readonly entries: ManifestEntry[];
  fileCount: number;
  totalBytes: number;
}

function createWalkState(limits: CandidateTreeLimits): WalkState {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`候选树限制 ${name} 必须是正整数`);
    }
  }
  return { limits, entries: [], fileCount: 0, totalBytes: 0 };
}

async function walkTree(input: {
  readonly sourceRoot: string;
  readonly sourceDirectory: string;
  readonly targetDirectory?: string;
  readonly relativeSegments: readonly string[];
  readonly signal: AbortSignal;
  readonly ignoreRootGit: boolean;
  readonly state: WalkState;
}): Promise<void> {
  assertNotAborted(input.signal);
  if (input.relativeSegments.length > input.state.limits.maxDepth) {
    throw new Error("候选目录深度超过安全上限");
  }
  const beforeDirectory = await lstat(input.sourceDirectory);
  if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
    throw new Error(`候选包含不安全目录：${displayPath(input.relativeSegments)}`);
  }
  const actualDirectory = await realpath(input.sourceDirectory);
  assertWithin(input.sourceRoot, actualDirectory, "候选目录");

  const directory = await opendir(actualDirectory);
  const names: string[] = [];
  try {
    for await (const entry of directory) names.push(entry.name);
  } finally {
    await directory.close().catch(() => undefined);
  }
  names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));

  for (const name of names) {
    assertNotAborted(input.signal);
    const segments = [...input.relativeSegments, name];
    const path = segments.join("/");
    assertCandidatePath(path, name, input.state.limits);
    if (name.toLowerCase() === ".git") {
      if (input.ignoreRootGit && input.relativeSegments.length === 0) continue;
      throw new Error(`候选包含不允许固化的 Git 元数据：${path}`);
    }
    const source = join(actualDirectory, name);
    const before = await lstat(source);
    if (before.isSymbolicLink()) throw new Error(`候选包含符号链接：${path}`);
    if (before.isDirectory()) {
      const target = input.targetDirectory ? join(input.targetDirectory, name) : undefined;
      if (target) {
        assertWithin(resolve(input.targetDirectory!), resolve(target), "候选快照目录");
        await mkdir(target, { mode: 0o700 });
      }
      input.state.entries.push({ path, kind: "directory" });
      await walkTree({
        ...input,
        sourceDirectory: source,
        ...(target ? { targetDirectory: target } : { targetDirectory: undefined }),
        relativeSegments: segments,
      });
      const after = await lstat(source);
      if (!sameFileIdentity(before, after) || !after.isDirectory() || after.isSymbolicLink()) {
        throw new Error(`候选目录在读取期间发生变化：${path}`);
      }
      continue;
    }
    if (!before.isFile()) throw new Error(`候选包含特殊文件：${path}`);
    if (before.nlink !== 1) throw new Error(`候选包含可能跨目录别名的硬链接：${path}`);
    if (before.size > input.state.limits.maxFileBytes) {
      throw new Error(`候选文件超过单文件上限：${path}`);
    }
    input.state.fileCount += 1;
    input.state.totalBytes += before.size;
    if (input.state.fileCount > input.state.limits.maxFiles) {
      throw new Error("候选文件数量超过安全上限");
    }
    if (input.state.totalBytes > input.state.limits.maxTotalBytes) {
      throw new Error("候选文件总大小超过安全上限");
    }
    const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const openedBefore = await handle.stat();
      if (!openedBefore.isFile() || openedBefore.nlink !== 1 || !sameFileIdentity(before, openedBefore)) {
        throw new Error(`候选文件在打开前发生变化：${path}`);
      }
      bytes = await handle.readFile();
      assertNotAborted(input.signal);
      const openedAfter = await handle.stat();
      if (!sameFileIdentity(openedBefore, openedAfter) || bytes.byteLength !== openedAfter.size) {
        throw new Error(`候选文件在读取期间发生变化：${path}`);
      }
    } finally {
      await handle.close();
    }
    const executable = (before.mode & 0o111) !== 0;
    const digest = hash(bytes);
    input.state.entries.push({
      path,
      kind: "file",
      executable,
      byteLength: bytes.byteLength,
      digest,
    });
    if (input.targetDirectory) {
      const target = join(input.targetDirectory, name);
      assertWithin(resolve(input.targetDirectory), resolve(target), "候选快照文件");
      const targetHandle = await open(target, "wx", 0o600);
      try {
        await targetHandle.writeFile(bytes);
        await targetHandle.sync();
      } finally {
        await targetHandle.close();
      }
      await chmod(target, executable ? 0o755 : 0o644);
    }
  }

  assertNotAborted(input.signal);
  const afterDirectory = await lstat(input.sourceDirectory);
  if (!sameFileIdentity(beforeDirectory, afterDirectory)
    || !afterDirectory.isDirectory() || afterDirectory.isSymbolicLink()) {
    throw new Error(`候选目录在遍历期间发生变化：${displayPath(input.relativeSegments)}`);
  }
}

async function checkedDirectoryRoot(
  input: string,
  label: string,
  signal: AbortSignal,
): Promise<string> {
  assertNotAborted(signal);
  if (!isAbsolute(input) || resolve(input) !== input) throw new Error(`${label}必须是规范化绝对路径`);
  const info = await lstat(input);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label}类型无效`);
  const actual = await realpath(input);
  if (actual !== input) throw new Error(`${label}真实路径已变化`);
  return actual;
}

function assertCandidatePath(path: string, name: string, limits: CandidateTreeLimits): void {
  if (!name || name === "." || name === ".." || name.includes("\0")
    || name.includes("/") || name.includes("\\") || isAbsolute(path)
    || Buffer.byteLength(path, "utf8") > limits.maxPathBytes) {
    throw new Error(`候选包含不安全路径：${path}`);
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CandidateOperationAbortedError();
}

function assertWithin(root: string, target: string, label: string): void {
  const path = relative(root, target);
  if (!path || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error(`${label}超出受控目录`);
}

function assertOutside(sourceRoot: string, targetRoot: string, message: string): void {
  const path = relative(sourceRoot, targetRoot);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) {
    throw new Error(message);
  }
}

function displayPath(segments: readonly string[]): string {
  return segments.length === 0 ? "." : segments.join("/");
}

function sameFileIdentity(
  left: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
    readonly size: number | bigint;
    readonly mtimeMs: number;
  },
  right: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
    readonly size: number | bigint;
    readonly mtimeMs: number;
  },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function manifest(state: WalkState): CandidateTreeManifest {
  return Object.freeze({
    digest: hash(Buffer.from(JSON.stringify(state.entries), "utf8")),
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
  });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
