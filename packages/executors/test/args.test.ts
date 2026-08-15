import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeCodeArgs, buildCodexArgs } from "../src/index.js";

test("codex args put global approval before exec subcommand", () => {
  const args = buildCodexArgs({
    cwd: "/tmp/work",
    prompt: "do work",
    model: "gpt-test",
    sandbox: "workspace-write",
    approvalMode: "never"
  });

  assert.deepEqual(args, [
    "--ask-for-approval",
    "never",
    "--model",
    "gpt-test",
    "exec",
    "--cd",
    "/tmp/work",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--ephemeral",
    "do work"
  ]);
  assert.equal(args.indexOf("--ask-for-approval") < args.indexOf("exec"), true);
});

test("claude args keep print mode and configurable permission mode", () => {
  assert.deepEqual(
    buildClaudeCodeArgs({ model: "sonnet", permissionMode: "default" }),
    [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "default",
      "--model",
      "sonnet"
    ]
  );
});
