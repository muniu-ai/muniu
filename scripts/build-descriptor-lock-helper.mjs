// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "packages/agent-session/native/descriptor-lock.c");
const localOutput = path.join(
  rootDir,
  "packages/agent-session/native/.build/mn-descriptor-lock"
);
const desktopOutputDirectory = path.join(rootDir, "apps/desktop-mac/src-tauri/binaries");
const buildDesktopHelpers = process.argv.includes("--desktop");

if (process.platform !== "darwin") process.exit(0);

const targets = buildDesktopHelpers
  ? [
      { architecture: "arm64", output: path.join(desktopOutputDirectory, "mn-descriptor-lock-aarch64-apple-darwin") },
      { architecture: "x86_64", output: path.join(desktopOutputDirectory, "mn-descriptor-lock-x86_64-apple-darwin") }
    ]
  : [{ architecture: process.arch === "arm64" ? "arm64" : "x86_64", output: localOutput }];

for (const target of targets) {
  mkdirSync(path.dirname(target.output), { recursive: true });
  const temporaryOutput = `${target.output}.tmp-${String(process.pid)}`;
  rmSync(temporaryOutput, { force: true });
  try {
    execFileSync("xcrun", [
      "clang",
      "-arch",
      target.architecture,
      "-mmacosx-version-min=12.0",
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      sourcePath,
      "-o",
      temporaryOutput
    ], { stdio: "inherit" });
    execFileSync("lipo", [temporaryOutput, "-verify_arch", target.architecture]);
    execFileSync("codesign", ["--force", "--sign", "-", temporaryOutput]);
    execFileSync("codesign", ["--verify", "--strict", temporaryOutput]);
    renameSync(temporaryOutput, target.output);
  } finally {
    rmSync(temporaryOutput, { force: true });
  }
}

console.log(buildDesktopHelpers
  ? "desktop descriptor-lock helpers ready"
  : `descriptor-lock helper ready: ${localOutput}`);
