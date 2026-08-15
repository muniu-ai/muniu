import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const evidenceDir = join(repoRoot, ".gdp-state", "mniu-ccswitch-redesign", "evidence");
const screenshotPath =
  process.env.MN_DESKTOP_SETTINGS_SCREENSHOT ??
  join(evidenceDir, "desktop-settings.png");
const keepTemp = process.env.MN_DESKTOP_E2E_KEEP_TEMP === "1";

const chromeExecutable = resolveChromeExecutable();
const tempRoot = await mkdtemp(join(tmpdir(), "mn-desktop-settings-"));
const homeDir = join(tempRoot, "home");
const mniuRoot = join(tempRoot, "mniu");
const worktreesRoot = join(tempRoot, "worktrees");

const apiPort = await freePort();
const vitePort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${vitePort}`;

const children = [];
let browser;

try {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(join(mniuRoot, "logs"), { recursive: true });
  await mkdir(join(homeDir, ".config", "fish", "conf.d"), { recursive: true });
  await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
  await mkdir(join(homeDir, "Library", "Logs", "DiagnosticReports"), {
    recursive: true
  });
  await mkdir(join(homeDir, "Library", "Logs", "dev.muniu.desktop"), {
    recursive: true
  });
  await mkdir(join(homeDir, "Library", "Application Support", "Code", "User"), {
    recursive: true
  });
  await writeFile(
    join(mniuRoot, "logs", "settings-e2e.log"),
    [
      "settings log line",
      "Authorization: Bearer settings-log-secret",
      "OPENAI_API_KEY=sk-settings-log-openai"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "Logs", "DiagnosticReports", "Muniu_settings_e2e.crash"),
    [
      "Process: Muniu",
      "Reason: settings e2e crash",
      "token=settings-crash-secret"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "Logs", "DiagnosticReports", "OtherApp_settings_e2e.crash"),
    "Bearer other-settings-crash-secret\n"
  );
  await writeFile(
    join(homeDir, "Library", "Logs", "dev.muniu.desktop", "mniu-desktop-e2e.log"),
    [
      "desktop app log line",
      "secret=settings-app-log-secret"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "Logs", "dev.muniu.desktop", "ignored.bin"),
    "token=ignored-settings-app-log-secret\n"
  );
  await writeFile(
    join(homeDir, ".zshrc"),
    [
      "export OPENAI_API_KEY=sk-settings-e2e-openai",
      "export ANTHROPIC_BASE_URL=https://settings-e2e.example",
      "echo keep-settings-profile"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, ".bash_profile"),
    [
      "declare -x ANTHROPIC_API_KEY=\"sk-settings-e2e-bash\"",
      "echo keep-bash-profile"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, ".config", "fish", "conf.d", "mniu.fish"),
    [
      "set -Ux OPENAI_API_KEY sk-settings-e2e-fish",
      "set -Ux KEEP_THIS value"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "LaunchAgents", "dev.muniu.env.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>Label</key>",
      "  <string>dev.muniu.env</string>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>ANTHROPIC_API_KEY</key>",
      "    <string>sk-settings-e2e-launchd</string>",
      "  </dict>",
      "</dict>",
      "</plist>"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),
    [
      "{",
      "  \"terminal.integrated.env.osx\": {",
      "    \"ANTHROPIC_BASE_URL\": \"https://settings-e2e-ide.example\",",
      "    \"KEEP_THIS\": \"value\"",
      "  }",
      "}"
    ].join("\n") + "\n"
  );

  const api = spawnProcess(
    process.execPath,
    [join(repoRoot, "apps", "api", "dist", "index.js")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        MN_API_HOST: "127.0.0.1",
        MN_API_PORT: String(apiPort),
        MN_MNIU_ROOT: mniuRoot,
        MN_USE_MOCK_EXECUTORS: "1",
        MN_WORKSPACE_ROOT: worktreesRoot
      }
    }
  );
  children.push(api);
  await waitForHttp(`${apiUrl}/healthz`, "mn-api");

  const viteBin = join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vite.cmd" : "vite"
  );
  const vite = spawnProcess(
    viteBin,
    ["--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        VITE_MN_API_URL: apiUrl
      }
    }
  );
  children.push(vite);
  await waitForHttp(appUrl, "desktop-vite");

  browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true
  });
  const page = await browser.newPage({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1100 }
  });
  page.setDefaultTimeout(15_000);

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#settings").scrollIntoViewIfNeeded();
  await expectText(page, "设置");
  await selectField(page, "Theme", "dark");
  await selectField(page, "Close behavior", "lightweight");
  await fillField(page, "API URL", "http://127.0.0.1:9999");
  await setCheckbox(page, "开机自启", true);
  await setCheckbox(page, "轻量模式", true);
  await page.locator("#settings").getByRole("button", { name: "保存" }).click();
  await expectText(page, "桌面设置已保存");
  await expectText(page, "开机自启偏好已保存");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#settings").scrollIntoViewIfNeeded();
  await expectSelectValue(page, "Theme", "dark");
  await expectSelectValue(page, "Close behavior", "lightweight");
  await expectInputValue(page, "API URL", "http://127.0.0.1:9999");
  await expectCheckbox(page, "开机自启", true);
  await expectCheckbox(page, "轻量模式", true);

  await fillField(page, "API URL", apiUrl);
  await page.locator("#settings").getByRole("button", { name: "保存" }).click();
  await expectText(page, "桌面设置已保存");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#settings").scrollIntoViewIfNeeded();
  await expectInputValue(page, "API URL", apiUrl);
  await expectText(page, "环境变量冲突");
  await expectText(page, "OPENAI_API_KEY");
  await expectText(page, "launchd 1");
  await expectText(page, "IDE 1");
  const diagnosticsDownloadPromise = page.waitForEvent("download");
  await page.locator("#settings").getByRole("button", { name: "导出诊断" }).click();
  const diagnosticsDownload = await diagnosticsDownloadPromise;
  const diagnosticsPath = await diagnosticsDownload.path();
  if (!diagnosticsPath) throw new Error("Diagnostics download did not produce a local path.");
  const diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  if (diagnostics.kind !== "mniu.diagnostics") {
    throw new Error(`Unexpected diagnostics kind: ${diagnostics.kind}`);
  }
  if (diagnostics.doctor?.api?.service !== "mn-api") {
    throw new Error("Diagnostics export is missing API doctor summary.");
  }
  const diagnosticsRaw = JSON.stringify(diagnostics);
  const diagnosticsLog = diagnostics.logs?.files?.find(
    (file) => file.relativePath === "logs/settings-e2e.log"
  );
  if (!diagnosticsLog) {
    throw new Error(`Diagnostics export is missing settings log tail: ${diagnosticsRaw}`);
  }
  if (!diagnosticsLog.tail.includes("settings log line")) {
    throw new Error("Diagnostics log tail is missing expected log content.");
  }
  if (
    !diagnosticsLog.tail.includes("Bearer [REDACTED]") ||
    !diagnosticsLog.tail.includes("OPENAI_API_KEY=[REDACTED]")
  ) {
    throw new Error(`Diagnostics log tail did not redact secrets: ${diagnosticsLog.tail}`);
  }
  const crashLog = diagnostics.crashReports?.files?.find(
    (file) => file.relativePath === "DiagnosticReports/Muniu_settings_e2e.crash"
  );
  if (!crashLog) {
    throw new Error(`Diagnostics export is missing Muniu crash report: ${diagnosticsRaw}`);
  }
  if (
    !crashLog.tail.includes("Process: Muniu") ||
    !crashLog.tail.includes("token=[REDACTED]")
  ) {
    throw new Error(`Diagnostics crash report did not redact correctly: ${crashLog.tail}`);
  }
  const appLog = diagnostics.appLogs?.files?.find(
    (file) =>
      file.relativePath === "ApplicationLogs/dev.muniu.desktop/mniu-desktop-e2e.log"
  );
  if (!appLog) {
    throw new Error(`Diagnostics export is missing desktop app log: ${diagnosticsRaw}`);
  }
  if (
    !appLog.tail.includes("desktop app log line") ||
    !appLog.tail.includes("secret=[REDACTED]")
  ) {
    throw new Error(`Diagnostics app log did not redact correctly: ${appLog.tail}`);
  }
  if (
    diagnosticsRaw.includes("sk-settings-e2e-openai") ||
    diagnosticsRaw.includes("https://settings-e2e.example") ||
    diagnosticsRaw.includes("sk-settings-e2e-launchd") ||
    diagnosticsRaw.includes("https://settings-e2e-ide.example") ||
    diagnosticsRaw.includes("settings-log-secret") ||
    diagnosticsRaw.includes("sk-settings-log-openai") ||
    diagnosticsRaw.includes("settings-crash-secret") ||
    diagnosticsRaw.includes("other-settings-crash-secret") ||
    diagnosticsRaw.includes("settings-app-log-secret") ||
    diagnosticsRaw.includes("ignored-settings-app-log-secret")
  ) {
    throw new Error("Diagnostics export leaked raw managed env values.");
  }
  await expectText(page, "Diagnostics downloaded");
  await page.locator("#settings").getByRole("button", { name: "预览清理" }).click();
  await expectText(page, "预览");
  await expectText(page, "6 lines");
  await page.locator("#settings").getByRole("button", { name: "确认清理" }).click();
  const cleanupDialog = page.getByRole("dialog", { name: "确认环境变量清理" });
  await cleanupDialog.getByRole("button", { name: "清理" }).click();
  await expectText(page, "已清理");
  await expectText(page, "backup");
  const cleanedProfile = await readFile(join(homeDir, ".zshrc"), "utf8");
  if (cleanedProfile.includes("OPENAI_API_KEY") || cleanedProfile.includes("ANTHROPIC_BASE_URL")) {
    throw new Error(`Shell profile still contains managed env lines:\n${cleanedProfile}`);
  }
  if (!cleanedProfile.includes("echo keep-settings-profile")) {
    throw new Error(`Shell profile cleanup removed non-conflict content:\n${cleanedProfile}`);
  }
  const cleanedBashProfile = await readFile(join(homeDir, ".bash_profile"), "utf8");
  if (cleanedBashProfile.includes("ANTHROPIC_API_KEY")) {
    throw new Error(`Bash profile still contains managed env lines:\n${cleanedBashProfile}`);
  }
  if (!cleanedBashProfile.includes("echo keep-bash-profile")) {
    throw new Error(`Bash profile cleanup removed non-conflict content:\n${cleanedBashProfile}`);
  }
  const cleanedFishProfile = await readFile(
    join(homeDir, ".config", "fish", "conf.d", "mniu.fish"),
    "utf8"
  );
  if (cleanedFishProfile.includes("OPENAI_API_KEY")) {
    throw new Error(`Fish profile still contains managed env lines:\n${cleanedFishProfile}`);
  }
  if (!cleanedFishProfile.includes("KEEP_THIS")) {
    throw new Error(`Fish profile cleanup removed non-conflict content:\n${cleanedFishProfile}`);
  }
  if (!existsSync(join(mniuRoot, "backups", "env-profile-cleanup"))) {
    throw new Error("Expected env cleanup backup directory to exist.");
  }
  const launchAgentProfile = await readFile(
    join(homeDir, "Library", "LaunchAgents", "dev.muniu.env.plist"),
    "utf8"
  );
  if (launchAgentProfile.includes("ANTHROPIC_API_KEY")) {
    throw new Error(`LaunchAgent still contains managed env lines:\n${launchAgentProfile}`);
  }
  if (!launchAgentProfile.includes("EnvironmentVariables")) {
    throw new Error(`LaunchAgent cleanup removed non-conflict structure:\n${launchAgentProfile}`);
  }
  const ideSettings = await readFile(
    join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),
    "utf8"
  );
  if (ideSettings.includes("ANTHROPIC_BASE_URL")) {
    throw new Error(`IDE settings still contain managed env lines:\n${ideSettings}`);
  }
  if (!ideSettings.includes("KEEP_THIS")) {
    throw new Error(`IDE cleanup removed non-conflict settings:\n${ideSettings}`);
  }
  await expectText(page, "launchd 0");
  await expectText(page, "IDE 0");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.setViewportSize({ width: 390, height: 920 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#settings").scrollIntoViewIfNeeded();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  if (hasHorizontalOverflow) {
    throw new Error("Settings layout overflows horizontally on mobile viewport.");
  }

  console.log(JSON.stringify({
    ok: true,
    apiUrl,
    appUrl,
    homeDir,
    mniuRoot,
    screenshotPath,
    preservedTemp: keepTemp
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await Promise.all(children.reverse().map((child) => stopProcess(child)));
  if (!keepTemp) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function fillField(container, label, value) {
  const field = container.locator("label", { hasText: label }).locator("input, textarea").first();
  await field.fill(value);
}

async function selectField(container, label, value) {
  const field = container.locator("label", { hasText: label }).locator("select").first();
  await field.selectOption(value);
}

async function setCheckbox(container, label, checked) {
  const checkbox = container.locator("label", { hasText: label }).locator("input[type='checkbox']");
  if ((await checkbox.isChecked()) !== checked) {
    await checkbox.click();
  }
}

async function expectSelectValue(container, label, value) {
  const field = container.locator("label", { hasText: label }).locator("select").first();
  const actual = await field.inputValue();
  if (actual !== value) throw new Error(`${label} expected ${value}, got ${actual}`);
}

async function expectInputValue(container, label, value) {
  const field = container.locator("label", { hasText: label }).locator("input").first();
  const actual = await field.inputValue();
  if (actual !== value) throw new Error(`${label} expected ${value}, got ${actual}`);
}

async function expectCheckbox(container, label, checked) {
  const checkbox = container.locator("label", { hasText: label }).locator("input[type='checkbox']");
  const actual = await checkbox.isChecked();
  if (actual !== checked) throw new Error(`${label} expected ${checked}, got ${actual}`);
}

async function expectText(scope, text) {
  await scope.getByText(text, { exact: false }).first().waitFor();
}

function spawnProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      child.output = `${child.output}${chunk}`.slice(-10_000);
    });
  }
  child.on("exit", (code, signal) => {
    child.exitCodeValue = code;
    child.exitSignalValue = signal;
  });
  return child;
}

async function stopProcess(child) {
  if (child.exitCodeValue !== undefined || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolveStop();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

async function waitForHttp(url, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(250);
    for (const child of children) {
      if (child.exitCodeValue !== undefined) {
        throw new Error(`${label} exited early.\n${child.output}`);
      }
    }
  }
  throw new Error(`Timed out waiting for ${label} at ${url}.`);
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolvePort(address.port);
        } else {
          rejectPort(new Error("Could not allocate a free port."));
        }
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "No Chrome executable found. Set PLAYWRIGHT_CHROME_EXECUTABLE to run desktop UI verification."
    );
  }
  return executable;
}
