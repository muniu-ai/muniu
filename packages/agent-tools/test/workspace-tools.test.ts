// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceTools } from "../src/index.js";

test("workspace tools read, search, replace and run allowlisted commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "muniu-tools-"));
  await writeFile(join(root, "hello.txt"), "hello world\n", "utf8");
  const tools = createWorkspaceTools({ allowedCommands: [process.execPath] });
  const context = { sessionId: "tools-session", cwd: root };
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(
    await byName.get("read_file")!.execute({ path: "hello.txt" }, context),
    { path: "hello.txt", content: "hello world\n", truncated: false }
  );
  assert.deepEqual(
    await byName.get("search_text")!.execute({ query: "world", path: "." }, context),
    { matches: [{ path: "hello.txt", line: 1, text: "hello world" }], truncated: false }
  );
  await byName.get("apply_patch")!.execute(
    { path: "hello.txt", oldText: "world", newText: "muniu" },
    context
  );
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hello muniu\n");
  const command = await byName.get("run_command")!.execute(
    { executable: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
    context
  );
  assert.deepEqual(command, { exitCode: 0, stdout: "ok", stderr: "", truncated: false });
});

test("workspace tools reject traversal and non-allowlisted commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "muniu-tools-boundary-"));
  const tools = createWorkspaceTools({ allowedCommands: ["git"] });
  const context = { sessionId: "tools-session", cwd: root };
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  await assert.rejects(
    async () => byName.get("read_file")!.execute({ path: "../outside" }, context),
    /outside the workspace/u
  );
  await assert.rejects(
    async () => byName.get("run_command")!.execute({ executable: "node", args: [] }, context),
    /not allowlisted/u
  );
});
