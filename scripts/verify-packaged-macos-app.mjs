#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauri = JSON.parse(readFileSync(path.join(root, "apps/desktop-mac/src-tauri/tauri.conf.json"), "utf8"));
const bundleRoot = path.join(root, "apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle");
const appPath = path.join(bundleRoot, "macos", `${tauri.productName}.app`);
const executable = path.join(appPath, "Contents/MacOS/mniu-desktop");
const hostSidecar = path.join(appPath, "Contents/MacOS/mn-host");
const dmgPath = path.join(bundleRoot, "dmg", `Muniu_${tauri.version}_universal.dmg`);
const isolatedHome = mkdtempSync(path.join(tmpdir(), "mn-v2-packaged-"));
let output = "";

if (listenerPid()) throw new Error("端口 7318 已被占用，无法隔离验证 mn-host");
for (const file of [appPath, executable, hostSidecar, dmgPath]) {
  if (!existsSync(file) || statSync(file).size <= 0) throw new Error(`发布物缺失：${file}`);
}
for (const binary of [executable, hostSidecar]) {
  execFileSync("lipo", [binary, "-verify_arch", "arm64", "x86_64"]);
}
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
execFileSync("hdiutil", ["verify", dmgPath]);

const app = spawn(executable, [], {
  cwd: root,
  env: { ...process.env, HOME: isolatedHome },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.on("data", (chunk) => { output += chunk.toString(); });
app.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  const health = await waitForHealth(app);
  if (health?.data?.core?.status !== "healthy") throw new Error(`Host 健康响应无效：${JSON.stringify(health)}`);
  const stateRoot = path.join(isolatedHome, ".muniu", "v2");
  if (!existsSync(path.join(stateRoot, "state.sqlite3"))) throw new Error("mn-host 未使用隔离的 v2 状态根");
  const legacy = await fetch("http://127.0.0.1:7318/v1");
  if (legacy.status !== 404) throw new Error(`旧接口必须返回 404，实际为 ${legacy.status}`);
  const childPid = managedHostPid(app.pid);
  if (!childPid) throw new Error("mn-host 不是 Desktop 的受管子进程");
  app.kill("SIGTERM");
  await waitForExit(app);
  await waitForShutdown(childPid);
  process.stdout.write(`macOS 打包验证通过：desktop=${app.pid} host=${childPid}\n`);
} catch (error) {
  if (app.exitCode === null) app.kill("SIGKILL");
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
} finally {
  rmSync(isolatedHome, { recursive: true, force: true });
}

function listenerPid() {
  try {
    return execFileSync("lsof", ["-tiTCP:7318", "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function managedHostPid(parentPid) {
  try {
    return Number(execFileSync("pgrep", ["-P", String(parentPid), "-f", "mn-host"], { encoding: "utf8" }).trim().split("\n")[0]);
  } catch {
    return 0;
  }
}

async function waitForHealth(processHandle) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error("Desktop 在 Host 就绪前退出");
    try {
      const response = await fetch("http://127.0.0.1:7318/v2/health");
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mn-host 健康检查超时");
}

function waitForExit(processHandle) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop 未在 20 秒内退出")), 20_000);
    processHandle.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForShutdown(pid) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      if (!listenerPid()) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`mn-host ${pid} 未随 Desktop 退出`);
}
