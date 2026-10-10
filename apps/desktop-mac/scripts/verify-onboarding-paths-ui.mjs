// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "../..");
const apiUrl = `http://127.0.0.1:${await freePort()}`;
const appUrl = `http://127.0.0.1:${await freePort()}`;
const children = [];
let browser;
try {
  launch(process.execPath, [join(desktopDir, "scripts/real-host-fixture.mjs")], repoRoot, {
    MN_FIXTURE_API_PORT: new URL(apiUrl).port, MN_FIXTURE_APP_ORIGIN: appUrl, MN_FIXTURE_MODE: "onboarding",
  });
  await waitForHttp(`${apiUrl}/v2/health`);
  launch(join(repoRoot, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", new URL(appUrl).port, "--strictPort"], desktopDir, { VITE_MN_API_URL: apiUrl });
  await waitForHttp(appUrl);
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "首次设置验收需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
  await recordsWithoutModel();
  await replayCommittedWorkspace();
  await codingWithoutModelAndResume();
  await externalAgentChecks();
  await builtinModelRetry();
  console.log(JSON.stringify({ ok: true, scenarios: ["records", "workspace-response-replay", "coding-resume", "external-readiness", "builtin-retry"] }));
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}

async function session(coding = false) {
  const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const page = await context.newPage();
  const requests = [];
  page.setDefaultTimeout(10_000);
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== apiUrl || request.method() !== "POST") return;
    requests.push({ path: url.pathname, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
  });
  await page.goto(appUrl);
  await page.getByRole("button", { name: "继续", exact: true }).click();
  if (coding) {
    await page.getByRole("button", { name: /OPC 经营管理/u }).click();
    await page.getByRole("button", { name: /Coding/u }).click();
  }
  await page.getByRole("button", { name: "继续", exact: true }).click();
  return { context, page, requests };
}

async function recordsWithoutModel() {
  const { context, page, requests } = await session();
  try {
    await page.getByRole("button", { name: "先整理记录", exact: true }).click();
    assert.equal(await page.getByLabel("API Key", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.getByLabel("工作区名称", { exact: true }).fill("无模型经营记录");
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.locator(".app-shell").waitFor();
    assert.equal(requests.filter(item => item.path === "/v2/model-connections").length, 0);
    assert.equal(requests.filter(item => item.path === "/v2/workspaces").length, 1);
  } finally { await context.close(); }
}

async function codingWithoutModelAndResume() {
  const { context, page, requests } = await session(true);
  try {
    await page.getByRole("button", { name: "先整理记录", exact: true }).click();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.getByLabel("工作区名称", { exact: true }).fill("无模型代码仓库");
    await page.getByLabel("第一个仓库", { exact: true }).fill("/workspace/onboarding-retry");
    const repositoryUrl = `${apiUrl}/v2/plugins/coding/repositories`;
    let fail = true;
    await page.route(repositoryUrl, async route => {
      if (fail) return failure(route, "仓库暂时无法登记");
      return route.continue();
    });
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.getByRole("alert").getByText("添加仓库未完成", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("第一个仓库", { exact: true }).inputValue(), "/workspace/onboarding-retry");
    assert.equal(await page.getByLabel("工作区名称", { exact: true }).inputValue(), "无模型代码仓库");
    assert.equal(await page.evaluate(() => localStorage.getItem("muniu:v2:onboarding-complete")), null);
    fail = false;
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.locator(".app-shell").waitFor();
    assert.equal(requests.filter(item => item.path === "/v2/workspaces").length, 1, "登记失败后应复用已建工作区");
    const attempts = requests.filter(item => item.path === "/v2/plugins/coding/repositories");
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0].key);
    assert.equal(attempts[0].key, attempts[1].key, "同一登记重试必须复用幂等键");
    assert.equal(requests.filter(item => item.path === "/v2/model-connections").length, 0);
  } finally { await context.close(); }
}

async function replayCommittedWorkspace() {
  const { context, page, requests } = await session();
  try {
    await page.getByRole("button", { name: "先整理记录", exact: true }).click();
    await assertNarrowLayout(page);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.getByLabel("工作区名称", { exact: true }).fill("响应丢失后恢复");
    let committedId;
    await page.route(`${apiUrl}/v2/workspaces`, async route => {
      if (route.request().method() !== "POST" || committedId) return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committedId = (await response.json()).data.id;
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.getByRole("alert").getByText("创建工作区未完成", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("工作区名称", { exact: true }).inputValue(), "响应丢失后恢复");
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.locator(".app-shell").waitFor().catch(async error => { throw new Error(`${error.message}\n${await page.locator(".error-state").allTextContents()}`); });
    const { data: workspaces } = await (await fetch(`${apiUrl}/v2/workspaces`)).json();
    const matches = workspaces.filter(item => item.name === "响应丢失后恢复");
    assert.equal(matches.length, 1, "丢失响应后的重试不得重复创建工作区");
    assert.equal(matches[0].id, committedId);
    const attempts = requests.filter(item => item.path === "/v2/workspaces");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].key, attempts[1].key);
  } finally { await context.close(); }
}

async function externalAgentChecks() {
  const { context, page, requests } = await session(true);
  try {
    await page.getByRole("button", { name: "连接内置模型", exact: true }).click();
    await page.getByLabel("API Key", { exact: true }).fill("fixture-unused-model-key");
    await page.getByRole("button", { name: "连接外部 Agent", exact: true }).click();
    assert.equal(await page.getByLabel("API Key", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.getByLabel("工作区名称", { exact: true }).fill("外部 Agent 工作区");
    await page.getByLabel("第一个仓库", { exact: true }).fill("/workspace/external-agent");
    await page.getByRole("button", { name: "创建并检查 Agent", exact: true }).click();
    const readiness = page.getByRole("region", { name: "外部 Agent 调度检查", exact: true });
    await readiness.waitFor();
    await assertNarrowLayout(page);
    const codex = readiness.getByRole("region", { name: "Codex CLI 接入状态", exact: true });
    await codex.getByText("查看检查项与处理步骤", { exact: true }).click();
    await codex.getByText("尚未检查 CLI 安装文件", { exact: true }).waitFor();
    await codex.getByText("CLI 登录态、模型权限与额度未验证", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("muniu:v2:onboarding-complete")), null);
    assert.equal(requests.filter(item => item.path.includes("/plugin-activations") || item.path.includes("/confirmations")).length, 0, "路径选择不得自动启用或确认 Runner");
    const readinessUrl = /\/v2\/workspaces\/[^/]+\/agent-readiness$/u;
    await page.route(readinessUrl, async route => {
      const response = await route.fetch();
      const body = await response.json();
      const report = body.data ?? body;
      const agent = report.agents.find(item => item.agentId === "codex-cli");
      const identity = agent.checks.find(item => item.id === "binary_identity");
      identity.status = "blocked";
      identity.message = "已确认的 CLI 文件摘要不匹配";
      identity.action = "重新核对安装文件";
      await route.fulfill({ response, json: body });
    });
    await readiness.getByRole("button", { name: "重新检查", exact: true }).click();
    await codex.getByText("已确认的 CLI 文件摘要不匹配", { exact: true }).waitFor();
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.locator(".app-shell").waitFor();
    assert.equal(requests.filter(item => item.path === "/v2/model-connections").length, 0);
    assert.equal(requests.filter(item => item.path === "/v2/workspaces").length, 1);
  } finally { await context.close(); }
}

async function builtinModelRetry() {
  const { context, page, requests } = await session();
  try {
    await page.getByRole("button", { name: "连接内置模型", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "继续", exact: true }).isEnabled(), false);
    await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
    await page.getByLabel("API Key", { exact: true }).fill("fixture-onboarding-key");
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.getByLabel("工作区名称", { exact: true }).fill("内置模型工作区");
    const probeUrl = /\/v2\/model-connections\/[^/]+\/probe$/u;
    let fail = true;
    await page.route(probeUrl, route => fail ? failure(route, "模型连接暂时不可用") : route.continue());
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.getByRole("alert").getByText("验证模型连接未完成", { exact: true }).waitFor();
    assert.equal(requests.filter(item => item.path === "/v2/workspaces").length, 0);
    await page.getByRole("button", { name: "上一步", exact: true }).click();
    assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "fixture-onboarding-key");
    await page.getByRole("button", { name: "继续", exact: true }).click();
    fail = false;
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await page.locator(".app-shell").waitFor();
    assert.equal(requests.filter(item => item.path === "/v2/model-connections").length, 1, "验证失败应复用已保存的模型连接");
    const attempts = requests.filter(item => item.path.endsWith("/probe"));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].key, attempts[1].key);
  } finally { await context.close(); }
}

function failure(route, message) {
  return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "SERVICE_UNAVAILABLE", message,
    action: "重试当前步骤", fieldIssues: [], traceId: "onboarding-path-fixture", retryable: true }) });
}
async function assertNarrowLayout(page) {
  const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(size.scrollWidth <= size.width + 1, "960 像素窗口不得横向溢出");
}
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  children.push(child);
}
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(address.port)); });
  });
}
async function waitForHttp(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* Wait for the isolated fixture. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`服务未就绪：${url}`);
}
