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
  const workspace = (await (await fetch(`${apiUrl}/v2/workspaces`)).json()).data[0];
  const response = await fetch(`${apiUrl}/v2/plugins/coding/repositories`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ workspaceId: workspace.id, expectedStreamVersion: 0, input: "/workspace/second" }) });
  assert.equal(response.ok, true); const secondRepository = (await response.json()).data;
  const captures = [], goals = [];
  page.on("request", request => {
    if (request.method() !== "POST") return; const path = new URL(request.url()).pathname;
    if (path === "/v2/plugins/coding/tasks") captures.push(request.postDataJSON());
    if (/\/workspaces\/[^/]+\/goals$/u.test(path)) goals.push(request.postDataJSON());
  });
  let rejectGoal = true;
  await page.route(`${apiUrl}/v2/workspaces/*/goals`, route => route.request().method() === "POST" && rejectGoal
    ? route.fulfill({ status: 403, contentType: "application/json", json: { code: "FORBIDDEN", message: "本次资料暂不可用", action: "核对任务后重试", fieldIssues: [], traceId: "recovery-fixture", retryable: false } })
    : route.continue());
  await page.goto(appUrl);
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  const composer = page.getByRole("form", { name: "委派新任务" });
  await composer.getByRole("radio", { name: "研发", exact: true }).check();
  const repository = composer.getByLabel("任务仓库", { exact: true });
  const firstRepository = await repository.locator("option").evaluateAll(items => items.find(item => item.value && item.textContent.includes("/workspace/muniu")).value);
  await repository.selectOption(firstRepository);
  await composer.getByLabel("任务目标", { exact: true }).fill("修复原始功能");
  await composer.getByLabel("验收要求", { exact: true }).fill("行为符合新的约定");
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await composer.getByRole("alert").filter({ hasText: "任务说明已保留" }).waitFor();
  await composer.getByLabel("任务目标", { exact: true }).fill("实现修改后的功能");
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await composer.getByRole("alert").filter({ hasText: "任务说明已保留" }).waitFor();
  assert.equal(captures.length, 2, "更改任务输入后不得复用旧 Coding task");
  assert.equal(captures[1].input, "实现修改后的功能");
  assert.notEqual(goals[0].threadId, goals[1].threadId);
  await repository.selectOption(secondRepository.id);
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await composer.getByRole("alert").filter({ hasText: "任务说明已保留" }).waitFor();
  assert.equal(captures.length, 3, "更改仓库后不得复用旧 Coding task");
  assert.equal(captures[2].repositoryId, secondRepository.id);
  assert.notEqual(goals[1].threadId, goals[2].threadId);
  await composer.getByRole("radio", { name: "经营", exact: true }).check();
  rejectGoal = false;
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).waitFor();
  assert.notEqual(goals[2].threadId, goals[3].threadId, "更改任务类型后不得复用旧会话");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await composer.getByLabel("任务目标", { exact: true }).fill("核对响应未知的目标");
  await composer.getByLabel("验收要求", { exact: true }).fill("保留唯一目标身份");
  await page.unroute(`${apiUrl}/v2/workspaces/*/goals`);
  let lostResponse = false;
  await page.route(`${apiUrl}/v2/workspaces/*/goals`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    if (!lostResponse) {
      const response = await route.fetch(); assert.equal(response.ok(), true); lostResponse = true; return route.abort("failed");
    }
    return route.fulfill({ status: 403, contentType: "application/json", json: { code: "FORBIDDEN", message: "权限已变化", action: "核对已保存任务", fieldIssues: [], traceId: "unknown-fixture", retryable: false } });
  });
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await composer.getByRole("alert").filter({ hasText: "任务说明已保留" }).waitFor();
  await composer.getByRole("button", { name: "继续准备", exact: true }).click();
  await composer.getByRole("alert").filter({ hasText: "权限已变化" }).waitFor();
  assert.equal(await composer.getByLabel("任务目标", { exact: true }).isEnabled(), false, "后续拒绝不能抹掉之前的未知提交结果");
  console.log(JSON.stringify({ ok: true, scenarios: ["changed-objective-creates-task", "changed-repository-creates-task", "changed-kind-creates-thread", "unknown-result-remains-locked"] }));
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
