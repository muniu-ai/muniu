// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { acquireLocalStateLock } from "../src/index.js";

test("macOS state ownership does not require a lock helper", { skip: process.platform !== "darwin" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "mn-state-no-helper-"));
  const helper = t.mock.method(childProcess, "spawn", () => { throw new Error("lock helper is unavailable"); });
  syncBuiltinESMExports();
  try {
    const first = await acquireLocalStateLock(root);
    try { await assert.rejects(acquireLocalStateLock(root), /STATE_IN_USE/); }
    finally { first.release(); }
    const second = await acquireLocalStateLock(root);
    second.release();
    assert.equal(helper.mock.callCount(), 0);
  } finally {
    helper.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local state ownership is an OS lock retained until release", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-state-owner-"));
  try {
    const first = await acquireLocalStateLock(root);
    try { await assert.rejects(acquireLocalStateLock(root), /STATE_IN_USE/); }
    finally { first.release(); }
    const second = await acquireLocalStateLock(root);
    second.release();
    second.release();
    symlinkSync(join(root, "state.lock"), join(root, "aliased-root"));
    await assert.rejects(acquireLocalStateLock(join(root, "aliased-root")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local state locking rejects unsafe roots and lock files without retaining a failed lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-state-private-"));
  const lockFile = join(root, "state.owner.lock");
  try {
    chmodSync(root, 0o755);
    await assert.rejects(acquireLocalStateLock(root), /LOCAL_STATE_INVALID/);
    chmodSync(root, 0o700);

    writeFileSync(lockFile, "", { mode: 0o600 });
    chmodSync(lockFile, 0o644);
    await assert.rejects(acquireLocalStateLock(root), /LOCAL_STATE_INVALID/);
    chmodSync(lockFile, 0o600);
    const recovered = await acquireLocalStateLock(root);
    recovered.release();

    const target = join(root, "target");
    writeFileSync(target, "", { mode: 0o600 });
    rmSync(lockFile);
    symlinkSync(target, lockFile);
    await assert.rejects(acquireLocalStateLock(root), { code: "ELOOP" });
    rmSync(lockFile);
    mkdirSync(lockFile, { mode: 0o700 });
    await assert.rejects(acquireLocalStateLock(root), { code: "EISDIR" });

    const alias = join(root, "alias");
    symlinkSync(root, alias);
    await assert.rejects(acquireLocalStateLock(alias), /LOCAL_STATE_INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local state lock is released by the OS when its owner crashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-state-crash-"));
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    'const {acquireLocalStateLock}=await import(process.argv[1]);await acquireLocalStateLock(process.argv[2]);process.stdout.write("ready");process.stdin.resume();',
    new URL("../src/index.js", import.meta.url).href, root], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(child, "exit");
  try {
    const [ready] = await once(child.stdout!, "data");
    assert.equal(ready.toString(), "ready");
    await assert.rejects(acquireLocalStateLock(root), /STATE_IN_USE/);
    child.kill("SIGKILL");
    await exited;
    const recovered = await acquireLocalStateLock(root);
    recovered.release();
  } finally { child.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); }
});
