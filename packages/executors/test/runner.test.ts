import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/index.js";

test("run command writes stdout and stderr output checkpoints", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-runner-checkpoint-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const stdoutPath = join(tempRoot, "checkpoint", "stdout.txt");
  const stderrPath = join(tempRoot, "checkpoint", "stderr.txt");
  const result = await runCommand({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('checkpoint stdout'); process.stderr.write('checkpoint stderr')"
    ],
    cwd: tempRoot,
    timeoutSeconds: 5,
    runId: "run-checkpoint",
    candidateId: "codex-1",
    outputCheckpoint: {
      stdoutPath,
      stderrPath
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "checkpoint stdout");
  assert.equal(result.stderr, "checkpoint stderr");
  assert.equal(await readFile(stdoutPath, "utf8"), "checkpoint stdout");
  assert.equal(await readFile(stderrPath, "utf8"), "checkpoint stderr");
});
