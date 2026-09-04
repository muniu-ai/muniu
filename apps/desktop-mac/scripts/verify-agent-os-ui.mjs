import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const mode = process.argv[2] ?? "onboarding";
if (!new Set(["onboarding", "opc", "coding"]).has(mode)) throw new Error(`未知验证模式：${mode}`);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), `muniu-agent-os-${mode}-`));
const apiPort = await freePort();
const vitePort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${vitePort}`;
const screenshotPath = join(temporaryRoot, `${mode}.png`);
const requests = [];
const children = [];
let browser;

try {
  const fixture = spawn(process.execPath, [join(scriptDir, "real-host-fixture.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MN_FIXTURE_API_PORT: String(apiPort),
      MN_FIXTURE_APP_ORIGIN: appUrl,
      MN_FIXTURE_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(fixture);
  fixture.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForHttp(`${apiUrl}/v2/health`);
  const viteBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  const vite = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: desktopDir,
    env: { ...process.env, VITE_MN_API_URL: apiUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(vite);
  await waitForHttp(appUrl);
  browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  if (mode !== "onboarding") {
    await context.addInitScript(() => localStorage.setItem("muniu:v2:onboarding-complete", "1"));
  }
  const page = await context.newPage();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== apiUrl || ["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
    let body = {};
    try { body = request.postDataJSON(); } catch { /* 请求体不是 JSON */ }
    requests.push({ method: request.method(), path: url.pathname, body });
  });
  page.setDefaultTimeout(12_000);
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  if (mode === "onboarding") await verifyOnboarding(page, requests);
  if (mode === "opc") await verifyOpc(page);
  if (mode === "coding") await verifyCoding(page, requests);

  await assertViewportFit(page);
  await page.waitForTimeout(350);
  await page.screenshot({ path: screenshotPath });
  await page.setViewportSize({ width: 960, height: 640 });
  await assertViewportFit(page);
  const shortcut = await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return { key: event.key, metaKey: event.metaKey, prevented: event.defaultPrevented };
  });
  if (!shortcut.metaKey || !shortcut.prevented) throw new Error(`Cmd-K 未被应用接管：${JSON.stringify(shortcut)}`);
  await page.getByRole("dialog", { name: "命令中心" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  console.log(JSON.stringify({ ok: true, mode, screenshotPath, requestCount: requests.length }));
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of children.reverse()) child.kill("SIGTERM");
  if (process.env.MN_DESKTOP_E2E_KEEP_TEMP !== "1") await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifyOnboarding(page, requestLog) {
  await expectText(page, "四步建立你的工作台");
  await expectText(page, "你希望先看到什么");
  await page.getByRole("button", { name: /专业视图/ }).click();
  await page.getByRole("button", { name: /经营视图/ }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await expectText(page, "选择现在要做的事");
  await page.getByRole("button", { name: /Coding/ }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await expectText(page, "连接你的模型");
  const screenText = await page.locator("body").innerText();
  for (const forbidden of ["Provider ID", "Model ID", "Base URL", "wire format"]) {
    if (screenText.includes(forbidden)) throw new Error(`向导暴露了技术字段：${forbidden}`);
  }
  await page.getByRole("button", { name: /DeepSeek/ }).click();
  await page.getByLabel("API Key").fill("test-key-not-a-secret");
  await page.getByRole("button", { name: "继续" }).click();
  await expectText(page, "创建第一个工作区");
  await page.getByLabel("工作区名称").fill("设计师增长");
  await page.getByLabel("第一条机会").fill("帮助独立设计师稳定获得高质量客户");
  await page.getByRole("button", { name: /进入工作台/ }).click();
  await expectText(page, "设计师增长");
  await expectText(page, "今天");
  const modelRequest = requestLog.find((entry) => entry.path === "/v2/model-connections");
  if (!modelRequest || modelRequest.body.presetId !== "deepseek" || !modelRequest.body.apiKey) {
    throw new Error("BYOK 向导没有提交厂商预设和密钥");
  }
  for (const field of ["providerId", "modelId", "baseUrl", "wireFormat"]) {
    if (field in modelRequest.body) throw new Error(`模型连接请求不应包含 ${field}`);
  }
}

async function verifyOpc(page) {
  await expectText(page, "首页");
  await page.getByRole("button", { name: "OPC" }).click();
  await expectText(page, "已有兴趣信号");
  await expectText(page, "支持证据");
  await expectText(page, "反证");
  await expectText(page, "证据缺口");
  await expectText(page, "下一步");
  await page.getByRole("button", { name: "收件箱" }).click();
  await expectText(page, "读取客户公开案例并保存摘要");
  await expectText(page, "https://example.com/case");
  await expectText(page, "external_read");
  await page.getByRole("button", { name: "仅批准这一次" }).click();
  await expectText(page, "收件箱已清空");
  await page.getByRole("button", { name: "OPC" }).click();
  await expectText(page, "已有兴趣信号");
}

async function verifyCoding(page, requestLog) {
  await page.getByRole("button", { name: "Coding" }).click();
  await expectText(page, "统一 Agent OS API");
  await expectText(page, "差异");
  await expectText(page, "检查");
  await expectText(page, "审批");
  await expectText(page, "下一步");
  if ((await page.locator("body").innerText()).includes("Harness 摘要")) throw new Error("经营视图不应显示 Harness");
  await page.getByTitle("技术配置").click();
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "专业视图" }).click();
  await page.getByRole("button", { name: "Coding" }).click();
  await expectText(page, "高级执行设置");
  await page.getByText("高级执行设置").click();
  await expectText(page, "Harness 摘要");
  const workspacePaths = requestLog.filter((entry) => /^\/v2\/workspaces\/[^/]+$/.test(entry.path) || entry.path === "/v2/plugins/coding/tasks");
  if (workspacePaths.length === 0) throw new Error("专业视图没有使用统一 v2 接口");
}

async function expectText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible" });
}

async function assertViewportFit(page) {
  const fit = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    shell: document.querySelector(".app-shell")?.getBoundingClientRect().toJSON(),
    primary: document.querySelector(".primary-button")?.getBoundingClientRect().toJSON(),
  }));
  if (fit.scrollWidth > fit.width + 1) throw new Error(`页面横向溢出：${JSON.stringify(fit)}`);
  if (fit.shell && (fit.shell.width > fit.width + 1 || fit.shell.height > fit.height + 1)) throw new Error(`Shell 超出窗口：${JSON.stringify(fit)}`);
  if (fit.primary && (fit.primary.right > fit.width + 1 || fit.primary.bottom > fit.height + 1)) throw new Error(`主操作不可见：${JSON.stringify(fit)}`);
}

function freePort() { return new Promise((resolvePort, reject) => { const server = createNetServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("无法分配端口")); server.close(() => resolvePort(address.port)); }); }); }

async function waitForHttp(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* 等待服务 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`服务未就绪：${url}`);
}

function chromeExecutable() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
      ? [join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe")]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error("未找到可用于桌面验收的 Chrome 或 Chromium");
  return executable;
}
