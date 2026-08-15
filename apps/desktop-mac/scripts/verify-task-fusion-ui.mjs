import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const evidenceDir = join(repoRoot, ".gdp-state", "mniu-ccswitch-redesign", "evidence");
const screenshotPath =
  process.env.MN_DESKTOP_TASK_FUSION_SCREENSHOT ??
  join(evidenceDir, "desktop-task-fusion.png");
const keepTemp = process.env.MN_DESKTOP_E2E_KEEP_TEMP === "1";

const chromeExecutable = resolveChromeExecutable();
const tempRoot = await mkdtemp(join(tmpdir(), "mn-desktop-task-fusion-"));
const homeDir = join(tempRoot, "home");
const mniuRoot = join(tempRoot, "mniu");
const worktreesRoot = join(tempRoot, "worktrees");
const demoRoot = join(tempRoot, "demo-repo");

const apiPort = await freePort();
const vitePort = await freePort();
const proxyPort = await freePort();
const upstreamPort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${vitePort}`;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

const children = [];
let browser;
let upstream;

try {
  await mkdir(evidenceDir, { recursive: true });
  await seedDemoRepo();
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
  const approvedSpecRef = await seedApprovedSpec();

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
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => {
    console.error(`desktop page error: ${error.stack ?? error.message}`);
  });

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  // App bootstrap intentionally refreshes once after the desktop daemon retry.
  // Let that replacement render settle before interacting with tab controls.
  await delay(1_800);
  await page.getByRole("tab", { name: "Codex" }).click();
  await page.locator("#tasks").scrollIntoViewIfNeeded();
  await expectText(page, "任务闭环");
  await expectText(page, "Workflow & Harness");
  await expectText(page, "runnable gates");
  if (await page.getByLabel("Workflow").inputValue() !== "classic-v1") {
    throw new Error("Desktop workflow selection did not consume classic-v1 capability.");
  }
  await fillField(page, "Project root", demoRoot);
  await fillField(page, "Candidates", "1");
  await fillField(page, "Title", "Desktop task fusion smoke");
  await fillField(page, "Prompt", "Make no changes. Verify the desktop task fusion path.");
  await fillField(page, "Acceptance", "unit tests and typecheck pass");
  const runResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && /\/v1\/tasks\/[^/]+\/runs$/.test(url.pathname);
  });
  await page.getByRole("button", { name: "运行任务" }).click();
  const runRecord = await (await runResponsePromise).json();

  await expectText(page, "Run completed");
  await expectText(page, "Run Detail");
  await expectText(page, "codex-1");
  await expectText(page, "unit_test: pass");
  await expectText(page, "typecheck: pass");
  await expectText(page, "llm_verifier: pass");
  await expectText(page, "Mock codex executor completed candidate codex-1");
  await expectText(page, "Governance & Policy Explain");
  await expectText(page, "requiredGates");
  await seedRunWorkers(runRecord.id);
  const workerPanel = page.getByLabel("Worker fleet");
  await workerPanel.getByTitle("刷新 worker fleet").click();
  await expectText(workerPanel, "desktop-worker-a");
  await expectText(workerPanel, "desktop-worker-idle");
  await expectText(workerPanel, "running");
  await expectText(workerPanel, "idle");
  await expectText(workerPanel, "1/2 slots");
  await expectText(workerPanel, "0/1 slots");
  await expectText(workerPanel, runRecord.id.slice(0, 8));
  await page.getByTitle("打开 candidate workspace").first().click();
  await expectText(page, "Workspace path:");
  await expectText(page, "codex-1");
  await expectText(page, "Run Artifacts");
  await expectText(page, "codex-1 stdout");
  await page.getByLabel("Artifact candidate filter").selectOption("codex-1");
  await page.getByLabel("Artifact kind filter").selectOption("log");
  await page.getByLabel("Artifact persisted filter").selectOption("persisted");
  await expectText(page, "1 files");
  await page.getByTitle("下载 artifact codex-1:stdout").click();
  await expectText(page, "Artifact downloaded: stdout.txt");
  const artifactPreview = page.getByLabel("Artifact preview");
  await expectText(artifactPreview, "stdout.txt");
  await expectText(artifactPreview, "mock codex completed");
  await page.getByTitle("下载全部 artifacts").click();
  await expectText(page, "Artifacts archive downloaded:");
  await expectText(artifactPreview, "artifacts.tar");
  await expectText(page, "Artifact Store");
  await expectText(page, "persisted");
  const artifactStorePanel = page.getByLabel("Artifact store");
  await page.getByLabel("Keep latest runs").fill("0");
  await artifactStorePanel.getByRole("button", { name: "预览清理" }).click();
  await expectText(page, "1 candidates");
  await expectText(page, "outside latest 0 runs");
  page.once("dialog", (dialog) => dialog.accept());
  await artifactStorePanel.getByRole("button", { name: "确认清理" }).click();
  await expectText(page, "Artifact store cleanup: 1 deleted");
  await expectText(page, "0 runs");

  await seedRunUsage(runRecord.id);
  await page.getByRole("button", { name: new RegExp(runRecord.id.slice(0, 8)) }).click();
  await expectText(page, "Run Usage");
  await expectText(page, "16 tok");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTitle("清理 workspaces").click();
  await expectText(page, "Workspace cleanup completed");

  await writeDemoPackageJson({
    test: "node -e \"setInterval(() => console.log('waiting for cancel'), 1000)\"",
    typecheck: "node -e \"console.log('typecheck ok')\"",
    lint: "node -e \"console.log('lint ok')\""
  });
  await fillField(page, "Title", "Desktop task fusion cancel");
  await page.getByRole("button", { name: "运行任务" }).click();
  await expectText(page, "Run queued");
  await page.getByTitle("取消 run").click();
  await expectText(page, "Run cancelled");
  await expectText(page, "cancelled");

  await writeDemoPackageJson({
    test: "node -e \"console.log('resume unit ok')\"",
    typecheck: "node -e \"console.log('typecheck ok')\"",
    lint: "node -e \"console.log('lint ok')\""
  });
  const resumeResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && /\/v1\/runs\/[^/]+\/resume$/.test(url.pathname);
  });
  await page.getByTitle("恢复 run").click();
  const resumedRun = await (await resumeResponsePromise).json();
  if (!resumedRun.resumedFromRunId || resumedRun.resumedFromRunId === resumedRun.run?.id) {
    throw new Error(`Unexpected resume response: ${JSON.stringify(resumedRun)}`);
  }
  await expectText(page, "Run resumed");
  await expectText(page, "Run completed");

  await page.getByLabel("Workflow").selectOption("governed-increment-v1");
  await expectText(page, "Harness profile");
  await page.getByLabel("Approved Spec").selectOption(
    `${approvedSpecRef.specSetId}@${approvedSpecRef.revision}`
  );
  const specValidationResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
      response.url().includes(`/v1/spec-sets/${approvedSpecRef.specSetId}/revisions/${approvedSpecRef.revision}`)
  );
  await page.getByRole("button", { name: "验证 Spec" }).click();
  const validatedSpec = await specValidationResponse;
  if (!validatedSpec.ok()) {
    throw new Error(`Spec validation failed: ${validatedSpec.status()} ${await validatedSpec.text()}`);
  }
  await expectText(page, `r${approvedSpecRef.revision} · approved`);

  const governedRun = await buildGovernedRunFixture(runRecord.id, approvedSpecRef);
  await page.route(`${apiUrl}/v1/runs/${runRecord.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(governedRun)
    });
  });
  const governedDetailResponse = page.waitForResponse((response) =>
    response.url() === `${apiUrl}/v1/runs/${runRecord.id}` &&
      response.request().method() === "GET"
  );
  await page.getByRole("button", { name: new RegExp(runRecord.id.slice(0, 8)) }).click();
  const governedDetailBody = await (await governedDetailResponse).json();
  if (!governedDetailBody.stages?.length || !governedDetailBody.gateResultsV2?.length) {
    throw new Error(`Governed run fixture was not loaded: ${JSON.stringify(governedDetailBody)}`);
  }
  const governedDetail = page.getByLabel("Governed run detail", { exact: true });
  await expectText(governedDetail, "Governed Increment");
  await expectText(governedDetail, "Discovery");
  await expectText(governedDetail, "Harness Manifest");
  await expectText(governedDetail, "acceptance_coverage");
  await expectText(governedDetail, "Evidence Trace");
  await expectText(page.getByLabel("Effective governance"), "Desktop governed fixture");

  await page.locator("#tasks").scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.setViewportSize({ width: 390, height: 920 });
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#tasks").scrollIntoViewIfNeeded();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  if (hasHorizontalOverflow) {
    throw new Error("Task fusion layout overflows horizontally on mobile viewport.");
  }

  console.log(JSON.stringify({
    ok: true,
    apiUrl,
    appUrl,
    demoRoot,
    homeDir,
    mniuRoot,
    screenshotPath,
    preservedTemp: keepTemp
  }, null, 2));
} finally {
  if (browser) await browser.close();
  if (upstream) await new Promise((resolveClose) => upstream.close(resolveClose));
  await Promise.all(children.reverse().map((child) => stopProcess(child)));
  if (!keepTemp) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function seedApprovedSpec() {
  const { digestSpecRevision } = await import(
    pathToFileURL(join(repoRoot, "packages", "specs", "dist", "index.js")).href
  );
  const unsigned = {
    specSetId: "desktop-governed-fixture",
    revision: 1,
    status: "draft",
    source: "native",
    title: "Desktop governed fixture",
    hypothesis: "Capability-driven Task Fusion exposes governed evidence.",
    outcomes: ["The desktop renders immutable governed run bindings."],
    nonGoals: ["Production deployment is excluded."],
    targetServices: [],
    contracts: {
      interface: {},
      data: {},
      state: {},
      permission: {},
      exception: {},
      quality: {},
      observability: {}
    },
    acceptanceCases: [{
      id: "desktop-evidence",
      kind: "positive",
      title: "Governed evidence is visible",
      given: ["An approved Spec revision is bound."],
      when: "The run detail is opened.",
      then: ["Stages, GateResultV2 and trace evidence are visible."]
    }],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "desktop-fixture"
  };
  const draft = { ...unsigned, digest: digestSpecRevision(unsigned) };
  await postJson(`${apiUrl}/v1/spec-sets`, {
    specSet: {
      id: draft.specSetId,
      title: draft.title,
      latestRevision: 0,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt
    },
    initialRevision: draft
  });
  const approved = await postJson(
    `${apiUrl}/v1/spec-sets/${draft.specSetId}/revisions/1/approve`,
    {
      approvedBy: "desktop-reviewer",
      approvedAt: "2026-07-11T01:00:00.000Z"
    }
  );
  return {
    specSetId: approved.specSetId,
    revision: approved.revision,
    digest: approved.digest
  };
}

async function buildGovernedRunFixture(runId, specRef) {
  const [run, capabilities] = await Promise.all([
    getJson(`${apiUrl}/v1/runs/${runId}`),
    getJson(`${apiUrl}/v1/capabilities`)
  ]);
  const workflow = capabilities.workflows.find(
    (item) => item.id === "governed-increment-v1"
  );
  const profile = capabilities.harnessProfiles.find((item) => item.id === "local");
  if (!workflow?.digest || !profile?.digest) {
    throw new Error("Governed workflow or local harness profile capability is unavailable.");
  }
  const workflowRef = {
    id: workflow.id,
    version: workflow.version,
    digest: workflow.digest
  };
  const harnessProfileRef = {
    id: profile.id,
    version: profile.version,
    digest: profile.digest
  };
  const query = new URLSearchParams({
    specSetId: specRef.specSetId,
    specRevision: String(specRef.revision),
    workflowId: workflowRef.id,
    workflowVersion: workflowRef.version,
    workflowDigest: workflowRef.digest,
    harnessProfileId: harnessProfileRef.id,
    harnessProfileVersion: harnessProfileRef.version,
    harnessProfileDigest: harnessProfileRef.digest
  });
  const governance = await getJson(
    `${apiUrl}/v1/projects/${run.projectId}/effective-governance?${query}`
  );
  const startedAt = "2026-07-11T02:00:00.000Z";
  const finishedAt = "2026-07-11T02:00:01.000Z";
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const budgetUsage = {
    durationSeconds: 1,
    tokens: 128,
    costUsd: 0.01,
    repairAttempts: 0,
    changedFiles: 1,
    changedLines: 3
  };
  const stage = (name, attempt, status = "completed") => ({
    id: `${runId}:${name}:${attempt}`,
    runId,
    stage: name,
    attempt,
    status,
    inputArtifacts: [],
    outputArtifacts: [],
    inputDigest: digestA,
    outputDigest: digestB,
    budgetUsage,
    startedAt,
    finishedAt
  });
  return {
    ...run,
    status: "completed",
    workflowRef,
    governanceSnapshot: governance.snapshot,
    harnessManifest: {
      schemaVersion: 1,
      generatedAt: startedAt,
      profile: harnessProfileRef,
      task: { taskId: run.taskId, projectRoot: demoRoot },
      specRef,
      governanceDigest: governance.snapshot.digest,
      selectedServices: [],
      languageByService: {},
      gatePlan: [{
        id: "acceptance_coverage",
        runnerId: "builtin/acceptance-coverage",
        runnerVersion: "2",
        languages: ["*"],
        required: true
      }],
      sandbox: {
        backendId: "local-worktree-postcheck",
        backendVersion: "1",
        enforcement: "postcheck",
        capabilities: ["source-isolation"]
      },
      context: {
        usedBytes: 120,
        usedTokens: 30,
        maxBytes: 10_000,
        maxTokens: 2_500,
        digest: digestA,
        fragments: [{ id: "project", source: ".mn/project.yaml", digest: digestB }],
        omitted: []
      },
      stopConditions: governance.snapshot.policy.budgets,
      outputSchema: "mn/evidence-v2",
      digest: digestB
    },
    stages: [
      stage("discovery", 1),
      stage("specification", 1),
      stage("impact_architecture", 1),
      stage("implementation", 1),
      stage("verification", 1),
      stage("approval_demo", 1),
      stage("learning", 1)
    ],
    gateResultsV2: [{
      schemaVersion: 2,
      id: "desktop-gate-evidence",
      runId,
      candidateId: "codex-1",
      gateId: "acceptance_coverage",
      runnerId: "builtin/acceptance-coverage",
      runnerVersion: "2",
      required: true,
      status: "pass",
      summary: "Every acceptance clause has fresh evidence.",
      specClauseIds: ["desktop-evidence"],
      tool: { id: "mn-policy-gates", version: "2" },
      workingDirectory: demoRoot,
      exitCode: 0,
      inputDigest: digestA,
      outputDigest: digestB,
      artifacts: [{
        id: "desktop-junit",
        kind: "junit",
        contentType: "application/xml",
        digest: digestB,
        byteLength: 128
      }],
      startedAt,
      finishedAt,
      freshUntil: "2026-07-12T02:00:01.000Z"
    }],
    verificationEvidence: [{
      stageAttemptId: `${runId}:verification:1`,
      gateResultIds: ["desktop-gate-evidence"]
    }],
    budgetUsage,
    trace: {
      traceId: "desktop-governed-trace",
      specDigest: specRef.digest,
      governanceDigest: governance.snapshot.digest,
      harnessDigest: digestB,
      evidenceIds: ["desktop-gate-evidence"]
    },
    updatedAt: finishedAt
  };
}

async function seedDemoRepo() {
  await mkdir(join(demoRoot, "src"), { recursive: true });
  await writeDemoPackageJson({
    test: "node -e \"console.log('unit ok')\"",
    typecheck: "node -e \"console.log('typecheck ok')\"",
    lint: "node -e \"console.log('lint ok')\""
  });
  await writeFile(
    join(demoRoot, "src", "index.js"),
    "export const ok = true;\n",
    "utf8"
  );
}

async function writeDemoPackageJson(scripts) {
  await writeFile(
    join(demoRoot, "package.json"),
    JSON.stringify(
      {
        name: "desktop-task-fusion-demo",
        version: "1.0.0",
        type: "module",
        scripts
      },
      null,
      2
    ),
    "utf8"
  );
}

async function startUpstream(port) {
  const server = createHttpServer(async (request, response) => {
    if (request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    await readRequestBody(request);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "resp-task-usage",
        object: "response",
        model: "task-usage-model",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "task usage ok" }]
          }
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16
        }
      }));
  });
  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  return server;
}

async function seedRunUsage(runId) {
  await postJson(`${apiUrl}/v1/providers`, {
    app: "codex",
    name: "Task Fusion Usage Provider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: upstreamUrl,
    defaultModel: "task-usage-model",
    apiKey: "test-key",
    enabled: true,
    modelCatalog: [
      {
        id: "task-usage-model",
        displayName: "Task Usage Model",
        inputTokenUsdPerMillion: 1,
        outputTokenUsdPerMillion: 2
      }
    ]
  });
  await postJson(`${apiUrl}/v1/proxy/start`, { port: proxyPort });
  await postJson(`${proxyUrl}/v1/responses`, {
    model: "task-usage-model",
    input: "Generate one task-fusion usage event"
  }, {
    "x-mn-app": "codex",
    "x-mn-run-id": runId,
    "x-mn-candidate-id": "codex-1"
  });
  await postJson(`${apiUrl}/v1/proxy/stop`, {});

  const usage = await getJson(`${apiUrl}/v1/usage/summary?runId=${encodeURIComponent(runId)}`);
  if (usage.summary?.requestCount !== 1 || usage.summary?.totalTokens !== 16) {
    throw new Error(`Expected run usage for ${runId}, got ${JSON.stringify(usage)}`);
  }
}

async function seedRunWorkers(runId) {
  await postJson(`${apiUrl}/v1/run-jobs/workers/heartbeat`, {
    ownerId: "desktop-worker-a",
    status: "running",
    activeRunId: runId,
    capacity: 2,
    ttlMs: 60_000
  });
  await postJson(`${apiUrl}/v1/run-jobs/workers/heartbeat`, {
    ownerId: "desktop-worker-idle",
    status: "idle",
    ttlMs: 60_000
  });

  const workers = await getJson(`${apiUrl}/v1/run-jobs/workers`);
  if (workers.summary?.running !== 1 || workers.summary?.idle !== 1) {
    throw new Error(`Expected seeded workers, got ${JSON.stringify(workers)}`);
  }
  if (workers.summary?.capacity !== 3 || workers.summary?.availableSlots !== 2) {
    throw new Error(`Expected seeded worker capacity, got ${JSON.stringify(workers)}`);
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

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function fillField(container, label, value) {
  const field = container.locator("label", { hasText: label }).locator("input, textarea").first();
  await field.fill(value);
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
