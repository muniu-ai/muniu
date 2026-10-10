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
  let version = 0;
  async function command(value) {
    const response = await fetch(`${apiUrl}/v2/plugins/opc/business/commands`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ workspaceId: workspace.id, expectedStreamVersion: version, command: value }) });
    assert.equal(response.status, 200); const result = (await response.json()).data; version = result.state.streamVersion; return result;
  }
  await command({ type: "customer.record", customerId: "customer", name: "青禾", source: "客户面谈", need: "客户事实原文不得进入目标正文", contact: "fixture-contact" });
  await command({ type: "service.record", serviceId: "service", title: "设计服务", currency: "CNY", priceMinor: "100000", inScope: ["标志"], outOfScope: ["印刷"], acceptanceCriteria: ["源文件"] });
  await command({ type: "order.record", orderId: "order", customerId: "customer", serviceId: "service", serviceVersion: 1, quantity: 1, agreedAmountMinor: "100000", contractedOn: "2026-10-01", dueOn: "2026-10-30", sourceRef: "合同", opening: { asOf: "2026-10-01", receivedMinor: "0", deliveredPercent: 0, accepted: false, sourceRef: "期初" } });
  await command({ type: "delivery.record", deliveryId: "delivery", orderId: "order", title: "标志初稿", deliveredOn: "2026-10-02", artifactRef: "原文件", progressPercent: 50 });
  await command({ type: "review.record", reviewId: "review", period: { start: "2026-10-01", end: "2026-10-10" }, explanation: "尚未验收", nextDecisions: ["完善交付"] });
  const goals = [];
  page.on("request", request => { if (request.method() !== "POST") return; const path = new URL(request.url()).pathname; if (/\/workspaces\/[^/]+\/goals$/u.test(path)) goals.push(request.postDataJSON()); });
  await page.goto(appUrl);
  const composer = page.getByRole("form", { name: "委派新任务" });
  for (const [kind, tab] of [["customer", "客户"], ["order", "报价与订单"], ["delivery", "交付与验收"], ["review", "周期复盘"]]) {
    await page.getByRole("button", { name: "经营", exact: true }).click();
    await page.getByRole("navigation", { name: "经营模块" }).getByRole("button", { name: tab, exact: true }).click();
    await page.getByRole("button", { name: "交给 Agent", exact: true }).first().click();
    await composer.getByRole("region", { name: "关联业务资料" }).getByText("事实版本", { exact: false }).waitFor();
    if (kind === "customer") {
      const draft = await composer.getByLabel("任务目标", { exact: true }).inputValue();
      await command({ type: "customer.record", customerId: "customer", name: "青禾", source: "面谈补充", need: "提交计划前已更新的需求" });
      await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
      await composer.getByRole("alert").filter({ hasText: "任务说明已保留" }).waitFor();
      assert.equal(await composer.getByLabel("任务目标", { exact: true }).isEnabled(), true, "来源过期的明确拒绝应允许核对资料并继续");
      assert.equal(await composer.getByLabel("任务目标", { exact: true }).inputValue(), draft);
      await composer.getByRole("button", { name: "重新核对业务资料", exact: true }).click();
      await composer.getByRole("region", { name: "关联业务资料" }).getByText(`事实版本 ${version}`, { exact: false }).waitFor();
    }
    const context = (await (await fetch(`${apiUrl}/v2/workspaces/${workspace.id}/business-context/${kind}/${kind}`)).json()).data;
    assert.ok((await composer.getByLabel("任务目标", { exact: true }).inputValue()).includes(context.title));
    await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
    await page.getByRole("button", { name: "确认计划并启动", exact: true }).waitFor().catch(async caught => { throw new Error(`${kind}: ${caught.message}\n${await page.locator("main").innerText()}`); });
    if (kind === "customer") assert.equal(goals[0].threadId, goals[1].threadId, "只更新资料版本应复用已保存会话");
    assert.ok(goals.at(-1).resourceRefs.some(ref => ref.namespace === `opc.business.${kind}` && ref.resourceId === kind && ref.streamVersion === version && ref.digest === context.sourceRef.digest));
    assert.equal(goals.at(-1).objective.includes(context.content), false);
    await page.getByRole("tab", { name: "目标", exact: true }).click();
    const sources = page.getByRole("region", { name: "任务资料来源", exact: true });
    await sources.getByText(context.title, { exact: true }).waitFor();
    await sources.getByRole("button", { name: `查看业务资料：${context.title}`, exact: true }).click();
    await sources.locator(".goal-preview").waitFor();
  }
  await command({ type: "customer.record", customerId: "customer", name: "青禾", source: "最新面谈", need: "更新后的需求" });
  const sources = page.getByRole("region", { name: "任务资料来源", exact: true });
  await sources.getByRole("alert").filter({ hasText: "资料版本已变化" }).waitFor();
  assert.equal(await sources.locator(".goal-preview").count(), 0);
  console.log(JSON.stringify({ ok: true, scenarios: ["customer-delegation", "order-delegation", "delivery-delegation", "review-delegation", "business-source-staleness", "stale-draft-recovery"] }));
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
