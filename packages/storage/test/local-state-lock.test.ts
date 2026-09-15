// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLocalStateLock } from "../src/index.js";

test("local state ownership is an OS lock retained after the helper exits", async () => {
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
