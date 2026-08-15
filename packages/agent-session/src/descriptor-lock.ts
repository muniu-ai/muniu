// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

const LOCK_COMMAND_TIMEOUT_MS = 5_000;
const INHERITED_LOCK_FD = 3;

export interface DescriptorLockCommand {
  readonly executable: string;
  readonly argumentsFor: (descriptor: number) => readonly string[];
}

export class DescriptorLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DescriptorLockError";
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveDescriptorLockCommand(
  platform: NodeJS.Platform = process.platform,
  executable: (filePath: string) => Promise<boolean> = isExecutable
): Promise<DescriptorLockCommand> {
  if (platform === "darwin") {
    if (!await executable("/usr/bin/lockf")) {
      throw new DescriptorLockError("descriptor lock command helper is unavailable");
    }
    return {
      executable: "/usr/bin/lockf",
      argumentsFor: (descriptor) => ["-s", "-t", "0", String(descriptor)]
    };
  }
  if (platform === "linux") {
    for (const candidate of ["/usr/bin/flock", "/bin/flock"] as const) {
      if (await executable(candidate)) {
        return {
          executable: candidate,
          argumentsFor: (descriptor) => ["-n", String(descriptor)]
        };
      }
    }
    throw new DescriptorLockError("descriptor lock command helper is unavailable");
  }
  throw new DescriptorLockError(`descriptor locks are unsupported on ${platform}`);
}

function observeClose(
  child: ChildProcess
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    const onError = (error: Error) => { spawnError = error; };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off("error", onError);
      resolve({ code, signal, ...(spawnError === undefined ? {} : { error: spawnError }) });
    };
    child.on("error", onError);
    child.once("close", onClose);
  });
}

function waitBounded<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DescriptorLockError(timeoutMessage)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

function killRunningChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export async function settleDescriptorLockCommand(
  child: ChildProcess,
  timeoutMs = LOCK_COMMAND_TIMEOUT_MS
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error }> {
  const closed = observeClose(child);
  try {
    return await waitBounded(closed, timeoutMs, "descriptor lock command timed out");
  } catch (error: unknown) {
    killRunningChild(child);
    try {
      await waitBounded(closed, timeoutMs, "descriptor lock command could not be terminated");
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "descriptor lock command and cleanup failed",
        { cause: error }
      );
    }
    throw error;
  }
}

export async function acquireInheritedDescriptorLock(sourceDescriptor: number): Promise<void> {
  if (!Number.isSafeInteger(sourceDescriptor) || sourceDescriptor < 0) {
    throw new DescriptorLockError("descriptor lock source is invalid");
  }
  const command = await resolveDescriptorLockCommand();
  let child: ChildProcess;
  try {
    child = spawn(command.executable, [...command.argumentsFor(INHERITED_LOCK_FD)], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe", sourceDescriptor]
    });
  } catch (error: unknown) {
    throw new DescriptorLockError("descriptor lock command could not start", { cause: error });
  }
  child.stderr?.resume();
  const result = await settleDescriptorLockCommand(child);
  if (result.error !== undefined) {
    throw new DescriptorLockError("descriptor lock command failed to start", { cause: result.error });
  }
  if (result.code !== 0 || result.signal !== null) {
    throw new DescriptorLockError("descriptor writer lock is already held or unavailable");
  }
}
