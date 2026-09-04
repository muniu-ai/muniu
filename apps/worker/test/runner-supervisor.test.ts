// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Runner 主进程退出后仍会终止同组后台进程再写入终止证明", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muniu-runner-group-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const backgroundPidPath = join(root, "background.pid");
  const token = "cd".repeat(32);
  await writeFile(statePath, `${JSON.stringify({
    protocol: "mn-runner-supervisor-v1",
    token,
    status: "prepared",
    updatedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config = Buffer.from(JSON.stringify({
    protocol: "mn-runner-supervisor-v1",
    statePath,
    token,
    executable: "/bin/sh",
    cwd: root,
    args: ["-c", `sleep 60 >/dev/null 2>&1 & echo $! > ${backgroundPidPath}`],
    env: { PATH: "/usr/bin:/bin" },
  }), "utf8").toString("base64url");
  const supervisor = spawn(process.execPath, [
    fileURLToPath(new URL("../src/runner-supervisor.js", import.meta.url)),
  ], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", MN_RUNNER_SUPERVISOR_CONFIG: config },
    stdio: ["pipe", "ignore", "pipe", "pipe"],
  });
  t.after(() => { if (supervisor.exitCode === null) supervisor.kill("SIGKILL"); });
  supervisor.stdin!.end();
  const terminated = await waitForState(statePath, "terminated");
  assert.match(terminated.reason, /^exit:0/u);
  const backgroundPid = Number.parseInt((await readFile(backgroundPidPath, "utf8")).trim(), 10);
  assert.ok(Number.isSafeInteger(backgroundPid));
  assert.throws(
    () => process.kill(backgroundPid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
});

async function waitForState(
  statePath: string,
  expected: "terminated",
): Promise<{ readonly status: string; readonly reason: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      readonly status: string;
      readonly reason?: string;
    };
    if (state.status === expected && state.reason) return { ...state, reason: state.reason };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("Runner 监督器没有写入进程组终止证明");
}
