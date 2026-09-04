import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertRunnerIdentity,
  buildClaudeInvocation,
  createClaudeCliRunner,
  inspectRunnerBinary,
  runnerClaudeCliPlugin,
  verifyRunnerBinaryIdentity,
} from "../src/index.ts";

test("Claude Runner 记录 realpath、版本和 SHA-256，摘要变化后要求重新确认", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mn-claude-runner-"));
  const binary = join(directory, "claude");
  await writeFile(binary, "#!/bin/sh\necho first\n");
  await chmod(binary, 0o755);
  const confirmed = await inspectRunnerBinary(binary, { readVersion: async () => "1.2.3" });
  assert.equal(confirmed.realPath, await realpath(binary));
  assert.equal(confirmed.version, "1.2.3");
  assert.match(confirmed.sha256, /^[0-9a-f]{64}$/);

  await writeFile(binary, "#!/bin/sh\necho changed\n");
  await chmod(binary, 0o755);
  let versionReads = 0;
  await assert.rejects(
    () => verifyRunnerBinaryIdentity(confirmed, {
      readVersion: async () => { versionReads += 1; return "1.2.3"; },
    }),
    (error) => error.code === "RUNNER_RECONFIRMATION_REQUIRED",
  );
  assert.equal(versionReads, 0);
  const changed = await inspectRunnerBinary(binary, { readVersion: async () => "1.2.3" });
  assert.throws(() => assertRunnerIdentity(confirmed, changed), (error) => {
    assert.equal(error.code, "RUNNER_RECONFIRMATION_REQUIRED");
    return true;
  });
});

test("Claude Runner 拒绝相对二进制路径", async () => {
  await assert.rejects(
    () => inspectRunnerBinary("bin/claude", { readVersion: async () => "1.2.3" }),
    (error) => error.code === "RUNNER_BINARY_INVALID" && /\u7edd\u5bf9\u8def\u5f84/u.test(error.message),
  );
});

test("Claude 调用使用 stdin 和 shell:false，不注入 Provider、代理、MCP 或 Skill 配置", () => {
  const invocation = buildClaudeInvocation({
    mode: "start",
    preparedInput: "实现已批准的 Spec",
  });
  assert.deepEqual(invocation.args, ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(invocation.stdin, "实现已批准的 Spec");
  assert.equal(invocation.shell, false);
  assert.deepEqual(Object.keys(invocation).sort(), ["args", "shell", "stdin"]);
  assert.throws(() => buildClaudeInvocation({
    mode: "resume",
    externalSessionId: "--dangerous-option",
    preparedInput: "继续",
  }), /会话 ID/);
});

test("Claude Runner 是独立的显式选择插件", () => {
  assert.equal(runnerClaudeCliPlugin.id, "runner-claude-cli");
  assert.equal(runnerClaudeCliPlugin.defaultEnabled, false);
  assert.equal(runnerClaudeCliPlugin.explicitSelectionRequired, true);
  assert.deepEqual(runnerClaudeCliPlugin.capabilities, ["start", "events", "cancel", "resume"]);
  assert.equal(
    runnerClaudeCliPlugin.definition.contributions.tools[0].effectClass,
    "external_side_effect",
  );
});

test("Claude Runner 在每次 start/resume 前复核身份和仓库真实路径", async () => {
  const identity = {
    requestedPath: "/tools/claude",
    realPath: "/opt/tools/claude",
    version: "1.2.3",
    sha256: "a".repeat(64),
    device: "1",
    inode: "2",
    byteLength: 100,
    modifiedAtMs: 1,
  };
  const launches = [];
  const killed = [];
  let inspectionCount = 0;
  const processFactory = (stdout) => ({
    stdout: (async function* () { yield stdout; })(),
    completed: Promise.resolve({ code: 0, signal: null }),
    kill(signal) { killed.push(signal); },
  });
  const runner = createClaudeCliRunner({
    binaryPath: identity.requestedPath,
    confirmedIdentity: identity,
    inspectIdentity: async () => {
      inspectionCount += 1;
      return identity;
    },
    inspectRepository: async () => ({ realPath: "/repo", device: "3", inode: "4" }),
    launch(spec) {
      launches.push(spec);
      return processFactory(launches.length === 1
        ? '{"type":"system","subtype":"init","session_id":"claude-session"}\n{"type":"result","is_error":false}\n'
        : '{"type":"result","is_error":false}\n');
    },
    createSessionId: () => "mn-session",
  });

  await assert.rejects(() => runner.start({
    executionId: "execution-1",
    repositoryPath: "/repo-link",
    expectedRepositoryRealPath: "/repo",
    resourceDigest: "b".repeat(64),
    preparedInput: "执行 Spec",
    explicitlySelected: false,
  }), /显式选择/);

  const session = await runner.start({
    executionId: "execution-1",
    repositoryPath: "/repo-link",
    expectedRepositoryRealPath: "/repo",
    resourceDigest: "b".repeat(64),
    preparedInput: "执行 Spec",
    explicitlySelected: true,
  });
  assert.equal(session.sessionId, "mn-session");
  assert.equal(launches[0].executable, identity.realPath);
  assert.equal(launches[0].cwd, "/repo");
  assert.equal(launches[0].shell, false);
  assert.equal("HTTPS_PROXY" in launches[0].env, false);

  const events = [];
  for await (const event of runner.events(session.sessionId)) events.push(event);
  assert.equal(events.at(-1).status, "completed");

  await runner.resume(session.sessionId, { preparedInput: "修复 Gate", explicitlySelected: true });
  assert.deepEqual(launches[1].args, [
    "-p",
    "--resume",
    "claude-session",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.equal(inspectionCount, 2);
  await runner.cancel(session.sessionId);
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("Claude Runner 取消超时后升级为 SIGKILL 并等待进程退出", async () => {
  const identity = {
    requestedPath: "/tools/claude",
    realPath: "/opt/tools/claude",
    version: "1.2.3",
    sha256: "a".repeat(64),
    device: "1",
    inode: "2",
    byteLength: 100,
    modifiedAtMs: 1,
  };
  const signals = [];
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const runner = createClaudeCliRunner({
    binaryPath: identity.requestedPath,
    confirmedIdentity: identity,
    inspectIdentity: async () => identity,
    inspectRepository: async () => ({ realPath: "/repo", device: "3", inode: "4" }),
    launch: () => ({
      stdout: (async function* () {})(),
      completed: completion,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") resolveCompletion({ code: null, signal });
      },
    }),
    createSessionId: () => "cancel-session",
    cancelGraceMs: 1,
  });
  const session = await runner.start({
    executionId: "execution-1",
    repositoryPath: "/repo",
    expectedRepositoryRealPath: "/repo",
    resourceDigest: "b".repeat(64),
    preparedInput: "执行 Spec",
    explicitlySelected: true,
  });

  await runner.cancel(session.sessionId);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Claude Runner 缺少明确终态时返回 unknown，交由内核人工核对", async () => {
  const identity = {
    requestedPath: "/tools/claude",
    realPath: "/tools/claude",
    version: "1",
    sha256: "a".repeat(64),
    device: "1",
    inode: "2",
    byteLength: 10,
    modifiedAtMs: 1,
  };
  const runner = createClaudeCliRunner({
    binaryPath: identity.requestedPath,
    confirmedIdentity: identity,
    inspectIdentity: async () => identity,
    inspectRepository: async () => ({ realPath: "/repo", device: "3", inode: "4" }),
    launch: () => ({
      stdout: (async function* () { yield '{"type":"assistant","message":"done"}\n'; })(),
      completed: Promise.resolve({ code: 0, signal: null }),
      kill() {},
    }),
  });
  const session = await runner.start({
    executionId: "execution-1",
    repositoryPath: "/repo",
    expectedRepositoryRealPath: "/repo",
    resourceDigest: "b".repeat(64),
    preparedInput: "执行 Spec",
    explicitlySelected: true,
  });
  const events = [];
  for await (const event of runner.events(session.sessionId)) events.push(event);
  assert.equal(events.at(-1).status, "unknown");
  assert.equal(events.at(-1).reconciliationRequired, true);
});
