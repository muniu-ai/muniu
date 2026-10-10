// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";

let browser, server, address;
before(async () => {
  const bundled = await build({ entryPoints: [new URL("../fixtures/goal-sources.tsx", import.meta.url).pathname], bundle: true,
    platform: "browser", format: "esm", jsx: "automatic", write: false, outfile: "goal-sources.js" });
  const files = new Map(bundled.outputFiles.map(file => [file.path.endsWith(".css") ? "/app.css" : "/app.js", file.text]));
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : request.url === "/app.css" ? "text/css" : "text/html");
    response.end(files.get(request.url) ?? '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "资料视图测试需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function page() {
  const current = await browser.newPage();
  const now = new Date("2026-10-10T00:00:00Z");
  await current.clock.install({ time: now }); await current.clock.pauseAt(now);
  await current.goto(address);
  await current.getByRole("button", { name: "查看摘录：来源.md", exact: true }).waitFor();
  return current;
}

test("连续工作区事件不会延后资料撤权清理与重新核验", async () => {
  const current = await page();
  try {
    await current.getByRole("button", { name: "查看摘录：来源.md", exact: true }).click();
    await current.getByText("仅限获准期间读取的正文", { exact: true }).waitFor();
    await current.evaluate(() => window.sourcesDriver.revoke());
    for (let i = 0; i < 6; i++) { await current.clock.runFor(50); await current.evaluate(() => window.sourcesDriver.event()); }
    assert.equal(await current.locator(".goal-preview").count(), 0, "持续事件中仍须清除撤权正文");
    assert.ok(await current.evaluate(() => window.sourcesDriver.extractions) >= 2, "应合并刷新，不能无限延后首次核验");
  } finally { await current.close(); }
});

test("撤权事件立即使在途提取响应失效", async () => {
  const current = await page();
  try {
    await current.evaluate(() => window.sourcesDriver.delayExtraction()); await current.clock.runFor(150);
    assert.equal(await current.evaluate(() => window.sourcesDriver.extractions), 2);
    await current.evaluate(() => { window.sourcesDriver.revoke(); window.sourcesDriver.releaseExtraction(); });
    await current.clock.runFor(1);
    assert.equal(await current.getByText("来源.md", { exact: true }).count(), 0, "撤权前开始的响应不得恢复可读资料");
  } finally { await current.close(); }
});

test("撤权事件立即丢弃在途原文下载，不能创建下载链接", async () => {
  const current = await page();
  try {
    await current.evaluate(() => window.sourcesDriver.delayDownload());
    await current.getByRole("button", { name: "下载原文：来源.md", exact: true }).click();
    assert.equal(await current.evaluate(() => window.sourcesDriver.downloads), 1);
    await current.evaluate(() => { window.sourcesDriver.revoke(); window.sourcesDriver.releaseDownload(); });
    await current.clock.runFor(1);
    assert.equal(await current.evaluate(() => window.sourcesDriver.emittedDownloads), 0, "撤权前开始的下载不得在撤权后发布");
  } finally { await current.close(); }
});
