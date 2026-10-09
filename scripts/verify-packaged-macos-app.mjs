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

export async function verifyBusinessManagement(request = fetch) {
  const send = async (route, body, key) => {
    const response = await request(`http://127.0.0.1:7318${route}`, {
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`经营打包检查失败（HTTP ${response.status}）`);
    return (await response.json()).data;
  };
  const workspace = await send("/v2/workspaces", { name: "打包经营检查", viewMode: "business", pluginIds: ["opc"] }, "packaged-business-workspace");
  if (!workspace?.id) throw new Error("经营打包检查缺少工作区");
  let view = await send(`/v2/plugins/opc/business?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (view?.state?.streamVersion !== 0) throw new Error("经营打包检查必须从空台账开始");
  const commands = [
    { type: "customer.record", customerId: "packaged-customer", name: "合成客户", source: "打包样本", need: "设计服务" },
    { type: "service.record", serviceId: "packaged-service", title: "设计服务", currency: "CNY", priceMinor: "100000", inScope: ["视觉设计"], outOfScope: ["印刷"], acceptanceCriteria: ["客户确认设计稿"] },
    { type: "order.record", orderId: "packaged-order", customerId: "packaged-customer", serviceId: "packaged-service", serviceVersion: 1, quantity: 1, agreedAmountMinor: "100000", contractedOn: "2026-10-01", dueOn: "2026-10-20", sourceRef: "合成合同", opening: { asOf: "2026-10-01", receivedMinor: "40000", deliveredPercent: 50, accepted: false, sourceRef: "合成期初核对" } },
    { type: "payment.record", paymentId: "packaged-payment", orderId: "packaged-order", amountMinor: "30000", receivedOn: "2026-10-02", sourceRef: "合成收款凭据" },
    { type: "refund.record", refundId: "packaged-refund", paymentId: "packaged-payment", amountMinor: "10000", refundedOn: "2026-10-03", reason: "客户调整范围", sourceRef: "合成退款凭据" },
    { type: "order.adjust", adjustmentId: "packaged-adjustment", orderId: "packaged-order", amountDeltaMinor: "-10000", effectiveOn: "2026-10-03", reason: "双方确认调减价款", sourceRef: "合成变更确认" },
    { type: "review.record", reviewId: "packaged-review", period: { start: "2026-10-01", end: "2026-10-04" }, explanation: "本期现金与期初数分别记录", nextDecisions: ["跟进剩余交付和回款"] },
  ];
  for (const [index, command] of commands.entries()) {
    const body = { workspaceId: workspace.id, expectedStreamVersion: view.state.streamVersion, command };
    const key = `packaged-business-command-${index}`;
    view = await send("/v2/plugins/opc/business/commands", body, key);
    const replay = await send("/v2/plugins/opc/business/commands", body, key);
    if (!isDeepStrictEqual(view, replay)) throw new Error("经营命令重试未返回原结果");
  }
  const restored = await send(`/v2/plugins/opc/business?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (restored?.state?.streamVersion !== commands.length || restored.summary.outstandingMinor !== "30000"
    || restored.summary.netCashFlowMinor !== "20000" || restored.state.reviews.length !== 1
    || restored.summary.orders[0]?.deliveredPercent !== 50) throw new Error("经营台账的期初、部分收款、退款或复盘结果不一致");
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
    await verifyBusinessManagement();
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
  process.stdout.write(`macOS 打包验证通过：desktop=${app.pid} host=${childPid} setup=200 replay=200 business=passed\n`);
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
