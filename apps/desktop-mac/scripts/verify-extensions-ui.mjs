import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  process.env.MN_DESKTOP_E2E_SCREENSHOT ??
  join(evidenceDir, "desktop-extensions-crud.png");
const keepTemp = process.env.MN_DESKTOP_E2E_KEEP_TEMP === "1";

const chromeExecutable = resolveChromeExecutable();

const tempRoot = await mkdtemp(join(tmpdir(), "mn-desktop-e2e-"));
const homeDir = join(tempRoot, "home");
const mniuRoot = join(tempRoot, "mniu");
const worktreesRoot = join(tempRoot, "worktrees");
const mcpName = "mcp-e2e";
const mcpEditedName = "mcp-ok";
const mcpDeepLinkName = "mcp-deep-link";
const promptName = "prompt";
const promptEditedName = "prompt-ok";
const promptDeepLinkName = "prompt-deep-link";
const skillName = "skill-e2e";
const skillEditedName = "skill-ok";
const skillSourcePath = join(mniuRoot, "skills", skillName);
const registrySkillName = "skill-registry-e2e";
const registryPath = join(tempRoot, "skill-registry.json");
const registryPublicKeyId = "desktop-registry-2026";
let registryPublicKey = "";

const apiPort = await freePort();
const vitePort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${vitePort}`;

const children = [];
let browser;

try {
  await seedSkillSource();
  await seedSkillRegistry();
  await mkdir(evidenceDir, { recursive: true });

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(15_000);

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#extensions").scrollIntoViewIfNeeded();
  await page.locator("section[aria-label='Claude Code MCP']").waitFor();
  await expectText(page, "MCP");
  await expectText(page, "Prompt");
  await expectText(page, "Skills");

  await createAndProjectMcp(page);
  await createAndActivatePrompt(page);
  await registerAndInstallSkill(page);
  await syncSkillRegistryFromUi(page);
  await importExtensionsViaDeepLink(page);

  await page.locator("#extensions").scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await deleteExtensionRow(page, "mcp", mcpEditedName);
  await deleteExtensionRow(page, "mcp", mcpDeepLinkName);
  await deleteExtensionRow(page, "prompt", promptEditedName);
  await deleteExtensionRow(page, "prompt", promptDeepLinkName);
  await deleteExtensionRow(page, "skill", skillEditedName);
  await deleteExtensionRow(page, "skill", registrySkillName);

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

async function createAndProjectMcp(page) {
  await clickButtonTitle(page, "新增 MCP");
  const dialog = page.locator("[role='dialog'][aria-label='新增 MCP']");
  await fillField(dialog, "名称", mcpName);
  await fillField(dialog, "Command", "node");
  await fillField(dialog, "Args", "--version\n--e2e");
  await fillField(dialog, "Env", "SECRET=actual-secret");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expectText(page, mcpName);

  const row = rowFor(page, mcpName);
  await row.locator("button[title='编辑 MCP']").click();
  const editDialog = page.locator("[role='dialog'][aria-label='编辑 MCP']");
  await fillField(editDialog, "名称", mcpEditedName);
  await editDialog.getByRole("button", { name: "保存" }).click();
  await expectText(page, mcpEditedName);

  const editedRow = rowFor(page, mcpEditedName);
  await editedRow.locator("button[title='确认后投影']").click();
  const confirm = page.locator(".confirm-dialog", { hasText: "确认 MCP 投影" });
  await confirm.waitFor();
  await expectText(confirm, join(homeDir, ".claude.json"));
  await confirm.getByRole("button", { name: "确认写入" }).click();
  await confirm.waitFor({ state: "detached" });

  const claudeMcp = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8"));
  const projected = claudeMcp.mcpServers?.[mcpEditedName];
  if (projected?.env?.SECRET !== "actual-secret") {
    throw new Error("MCP projection did not preserve the stored secret env value.");
  }
}

async function createAndActivatePrompt(page) {
  await clickButtonTitle(page, "新增 Prompt");
  const dialog = page.locator("[role='dialog'][aria-label='新增 Prompt']");
  await fillField(dialog, "名称", promptName);
  await fillField(dialog, "Content", "# Desktop E2E Prompt\n\nUse the safe temp HOME.");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expectText(page, promptName);

  const row = rowFor(page, promptName);
  await row.locator("button[title='编辑 Prompt']").click();
  const editDialog = page.locator("[role='dialog'][aria-label='编辑 Prompt']");
  await fillField(editDialog, "名称", promptEditedName);
  await fillField(editDialog, "Content", "# Desktop E2E Prompt\n\nActivated from UI.");
  await editDialog.getByRole("button", { name: "保存" }).click();
  await expectText(page, promptEditedName);

  const editedRow = rowFor(page, promptEditedName);
  await editedRow.locator("button[title='确认后激活']").click();
  const confirm = page.locator(".confirm-dialog", { hasText: "确认 Prompt 激活" });
  await confirm.waitFor();
  await expectText(confirm, join(homeDir, ".claude", "CLAUDE.md"));
  await confirm.getByRole("button", { name: "确认写入" }).click();
  await confirm.waitFor({ state: "detached" });

  const promptContent = await readFile(join(homeDir, ".claude", "CLAUDE.md"), "utf8");
  if (!promptContent.includes("Activated from UI.")) {
    throw new Error("Prompt activation did not write CLAUDE.md.");
  }
}

async function registerAndInstallSkill(page) {
  await expectText(page, skillName);
  const sourceRow = page.locator(".source-row", { hasText: skillName }).first();
  await sourceRow.getByRole("button", { name: "登记" }).click();
  const dialog = page.locator("[role='dialog'][aria-label='新增 Skill']");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expectText(page, "Skill 已保存");

  const row = rowFor(page, skillName);
  await row.locator("button[title='编辑 Skill']").click();
  const editDialog = page.locator("[role='dialog'][aria-label='编辑 Skill']");
  await fillField(editDialog, "名称", skillEditedName);
  await fillField(editDialog, "Description", "Edited by repeatable desktop E2E");
  await editDialog.getByRole("button", { name: "保存" }).click();
  await expectText(page, skillEditedName);

  const editedRow = rowFor(page, skillEditedName);
  await editedRow.getByRole("button", { name: "copy" }).click();
  const confirm = page.locator(".confirm-dialog", { hasText: "确认 Skill 安装" });
  await confirm.waitFor();
  await expectText(
    confirm,
    join(homeDir, ".claude", "skills", skillEditedName)
  );
  await confirm.getByRole("button", { name: "确认写入" }).click();
  await confirm.waitFor({ state: "detached" });

  const installedSkill = await readFile(
    join(homeDir, ".claude", "skills", skillEditedName, "SKILL.md"),
    "utf8"
  );
  if (!installedSkill.includes("description: Repeatable desktop Extensions E2E source")) {
    throw new Error("Skill install did not copy the source SKILL.md.");
  }
}

async function syncSkillRegistryFromUi(page) {
  await page.locator("#extensions").scrollIntoViewIfNeeded();
  await page.getByLabel("Skill registry profile name").fill("Trusted Desktop Registry");
  await page.getByLabel("Skill registry URL").fill(registryPath);
  await page.getByLabel("Require signature").check();
  await page.getByLabel("Require release metadata").check();
  await page.getByLabel("Registry trusted keys").fill(`${registryPublicKeyId}=${registryPublicKey}`);
  await page.getByLabel("Registry revoked key IDs").fill("desktop-registry-2025");
  await page
    .locator("[aria-label='Skill Registry Sync']")
    .getByRole("button", { name: "保存" })
    .click();
  await expectText(page, "Registry profile 已保存");
  await page
    .getByLabel("Skill registry profile", { exact: true })
    .locator("option", { hasText: "Trusted Desktop Registry" })
    .waitFor({ state: "attached" });
  await page
    .getByLabel("Skill registry profile", { exact: true })
    .selectOption({ label: "Trusted Desktop Registry" });
  await page.locator("[aria-label='Skill Registry Sync']").getByRole("button", { name: "同步" }).click();
  const confirm = page.locator(".confirm-dialog", { hasText: "确认 Skill Registry 同步" });
  await confirm.waitFor();
  await expectText(confirm, "Skill Registry");
  await expectText(confirm, "new:1");
  await confirm.getByRole("button", { name: "确认写入" }).click();
  await confirm.waitFor({ state: "detached" });
  await expectText(page, registrySkillName);
  const syncedSkill = await readFile(
    join(mniuRoot, "skills", registrySkillName, "SKILL.md"),
    "utf8"
  );
  if (!syncedSkill.includes("Registry Desktop E2E Skill")) {
    throw new Error("Skill registry sync did not write the signed source.");
  }
}

async function importExtensionsViaDeepLink(page) {
  const mcpDeepLinkUrl = `mniu://import/mcp?payload=${Buffer.from(
    JSON.stringify({
      server: {
        name: mcpDeepLinkName,
        command: "node",
        args: ["--version", "--deep-link"],
        env: { SECRET: "deep-link-secret" },
        apps: ["claude"],
        enabled: true
      }
    }),
    "utf8"
  ).toString("base64url")}`;
  await page.locator("#settings").scrollIntoViewIfNeeded();
  await page.getByLabel("Deep link URL").fill(mcpDeepLinkUrl);
  await page.getByRole("button", { name: "预览导入" }).click();
  let confirm = page.locator(".confirm-dialog", { hasText: "确认 Deep Link 导入" });
  await confirm.waitFor();
  await expectText(confirm, "Deep Link MCP 导入预览");
  await confirm.getByRole("button", { name: "导入" }).click();
  await confirm.waitFor({ state: "detached" });
  await page.locator("#extensions").scrollIntoViewIfNeeded();
  await expectText(page, mcpDeepLinkName);

  const promptDeepLinkUrl = `mniu://import/prompt?payload=${Buffer.from(
    JSON.stringify({
      prompt: {
        name: promptDeepLinkName,
        content: "# Deep Link Prompt\n\nImported from mniu URL.",
        apps: ["claude"]
      }
    }),
    "utf8"
  ).toString("base64url")}`;
  await page.locator("#settings").scrollIntoViewIfNeeded();
  await page.getByLabel("Deep link URL").fill(promptDeepLinkUrl);
  await page.getByRole("button", { name: "预览导入" }).click();
  confirm = page.locator(".confirm-dialog", { hasText: "确认 Deep Link 导入" });
  await confirm.waitFor();
  await expectText(confirm, "Deep Link Prompt 导入预览");
  await confirm.getByRole("button", { name: "导入" }).click();
  await confirm.waitFor({ state: "detached" });
  await page.locator("#extensions").scrollIntoViewIfNeeded();
  await expectText(page, promptDeepLinkName);
}

async function deleteExtensionRow(page, kind, name) {
  const titles = {
    mcp: "删除 MCP",
    prompt: "删除 Prompt",
    skill: "删除 Skill"
  };
  await rowFor(page, name).locator(`button[title='${titles[kind]}']`).click();
  const confirm = page.locator(".confirm-dialog", { hasText: titles[kind] });
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "删除" }).click();
  await confirm.waitFor({ state: "detached" });
  await page.locator(".extension-row", { hasText: name }).waitFor({ state: "detached" });
}

function rowFor(page, text) {
  return page.locator(".extension-row", { hasText: text }).first();
}

async function fillField(container, label, value) {
  const field = container.locator("label", { hasText: label }).locator("input, textarea").first();
  await field.fill(value);
}

async function clickButtonTitle(page, title) {
  await page.locator(`button[title='${title}']`).click();
}

async function expectText(scope, text) {
  await scope.getByText(text, { exact: false }).first().waitFor();
}

async function seedSkillSource() {
  await mkdir(skillSourcePath, { recursive: true });
  await writeFile(
    join(skillSourcePath, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      "version: 1.0.0",
      "description: Repeatable desktop Extensions E2E source",
      "---",
      "",
      "# Desktop E2E Skill",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function seedSkillRegistry() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  registryPublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const files = [
    {
      path: "SKILL.md",
      content: [
        "---",
        `name: ${registrySkillName}`,
        "version: 1.2.0",
        "description: Registry Desktop E2E Skill",
        "---",
        "",
        "# Registry Desktop E2E Skill",
        ""
      ].join("\n")
    },
    {
      path: "notes.md",
      content: "registry sync source\n"
    }
  ];
  const sha256 = hashRegistryFiles(files);
  const entry = {
    name: registrySkillName,
    version: "1.2.0",
    description: "Registry Desktop E2E Skill",
    apps: ["claude", "codex"],
    files,
    sha256,
    publicKeyId: registryPublicKeyId
  };
  const signature = sign(null, Buffer.from(skillRegistrySignaturePayload(entry)), privateKey)
    .toString("base64");
  const registry = {
    version: 1,
    publicKeys: [{ id: registryPublicKeyId, publicKey: registryPublicKey }],
    revokedPublicKeyIds: ["desktop-registry-2025"],
    signatureAlgorithm: "ed25519",
    skills: [{ ...entry, signature }]
  };
  const releaseMetadata = {
    version: 1,
    sequence: 1,
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    registrySha256: hashRegistryReleasePayload(registry),
    publicKeyId: registryPublicKeyId
  };
  const releaseSignature = sign(
    null,
    Buffer.from(skillRegistryReleaseSignaturePayload(releaseMetadata)),
    privateKey
  ).toString("base64");
  await writeFile(
    registryPath,
    `${JSON.stringify({
      ...registry,
      releaseMetadata: { ...releaseMetadata, signature: releaseSignature }
    }, null, 2)}\n`,
    "utf8"
  );
}

function hashRegistryFiles(files) {
  const hash = createHash("sha256");
  for (const file of files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(Buffer.from(file.content, "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function skillRegistrySignaturePayload(entry) {
  return JSON.stringify({
    name: entry.name,
    version: entry.version,
    description: entry.description ?? "",
    apps: entry.apps.slice().sort(),
    sha256: entry.sha256
  });
}

function hashRegistryReleasePayload(registry) {
  return createHash("sha256")
    .update(skillRegistryReleasePayload(registry))
    .digest("hex");
}

function skillRegistryReleasePayload(registry) {
  return JSON.stringify({
    version: registry.version,
    publicKey: registry.publicKey ?? "",
    publicKeys: (registry.publicKeys ?? [])
      .map((key) => ({
        id: key.id,
        publicKey: key.publicKey,
        status: key.status ?? "active"
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    revokedPublicKeyIds: Array.from(new Set(registry.revokedPublicKeyIds ?? [])).sort(),
    signatureAlgorithm: registry.signatureAlgorithm ?? "",
    skills: registry.skills
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        description: entry.description ?? "",
        apps: (entry.apps?.length ? entry.apps : ["claude", "codex"]).slice().sort(),
        sha256: entry.sha256,
        signature: entry.signature ?? "",
        publicKeyId: entry.publicKeyId ?? ""
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  });
}

function skillRegistryReleaseSignaturePayload(metadata) {
  return JSON.stringify({
    version: metadata.version,
    sequence: metadata.sequence,
    issuedAt: metadata.issuedAt,
    expiresAt: metadata.expiresAt ?? "",
    registrySha256: metadata.registrySha256
  });
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
