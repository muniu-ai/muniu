import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { businessDateAt } from "../../../packages/contracts/dist/index.js";

const mode = process.argv[2] ?? "onboarding";
if (!new Set(["onboarding", "opc", "coding", "goals", "teams", "business", "startup", "repositories", "tasks", "refresh"]).has(mode)) throw new Error(`未知验证模式：${mode}`);
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
let page;

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
  if (!["onboarding", "business"].includes(mode)) {
    await context.addInitScript(() => localStorage.setItem("muniu:v2:onboarding-complete", "1"));
  }
  page = await context.newPage();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== apiUrl || ["HEAD", "OPTIONS"].includes(request.method())) return;
    let body = {};
    try { body = request.postDataJSON(); } catch { /* 请求体不是 JSON */ }
    requests.push({ method: request.method(), path: url.pathname, search: url.search, body, key: request.headers()["idempotency-key"] });
  });
  page.setDefaultTimeout(12_000);
  if (mode === "startup") await verifyStartup(page, requests);
  else await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  if (mode === "onboarding") await verifyOnboarding(page, requests);
  if (mode === "opc") await verifyOpc(page, requests, apiUrl);
  if (mode === "coding") await verifyCoding(page, requests);
  if (mode === "repositories") await verifyRepositories(page, requests);
  if (mode === "goals") await verifyGoals(page, requests);
  if (mode === "teams") await verifyTeams(page, requests);
  if (mode === "tasks") await verifyTasks(page, requests);
  if (mode === "business") await verifyBusiness(page, requests);
  if (mode === "refresh") await verifyRefresh(page);
  await page.getByTitle("技术配置").click();
  if (!await page.getByRole("button", { name: "设置", exact: true }).isVisible()) await page.getByTitle("技术配置").click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await verifyConnectivitySettings(page, requests);
  await page.getByRole("region", { name: "插件管理" }).waitFor({ state: "visible" });
  const manager = page.getByRole("region", { name: "插件管理" });
  const install = manager.getByRole("button", { name: "安装", exact: true });
  await install.waitFor({ state: "visible" });
  if (await install.isEnabled()) throw new Error("插件未确认宿主权限时不得安装");
  await manager.getByRole("checkbox").check();
  await install.click();
  const research = manager.locator("div").filter({ has: page.getByText("research · 1.0.0", { exact: true }) }).last();
  await research.getByRole("button", { name: "在此工作区启用" }).click();
  await page.getByRole("button", { name: "研究助手", exact: true }).click();
  await page.getByRole("heading", { name: "研究工作台" }).waitFor({ state: "visible" });
  await page.getByLabel("研究主题").fill("插件跨入口验证");
  await page.getByRole("button", { name: "生成研究结果", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "研究结果：插件跨入口验证" }).waitFor({ state: "visible" });

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
  await page.keyboard.press("ArrowDown");
  await page.getByRole("dialog", { name: "命令中心" }).getByRole("option", { selected: true }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "命令中心" }).waitFor({ state: "hidden" });
  console.log(JSON.stringify({ ok: true, mode, screenshotPath, requestCount: requests.length }));
} catch (error) {
  if (page && process.env.MN_DESKTOP_E2E_KEEP_TEMP === "1") {
    await page.screenshot({ path: screenshotPath, timeout: 5000 }).catch(() => undefined);
    process.stderr.write(`桌面验证失败截图：${screenshotPath}\n`);
  }
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of children.reverse()) child.kill("SIGTERM");
  if (process.env.MN_DESKTOP_E2E_KEEP_TEMP !== "1") await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifyRepositories(page, requestLog) {
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  const capture = page.getByRole("form", { name: "委派新任务" });
  await capture.getByRole("radio", { name: "研发", exact: true }).check();
  const draft = capture.getByLabel("任务目标", { exact: true });
  await draft.fill("为客户网站补充错误处理");
  const registrations = () => requestLog.filter(entry => entry.method === "POST" && entry.path === "/v2/plugins/coding/repositories");
  await capture.getByRole("button", { name: "登记仓库", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登记仓库", exact: true });
  const path = dialog.getByLabel("仓库绝对路径", { exact: true });
  const submit = dialog.getByRole("button", { name: "登记并选中", exact: true });
  await dialog.waitFor();
  if (await dialog.getByRole("button", { name: "选择文件夹", exact: true }).count()) throw new Error("浏览器不应显示不可用的原生目录选择");
  for (const invalid of ["relative/path", "/", " /// "]) {
    await path.fill(invalid);
    if (await submit.isEnabled()) throw new Error("无效的仓库绝对路径必须阻止提交");
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  if (registrations().length || await draft.inputValue() !== "为客户网站补充错误处理") throw new Error("取消登记不得写入或清空任务");
  if (!await capture.getByRole("button", { name: "登记仓库", exact: true }).evaluate(el => el === document.activeElement)) throw new Error("取消后焦点应返回登记入口");

  await page.evaluate(() => {
    window.__folderResult = null;
    window.__TAURI__ = { core: { invoke: async command => {
      if (command !== "choose_repository_directory") throw new Error("unexpected native command");
      if (window.__folderResult === "error") throw new Error("fixture error");
      return window.__folderResult;
    } } };
  });
  await capture.getByRole("button", { name: "登记仓库", exact: true }).click();
  await path.fill("/workspace/manual");
  const choose = dialog.getByRole("button", { name: "选择文件夹", exact: true });
  await choose.click();
  await choose.waitFor();
  if (await path.inputValue() !== "/workspace/manual") throw new Error("取消目录选择必须保留已填路径");
  await page.evaluate(() => { window.__folderResult = "error"; });
  await choose.click();
  await dialog.getByRole("alert").waitFor();
  if (!await path.isEnabled()) throw new Error("原生选择失败后应允许手动输入");
  const firstPath = "/workspace/客户 网站";
  await page.evaluate(value => { window.__folderResult = value; }, firstPath);
  await choose.click();
  await path.inputValue().then(value => { if (value !== firstPath) throw new Error("未填入目录选择结果"); });
  if (registrations().length) throw new Error("选择目录不得直接登记");
  await page.setViewportSize({ width: 960, height: 640 });
  await assertViewportFit(page);
  await page.screenshot({ path: join(temporaryRoot, "repository-dialog.png") });
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  const choice = capture.getByLabel("任务仓库", { exact: true });
  const firstId = await choice.inputValue();
  if (!firstId || !(await choice.locator("option:checked").textContent()).startsWith("客户 网站") || await draft.inputValue() !== "为客户网站补充错误处理") throw new Error("登记后应选中新仓库并保留任务");

  await capture.getByRole("button", { name: "添加仓库", exact: true }).click();
  await path.fill(`${firstPath}///`);
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  if (registrations().length !== 1 || await choice.inputValue() !== firstId) throw new Error("相同路径应复用已有仓库");

  let dropped = false;
  await page.route(`${apiUrl}/v2/plugins/coding/repositories`, async route => {
    if (route.request().method() !== "POST" || dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    if (!response.ok()) throw new Error("丢失响应场景应先完成真实写入");
    await route.abort("failed");
  });
  await capture.getByRole("button", { name: "添加仓库", exact: true }).click();
  await path.fill("/workspace/second");
  await submit.click();
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await capture.getByRole("button", { name: "添加仓库", exact: true }).click();
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  const attempts = registrations().slice(-2);
  if (attempts.length !== 2 || !attempts[0].key || attempts[0].key !== attempts[1].key) throw new Error("响应丢失重试必须复用幂等键");
  await page.unroute(`${apiUrl}/v2/plugins/coding/repositories`);
  const secondId = await choice.inputValue();
  if (!secondId || secondId === firstId || !(await choice.locator("option:checked").textContent()).startsWith("second")) throw new Error("多个仓库时应选中刚登记的一项");
  await capture.getByLabel("验收要求", { exact: true }).fill("包含错误处理和验证说明");
  await capture.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).waitFor();
  const task = requestLog.find(entry => entry.method === "POST" && entry.path === "/v2/plugins/coding/tasks");
  if (task?.body.repositoryId !== secondId) throw new Error("任务必须绑定新选中的仓库");
  await page.getByRole("button", { name: "Coding", exact: true }).click();
  const list = page.getByRole("region", { name: "Coding 仓库" });
  await list.getByText("second", { exact: true }).waitFor();
  if (await list.getByText("second", { exact: true }).count() !== 1) throw new Error("重试产生了重复仓库");
  await list.getByRole("button", { name: "添加仓库", exact: true }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await assertViewportFit(page);
  await page.screenshot({ path: join(temporaryRoot, "repository-capture.png") });
  await page.setViewportSize({ width: 1180, height: 760 });
}

async function verifyStartup(page, requestLog) {
  const workspacesUrl = `${apiUrl}/v2/workspaces`;
  await page.addInitScript(() => {
    window.__startupSignals = [];
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/v2/workspaces")) window.__startupSignals.push(init?.signal);
      return originalFetch(input, init);
    };
  });
  let attempts = 0;
  const unavailable = { code: "HOST_STARTING", message: "后台服务正在启动", action: "稍后重试", fieldIssues: [], traceId: "startup-fixture", retryable: true };
  await page.route(workspacesUrl, route => {
    attempts += 1;
    if (attempts === 1) return route.abort("connectionrefused");
    if (attempts < 4) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(unavailable) });
    return route.continue();
  });
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "经营管理", exact: true }).waitFor({ timeout: 6000 });
  if (attempts < 4 || attempts > 6) throw new Error(`启动重试次数异常：${attempts}`);
  if (requestLog.some(entry => entry.method === "POST")) throw new Error("启动重试不得重复写入操作");
  if (!await page.evaluate(() => window.__startupSignals.some(signal => signal?.aborted))) throw new Error("卸载启动 effect 时未取消读取请求");
  await page.unroute(workspacesUrl);

  for (const [status, message, body] of [
    [401, "工作区凭据已失效", { ...unavailable, message: "工作区凭据已失效" }],
    [403, "没有权限读取工作区", { ...unavailable, message: "没有权限读取工作区" }],
    [200, "Host 响应不符合公共契约", { data: { invalid: true } }],
  ]) {
    let rejected = 0;
    await page.route(workspacesUrl, route => { rejected += 1; return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("alert").getByText(message, { exact: false }).waitFor();
    const stoppedAt = rejected;
    await page.waitForTimeout(750);
    if (rejected !== stoppedAt) throw new Error(`启动时不得自动重试 ${status} 错误`);
    await page.unroute(workspacesUrl);
    await page.getByRole("alert").getByRole("button", { name: "重试", exact: true }).click();
    await page.getByRole("heading", { name: "经营管理", exact: true }).waitFor();
  }

  let unavailableAttempts = 0;
  await page.route(workspacesUrl, route => { unavailableAttempts += 1; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(unavailable) }); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("alert").waitFor({ timeout: 16000 });
  const stoppedAt = unavailableAttempts;
  await page.waitForTimeout(1000);
  if (unavailableAttempts !== stoppedAt || stoppedAt > 7) throw new Error("后台服务持续不可用时启动重试必须有界");
  await page.unroute(workspacesUrl);
  await page.getByRole("alert").getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("heading", { name: "经营管理", exact: true }).waitFor();

  const hangingRequests = [];
  await page.route(workspacesUrl, route => { hangingRequests.push(route); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("alert").getByText("木牛后台服务响应超时", { exact: false }).waitFor({ timeout: 18000 });
  if (hangingRequests.length > 2) throw new Error("网络悬挂时不得叠加未取消的启动请求");
  await page.unroute(workspacesUrl);
  await Promise.all(hangingRequests.map(route => route.abort().catch(() => undefined)));
  await page.getByRole("alert").getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("heading", { name: "经营管理", exact: true }).waitFor();
}

async function verifyBusiness(page, requestLog) {
  await page.getByRole("button", { name: "继续" }).click();
  await expectText(page, "OPC 经营管理");
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByLabel("工作区名称").fill("设计经营工作室");
  await page.getByLabel("已有客户", { exact: true }).check();
  await page.getByRole("button", { name: /进入工作台/ }).click();
  await page.getByRole("heading", { name: "经营管理", exact: true }).waitFor();
  if (requestLog.some(entry => entry.method === "POST" && ["/v2/model-connections", "/v2/plugins/opc/opportunities"].includes(entry.path))) {
    throw new Error("手工经营入门不得强制连接模型或创建机会");
  }
  const today = businessDateAt(new Date().toISOString());
  const monthStart = `${today.slice(0, 7)}-01`;
  const historicalDate = new Date(`${monthStart}T00:00:00.000Z`);
  historicalDate.setUTCDate(0);
  const previous = historicalDate.toISOString().slice(0, 10);
  const navigate = name => page.getByRole("navigation", { name: "经营模块" }).getByRole("button", { name, exact: true }).click();
  async function form(trigger, title, fields = {}, selections = {}, checks = [], loseResponse = false) {
    await page.getByRole("button", { name: trigger, exact: true }).first().click();
    const editor = page.getByRole("form", { name: title, exact: true });
    for (const [name, value] of Object.entries(fields)) await editor.locator(`[name="${name}"]`).fill(value);
    for (const [name, value] of Object.entries(selections)) await editor.locator(`select[name="${name}"]`).selectOption(value);
    for (const name of checks) await editor.locator(`input[name="${name}"]`).check();
    let originalRequest;
    if (loseResponse) {
      let committed;
      await page.route(`${apiUrl}/v2/plugins/opc/business/commands`, async route => {
        if (originalRequest) return route.continue();
        originalRequest = { key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() };
        const response = await route.fetch();
        if (!response.ok()) throw new Error(`${title}模拟丢失响应前未成功保存`);
        committed = (await response.json()).data;
        await route.abort("failed");
      });
      const observed = page.waitForResponse(async response => new URL(response.url()).pathname === "/v2/plugins/opc/business" && response.ok() && committed && (await response.json()).data.state.streamVersion >= committed.state.streamVersion);
      await editor.getByRole("button", { name: title, exact: true }).click();
      await page.getByRole("alert").waitFor();
      await observed;
      await page.getByRole("alert").waitFor();
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/v2/plugins/opc/business" && response.ok());
      await page.getByRole("alert").getByRole("button", { name: "重试", exact: true }).click();
      await (await refreshed).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (!await page.getByRole("alert").isVisible()) throw new Error("读取成功不得清除尚未确认的保存错误");
    }
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/v2/plugins/opc/business/commands" && response.request().method() === "POST");
    await editor.getByRole("button", { name: title, exact: true }).click();
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`${title}失败：HTTP ${response.status()} ${JSON.stringify(await response.json())}`);
    if (originalRequest && (response.request().headers()["idempotency-key"] !== originalRequest.key || JSON.stringify(response.request().postDataJSON()) !== JSON.stringify(originalRequest.body))) throw new Error(`${title}丢失响应后必须重放原请求`);
    const result = (await response.json()).data;
    await editor.waitFor({ state: "hidden" });
    if (loseResponse) await page.unroute(`${apiUrl}/v2/plugins/opc/business/commands`);
    return result;
  }
  await navigate("经营计划");
  await form("新增经营计划", "保存经营计划", { title: "十月设计经营", start: monthStart, end: today, targetCustomer: "独立顾问", valueProposition: "交付可直接使用的品牌设计", focus: "完成两笔订单\n核对收支", resources: "每周四十小时", reviewOn: today });
  await navigate("客户");
  await page.getByRole("button", { name: "新增客户", exact: true }).click();
  const customerEditor = page.getByRole("form", { name: "保存客户", exact: true });
  for (const [name, value] of Object.entries({ name: "青禾顾问", source: "客户转介绍", need: "品牌设计", contact: "fixture-contact", followUpOn: today })) await customerEditor.locator(`[name="${name}"]`).fill(value);
  const commandUrl = `${apiUrl}/v2/plugins/opc/business/commands`;
  let droppedCustomerRequest;
  let committedCustomer;
  await page.route(commandUrl, async route => {
    if (route.request().postDataJSON()?.command?.type !== "customer.record" || droppedCustomerRequest) return route.continue();
    droppedCustomerRequest = { key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() };
    const response = await route.fetch();
    if (!response.ok()) throw new Error("模拟丢失响应前，客户必须已由真实 Host 保存");
    committedCustomer = (await response.json()).data;
    await route.abort("failed");
  });
  const observedCommittedVersion = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== "/v2/plugins/opc/business" || !response.ok() || !committedCustomer) return false;
    return (await response.json()).data.state.streamVersion >= committedCustomer.state.streamVersion;
  });
  await customerEditor.getByRole("button", { name: "保存客户", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await observedCommittedVersion;
  const replayPromise = page.waitForResponse(response => new URL(response.url()).pathname === "/v2/plugins/opc/business/commands" && response.request().method() === "POST");
  await customerEditor.getByRole("button", { name: "保存客户", exact: true }).click();
  const replay = await replayPromise;
  let result = (await replay.json()).data;
  if (!replay.ok() || result.state.customers.length !== 1 || replay.request().headers()["idempotency-key"] !== droppedCustomerRequest.key || replay.request().postDataJSON().expectedStreamVersion !== droppedCustomerRequest.body.expectedStreamVersion) throw new Error("响应丢失后重试必须复用提交身份及原版本，不得追加客户修订");
  await customerEditor.waitFor({ state: "hidden" });
  await page.unroute(commandUrl);
  const customerId = result.state.customers[0].id;
  await page.getByRole("button", { name: "更新客户", exact: true }).click();
  const staleEditor = page.getByRole("form", { name: "保存客户", exact: true });
  const observedExternalRevision = page.waitForResponse(async response => new URL(response.url()).pathname === "/v2/plugins/opc/business" && response.ok() && (await response.json()).data.state.customers.length === 2);
  void observedExternalRevision.catch(() => undefined);
  const externalUpdate = await fetch(commandUrl, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ workspaceId: result.state.workspaceId, expectedStreamVersion: result.state.streamVersion, command: { type: "customer.record", customerId, name: "青禾顾问", source: "客户转介绍", need: "客户刚确认的新需求", contact: "fixture-contact", followUpOn: today } }) });
  if (!externalUpdate.ok) throw new Error(`并发客户更新未保存成功：${externalUpdate.status} ${JSON.stringify(await externalUpdate.json())}`);
  await observedExternalRevision;
  const staleSave = page.waitForResponse(response => new URL(response.url()).pathname === "/v2/plugins/opc/business/commands" && response.request().method() === "POST");
  await staleEditor.getByRole("button", { name: "保存客户", exact: true }).click();
  if ((await staleSave).status() !== 409) throw new Error("表单打开后发生并发更新，旧内容保存必须报告版本冲突");
  await staleEditor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "更新客户", exact: true }).click();
  if (await page.getByRole("form", { name: "保存客户", exact: true }).locator('[name="need"]').inputValue() !== "客户刚确认的新需求") throw new Error("版本冲突后重开表单必须显示最新客户内容");
  await page.getByRole("form", { name: "保存客户", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  await navigate("产品与服务");
  result = await form("新增产品或服务", "发布产品版本", { title: "品牌设计服务", price: "1000.00", inScope: "标志与使用说明", outOfScope: "印刷制作", acceptanceCriteria: "客户确认最终设计" });
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: /搜索命令/ }).click();
  const customerPalette = page.getByRole("dialog", { name: "命令中心" });
  await customerPalette.getByRole("textbox").fill("客户刚确认的新需求");
  await customerPalette.getByRole("option").filter({ hasText: "青禾顾问" }).click();
  await page.locator(`[data-business-resource="${customerId}"]`).getByText("客户刚确认的新需求", { exact: true }).waitFor();
  await navigate("产品与服务");
  const product = result.state.services[0];
  const service = JSON.stringify([product.id, product.version]);
  await navigate("报价与订单");
  result = await form("新增报价", "生成报价", { quantity: "1", discount: "0", validUntil: today, dueOn: today }, { customerId, service });
  const quoteId = result.state.quotes[0].id;
  result = await form("登记客户确认", "登记客户接受报价", { confirmedOn: today, sourceRef: "客户确认邮件 fixture-quote" }, { quoteId });
  if (result.state.orders.length !== 0 || result.state.quoteConfirmations.length !== 1) throw new Error("客户接受报价必须单独记录，不能自动使订单生效");
  result = await form("登记订单生效", "登记订单生效", { contractedOn: today, sourceRef: "订单合同 fixture-order" }, { quoteConfirmationId: result.state.quoteConfirmations[0].id });
  const orderId = result.state.orders[0].id;
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: /搜索命令/ }).click();
  const orderPalette = page.getByRole("dialog", { name: "命令中心" });
  await orderPalette.getByRole("textbox").fill(orderId);
  await orderPalette.getByRole("option").filter({ hasText: "品牌设计服务" }).click();
  await page.locator(".business-order-detail").getByRole("heading", { name: "青禾顾问 · 品牌设计服务", exact: true }).waitFor();
  await navigate("交付与验收");
  result = await form("记录交付", "记录交付", { title: "完整品牌设计", deliveredOn: today, progressPercent: "100", artifactRef: "设计附件 fixture-artifact" }, { orderId });
  await form("登记客户验收", "登记客户验收", { acceptedOn: today, customerConfirmationRef: "客户验收邮件 fixture-acceptance" }, { orderId }, ["deliveryIds", "complete"]);
  await navigate("收支记录");
  result = await form("登记收款", "登记收款", { amount: "1000", receivedOn: today, sourceRef: "收款凭证 fixture-original" }, { orderId });
  result = await form("冲销错误记录", "冲销错误收款", { reversedOn: today, reason: "原凭证登记错误", sourceRef: "纠错依据 fixture-reversal" }, { paymentId: result.state.payments[0].id }, [], true);
  if (result.state.paymentReversals.length !== 1) throw new Error("冲销重试不得重复记录资金纠错");
  result = await form("登记收款", "登记收款", { amount: "1000", receivedOn: today, sourceRef: "收款凭证 fixture-corrected" }, { orderId });
  const paymentId = result.state.payments.at(-1).id;
  await form("登记费用", "登记费用", { category: "外包成本", description: "图形协作", amount: "100", paidOn: today, sourceRef: "支出凭证 fixture-expense" }, { orderId });
  await form("登记退款", "登记退款", { amount: "100", refundedOn: today, reason: "范围调整退还差额", sourceRef: "退款凭证 fixture-refund" }, { refundSource: JSON.stringify(["payment", paymentId]) });
  await navigate("报价与订单");
  if (!await page.getByRole("button", { name: "调整订单金额或期限", exact: true }).isVisible()) await page.getByRole("button", { name: "查看订单详情", exact: true }).click();
  await form("调整订单金额或期限", "记录订单调整", { amountDelta: "-100", effectiveOn: today, reason: "双方确认减少范围", sourceRef: "变更确认 fixture-adjustment" }, { orderId });
  result = await form("登记已有订单", "登记已有订单", { quantity: "1", agreedAmount: "1000", contractedOn: `${previous.slice(0, 7)}-01`, dueOn: today, sourceRef: "原合同 fixture-contract", asOf: previous, openingReceived: "400", openingDelivered: "50", openingSourceRef: "期初凭证 fixture-opening" }, { customerId, service });
  const oldOrderId = result.state.orders.at(-1).id;
  await expectText(page, "历史已收 ¥400.00，已交付 50%");
  await page.getByText(/历史已收 ¥400.00，已交付 50%/u).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(temporaryRoot, "business-existing-order.png"), fullPage: true });
  await navigate("交付与验收");
  await form("记录交付", "记录交付", { title: "已有订单剩余设计", deliveredOn: today, progressPercent: "50", artifactRef: "补充交付 fixture-remaining" }, { orderId: oldOrderId });
  await form("登记客户验收", "登记客户验收", { acceptedOn: today, customerConfirmationRef: "旧单验收 fixture-old-acceptance" }, { orderId: oldOrderId }, ["deliveryIds", "complete"]);
  await navigate("收支记录");
  await form("登记收款", "登记收款", { amount: "600", receivedOn: today, sourceRef: "尾款凭证 fixture-tail" }, { orderId: oldOrderId });
  await navigate("周期复盘");
  result = await form("新增周期复盘", "保存周期复盘", { start: monthStart, end: today, explanation: "两笔订单已验收，核对本期收支和历史已收", nextDecisions: "保留服务范围\n下期跟进客户" });
  const snapshot = result.state.reviews.at(-1).summary;
  for (const [key, expected] of Object.entries({ cashReceivedMinor: "160000", cashRefundedMinor: "10000", cashExpensesMinor: "10000", netCashFlowMinor: "140000", outstandingMinor: "0" })) {
    if (snapshot[key] !== expected) throw new Error(`经营复盘 ${key} 应为 ${expected}，实际 ${snapshot[key]}`);
  }
  if (snapshot.orders.some(order => !order.accepted || order.deliveredPercent !== 100)) throw new Error("两个订单均应完成交付及客户验收");
  await expectText(page, "¥1400.00");
  await page.getByText("两笔订单已验收，核对本期收支和历史已收", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(temporaryRoot, "business-review.png"), fullPage: true });
  await page.reload();
  await page.getByRole("heading", { name: "经营管理", exact: true }).waitFor();
  await navigate("周期复盘");
  await expectText(page, "两笔订单已验收，核对本期收支和历史已收");
  await expectText(page, "¥1400.00");
  await navigate("经营总览");
  historicalDate.setUTCDate(historicalDate.getUTCDate() - 1);
  await page.getByLabel("统计开始", { exact: true }).fill(`${previous.slice(0, 7)}-01`);
  await page.getByLabel("统计截止", { exact: true }).fill(historicalDate.toISOString().slice(0, 10));
  await page.getByRole("alert").waitFor();
  if (!await page.getByLabel("统计截止", { exact: true }).isVisible()) throw new Error("查询失败后必须能纠正统计期间");
  await page.getByRole("button", { name: "恢复本月", exact: true }).click();
  await expectText(page, "¥1400.00");
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await page.screenshot({ path: join(temporaryRoot, "business-overview.png"), fullPage: true });
  await page.setViewportSize({ width: 960, height: 640 });
  await assertViewportFit(page);
  await page.setViewportSize({ width: 1180, height: 760 });
}

async function verifyConnectivitySettings(page, requestLog) {
  const connections = page.getByRole("region", { name: "模型连接管理" });
  await connections.waitFor({ state: "visible" });
  const provider = connections.getByLabel("模型厂商", { exact: true });
  await provider.locator('option[value="moonshot"]').waitFor({ state: "attached" });
  await provider.locator('option[value="qwen"]').waitFor({ state: "attached" });
  if (mode === "onboarding") {
    for (const presetId of ["moonshot", "qwen"]) {
      await provider.selectOption(presetId);
      await connections.getByLabel("新模型密钥", { exact: true }).fill("ui-fixture-model-key");
      const probeResponse = page.waitForResponse(response => /\/v2\/model-connections\/[^/]+\/probe$/.test(new URL(response.url()).pathname));
      await connections.getByRole("button", { name: "保存并用于新任务", exact: true }).click();
      const response = await probeResponse;
      if (!response.ok()) throw new Error(`${presetId} 连接未通过真实 Host fixture`);
      await connections.getByRole("status").filter({ hasText: "模型已连接" }).waitFor();
    }
    const beforeModels = await hostData(apiUrl, "/v2/model-connections");
    const qwen = beforeModels.find(connection => connection.presetId === "qwen");
    const nextModel = qwen?.modelOptions.find(option => option.selectable && option.modelName !== qwen.defaultModel)?.modelName;
    if (!qwen || !nextModel) throw new Error("Qwen fixture 缺少可选择模型");
    const qwenCard = connections.getByRole("article", { name: `${qwen.displayName} 模型连接`, exact: true });
    await qwenCard.getByLabel("为新任务选择模型", { exact: true }).selectOption(nextModel);
    await qwenCard.getByRole("button", { name: "用于新任务", exact: true }).click();
    await connections.getByRole("status").filter({ hasText: "已为新任务创建所选模型连接" }).waitFor();
    const afterModels = await hostData(apiUrl, "/v2/model-connections");
    const preserved = afterModels.find(connection => connection.id === qwen.id);
    if (preserved?.defaultModel !== qwen.defaultModel || preserved.streamVersion !== qwen.streamVersion) throw new Error("切换模型改写了旧连接或授权版本");
    if (!afterModels.some(connection => connection.id !== qwen.id && connection.defaultModel === nextModel && connection.defaultForNewExecutions)) {
      throw new Error("所选 Qwen 模型未成为新任务默认连接");
    }
    const defaultResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/v2/model-connections/${qwen.id}/model`);
    await qwenCard.getByRole("button", { name: "设为默认连接", exact: true }).click();
    if (!(await defaultResponse).ok()) throw new Error("将现有模型用于新任务未通过新连接接口");
    await connections.getByRole("status").filter({ hasText: "已为新任务创建所选模型连接" }).waitFor();
    const defaults = await hostData(apiUrl, "/v2/model-connections");
    if (defaults.find(connection => connection.id === qwen.id)?.streamVersion !== qwen.streamVersion
      || !defaults.some(connection => connection.id !== qwen.id && connection.defaultModel === qwen.defaultModel && connection.defaultForNewExecutions)) {
      throw new Error("设为默认连接必须保留原连接并为新任务创建绑定");
    }
    if (await connections.getByLabel("新模型密钥", { exact: true }).inputValue()) throw new Error("连接成功后密钥仍在输入框中");
    const localValues = await page.evaluate(() => JSON.stringify(localStorage));
    if (localValues.includes("ui-fixture-model-key")) throw new Error("模型密钥被写入浏览器存储");
  }
  const readiness = page.getByRole("region", { name: "外部 Agent 调度检查" });
  await readiness.waitFor({ state: "visible" });
  await readiness.getByRole("heading", { name: "Codex CLI", exact: true }).waitFor();
  await readiness.getByRole("heading", { name: "Claude Code", exact: true }).waitFor();
  const codexReadiness = readiness.getByRole("region", { name: "Codex CLI 接入状态", exact: true });
  await codexReadiness.getByText("查看检查项与处理步骤", { exact: true }).click();
  await codexReadiness.getByText("CLI 登录态、模型权限与额度未验证", { exact: true }).waitFor();
  await codexReadiness.getByText("执行服务", { exact: true }).waitFor();
  await codexReadiness.getByText("隔离环境", { exact: true }).waitFor();
  await codexReadiness.getByText("查看检查项与处理步骤", { exact: true }).click();
  const workbuddy = readiness.getByRole("region", { name: "WorkBuddy 接入状态", exact: true });
  await workbuddy.getByText("尚未接入", { exact: true }).waitFor();
  if (await workbuddy.getByRole("button").count()) throw new Error("未适配的 WorkBuddy 不得提供启用或调度操作");
  if ((await readiness.innerText()).includes("可调度")) throw new Error("未连接隔离 Worker 的 fixture 不得显示外部 Agent 可调度");
  if (!requestLog.some(entry => entry.method === "GET" && /\/workspaces\/[^/]+\/agent-readiness$/.test(entry.path))) {
    throw new Error("Agent 调度检查必须读取 Host 状态");
  }
  const before = requestLog.filter(entry => entry.method === "POST").length;
  const refreshedReadiness = page.waitForResponse(response => /\/workspaces\/[^/]+\/agent-readiness$/.test(new URL(response.url()).pathname));
  await readiness.getByRole("button", { name: "重新检查", exact: true }).click();
  if (!(await refreshedReadiness).ok()) throw new Error("Agent 调度检查刷新失败");
  await readiness.getByRole("button", { name: "重新检查", exact: true }).waitFor({ state: "visible" });
  if (requestLog.filter(entry => entry.method === "POST").length !== before) throw new Error("只读调度检查不得创建执行或调用登录命令");
  await readiness.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(temporaryRoot, "connectivity-settings.png") });
}

async function verifyGoals(page, requestLog) {
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "关联已有任务", exact: true }).click();
  await page.getByLabel("预期结果").waitFor();
  const externalWorkspace = (await hostData(apiUrl, "/v2/workspaces"))[0];
  const externalThreadId = await page.getByLabel("关联任务").inputValue();
  const createExternalGoal = async objective => {
    const response = await fetch(`${apiUrl}/v2/workspaces/${externalWorkspace.id}/goals`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ threadId: externalThreadId, objective, resourceRefs: [],
        budget: { maxTokens: 1000, maxCostMinorUnits: "50", currency: "CNY", maxDurationMs: 60000 },
        deliverables: [{ key: "result", title: "任务成果", required: true, criteria: [{ id: "scope", description: "说明验证范围" }] }] }),
    });
    if (!response.ok) throw new Error("外部目标创建失败");
    return (await response.json()).data;
  };
  let releaseOldList;
  let reportHeldList;
  const heldList = new Promise(resolve => { reportHeldList = resolve; });
  const releasedList = new Promise(resolve => { releaseOldList = resolve; });
  let holdNextList = true;
  const listUrl = `${apiUrl}/v2/workspaces/${externalWorkspace.id}/goals`;
  await page.route(listUrl, async route => {
    if (route.request().method() !== "GET" || !holdNextList) return route.continue();
    holdNextList = false;
    const response = await route.fetch();
    reportHeldList();
    await releasedList;
    await route.fulfill({ response });
  });
  await createExternalGoal("外部入口创建的目标");
  await waitForHeldResponse(heldList);
  await createExternalGoal("随后创建的目标");
  await page.getByRole("button", { name: /随后创建的目标/u }).waitFor();
  const delayedList = page.waitForResponse(response => response.url() === listUrl && response.request().method() === "GET");
  releaseOldList();
  await delayedList;
  await page.waitForTimeout(200);
  if (!await page.getByRole("button", { name: /随后创建的目标/u }).isVisible()) throw new Error("迟到列表响应覆盖了新目标");
  await page.unroute(listUrl);
  await page.getByRole("button", { name: /外部入口创建的目标/u }).waitFor();
  await page.getByLabel("预期结果").fill("整理设计师获客访谈的验证问题");
  await page.getByLabel("验收标准（每行一项）").fill("列出三个验证问题\n区分事实与待验证假设");
  await page.getByRole("button", { name: "创建目标", exact: true }).click();
  await page.getByRole("heading", { name: "整理设计师获客访谈的验证问题", exact: true }).waitFor();
  await page.getByRole("button", { name: "生成计划", exact: true }).click();
  await page.getByText("待确认计划", { exact: true }).waitFor();
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).click();
  await page.getByText("执行中", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page.getByText("已取消", { exact: true }).waitFor();
  const create = requestLog.find(request => request.method === "POST" && /\/workspaces\/[^/]+\/goals$/u.test(request.path));
  if (create?.body?.deliverables?.[0]?.criteria?.length !== 2) throw new Error("目标未保存完整验收标准");
  const start = requestLog.find(request => request.body?.command === "start" && request.path.includes("/goals/"));
  if (!start?.body?.planRevisionId || !start.body.planDigest || !Number.isInteger(start.body.expectedStreamVersion)) throw new Error("目标启动未绑定审阅过的计划和版本");
  const cancel = requestLog.find(request => request.body?.command === "cancel" && request.path.includes("/goals/"));
  if (cancel.body.expectedStreamVersion <= start.body.expectedStreamVersion) throw new Error("目标取消未使用最新版本");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByRole("button", { name: "关联已有任务", exact: true }).click();
  await page.getByLabel("预期结果").fill("验证目标成果验收");
  await page.getByRole("button", { name: "创建目标", exact: true }).click();
  await page.getByRole("heading", { name: "验证目标成果验收", exact: true }).waitFor();
  await page.getByRole("button", { name: "生成计划", exact: true }).click();
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^待验收$/u }).waitFor();
  const acceptance = page.getByRole("region", { name: "成果验收" });
  await acceptance.getByText(/三个验证问题：近期如何获客/u).waitFor();
  const accept = acceptance.getByRole("button", { name: "接收成果", exact: true });
  if (await accept.isEnabled()) throw new Error("未逐条复核标准时不能接收成果");
  await acceptance.getByRole("checkbox").nth(0).check();
  if (await accept.isEnabled()) throw new Error("只复核部分标准时不能接收成果");
  await acceptance.getByRole("checkbox").nth(1).check();
  await accept.click();
  await page.getByRole("status").filter({ hasText: /^已验收$/u }).waitFor();
  const accepted = requestLog.find(request => request.method === "POST" && request.path.endsWith("/acceptances"));
  if (!accepted?.body?.deliverySetId || accepted.body.items?.[0]?.reviewedCriterionIds?.length !== 2 || !accepted.body.items[0].digest) throw new Error("验收未绑定成果版本和完整标准");
  await assertViewportFit(page);
  await page.screenshot({ path: join(temporaryRoot, "goal-detail.png") });
  const workspaceId = accepted.body.workspaceId;
  const goalPath = accepted.path.slice(0, -"/acceptances".length);
  const detail = await hostData(apiUrl, `${goalPath}?workspaceId=${encodeURIComponent(workspaceId)}`);
  let releaseOldResponse;
  let reportHeldResponse;
  const heldResponse = new Promise(resolve => { reportHeldResponse = resolve; });
  const releasedResponse = new Promise(resolve => { releaseOldResponse = resolve; });
  let holdNextRead = true;
  await page.route(`${apiUrl}${goalPath}?workspaceId=*`, async route => {
    if (!holdNextRead) return route.continue();
    holdNextRead = false;
    const response = await route.fetch();
    if (response.status() !== 200) throw new Error("延迟读取未取得变更前的成果");
    reportHeldResponse();
    await releasedResponse;
    await route.fulfill({ response });
  });
  const anotherGoal = await fetch(`${apiUrl}/v2/workspaces/${encodeURIComponent(workspaceId)}/goals`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ threadId: detail.goal.threadId, objective: "触发工作区刷新", resourceRefs: [],
      budget: detail.goal.budget, deliverables: detail.goal.deliverables }),
  });
  if (!anotherGoal.ok) throw new Error("无法触发工作区目标刷新");
  await waitForHeldResponse(heldResponse);
  const source = detail.goal.resourceRefs.find(ref => ref.namespace === "opc.opportunity");
  const changed = await fetch(`${apiUrl}/v2/plugins/opc/opportunities/${source.resourceId}/commands`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ workspaceId, expectedStreamVersion: source.streamVersion, command: "frame", input: {
      targetCustomer: "独立设计师", problem: "来源条件已变化", falsifiableHypothesis: "需要根据新资料重新复核",
    } }),
  });
  if (!changed.ok) throw new Error(`来源变更 fixture 失败：${await changed.text()}`);
  await page.locator(".goal-preview").waitFor({ state: "hidden" });
  await page.getByRole("alert").filter({ hasText: /资料|版本|来源/u }).waitFor();
  const delayedRead = page.waitForResponse(response => response.url().startsWith(`${apiUrl}${goalPath}?`) && response.status() === 200);
  releaseOldResponse();
  await delayedRead;
  await page.waitForTimeout(200);
  if (await page.locator(".goal-preview").isVisible()) throw new Error("来源失效后的迟到响应恢复了成果正文");
  await page.unroute(`${apiUrl}${goalPath}?workspaceId=*`);
  let reportHeldFailure;
  let releaseFailure;
  const heldFailure = new Promise(resolve => { reportHeldFailure = resolve; });
  const releasedFailure = new Promise(resolve => { releaseFailure = resolve; });
  let holdNextFailure = true;
  await page.route(`${apiUrl}${goalPath}?workspaceId=*`, async route => {
    if (!holdNextFailure) return route.continue();
    holdNextFailure = false;
    const response = await route.fetch();
    if (response.ok()) throw new Error("失效来源仍允许读取原目标");
    reportHeldFailure();
    await releasedFailure;
    await route.fulfill({ response });
  });
  const nextGoal = await createExternalGoal("独立切换目标");
  await waitForHeldResponse(heldFailure);
  const nextGoalUrl = `${apiUrl}/v2/goals/${nextGoal.goal.id}?workspaceId=*`;
  let releaseNextGoal;
  let reportNextGoal;
  const heldNextGoal = new Promise(resolve => { reportNextGoal = resolve; });
  const releasedNextGoal = new Promise(resolve => { releaseNextGoal = resolve; });
  await page.route(nextGoalUrl, async route => {
    const response = await route.fetch();
    reportNextGoal();
    await releasedNextGoal;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: /独立切换目标/u }).click();
  await waitForHeldResponse(heldNextGoal);
  const delayedFailure = page.waitForResponse(response => response.url().startsWith(`${apiUrl}${goalPath}?`) && !response.ok());
  releaseFailure();
  await delayedFailure;
  await page.waitForTimeout(100);
  releaseNextGoal();
  await page.getByRole("heading", { name: "独立切换目标", exact: true }).waitFor();
  await page.unroute(nextGoalUrl);
  await page.unroute(`${apiUrl}${goalPath}?workspaceId=*`);
}

async function waitForHeldResponse(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("未收到预期的并发读取响应")), 12000);
    })]);
  } finally { clearTimeout(timer); }
}

async function verifyOnboarding(page, requestLog) {
  await expectText(page, "四步建立你的工作台");
  await expectText(page, "你希望先看到什么");
  await page.getByRole("img", { name: "木牛标志", exact: true }).evaluate(image => image.decode());
  await page.screenshot({ path: join(temporaryRoot, "brand-onboarding.png") });
  await page.getByRole("button", { name: /专业视图/ }).click();
  await page.getByRole("button", { name: /经营视图/ }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await expectText(page, "选择现在要做的事");
  await page.getByRole("button", { name: /Coding/ }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await expectText(page, "选择开始方式");
  await page.getByRole("button", { name: /连接内置模型/ }).click();
  if (!requestLog.some(entry => entry.method === "GET" && entry.path === "/v2/model-connections/presets")) {
    throw new Error("首次设置必须读取 Host 的模型厂商列表");
  }
  const hostPresets = await hostData(apiUrl, "/v2/model-connections/presets");
  for (const preset of hostPresets) {
    await page.getByRole("button", { name: preset.displayName, exact: true }).waitFor({ state: "visible" });
  }
  await page.screenshot({ path: join(temporaryRoot, "model-presets.png") });
  const screenText = await page.locator("body").innerText();
  for (const forbidden of ["Provider ID", "Model ID", "Base URL", "wire format"]) {
    if (screenText.includes(forbidden)) throw new Error(`向导暴露了技术字段：${forbidden}`);
  }
  await page.getByRole("button", { name: /DeepSeek/ }).click();
  await page.getByLabel("API Key").fill("test-key-not-a-secret");
  await page.getByRole("button", { name: "继续" }).click();
  await expectText(page, "创建第一个工作区");
  await page.getByLabel("工作区名称").fill("设计师增长");
  const setupUrl = `${apiUrl}/v2/setup`;
  await page.route(setupUrl, route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({
    code: "INTERNAL_ERROR", message: "服务暂时不可用", action: "稍后重试；若问题持续，请运行 mn doctor",
    fieldIssues: [], traceId: "onboarding-setup-fixture", retryable: true,
  }) }));
  await page.getByRole("button", { name: /进入工作台/ }).click();
  await page.getByRole("alert").getByText("初始化设置未完成", { exact: true }).waitFor();
  await page.getByText("故障详情", { exact: true }).click();
  await expectText(page, "INTERNAL_ERROR");
  await expectText(page, "onboarding-setup-fixture");
  if (await page.evaluate(() => localStorage.getItem("muniu:v2:onboarding-complete")) !== null) {
    throw new Error("初始化失败不得标记向导完成");
  }
  if (requestLog.some(entry => entry.method === "POST" && entry.path === "/v2/model-connections")) {
    throw new Error("初始化失败不得继续创建模型连接");
  }
  await page.unroute(setupUrl);
  const setupResponse = page.waitForResponse(response => response.url() === setupUrl && response.request().method() === "POST");
  await page.getByRole("button", { name: /进入工作台/ }).click();
  const initialized = await setupResponse;
  if (initialized.status() !== 200) throw new Error(`受保护日志中的初始化失败：HTTP ${initialized.status()}`);
  await expectText(page, "设计师增长");
  await page.getByRole("heading", { name: "经营管理", exact: true }).waitFor();
  await page.getByRole("img", { name: "木牛标志", exact: true }).evaluate(image => image.decode());
  await page.screenshot({ path: join(temporaryRoot, "brand-sidebar-expanded.png") });
  await page.getByTitle("收起侧栏").click();
  await assertViewportFit(page);
  await page.screenshot({ path: join(temporaryRoot, "brand-sidebar-compact.png"), animations: "disabled" });
  await page.getByTitle("展开侧栏").click();
  if (!await page.getByRole("button", { name: "设置", exact: true }).isVisible()) {
    throw new Error("经营视图必须直接显示设置入口");
  }
  await page.getByRole("button", { name: "工作区" }).click();
  await expectText(page, "成员");
  await expectText(page, "本地所有者");
  if ((await page.locator("body").innerText()).includes("local-owner")) {
    throw new Error("经营视图不应暴露内部 principal ID");
  }
  await page.getByTitle("技术配置").click();
  await page.getByRole("button", { name: "Agents" }).click();
  await expectText(page, "公开资料研究");
  await expectText(page, "预期成果");
  await expectText(page, "示例输入");
  await expectText(page, "木牛 Agent OS");
  await expectText(page, "Apache-2.0");
  await expectText(page, "已启用");
  const modelRequest = requestLog.find((entry) => entry.path === "/v2/model-connections");
  if (!modelRequest || modelRequest.body.presetId !== "deepseek" || !modelRequest.body.apiKey) {
    throw new Error("BYOK 向导没有提交厂商预设和密钥");
  }
  for (const field of ["providerId", "modelId", "baseUrl", "wireFormat"]) {
    if (field in modelRequest.body) throw new Error(`模型连接请求不应包含 ${field}`);
  }
}

async function verifyOpc(page, requestLog, hostUrl) {
  await expectText(page, "工作台");
  await page.getByRole("button", { name: "经营", exact: true }).click();
  await page.getByRole("button", { name: "机会验证", exact: true }).click();
  await expectText(page, "方案待验证");
  await expectText(page, "支持证据");
  await expectText(page, "反证");
  await expectText(page, "证据缺口");
  await expectText(page, "下一步");
  const businessText = await page.locator("body").innerText();
  for (const hiddenDetail of ["机会 ID", "事件版本", "内部状态"]) {
    if (businessText.includes(hiddenDetail)) throw new Error(`经营视图不应显示${hiddenDetail}`);
  }

  const workspace = (await hostData(hostUrl, "/v2/workspaces"))[0];
  const summary = (await hostData(hostUrl, `/v2/plugins/opc/opportunities?workspaceId=${encodeURIComponent(workspace.id)}`))[0];
  await page.getByRole("button", { name: "查看档案" }).click();
  await expectText(page, "界定这项机会");
  await expectText(page, "与 OPC Agent 一起推进");
  const nextTaskBox = await page.locator(".opc-next-task").first().boundingBox();
  const agentBox = await page.locator(".opc-agent-panel").boundingBox();
  if (!nextTaskBox || !agentBox || nextTaskBox.y >= agentBox.y) throw new Error("机会下一步应显示在会话前面");
  await expectText(page, "请回忆最近一次遇到这个问题的具体经过。");
  await page.getByLabel("给 OPC Agent 的消息").fill("请先列出当前最需验证的三个问题");
  await page.getByRole("button", { name: "发送给 OPC Agent" }).click();
  await expectText(page, "请先列出当前最需验证的三个问题");
  await expectText(page, "已按当前机会整理三个验证问题");
  await expectText(page, "预估模型费用：CNY 0.00");
  await expectText(page, "费用按参考价格预估，以厂商账单为准");
  const turnRequest = requestLog.find((entry) => entry.method === "POST" && entry.path.endsWith("/turns"));
  if (!turnRequest || turnRequest.body.message !== "请先列出当前最需验证的三个问题"
    || !Number.isInteger(turnRequest.body.expectedStreamVersion)) {
    throw new Error(`OPC Agent 没有通过通用 turns 接口提交：${JSON.stringify(turnRequest)}`);
  }
  for (const hiddenField of ["threadId", "agentDefinitionId", "modelBindingId", "providerId", "modelId", "runnerId"]) {
    if (hiddenField in turnRequest.body) throw new Error(`OPC Agent 提交不应包含 ${hiddenField}`);
  }
  if (!requestLog.some((entry) => entry.method === "GET" && entry.path.endsWith("/threads"))) {
    throw new Error("OPC 档案没有按资源引用解析 Thread");
  }
  if (!requestLog.some((entry) => entry.method === "GET" && entry.path.endsWith("/turns"))) {
    throw new Error("OPC 档案没有读取会话记录");
  }
  const initialEventStream = requestLog.find((entry) => entry.method === "GET" && entry.path.endsWith("/events"));
  if (!initialEventStream) throw new Error("OPC 会话没有订阅工作区 SSE");
  await page.waitForFunction(() => Object.keys(sessionStorage)
    .filter((key) => key.startsWith("muniu:v2:event-cursor:"))
    .some((key) => Number(sessionStorage.getItem(key)) > 0));

  const streamCount = requestLog.filter(entry => entry.method === "GET" && entry.path.endsWith("/events")).length;
  await page.getByRole("button", { name: "返回机会列表" }).click();
  await page.getByRole("button", { name: "查看档案" }).click();
  await expectText(page, "与 OPC Agent 一起推进");
  await page.waitForTimeout(250);
  if (requestLog.filter(entry => entry.method === "GET" && entry.path.endsWith("/events")).length !== streamCount) throw new Error("同一工作区的会话重新进入不应建立额外事件连接");

  await page.getByText("管理机会", { exact: true }).click();
  await page.getByLabel("管理原因").fill("等待两位目标客户回复");
  await page.getByRole("button", { name: "暂停机会" }).click();
  await expectText(page, "暂停原因：等待两位目标客户回复");
  await page.getByRole("button", { name: "恢复机会" }).click();
  await expectText(page, "机会已恢复");

  await page.getByLabel("目标客户").fill("有 2–5 年经验的独立设计师");
  await page.getByLabel("客户问题").fill("收入依赖不稳定的转介绍");
  await page.getByLabel("可证伪假设").fill("3 位目标客户中至少 1 位愿意承诺付费试用");
  await page.getByRole("button", { name: "保存机会界定" }).click();
  await expectText(page, "开始资料研究");
  let opportunity = await hostData(hostUrl, `/v2/plugins/opc/opportunities/${summary.id}?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (opportunity.state !== "framed" || opportunity.hypotheses.at(-1)?.problem !== "收入依赖不稳定的转介绍") {
    throw new Error(`机会界定没有写入真实 Host：${JSON.stringify(opportunity)}`);
  }

  await page.getByRole("button", { name: "开始研究" }).click();
  await expectText(page, "记录一条市场信号");
  await page.getByLabel("来源类型").selectOption("public_web");
  await page.getByLabel("来源网址").fill("ftp://example.com/research");
  await page.getByLabel("观察时间").fill("2026-09-04T08:30");
  await page.getByLabel("原始摘录").fill("访谈准备耗时");
  await page.getByLabel("信号摘要").fill("目标客户正在寻找可复用的获客方法");
  await page.getByLabel("证据关系").selectOption("support");
  await page.getByLabel("信号强度").selectOption("interest");
  await page.getByRole("button", { name: "保存信号" }).click();
  const pluginError = page.getByRole("alert").filter({ hasText: "公开网页来源必须使用 HTTP 或 HTTPS" });
  await pluginError.waitFor();
  if ((await pluginError.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' opc-detail ')]").count()) !== 1) {
    throw new Error("OPC 命令错误没有留在插件详情边界内");
  }
  await page.getByRole("button", { name: "工作台" }).waitFor({ state: "visible" });
  await expectText(page, "记录一条市场信号");
  await page.getByLabel("来源网址").fill("https://example.com/research");
  await page.getByRole("button", { name: "保存信号" }).click();
  await expectText(page, "信号已保存");

  await page.getByLabel("来源类型").selectOption("file");
  await page.getByLabel("证据文件").setInputFiles({
    name: "免费替代方案.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("熟人推荐已经够用"),
  });
  await page.getByLabel("观察时间").fill("2026-09-04T08:40");
  await page.getByLabel("原始摘录").fill("熟人推荐已经够用");
  await page.getByLabel("信号摘要").fill("现有转介绍可能削弱付费意愿");
  await page.getByLabel("证据关系").selectOption("oppose");
  await page.getByLabel("信号强度").selectOption("context");
  await page.getByRole("button", { name: "保存信号" }).click();
  await expectText(page, "信号已保存");
  opportunity = await hostData(hostUrl, `/v2/plugins/opc/opportunities/${summary.id}?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (opportunity.signals.length !== 2 || !opportunity.signals.some((item) => item.relationship === "oppose")) {
    throw new Error(`支持与反证没有写入真实 Host：${JSON.stringify(opportunity.signals)}`);
  }

  await page.getByRole("button", { name: "信号已够，开始访谈" }).click();
  await expectText(page, "保存访谈原文");
  await page.getByLabel("受访者代号").fill("受访者 A");
  await page.getByLabel("访谈时间").fill("2026-09-03T10:00");
  const rawInterview = "我依赖熟人推荐，但淡季时没有稳定的新客户。";
  await page.getByLabel("访谈原文").fill(rawInterview);
  await page.getByRole("button", { name: "保存访谈原文" }).click();
  await expectText(page, "访谈原文已保存");
  opportunity = await hostData(hostUrl, `/v2/plugins/opc/opportunities/${summary.id}?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (opportunity.interviews[0]?.rawRecord !== rawInterview) throw new Error("访谈原文未按输入保存");
  await page.getByLabel("为受访者 A 追加标注").fill("现有获客方式在淡季失效");
  await page.getByRole("button", { name: "追加标注", exact: true }).click();
  await expectText(page, "访谈标注已追加");
  opportunity = await hostData(hostUrl, `/v2/plugins/opc/opportunities/${summary.id}?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (opportunity.interviews[0]?.rawRecord !== rawInterview
    || opportunity.interviews[0]?.annotations?.[0]?.text !== "现有获客方式在淡季失效") {
    throw new Error("追加访谈标注覆盖了原文或没有写入标注");
  }

  await page.getByRole("button", { name: "访谈已够，开始评估" }).click();
  await expectText(page, "形成最小收费方案");
  await page.getByLabel("承诺结果").fill("七天内形成可执行的获客节奏");
  await page.getByLabel("服务范围").fill("访谈提纲\n证据账本");
  await page.getByLabel("不包含").fill("自动外联\n代替客户访谈");
  await page.getByLabel("价格", { exact: true }).fill("99");
  await page.getByLabel("价格假设").fill("首批客户测试价");
  await page.getByLabel("交付形式").fill("在线文档与复盘会");
  await page.getByLabel("交付周期").fill("7 天");
  await page.getByLabel("验收方式").fill("完成三次访谈并形成结论");
  await page.getByLabel("客户下一步").fill("确认参与付费试用");
  await page.getByLabel("主要风险").fill("样本招募不足");
  await page.getByRole("button", { name: "保存最小收费方案" }).click();
  await expectText(page, "记录客户承诺");

  await page.getByLabel("证据说明").fill("客户确认愿意按测试价试用");
  await page.getByLabel("证据来源").fill("受访者 A 的访谈原文");
  await page.getByRole("button", { name: "提交待确认承诺" }).click();
  await expectText(page, "核对客户承诺");
  const confirmEvidence = page.getByRole("button", { name: "确认承诺证据" });
  if (!(await confirmEvidence.isDisabled())) throw new Error("未人工核对前不应允许确认承诺");
  await page.getByLabel("我已核对原始记录，确认这项承诺真实有效").check();
  await confirmEvidence.click();
  await expectText(page, "作出最终决策");
  opportunity = await hostData(hostUrl, `/v2/plugins/opc/opportunities/${summary.id}?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (opportunity.evidenceLevel !== "commitment" || opportunity.commitmentEvidence[0]?.status !== "confirmed") {
    throw new Error("人工确认没有提升承诺证据等级");
  }

  await page.getByLabel("决策", { exact: true }).selectOption("pursue");
  await page.getByLabel("决策理由").fill("已有明确承诺，同时保留转介绍替代方案风险");
  const decide = page.getByRole("button", { name: "保存人工决策" });
  if (!(await decide.isDisabled())) throw new Error("未人工确认前不应允许保存最终决策");
  await page.getByLabel("我确认这是负责人作出的最终决策").check();
  await decide.click();
  await expectText(page, "导出机会成果");
  await expectText(page, "机会验证档案");
  await expectText(page, "决策记录");
  opportunity = await hostData(hostUrl, `/v2/plugins/opc/opportunities/${summary.id}?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (opportunity.state !== "decided" || opportunity.decision?.choice !== "pursue") throw new Error("人工决策未写入真实 Host");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出 6 项成果" }).click(),
  ]);
  if (!download.suggestedFilename().endsWith(".json")) throw new Error("成果没有导出为结构化文件");
  const downloaded = JSON.parse(await readFile(await download.path(), "utf8"));
  if (downloaded.schemaVersion !== 1 || downloaded.deliverables?.length !== 6) throw new Error("成果文件缺少完整的六项交付物");
  if (!downloaded.deliverables.find(item => item.kind === "interview_pack")?.content.interviews[0]?.rawRecord) throw new Error("成果文件缺少经授权的原始访谈");
  await expectText(page, "6 项成果已导出");
  const exportCount = requestLog.filter(entry => entry.method === "POST" && entry.path.endsWith("/exports")).length;
  await page.evaluate(() => {
    window.__TAURI__ = { core: { async invoke(command, args) {
      if (command !== "save_json_export" || !args.fileName.endsWith(".json") || JSON.parse(args.content).deliverables.length !== 6) throw new Error("原生保存契约无效");
      return false;
    } } };
  });
  await page.getByRole("button", { name: "导出 6 项成果" }).click();
  await expectText(page, "已取消保存文件");
  if (requestLog.filter(entry => entry.method === "POST" && entry.path.endsWith("/exports")).length !== exportCount) throw new Error("重复保存文件不应重复创建成果");
  await page.evaluate(() => { window.__TAURI__.core.invoke = async () => { throw new Error("fixture-save-failure"); }; });
  await page.getByRole("button", { name: "导出 6 项成果" }).click();
  await expectText(page, "文件未保存，请选择新的 JSON 文件名并检查目录权限");
  if ((await page.locator("body").innerText()).includes("fixture-save-failure")) throw new Error("原生保存错误泄露未脱敏详情");
  await page.evaluate(() => { delete window.__TAURI__; });
  await page.screenshot({ path: join(temporaryRoot, "opc-export.png") });
  const exported = await hostData(hostUrl, `/v2/deliverables?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (exported.length !== 6) throw new Error(`实际导出成果数不是 6：${exported.length}`);
  await page.getByRole("button", { name: "资料与成果", exact: true }).click();
  await expectText(page, "可以交付的结果");
  await page.getByRole("button", { name: "打开成果：机会验证档案", exact: true }).click();
  await expectText(page, "机会验证");

  const commandRequests = requestLog.filter((entry) => entry.method === "POST" && entry.path.endsWith("/commands"));
  const successfulSequence = ["frame", "start_research", "record_signal", "record_signal", "start_interviewing", "record_interview", "annotate_interview", "start_evaluation", "prepare_offer", "propose_commitment", "confirm_commitment", "decide"];
  let cursor = 0;
  for (const request of commandRequests) {
    if (request.body.command === successfulSequence[cursor]) cursor += 1;
  }
  if (cursor !== successfulSequence.length) throw new Error(`OPC 命令序列不完整：${JSON.stringify(commandRequests.map((entry) => entry.body.command))}`);
  if (!requestLog.some((entry) => entry.method === "GET" && entry.path.endsWith(`/opportunities/${summary.id}`))) throw new Error("档案没有调用真实 GET opportunity");
  if (!requestLog.some((entry) => entry.method === "GET" && entry.path.endsWith(`/opportunities/${summary.id}/deliverables`))) throw new Error("档案没有调用真实 GET deliverables");
  if (!requestLog.some((entry) => entry.method === "POST" && entry.path.endsWith(`/opportunities/${summary.id}/exports`))) throw new Error("档案没有调用真实 POST exports");
  if (commandRequests.some((entry) => !Number.isInteger(entry.body.expectedStreamVersion))) throw new Error("OPC 命令缺少 expectedStreamVersion");
  const fileSignal = commandRequests.find((entry) => entry.body.command === "record_signal" && entry.body.input?.sourceKind === "file");
  if (!fileSignal?.body.input?.sourceAssetId) throw new Error("文件信号没有提交 Asset 引用");
  const interviewCommand = commandRequests.find((entry) => entry.body.command === "record_interview");
  if (!interviewCommand?.body.input?.rawRecordAssetId || "rawRecord" in interviewCommand.body.input) {
    throw new Error("访谈命令没有使用受保护 Asset 引用");
  }
  const assetUploads = requestLog.filter((entry) => entry.method === "POST" && entry.path === "/v2/assets");
  if (assetUploads.length < 2 || assetUploads.some((entry) => entry.body.attachments?.[0]?.protected !== true)) {
    throw new Error("OPC 文件没有通过受保护附件接口上传");
  }
  const commandCountBeforeModeSwitch = commandRequests.length;

  await page.getByRole("button", { name: "返回机会列表" }).click();
  await expectText(page, "已有承诺证据");
  if (!await page.getByRole("button", { name: "设置", exact: true }).isVisible()) {
    await page.getByTitle("技术配置").click();
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expectText(page, "目标客户重视可预测的获客节奏");
  await page.getByRole("button", { name: "修改记忆：目标客户重视可预测的获客节奏" }).click();
  await page.getByLabel("记忆内容").fill("目标客户明确重视可预测的获客节奏");
  await page.getByRole("button", { name: "保存记忆修改" }).click();
  await expectText(page, "目标客户明确重视可预测的获客节奏");
  await page.getByRole("button", { name: "删除记忆：目标客户明确重视可预测的获客节奏" }).click();
  await page.getByRole("button", { name: "确认删除记忆" }).click();
  await page.getByText("目标客户明确重视可预测的获客节奏", { exact: true }).waitFor({ state: "hidden" });
  const remainingMemories = await hostData(hostUrl, `/v2/memories?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (remainingMemories.length !== 0) throw new Error("删除后的记忆仍存在于查询投影");
  if ((await page.locator("body").innerText()).includes("目标客户明确重视可预测的获客节奏")) throw new Error("删除后的记忆仍暴露原内容");
  await page.getByRole("button", { name: "专业视图" }).click();
  await page.getByRole("button", { name: "经营", exact: true }).click();
  await page.getByRole("button", { name: "机会验证", exact: true }).click();
  await page.getByRole("button", { name: "查看档案" }).click();
  await expectText(page, "机会 ID");
  await expectText(page, "事件版本");
  await expectText(page, "继续推进");
  const commandCountAfterModeSwitch = requestLog.filter((entry) => entry.method === "POST" && entry.path.endsWith("/commands")).length;
  if (commandCountAfterModeSwitch !== commandCountBeforeModeSwitch) throw new Error("切换视图不应产生新的 OPC 领域命令");
  if (!requestLog.some((entry) => entry.method === "PATCH" && /^\/v2\/memories\/[^/]+$/.test(entry.path))) throw new Error("记忆修改没有使用统一 v2 接口");
  if (!requestLog.some((entry) => entry.method === "DELETE" && /^\/v2\/memories\/[^/]+$/.test(entry.path))) throw new Error("记忆删除没有使用统一 v2 接口");
}

async function hostData(hostUrl, path) {
  const response = await fetch(`${hostUrl}${path}`, { headers: { accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`真实 Host 请求失败 ${path}：${JSON.stringify(payload)}`);
  return payload.data;
}

async function verifyCoding(page, requestLog) {
  await page.getByRole("button", { name: "工作区" }).click();
  await expectText(page, "Codex Runner");
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  const capture = page.getByRole("form", { name: "委派新任务" });
  await capture.waitFor({ state: "visible" });
  const taskKinds = await capture.getByRole("group", { name: "任务类型" }).getByRole("radio").count();
  if (taskKinds !== 2) throw new Error("统一入口只能提供经营与研发，不得把 Runner 当成任务类型");
  await page.getByRole("button", { name: /收件箱/ }).click();
  await expectText(page, "模型凭据失效");
  await expectText(page, "重新连接模型后，等待中的任务才能继续");
  await page.getByRole("button", { name: "检查模型连接" }).click();
  await page.getByRole("region", { name: "模型连接管理" }).waitFor();
  await page.getByLabel("模型厂商", { exact: true }).selectOption("deepseek");
  await page.getByLabel("新模型密钥", { exact: true }).fill("fixture-new-key-not-a-secret");
  await page.getByRole("button", { name: "保存并用于新任务" }).click();
  await expectText(page, "模型已连接，新任务将使用此连接");
  if (await page.getByLabel("新模型密钥", { exact: true }).inputValue()) throw new Error("保存后未清除输入框中的密钥");
  await page.getByRole("button", { name: /收件箱/ }).click();
  await expectText(page, "外部 Runner 结果待核对");
  await expectText(page, "选择标记完成后，将先对保留候选运行权威 Gate；不会重放外部 Runner");
  await expectText(page, "0 个候选 · 0 次 Gate");
  await page.getByRole("button", { name: "验证保留结果并标记完成" }).waitFor();
  if ((await page.locator("body").innerText()).includes("/private/var/tmp")) {
    throw new Error("人工核对卡泄露了内部执行路径");
  }
  await page.getByRole("button", { name: "终止旧调用" }).click();
  await expectText(page, "旧调用已终止，隔离资源正在清理");
  const reconciliationGet = requestLog.find((entry) => entry.method === "GET"
    && entry.path.endsWith("/reconciliation"));
  const reconciliationDecision = requestLog.find((entry) => entry.method === "POST"
    && entry.path.endsWith("/reconciliation-decisions"));
  if (!reconciliationGet || !reconciliationDecision
    || reconciliationDecision.body.expectedStreamVersion !== 1
    || reconciliationDecision.body.expectedCodingStreamVersion !== 1
    || reconciliationDecision.body.decision !== "terminate") {
    throw new Error(`桌面人工核对没有自动提交并发版本：${JSON.stringify(reconciliationDecision)}`);
  }
  await page.getByRole("button", { name: "Coding" }).click();
  const repositories = page.getByRole("region", { name: "Coding 仓库" });
  await repositories.getByText("muniu", { exact: true }).waitFor();
  await repositories.getByRole("button", { name: "添加仓库", exact: true }).click();
  const registration = page.getByRole("dialog", { name: "登记仓库", exact: true });
  await registration.getByLabel("仓库绝对路径", { exact: true }).fill("/workspace/customer-service");
  await registration.getByRole("button", { name: "登记并选中", exact: true }).click();
  await repositories.getByText("customer-service", { exact: true }).waitFor();
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  await capture.getByRole("radio", { name: "研发", exact: true }).check();
  const repositoryChoice = page.getByLabel("任务仓库", { exact: true });
  await capture.getByLabel("任务目标", { exact: true }).fill("为第二个仓库补充错误处理");
  if (!(await repositoryChoice.locator("option:checked").textContent()).startsWith("customer-service")) throw new Error("登记后应选中新仓库");
  const selectedRepository = await repositoryChoice.inputValue();
  await capture.getByLabel("验收要求", { exact: true }).fill("说明修复和验证结果");
  await capture.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).waitFor();
  await page.getByRole("button", { name: "Coding", exact: true }).click();
  await page.locator(".coding-card").filter({ hasText: "为第二个仓库补充错误处理" }).waitFor();
  const newTaskCard = page.locator(".coding-card").filter({ hasText: "为第二个仓库补充错误处理" });
  await newTaskCard.getByText("进行中", { exact: true }).waitFor();
  await newTaskCard.getByText("待检查", { exact: true }).waitFor();
  const capturedTask = requestLog.filter(entry => entry.method === "POST" && entry.path === "/v2/plugins/coding/tasks").at(-1);
  if (capturedTask?.body.repositoryId !== selectedRepository) throw new Error("任务未绑定到用户选择的仓库");
  await assertViewportFit(page);
  await page.screenshot({ path: join(temporaryRoot, "coding-repositories.png") });
  await expectText(page, "统一 Agent OS API");
  await expectText(page, "差异");
  await expectText(page, "检查");
  await expectText(page, "审批");
  await expectText(page, "下一步");
  await page.locator(".coding-card").filter({ hasText: "统一 Agent OS API" })
    .getByRole("button", { name: "打开任务" }).click();
  await expectText(page, "Coding 任务");
  const runnerSelector = page.getByLabel("本轮执行方式", { exact: true });
  await runnerSelector.waitFor({ state: "visible" });
  if (await runnerSelector.inputValue() !== "builtin") throw new Error("Coding 必须默认使用内置 Agent");
  await page.getByLabel("给 Coding Agent 的消息", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "发送给 Coding Agent", exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("给 Coding Agent 的消息", { exact: true }).fill("按任务要求生成可审阅的变更");
  await page.getByRole("button", { name: "发送给 Coding Agent", exact: true }).click();
  await expectText(page, "已提交，等待执行");
  await page.getByLabel("给 Coding Agent 的消息", { exact: true }).fill("补充检查错误处理");
  await page.getByRole("button", { name: "发送给 Coding Agent", exact: true }).click();
  await page.getByLabel("给 Coding Agent 的消息", { exact: true }).fill("保留现有未提交内容");
  await page.getByRole("button", { name: "调整当前方向", exact: true }).click();
  await page.getByRole("button", { name: "取消执行", exact: true }).click();
  await expectText(page, "执行已取消");
  const controls = requestLog.filter(entry => entry.method === "POST" && /\/executions\/[^/]+\/commands$/.test(entry.path));
  if (JSON.stringify(controls.slice(-3).map(entry => entry.body.command)) !== JSON.stringify(["follow_up", "steer", "cancel"])) {
    throw new Error("Coding 会话未使用同一 Execution 的控制接口");
  }
  await page.getByRole("button", { name: "返回任务列表" }).click();
  await expectText(page, "统一 Agent OS API");
  await page.keyboard.press("Meta+k");
  await page.getByRole("dialog", { name: "命令中心" }).getByRole("textbox").fill("统一 Agent OS API");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "返回任务列表" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "返回任务列表" }).click();
  if ((await page.locator("body").innerText()).includes("Harness 摘要")) throw new Error("经营视图不应显示 Harness");
  if (!await page.getByRole("button", { name: "设置", exact: true }).isVisible()) {
    await page.getByTitle("技术配置").click();
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "专业视图" }).click();
  await page.getByRole("button", { name: "Coding" }).click();
  await page.getByText("正在读取 Coding 任务").waitFor({ state: "hidden" });
  await expectText(page, "高级执行设置");
  const codingCard = page.locator(".coding-card").filter({ hasText: "统一 Agent OS API" });
  await codingCard.getByText("高级执行设置").click();
  await codingCard.getByText("Harness 摘要").waitFor({ state: "visible" });
  if (!await page.getByRole("button", { name: "集成", exact: true }).isVisible()) await page.getByTitle("技术配置").click();
  await page.getByRole("button", { name: "集成", exact: true }).click();
  await expectText(page, "与 Host 同进程运行");
  await expectText(page, "不是安全沙箱");
  await expectText(page, "无法约束恶意插件直接使用进程能力");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const runnerCard = page.getByRole("region", { name: "Codex CLI 接入状态", exact: true });
  await runnerCard.getByText("确认 Agent 可执行文件", { exact: true }).click();
  await runnerCard.getByLabel("可执行文件绝对路径", { exact: true }).fill(process.execPath);
  await runnerCard.getByRole("button", { name: "检查文件", exact: true }).click();
  await runnerCard.getByText("SHA-256", { exact: true }).waitFor({ state: "visible" });
  await runnerCard.getByLabel("已核实的版本", { exact: true }).fill("0.2.0-ui-fixture");
  await runnerCard.getByLabel("我已核对文件来源、版本和摘要", { exact: true }).check();
  await runnerCard.getByRole("button", { name: "确认使用此文件", exact: true }).click();
  await runnerCard.getByText("文件已确认", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Coding", exact: true }).click();
  await page.locator(".coding-card").filter({ hasText: "统一 Agent OS API" }).getByRole("button", { name: "打开任务" }).click();
  const selectedRunner = page.getByLabel("本轮执行方式", { exact: true });
  if (await selectedRunner.inputValue() !== "builtin") throw new Error("确认外部 Runner 不得改变默认执行方式");
  await selectedRunner.selectOption("codex-cli");
  await page.getByLabel("给 Coding Agent 的消息", { exact: true }).fill("显式选择 Codex Runner");
  await page.getByRole("button", { name: "发送给 Coding Agent", exact: true }).click();
  await expectText(page, "已提交，等待执行");
  const externalTurn = requestLog.filter(entry => entry.method === "POST" && /\/threads\/[^/]+\/turns$/.test(entry.path)).at(-1);
  if (externalTurn?.body.runnerId !== "codex-cli") throw new Error("显式 Runner 选择未写入公共 turn 接口");
  const workspacePaths = requestLog.filter((entry) => /^\/v2\/workspaces\/[^/]+$/.test(entry.path) || entry.path === "/v2/plugins/coding/tasks");
  if (workspacePaths.length === 0) throw new Error("专业视图没有使用统一 v2 接口");
}

async function expectText(page, text) {
  await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ state: "visible" });
}

async function assertViewportFit(page) {
  const fit = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    shell: document.querySelector(".app-shell")?.getBoundingClientRect().toJSON(),
    primary: (document.querySelector("dialog[open] .primary-button") ?? Array.from(document.querySelectorAll(".primary-button")).find(button => button.checkVisibility()))?.getBoundingClientRect().toJSON(),
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

async function verifyTasks(page, requestLog) {
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  const composer = page.getByRole("form", { name: "委派新任务" });
  const executionModel = composer.getByLabel("执行模型", { exact: true });
  await executionModel.locator('option').nth(1).waitFor({ state: "attached" });
  if (await composer.getByLabel("任务执行者").inputValue() !== "auto" || await composer.getByLabel("调度偏好").inputValue() !== "quality") throw new Error("任务未默认采用质量优先自动推荐");
  const initialModel = await executionModel.inputValue();
  const selectedPlanModel = await executionModel.locator('option').evaluateAll((items, initial) => items.find(item => item.value !== initial).value, initialModel);
  await executionModel.selectOption(selectedPlanModel);
  await composer.getByLabel("任务目标", { exact: true }).fill("规划下月经营，分析现金流与交付安排");
  await composer.getByLabel("验收要求", { exact: true }).fill("区分事实和建议\n说明资料缺口");
  await composer.getByLabel("任务执行者").selectOption("claude-cli");
  if (await executionModel.count()) throw new Error("手动选择 CLI 不应要求木牛模型连接");
  await composer.getByText(/使用 CLI 自有账户和模型/u).waitFor();
  if (!await composer.getByRole("button", { name: "准备执行计划", exact: true }).isEnabled()) throw new Error("外部 CLI 应允许先提交计划，交由 Host 检查身份");
  await composer.getByLabel("任务执行者").selectOption("auto");
  if (await executionModel.inputValue() !== selectedPlanModel) throw new Error("切换 CLI 不应丢失模型偏好");
  await composer.getByLabel("添加文本资料").setInputFiles({ name: "不可读.pdf", mimeType: "application/pdf", buffer: Buffer.from("fixture") });
  await composer.getByText("资料未就绪", { exact: true }).waitFor();
  if (await composer.getByRole("button", { name: "准备执行计划", exact: true }).isEnabled()) throw new Error("不可读资料必须阻止计划准备");
  if (!(await composer.getByLabel("任务目标", { exact: true }).inputValue()).includes("现金流")) throw new Error("资料解析失败丢失任务草稿");
  await composer.getByRole("button", { name: "移除 不可读.pdf", exact: true }).click();
  await composer.getByLabel("添加文本资料").setInputFiles({ name: "交付约束.md", mimeType: "text/markdown", buffer: Buffer.from("现有客户优先；资料不是执行授权。") });
  await composer.getByText("已解析", { exact: true }).waitFor();
  await composer.getByRole("button", { name: "交付约束.md", exact: true }).click();
  await composer.getByText("现有客户优先；资料不是执行授权。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  if (!(await composer.getByLabel("任务目标", { exact: true }).inputValue()).includes("现金流")) throw new Error("切换页面丢失任务草稿");
  let droppedGoal = false;
  await page.route(`${apiUrl}/v2/workspaces/*/goals`, async route => {
    if (route.request().method() !== "POST" || droppedGoal) return route.continue();
    droppedGoal = true;
    const response = await route.fetch();
    if (!response.ok()) throw new Error("任务响应丢失测试必须先完成真实写入");
    await route.abort("failed");
  });
  await page.screenshot({ path: join(temporaryRoot, "task-composer.png"), fullPage: true, animations: "disabled" });
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  await composer.getByRole("alert").waitFor();
  if (await composer.getByLabel("任务目标", { exact: true }).isEnabled()) throw new Error("结果未知时不得改变重试内容");
  await composer.getByRole("button", { name: "继续准备", exact: true }).click();
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).waitFor();
  await page.unroute(`${apiUrl}/v2/workspaces/*/goals`);
  if (await page.getByRole("region", { name: "目标详情" }).getByLabel("执行模型", { exact: true }).inputValue() !== selectedPlanModel) throw new Error("计划审阅显示的模型与委派时选择的模型不一致");
  await page.getByRole("region", { name: "调度依据" }).waitFor();
  if (requestLog.some(item => item.path.endsWith("/turns"))) throw new Error("计划审阅之前不得开始执行");
  const created = requestLog.filter(item => item.method === "POST" && /\/workspaces\/[^/]+\/goals$/.test(item.path));
  if (created.length !== 2 || created[0].key !== created[1].key || JSON.stringify(created[0].body) !== JSON.stringify(created[1].body) || created[0].body.objective.includes("现有客户优先")) throw new Error("目标重试未保留唯一请求，或材料正文仍写入目标");
  const materialUpload = requestLog.find(item => item.method === "POST" && item.path === "/v2/assets" && item.body.attachments?.[0]?.fileName === "交付约束.md");
  const materialRef = created[0].body.resourceRefs.find(ref => ref.namespace === "asset");
  if (!materialUpload?.body.attachments[0].protected || !materialRef?.digest || !Number.isSafeInteger(materialRef.streamVersion)) throw new Error("资料缺少受保护文件或版本引用");
  const sourceResponse = await fetch(`${apiUrl}/v2/assets/${materialRef.resourceId}`);
  const source = (await sourceResponse.json()).data;
  if (!sourceResponse.ok || !source.protected || source.digest !== materialRef.digest || source.streamVersion !== materialRef.streamVersion) throw new Error("资料引用未固定服务器文件版本");
  if (requestLog.some(item => item.method === "POST" && item.path.endsWith("/opportunities"))) throw new Error("经营任务被错误创建为机会");
  await page.screenshot({ path: join(temporaryRoot, "task-plan.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "确认计划并启动", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^待验收$/u }).waitFor();
  const acceptance = page.getByRole("region", { name: "成果验收" });
  if (await acceptance.getByRole("button", { name: "接收成果", exact: true }).isEnabled()) throw new Error("验收必须逐条确认");
  await acceptance.getByRole("checkbox").nth(0).check();
  await acceptance.getByRole("checkbox").nth(1).check();
  await acceptance.getByRole("button", { name: "接收成果", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^已验收$/u }).waitFor();
  await page.getByRole("tab", { name: "进展", exact: true }).click();
  if (await page.getByRole("button", { name: "补充说明", exact: true }).isEnabled()) throw new Error("结束后不能隐式开启额度外执行");
  await page.getByRole("tab", { name: "成果", exact: true }).click();
  await page.getByRole("link", { name: "下载成果", exact: true }).waitFor();
  await acceptance.getByRole("heading", { name: "经营建议", exact: true }).waitFor();
  await acceptance.getByRole("table").waitFor();
  if (await acceptance.locator("img, script").count()) throw new Error("模型正文不得执行 HTML");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: /搜索命令/ }).click();
  const palette = page.getByRole("dialog", { name: "命令中心" });
  await palette.getByRole("textbox").fill("规划下月经营");
  await palette.getByRole("option").filter({ hasText: "规划下月经营" }).first().click();
  await page.getByRole("region", { name: "目标详情" }).getByRole("status").filter({ hasText: /^已验收$/u }).waitFor();
  await page.screenshot({ path: join(temporaryRoot, "task-delivery.png"), fullPage: true });
  await page.setViewportSize({ width: 960, height: 640 });
  await assertViewportFit(page);
}

async function verifyRefresh(page) {
  let changed = false;
  await page.route(`${apiUrl}/v2/inbox?*`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (changed) body.data.push({ id: "refresh-fixture", tenantId: "local", workspaceId: new URL(route.request().url()).searchParams.get("workspaceId"), kind: "credential", title: "外部入口待处理", summary: "检查接入状态", createdAt: new Date().toISOString(), status: "open" });
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: /^收件箱/ }).click();
  await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
  let workspace = (await hostData(apiUrl, "/v2/workspaces"))[0];
  changed = true;
  const mutation = await fetch(`${apiUrl}/v2/workspaces/${workspace.id}`, { method: "PATCH", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedStreamVersion: workspace.streamVersion, viewMode: "professional" }) });
  if (!mutation.ok) throw new Error("外部入口切换视图失败");
  await page.locator(".view-chip").getByText("专业视图", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "外部入口待处理", exact: true }).waitFor();
  workspace = (await mutation.json()).data;
  const removed = await fetch(`${apiUrl}/v2/workspaces/${workspace.id}/plugin-activations/coding`, { method: "DELETE", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedStreamVersion: workspace.streamVersion }) });
  if (!removed.ok) throw new Error("外部入口停用插件失败");
  await page.getByRole("button", { name: "Coding", exact: true }).waitFor({ state: "hidden" });
  workspace = (await removed.json()).data;
  const restored = await fetch(`${apiUrl}/v2/workspaces/${workspace.id}/plugin-activations`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ expectedStreamVersion: workspace.streamVersion, pluginId: "coding" }) });
  if (!restored.ok) throw new Error("外部入口启用插件失败");
  await page.getByRole("button", { name: "Coding", exact: true }).waitFor();
  await page.unroute(`${apiUrl}/v2/inbox?*`);
}


async function verifyTeams(page, requestLog) {
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  const composer = page.getByRole("form", { name: "委派新任务" });
  if (!await composer.getByRole("radio", { name: "单 Agent", exact: true }).isChecked()) throw new Error("团队不能默认启用");
  await composer.getByLabel("任务目标", { exact: true }).fill("核对客户需求，形成经营方案与待确认事实");
  await composer.getByLabel("验收要求", { exact: true }).fill("区分事实与建议\n说明资料缺口");
  await composer.getByRole("radio", { name: "经营方案", exact: true }).check();
  await composer.getByLabel("团队执行模型", { exact: true }).locator("option").first().waitFor({ state: "attached" });
  await composer.getByRole("button", { name: "准备执行计划", exact: true }).click();
  const detail = page.getByRole("region", { name: "目标详情", exact: true });
  await detail.getByRole("tabpanel", { name: "计划", exact: true }).waitFor();
  await detail.getByRole("region", { name: "执行计划", exact: true }).getByText(/模板版本 1/u).waitFor();
  if (await detail.getByRole("tab").count() !== 4) throw new Error("任务详情缺少四个视图");
  await detail.getByRole("button", { name: "确认计划并启动", exact: true }).click();
  await detail.getByRole("button", { name: "确认并继续", exact: true }).waitFor({ timeout: 30000 });
  const { runCli } = await import("../../cli/dist/index.js");
  const plannedRequest = requestLog.find(request => request.body?.kind === "team-v1");
  const goalId = plannedRequest.path.split("/")[3], workspaceId = plannedRequest.body.workspaceId;
  async function cli(args) {
    const lines = [];
    const code = await runCli(["goal", ...args, "--workspace", workspaceId, "--json"], { apiUrl, io: { stdout: line => lines.push(line), stderr: line => lines.push(line) } });
    if (code !== 0) throw new Error(`CLI 团队跟进失败：${lines.join("\n")}`);
    return JSON.parse(lines.at(-1)).data;
  }
  const nodeState = await cli(["nodes", goalId]);
  if (!nodeState.nodes.some(node => node.nodeId === "confirm" && node.status === "awaiting_decision")) throw new Error("CLI 未读到 Desktop 当前等待节点");
  const current = await cli(["show", goalId]);
  const paused = await cli(["pause", goalId, "--version", String(current.goal.streamVersion), "--key", "ui-cli-team-pause"]);
  if (!["pausing", "paused"].includes(paused.goal.status)) throw new Error("CLI 暂停未被 Host 记录");
  await detail.getByRole("button", { name: "恢复", exact: true }).waitFor();
  if (await detail.getByRole("button", { name: "确认并继续", exact: true }).count()) throw new Error("暂停后不得继续人工决定");
  await detail.getByRole("button", { name: "恢复", exact: true }).click();
  await detail.getByRole("button", { name: "确认并继续", exact: true }).click();
  await detail.getByRole("status").filter({ hasText: /^待验收$/u }).waitFor({ timeout: 30000 });
  const acceptance = detail.getByRole("region", { name: "成果验收", exact: true });
  await acceptance.getByText(/经营建议/u).waitFor();
  for (const checkbox of await acceptance.getByRole("checkbox").all()) await checkbox.check();
  await acceptance.getByRole("button", { name: "接收成果", exact: true }).click();
  await detail.getByRole("status").filter({ hasText: /^已验收$/u }).waitFor();
  const plan = requestLog.find(request => request.body?.kind === "team-v1");
  if (plan?.body?.templateId !== "business-proposal" || plan.body.templateVersion !== "1" || !plan.body.modelBindingId) throw new Error("团队计划未固定模板版本与模型");
  const decide = requestLog.find(request => request.body?.command === "decide");
  if (decide?.body?.nodeId !== "confirm" || decide.body.decision !== "continue") throw new Error("人工决定未绑定等待节点");
  const commands = requestLog.filter(request => ["start", "pause", "resume", "decide"].includes(request.body?.command));
  if (commands.length !== 3 || commands.some(request => !request.key || !Number.isInteger(request.body.expectedStreamVersion))) throw new Error("团队控制缺少版本与请求身份");
  await assertViewportFit(page);
  await page.screenshot({ path: join(temporaryRoot, "team-accepted.png"), fullPage: true, animations: "disabled" });
}
