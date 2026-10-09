#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function packagedArtifacts(repositoryRoot, tauri) {
  const bundleRoot = path.join(repositoryRoot, "apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle");
  const appPath = path.join(bundleRoot, "macos", `${tauri.productName}.app`);
  return { appPath, executable: path.join(appPath, "Contents/MacOS/muniu-desktop"),
    hostSidecar: path.join(appPath, "Contents/MacOS/mn-host"),
    dmgPath: path.join(bundleRoot, "dmg", `Muniu_${tauri.version}_universal.dmg`) };
}

export function isolatedEnvironment(isolatedHome, inherited = process.env) {
  // Isolate business data while retaining the user's HOME for the system Keychain.
  // Desktop and Host honor this explicit root; lsof verifies the actual open file.
  return { ...inherited, MN_V2_STATE_ROOT: path.join(isolatedHome, ".muniu", "v2") };
}

export function assertIsolatedHost(childPid, database, inspect = execFileSync) {
  try {
    const expected = realpathSync(database);
    const files = inspect("lsof", ["-a", "-p", String(childPid), "-Fn", "--", expected], { encoding: "utf8" });
    const opened = files.split("\n").filter(line => line.startsWith("n")).map(line => realpathSync(line.slice(1)));
    if (opened.includes(expected)) return;
  } catch {}
  throw new Error("无法确认受管 mn-host 使用隔离数据库，未发送首次设置请求");
}

export async function verifySetup(request = fetch) {
  const options = { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "mac-packaged-setup" }, body: "{}" };
  let original;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request("http://127.0.0.1:7318/v2/setup", { ...options, signal: AbortSignal.timeout(5_000) });
    if (response.status !== 200) throw new Error(`首次设置${attempt ? "重放" : "请求"}失败（HTTP ${response.status}）`);
    const result = await response.json();
    if (result?.data?.tenantId !== "local" || result?.data?.principalId !== "local-owner"
      || (attempt && !isDeepStrictEqual(original, result.data))) throw new Error("首次设置或重放返回的身份无效");
    original = result.data;
  }
}

export async function verifyPackagedMacosApp() {
  if (listenerPid()) throw new Error("端口 7318 已被占用，无法隔离验证 mn-host");
  const tauri = JSON.parse(readFileSync(path.join(root, "apps/desktop-mac/src-tauri/tauri.conf.json"), "utf8"));
  const { appPath, executable, hostSidecar, dmgPath } = packagedArtifacts(root, tauri);
  for (const file of [appPath, executable, hostSidecar, dmgPath]) {
    if (!existsSync(file) || statSync(file).size <= 0) throw new Error(`发布物缺失：${file}`);
  }
  for (const binary of [executable, hostSidecar]) execFileSync("lipo", [binary, "-verify_arch", "arm64", "x86_64"]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
  execFileSync("hdiutil", ["verify", dmgPath]);

  const isolatedHome = mkdtempSync(path.join(tmpdir(), "mn-v2-packaged-"));
  let output = "", childPid = 0;
  const app = spawn(executable, [], { cwd: root, env: isolatedEnvironment(isolatedHome), stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", chunk => { output += chunk.toString(); });
  app.stderr.on("data", chunk => { output += chunk.toString(); });
  app.once("error", error => { output += error.message; });
  try {
    const health = await waitForHealth(app);
    if (health?.data?.core?.status !== "healthy") throw new Error(`Host 健康响应无效：${JSON.stringify(health)}`);
    childPid = managedHostPid(app.pid);
    if (!childPid || listenerPid().split("\n").some(pid => Number(pid) !== childPid)) throw new Error("mn-host 不是 Desktop 的受管监听进程");
    assertIsolatedHost(childPid, path.join(isolatedHome, ".muniu", "v2", "state.sqlite3"));
    await verifySetup();
    const legacy = await fetch("http://127.0.0.1:7318/v1");
    if (legacy.status !== 404) throw new Error(`旧接口必须返回 404，实际为 ${legacy.status}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  } finally {
    childPid ||= app.pid ? managedHostPid(app.pid) : 0;
    if (app.pid && app.exitCode === null && app.signalCode === null) {
      app.kill("SIGTERM");
      try { await waitForExit(app); } catch { app.kill("SIGKILL"); await waitForExit(app); }
    }
    if (childPid) {
      await waitForShutdown(childPid);
      rmSync(isolatedHome, { recursive: true, force: true });
    } else {
      process.stderr.write(`无法确认受管 Host 已退出，保留隔离目录：${isolatedHome}\n`);
    }
  }
  process.stdout.write(`macOS 打包验证通过：desktop=${app.pid} host=${childPid} setup=200 replay=200\n`);
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
    if (!processHandle.pid || processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error("Desktop 在 Host 就绪前退出");
    try {
      const response = await fetch("http://127.0.0.1:7318/v2/health");
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mn-host 健康检查超时");
}

function waitForExit(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return Promise.resolve();
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyPackagedMacosApp();
