// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";

let browser, server, address;
before(async () => {
  const bundled = await build({ entryPoints: [new URL("../fixtures/team-views.tsx", import.meta.url).pathname], bundle: true,
    platform: "browser", format: "esm", jsx: "automatic", write: false, outfile: "team-views.js" });
  const files = new Map(bundled.outputFiles.map(file => [file.path.endsWith(".css") ? "/app.css" : "/app.js", file.text]));
  server = createServer((request, response) => {
    const content = files.get(request.url);
    response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : request.url === "/app.css" ? "text/css" : "text/html");
    response.end(content ?? '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "视图测试需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function page(fixture) { const current = await browser.newPage({ viewport: { width: 960, height: 640 } }); await current.goto(`${address}${fixture ? `?fixture=${fixture}` : ""}`); return current; }

test("四个详情视图支持键盘切换，隐藏页保留草稿且仅当前页可访问", async () => {
  const current = await page();
  try {
    const tabs = current.getByRole("tablist", { name: "任务详情视图" });
    assert.equal(await tabs.getByRole("tab").count(), 4);
    await current.getByLabel("保留的任务草稿", { exact: true }).fill("尚未提交的修改");
    await tabs.getByRole("tab", { name: "目标", exact: true }).focus();
    await current.keyboard.press("ArrowRight");
    assert.equal(await tabs.getByRole("tab", { name: "计划", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await current.getByRole("tabpanel").count(), 1);
    await current.getByRole("tabpanel", { name: "计划", exact: true }).getByText("待确认的固定计划").waitFor();
    await current.keyboard.press("End");
    assert.equal(await tabs.getByRole("tab", { name: "成果", exact: true }).getAttribute("aria-selected"), "true");
    await current.keyboard.press("Home");
    assert.equal(await current.getByLabel("保留的任务草稿", { exact: true }).inputValue(), "尚未提交的修改");
    await current.keyboard.press("ArrowLeft");
    assert.equal(await tabs.getByRole("tab", { name: "成果", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await current.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  } finally { await current.close(); }
});

test("团队模板必须显式选择，可用性变化与请求锁定不替用户改选", async () => {
  const current = await page("selector");
  try {
    assert.equal(await current.getByRole("radio", { name: "单 Agent", exact: true }).isChecked(), true);
    assert.equal(await current.getByLabel("选择次数").textContent(), "0");
    assert.equal(await current.getByRole("radio", { name: "代码交付", exact: true }).isDisabled(), true);
    await current.getByText("请先登记代码仓库", { exact: true }).waitFor();
    await current.getByRole("radio", { name: "研究汇总", exact: true }).check();
    assert.equal(await current.getByLabel("当前策略").textContent(), "research-summary");
    await current.getByRole("button", { name: "撤销可用性", exact: true }).click();
    assert.equal(await current.getByRole("radio", { name: "研究汇总", exact: true }).isChecked(), true);
    assert.equal(await current.getByRole("radio", { name: "研究汇总", exact: true }).isDisabled(), true);
    assert.equal(await current.getByLabel("选择次数").textContent(), "1");
    await current.getByText("当前模型连接不可用", { exact: true }).waitFor();
    await current.getByRole("radio", { name: "经营方案", exact: true }).check();
    await current.getByRole("button", { name: "锁定请求", exact: true }).click();
    for (const radio of await current.getByRole("radio").all()) assert.equal(await radio.isDisabled(), true);
    assert.equal(await current.getByLabel("当前策略").textContent(), "business-proposal");
    assert.equal(await current.getByLabel("选择次数").textContent(), "2");
  } finally { await current.close(); }
});

test("委派默认单 Agent，明确选择团队后固定模板、模型及未知请求身份", async () => {
  const current = await page("composer");
  try {
    const composer = current.getByRole("form", { name: "委派新任务" });
    assert.equal(await composer.getByRole("radio", { name: "单 Agent", exact: true }).isChecked(), true);
    await composer.getByLabel("任务目标", { exact: true }).fill("核对资料形成报告");
    await composer.getByLabel("验收要求", { exact: true }).fill("结论带来源");
    await composer.getByRole("radio", { name: "研究汇总", exact: true }).check();
    await composer.getByLabel("团队执行模型", { exact: true }).selectOption("model-1");
    assert.equal(await composer.getByLabel("任务执行者", { exact: true }).count(), 0);
    await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
    await composer.getByRole("button", { name: "继续准备", exact: true }).waitFor();
    assert.equal(await composer.getByLabel("任务目标", { exact: true }).isDisabled(), true);
    assert.equal(await composer.getByRole("radio", { name: "单 Agent", exact: true }).isDisabled(), true);
    await composer.getByRole("button", { name: "继续准备", exact: true }).click();
    await current.getByText("已打开待审阅计划", { exact: true }).waitFor();
    const calls = await current.evaluate(() => window.composerCalls);
    assert.equal(calls.filter(call => call.method === "goal").length, 1);
    assert.equal(calls.filter(call => call.method === "single").length, 0);
    const team = calls.filter(call => call.method === "team");
    assert.equal(team.length, 2); assert.deepEqual(team[0], team[1]);
    assert.deepEqual(team[0].input, { templateId: "research-summary", templateVersion: "1", modelBindingId: "model-1" });
  } finally { await current.close(); }
});


test("团队详情显示四视图及 Host 允许操作，未知操作固定身份并锁定新操作", async () => {
  const current = await page("goals");
  try {
    await current.getByRole("tab", { name: "进展", exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await current.getByRole("tab").count(), 4);
    await current.getByRole("tabpanel", { name: "进展", exact: true }).waitFor();
    await current.getByText("等待人工决定", { exact: true }).waitFor();
    await current.getByText("CNY 费用待核对", { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await current.getByRole("button", { name: "取消", exact: true }).count(), 0);
    await current.getByRole("button", { name: "暂停", exact: true }).click();
    await current.getByRole("button", { name: "重试上次操作", exact: true }).waitFor();
    assert.equal(await current.getByRole("button", { name: "暂停", exact: true }).isDisabled(), true);
    assert.equal(await current.getByRole("button", { name: "确认并继续", exact: true }).isDisabled(), true);
    await current.getByRole("button", { name: "重试上次操作", exact: true }).click();
    await current.getByRole("button", { name: "恢复", exact: true }).waitFor();
    const calls = await current.evaluate(() => window.goalCalls);
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.ok(calls[0].key);
    assert.equal(await current.getByRole("button", { name: "确认并继续", exact: true }).count(), 0);
    await current.getByRole("tab", { name: "计划", exact: true }).click();
    await current.getByRole("region", { name: "执行计划", exact: true }).waitFor();
  } finally { await current.close(); }
});

test("人工决定只对 Host 标记的等待节点提交选择", async () => {
  const current = await page("goals");
  try {
    await current.getByRole("button", { name: "确认并继续", exact: true }).waitFor({ timeout: 3000 });
    await current.getByRole("button", { name: "确认并继续", exact: true }).click();
    await current.waitForFunction(() => window.goalCalls.length === 1);
    const [call] = await current.evaluate(() => window.goalCalls);
    assert.equal(call.nodeId, "confirm"); assert.equal(call.decision, "continue"); assert.equal(call.version, 3); assert.ok(call.key);
  } finally { await current.close(); }
});


test("未知操作重试遇到撤权仍保留原请求，不能改为新操作", async () => {
  const current = await page("goals&retryDenied=1");
  try {
    await current.getByRole("button", { name: "暂停", exact: true }).click();
    await current.getByRole("button", { name: "重试上次操作", exact: true }).click();
    await current.getByRole("alert").filter({ hasText: "当前授权已撤销" }).waitFor();
    await current.getByRole("button", { name: "重试上次操作", exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await current.getByRole("button", { name: "暂停", exact: true }).isDisabled(), true);
    await current.getByRole("button", { name: "重试上次操作", exact: true }).click();
    await current.getByRole("button", { name: "恢复", exact: true }).waitFor();
    const calls = await current.evaluate(() => window.goalCalls);
    assert.equal(calls.length, 3); assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[1], calls[2]);
  } finally { await current.close(); }
});


test("切换目标后旧节点响应不能恢复其他团队的可用操作", async () => {
  const current = await page("goals&race=1");
  try {
    await current.getByText("正在核对步骤进展与可用操作…", { exact: true }).waitFor();
    await current.getByRole("button", { name: "切换团队目标", exact: true }).click();
    await current.getByRole("button", { name: "恢复", exact: true }).waitFor();
    await current.evaluate(() => window.releaseOldProgress());
    await current.waitForTimeout(100);
    assert.equal(await current.getByRole("button", { name: "暂停", exact: true }).count(), 0);
    assert.equal(await current.getByRole("button", { name: "恢复", exact: true }).count(), 1);
  } finally { await current.close(); }
});

test("撤权事件使在途团队节点响应失效", async () => {
  const current = await page("goals&race=1");
  try {
    await current.getByText("正在核对步骤进展与可用操作…", { exact: true }).waitFor();
    await current.evaluate(() => window.revoke());
    await current.getByRole("alert").filter({ hasText: "资料已撤权" }).waitFor();
    await current.evaluate(() => window.releaseOldProgress());
    await current.waitForTimeout(100);
    assert.equal(await current.getByRole("button", { name: "暂停", exact: true }).count(), 0);
    assert.equal(await current.getByRole("button", { name: "确认并继续", exact: true }).count(), 0);
  } finally { await current.close(); }
});


test("不同目标独立保留未知操作，导航后可控制其他团队", async () => {
  const current = await page("goals");
  try {
    await current.getByRole("button", { name: "暂停", exact: true }).click();
    await current.getByRole("button", { name: "重试上次操作", exact: true }).waitFor();
    await current.getByRole("button", { name: "切换团队目标", exact: true }).click();
    await current.getByRole("button", { name: "恢复", exact: true }).click();
    await current.waitForFunction(() => window.goalCalls.length === 2, undefined, { timeout: 2000 });
    await current.getByRole("button", { name: "返回原团队目标", exact: true }).click();
    await current.getByRole("button", { name: "重试上次操作", exact: true }).click();
    await current.waitForFunction(() => window.goalCalls.length === 3);
    const calls = await current.evaluate(() => window.goalCalls);
    assert.deepEqual(calls[0], calls[2]); assert.equal(calls[1].goalId, "goal-2"); assert.notEqual(calls[0].key, calls[1].key);
  } finally { await current.close(); }
});
