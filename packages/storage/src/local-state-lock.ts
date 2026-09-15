// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LocalStateLock { release(): void; }
const owners = new WeakMap<LocalStateLock, { root: string; released: boolean }>();

export function assertLocalStateLock(lock: LocalStateLock, directory: string): void {
  const owner = owners.get(lock);
  if (!owner || owner.released || owner.root !== resolve(directory)) throw new Error("LOCAL_STATE_LOCK_REQUIRED");
}

/** flock belongs to the shared open file description, not the short-lived helper process. */
export async function acquireLocalStateLock(directory: string): Promise<LocalStateLock> {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const status = lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new Error("LOCAL_STATE_INVALID: 状态目录必须是私有普通目录");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("LOCAL_STATE_LOCK_UNAVAILABLE");
  const descriptor = openSync(join(root, "state.owner.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let released = false;
  const release = () => { if (!released) { released = true; closeSync(descriptor); } };
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("LOCAL_STATE_INVALID: 状态锁必须是私有普通文件");
    await new Promise<void>((resolveLock, reject) => {
      const child = spawn(process.platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock",
        process.platform === "darwin" ? ["-s", "-t", "0", "3"] : ["-n", "-E", "75", "3"],
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
