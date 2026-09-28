// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { approvedNodeImage, selectCachedKindNode } from "../lib/kind-node-image.mjs";

test("offline Kind cache must match the config digest of the pinned release", () => {
  const id = "sha256:b1b6ffc307b4d2ac9bd8902aa24a720ff533ffa5b34193c66d7c0f21f2d77ee7";
  assert.equal(selectCachedKindNode(approvedNodeImage, { Id: id, Architecture: "arm64" }), id);
  assert.equal(selectCachedKindNode(approvedNodeImage, undefined), approvedNodeImage);
  assert.throws(() => selectCachedKindNode(approvedNodeImage, { Id: "sha256:" + "0".repeat(64), Architecture: "arm64" }), /digest/);
  assert.throws(() => selectCachedKindNode(approvedNodeImage, { Id: id, Architecture: "amd64" }), /digest/);
  assert.throws(() => selectCachedKindNode("kindest/node:latest", undefined), /pinned/);
});

test("Kind reports missing host dependencies before building an image or creating a cluster", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muniu-kind-prerequisites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  await copyFile(new URL("../verify-kind-sandbox.sh", import.meta.url), join(root, "scripts", "verify-kind-sandbox.sh"));
  await copyFile(new URL("../lib/kind-node-image.mjs", import.meta.url), join(root, "scripts", "lib", "kind-node-image.mjs"));
  const commandLog = join(root, "commands.log");
  for (const command of ["docker", "kind", "kubectl", "helm", "curl"]) {
    await writeFile(join(bin, command), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$MN_KIND_TEST_COMMAND_LOG"\nexit 99\n', { mode: 0o755 });
  }
  const result = spawnSync("/bin/bash", ["scripts/verify-kind-sandbox.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, MN_KIND_TEST_COMMAND_LOG: commandLog },
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm ci/u);
  const commands = await readFile(commandLog, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  assert.doesNotMatch(commands, /docker build|kind create cluster/u);
});
