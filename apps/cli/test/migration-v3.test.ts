// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { SessionId } from "@mn/agent-protocol";
import { JsonlAgentSessionStore } from "@mn/agent-session";

const execFileAsync = promisify(execFile);

async function missing(filePath: string): Promise<boolean> {
  return access(filePath).then(() => false, () => true);
}

test("migrate app-server-v3 defaults to dry-run and requires explicit apply or rollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-cli-v3-"));
  const store = new JsonlAgentSessionStore(root);
  await store.create({
    schemaVersion: 2,
    sessionId: SessionId("session-cli-migrate"),
    cwd: "/workspace/project",
    modelBinding: {
      schemaVersion: 1,
      kind: "agent-model-binding",
      providerId: "openai",
      modelId: "gpt-5"
    }
  });
  await store.dispose();
  const cli = path.join(process.cwd(), "dist-test", "src", "index.js");

  const dryRun = await execFileAsync(process.execPath, [
    cli, "migrate", "app-server-v3", "--root", root, "--dry-run"
  ]);
  assert.equal(JSON.parse(dryRun.stdout).mode, "dry-run");
  assert.equal(await missing(path.join(root, "threads")), true);

  const applied = await execFileAsync(process.execPath, [
    cli, "migrate", "app-server-v3", "--root", root, "--apply"
  ]);
  assert.equal(JSON.parse(applied.stdout).mode, "applied");
  const rolledBack = await execFileAsync(process.execPath, [
    cli, "migrate", "app-server-v3", "--root", root, "--rollback"
  ]);
  assert.equal(JSON.parse(rolledBack.stdout).mode, "rolled-back");

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      cli, "migrate", "app-server-v3", "--root", root, "--apply", "--rollback"
    ]),
    /exactly one migration mode/iu
  );
});
