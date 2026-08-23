// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ThreadManager } from "@mn/agent-kernel";
import { JsonlAgentEventV3Store } from "@mn/agent-session";
import {
  AppServerConnection,
  InMemoryNotificationLog,
  createCoreAppServerHandlers,
  createLocalWebSocketServer
} from "@mn/app-server";
import { chromium } from "playwright-core";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const tempRoot = await mkdtemp(join(tmpdir(), "muniu-desktop-thread-"));
const vitePort = await freePort();
const appUrl = `http://127.0.0.1:${vitePort}`;
const children = [];
let browser;
let activeConnection;

const threads = new ThreadManager({
  store: new JsonlAgentEventV3Store(join(tempRoot, "threads")),
  executor: {
    async execute(input) {
      await input.recordItem({
        kind: "plan",
        content: { text: "检查发布契约" },
        publicControls: { text: "检查发布契约" }
      });
      if (!activeConnection) throw new Error("Desktop app-server connection is unavailable");
      await activeConnection.requestClient("item/commandExecution/requestApproval", {
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: "command-release-check",
        startedAtMs: Date.now(),
        command: "npm test",
        cwd: tempRoot,
        muniu: { effectCommitment: "a".repeat(64) }
      });
      await input.recordItem({
        kind: "commandExecution",
        content: { command: "npm test", cwd: tempRoot },
        publicControls: {
          command: "npm test",
          cwd: tempRoot,
          aggregatedOutput: "all tests passed",
          exitCode: 0,
          durationMs: 42
        }
      });
      await input.recordItem({
        kind: "fileChange",
        content: {
          changes: [{
            path: "README.md",
            kind: { type: "update", move_path: null },
            diff: "@@ -1 +1 @@\n-v0.1.1\n+v0.2.0"
          }]
        }
      });
      await input.recordItem({
        kind: "subAgentActivity",
        content: { childThreadId: "child-thread", kind: "completed" },
        publicControls: {
          agentThreadId: "child-thread",
          agentPath: `${input.threadId}/child-thread`,
          kind: "completed"
        }
      });
      await input.recordItem({
        kind: "evidenceCheckpoint",
        content: { evidenceId: "evidence-1" },
        publicControls: {
          evidenceId: "evidence-1",
          digest: "b".repeat(64),
          evidenceStatus: "verified"
        }
      });
      await input.recordItem({
        kind: "agentMessage",
        content: { text: "Desktop streamed reply" }
      });
      return {
        status: "completed",
        tokenUsage: { inputTokens: 8, outputTokens: 4 }
      };
    }
  }
});
const notifications = new InMemoryNotificationLog();
const listener = await createLocalWebSocketServer({
  host: "127.0.0.1",
  port: 0,
  createConnection(peer) {
    let connection;
    const handlers = createCoreAppServerHandlers({
      threads,
      defaults: {
        cwd: tempRoot,
        providerId: "mock",
        modelId: "local-mock",
        permissionProfile: "on-request",
        sandbox: { mode: "workspace-write", network: false }
      },
      notify: (method, params) => connection.notify(method, params)
    });
    connection = new AppServerConnection({
      serverInfo: { name: "muniu-desktop-e2e", version: "0.2.0" },
      instructionSources: ["AGENTS.md"],
      handlers,
      notificationLog: notifications,
      write: (message) => peer.send(message),
      close: () => peer.close()
    });
    activeConnection = connection;
    return {
      receiveText: (text) => connection.receiveText(text),
      closed: () => {
        if (activeConnection === connection) activeConnection = undefined;
        connection.close();
      }
    };
  }
});

try {
  const viteBin = join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vite.cmd" : "vite"
  );
  const vite = spawnProcess(viteBin, [
    "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"
  ], {
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_MN_APP_SERVER_URL: listener.url,
      VITE_MN_APP_SERVER_TOKEN: listener.token
    }
  });
  children.push(vite);
  await waitForHttp(appUrl, "desktop-vite");

  browser = await chromium.launch({
    executablePath: resolveChromeExecutable(),
    headless: true
  });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  const workspace = page.getByLabel("Agent 线程工作区");
  await workspace.scrollIntoViewIfNeeded();
  await workspace.getByRole("button", { name: "新建线程" }).click();
  await workspace.getByLabel("线程列表").getByRole("button").first().waitFor();
  await (await field(workspace, "目标")).fill("发布 v0.2.0");
  await (await field(workspace, "Token 预算")).fill("100");
  await workspace.getByRole("button", { name: "保存目标" }).click();
  await workspace.getByPlaceholder("向当前线程发送消息").fill("验证 Desktop app-server 流程");
  await workspace.getByRole("button", { name: "发送" }).click();

  await expectText(workspace, "item/commandExecution/requestApproval");
  await workspace.getByRole("button", { name: "批准一次" }).click();
  await expectText(workspace, "Desktop streamed reply");
  await expectText(workspace, "检查发布契约");
  await expectText(workspace, "all tests passed");
  await expectText(workspace, "README.md");
  await expectText(workspace, "child-thread");
  await expectText(workspace, "evidence-1");

  const downloadPromise = page.waitForEvent("download");
  await workspace.getByRole("button", { name: "导出证据" }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error("Desktop evidence export did not produce a file");
  const exported = JSON.parse(await readFile(downloadedPath, "utf8"));
  if (exported.evidence?.[0]?.evidenceId !== "evidence-1") {
    throw new Error(`Desktop evidence export is invalid: ${JSON.stringify(exported)}`);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  const restored = page.getByLabel("Agent 线程工作区");
  await restored.scrollIntoViewIfNeeded();
  await expectText(restored, "Desktop streamed reply").catch(async (error) => {
    throw new Error(`Desktop thread recovery failed: ${await restored.innerText()}\n${pageErrors.join("\n")}`, {
      cause: error
    });
  });
  await expectText(restored, "evidence-1");

  console.log(JSON.stringify({ ok: true, appUrl, checks: 10 }, null, 2));
} finally {
  if (browser) await browser.close();
  await Promise.all(children.reverse().map((child) => stopProcess(child)));
  await listener.close();
  await rm(tempRoot, { recursive: true, force: true });
}

async function field(scope, label) {
  return scope.locator("label.form-field", { hasText: label }).locator("input, textarea").first();
}

async function expectText(scope, value) {
  await scope.getByText(value, { exact: false }).first().waitFor();
}

function spawnProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { child.output = `${child.output}${chunk}`.slice(-10_000); });
  }
  child.on("exit", (code, signal) => {
    child.exitCodeValue = code;
    child.exitSignalValue = signal;
  });
  return child;
}

async function stopProcess(child) {
  if (child.exitCodeValue !== undefined || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolveStop();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

async function waitForHttp(url, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    for (const child of children) {
      if (child.exitCodeValue !== undefined) throw new Error(`${label} exited early.\n${child.output}`);
    }
  }
  throw new Error(`Timed out waiting for ${label} at ${url}.`);
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => address && typeof address === "object"
        ? resolvePort(address.port)
        : rejectPort(new Error("Could not allocate a free port.")));
    });
  });
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error("No Chrome executable found. Set PLAYWRIGHT_CHROME_EXECUTABLE to run Desktop E2E verification.");
  }
  return executable;
}
