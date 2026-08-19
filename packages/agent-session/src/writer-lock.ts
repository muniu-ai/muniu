// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireInheritedDescriptorLock,
  resolveDescriptorLockCommand
} from "./descriptor-lock.js";

const LOCK_EXIT_TIMEOUT_MS = 5_000;
const MAX_EVENT_WRITER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_WRITER_ACK_BYTES = 4 * 1024;
const uid = process.getuid?.();
const fixedTemporaryRoot = process.platform === "darwin"
  ? "/private/tmp"
  : process.platform === "linux" ? "/tmp" : undefined;
const lockRoot = fixedTemporaryRoot === undefined
  ? undefined
  : path.join(fixedTemporaryRoot, `muniu-agent-session-writer-locks-${String(uid ?? "unsupported")}`);
const PACKAGED_EVENT_WRITER_ARGUMENT = "--mn-agent-session-event-writer";

export interface EventWriterHelperCommand {
  readonly executable: string;
  readonly staticHelperPath?: string;
  readonly argumentsFor: (nonce: string) => readonly string[];
}

export function resolveEventWriterHelperCommand(
  packaged = process.env.MN_DESKTOP_PACKAGED === "1",
  executable = process.execPath,
  moduleUrl?: string
): EventWriterHelperCommand {
  if (packaged) {
    return {
      executable,
      argumentsFor: (nonce) => [PACKAGED_EVENT_WRITER_ARGUMENT, "3", "4", nonce]
    };
  }
  const staticHelperPath = fileURLToPath(
    new URL("./event-writer-helper.js", moduleUrl ?? import.meta.url)
  );
  return {
    executable,
    staticHelperPath,
    argumentsFor: (nonce) => [staticHelperPath, "3", "4", nonce]
  };
}

interface EventWriterState {
  expectedExit: boolean;
  lost: boolean;
  closedNow: boolean;
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface OsWriterLock {
  readonly identity: string;
  readonly nonce: string;
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

export const resolveWriterLockHelper = resolveDescriptorLockCommand;

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

function waitBounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WriterLockError(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

class OwnedDescriptorWriterLock implements OsWriterLock {
  private isReleased = false;

  constructor(
    readonly identity: string,
    readonly nonce: string,
    private readonly handle: FileHandle
  ) {}

  get released(): boolean {
    return this.isReleased;
  }

  async release(): Promise<void> {
    if (this.isReleased) return;
    this.isReleased = true;
    await this.handle.close();
  }
}

function observeEventWriter(child: ChildProcessWithoutNullStreams): EventWriterState {
  let settle!: (result: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void;
  const state: EventWriterState = {
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

function killTrackedEventWriter(child: ChildProcessWithoutNullStreams, state: EventWriterState): void {
  if (state.closedNow || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
}

async function forceStopEventWriter(
  child: ChildProcessWithoutNullStreams,
  state: EventWriterState
): Promise<void> {
  if (state.closedNow) return;
  state.expectedExit = true;
  child.stdin.destroy();
  killTrackedEventWriter(child, state);
  await waitBounded(state.closed, LOCK_EXIT_TIMEOUT_MS, "event writer helper did not terminate after SIGKILL");
}

async function assertStaticEventWriterHelper(command: EventWriterHelperCommand): Promise<void> {
  if (!path.isAbsolute(command.executable) || !await isExecutable(command.executable)) {
    throw new WriterLockError("event writer Node executable is unavailable");
  }
  if (command.staticHelperPath === undefined) return;
  let handle: FileHandle;
  try {
    handle = await open(
      command.staticHelperPath,
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
  state: EventWriterState,
  nonce: string
): Promise<void> {
  await waitBounded(new Promise<void>((resolve, reject) => {
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
          || ready.pid !== child.pid) {
          reject(new WriterLockError("event writer helper returned an invalid handshake"));
          return;
        }
        resolve();
      });
    };
    child.stdout.on("data", onData);
    void state.closed.then(({ code, signal }) => {
      finish(() => reject(new WriterLockError(
        `event writer helper exited before acquisition (code=${String(code)}, signal=${String(signal)})`
      )));
    });
  }), LOCK_EXIT_TIMEOUT_MS, "event writer helper acquisition timed out");
}

interface PendingWriterRequest {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
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
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly state: EventWriterState
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
        await forceStopEventWriter(this.child, this.state);
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
      await forceStopEventWriter(this.child, this.state);
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
      }, LOCK_EXIT_TIMEOUT_MS);
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
    killTrackedEventWriter(this.child, this.state);
  }
}

export async function acquireOsWriterLock(identity: string): Promise<OsWriterLock> {
  await ensureLockRoot();
  if (lockRoot === undefined) throw new WriterLockError("writer lock directory is unavailable");
  const filePath = path.join(lockRoot, `${identityDigest(identity)}.lock`);
  const root = await openLockDirectory(lockRoot);
  let lockFile: Awaited<ReturnType<typeof openSafeLockFile>> | undefined;
  let rootClosed = false;
  let lockClosed = false;
  const closeRoot = async () => {
    if (rootClosed) return;
    rootClosed = true;
    await root.handle.close();
  };
  const closeLock = async () => {
    if (lockClosed || lockFile === undefined) return;
    lockClosed = true;
    await lockFile.handle.close();
  };
  try {
    lockFile = await openSafeLockFile(filePath);
    await acquireInheritedDescriptorLock(lockFile.handle.fd);
    const current = await openSafeLockFile(filePath);
    try {
      if (!sameFile(lockFile.stat, current.stat)) {
        throw new WriterLockError("writer lock identity changed during descriptor acquisition");
      }
    } finally {
      await current.handle.close();
    }
    const currentRoot = await openLockDirectory(lockRoot);
    try {
      if (!sameFile(root.stat, currentRoot.stat)) {
        throw new WriterLockError("writer lock directory identity changed during descriptor acquisition");
      }
    } finally {
      await currentRoot.handle.close();
    }
    await closeRoot();
    return new OwnedDescriptorWriterLock(identity, randomUUID(), lockFile.handle);
  } catch (error: unknown) {
    const settled = await Promise.allSettled([closeLock(), closeRoot()]);
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
  const helperCommand = resolveEventWriterHelperCommand();
  await assertStaticEventWriterHelper(helperCommand);
  const filePath = path.join(lockRoot, `${identityDigest(identity)}.lock`);
  const root = await openLockDirectory(lockRoot);
  let lockFile: Awaited<ReturnType<typeof openSafeLockFile>> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let state: EventWriterState | undefined;
  let rootClosed = false;
  let lockClosed = false;
  const closeRoot = async () => {
    if (rootClosed) return;
    rootClosed = true;
    await root.handle.close();
  };
  const closeLock = async () => {
    if (lockClosed || lockFile === undefined) return;
    lockClosed = true;
    await lockFile.handle.close();
  };

  try {
    lockFile = await openSafeLockFile(filePath);
    const nonce = randomUUID();
    child = spawn(helperCommand.executable, [...helperCommand.argumentsFor(nonce)], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe", eventHandle.fd, lockFile.handle.fd]
    }) as unknown as ChildProcessWithoutNullStreams;
    child.stdin.on("error", () => {});
    child.stderr.resume();
    state = observeEventWriter(child);
    await awaitEventWriterReady(child, state, nonce);

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
      if (!sameFile(root.stat, currentRoot.stat)) {
        throw new WriterLockError("event writer lock directory identity changed during helper acquisition");
      }
    } finally {
      await currentRoot.handle.close();
    }
    const settled = await Promise.allSettled([closeLock(), closeRoot()]);
    const closeErrors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, "event writer verification descriptors could not be closed");
    }
    return new OwnedEventWriterLock(identity, nonce, child, state);
  } catch (error: unknown) {
    const cleanup = [closeLock(), closeRoot()];
    if (child !== undefined && state !== undefined) cleanup.push(forceStopEventWriter(child, state));
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
