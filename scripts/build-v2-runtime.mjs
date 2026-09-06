#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildOrder = [
  "vendor/cosmokit",
  "vendor/schemastery",
  "vendor/cordis",
  "vendor/loader",
  "vendor/include",
  "vendor/group",
  "vendor/timer",
  "vendor/hmr",
  "vendor/logger-console",
  "packages/contracts",
  "packages/storage",
  "packages/kernel",
  "packages/plugin-sdk",
  "packages/agent-runtime",
  "plugins/opc",
  "plugins/coding",
  "plugins/runner-claude-cli",
  "plugins/runner-codex-cli",
  "apps/worker",
  "apps/host",
  "apps/cli",
];

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} 失败：${signal ?? code}`));
    });
  });
}

for (const directory of buildOrder) {
  const manifestPath = join(root, directory, "package.json");
  await access(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.scripts?.build) await run("npm", ["run", "build", "--prefix", directory]);
}
