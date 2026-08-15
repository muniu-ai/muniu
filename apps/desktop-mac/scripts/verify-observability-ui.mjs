import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const evidenceDir = join(repoRoot, ".gdp-state", "mniu-ccswitch-redesign", "evidence");
const screenshotPath =
  process.env.MN_DESKTOP_OBSERVABILITY_SCREENSHOT ??
  join(evidenceDir, "desktop-observability.png");
const keepTemp = process.env.MN_DESKTOP_E2E_KEEP_TEMP === "1";

const chromeExecutable = resolveChromeExecutable();
const tempRoot = await mkdtemp(join(tmpdir(), "mn-desktop-observability-"));
const homeDir = join(tempRoot, "home");
const mniuRoot = join(tempRoot, "mniu");
const worktreesRoot = join(tempRoot, "worktrees");

const apiPort = await freePort();
const vitePort = await freePort();
const proxyPort = await freePort();
const upstreamPort = await freePort();
const failedUpstreamPort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${vitePort}`;
const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
const failedUpstreamUrl = `http://127.0.0.1:${failedUpstreamPort}`;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;

const children = [];
let browser;
let upstream;

try {
  await mkdir(evidenceDir, { recursive: true });
  await seedSession();
  upstream = await startUpstream(upstreamPort);

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
  await seedProviderAndProxyLog();
  await assertObservabilitySeeded();

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
  await selectCodex(page);
  await page.locator("#providers").scrollIntoViewIfNeeded();
  const providerRow = page.locator(".provider-row", { hasText: "Observability Provider" }).first();
  await providerRow.locator("button[title='测速 Observability Provider']").click();
  await providerRow.locator(".provider-probe-result", { hasText: "200" }).waitFor();
  await expectText(providerRow, "ms");
  await exerciseProxyTakeover(page);
  await exerciseProviderCrud(page);
  await exerciseProviderImportExport(page);
  await page.locator("#observability").scrollIntoViewIfNeeded();
  await expectText(page, "观测");
  await expectText(page, "Usage");
  await expectText(page, "Sessions");
  await expectText(page, "Proxy Logs");
  await expectText(page, "Proxy Health");
  await expectText(page, "Observability Provider");
  await expectText(page, "healthy");
  await expectText(page, "Circuit Provider");
  await expectText(page, "circuit open");
  const circuitHealthRow = page.locator(".proxy-health-row", { hasText: "Circuit Provider" }).first();
  await circuitHealthRow.locator("button[title='重置 Circuit Provider health']").click();
  await expectText(page, "Proxy health reset: Circuit Provider (1)");
  await expectText(circuitHealthRow, "unknown");
  await expectText(circuitHealthRow, "0 fail");
  await expectText(page, "obs-model");
  await expectText(page, "tools get_weather:readonly");
  await expectText(page, "Desktop observability run");
  await expectText(page, "本地 session 内容");
  await expectText(page, "/Users/<user>");
  await expectText(page, "Bearer ****");
  assertRedactedSessionExport(await downloadSessionExport(page));
  await page.getByLabel("Redact sessions").uncheck();
  await expectText(page, "/Users/alice");
  await expectText(page, "Bearer abcdef123456");
  assertRawSessionExport(await downloadSessionExport(page));
  await page.getByLabel("Redact sessions").check();
  await expectText(page, "/Users/<user>");
  await expectText(page, "Bearer ****");
  await page.getByTitle("下一页").click();
  await expectText(page, "Older session 8");
  await page.getByLabel("Search sessions").fill("rare needle");
  await page.getByTitle("搜索 session").click();
  await expectText(page, "Rare needle session");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.setViewportSize({ width: 390, height: 920 });
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await selectCodex(page);
  await page.locator("#observability").scrollIntoViewIfNeeded();
  await expectText(page, "Proxy Logs");
  // Vite injects the development stylesheet immediately after DOM content on
  // some Chromium runs. Validate the settled responsive layout rather than a
  // one-frame pre-media-query width, while still failing with element-level
  // diagnostics if the overflow persists.
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    undefined,
    { timeout: 5_000 }
  ).catch(() => undefined);
  const horizontalOverflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const documentWidth = document.documentElement.scrollWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          parentClassName:
            typeof element.parentElement?.className === "string"
              ? element.parentElement.className
              : "",
          grandparentClassName:
            typeof element.parentElement?.parentElement?.className === "string"
              ? element.parentElement.parentElement.className
              : "",
          text: (element.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 120),
          left: Math.round(rectangle.left),
          right: Math.round(rectangle.right),
          width: Math.round(rectangle.width),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth
        };
      })
      .filter((element) => element.right > viewportWidth + 1 || element.left < -1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 12);
    return { viewportWidth, documentWidth, offenders };
  });
  if (horizontalOverflow.documentWidth > horizontalOverflow.viewportWidth + 1) {
    throw new Error(
      `Observability layout overflows horizontally on mobile viewport: ${JSON.stringify(horizontalOverflow)}`
    );
  }

  console.log(JSON.stringify({
    ok: true,
    apiUrl,
    appUrl,
    proxyUrl,
    homeDir,
    mniuRoot,
    screenshotPath,
    preservedTemp: keepTemp
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await Promise.all(children.reverse().map((child) => stopProcess(child)));
  if (upstream) {
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
  if (!keepTemp) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function exerciseProviderCrud(page) {
  const providersPanel = page.locator("#providers");
  await providersPanel.getByRole("button", { name: "新增" }).click();
  let dialog = page.getByRole("dialog", { name: "新增 Provider" });
  await fillLabeled(dialog, "名称", "Desktop CRUD Provider");
  await fillLabeled(dialog, "Base URL", upstreamUrl);
  await fillLabeled(dialog, "Default model", "crud-model");
  await dialog.getByRole("button", { name: "新增 Model" }).click();
  await fillLabeled(dialog, "Model ID", "crud-model");
  await fillLabeled(dialog, "Display name", "CRUD Model");
  await fillLabeled(dialog, "Context", "64000");
  await fillLabeled(dialog, "Input $/M", "1.25");
  await fillLabeled(dialog, "Output $/M", "2.5");
  await fillLabeled(dialog, "Cached input $/M", "0.5");
  await fillLabeled(dialog, "Cache create $/M", "0.75");
  await fillLabeled(dialog, "Cache read $/M", "0.25");
  await fillLabeled(dialog, "Reasoning output $/M", "4.5");
  await fillLabeled(dialog, "Failure threshold", "2");
  await fillLabeled(dialog, "Circuit open ms", "120000");
  await dialog.getByRole("checkbox", { name: "Replay tool calls" }).check();
  await fillLabeled(dialog, "Readonly tools", "get_weather, list_models");
  await fillLabeled(dialog, "Idempotent tools", "cache_lookup");
  await fillLabeled(dialog, "Side-effect tools", "write_file");
  await fillLabeled(dialog, "API key env", "");
  await fillLabeled(dialog, "API key", "crud-key");
  await dialog.getByRole("button", { name: "保存" }).click();

  const createdRow = page.locator(".provider-row", { hasText: "Desktop CRUD Provider" }).first();
  await createdRow.waitFor();
  await assertProviderHealthPolicy("Desktop CRUD Provider", 2, 120000);
  await assertProviderReplayToolCalls("Desktop CRUD Provider", true);
  await assertProviderToolReplayPolicy("Desktop CRUD Provider", {
    get_weather: "readonly",
    list_models: "readonly",
    cache_lookup: "idempotent",
    write_file: "side_effect"
  });
  await assertProviderModelCatalog("Desktop CRUD Provider", {
    id: "crud-model",
    displayName: "CRUD Model",
    contextWindow: 64000,
    inputTokenUsdPerMillion: 1.25,
    outputTokenUsdPerMillion: 2.5,
    cachedInputTokenUsdPerMillion: 0.5,
    cacheCreationInputTokenUsdPerMillion: 0.75,
    cacheReadInputTokenUsdPerMillion: 0.25,
    reasoningOutputTokenUsdPerMillion: 4.5
  });
  await createdRow.locator("button[title='编辑 Desktop CRUD Provider']").click();
  dialog = page.getByRole("dialog", { name: "编辑 Provider" });
  await expectLabeledValue(dialog, "Model ID", "crud-model");
  await expectLabeledValue(dialog, "Display name", "CRUD Model");
  await expectLabeledValue(dialog, "Context", "64000");
  await expectLabeledValue(dialog, "Input $/M", "1.25");
  await expectLabeledValue(dialog, "Output $/M", "2.5");
  await expectLabeledValue(dialog, "Cached input $/M", "0.5");
  await expectLabeledValue(dialog, "Cache create $/M", "0.75");
  await expectLabeledValue(dialog, "Cache read $/M", "0.25");
  await expectLabeledValue(dialog, "Reasoning output $/M", "4.5");
  await expectLabeledValue(dialog, "Failure threshold", "2");
  await expectLabeledValue(dialog, "Circuit open ms", "120000");
  await expectLabeledValue(dialog, "Readonly tools", "get_weather, list_models");
  await expectLabeledValue(dialog, "Idempotent tools", "cache_lookup");
  await expectLabeledValue(dialog, "Side-effect tools", "write_file");
  if (!(await dialog.getByRole("checkbox", { name: "Replay tool calls" }).isChecked())) {
    throw new Error("Expected Replay tool calls to be checked after provider edit backfill.");
  }
  await fillLabeled(dialog, "名称", "Desktop CRUD Provider Updated");
  await fillLabeled(dialog, "Default model", "crud-model-2");
  await fillLabeled(dialog, "Model ID", "crud-model-2");
  await fillLabeled(dialog, "Display name", "CRUD Model Updated");
  await fillLabeled(dialog, "Input $/M", "1.5");
  await fillLabeled(dialog, "Output $/M", "3");
  await fillLabeled(dialog, "Cached input $/M", "0.6");
  await fillLabeled(dialog, "Cache create $/M", "0.9");
  await fillLabeled(dialog, "Cache read $/M", "0.3");
  await fillLabeled(dialog, "Reasoning output $/M", "5");
  await fillLabeled(dialog, "Failure threshold", "4");
  await fillLabeled(dialog, "Circuit open ms", "180000");
  await dialog.getByRole("checkbox", { name: "Replay tool calls" }).uncheck();
  await fillLabeled(dialog, "Readonly tools", "read_file");
  await fillLabeled(dialog, "Idempotent tools", "cache_lookup, memoize_result");
  await fillLabeled(dialog, "Side-effect tools", "");
  await dialog.getByRole("button", { name: "保存" }).click();

  const updatedRow = page
    .locator(".provider-row", { hasText: "Desktop CRUD Provider Updated" })
    .first();
  await expectText(updatedRow, "crud-model-2");
  await assertProviderHealthPolicy("Desktop CRUD Provider Updated", 4, 180000);
  await assertProviderReplayToolCalls("Desktop CRUD Provider Updated", false);
  await assertProviderToolReplayPolicy("Desktop CRUD Provider Updated", {
    read_file: "readonly",
    cache_lookup: "idempotent",
    memoize_result: "idempotent"
  });
  await assertProviderModelCatalog("Desktop CRUD Provider Updated", {
    id: "crud-model-2",
    displayName: "CRUD Model Updated",
    contextWindow: 64000,
    inputTokenUsdPerMillion: 1.5,
    outputTokenUsdPerMillion: 3,
    cachedInputTokenUsdPerMillion: 0.6,
    cacheCreationInputTokenUsdPerMillion: 0.9,
    cacheReadInputTokenUsdPerMillion: 0.3,
    reasoningOutputTokenUsdPerMillion: 5
  });

  await updatedRow.locator("button[title='复制 Desktop CRUD Provider Updated']").click();
  const copyRow = page
    .locator(".provider-row", { hasText: "Desktop CRUD Provider Updated Copy" })
    .first();
  await copyRow.waitFor();

  await copyRow.locator("button[title='删除 Desktop CRUD Provider Updated Copy']").click();
  dialog = page.getByRole("dialog", { name: "删除 Provider" });
  await dialog.getByRole("button", { name: "删除" }).click();
  await copyRow.waitFor({ state: "detached" });

  await updatedRow.locator("button[title='启用 Desktop CRUD Provider Updated']").click();
  dialog = page.getByRole("dialog", { name: "确认 Provider 启用" });
  await expectText(dialog, "配置变更预览");
  await expectText(dialog, ".codex/config.toml");
  await expectText(dialog, "Before");
  await expectText(dialog, "After");
  if ((await dialog.textContent()).includes("desktop-crud-secret")) {
    throw new Error("Provider diff leaked the API key");
  }
  await dialog.getByRole("button", { name: "启用" }).click();
  await updatedRow.locator(".state-tag", { hasText: "已启用" }).waitFor();

  await updatedRow.locator("button[title='恢复 Desktop CRUD Provider Updated 启用前配置']").click();
  dialog = page.getByRole("dialog", { name: "恢复 Provider 配置" });
  await expectText(dialog, "将恢复启用前的配置");
  await dialog.getByRole("button", { name: "恢复" }).click();
  await updatedRow.locator(".state-tag", { hasText: "openai_compatible" }).waitFor();
  if (existsSync(join(homeDir, ".codex", "config.toml"))) {
    throw new Error("Provider restore did not remove the generated Codex config.");
  }
}

async function exerciseProviderImportExport(page) {
  const providersPanel = page.locator("#providers");
  await providersPanel.getByRole("button", { name: "导出" }).click();
  await expectText(page, "Provider 导出已下载");

  const importPath = join(tempRoot, "provider-import.json");
  await writeFile(
    importPath,
    `${JSON.stringify({
      version: 1,
      providers: [
        {
          app: "codex",
          name: "Desktop Imported Provider",
          kind: "openai_compatible",
          apiFormat: "openai_chat",
          baseUrl: upstreamUrl,
          defaultModel: "imported-ui-model",
          wireApi: "chat",
          apiKeyEnv: "DESKTOP_IMPORTED_PROVIDER_KEY"
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  await providersPanel.locator("input[type='file']").setInputFiles(importPath);
  const dialog = page.getByRole("dialog", { name: "确认 Provider 导入" });
  await expectText(dialog, "1 个可导入");
  await dialog.getByRole("button", { name: "导入" }).click();
  await page
    .locator(".provider-row", { hasText: "Desktop Imported Provider" })
    .first()
    .waitFor();

  const deepLinkPayload = {
    provider: {
      app: "codex",
      name: "Desktop Deep Link Provider",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: upstreamUrl,
      defaultModel: "deep-link-ui-model",
      wireApi: "chat",
      apiKeyEnv: "DESKTOP_DEEP_LINK_PROVIDER_KEY"
    }
  };
  const deepLinkUrl = `mniu://import/provider?payload=${Buffer.from(
    JSON.stringify(deepLinkPayload),
    "utf8"
  ).toString("base64url")}`;
  await page.locator("#settings").scrollIntoViewIfNeeded();
  await page.getByLabel("Deep link URL").fill(deepLinkUrl);
  await page.getByRole("button", { name: "预览导入" }).click();
  const deepLinkDialog = page.getByRole("dialog", { name: "确认 Deep Link 导入" });
  await expectText(deepLinkDialog, "1 个可导入");
  await deepLinkDialog.getByRole("button", { name: "导入" }).click();
  await page.locator("#providers").scrollIntoViewIfNeeded();
  await page
    .locator(".provider-row", { hasText: "Desktop Deep Link Provider" })
    .first()
    .waitFor();
}

async function downloadSessionExport(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("button[title='导出 session']").click()
  ]);
  const path = await download.path();
  if (!path) {
    throw new Error("Session export download did not produce a local path.");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function assertRedactedSessionExport(document) {
  if (document.kind !== "mniu.session.export" || document.redacted !== true) {
    throw new Error(`Expected redacted session export, got ${JSON.stringify(document)}`);
  }
  const serialized = JSON.stringify(document.session);
  if (!serialized.includes("/Users/<user>") || !serialized.includes("Bearer ****")) {
    throw new Error(`Redacted export is missing masked values: ${serialized}`);
  }
  if (serialized.includes("/Users/alice") || serialized.includes("Bearer abcdef123456")) {
    throw new Error(`Redacted export leaked raw local content: ${serialized}`);
  }
}

function assertRawSessionExport(document) {
  if (document.kind !== "mniu.session.export" || document.redacted !== false) {
    throw new Error(`Expected raw session export, got ${JSON.stringify(document)}`);
  }
  const serialized = JSON.stringify(document.session);
  if (!serialized.includes("/Users/alice") || !serialized.includes("Bearer abcdef123456")) {
    throw new Error(`Raw export is missing original session values: ${serialized}`);
  }
}

async function seedSession() {
  const sessionDir = join(homeDir, ".codex", "sessions", "2026");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "observability.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-07-06T01:00:00.000Z",
        type: "turn_context",
          payload: { cwd: "/Users/alice/mn-observability" }
      }),
      JSON.stringify({
        timestamp: "2026-07-06T01:00:01.000Z",
        type: "user_message",
        message: {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Desktop observability run in /Users/alice/project with Bearer abcdef123456"
            }
          ]
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-06T01:00:02.000Z",
        type: "assistant_message",
        message: {
          role: "assistant",
          model: "gpt-5",
          content: [{ type: "output_text", text: "Observability panel is green" }],
          usage: {
            input_tokens: 13,
            output_tokens: 6,
            total_tokens: 19
          }
        }
      })
    ].join("\n"),
    "utf8"
  );
  for (let index = 1; index <= 9; index += 1) {
    await writeFile(
      join(sessionDir, `observability-${index}.jsonl`),
      [
        JSON.stringify({
          timestamp: `2026-07-06T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
          type: "turn_context",
          payload: { cwd: `/tmp/mn-observability/${index}` }
        }),
        JSON.stringify({
          timestamp: `2026-07-06T00:${String(59 - index).padStart(2, "0")}:01.000Z`,
          type: "user_message",
          message: {
            role: "user",
            content: [
              {
                type: "input_text",
                text: index === 9 ? "Rare needle session" : `Older session ${index}`
              }
            ]
          }
        }),
        JSON.stringify({
          timestamp: `2026-07-06T00:${String(59 - index).padStart(2, "0")}:02.000Z`,
          type: "assistant_message",
          message: {
            role: "assistant",
            model: "gpt-5",
            content: [
              {
                type: "output_text",
                text: index === 9 ? "rare needle match" : `Older response ${index}`
              }
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2
            }
          }
        })
      ].join("\n"),
      "utf8"
    );
  }
}

async function startUpstream(port) {
  const server = createHttpServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const requestBody = JSON.parse((await readRequestBody(request)).toString("utf8")) ?? {};
    if (JSON.stringify(requestBody).includes("Call proxy tool metadata")) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({
          id: "chatcmpl-observability-tool",
          object: "chat.completion",
          model: "obs-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_weather",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: "{\"city\":\"Hangzhou\"}"
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: {
            prompt_tokens: 13,
            completion_tokens: 7,
            total_tokens: 20
          }
        }));
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-observability",
        object: "chat.completion",
        model: "obs-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "observability ok" },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 5,
          total_tokens: 16
        }
      }));
  });
  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  return server;
}

async function seedProviderAndProxyLog() {
  const providerCreate = await postJson(`${apiUrl}/v1/providers`, {
    app: "codex",
    name: "Observability Provider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: upstreamUrl,
    defaultModel: "obs-model",
    apiKey: "test-key",
    enabled: true,
    config: {
      toolReplayPolicy: {
        tools: {
          get_weather: "readonly"
        }
      }
    },
    modelCatalog: [
      {
        id: "obs-model",
        displayName: "Observability Model",
        inputTokenUsdPerMillion: 1,
        outputTokenUsdPerMillion: 2
      }
    ]
  });
  await postJson(`${apiUrl}/v1/proxy/start`, { port: proxyPort });
  await postJson(`${proxyUrl}/v1/responses`, {
    model: "obs-model",
    input: "Generate one observability event"
  }, {
    "x-mn-app": "codex"
  });
  await postJson(`${proxyUrl}/v1/responses`, {
    model: "obs-model",
    input: "Call proxy tool metadata",
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } } }
      }
    ]
  }, {
    "x-mn-app": "codex"
  });
  if (!providerCreate.id) {
    throw new Error(`Expected provider id from create response: ${JSON.stringify(providerCreate)}`);
  }

  const failingProvider = await postJson(`${apiUrl}/v1/providers`, {
    app: "codex",
    name: "Circuit Provider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: failedUpstreamUrl,
    defaultModel: "circuit-model",
    apiKey: "test-key",
    enabled: false
  });
  const failingProviderId = failingProvider.id;
  if (!failingProviderId) {
    throw new Error(`Expected failing provider id: ${JSON.stringify(failingProvider)}`);
  }
  for (let index = 0; index < 3; index += 1) {
    await postJson(`${apiUrl}/v1/providers/${encodeURIComponent(failingProviderId)}/test-endpoint`, {
      timeoutMs: 150
    });
  }
}

async function exerciseProxyTakeover(page) {
  await page.locator("#proxy").scrollIntoViewIfNeeded();
  const takeoverButton = page.getByTitle("由本地代理接管 Codex");
  await takeoverButton.click();
  let dialog = page.getByRole("dialog", { name: "确认接管 Codex" });
  await dialog.waitFor();
  await expectText(dialog, ".codex/config.toml");
  await dialog.getByRole("button", { name: "确认写入" }).click();
  await page.getByTitle("恢复 Codex 接管前配置").waitFor();
  await expectText(page.locator("#proxy"), "taken over");

  await page.getByTitle("恢复 Codex 接管前配置").click();
  dialog = page.getByRole("dialog", { name: "确认恢复 Codex" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "确认写入" }).click();
  await page.getByTitle("由本地代理接管 Codex").waitFor();
  await expectText(page.locator("#proxy"), "direct");

  await page.getByTitle("由本地代理接管 Codex").click();
  dialog = page.getByRole("dialog", { name: "确认接管 Codex" });
  await dialog.getByRole("button", { name: "确认写入" }).click();
  await page.getByTitle("恢复 Codex 接管前配置").waitFor();
  await page.getByTitle("安全停止本地代理").click();
  dialog = page.getByRole("dialog", { name: "确认安全停止本地代理" });
  await expectText(dialog, "配置变更预览");
  await dialog.getByRole("button", { name: "确认写入" }).click();
  await page.getByTitle("启动本地代理").waitFor();
  await page.getByTitle("由本地代理接管 Codex").waitFor();
  await expectText(page.locator("#proxy"), "direct");
}

async function assertObservabilitySeeded() {
  const [logs, usage, sessions, health] = await Promise.all([
    getJson(`${apiUrl}/v1/proxy/logs?app=codex`),
    getJson(`${apiUrl}/v1/usage/summary?app=codex`),
    getJson(`${apiUrl}/v1/sessions?app=codex`),
    getJson(`${apiUrl}/v1/proxy/health?app=codex`)
  ]);

  if (!logs.logs?.some((log) => log.model === "obs-model")) {
    throw new Error(`Expected obs-model proxy log, got ${JSON.stringify(logs)}`);
  }
  if (
    !logs.logs?.some((log) =>
      log.toolCalls?.some(
        (toolCall) =>
          toolCall.name === "get_weather" &&
          toolCall.effect === "readonly" &&
          toolCall.replaySafe === true
      )
    )
  ) {
    throw new Error(`Expected get_weather readonly proxy log metadata, got ${JSON.stringify(logs)}`);
  }
  if (!usage.summary?.byModel?.some((bucket) => bucket.model === "obs-model")) {
    throw new Error(`Expected obs-model usage bucket, got ${JSON.stringify(usage)}`);
  }
  if (
    !sessions.sessions?.some((session) =>
      session.title.includes("Desktop observability run")
    )
  ) {
    throw new Error(`Expected seeded Codex session, got ${JSON.stringify(sessions)}`);
  }
  if (
    !health.health?.some(
      (row) => row.providerName === "Observability Provider" && row.state === "healthy"
    )
  ) {
    throw new Error(`Expected healthy provider row, got ${JSON.stringify(health)}`);
  }
  if (
    !health.health?.some(
      (row) => row.providerName === "Circuit Provider" && row.state === "circuit_open"
    )
  ) {
    throw new Error(`Expected circuit-open provider row, got ${JSON.stringify(health)}`);
  }
}

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function selectCodex(page) {
  await page.getByRole("tab", { name: "Codex" }).click();
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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
    const server = createNetServer();
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

async function fillLabeled(scope, label, value) {
  await (await formField(scope, label)).locator("input").fill(value);
}

async function expectLabeledValue(scope, label, value) {
  const inputValue = await (await formField(scope, label)).locator("input").inputValue();
  if (inputValue !== value) {
    throw new Error(`Expected ${label} to be ${value}, got ${inputValue}`);
  }
}

async function assertProviderHealthPolicy(name, failureThreshold, circuitOpenMs) {
  const providers = await getJson(`${apiUrl}/v1/providers?app=codex`);
  const provider = providers.providers?.find((item) => item.name === name);
  if (!provider) {
    throw new Error(`Expected provider ${name}, got ${JSON.stringify(providers)}`);
  }
  const policy = provider.config?.healthPolicy;
  if (
    policy?.failureThreshold !== failureThreshold ||
    policy?.circuitOpenMs !== circuitOpenMs
  ) {
    throw new Error(
      `Expected ${name} healthPolicy ${failureThreshold}/${circuitOpenMs}, got ${JSON.stringify(provider.config)}`
    );
  }
}

async function assertProviderReplayToolCalls(name, expected) {
  const providers = await getJson(`${apiUrl}/v1/providers?app=codex`);
  const provider = providers.providers?.find((item) => item.name === name);
  if (!provider) {
    throw new Error(`Expected provider ${name}, got ${JSON.stringify(providers)}`);
  }
  const actual = provider.config?.replayToolCalls === true;
  if (actual !== expected) {
    throw new Error(
      `Expected ${name} replayToolCalls ${expected}, got ${JSON.stringify(provider.config)}`
    );
  }
}

async function assertProviderToolReplayPolicy(name, expectedTools) {
  const providers = await getJson(`${apiUrl}/v1/providers?app=codex`);
  const provider = providers.providers?.find((item) => item.name === name);
  if (!provider) {
    throw new Error(`Expected provider ${name}, got ${JSON.stringify(providers)}`);
  }
  const actualTools = provider.config?.toolReplayPolicy?.tools ?? {};
  const expectedEntries = Object.entries(expectedTools);
  const actualEntries = Object.entries(actualTools);
  const matches =
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(([toolName, effect]) => actualTools[toolName] === effect);
  if (!matches) {
    throw new Error(
      `Expected ${name} toolReplayPolicy ${JSON.stringify(expectedTools)}, got ${JSON.stringify(provider.config)}`
    );
  }
}

async function assertProviderModelCatalog(name, expected) {
  const providers = await getJson(`${apiUrl}/v1/providers?app=codex`);
  const provider = providers.providers?.find((item) => item.name === name);
  if (!provider) {
    throw new Error(`Expected provider ${name}, got ${JSON.stringify(providers)}`);
  }
  const model = provider.modelCatalog?.find((item) => item.id === expected.id);
  if (
    !model ||
    model.displayName !== expected.displayName ||
    model.contextWindow !== expected.contextWindow ||
    model.inputTokenUsdPerMillion !== expected.inputTokenUsdPerMillion ||
    model.outputTokenUsdPerMillion !== expected.outputTokenUsdPerMillion ||
    model.cachedInputTokenUsdPerMillion !== expected.cachedInputTokenUsdPerMillion ||
    model.cacheCreationInputTokenUsdPerMillion !==
      expected.cacheCreationInputTokenUsdPerMillion ||
    model.cacheReadInputTokenUsdPerMillion !== expected.cacheReadInputTokenUsdPerMillion ||
    model.reasoningOutputTokenUsdPerMillion !== expected.reasoningOutputTokenUsdPerMillion
  ) {
    throw new Error(
      `Expected ${name} model catalog ${JSON.stringify(expected)}, got ${JSON.stringify(provider.modelCatalog)}`
    );
  }
}

async function formField(scope, label) {
  const fields = scope.locator("label.form-field");
  const count = await fields.count();
  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    const text = (await field.locator("span").first().innerText()).trim();
    if (text === label) return field;
  }
  throw new Error(`Missing form field: ${label}`);
}

async function expectText(scope, text) {
  await scope.getByText(text, { exact: false }).first().waitFor();
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
