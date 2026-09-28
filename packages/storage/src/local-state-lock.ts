// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LocalStateLock { release(): void; }
const owners = new WeakMap<LocalStateLock, { root: string; released: boolean }>();
// Darwin's O_EXLOCK is not exposed by Node's fs.constants.
const DARWIN_O_EXLOCK = 0x20;

export function assertLocalStateLock(lock: LocalStateLock, directory: string): void {
  const owner = owners.get(lock);
  if (!owner || owner.released || owner.root !== resolve(directory)) throw new Error("LOCAL_STATE_LOCK_REQUIRED");
}

/** The OS lock belongs to the open file description retained until release or process exit. */
export async function acquireLocalStateLock(directory: string): Promise<LocalStateLock> {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const status = lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new Error("LOCAL_STATE_INVALID: 状态目录必须是私有普通目录");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("LOCAL_STATE_LOCK_UNAVAILABLE");
  const darwin = process.platform === "darwin";
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW
    | (darwin ? DARWIN_O_EXLOCK | constants.O_NONBLOCK : 0);
  let descriptor: number;
  try {
    descriptor = openSync(join(root, "state.owner.lock"), flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (darwin && (code === "EAGAIN" || code === "EWOULDBLOCK")) {
      throw new Error("LOCAL_STATE_IN_USE: 请先退出使用该状态目录的木牛进程", { cause: error });
    }
    throw error;
  }
  let released = false;
  const release = () => { if (!released) { released = true; closeSync(descriptor); } };
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("LOCAL_STATE_INVALID: 状态锁必须是私有普通文件");
    if (!darwin) await new Promise<void>((resolveLock, reject) => {
      const child = spawn("/usr/bin/flock", ["-n", "-E", "75", "3"],
        { stdio: ["ignore", "ignore", "ignore", descriptor] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("LOCAL_STATE_LOCK_UNAVAILABLE")); });
      child.once("exit", code => {
        clearTimeout(timer);
        if (code === 0) resolveLock();
        else reject(new Error(code === 75 ? "LOCAL_STATE_IN_USE: 请先退出使用该状态目录的木牛进程" : "LOCAL_STATE_LOCK_UNAVAILABLE"));
      });
    });
    // Keep the inode and descriptor; unlinking the file would allow a second independent lock.
    const owner = { root, released: false };
    const lock = { release() { owner.released = true; release(); } };
    owners.set(lock, owner);
    return lock;
  } catch (error) { release(); throw error; }
}
