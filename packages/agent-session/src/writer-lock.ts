// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_START_TIMEOUT_MS = 5_000;
const LOCK_EXIT_TIMEOUT_MS = 5_000;
const MAX_HANDSHAKE_BYTES = 128;
const MAX_EVENT_WRITER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_WRITER_ACK_BYTES = 4 * 1024;
const uid = process.getuid?.();
const fixedTemporaryRoot = process.platform === "darwin"
  ? "/private/tmp"
  : process.platform === "linux" ? "/tmp" : undefined;
const lockRoot = fixedTemporaryRoot === undefined
  ? undefined
  : path.join(fixedTemporaryRoot, `muniu-agent-session-writer-locks-${String(uid ?? "unsupported")}`);
const eventWriterHelperPath = fileURLToPath(new URL("./event-writer-helper.js", import.meta.url));
const nodeExecutable = process.execPath;

interface WriterLockHelper {
  readonly executable: string;
  readonly argumentsFor: (
    filePath: string,
    command?: string,
    commandArguments?: readonly string[]
  ) => readonly string[];
}

interface HolderState {
  expectedExit: boolean;
  lost: boolean;
  closedNow: boolean;
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface OsWriterLock {
  readonly identity: string;
  readonly nonce: string;
  readonly holderPid: number;
  readonly released: boolean;
  release(): Promise<void>;
}

export interface EventWriterLock extends OsWriterLock {
  append(line: string): Promise<void>;
  flush(): Promise<void>;
  truncate(length: number): Promise<void>;
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
      argumentsFor: (filePath, command = "/bin/cat", commandArguments = []) => [
        "-t", "0", "-k", filePath, command, ...commandArguments
      ]
    };
  }
  if (platform === "linux") {
    for (const candidate of ["/usr/bin/flock", "/bin/flock"] as const) {
      if (await executable(candidate)) {
        return {
          executable: candidate,
          argumentsFor: (filePath, command = "/bin/cat", commandArguments = []) => [
            "-n", filePath, command, ...commandArguments
          ]
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
  if (uid === undefined || lockRoot === undefined) {
    throw new WriterLockError("writer locks require a supported operating-system user identity");
  }
  lockRootReady ??= (async () => {
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const directory = await openLockDirectory(lockRoot);
    await directory.handle.close();
  })();
  return lockRootReady;
}

async function syncLockRoot(): Promise<void> {
  if (lockRoot === undefined) throw new WriterLockError("writer lock directory is unavailable");
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
    closedNow: false,
    closed: new Promise((resolve) => { settle = resolve; })
  };
  let settled = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    state.closedNow = true;
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

interface PendingWriterRequest {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

function ignoreMissingProcess(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
}

function killEventWriterGroup(child: ChildProcessWithoutNullStreams, helperPid?: number): void {
  if (helperPid !== undefined) {
    try {
      process.kill(helperPid, "SIGKILL");
    } catch (error: unknown) {
      ignoreMissingProcess(error);
    }
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error: unknown) {
      ignoreMissingProcess(error);
    }
  }
  child.kill("SIGKILL");
}

async function forceStopEventWriter(
  child: ChildProcessWithoutNullStreams,
  state: HolderState,
  helperPid?: number
): Promise<void> {
  if (state.closedNow) return;
  state.expectedExit = true;
  child.stdin.destroy();
  killEventWriterGroup(child, helperPid);
  await waitBounded(state.closed, LOCK_EXIT_TIMEOUT_MS, "event writer helper did not terminate after SIGKILL");
}

async function assertStaticEventWriterHelper(): Promise<void> {
  if (!path.isAbsolute(nodeExecutable) || !await isExecutable(nodeExecutable)) {
    throw new WriterLockError("event writer Node executable is unavailable");
  }
  let handle: FileHandle;
  try {
    handle = await open(
      eventWriterHelperPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    throw new WriterLockError("compiled event writer helper is unavailable", { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new WriterLockError("compiled event writer helper is not a regular file");
  } finally {
    await handle.close();
  }
}

async function awaitEventWriterReady(
  child: ChildProcessWithoutNullStreams,
  state: HolderState,
  nonce: string
): Promise<number> {
  return waitBounded(new Promise<number>((resolve, reject) => {
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (completion: () => void) => {
      if (settled) return;
      settled = true;
      child.stdout.off("data", onData);
      completion();
    };
    const onData = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_EVENT_WRITER_ACK_BYTES) {
        finish(() => reject(new WriterLockError("event writer helper returned an oversized handshake")));
        return;
      }
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== output.length - 1) {
        finish(() => reject(new WriterLockError("event writer helper returned an invalid handshake")));
        return;
      }
      finish(() => {
        let value: unknown;
        try {
          value = JSON.parse(output.subarray(0, newline).toString("utf8"));
        } catch {
          reject(new WriterLockError("event writer helper returned an invalid handshake"));
          return;
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          reject(new WriterLockError("event writer helper returned an invalid handshake"));
          return;
        }
        const ready = value as Record<string, unknown>;
        if (Object.keys(ready).length !== 3
          || ready.nonce !== nonce
          || ready.status !== "ready"
          || !Number.isSafeInteger(ready.pid)
          || (ready.pid as number) <= 0) {
          reject(new WriterLockError("event writer helper returned an invalid handshake"));
          return;
        }
        resolve(ready.pid as number);
      });
    };
    child.stdout.on("data", onData);
    void state.closed.then(({ code, signal }) => {
      finish(() => reject(new WriterLockError(
        `event writer helper exited before acquisition (code=${String(code)}, signal=${String(signal)})`
      )));
    });
  }), LOCK_START_TIMEOUT_MS, "event writer helper acquisition timed out");
}

class OwnedEventWriterLock implements EventWriterLock {
  private isReleased = false;
  private closing = false;
  private output = Buffer.alloc(0);
  private failure: WriterLockError | undefined;
  private readonly pending = new Map<string, PendingWriterRequest>();

  constructor(
    readonly identity: string,
    readonly nonce: string,
    readonly holderPid: number,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly state: HolderState
  ) {
    child.stdout.on("data", (chunk: Buffer) => { this.acceptOutput(chunk); });
    child.once("error", () => {
      if (!state.expectedExit) this.lose("event writer helper process failed");
    });
    child.once("exit", () => {
      if (!state.expectedExit) this.lose("event writer helper exited unexpectedly");
    });
  }

  get released(): boolean {
    return this.isReleased || this.state.lost || this.failure !== undefined;
  }

  append(line: string): Promise<void> {
    if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
      return Promise.reject(new WriterLockError("event writer append must be one complete JSONL record"));
    }
    return this.request({ operation: "append", line });
  }

  flush(): Promise<void> {
    return this.request({ operation: "flush" });
  }

  truncate(length: number): Promise<void> {
    if (!Number.isSafeInteger(length) || length < 0) {
      return Promise.reject(new WriterLockError("event writer truncate length is invalid"));
    }
    return this.request({ operation: "truncate", length });
  }

  async release(): Promise<void> {
    if (this.isReleased) return;
    this.isReleased = true;
    if (this.state.lost || this.failure !== undefined) {
      const failure = this.failure
        ?? new WriterLockError("event writer helper exited unexpectedly and the lease was lost");
      try {
        await forceStopEventWriter(this.child, this.state, this.holderPid);
      } catch (cleanupError: unknown) {
        throw new AggregateError([failure, cleanupError], "lost event writer cleanup failed", { cause: failure });
      }
      throw failure;
    }

    this.closing = true;
    this.state.expectedExit = true;
    let primary: unknown;
    try {
      await this.request({ operation: "close" }, true);
      this.child.stdin.end();
      const result = await waitBounded(
        this.state.closed,
        LOCK_EXIT_TIMEOUT_MS,
        "event writer helper exit timed out"
      );
      if (result.code !== 0 || result.signal !== null) {
        throw new WriterLockError("event writer helper exited abnormally during release");
      }
      return;
    } catch (error: unknown) {
      primary = error;
    }
    try {
      await forceStopEventWriter(this.child, this.state, this.holderPid);
    } catch (cleanupError: unknown) {
      throw new AggregateError([primary, cleanupError], "event writer release cleanup failed", { cause: primary });
    }
    throw primary;
  }

  private request(
    fields: { readonly operation: "append"; readonly line: string }
      | { readonly operation: "truncate"; readonly length: number }
      | { readonly operation: "flush" | "close" },
    allowClosing = false
  ): Promise<void> {
    if (this.state.lost
      || this.failure !== undefined
      || (this.isReleased && !allowClosing)
      || (this.closing && !allowClosing)) {
      return Promise.reject(this.failure ?? new WriterLockError("event writer lease is not held"));
    }
    const requestId = randomUUID();
    const frame = `${JSON.stringify({ nonce: this.nonce, requestId, ...fields })}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_EVENT_WRITER_FRAME_BYTES) {
      return Promise.reject(new WriterLockError("event writer request exceeds the bounded frame size"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lose("event writer helper acknowledgement timed out");
      }, LOCK_START_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(frame, (error) => {
        if (error !== null && error !== undefined) this.lose("event writer helper rejected a request");
      });
    });
  }

  private acceptOutput(chunk: Buffer): void {
    if (this.failure !== undefined || this.isReleased && !this.closing) return;
    this.output = Buffer.concat([this.output, chunk]);
    if (this.output.length > MAX_EVENT_WRITER_ACK_BYTES) {
      this.lose("event writer helper returned an oversized acknowledgement");
      return;
    }
    let newline = this.output.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.output.subarray(0, newline).toString("utf8");
      this.output = this.output.subarray(newline + 1);
      let value: unknown;
      try {
        value = JSON.parse(frame);
      } catch {
        this.lose("event writer helper returned an invalid acknowledgement");
        return;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        this.lose("event writer helper returned an invalid acknowledgement");
        return;
      }
      const ack = value as Record<string, unknown>;
      const pending = typeof ack.requestId === "string" ? this.pending.get(ack.requestId) : undefined;
      if (Object.keys(ack).length !== 3
        || ack.nonce !== this.nonce
        || ack.status !== "ok"
        || pending === undefined) {
        this.lose("event writer helper returned an invalid acknowledgement");
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(ack.requestId as string);
      pending.resolve();
      newline = this.output.indexOf(0x0a);
    }
  }

  private lose(message: string): void {
    if (this.failure !== undefined) return;
    const failure = new WriterLockError(message);
    this.failure = failure;
    this.state.lost = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    this.pending.clear();
    try {
      killEventWriterGroup(this.child, this.holderPid);
    } catch {
      // The failed helper is already unusable; release reports bounded cleanup.
    }
  }
}

export async function acquireOsWriterLock(identity: string): Promise<OsWriterLock> {
  await ensureLockRoot();
  if (lockRoot === undefined) throw new WriterLockError("writer lock directory is unavailable");
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

export async function acquireEventWriterLock(
  identity: string,
  eventHandle: FileHandle
): Promise<EventWriterLock> {
  await ensureLockRoot();
  if (lockRoot === undefined) throw new WriterLockError("writer lock directory is unavailable");
  await assertStaticEventWriterHelper();
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
      throw new AggregateError([error, cleanupError], "event writer lock open and cleanup failed", {
        cause: error
      });
    }
    throw error;
  }

  const nonce = randomUUID();
  let child: ChildProcessWithoutNullStreams | undefined;
  let state: HolderState | undefined;
  let helperPid: number | undefined;
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
    const spawned = spawn(helper.executable, [
      ...helper.argumentsFor(filePath, nodeExecutable, [eventWriterHelperPath, "3", nonce])
    ], {
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", eventHandle.fd]
    }) as unknown as ChildProcessWithoutNullStreams;
    child = spawned;
    spawned.stdin.on("error", () => {});
    spawned.stderr.resume();
    const observed = observeHolder(spawned);
    state = observed;
    helperPid = await awaitEventWriterReady(spawned, observed, nonce);

    const current = await openSafeLockFile(filePath);
    try {
      if (!sameFile(lockFile.stat, current.stat)) {
        throw new WriterLockError("event writer lock identity changed during helper acquisition");
      }
    } finally {
      await current.handle.close();
    }
    const currentRoot = await openLockDirectory(lockRoot);
    try {
      if (!sameFile(rootStat, currentRoot.stat)) {
        throw new WriterLockError("event writer lock directory identity changed during helper acquisition");
      }
    } finally {
      await currentRoot.handle.close();
    }
    if (observed.lost || spawned.pid === undefined) {
      throw new WriterLockError("event writer helper exited during acquisition");
    }
    const closed = await Promise.allSettled([closeLockFile(), closeRoot()]);
    const closeErrors = closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, "event writer verification descriptors could not be closed");
    }
    return new OwnedEventWriterLock(identity, nonce, helperPid, spawned, observed);
  } catch (error: unknown) {
    const cleanup = [closeLockFile(), closeRoot()];
    if (child !== undefined && state !== undefined) {
      cleanup.push(forceStopEventWriter(child, state, helperPid));
    }
    const settled = await Promise.allSettled(cleanup);
    const cleanupErrors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "event writer acquisition and cleanup failed", {
        cause: error
      });
    }
    throw error;
  }
}
