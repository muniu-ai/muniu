#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(rootDir, "apps/desktop-mac/src-tauri/binaries");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output-dir="));
const binariesDir = outputArgument ? path.resolve(outputArgument.slice("--output-dir=".length)) : defaultOutput;
const smoke = process.argv.includes("--smoke");
const unknown = process.argv.slice(2).filter((argument) => argument !== "--smoke" && !argument.startsWith("--output-dir="));
if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(", ")}`);

const buildDir = await mkdtemp(path.join(tmpdir(), "mn-host-sidecar-"));
const bundlePath = path.join(buildDir, "mn-host.cjs");
const packagedDir = path.join(buildDir, "pkg");
const pkgBin = path.join(rootDir, "node_modules/.bin/pkg");
const arm64Path = path.join(binariesDir, "mn-host-aarch64-apple-darwin");
const x64Path = path.join(binariesDir, "mn-host-x86_64-apple-darwin");
const universalPath = path.join(binariesDir, "mn-host-universal-apple-darwin");
const manifestPath = path.join(binariesDir, "mn-host-build.json");

try {
  if (process.platform !== "darwin") throw new Error("mn-host macOS sidecar 只能在 macOS 构建");
  mkdirSync(packagedDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });
  await build({
    entryPoints: [path.join(rootDir, "apps/host/src/main.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    legalComments: "eof",
    define: { "import.meta.url": "__mnHostImportMetaUrl" },
    banner: { js: "const __mnHostImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: "info",
  });
  execFileSync(pkgBin, [
    bundlePath,
    "--targets", "node22-macos-arm64,node22-macos-x64",
    "--out-path", packagedDir,
    "--compress", "GZip",
  ], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0", TZ: "UTC" },
  });

  cpSync(path.join(packagedDir, "mn-host-arm64"), arm64Path);
  cpSync(path.join(packagedDir, "mn-host-x64"), x64Path);
  execFileSync("chmod", ["755", arm64Path, x64Path]);
  execFileSync("lipo", [arm64Path, "-verify_arch", "arm64"]);
  execFileSync("lipo", [x64Path, "-verify_arch", "x86_64"]);
  execFileSync("lipo", ["-create", arm64Path, x64Path, "-output", universalPath]);
  execFileSync("chmod", ["755", universalPath]);
  execFileSync("codesign", ["--force", "--sign", "-", universalPath]);
  execFileSync("lipo", [universalPath, "-verify_arch", "arm64", "x86_64"]);
  execFileSync("codesign", ["--verify", "--strict", universalPath]);
  const manifest = {
    schemaVersion: 1,
    service: "mn-host",
    source: "apps/host/src/main.ts",
    node: "22",
    targets: {
      "aarch64-apple-darwin": sha256(arm64Path),
      "x86_64-apple-darwin": sha256(x64Path),
      "universal-apple-darwin": sha256(universalPath),
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  if (smoke) await smokeCurrentArchitecture(universalPath);
  process.stdout.write(`mn-host sidecar 已生成：${binariesDir}\n`);
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function smokeCurrentArchitecture(binary) {
  if (process.platform !== "darwin") throw new Error("--smoke 只支持 macOS");
  const stateRoot = await mkdtemp(path.join(tmpdir(), "mn-host-smoke-"));
  const child = spawn(binary, [], {
    cwd: rootDir,
    env: { ...process.env, MN_V2_STATE_ROOT: stateRoot, MN_DESKTOP_PARENT_PID: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`mn-host 提前退出：${output}`);
      try {
        const response = await fetch("http://127.0.0.1:7318/v2/health");
        const body = await response.json();
        if (response.ok && body?.data?.core?.status === "healthy") return;
      } catch {
        // Host startup is bounded by the deadline above.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`mn-host 健康检查超时：${output}`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(stateRoot, { recursive: true, force: true });
  }
}
