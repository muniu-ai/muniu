// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("mn app-server serves the v2 initialize transcript over stdio", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mn-cli-app-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(process.cwd(), "dist-test", "src", "index.js");
  const child = spawn(process.execPath, [entry, "app-server", "--transport", "stdio", "--root", root, "--mock"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "cli-test", version: "0.2.0" } }
  })}\n`);
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`initialize timed out: ${stderr}`)), 10_000);
    const inspect = () => {
      const line = stdout.split("\n").find(Boolean);
      if (!line) return;
      clearTimeout(timeout);
      resolve(JSON.parse(line) as Record<string, unknown>);
    };
    child.stdout.on("data", inspect);
    inspect();
  });
  assert.equal(response.id, 1);
  assert.equal((response.result as { protocolVersion?: unknown }).protocolVersion, "2");
  assert.equal(stdout.trimStart().startsWith("{"), true);
  child.stdin.end(`${JSON.stringify({ method: "initialized" })}\n`);
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
});
