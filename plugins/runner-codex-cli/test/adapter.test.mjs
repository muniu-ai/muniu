import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertRunnerIdentity,
  buildCodexInvocation,
  createCodexCliRunner,
  inspectRunnerBinary,
  runnerCodexCliPlugin,
  verifyRunnerBinaryIdentity,
} from "../src/index.ts";

test("Codex Runner 记录 realpath、版本和 SHA-256，摘要变化后要求重新确认", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mn-codex-runner-"));
  const binary = join(directory, "codex");
  await writeFile(binary, "#!/bin/sh\necho first\n");
  await chmod(binary, 0o755);
  const confirmed = await inspectRunnerBinary(binary, { readVersion: async () => "4.5.6" });
  assert.equal(confirmed.realPath, await realpath(binary));
  assert.equal(confirmed.version, "4.5.6");

  await writeFile(binary, "#!/bin/sh\necho changed\n");
  await chmod(binary, 0o755);
  let versionReads = 0;
  await assert.rejects(
    () => verifyRunnerBinaryIdentity(confirmed, {
      readVersion: async () => { versionReads += 1; return "4.5.6"; },
    }),
    (error) => error.code === "RUNNER_RECONFIRMATION_REQUIRED",
  );
  assert.equal(versionReads, 0);
  const changed = await inspectRunnerBinary(binary, { readVersion: async () => "4.5.6" });
  assert.throws(() => assertRunnerIdentity(confirmed, changed), (error) => {
    assert.equal(error.code, "RUNNER_RECONFIRMATION_REQUIRED");
    return true;
  });
});

test("Codex Runner 拒绝相对二进制路径", async () => {
  await assert.rejects(
    () => inspectRunnerBinary("bin/codex", { readVersion: async () => "4.5.6" }),
    (error) => error.code === "RUNNER_BINARY_INVALID" && /\u7edd\u5bf9\u8def\u5f84/u.test(error.message),
  );
});

test("Codex 调用使用 stdin 和 shell:false，不注入 Provider、代理、MCP 或 Skill 配置", () => {
  const invocation = buildCodexInvocation({ mode: "start", preparedInput: "实现已批准的 Spec" });
  assert.deepEqual(invocation.args, ["exec", "--json", "-"]);
  assert.equal(invocation.stdin, "实现已批准的 Spec");
  assert.equal(invocation.shell, false);
  assert.deepEqual(Object.keys(invocation).sort(), ["args", "shell", "stdin"]);
  assert.throws(() => buildCodexInvocation({
    mode: "resume",
    externalSessionId: "--dangerous-option",
    preparedInput: "继续",
  }), /会话 ID/);
});

test("Codex Runner 是独立的显式选择插件", () => {
  assert.equal(runnerCodexCliPlugin.id, "runner-codex-cli");
  assert.equal(runnerCodexCliPlugin.defaultEnabled, false);
  assert.equal(runnerCodexCliPlugin.explicitSelectionRequired, true);
  assert.deepEqual(runnerCodexCliPlugin.capabilities, ["start", "events", "cancel", "resume"]);
  assert.equal(
    runnerCodexCliPlugin.definition.contributions.tools[0].effectClass,
    "external_side_effect",
  );
});

test("Codex Runner 规范化 thread/turn 事件并使用安全 resume 调用", async () => {
  const identity = {
    requestedPath: "/tools/codex",
    realPath: "/opt/tools/codex",
    version: "4.5.6",
    sha256: "c".repeat(64),
    device: "1",
    inode: "2",
    byteLength: 100,
    modifiedAtMs: 1,
  };
  const launches = [];
  const runner = createCodexCliRunner({
    binaryPath: identity.requestedPath,
    confirmedIdentity: identity,
    inspectIdentity: async () => identity,
    inspectRepository: async () => ({ realPath: "/repo", device: "3", inode: "4" }),
    launch(spec) {
      launches.push(spec);
      return {
        stdout: (async function* () {
          yield launches.length === 1
            ? '{"type":"thread.started","thread_id":"codex-thread"}\n{"type":"turn.completed"}\n'
            : '{"type":"turn.completed"}\n';
        })(),
        completed: Promise.resolve({ code: 0, signal: null }),
        kill() {},
      };
    },
    createSessionId: () => "mn-session",
  });
  const session = await runner.start({
    executionId: "execution-1",
    repositoryPath: "/repo",
    expectedRepositoryRealPath: "/repo",
    resourceDigest: "d".repeat(64),
    preparedInput: "执行 Spec",
    explicitlySelected: true,
  });
  const events = [];
  for await (const event of runner.events(session.sessionId)) events.push(event);
  assert.equal(events.at(-1).status, "completed");
  await runner.resume(session.sessionId, { preparedInput: "修复 Gate", explicitlySelected: true });
  assert.deepEqual(launches[1].args, ["exec", "resume", "codex-thread", "--json", "-"]);
  assert.equal(launches[1].shell, false);
});
