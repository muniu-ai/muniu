import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
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
const state = { viewMode: "business", opcRequests: 0, approved: false };
const api = createMockApi(apiPort, state, requests);
const children = [];
let browser;

try {
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
  await new Promise((resolveClose) => api.close(resolveClose));
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
  await expectText(page, "OPC 已降级");
  await expectText(page, "核心页面和 Coding 不受影响");
  await page.getByRole("button", { name: "重试" }).click();
  await expectText(page, "方案待验证");
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
  await expectText(page, "方案待验证");
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
  const workspacePaths = requestLog.filter((entry) => entry.path === "/v2/workspaces/workspace-1" || entry.path === "/v2/plugins/coding/tasks");
  if (workspacePaths.length === 0) throw new Error("专业视图没有使用统一 v2 接口");
}

function createMockApi(port, state, requestLog) {
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const body = await readJson(request);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) requestLog.push({ method: request.method, path: url.pathname, body });
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type,idempotency-key");
    response.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
    if (request.method === "OPTIONS") return respond(response, 204);
    if (url.pathname === "/v2/health") return respond(response, 200, { data: { core: { status: "healthy" }, plugins: [{ pluginId: "opc", status: "healthy" }, { pluginId: "coding", status: "healthy" }] } });
    if (request.method === "POST" && url.pathname === "/v2/setup") return respond(response, 200, { data: { tenantId: "local", principalId: "local-owner" } });
    if (request.method === "POST" && url.pathname === "/v2/model-connections") return respond(response, 200, { data: { id: "connection-1", defaultModel: "deepseek-chat", discoveredModels: ["deepseek-chat"] } });
    if (request.method === "POST" && url.pathname === "/v2/model-connections/connection-1/probe") return respond(response, 200, { data: { status: "ready", defaultModel: "deepseek-chat" } });
    if (request.method === "POST" && url.pathname === "/v2/workspaces") { state.viewMode = body.viewMode; return respond(response, 200, { data: workspace(body.name) }); }
    if (request.method === "PATCH" && url.pathname === "/v2/workspaces/workspace-1") { state.viewMode = body.viewMode; return respond(response, 200, { data: workspace("设计师增长", 2) }); }
    if (request.method === "GET" && url.pathname === "/v2/workspaces") return respond(response, 200, { data: [workspace("设计师增长")] });
    if (request.method === "GET" && url.pathname === "/v2/workspaces/workspace-1/home") return respond(response, 200, { data: home(state.approved) });
    if (request.method === "GET" && url.pathname === "/v2/deliverables") return respond(response, 200, { data: deliverables() });
    if (request.method === "GET" && url.pathname === "/v2/activity") return respond(response, 200, { data: [{ id: "activity-1", title: "机会研究已完成", status: "completed", cost: "¥0.18", occurredAt: "2026-09-04T08:00:00Z" }] });
    if (request.method === "GET" && url.pathname === "/v2/memories") return respond(response, 200, { data: [{ id: "memory-1", namespace: "opc", resourceId: "opportunity-1", summary: "目标客户重视可预测的获客节奏", source: "访谈记录 01", confidence: .82, status: "proposed", streamVersion: 1 }] });
    if (request.method === "GET" && url.pathname === "/v2/plugins/opc/opportunities") {
      state.opcRequests += 1;
      if (mode === "opc" && state.opcRequests === 1) return respond(response, 503, failure("PLUGIN_DEGRADED", "OPC 暂时不可用", "点击重试"));
      return respond(response, 200, { data: opportunities() });
    }
    if (request.method === "GET" && url.pathname === "/v2/plugins/coding/tasks") return respond(response, 200, { data: codingTasks() });
    if (request.method === "POST" && url.pathname === "/v2/approvals/approval-1/decisions") { state.approved = true; return respond(response, 200, { data: { status: "approved_once" } }); }
    if (request.method === "POST" && /\/v2\/memories\/[^/]+\/decisions$/.test(url.pathname)) return respond(response, 200, { data: { status: body.decision === "accept" ? "accepted" : "rejected" } });
    if (request.method === "POST" && url.pathname.startsWith("/v2/plugins/")) return respond(response, 200, { data: { id: "created-1", streamVersion: 1 } });
    return respond(response, 404, failure("NOT_FOUND", "接口不存在", "更新客户端"));
  }).listen(port, "127.0.0.1");

  function workspace(name, streamVersion = 1) { return { id: "workspace-1", name, viewMode: state.viewMode, activePluginIds: ["opc", "coding"], streamVersion }; }
}

function home(approved) {
  return {
    todayActions: [{ id: "action-1", title: "补足愿意付费的承诺证据", detail: "安排 3 次非诱导访谈", pluginId: "opc" }],
    blockers: [{ id: "blocker-1", title: "收费假设仍缺少证据", detail: "至少需要一位目标客户确认下一步行动" }],
    approvals: approved ? [] : [{ id: "approval-1", title: "公开网页读取", intent: "读取客户公开案例并保存摘要", resourceSummary: "https://example.com/case", risk: "external_read", expiresAt: "2026-09-05T08:00:00Z", streamVersion: 1 }],
    recentDeliverables: deliverables(),
  };
}

function deliverables() { return [{ id: "deliverable-1", pluginId: "opc", title: "机会验证档案", outcome: "已整理支持证据、反证和 2 个证据缺口", decision: "继续访谈", nextAction: "确认一次客户承诺", createdAt: "2026-09-04T08:00:00Z" }]; }

function opportunities() { return [{ id: "opportunity-1", title: "独立设计师稳定获客", targetCustomer: "有 2–5 年经验的独立设计师", problem: "收入依赖不稳定的转介绍", falsifiableHypothesis: "若提供每周可执行的获客系统，3 位目标客户中至少 1 位愿意承诺付费试用", status: "evaluating", evidenceLevel: "none", streamVersion: 5, evidence: [{ id: "signal-1", stance: "supporting", summary: "两位设计师主动询问可复制的获客流程", source: "访谈记录", capturedAt: "2026-09-03T08:00:00Z" }, { id: "signal-2", stance: "opposing", summary: "一位受访者更愿意继续依赖熟人推荐", source: "访谈记录", capturedAt: "2026-09-04T08:00:00Z" }], gaps: ["没有价格承诺", "尚未观察实际使用"], nextAction: "用非诱导问题完成 3 次访谈" }]; }

function codingTasks() { return [{ id: "task-1", title: "统一 Agent OS API", repository: "muniu-ai/muniu", status: "verify", diffSummary: "12 个文件 · +486 −120", checks: [{ name: "单元测试", status: "pass" }, { name: "类型检查", status: "pass" }, { name: "安全 Gate", status: "pending" }], approval: "安全 Gate 通过后请求合并批准", nextAction: "完成安全 Gate", advanced: { harnessDigest: "sha256:7ab4…d91e", candidateCount: 1, remainingBudget: "2 次修复 · 42 分钟" } }]; }

function failure(code, message, action) { return { code, message, action, fieldIssues: [], traceId: "trace-test", retryable: true }; }

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

function respond(response, status, value) {
  response.statusCode = status;
  if (value !== undefined) { response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); }
  else response.end();
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
