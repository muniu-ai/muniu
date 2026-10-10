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
    { MN_FIXTURE_API_PORT: new URL(apiUrl).port, MN_FIXTURE_APP_ORIGIN: appUrl, MN_FIXTURE_MODE: "tasks" });
  await ready(`${apiUrl}/v2/health`);
  launch(join(root, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", new URL(appUrl).port, "--strictPort"], desktopDir, { VITE_MN_API_URL: apiUrl });
  await ready(appUrl);
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "资料验收需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem("muniu:v2:onboarding-complete", "1"));
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const uploads = [], goals = [];
  page.on("request", request => {
    if (request.method() !== "POST" || !request.url().startsWith(apiUrl)) return;
    const path = new URL(request.url()).pathname;
    const item = { key: request.headers()["idempotency-key"], body: request.postDataJSON() };
    if (path === "/v2/assets") uploads.push(item);
    if (/\/workspaces\/[^/]+\/goals$/u.test(path)) goals.push(item);
  });
  let committedAsset;
  await page.route(`${apiUrl}/v2/assets`, async route => {
    if (committedAsset) return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 201);
    committedAsset = (await response.json()).data[0];
    await route.abort("failed");
  });
  let failGoal = true;
  await page.route(`${apiUrl}/v2/workspaces/*/goals`, route => route.request().method() === "POST" && failGoal
    ? route.fulfill({ status: 503, contentType: "application/json", json: { code: "SERVICE_UNAVAILABLE", message: "目标暂时无法保存", action: "重试当前请求", fieldIssues: [], traceId: "material-fixture", retryable: true } })
    : route.continue());
  await page.goto(appUrl);
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  const composer = page.getByRole("form", { name: "委派新任务" });
  await composer.getByLabel("任务目标", { exact: true }).fill("根据资料整理交付要求");
  await composer.getByLabel("验收要求", { exact: true }).fill("每项要求引用资料位置");
  const originalText = `资料专用正文，不得写入目标描述。\n第二段包含待核验的事实。${"x".repeat(17_000)}`;
  await composer.getByLabel("添加文本资料").setInputFiles({ name: "交付说明.md", mimeType: "text/markdown", buffer: Buffer.from(originalText) });
  await composer.getByRole("button", { name: "重试资料：交付说明.md", exact: true }).waitFor();
  assert.equal(await composer.getByLabel("任务目标", { exact: true }).inputValue(), "根据资料整理交付要求");
  await composer.getByRole("button", { name: "重试资料：交付说明.md", exact: true }).click();
  await composer.getByText("已解析", { exact: true }).waitFor();
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].key, uploads[1].key, "上传响应丢失必须复用幂等键");
  assert.deepEqual(uploads[0].body, uploads[1].body);
  assert.equal(uploads[0].body.attachments[0].protected, true);
  assert.equal(committedAsset.protected, true);
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await composer.getByRole("alert").filter({ hasText: "任务说明已保留" }).waitFor();
  failGoal = false;
  await composer.getByRole("button", { name: "继续准备", exact: true }).click();
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).waitFor();
  assert.equal(goals.length, 2);
  assert.equal(goals[0].key, goals[1].key, "目标重试必须复用幂等键");
  assert.deepEqual(goals[0].body, goals[1].body);
  assert.equal(goals[0].body.objective.includes(originalText), false, "正文不得写入目标描述");
  assert.deepEqual(goals[0].body.resourceRefs, [{ namespace: "asset", resourceId: committedAsset.id, streamVersion: committedAsset.streamVersion, digest: committedAsset.digest }]);
  const sources = page.getByRole("region", { name: "任务资料来源", exact: true });
  await sources.getByText("交付说明.md", { exact: true }).waitFor();
  await sources.getByRole("button", { name: "查看摘录：交付说明.md", exact: true }).click();
  await sources.getByText("第 1 段", { exact: true }).waitFor();
  const download = page.waitForEvent("download");
  await sources.getByRole("button", { name: "下载原文：交付说明.md", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "交付说明.md");
  await page.setViewportSize({ width: 960, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  const removed = await fetch(`${apiUrl}/v2/assets/${committedAsset.id}`, { method: "DELETE", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ expectedStreamVersion: committedAsset.streamVersion, reason: "资料验收撤回" }) });
  assert.equal(removed.ok, true);
  await sources.getByRole("alert").waitFor();
  assert.equal(await sources.locator(".goal-preview").count(), 0, "来源删除后不得保留旧摘录");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await composer.getByLabel("任务目标", { exact: true }).fill("检查不可读资料");
  await composer.getByLabel("验收要求", { exact: true }).fill("明确缺失内容");
  await composer.getByLabel("添加文本资料").setInputFiles({ name: "空资料.txt", mimeType: "text/plain", buffer: Buffer.from(" \n\n") });
  await composer.getByText("无法读取，请移除或重新提供文本", { exact: true }).waitFor();
  assert.equal(await composer.getByRole("button", { name: "准备执行计划", exact: true }).isEnabled(), false, "不可读资料不得进入计划");
  assert.equal(await composer.getByLabel("任务目标", { exact: true }).inputValue(), "检查不可读资料");
  await composer.getByRole("button", { name: "移除 空资料.txt", exact: true }).click();
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).waitFor();
  assert.equal(await composer.getByRole("button", { name: "准备执行计划", exact: true }).isEnabled(), true);
  console.log(JSON.stringify({ ok: true, scenarios: ["protected-asset-replay", "goal-reference-replay", "source-locators-and-download", "source-revocation", "unreadable-material"] }));
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => process.stderr.write(chunk)); children.push(child);
}
function freePort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(address.port)); }); }); }
async function ready(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch { /* Wait for the isolated fixture. */ } await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  throw new Error(`服务未就绪：${url}`);
}
