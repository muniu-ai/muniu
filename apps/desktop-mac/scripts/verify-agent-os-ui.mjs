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
    if (url.origin !== apiUrl || ["HEAD", "OPTIONS"].includes(request.method())) return;
    let body = {};
    try { body = request.postDataJSON(); } catch { /* 请求体不是 JSON */ }
    requests.push({ method: request.method(), path: url.pathname, body });
  });
  page.setDefaultTimeout(12_000);
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  if (mode === "onboarding") await verifyOnboarding(page, requests);
  if (mode === "opc") await verifyOpc(page, requests, apiUrl);
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
  await expectText(page, "木牛 OPC Agent OS");
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
  await expectText(page, "首页");
  await page.getByRole("button", { name: "OPC" }).click();
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
  await page.getByRole("button", { name: "首页" }).waitFor({ state: "visible" });
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

  await page.getByRole("button", { name: "导出 6 项成果" }).click();
  await expectText(page, "6 项成果已导出");
  const exported = await hostData(hostUrl, `/v2/deliverables?workspaceId=${encodeURIComponent(workspace.id)}`);
  if (exported.length !== 6) throw new Error(`实际导出成果数不是 6：${exported.length}`);
  await page.getByRole("button", { name: "成果", exact: true }).click();
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
  await page.getByTitle("技术配置").click();
  await page.getByRole("button", { name: "设置" }).click();
  await expectText(page, "目标客户重视可预测的获客节奏");
  await page.getByRole("button", { name: "修改记忆：目标客户重视可预测的获客节奏" }).click();
  await page.getByLabel("记忆内容").fill("目标客户明确重视可预测的获客节奏");
  await page.getByRole("button", { name: "保存记忆修改" }).click();
  await expectText(page, "目标客户明确重视可预测的获客节奏");
  await page.getByRole("button", { name: "删除记忆：目标客户明确重视可预测的获客节奏" }).click();
  await page.getByRole("button", { name: "确认删除记忆" }).click();
  await expectText(page, "不可用");
  if ((await page.locator("body").innerText()).includes("目标客户明确重视可预测的获客节奏")) throw new Error("删除后的记忆仍暴露原内容");
  await page.getByRole("button", { name: "专业视图" }).click();
  await page.getByRole("button", { name: "OPC" }).click();
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
  await page.getByRole("button", { name: /收件箱/ }).click();
  await expectText(page, "模型凭据失效");
  await expectText(page, "重新连接模型后，等待中的任务才能继续");
  await page.getByRole("button", { name: "Coding" }).click();
  await expectText(page, "统一 Agent OS API");
  await expectText(page, "差异");
  await expectText(page, "检查");
  await expectText(page, "审批");
  await expectText(page, "下一步");
  await page.getByRole("button", { name: "打开任务" }).click();
  await expectText(page, "Coding 任务");
  await page.getByRole("button", { name: "返回任务列表" }).click();
  await expectText(page, "统一 Agent OS API");
  await page.keyboard.press("Meta+k");
  await page.getByRole("dialog", { name: "命令中心" }).getByRole("textbox").fill("统一 Agent OS API");
  await page.getByRole("dialog", { name: "命令中心" }).getByRole("button", { name: /统一 Agent OS API/ }).click();
  await page.getByRole("button", { name: "返回任务列表" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "返回任务列表" }).click();
  if ((await page.locator("body").innerText()).includes("Harness 摘要")) throw new Error("经营视图不应显示 Harness");
  await page.getByTitle("技术配置").click();
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "专业视图" }).click();
  await page.getByRole("button", { name: "Coding" }).click();
  await expectText(page, "高级执行设置");
  await page.getByText("高级执行设置").click();
  await expectText(page, "Harness 摘要");
  await page.getByRole("button", { name: "集成" }).click();
  await expectText(page, "与 Host 同进程运行");
  await expectText(page, "不是安全沙箱");
  await expectText(page, "无法约束恶意插件直接使用进程能力");
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
