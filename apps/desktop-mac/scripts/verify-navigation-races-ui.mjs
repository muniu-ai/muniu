// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktopDir, "../..");
const apiUrl = `http://127.0.0.1:${await freePort()}`;
const appUrl = `http://127.0.0.1:${await freePort()}`;
const children = [];
let browser;
try {
  launch(process.execPath, [join(desktopDir, "scripts/real-host-fixture.mjs")], root,
    { MN_FIXTURE_API_PORT: new URL(apiUrl).port, MN_FIXTURE_APP_ORIGIN: appUrl, MN_FIXTURE_MODE: "goals" });
  await ready(`${apiUrl}/v2/health`);
  const [workspace] = await data("/v2/workspaces");
  const threads = await data(`/v2/workspaces/${workspace.id}/threads`);
  const goal = await data(`/v2/workspaces/${workspace.id}/goals`, {
    threadId: threads.find(thread => thread.pluginId === "opc").id, objective: "搜索导航的延迟目标", resourceRefs: [],
    budget: { maxTokens: 1000, maxCostMinorUnits: "1000", currency: "CNY", maxDurationMs: 60_000 },
    deliverables: [{ key: "report", title: "导航检查", required: true, criteria: [{ id: "check", description: "检查导航" }] }],
  });
  launch(join(root, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", new URL(appUrl).port, "--strictPort"], desktopDir, { VITE_MN_API_URL: apiUrl });
  await ready(appUrl);
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "导航验收需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
  const failures = [];
  for (const scenario of [() => staleTargetCannotReplaceDraft(goal.goal.id), repositorySearchLeavesTask]) {
    try { await scenario(); } catch (error) { failures.push(error.message); }
  }
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ ok: true, scenarios: ["stale-goal-navigation", "repository-focus"] }));
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}

async function session() {
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  await context.addInitScript(() => localStorage.setItem("muniu:v2:onboarding-complete", "1"));
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  await page.goto(appUrl);
  await page.locator(".app-shell").waitFor();
  return { context, page };
}
async function search(page, text) {
  await page.locator(".search-trigger").click();
  const dialog = page.getByRole("dialog", { name: "命令中心" });
  await dialog.getByRole("textbox").fill(text);
  return dialog;
}
async function staleTargetCannotReplaceDraft(goalId) {
  const { context, page } = await session();
  let release;
  const held = new Promise(resolveHeld => { release = resolveHeld; });
  let received;
  const intercepted = new Promise(resolveReceived => { received = resolveReceived; });
  try {
    await page.route(`${apiUrl}/v2/goals/${goalId}?*`, async route => {
      const response = await route.fetch(); received(); await held;
      await route.fulfill({ response });
    });
    const dialog = await search(page, "搜索导航的延迟目标");
    await dialog.getByRole("option").click();
    await intercepted;
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("任务目标", { exact: true }).fill("保留后续填写的草稿");
    const returned = page.waitForResponse(response => response.url().includes(`/v2/goals/${goalId}?`));
    release(); await returned;
    await page.waitForTimeout(300);
    assert.equal(await page.getByLabel("任务目标", { exact: true }).isVisible(), true, "迟到目标详情覆盖了后续的新建任务选择");
    assert.equal(await page.getByLabel("任务目标", { exact: true }).inputValue(), "保留后续填写的草稿");
  } finally { release(); await context.close(); }
}
async function repositorySearchLeavesTask() {
  const { context, page } = await session();
  try {
    await page.getByRole("button", { name: "Coding", exact: true }).click();
    await page.locator(".coding-card").getByRole("button", { name: "打开任务", exact: true }).click();
    await page.getByRole("heading", { name: "统一 Agent OS API", exact: true }).waitFor();
    const dialog = await search(page, "muniu");
    await dialog.getByRole("option").filter({ hasText: "仓库 · /workspace/muniu" }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("region", { name: "Coding 仓库", exact: true }).isVisible(), true, "搜索仓库后仍停留在原任务详情");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes("/workspace/muniu")), true, "搜索仓库后未聚焦匹配仓库");
  } finally { await context.close(); }
}
async function data(path, body) {
  const response = await fetch(`${apiUrl}${path}`, body ? { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) } : {});
  assert.ok(response.ok, `fixture 请求失败：${path}`);
  return (await response.json()).data;
}
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => process.stderr.write(chunk)); children.push(child);
}
function freePort() {
  return new Promise((resolvePort, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(address.port)); }); });
}
async function ready(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch { /* Wait for the isolated fixture. */ } await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  throw new Error(`服务未就绪：${url}`);
}
