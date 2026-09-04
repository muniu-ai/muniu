// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CandidateOperationAbortedError,
  ControlledCommandTimeoutError,
  copyCandidateTree,
  inspectCandidateTree,
  runControlledCommand,
} from "../src/candidate-materializer.js";

test("候选固化忽略根 .git 且复制得到可复核的普通文件树", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muniu-materializer-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "snapshot");
  await mkdir(join(source, ".git"), { recursive: true });
  await writeFile(join(source, ".git", "config"), "[diff \"evil\"]\n", "utf8");
  await writeFile(join(source, ".gitattributes"), "*.txt diff=evil filter=evil\n", "utf8");
  await writeFile(join(source, "message.txt"), "safe\n", "utf8");

  const copied = await copyCandidateTree({
    sourceRoot: source,
    targetRoot: target,
    signal: new AbortController().signal,
    ignoreRootGit: true,
  });
  const inspected = await inspectCandidateTree({
    root: target,
    signal: new AbortController().signal,
  });

  assert.deepEqual(inspected, copied);
  assert.equal(await readFile(join(target, "message.txt"), "utf8"), "safe\n");
  await assert.rejects(
    () => readFile(join(target, ".git", "config"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("候选固化拒绝符号链接和 FIFO，不读取其目标或阻塞", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muniu-materializer-special-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const symlinkSource = join(root, "symlink-source");
  await mkdir(symlinkSource);
  await symlink("/etc/passwd", join(symlinkSource, "leak.txt"));
  await assert.rejects(
    copyCandidateTree({
      sourceRoot: symlinkSource,
      targetRoot: join(root, "symlink-target"),
      signal: new AbortController().signal,
    }),
    /符号链接/u,
  );

  const fifoSource = join(root, "fifo-source");
  await mkdir(fifoSource);
  await run("/usr/bin/mkfifo", [join(fifoSource, "blocked")]);
  await assert.rejects(
    copyCandidateTree({
      sourceRoot: fifoSource,
      targetRoot: join(root, "fifo-target"),
      signal: new AbortController().signal,
    }),
    /特殊文件/u,
  );
});

test("候选遍历响应 AbortSignal，不留下半成品快照", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muniu-materializer-abort-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(source);
  await writeFile(join(source, "message.txt"), "safe\n", "utf8");
  const abort = new AbortController();
  abort.abort("lease_lost");

  await assert.rejects(
    copyCandidateTree({ sourceRoot: source, targetRoot: target, signal: abort.signal }),
    CandidateOperationAbortedError,
  );
  await assert.rejects(
    () => readFile(join(target, "message.txt"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("受控命令在取消和超时后终止挂起进程", async () => {
  const abort = new AbortController();
  const cancelled = runControlledCommand({
    executable: "/bin/sleep",
    arguments: ["60"],
    signal: abort.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => abort.abort("lease_lost"), 20).unref();
  await assert.rejects(cancelled, CandidateOperationAbortedError);

  await assert.rejects(
    runControlledCommand({
      executable: "/bin/sleep",
      arguments: ["60"],
      signal: new AbortController().signal,
      timeoutMs: 20,
    }),
    ControlledCommandTimeoutError,
  );
});

function run(executable: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(executable, [...arguments_], (error) => {
      if (error) rejectCommand(error);
      else resolveCommand();
    });
  });
}
