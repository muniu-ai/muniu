#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));
const assertIncludes = (value, expected, label) => {
  if (!value.includes(expected)) throw new Error(`${label} 缺少 ${expected}`);
};
const assertExcludes = (value, unexpected, label) => {
  if (value.includes(unexpected)) throw new Error(`${label} 不得包含 ${unexpected}`);
};

const tauri = json("apps/desktop-mac/src-tauri/tauri.conf.json");
const desktop = json("apps/desktop-mac/package.json");
const capability = json("apps/desktop-mac/src-tauri/capabilities/default.json");
const rust = read("apps/desktop-mac/src-tauri/src/lib.rs");
const sidecar = read("scripts/build-host-sidecar.mjs");
const release = read("apps/desktop-mac/scripts/build-macos-release.mjs");
const cask = read("packaging/homebrew/Casks/mniu.rb");

if (tauri.version !== "0.2.0" || desktop.version !== tauri.version) {
  throw new Error("Desktop、Tauri 与 Agent OS 必须同时发布 0.2.0");
}
if (tauri.bundle?.externalBin?.join(",") !== "binaries/mn-host") {
  throw new Error("Tauri 只能打包 mn-host sidecar");
}
assertIncludes(rust, '.sidecar("mn-host")', "Desktop Host 启动器");
assertIncludes(rust, 'join("v2")', "Desktop v2 状态根");
assertIncludes(rust, '"MN_V2_STATE_ROOT"', "Desktop Host 环境");
assertIncludes(rust, '"MN_DESKTOP_PARENT_PID"', "Desktop Host 环境");
assertIncludes(JSON.stringify(capability), 'binaries/mn-host', "Desktop capability");
assertIncludes(tauri.app.security.csp, "object-src 'none'", "生产 CSP");
assertIncludes(tauri.app.security.csp, "frame-src 'none'", "生产 CSP");
assertIncludes(sidecar, "apps/host/src/main.ts", "sidecar 构建入口");
assertIncludes(sidecar, "mn-host-universal-apple-darwin", "sidecar 通用架构产物");
assertIncludes(sidecar, '"-create"', "sidecar 通用 Mach-O 构建");
assertIncludes(release, "universal-apple-darwin", "macOS 发布脚本");
assertIncludes(release, "notarytool", "macOS 发布脚本");
assertIncludes(cask, 'version "0.2.0"', "Homebrew Cask");
for (const [value, label] of [[rust, "Desktop Host 启动器"], [sidecar, "sidecar 构建脚本"], [cask, "Homebrew Cask"]]) {
  for (const forbidden of ["mn-api", "descriptor-lock", "mniu://"]) assertExcludes(value, forbidden, label);
}
if (existsSync(path.join(root, "scripts/build-descriptor-lock-helper.mjs"))) {
  throw new Error("旧 descriptor lock 构建脚本仍然存在");
}
execFileSync("ruby", ["-c", path.join(root, "packaging/homebrew/Casks/mniu.rb")], { stdio: "inherit" });
process.stdout.write("macOS 0.2 发布契约通过\n");
