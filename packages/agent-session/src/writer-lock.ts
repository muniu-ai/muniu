// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, mkdir, open, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_START_TIMEOUT_MS = 5_000;
const LOCK_EXIT_TIMEOUT_MS = 5_000;
const MAX_HANDSHAKE_BYTES = 128;
const uid = process.getuid?.();
const lockRoot = path.join(os.tmpdir(), `muniu-agent-session-writer-locks-${String(uid ?? "unsupported")}`);

interface WriterLockHelper {
  readonly executable: string;
  readonly argumentsFor: (filePath: string) => readonly string[];
}

interface HolderState {
  expectedExit: boolean;
  lost: boolean;
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface OsWriterLock {
  readonly identity: string;
  readonly nonce: string;
  readonly holderPid: number;
  readonly released: boolean;
  release(): Promise<void>;
}

export class WriterLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WriterLockError";
  }
}

function identityDigest(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWriterLockHelper(
  platform: NodeJS.Platform = process.platform,
  executable: (filePath: string) => Promise<boolean> = isExecutable
): Promise<WriterLockHelper> {
  if (!await executable("/bin/cat")) {
    throw new WriterLockError("writer lock command helper is unavailable");
  }
  if (platform === "darwin") {
    if (!await executable("/usr/bin/lockf")) {
      throw new WriterLockError("writer lock command helper is unavailable");
    }
    return {
      executable: "/usr/bin/lockf",
      argumentsFor: (filePath) => ["-t", "0", "-k", filePath, "/bin/cat"]
    };
  }
  if (platform === "linux") {
    for (const candidate of ["/usr/bin/flock", "/bin/flock"] as const) {
      if (await executable(candidate)) {
        return {
          executable: candidate,
          argumentsFor: (filePath) => ["-n", filePath, "/bin/cat"]
        };
      }
    }
    throw new WriterLockError("writer lock command helper is unavailable");
  }
  throw new WriterLockError(`writer locks are unsupported on ${platform}`);
}

async function openLockDirectory(directoryPath: string): Promise<{ readonly handle: FileHandle; readonly stat: Stats }> {
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  const stat = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    await handle.close();
    throw new WriterLockError("writer lock directory has unsafe type, ownership, or permissions");
  }
  return { handle, stat };
}

let lockRootReady: Promise<void> | undefined;

async function ensureLockRoot(): Promise<void> {
  if (uid === undefined) throw new WriterLockError("writer locks require an operating-system user identity");
  lockRootReady ??= (async () => {
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const directory = await openLockDirectory(lockRoot);
    await directory.handle.close();
  })();
  return lockRootReady;
}

async function syncLockRoot(): Promise<void> {
  const directory = await openLockDirectory(lockRoot);
  try {
    await directory.handle.sync();
  } finally {
    await directory.handle.close();
  }
}

function assertSafeLockFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
    throw new WriterLockError("writer lock has unsafe type, ownership, permissions, or link count");
  }
}

async function openSafeLockFile(filePath: string): Promise<{ handle: FileHandle; stat: Stats }> {
  let handle: FileHandle;
  let created = false;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
    created = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new WriterLockError("writer lock file could not be created safely", { cause: error });
    }
    try {
      handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (openError: unknown) {
      throw new WriterLockError("writer lock file could not be opened safely", { cause: openError });
    }
  }

  try {
    if (created) {
      await handle.chmod(0o600);
      await handle.sync();
    }
    const stat = await handle.stat();
    assertSafeLockFile(stat);
    if (created) await syncLockRoot();
    return { handle, stat };
  } catch (error: unknown) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function observeHolder(child: ChildProcessWithoutNullStreams): HolderState {
  let settle!: (result: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void;
  const state: HolderState = {
    expectedExit: false,
    lost: false,
    closed: new Promise((resolve) => { settle = resolve; })
  };
  let settled = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    if (!state.expectedExit) state.lost = true;
    settle({ code, signal });
  };
  child.once("error", () => {
    if (!state.expectedExit) state.lost = true;
  });
  child.once("exit", () => {
    if (!state.expectedExit) state.lost = true;
  });
  child.once("close", finish);
  return state;
}

function waitBounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WriterLockError(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function awaitHandshake(
  child: ChildProcessWithoutNullStreams,
  state: HolderState,
  nonce: string
): Promise<void> {
  const expected = `${nonce}\n`;
  await waitBounded(new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (completion: () => void) => {
      if (settled) return;
      settled = true;
      child.stdout.off("data", onData);
      completion();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output, "utf8") > MAX_HANDSHAKE_BYTES) {
        finish(() => reject(new WriterLockError("writer lock helper returned an invalid handshake")));
      } else if (output.includes("\n")) {
        finish(() => {
          if (output === expected) resolve();
          else reject(new WriterLockError("writer lock helper returned an invalid handshake"));
        });
      }
    };
    child.stdout.on("data", onData);
    void state.closed.then(({ code, signal }) => {
      finish(() => reject(new WriterLockError(
        `writer lock helper exited before acquisition (code=${String(code)}, signal=${String(signal)})`
      )));
    });
    child.stdin.write(expected, (error) => {
      if (error !== null && error !== undefined) {
        finish(() => reject(new WriterLockError("writer lock helper rejected its handshake", { cause: error })));
      }
    });
  }), LOCK_START_TIMEOUT_MS, "writer lock helper acquisition timed out");
}

async function stopHolder(child: ChildProcessWithoutNullStreams, state: HolderState): Promise<void> {
  state.expectedExit = true;
  child.stdin.end();
  try {
    await waitBounded(state.closed, LOCK_EXIT_TIMEOUT_MS, "writer lock helper exit timed out");
  } catch (error: unknown) {
    child.kill("SIGKILL");
    try {
      await waitBounded(state.closed, LOCK_EXIT_TIMEOUT_MS, "writer lock helper did not terminate after SIGKILL");
    } catch (killError: unknown) {
      throw new AggregateError([error, killError], "writer lock helper could not be stopped", { cause: error });
    }
    throw error;
  }
}

class OwnedWriterLock implements OsWriterLock {
  private isReleased = false;

  constructor(
    readonly identity: string,
    readonly nonce: string,
    readonly holderPid: number,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly state: HolderState
  ) {}

  get released(): boolean {
    return this.isReleased || this.state.lost;
  }

  async release(): Promise<void> {
    if (this.isReleased) return;
    this.isReleased = true;
    if (this.state.lost) {
      const lost = new WriterLockError("writer lock helper exited unexpectedly and the lease was lost");
      try {
        await stopHolder(this.child, this.state);
      } catch (cleanupError: unknown) {
        throw new AggregateError([lost, cleanupError], "lost writer lock helper cleanup failed", { cause: lost });
      }
      throw lost;
    }
    await stopHolder(this.child, this.state);
    const result = await this.state.closed;
    if (result.code !== 0 || result.signal !== null) {
      throw new WriterLockError("writer lock helper exited abnormally during release");
    }
  }
}

export async function acquireOsWriterLock(identity: string): Promise<OsWriterLock> {
  await ensureLockRoot();
  const helper = await resolveWriterLockHelper();
  const filePath = path.join(lockRoot, `${identityDigest(identity)}.lock`);
  const root = await openLockDirectory(lockRoot);
  const rootHandle = root.handle;
  const rootStat = root.stat;
  let lockFile: Awaited<ReturnType<typeof openSafeLockFile>>;
  try {
    lockFile = await openSafeLockFile(filePath);
  } catch (error: unknown) {
    try {
      await rootHandle.close();
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "writer lock open and cleanup failed", { cause: error });
    }
    throw error;
  }
  const nonce = randomUUID();
  let child: ChildProcessWithoutNullStreams | undefined;
  let state: HolderState | undefined;
  let rootClosed = false;
  let lockFileClosed = false;
  const closeRoot = async () => {
    if (rootClosed) return;
    rootClosed = true;
    await rootHandle.close();
  };
  const closeLockFile = async () => {
    if (lockFileClosed) return;
    lockFileClosed = true;
    await lockFile.handle.close();
  };
  try {
    child = spawn(helper.executable, [...helper.argumentsFor(filePath)], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    state = observeHolder(child);
    await awaitHandshake(child, state, nonce);
    const current = await openSafeLockFile(filePath);
    try {
      if (!sameFile(lockFile.stat, current.stat)) {
        throw new WriterLockError("writer lock identity changed during helper acquisition");
      }
    } finally {
      await current.handle.close();
    }
    const currentRoot = await openLockDirectory(lockRoot);
    try {
      if (!sameFile(rootStat, currentRoot.stat)) {
        throw new WriterLockError("writer lock directory identity changed during helper acquisition");
      }
    } finally {
      await currentRoot.handle.close();
    }
    if (state.lost || child.pid === undefined) {
      throw new WriterLockError("writer lock helper exited during acquisition");
    }
    const closed = await Promise.allSettled([closeLockFile(), closeRoot()]);
    const closeErrors = closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, "writer lock verification descriptors could not be closed");
    }
    return new OwnedWriterLock(identity, nonce, child.pid, child, state);
  } catch (error: unknown) {
    const cleanup = [
      closeLockFile(),
      closeRoot(),
      ...(child === undefined || state === undefined ? [] : [stopHolder(child, state)])
    ];
    const settled = await Promise.allSettled(cleanup);
    const cleanupErrors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "writer lock acquisition and cleanup failed", {
        cause: error
      });
    }
    throw error;
  }
}
