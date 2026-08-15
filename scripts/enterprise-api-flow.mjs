import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFixtureRoot = join(workspaceRoot, "examples/microservice-repo");
const apiEntry = join(workspaceRoot, "apps/api/dist/index.js");
const cliEntry = join(workspaceRoot, "apps/cli/dist/index.js");
const tenantId =
  process.env.MN_ENTERPRISE_TENANT_ID ??
  `tenant-e2e-${process.pid}-${Date.now().toString(36)}`;
const origin = process.env.MN_ENTERPRISE_CORS_ORIGIN ?? "http://127.0.0.1:4173";
const tokenUrl = process.env.MN_ENTERPRISE_TOKEN_URL ?? "http://127.0.0.1:59080/token";
const postgresUrl =
  process.env.MN_ENTERPRISE_POSTGRES_URL ??
  process.env.MN_POSTGRES_URL ??
  "postgresql://mn:mn-e2e-only@127.0.0.1:55432/mn_enterprise";
const s3Endpoint =
  process.env.MN_ENTERPRISE_S3_ENDPOINT ??
  process.env.MN_ARTIFACT_REMOTE_STORE_ENDPOINT_URL ??
  "http://127.0.0.1:59000";
const s3Bucket =
  process.env.MN_ENTERPRISE_S3_BUCKET ??
  process.env.MN_ARTIFACT_REMOTE_STORE_BUCKET ??
  "mn-artifacts";
const otlpEndpoint =
  process.env.MN_OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:59080/otlp";
const otlpStatusUrl =
  process.env.MN_ENTERPRISE_OTEL_STATUS_URL ?? "http://127.0.0.1:59080/otlp/status";
const apiPort = Number.parseInt(process.env.MN_API_PORT ?? "17318", 10);
const apiUrl = (
  process.env.MN_ENTERPRISE_API_URL ?? `http://127.0.0.1:${apiPort}`
).replace(/\/+$/u, "");
const providerProxyUrl = process.env.MN_ENTERPRISE_PROXY_PUBLIC_BASE_URL
  ?.replace(/\/+$/u, "");
const targetExistingApi = Boolean(process.env.MN_ENTERPRISE_API_URL);
const ownerActor = "project-owner@mn-e2e.local";
const reviewerActor = "reviewer@mn-e2e.local";
const governanceActor = "governance-admin@mn-e2e.local";
const workerActor = "enterprise-e2e-worker";
const resumeWorkerActor = "enterprise-e2e-worker-resume";
const auditorActor = "auditor@mn-e2e.local";
const workerId = "enterprise-e2e-worker";
const resumeWorkerId = "enterprise-e2e-worker-resume";
let apiProcess;
let apiExited;
let stateRoot;
let interruptedSignal;
let providerUpstream;
let providerUpstreamBaseUrl;
let providerUpstreamRequestCount = 0;

function step(message) {
  console.log(`\n[enterprise-api-flow] ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function startProviderUpstream() {
  providerUpstream = createServer(async (request, response) => {
    providerUpstreamRequestCount += 1;
    for await (const _chunk of request) { /* drain governed request */ }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: "resp-enterprise-e2e",
        object: "response",
        model: "e2e-governed-model",
        output: [],
        usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 }
      })
    );
  });
  await new Promise((resolve, reject) => {
    providerUpstream.once("error", reject);
    providerUpstream.listen(0, "127.0.0.1", resolve);
  });
  const address = providerUpstream.address();
  assert.ok(address && typeof address === "object");
  providerUpstreamBaseUrl = `http://127.0.0.1:${address.port}`;
}

function externalizeGateExecution(execution, worker, canonicalDigest) {
  const results = execution.results.map((result) => {
    const artifacts = result.artifacts.map(({ path: _localPath, ...artifact }) => artifact);
    const draft = { ...result, artifacts };
    return { ...draft, outputDigest: worker.gateResultV2OutputDigest(draft) };
  });
  const legacyResults = execution.legacyResults.map((gate) => ({
    ...gate,
    evidence: gate.evidence.map((artifact) => ({
      ...artifact,
      path: `mn://gate-artifacts/${artifact.id}`
    }))
  }));
  return {
    ...execution,
    results,
    legacyResults,
    failureSignature: canonicalDigest({
      results: results.map((result) => ({
        gateId: result.gateId,
        runnerId: result.runnerId,
        runnerVersion: result.runnerVersion,
        status: result.status,
        outputDigest: result.outputDigest
      })),
      integrityFailures: []
    })
  };
}

function runtimeModule(relativePath) {
  return `${pathToFileURL(join(workspaceRoot, relativePath)).href}?enterprise-api-flow=${Date.now()}`;
}

async function ensureBuiltRuntime() {
  const required = [
    apiEntry,
    join(workspaceRoot, "packages/specs/dist/index.js"),
    join(workspaceRoot, "packages/loop/dist/index.js"),
    join(workspaceRoot, "apps/worker/dist/index.js"),
    cliEntry,
    join(workspaceRoot, "apps/api/dist/artifactRemoteStore.js")
  ];
  for (const path of required) {
    try {
      await access(path);
    } catch {
      throw new Error(
        `Built enterprise runtime is missing: ${path}. Run npm run build before this flow.`
      );
    }
  }
}

async function runProductWorkerEntry({ token, ownerId, workspaces }) {
  await mkdir(workspaces, { recursive: true });
  const args = [
    cliEntry,
    "run",
    "worker",
    "--enterprise",
    "--once",
    "--mock",
    "--mock-repair",
    "--owner",
    ownerId,
    "--capacity",
    "1",
    "--ttl-ms",
    "120000",
    "--workspace-root",
    workspaces,
    "--provider",
    "codex",
    "--language",
    "javascript",
    "--tool",
    "node",
    "--tool",
    "npm"
  ];
  const child = spawn(process.execPath, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      MN_API_URL: apiUrl,
      MN_API_TOKEN: token
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let workerTimeout;
  let result;
  try {
    result = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((resolve) => {
        workerTimeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: null, signal: "TIMEOUT" });
        }, 240_000);
        workerTimeout.unref?.();
      })
    ]);
  } finally {
    if (workerTimeout) clearTimeout(workerTimeout);
  }
  if (result.code !== 0) {
    throw new Error(
      `enterprise product worker ${ownerId} failed (${result.code ?? result.signal}): ` +
      `${stderr.slice(-8_000)}\n${stdout.slice(-8_000)}`
    );
  }
  let document;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`enterprise product worker emitted non-JSON output: ${stdout.slice(-8_000)}`, {
      cause: error
    });
  }
  return { stdout, stderr, document };
}

async function verifyProductWorkerFlow({
  project,
  approvedSpec,
  specRef,
  ownerToken,
  workerToken,
  resumeWorkerToken,
  runtime,
  fixtureRoot
}) {
  step("executing a second governed increment through the published enterprise worker CLI");
  const task = await apiRequest(ownerToken, "POST", "/v1/tasks", {
    expected: [201],
    body: {
      projectId: project.id,
      title: "Product worker Spec-Harness-Loop acceptance",
      intent: "implement",
      targetServices: ["orders", "inventory"],
      prompt: "Exercise the product enterprise worker with one bounded repair.",
      acceptanceCriteria: approvedSpec.acceptanceCases.map((item) => item.title),
      specRef,
      strategy: {
        providers: ["codex"],
        candidates: 1,
        sandbox: "isolated-worktree",
        humanApproval: "before-merge",
        timeoutSeconds: 600
      }
    }
  });
  let queued = await apiRequest(
    ownerToken,
    "POST",
    `/v1/tasks/${task.id}/runs`,
    { expected: [201], body: { queueOnly: true, queuePriority: 200 } }
  );
  step("dispatching a receipt-bound provider request through the product proxy");
  const accountingClaim = await claimRun(workerToken, queued.id);
  const usageReceipt = await apiRequest(
    workerToken,
    "POST",
    `/v1/run-jobs/queue/${queued.id}/usage-receipts`,
    {
      body: {
        ownerId: workerId,
        claimToken: accountingClaim.claimToken,
        candidateId: "codex-enterprise-journal-e2e",
        app: "codex"
      }
    }
  );
  const faultPg = new runtime.pg.Client({ connectionString: postgresUrl });
  await faultPg.connect();
  await faultPg.query(`
    CREATE OR REPLACE FUNCTION mn_e2e_fail_provider_usage_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'mn e2e simulated provider usage commit ambiguity';
    END;
    $$;
    CREATE TRIGGER mn_e2e_fail_provider_usage_insert
    BEFORE INSERT ON mn_provider_usage
    FOR EACH ROW EXECUTE FUNCTION mn_e2e_fail_provider_usage_insert();
  `);
  const providerResponse = await fetch(
    `${usageReceipt.proxyBaseUrl}/mn/usage-receipts/${encodeURIComponent(usageReceipt.receipt)}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "e2e-governed-model", input: "journal-me" })
    }
  );
  assert.equal(providerResponse.status, 503, await responseDetail(providerResponse));
  assert.equal(providerUpstreamRequestCount, 1);
  await faultPg.query(`
    DROP TRIGGER mn_e2e_fail_provider_usage_insert ON mn_provider_usage;
    DROP FUNCTION mn_e2e_fail_provider_usage_insert();
  `);
  await faultPg.end();
  step("proving startup replay from real MinIO after PostgreSQL append failure");
  await stopApi();
  await startApi(stateRoot, fixtureRoot);
  await waitForApi();
  const replayPg = new runtime.pg.Client({ connectionString: postgresUrl });
  await replayPg.connect();
  const replayed = await replayPg.query(
    `SELECT terminal_journal FROM mn_provider_usage
      WHERE tenant_id=$1 AND run_id=$2 AND candidate_id=$3`,
    [tenantId, queued.id, "codex-enterprise-journal-e2e"]
  );
  await replayPg.end();
  assert.equal(replayed.rowCount, 1);
  assert.ok(replayed.rows[0].terminal_journal.objectKey);
  assert.equal(providerUpstreamRequestCount, 1, "startup replay contacted the provider again");
  await apiRequest(
    workerToken,
    "POST",
    `/v1/run-jobs/queue/${queued.id}/release`,
    {
      body: {
        ownerId: workerId,
        claimToken: accountingClaim.claimToken,
        capacity: 1,
        ttlMs: 120_000
      }
    }
  );
  await apiRequest(ownerToken, "POST", `/v1/runs/${queued.id}/cancel`, {
    expected: [200],
    body: {}
  });
  const productTask = await apiRequest(ownerToken, "POST", "/v1/tasks", {
    expected: [201],
    body: {
      projectId: project.id,
      title: "Product worker Spec-Harness-Loop after accounting recovery",
      intent: "implement",
      targetServices: ["orders", "inventory"],
      prompt: "Exercise the product enterprise worker with one bounded repair.",
      acceptanceCriteria: approvedSpec.acceptanceCases.map((item) => item.title),
      specRef,
      strategy: {
        providers: ["codex"],
        candidates: 1,
        sandbox: "isolated-worktree",
        humanApproval: "before-merge",
        timeoutSeconds: 600
      }
    }
  });
  queued = await apiRequest(
    ownerToken,
    "POST",
    `/v1/tasks/${productTask.id}/runs`,
    { expected: [201], body: { queueOnly: true, queuePriority: 200 } }
  );
  const first = await runProductWorkerEntry({
    token: workerToken,
    ownerId: workerId,
    workspaces: join(stateRoot, "product-worker-first")
  });
  assert.match(first.stdout, /waiting_approval/u);
  assert.equal(first.document.disposition, "waiting_approval");
  assert.equal(first.document.release.item.status, "queued");
  const waiting = await apiRequest(ownerToken, "GET", `/v1/runs/${queued.id}`);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.budgetUsage.repairAttempts, 1);
  assert.ok(
    first.document.governedLoopState.attempts.every(
      (attempt) => attempt.status === "running" || attempt.budgetMeasurement
    )
  );
  assert.ok(waiting.sandboxEvidenceHistory.length > 0);
  assert.ok(
    waiting.gateResultsV2.every((gate) =>
      gate.sandboxExecution?.runtimeProof?.issuer === "mn-api"
    )
  );

  const approval = await apiRequest(
    ownerToken,
    "POST",
    `/v1/runs/${queued.id}/approve`,
    { expected: [202], body: { decision: "approve" } }
  );
  assert.equal(approval.status, "queued");
  const resumed = await runProductWorkerEntry({
    token: resumeWorkerToken,
    ownerId: resumeWorkerId,
    workspaces: join(stateRoot, "product-worker-resume")
  });
  const completed = await apiRequest(ownerToken, "GET", `/v1/runs/${queued.id}`);
  assert.equal(completed.status, "completed");
  assert.equal(completed.stages.at(-1).stage, "learning");
  assert.equal(completed.budgetUsage.repairAttempts, 1);
  assert.ok(completed.sandboxEvidenceHistory.length >= 2);
  assert.equal(
    completed.gateResultsV2.filter((gate) => gate.required && gate.status === "skipped").length,
    0
  );
  assert.ok(
    resumed.document.governedLoopState.attempts.every(
      (attempt) => attempt.status === "running" || attempt.budgetMeasurement
    )
  );
  const artifacts = completed.gateResultsV2.flatMap((gate) => gate.artifacts);
  assert.ok(artifacts.length > 0);
  assert.ok(
    artifacts.every(
      (artifact) =>
        /^mn:\/\/cas\/gate-artifacts\//u.test(artifact.handle ?? "") &&
        artifact.path === undefined
    )
  );
  const evidenceArtifact = artifacts[0];
  const evalAsset = await apiRequest(ownerToken, "POST", "/v1/eval-assets", {
    expected: [201],
    body: {
      projectId: project.id,
      asset: {
        id: "product-worker-gate-cas-e2e",
        revision: 1,
        kind: "contract_test",
        title: "Product worker Gate CAS bytes",
        specRef,
        specClauseIds: approvedSpec.acceptanceCases.map((item) => item.id),
        serviceIds: ["orders", "inventory"],
        owner: "commerce-platform",
        source: {
          kind: "generated",
          ref: evidenceArtifact.handle,
          digest: evidenceArtifact.digest
        },
        contentRef: evidenceArtifact.handle,
        contentDigest: evidenceArtifact.digest,
        createdAt: new Date().toISOString(),
        createdBy: ownerActor
      }
    }
  });
  assert.match(evalAsset.digest, /^[a-f0-9]{64}$/u);
  return {
    completed,
    approval: resumed.document.governedLoopState.approval,
    evalAsset,
    evidenceArtifact,
    runId: completed.id,
    repairAttempts: completed.budgetUsage.repairAttempts,
    stageCount: completed.stages.length,
    gateCount: completed.gateResultsV2.length,
    sandboxLeaseCount: completed.sandboxEvidenceHistory.length,
    gateArtifactCount: artifacts.length,
    evalAssetDigest: evalAsset.digest
  };
}

async function prepareFixtureWorkspace(root) {
  const target = join(root, "microservice-repo");
  await cp(sourceFixtureRoot, target, { recursive: true });
  const projectPath = join(target, ".mn/project.yaml");
  const project = await readFile(projectPath, "utf8");
  assert.match(
    project,
    /integration: node --test \.\.\/\.\.\/tests\/cross-service\.e2e\.test\.mjs/u,
    "the authoritative fixture must declare a service-cwd-safe integration Gate"
  );
  assert.equal(
    project.match(/lint: node --check src\/server\.mjs/gu)?.length,
    2,
    "the authoritative fixture must declare lint for every service"
  );
  assert.equal(
    project.match(/typecheck: node --check src\/server\.mjs/gu)?.length,
    2,
    "the authoritative fixture must declare typecheck for every service"
  );
  assert.equal(
    project.match(/llm_verifier: node --check src\/server\.mjs/gu)?.length,
    2,
    "the authoritative fixture must declare llm_verifier for every service"
  );
  return realpath(target);
}

function pipeApiLogs(stream, label) {
  if (!stream) return;
  stream.setEncoding("utf8");
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) console.log(`[mn-api:${label}] ${line}`);
    }
  });
  stream.on("end", () => {
    if (pending.trim()) console.log(`[mn-api:${label}] ${pending}`);
  });
}

async function startApi(root, fixtureRoot) {
  if (targetExistingApi) {
    step(`targeting existing API at ${apiUrl}`);
    return;
  }
  step(`starting built enterprise API at ${apiUrl}`);
  const mniuRoot = join(root, "mniu");
  const objectCache =
    process.env.MN_ARTIFACT_OBJECT_STORE_LOCAL_BACKEND_PATH ??
    join(root, "object-store-cache");
  await mkdir(mniuRoot, { recursive: true });
  await mkdir(objectCache, { recursive: true });
  const sandboxImageReference =
    process.env.MN_ENTERPRISE_SANDBOX_IMAGE ?? "node:22-alpine";
  const sandboxImageDigest = await inspectDockerImageDigest(sandboxImageReference);
  const childEnv = {
    ...process.env,
    MN_RUNTIME_PROFILE: "enterprise",
    MN_API_HOST: process.env.MN_API_HOST ?? "127.0.0.1",
    MN_API_PORT: String(apiPort),
    MN_USE_MOCK_EXECUTORS: "1",
    MN_MNIU_ROOT: mniuRoot,
    MN_API_STATE_PATH: join(root, "api-state.json"),
    MN_WORKSPACE_ROOT: join(root, "worktrees"),
    MN_POSTGRES_URL: postgresUrl,
    MN_OIDC_ISSUER: process.env.MN_OIDC_ISSUER ?? "http://jwks:8080",
    MN_OIDC_AUDIENCE: process.env.MN_OIDC_AUDIENCE ?? "mn-enterprise",
    MN_OIDC_JWKS_URL:
      process.env.MN_ENTERPRISE_JWKS_URL ??
      process.env.MN_OIDC_JWKS_URL ??
      "http://127.0.0.1:59080/jwks.json",
    MN_CORS_ALLOWLIST: process.env.MN_CORS_ALLOWLIST ?? origin,
    MN_ENTERPRISE_PROJECT_ROOTS: fixtureRoot,
    MN_ENTERPRISE_SANDBOX_IMAGE: sandboxImageReference,
    MN_ENTERPRISE_SANDBOX_IMAGE_DIGEST: sandboxImageDigest,
    MN_OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
    MN_OTEL_SERVICE_NAME:
      process.env.MN_OTEL_SERVICE_NAME ?? "mn-api-enterprise-e2e",
    MN_ARTIFACT_REMOTE_STORE_TYPE: "s3",
    MN_ARTIFACT_REMOTE_STORE_BUCKET: s3Bucket,
    MN_ARTIFACT_REMOTE_STORE_PREFIX:
      process.env.MN_ARTIFACT_REMOTE_STORE_PREFIX ?? "enterprise-api-flow",
    MN_ARTIFACT_REMOTE_STORE_ENDPOINT_URL: s3Endpoint,
    MN_ARTIFACT_OBJECT_STORE_LOCAL_BACKEND_PATH: objectCache,
    MN_ARTIFACT_S3_ACCESS_KEY_ID:
      process.env.MN_ARTIFACT_S3_ACCESS_KEY_ID ?? "mn-e2e",
    MN_ARTIFACT_S3_SECRET_ACCESS_KEY:
      process.env.MN_ARTIFACT_S3_SECRET_ACCESS_KEY ?? "mn-e2e-secret-only",
    MN_ARTIFACT_S3_REGION: process.env.MN_ARTIFACT_S3_REGION ?? "us-east-1",
    MN_ARTIFACT_S3_REQUEST_TIMEOUT_MS:
      process.env.MN_ARTIFACT_S3_REQUEST_TIMEOUT_MS ?? "10000"
  };
  apiProcess = spawn(process.execPath, [apiEntry], {
    cwd: workspaceRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  pipeApiLogs(apiProcess.stdout, "out");
  pipeApiLogs(apiProcess.stderr, "err");
  apiExited = new Promise((resolveExit, rejectExit) => {
    apiProcess.once("error", rejectExit);
    apiProcess.once("exit", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
}

async function inspectDockerImageDigest(reference) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(
      process.env.MN_DOCKER_BINARY ?? "docker",
      ["image", "inspect", reference, "--format", "{{.Id}}"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
  });
  const digest = result.stdout.trim().replace(/^sha256:/u, "");
  if (result.code !== 0 || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(
      `Cannot resolve content digest for sandbox image ${reference}: ${result.stderr}`
    );
  }
  return digest;
}

async function stopApi() {
  const child = apiProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let shutdownTimeout;
  let exited;
  try {
    exited = await Promise.race([
      apiExited,
      new Promise((resolve) => {
        shutdownTimeout = setTimeout(() => resolve(undefined), 5_000);
        shutdownTimeout.unref?.();
      })
    ]);
  } finally {
    if (shutdownTimeout) clearTimeout(shutdownTimeout);
  }
  if (exited === undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await apiExited;
  }
}

async function responseDetail(response) {
  const text = await response.text();
  if (!text) return "";
  const bounded = text.length > 4_096 ? `${text.slice(0, 4_096)}…[truncated]` : text;
  try {
    return JSON.stringify(JSON.parse(bounded));
  } catch {
    return bounded;
  }
}

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/healthz`, {
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.runtimeProfile, "enterprise");
        assert.equal(health.metadataBackend, "postgresql");
        assert.equal(health.queueBackend, "postgresql");
        assert.equal(health.artifactRemoteStore?.type, "s3");
        assert.equal(health.artifactRemoteStore?.bucket, s3Bucket);
        assert.equal(health.telemetry?.enabled, true);
        return health;
      }
      lastError = `HTTP ${response.status}: ${await responseDetail(response)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (apiProcess && apiProcess.exitCode !== null) {
      throw new Error(`Enterprise API exited before readiness with code ${apiProcess.exitCode}`);
    }
    await delay(250);
  }
  throw new Error(`Enterprise API did not become ready: ${lastError}`);
}

async function issueToken(role, projectId, actor, options = {}) {
  const url = new URL(tokenUrl);
  url.searchParams.set("role", role);
  url.searchParams.set("tenant", tenantId);
  url.searchParams.set("project", projectId ?? "bootstrap-project");
  url.searchParams.set("sub", actor);
  if (options.principalType) {
    url.searchParams.set("principal_type", options.principalType);
  }
  if (options.scopes) {
    url.searchParams.set("scopes", options.scopes.join(","));
  }
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`JWT stub returned ${response.status}: ${await responseDetail(response)}`);
  }
  const body = await response.json();
  assert.match(body.access_token, /^[^.]+\.[^.]+\.[^.]+$/u);
  return body.access_token;
}

async function apiRequest(token, method, path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin,
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
  });
  const expected = options.expected ?? [200];
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${expected.join("/")}: ` +
      (await responseDetail(response))
    );
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function draftFromApproved(approved, specs) {
  const {
    approvedAt: _approvedAt,
    approvedBy: _approvedBy,
    digest: _digest,
    ...base
  } = approved;
  const semantic = { ...base, revision: 1, status: "draft" };
  return { ...semantic, digest: specs.digestSpecRevision(semantic) };
}

function loopArtifact(loop, runId, id, kind, semantic) {
  return {
    id,
    kind,
    path: `mn://runs/${encodeURIComponent(runId)}/${encodeURIComponent(id)}`,
    digest: loop.sha256Canonical(semantic),
    contentType: "application/vnd.mn.loop-artifact+json"
  };
}

function coreArtifact(artifact) {
  const kind =
    artifact.kind === "diff"
      ? "diff"
      : artifact.kind === "verification_evidence"
        ? "test-report"
        : artifact.kind === "learning_proposal"
          ? "summary"
          : "trace";
  return {
    id: artifact.id,
    kind,
    path: artifact.path,
    sha256: artifact.digest,
    ...(artifact.contentType ? { contentType: artifact.contentType } : {})
  };
}

function coreAttempt(attempt) {
  return {
    id: attempt.id,
    runId: attempt.runId,
    stage: attempt.stage,
    attempt: attempt.attempt,
    status: attempt.status,
    inputArtifacts: attempt.inputArtifacts.map(coreArtifact),
    outputArtifacts: attempt.outputArtifacts.map(coreArtifact),
    inputDigest: attempt.inputDigest,
    ...(attempt.outputDigest ? { outputDigest: attempt.outputDigest } : {}),
    budgetUsage: { ...attempt.budgetUsage },
    ...(attempt.failure
      ? {
          failure: {
            kind:
              attempt.failure.kind === "budget_exhausted"
                ? "context_exhausted"
                : attempt.failure.kind === "stage_failure"
                  ? "test_failure"
                  : "unknown",
            retryable: attempt.failure.retryable,
            reason: attempt.failure.reason
          }
        }
      : {}),
    startedAt: attempt.startedAt,
    ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {})
  };
}

function runStatus(state) {
  if (state.status === "waiting_approval") return "waiting_approval";
  if (state.status === "completed") return "completed";
  if (state.status === "cancelled") return "cancelled";
  if (state.status === "failed" || state.status === "needs_human") return "failed";
  return state.currentStage === "verification" ? "verifying" : "running";
}

function materializeRun(
  baseRun,
  state,
  candidate,
  gateResults,
  legacyGates,
  verificationEvidence
) {
  return {
    ...baseRun,
    status: runStatus(state),
    candidates: [candidate],
    gates: [...legacyGates],
    gateResultsV2: [...gateResults],
    verificationEvidence: verificationEvidence.map((binding) => ({
      stageAttemptId: binding.stageAttemptId,
      gateResultIds: [...binding.gateResultIds]
    })),
    winnerCandidateId: candidate.id,
    stages: state.attempts.map(coreAttempt),
    budgetUsage: { ...state.budgetUsage },
    trace: {
      traceId: baseRun.trace?.traceId ?? baseRun.id,
      specDigest: baseRun.governanceSnapshot.specRef.digest,
      governanceDigest: baseRun.governanceSnapshot.digest,
      harnessDigest: baseRun.harnessManifest.digest,
      evidenceIds: [
        ...state.attempts.flatMap((attempt) =>
          attempt.outputArtifacts.map((artifact) => artifact.id)
        ),
        ...gateResults.map((gate) => gate.id)
      ]
    },
    updatedAt:
      Date.parse(state.updatedAt) < Date.parse(baseRun.updatedAt)
        ? baseRun.updatedAt
        : state.updatedAt
  };
}

function workerCapabilities(requirements) {
  const sandboxIds = requirements.sandbox.allowedBackendIds.length > 0
    ? requirements.sandbox.allowedBackendIds
    : ["enterprise-container"];
  return {
    providers: [...requirements.requiredProviders],
    languages: [...requirements.requiredLanguages],
    gateRunnerIds: [...requirements.requiredGateRunnerIds],
    sandboxBackends: sandboxIds.map((backendId) => ({
      backendId,
      enforcement: "enforced",
      capabilities: [...requirements.sandbox.requiredCapabilities]
    })),
    tenantIds: [tenantId],
    tools: [...requirements.requiredTools]
  };
}

async function claimRun(token, runId, claimOwnerId = workerId) {
  const queue = await apiRequest(token, "GET", `/v1/run-jobs/queue/${runId}`);
  assert.equal(queue.item.status, "queued");
  assert.equal(queue.item.version, 2);
  assert.ok(queue.item.requirements);
  const capabilities = workerCapabilities(queue.item.requirements);
  const claim = await apiRequest(token, "POST", "/v1/run-jobs/queue/claim", {
    body: {
      ownerId: claimOwnerId,
      capacity: 1,
      ttlMs: 120_000,
      capabilities
    }
  });
  if (claim.item?.runId !== runId && claim.claimToken) {
    await apiRequest(
      token,
      "POST",
      `/v1/run-jobs/queue/${claim.item.runId}/release`,
      {
        expected: [200, 409],
        body: {
          ownerId: claimOwnerId,
          claimToken: claim.claimToken,
          capacity: 1,
          ttlMs: 120_000
        }
      }
    );
  }
  assert.ok(claim.item, `no compatible PostgreSQL job was claimable for ${runId}`);
  assert.equal(claim.item.runId, runId);
  assert.equal(claim.item.status, "running");
  assert.equal(claim.item.claimToken, undefined);
  assert.match(claim.claimToken, /^[0-9a-f-]{36}$/u);
  return { ...claim, capabilities };
}

async function postgresRow(pg, runId) {
  const result = await pg.query(
    `SELECT status, attempt, owner_id, claim_token_hash,
            claim_binding_digest, worker_capability_digest
       FROM mn_run_jobs WHERE run_id=$1`,
    [runId]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function assertActivePostgresClaim(pg, runId, ownerId, claimToken) {
  const result = await pg.query(
    `SELECT status, owner_id, claim_token_hash, worker_capability_digest,
            claim_expires_at, now() AS database_now
       FROM mn_run_jobs WHERE run_id=$1`,
    [runId]
  );
  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  assert.equal(row.status, "running");
  assert.equal(row.owner_id, ownerId);
  assert.equal(row.claim_token_hash, sha256(claimToken));
  assert.match(row.worker_capability_digest, /^[a-f0-9]{64}$/u);
  const remainingMs =
    new Date(row.claim_expires_at).getTime() - new Date(row.database_now).getTime();
  assert.ok(
    remainingMs > 60_000,
    `claim has only ${remainingMs}ms remaining at database time ${row.database_now}`
  );
}

async function executeInitialLoop({ loop, run, failedGates, passedGates }) {
  let verificationRound = 0;
  const checkpoints = [];
  const handlers = {
    discovery: async (context) => ({
      status: "completed",
      artifacts: [
        loopArtifact(loop, run.id, "discovery", "discovery", {
          selectedServices: run.harnessManifest.selectedServices,
          contextDigest: run.harnessManifest.context.digest
        })
      ]
    }),
    specification: async () => ({
      status: "completed",
      artifacts: [
        loopArtifact(loop, run.id, "approved-spec", "specification", {
          specRef: run.governanceSnapshot.specRef
        })
      ]
    }),
    impact_architecture: async () => ({
      status: "completed",
      artifacts: [
        loopArtifact(loop, run.id, "impact-architecture", "impact_report", {
          services: run.harnessManifest.selectedServices,
          gates: run.harnessManifest.gatePlan.map((gate) => gate.id)
        })
      ]
    }),
    implementation: async (context) => {
      const diff = loop.sha256Canonical({
        attempt: context.attempt,
        repair: context.isRepair,
        changedPaths: ["services/orders/src/server.mjs"]
      });
      return {
        status: "completed",
        artifacts: [
          loopArtifact(
            loop,
            run.id,
            `implementation-${context.attempt}`,
            "diff",
            { diff, repair: context.isRepair }
          )
        ],
        budgetDelta: {
          durationSeconds: 1,
          tokens: context.isRepair ? 250 : 500,
          costUsd: context.isRepair ? 0.01 : 0.02,
          changedFiles: 1,
          changedLines: context.isRepair ? 2 : 8
        },
        diffDigest: diff
      };
    },
    verification: async (context) => {
      const current = verificationRound++ === 0 ? failedGates : passedGates;
      const semantic = current.results.map((gate) => ({
        id: gate.id,
        gateId: gate.gateId,
        status: gate.status,
        outputDigest: gate.outputDigest
      }));
      const artifact = loopArtifact(
        loop,
        run.id,
        `verification-${context.attempt}`,
        "verification_evidence",
        semantic
      );
      if (current.successful) {
        return {
          status: "completed",
          artifacts: [artifact],
          budgetDelta: {
            durationSeconds: 1,
            tokens: 0,
            costUsd: 0,
            changedFiles: 0,
            changedLines: 0
          }
        };
      }
      return {
        status: "failed",
        artifacts: [artifact],
        budgetDelta: {
          durationSeconds: 1,
          tokens: 0,
          costUsd: 0,
          changedFiles: 0,
          changedLines: 0
        },
        failure: {
          kind: "stage_failure",
          retryable: true,
          reason: "A real governed GateResultV2 failed and requires bounded repair."
        },
        failureSignature: current.failureSignature,
        diffDigest: context.inputArtifacts.at(-1)?.digest ?? loop.sha256Canonical([])
      };
    },
    approval_demo: async () => ({
      status: "waiting_approval",
      artifacts: [
        loopArtifact(loop, run.id, "approval-material", "approval_material", {
          gateDigest: loop.sha256Canonical(passedGates.results)
        })
      ]
    }),
    learning: async () => ({
      status: "completed",
      artifacts: [
        loopArtifact(loop, run.id, "learning-proposal", "learning_proposal", {
          automaticActivationAllowed: false
        })
      ]
    })
  };
  const state = await loop.executeGovernedIncrement({
    schemaVersion: 1,
    runId: run.id,
    specRef: run.governanceSnapshot.specRef,
    governanceSnapshot: run.governanceSnapshot,
    harnessManifest: run.harnessManifest,
    handlers,
    onCheckpoint(checkpoint) {
      checkpoints.push(checkpoint);
    }
  });
  assert.equal(state.status, "waiting_approval");
  assert.equal(state.budgetUsage.repairAttempts, 1);
  const verificationAttempts = state.attempts.filter(
    (attempt) => attempt.stage === "verification"
  );
  assert.deepEqual(
    verificationAttempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.equal(state.repairHistory.length, 1);
  assert.ok(checkpoints.length >= state.attempts.length * 2);
  return { state, handlers, verificationAttempts };
}

async function resumeApprovedLoop({ loop, run, resumeFrom, decision, handlers }) {
  const state = await loop.executeGovernedIncrement({
    schemaVersion: 1,
    runId: run.id,
    specRef: run.governanceSnapshot.specRef,
    governanceSnapshot: run.governanceSnapshot,
    harnessManifest: run.harnessManifest,
    handlers,
    onCheckpoint() {},
    resumeFrom,
    approvalDecision: decision
  });
  assert.equal(state.status, "completed");
  assert.equal(state.approval?.decision, "approve");
  assert.equal(state.attempts.at(-1)?.stage, "learning");
  assert.equal(state.attempts.at(-1)?.status, "completed");
  assert.equal(
    state.attempts.at(-1)?.outputArtifacts.every(
      (artifact) => artifact.kind === "learning_proposal"
    ),
    true
  );
  return state;
}

function verificationEvidence(attempts, failed, passed) {
  return [
    {
      stageAttemptId: attempts[0].id,
      gateResultIds: failed.results.map((result) => result.id)
    },
    {
      stageAttemptId: attempts[1].id,
      gateResultIds: passed.results.map((result) => result.id)
    }
  ];
}

function finalRequiredPassedGates(run) {
  const finalVerification = run.stages
    .filter((attempt) => attempt.stage === "verification")
    .at(-1);
  assert.ok(finalVerification, "completed Run must have a final verification attempt");
  assert.equal(finalVerification.status, "completed");
  const binding = run.verificationEvidence.find(
    (candidate) => candidate.stageAttemptId === finalVerification.id
  );
  assert.ok(binding, "final verification must have an evidence binding");
  const byId = new Map(run.gateResultsV2.map((gate) => [gate.id, gate]));
  const bound = binding.gateResultIds.map((id) => {
    const gate = byId.get(id);
    assert.ok(gate, `final verification Gate ${id} must exist`);
    return gate;
  });
  const failedRequired = bound.filter(
    (gate) => gate.required && gate.status !== "pass"
  );
  assert.equal(
    failedRequired.length,
    0,
    "final verification cannot bind a non-passing required Gate"
  );
  const requiredPassed = bound.filter(
    (gate) => gate.required && gate.status === "pass"
  );
  assert.ok(
    requiredPassed.length > 0,
    "final verification must bind at least one required passing Gate"
  );
  return requiredPassed;
}

async function runProductOnlyFlow(fixtureRoot, runtime) {
  step("bootstrapping the enterprise control plane for the product worker path");
  const bootstrapOwnerToken = await issueToken(
    "project_owner",
    undefined,
    ownerActor
  );
  const bootstrapAdminToken = await issueToken(
    "org_admin",
    undefined,
    governanceActor
  );
  const capabilities = await apiRequest(
    bootstrapAdminToken,
    "GET",
    "/v1/capabilities"
  );
  const workflow = capabilities.workflows.find(
    (candidate) => candidate.id === "governed-increment-v1"
  );
  const harnessProfile = capabilities.harnessProfiles.find(
    (candidate) => candidate.id === "enterprise"
  );
  assert.equal(workflow?.status, "available");
  assert.equal(harnessProfile?.status, "available");
  const project = await apiRequest(bootstrapOwnerToken, "POST", "/v1/projects", {
    expected: [201],
    body: {
      name: "enterprise-product-worker-e2e",
      rootPath: fixtureRoot,
      defaultBranch: "main"
    }
  });
  const ownerToken = await issueToken("project_owner", project.id, ownerActor);
  const reviewerToken = await issueToken("reviewer", project.id, reviewerActor);
  const governanceToken = await issueToken(
    "governance_admin",
    project.id,
    governanceActor
  );
  const auditorToken = await issueToken("auditor", project.id, auditorActor);
  const workerScopes = [
    "run_jobs:claim",
    "run_jobs:heartbeat",
    "run_jobs:checkpoint",
    "run_jobs:finish",
    "run_jobs:events",
    "run_jobs:release"
  ];
  const workerToken = await issueToken("developer", project.id, workerActor, {
    principalType: "worker",
    scopes: workerScopes
  });
  const resumeWorkerToken = await issueToken(
    "developer",
    project.id,
    resumeWorkerActor,
    { principalType: "worker", scopes: workerScopes }
  );
  assert.ok(providerUpstreamBaseUrl);
  const governedProvider = await apiRequest(
    bootstrapAdminToken,
    "POST",
    "/v1/providers",
    {
      expected: [201],
      body: {
        app: "codex",
        name: "Enterprise E2E governed provider",
        kind: "openai_compatible",
        apiFormat: "openai_responses",
        baseUrl: providerUpstreamBaseUrl,
        defaultModel: "e2e-governed-model",
        apiKey: "enterprise-e2e-provider-key",
        enabled: true,
        config: {
          providerAccountId: "enterprise-e2e-account",
          enterpriseScope: { tenantIds: [tenantId], projectIds: [project.id] }
        }
      }
    }
  );
  assert.equal(governedProvider.enabled, true);
  const indexed = await apiRequest(
    ownerToken,
    "POST",
    `/v1/projects/${project.id}/index`
  );
  assert.deepEqual(
    indexed.project.services.map((service) => service.id).sort(),
    ["inventory", "orders"]
  );

  const native = JSON.parse(
    await readFile(join(fixtureRoot, "specs/order-reservation/spec.yaml"), "utf8")
  ).revision;
  const draft = draftFromApproved(native, runtime.specs);
  await apiRequest(ownerToken, "POST", "/v1/spec-sets", {
    expected: [201],
    body: {
      specSet: {
        id: draft.specSetId,
        title: draft.title,
        description: "Product worker enterprise acceptance Spec.",
        latestRevision: 0,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt
      },
      initialRevision: draft
    }
  });
  const approvedSpec = await apiRequest(
    reviewerToken,
    "POST",
    `/v1/spec-sets/${draft.specSetId}/revisions/1/approve`,
    { expected: [201], body: { approvedBy: reviewerActor } }
  );
  const specRef = {
    specSetId: approvedSpec.specSetId,
    revision: approvedSpec.revision,
    digest: approvedSpec.digest
  };
  const pack = JSON.parse(
    await readFile(join(fixtureRoot, "standards/enterprise-standard-pack.json"), "utf8")
  );
  assert.equal(runtime.governance.validateStandardPack(pack).valid, true);
  const imported = await apiRequest(
    governanceToken,
    "POST",
    "/v1/standard-packs/import",
    { expected: [201], body: { manifest: pack, importedBy: governanceActor } }
  );
  const activated = await apiRequest(
    governanceToken,
    "POST",
    "/v1/standard-packs/activate",
    {
      body: {
        id: pack.id,
        version: pack.version,
        scope: "project",
        scopeId: project.id,
        projectId: project.id,
        activatedBy: governanceActor
      }
    }
  );
  assert.equal(activated.activated, true);
  await apiRequest(ownerToken, "POST", "/v1/run-jobs/queue/claim", {
    expected: [403],
    body: { ownerId: "human-must-not-claim" }
  });

  const product = await verifyProductWorkerFlow({
    project,
    approvedSpec,
    specRef,
    ownerToken,
    workerToken,
    resumeWorkerToken,
    runtime,
    fixtureRoot
  });
  const run = product.completed;
  assert.deepEqual(run.governanceSnapshot.specRef, specRef);
  assert.equal(run.harnessManifest.profile.id, "enterprise");
  assert.equal(run.harnessManifest.sandbox.enforcement, "enforced");
  assert.match(run.harnessManifest.sandbox.runtimeImage.digest, /^[a-f0-9]{64}$/u);
  assert.equal(
    run.gateResultsV2.filter((gate) => gate.required && gate.status === "skipped").length,
    0
  );

  step("building the evidence, maturity and learning closure from product worker bytes");
  const acceptanceIds = approvedSpec.acceptanceCases.map((item) => item.id);
  const contractFragment = run.harnessManifest.context.fragments.find(
    (fragment) => fragment.metadata?.relativePath === "services/orders/openapi.yaml"
  );
  assert.ok(contractFragment);
  const diffArtifact = run.stages
    .filter((attempt) => attempt.stage === "implementation")
    .flatMap((attempt) => attempt.outputArtifacts)
    .filter((artifact) => artifact.kind === "diff")
    .at(-1);
  assert.ok(diffArtifact);
  const requiredGates = finalRequiredPassedGates(run);
  const gateNodes = requiredGates.map((gate, index) => ({
    id: `required-gate-${index}`,
    kind: "test_gate",
    ref: gate.id,
    digest: gate.outputDigest,
    serviceIds: ["orders", "inventory"]
  }));
  assert.ok(product.approval);
  const clauseNodes = acceptanceIds.map((id) => ({
    id: `clause-${id}`,
    kind: "spec_clause",
    ref: id,
    digest: specRef.digest,
    serviceIds: ["orders", "inventory"]
  }));
  const trace = await apiRequest(ownerToken, "POST", "/v1/trace-graphs", {
    expected: [201],
    body: {
      projectId: project.id,
      id: "product-worker-e2e-trace",
      graph: {
        nodes: [
          {
            id: "hypothesis",
            kind: "business_hypothesis",
            ref: specRef.specSetId,
            digest: sha256(approvedSpec.hypothesis),
            serviceIds: ["orders", "inventory"]
          },
          ...clauseNodes,
          {
            id: "contract",
            kind: "design_contract",
            ref: contractFragment.id,
            digest: contractFragment.contentDigest,
            serviceIds: ["orders"]
          },
          {
            id: "diff",
            kind: "diff",
            ref: diffArtifact.id,
            digest: diffArtifact.sha256,
            serviceIds: ["orders"]
          },
          ...gateNodes,
          {
            id: "owner-approval",
            kind: "approval",
            ref: product.approval.stageAttemptId,
            digest: product.approval.digest,
            serviceIds: ["orders", "inventory"]
          },
          {
            id: "gate-observation",
            kind: "observation",
            ref: product.evidenceArtifact.handle,
            digest: product.evidenceArtifact.digest,
            serviceIds: ["orders", "inventory"]
          }
        ],
        edges: [
          ...acceptanceIds.flatMap((id) => [
            { from: "hypothesis", to: `clause-${id}`, kind: "derives" },
            { from: `clause-${id}`, to: "contract", kind: "designs" }
          ]),
          { from: "contract", to: "diff", kind: "implements" },
          ...gateNodes.flatMap((gate) => [
            { from: "diff", to: gate.id, kind: "verifies" },
            { from: gate.id, to: "owner-approval", kind: "approves" }
          ]),
          { from: "owner-approval", to: "gate-observation", kind: "observes" }
        ]
      },
      analysis: {
        requiredSpecClauseIds: acceptanceIds,
        contracts: [
          {
            ref: contractFragment.id,
            expectedDigest: contractFragment.contentDigest,
            actualDigest: contractFragment.contentDigest
          }
        ],
        expectedContextDigest: run.harnessManifest.context.digest,
        actualContextDigest: run.harnessManifest.context.digest
      }
    }
  });
  assert.equal(trace.analysis.complete, true);
  assert.equal(trace.analysis.traceabilityRate, 1);

  const proposalId = "product-worker-learning-e2e";
  const proposal = await apiRequest(ownerToken, "POST", "/v1/learning-proposals", {
    expected: [201],
    body: {
      projectId: project.id,
      proposal: {
        id: proposalId,
        kind: "standard_pack",
        title: "Retain product worker repair regression",
        rationale: "The bounded product path generated verified reusable evidence.",
        sourceRunId: run.id,
        sourceEvidenceIds: [product.evalAsset.id],
        targetRef: `${pack.id}@next`,
        changeDigest: sha256(JSON.stringify({
          runId: run.id,
          gates: requiredGates.map((gate) => gate.id)
        })),
        createdAt: new Date().toISOString(),
        createdBy: ownerActor
      }
    }
  });
  assert.equal(proposal.status, "draft");
  await apiRequest(
    ownerToken,
    "POST",
    `/v1/learning-proposals/${proposalId}/submit`,
    { body: { projectId: project.id } }
  );
  const reviewed = await apiRequest(
    reviewerToken,
    "POST",
    `/v1/learning-proposals/${proposalId}/review`,
    {
      body: {
        projectId: project.id,
        approved: true,
        reason: "Product path evidence is suitable for canary."
      }
    }
  );
  assert.equal(reviewed.status, "approved");
  const canary = await apiRequest(
    reviewerToken,
    "POST",
    `/v1/learning-proposals/${proposalId}/canary`,
    {
      body: {
        projectId: project.id,
        passed: true,
        environment: "enterprise-product-worker-e2e",
        evidenceDigest: product.evalAsset.digest
      }
    }
  );
  assert.equal(canary.status, "canary_passed");
  const deniedPromotion = await apiRequest(
    governanceToken,
    "POST",
    `/v1/learning-proposals/${proposalId}/promote`,
    {
      expected: [403],
      body: {
        projectId: project.id,
        rollbackRef: `standards-lock:${activated.lock.digest}`,
        signature: {
          algorithm: "ed25519",
          keyId: "untrusted-enterprise-e2e-key",
          value: "forged-enterprise-e2e-signature"
        }
      }
    }
  );
  assert.match(deniedPromotion.error, /signature is not trusted/u);
  const maturity = await apiRequest(ownerToken, "POST", "/v1/maturity-report", {
    expected: [201],
    body: { projectId: project.id, id: "product-worker-e2e" }
  });
  assert.equal(maturity.report.contractCoverageRate, 1);
  assert.equal(maturity.report.contextDriftRate, 0);

  const s3 = new runtime.artifacts.S3CompatibleArtifactStore({
    endpointUrl: s3Endpoint,
    bucket: s3Bucket,
    region: process.env.MN_ARTIFACT_S3_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.MN_ARTIFACT_S3_ACCESS_KEY_ID ?? "mn-e2e",
      secretAccessKey:
        process.env.MN_ARTIFACT_S3_SECRET_ACCESS_KEY ?? "mn-e2e-secret-only"
    },
    requestTimeoutMs: 10_000
  });
  const remoteObjects = await s3.listObjects(
    process.env.MN_ARTIFACT_REMOTE_STORE_PREFIX ?? "enterprise-api-flow"
  );
  assert.ok(remoteObjects.length > 0);
  const journalObjects = remoteObjects.filter((object) =>
    object.key.includes("/provider-usage-journal/")
  );
  assert.ok(journalObjects.length > 0, "real MinIO provider usage journal is missing");
  const pg = new runtime.pg.Client({ connectionString: postgresUrl });
  await pg.connect();
  const journalRows = await pg.query(
    `SELECT terminal_journal FROM mn_provider_usage
      WHERE tenant_id=$1 AND candidate_id=$2 AND terminal_journal IS NOT NULL`,
    [tenantId, "codex-enterprise-journal-e2e"]
  );
  await pg.end();
  assert.ok(journalRows.rowCount > 0, "PostgreSQL terminal_journal binding is missing");
  assert.ok(journalRows.rows.every((row) => row.terminal_journal.objectKey));
  const audit = await apiRequest(auditorToken, "GET", "/v1/audit-events");
  for (const action of ["run.create", "run.checkpoint", "run.approve", "run.finish"]) {
    assert.ok(
      audit.auditEvents.some(
        (event) => event.resourceId === run.id && event.action === action
      ),
      `missing product worker audit action ${action}`
    );
  }
  const telemetryStatus = await fetch(otlpStatusUrl, {
    signal: AbortSignal.timeout(5_000)
  }).then((response) => response.json());
  assert.ok(telemetryStatus.acceptedTraceSpans > 0);
  return {
    projectId: project.id,
    taskId: run.taskId,
    runId: run.id,
    specRef,
    bindings: {
      spec: run.governanceSnapshot.specRef.digest,
      governance: run.governanceSnapshot.digest,
      harness: run.harnessManifest.digest,
      workflow: run.workflowRef.digest
    },
    standardPack: { id: pack.id, version: pack.version, digest: imported.digest },
    repair: { attempts: run.budgetUsage.repairAttempts },
    productWorker: {
      stageCount: run.stages.length,
      gateCount: run.gateResultsV2.length,
      requiredSkipped: 0,
      sandboxLeaseCount: run.sandboxEvidenceHistory.length,
      gateArtifactCount: run.gateResultsV2.flatMap((gate) => gate.artifacts).length
    },
    evidence: {
      evalAssetDigest: product.evalAsset.digest,
      traceDigest: trace.graph.digest,
      traceabilityRate: trace.analysis.traceabilityRate,
      maturityDigest: maturity.report.digest
    },
    learning: {
      id: proposalId,
      status: canary.status,
      automaticallyActivated: false,
      untrustedPromotionRejected: true
    },
    s3: {
      objectCount: remoteObjects.length,
      providerUsageJournalObjects: journalObjects.length,
      postgresJournalBindings: journalRows.rowCount
    },
    telemetry: { acceptedTraceSpans: telemetryStatus.acceptedTraceSpans },
    auditEventCount: audit.auditEvents.length
  };
}

/** Historical bespoke flow retained only as source-level attack fixtures. It
 * is deliberately not called by the default Compose acceptance path. */
async function runLegacyManualNegativeFlow(fixtureRoot, runtime) {
  step("verifying OIDC, enterprise capabilities and creating the tenant project");
  const bootstrapOwnerToken = await issueToken(
    "project_owner",
    undefined,
    ownerActor
  );
  const bootstrapAdminToken = await issueToken(
    "org_admin",
    undefined,
    governanceActor
  );
  const capabilities = await apiRequest(
    bootstrapAdminToken,
    "GET",
    "/v1/capabilities"
  );
  const workflow = capabilities.workflows.find(
    (candidate) => candidate.id === "governed-increment-v1"
  );
  const harnessProfile = capabilities.harnessProfiles.find(
    (candidate) => candidate.id === "enterprise"
  );
  assert.equal(workflow?.status, "available");
  assert.match(workflow?.digest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(harnessProfile?.status, "available");
  assert.match(harnessProfile?.digest ?? "", /^[a-f0-9]{64}$/u);
  const project = await apiRequest(bootstrapOwnerToken, "POST", "/v1/projects", {
    expected: [201],
    body: {
      name: "enterprise-commerce-reservation-e2e",
      rootPath: fixtureRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(project.tenantId, tenantId);
  const ownerToken = await issueToken("project_owner", project.id, ownerActor);
  const workerToken = await issueToken("developer", project.id, workerActor, {
    principalType: "worker",
    scopes: [
      "run_jobs:claim",
      "run_jobs:heartbeat",
      "run_jobs:checkpoint",
      "run_jobs:finish",
      "run_jobs:events",
      "run_jobs:release"
    ]
  });
  const resumeWorkerToken = await issueToken(
    "developer",
    project.id,
    resumeWorkerActor,
    {
      principalType: "worker",
      scopes: [
        "run_jobs:claim",
        "run_jobs:heartbeat",
        "run_jobs:checkpoint",
        "run_jobs:finish",
        "run_jobs:events",
        "run_jobs:release"
      ]
    }
  );
  const reviewerToken = await issueToken("reviewer", project.id, reviewerActor);
  const governanceToken = await issueToken(
    "governance_admin",
    project.id,
    governanceActor
  );
  const auditorToken = await issueToken("auditor", project.id, auditorActor);
  const indexed = await apiRequest(
    ownerToken,
    "POST",
    `/v1/projects/${project.id}/index`
  );
  assert.deepEqual(
    indexed.project.services.map((service) => service.id).sort(),
    ["inventory", "orders"]
  );

  step("creating and approving the exact Spec revision through the control plane");
  const native = JSON.parse(
    await readFile(join(fixtureRoot, "specs/order-reservation/spec.yaml"), "utf8")
  ).revision;
  const draft = draftFromApproved(native, runtime.specs);
  const specCreated = await apiRequest(ownerToken, "POST", "/v1/spec-sets", {
    expected: [201],
    body: {
      specSet: {
        id: draft.specSetId,
        title: draft.title,
        description: "Cross-service reservation increment used by enterprise API E2E.",
        latestRevision: 0,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt
      },
      initialRevision: draft
    }
  });
  assert.equal(specCreated.revisions[0].status, "draft");
  const approvedSpec = await apiRequest(
    reviewerToken,
    "POST",
    `/v1/spec-sets/${draft.specSetId}/revisions/1/approve`,
    {
      expected: [201],
      body: { approvedBy: reviewerActor }
    }
  );
  assert.equal(approvedSpec.revision, 2);
  assert.equal(approvedSpec.status, "approved");
  assert.match(approvedSpec.digest, /^[a-f0-9]{64}$/u);

  step("importing and activating a deterministic enterprise StandardPack");
  const fixturePack = JSON.parse(
    await readFile(join(fixtureRoot, "standards/enterprise-standard-pack.json"), "utf8")
  );
  const pack = fixturePack;
  const packValidation = runtime.governance.validateStandardPack(pack);
  assert.equal(packValidation.valid, true, JSON.stringify(packValidation.issues));
  const imported = await apiRequest(
    governanceToken,
    "POST",
    "/v1/standard-packs/import",
    {
      expected: [201],
      body: { manifest: pack, importedBy: governanceActor }
    }
  );
  assert.match(imported.digest, /^[a-f0-9]{64}$/u);
  const activated = await apiRequest(
    governanceToken,
    "POST",
    "/v1/standard-packs/activate",
    {
      body: {
        id: pack.id,
        version: pack.version,
        scope: "project",
        scopeId: project.id,
        projectId: project.id,
        activatedBy: governanceActor
      }
    }
  );
  assert.equal(activated.activated, true);
  assert.match(activated.lock.digest, /^[a-f0-9]{64}$/u);
  const specRef = {
    specSetId: approvedSpec.specSetId,
    revision: approvedSpec.revision,
    digest: approvedSpec.digest
  };
  const governanceQuery = new URLSearchParams({
    now: new Date().toISOString(),
    specSetId: specRef.specSetId,
    specRevision: String(specRef.revision),
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    workflowDigest: workflow.digest,
    harnessProfileId: harnessProfile.id,
    harnessProfileVersion: harnessProfile.version,
    harnessProfileDigest: harnessProfile.digest
  });
  const effective = await apiRequest(
    ownerToken,
    "GET",
    `/v1/projects/${project.id}/effective-governance?${governanceQuery}`
  );
  assert.deepEqual(effective.snapshot.specRef, specRef);
  assert.equal(effective.snapshot.workflowRef.digest, workflow.digest);
  assert.equal(effective.snapshot.harnessProfileRef.digest, harnessProfile.digest);
  for (const gate of [
    "spec_schema",
    "spec_approval",
    "acceptance_coverage",
    "protected_path",
    "contract",
    "migration_safety",
    "security"
  ]) {
    assert.ok(effective.snapshot.policy.requiredGates.includes(gate));
  }

  step("creating a governed task and checking immutable Spec/Governance/Harness snapshots");
  const task = await apiRequest(ownerToken, "POST", "/v1/tasks", {
    expected: [201],
    body: {
      projectId: project.id,
      title: "Implement an approved order reservation increment",
      intent: "implement",
      targetServices: ["orders", "inventory"],
      prompt:
        "Implement only the approved order reservation Spec and retain cross-service evidence.",
      acceptanceCriteria: approvedSpec.acceptanceCases.map((item) => item.title),
      specRef,
      strategy: {
        providers: ["codex"],
        candidates: 1,
        sandbox: "isolated-worktree",
        humanApproval: "before-merge",
        timeoutSeconds: 600
      }
    }
  });
  assert.equal(task.workflowRef.digest, workflow.digest);
  assert.equal(task.harnessProfileRef.digest, harnessProfile.digest);
  const run = await apiRequest(
    ownerToken,
    "POST",
    `/v1/tasks/${task.id}/runs`,
    { expected: [201], body: { queueOnly: true, queuePriority: 100 } }
  );
  assert.equal(run.status, "queued");
  assert.deepEqual(run.governanceSnapshot.specRef, specRef);
  assert.equal(run.harnessManifest.governanceDigest, run.governanceSnapshot.digest);
  assert.equal(run.harnessManifest.profile.id, "enterprise");
  assert.equal(run.harnessManifest.sandbox.enforcement, "enforced");
  assert.match(run.harnessManifest.digest, /^[a-f0-9]{64}$/u);
  await apiRequest(ownerToken, "POST", "/v1/run-jobs/queue/claim", {
    expected: [403],
    body: { ownerId: "human-must-not-claim", capacity: 1, ttlMs: 120_000 }
  });
  const runGovernanceQuery = new URLSearchParams(governanceQuery);
  runGovernanceQuery.set("now", run.governanceSnapshot.resolvedAt);
  const reboundGovernance = await apiRequest(
    ownerToken,
    "GET",
    `/v1/projects/${project.id}/effective-governance?${runGovernanceQuery}`
  );
  assert.equal(reboundGovernance.snapshot.digest, run.governanceSnapshot.digest);
  const bindings = {
    spec: run.governanceSnapshot.specRef.digest,
    governance: run.governanceSnapshot.digest,
    harness: run.harnessManifest.digest,
    workflow: run.workflowRef.digest
  };

  step("claiming the job from PostgreSQL with exact remote-worker capabilities");
  const firstClaim = await claimRun(workerToken, run.id);
  assert.equal(firstClaim.sandboxAttestation.runId, run.id);
  assert.equal(firstClaim.sandboxAttestation.tenantId, tenantId);
  assert.equal(firstClaim.sandboxAttestation.workerId, workerId);
  assert.equal(firstClaim.sandboxAttestation.harnessDigest, run.harnessManifest.digest);
  assert.deepEqual(
    firstClaim.sandboxAttestation.policy.runtimeImage,
    run.harnessManifest.sandbox.runtimeImage
  );
  assert.match(firstClaim.sandboxAttestation.digest, /^[a-f0-9]{64}$/u);
  let activeClaimToken = firstClaim.claimToken;
  let activeWorkerToken = workerToken;
  let activeWorkerId = workerId;
  let sandboxBackend;
  let sandboxLeaseId;
  let resumeSandboxBackend;
  let resumeSandboxLeaseId;
  const pg = new runtime.pg.Client({ connectionString: postgresUrl });
  let pgConnected = false;
  try {
    await pg.connect();
    pgConnected = true;
    const claimedRow = await postgresRow(pg, run.id);
    assert.equal(claimedRow.status, "running");
    assert.equal(claimedRow.owner_id, workerId);
    assert.match(claimedRow.claim_token_hash, /^[a-f0-9]{64}$/u);
    assert.match(claimedRow.claim_binding_digest, /^[a-f0-9]{64}$/u);
    assert.match(claimedRow.worker_capability_digest, /^[a-f0-9]{64}$/u);
    assert.notEqual(claimedRow.claim_token_hash, firstClaim.claimToken);
    assert.equal(firstClaim.sandboxAttestation.claimDigest, claimedRow.claim_token_hash);
    await assertActivePostgresClaim(pg, run.id, workerId, firstClaim.claimToken);

    step("provisioning and negatively probing the API-issued Docker sandbox lease");
    sandboxBackend = new runtime.worker.DockerEnforcedSandboxBackend({
      image: firstClaim.sandboxAttestation.policy.runtimeImage.reference,
      attestation: firstClaim.sandboxAttestation,
      expected: {
        runId: run.id,
        tenantId,
        workerId,
        harnessDigest: run.harnessManifest.digest
      },
      runtimeProofAuthority: async ({ attestation, runtimeId }) => {
        const authority = await apiRequest(
          workerToken,
          "POST",
          `/v1/run-jobs/queue/${run.id}/sandbox-runtime-proof`,
          {
            body: {
              ownerId: workerId,
              claimToken: firstClaim.claimToken,
              capacity: 1,
              ttlMs: 120_000,
              attestation,
              runtimeId
            }
          }
        );
        return authority.runtimeProof;
      }
    });
    const preparedSandbox = await sandboxBackend.prepare({
      projectRoot: fixtureRoot,
      taskId: task.id,
      commandAllowlist: run.harnessManifest.executionPolicy.commandAllowlist ?? [],
      networkAllowlist: []
    });
    sandboxLeaseId = preparedSandbox.leaseId;
    const sandboxExecution = sandboxBackend.executionEvidence(sandboxLeaseId);
    const commandExecutor = sandboxBackend.gateCommandExecutor(sandboxLeaseId);
    assert.equal(sandboxExecution.attestationDigest, firstClaim.sandboxAttestation.digest);
    assert.match(sandboxExecution.runtimeId, /^[a-f0-9]{64}$/u);
    assert.match(sandboxExecution.runtimeDigest, /^[a-f0-9]{64}$/u);
    assert.equal(
      sandboxExecution.imageDigest,
      firstClaim.sandboxAttestation.policy.runtimeImage.digest
    );
    assert.equal(sandboxExecution.runtimeProof.issuer, "mn-api");
    assert.equal(
      sandboxExecution.runtimeProof.claimDigest,
      firstClaim.sandboxAttestation.claimDigest
    );
    assert.equal(sandboxExecution.runtimeProof.runtimeId, sandboxExecution.runtimeId);
    assert.equal(sandboxExecution.runtimeProof.runtimeDigest, sandboxExecution.runtimeDigest);
    assert.equal(sandboxExecution.runtimeProof.imageDigest, sandboxExecution.imageDigest);
    assert.match(sandboxExecution.runtimeProof.signature, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      sandboxBackend.execute(sandboxLeaseId, {
        executable: "sh",
        args: ["-c", "true"],
        cwd: fixtureRoot,
        timeoutSeconds: 30
      }),
      /not allowed by sandbox lease/u
    );
    await assert.rejects(
      sandboxBackend.execute(sandboxLeaseId, {
        executable: "node",
        args: ["-e", "process.exit(0)"],
        cwd: "/etc",
        timeoutSeconds: 30
      }),
      /outside the leased project mount/u
    );
    await assert.rejects(
      sandboxBackend.execute(sandboxLeaseId, {
        executable: "node",
        args: ["-e", "process.exit(0)"],
        cwd: fixtureRoot,
        timeoutSeconds: 30,
        env: { UNAUTHORIZED_SECRET: "must-not-enter-container" },
        secretNames: ["UNAUTHORIZED_SECRET"]
      }),
      /secret UNAUTHORIZED_SECRET is not allowed/u
    );
    const deniedNetwork = await sandboxBackend.execute(sandboxLeaseId, {
      executable: "node",
      args: [
        "-e",
        "fetch('http://example.com').then(()=>process.exit(90)).catch(()=>process.exit(42))"
      ],
      cwd: fixtureRoot,
      timeoutSeconds: 30
    });
    assert.equal(deniedNetwork.exitCode, 42, deniedNetwork.stderr);

    step("executing real GateResultV2 failure and repaired pass through the governed Gate registry");
    const contractBaseline = await runtime.worker.captureContractBaseline(indexed.project);
    const failedGates = externalizeGateExecution(
      await runtime.worker.runGovernedGatePlan({
      project: indexed.project,
      task,
      manifest: run.harnessManifest,
      candidateRoot: fixtureRoot,
      runId: run.id,
      candidateId: "codex-enterprise-e2e",
      changedPaths: [".mn/standards.lock"],
      spec: approvedSpec,
      contractBaseline,
      commandExecutor
      }),
      runtime.worker,
      runtime.loop.sha256Canonical
    );
    await apiRequest(
      workerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/heartbeat`,
      {
        body: {
          ownerId: workerId,
          claimToken: firstClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000
        }
      }
    );
    await assertActivePostgresClaim(pg, run.id, workerId, firstClaim.claimToken);
    assert.equal(failedGates.successful, false);
    assert.ok(failedGates.results.some((gate) => gate.status === "fail"));
    const passedGates = externalizeGateExecution(
      await runtime.worker.runGovernedGatePlan({
      project: indexed.project,
      task,
      manifest: run.harnessManifest,
      candidateRoot: fixtureRoot,
      runId: run.id,
      candidateId: "codex-enterprise-e2e",
      changedPaths: ["services/orders/src/server.mjs"],
      spec: approvedSpec,
      contractBaseline,
      commandExecutor
      }),
      runtime.worker,
      runtime.loop.sha256Canonical
    );
    await assertActivePostgresClaim(pg, run.id, workerId, firstClaim.claimToken);
    await apiRequest(
      workerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/heartbeat`,
      {
        body: {
          ownerId: workerId,
          claimToken: firstClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000
        }
      }
    );
    assert.equal(
      passedGates.successful,
      true,
      JSON.stringify(
        passedGates.results.map((gate) => ({
          gateId: gate.gateId,
          status: gate.status,
          summary: gate.summary
        }))
      )
    );
    const now = new Date().toISOString();
    for (const gate of [...failedGates.results, ...passedGates.results]) {
      assert.deepEqual(runtime.worker.validateGateResultV2Integrity(gate, now), []);
      assert.equal(gate.runId, run.id);
      assert.equal(gate.candidateId, "codex-enterprise-e2e");
      assert.match(gate.inputDigest, /^[a-f0-9]{64}$/u);
      assert.match(gate.outputDigest, /^[a-f0-9]{64}$/u);
      assert.ok(gate.tool || gate.command);
      assert.deepEqual(gate.sandboxExecution, sandboxExecution);
    }

    step("running the bounded Loop engine to a real governed approval checkpoint");
    const initial = await executeInitialLoop({
      loop: runtime.loop,
      run,
      failedGates,
      passedGates
    });
    const allGateResults = [...failedGates.results, ...passedGates.results];
    const candidate = {
      id: "codex-enterprise-e2e",
      runId: run.id,
      provider: "codex",
      worktreePath: fixtureRoot,
      status: "completed",
      result: {
        provider: "codex",
        candidateId: "codex-enterprise-e2e",
        status: "completed",
        exitCode: 0,
        stdout:
          "Enterprise governed increment repaired protected-path scope and passed all required Gates.\n",
        stderr: "",
        summary: "Bounded repair completed with immutable evidence.",
        artifacts: [],
        startedAt: initial.state.createdAt,
        finishedAt: initial.state.updatedAt
      },
      gates: [...passedGates.legacyResults]
    };
    const attemptEvidence = verificationEvidence(
      initial.verificationAttempts,
      failedGates,
      passedGates
    );
    const waitingRun = {
      ...materializeRun(
        run,
        initial.state,
        candidate,
        allGateResults,
        passedGates.legacyResults,
        attemptEvidence
      ),
      sandboxAttestation: firstClaim.sandboxAttestation,
      sandboxExecution,
      sandboxEvidenceHistory: [{
        attestation: firstClaim.sandboxAttestation,
        execution: sandboxExecution,
        gateResultIds: allGateResults.map((gate) => gate.id),
        stageAttemptIds: attemptEvidence.map((binding) => binding.stageAttemptId)
      }]
    };
    const missingSandboxEvidence = structuredClone(waitingRun);
    delete missingSandboxEvidence.sandboxAttestation;
    delete missingSandboxEvidence.sandboxExecution;
    await apiRequest(
      workerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/update`,
      {
        expected: [400],
        body: {
          ownerId: workerId,
          claimToken: firstClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000,
          run: missingSandboxEvidence,
          governedLoopState: initial.state
        }
      }
    );
    const tamperedSandboxEvidence = structuredClone(waitingRun);
    tamperedSandboxEvidence.sandboxAttestation.policy.resources.memoryMb = 65_536;
    await apiRequest(
      workerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/update`,
      {
        expected: [400],
        body: {
          ownerId: workerId,
          claimToken: firstClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000,
          run: tamperedSandboxEvidence,
          governedLoopState: initial.state
        }
      }
    );
    for (const [name, mutate, pattern] of [
      [
        "runtimeId",
        (value) => { value.sandboxExecution.runtimeId = "0".repeat(64); },
        /execution evidence|runtime values|runtime proof/u
      ],
      [
        "runtimeDigest",
        (value) => { value.sandboxExecution.runtimeDigest = "1".repeat(64); },
        /execution evidence|runtime values|runtime proof/u
      ],
      [
        "runtimeProof",
        (value) => { value.sandboxExecution.runtimeProof.signature = "2".repeat(64); },
        /runtime proof signature/u
      ]
    ]) {
      const forged = structuredClone(waitingRun);
      // Break structuredClone's preserved alias with Gate/history evidence so
      // each negative reaches the API's top-level runtime-proof validator.
      forged.sandboxExecution = structuredClone(forged.sandboxExecution);
      mutate(forged);
      const rejected = await apiRequest(
        workerToken,
        "POST",
        `/v1/run-jobs/queue/${run.id}/update`,
        {
          expected: [400],
          body: {
            ownerId: workerId,
            claimToken: firstClaim.claimToken,
            capacity: 1,
            ttlMs: 120_000,
            run: forged,
            governedLoopState: initial.state
          }
        }
      );
      assert.match(rejected.error, pattern, `${name} forgery was not rejected by runtime authority`);
    }
    const update = await apiRequest(
      workerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/update`,
      {
        body: {
          ownerId: workerId,
          claimToken: firstClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000,
          run: waitingRun,
          governedLoopState: initial.state
        }
      }
    );
    assert.equal(update.run.status, "waiting_approval");
    assert.deepEqual(
      {
        spec: update.run.governanceSnapshot.specRef.digest,
        governance: update.run.governanceSnapshot.digest,
        harness: update.run.harnessManifest.digest,
        workflow: update.run.workflowRef.digest
      },
      bindings
    );
    const waitingApprovalAttempt = initial.state.attempts.at(-1);
    assert.equal(waitingApprovalAttempt.stage, "approval_demo");
    const forgedApproval = runtime.loop.createApprovalDecision({
      runId: run.id,
      stageAttemptId: waitingApprovalAttempt.id,
      decision: "approve",
      actorId: workerId,
      decidedAt: new Date().toISOString()
    });
    const forgedCompletedState = await resumeApprovedLoop({
      loop: runtime.loop,
      run,
      resumeFrom: initial.state,
      decision: forgedApproval,
      handlers: initial.handlers
    });
    const forgedCompletedRun = materializeRun(
      update.run,
      forgedCompletedState,
      candidate,
      allGateResults,
      passedGates.legacyResults,
      attemptEvidence
    );
    const forgedFinish = await apiRequest(
      workerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/finish`,
      {
        expected: [400],
        body: {
          ownerId: workerId,
          claimToken: firstClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000,
          run: forgedCompletedRun,
          governedLoopState: forgedCompletedState
        }
      }
    );
    assert.match(
      forgedFinish.error,
      /approval was not issued by the server approval endpoint/u
    );
    await apiRequest(
      workerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/release`,
      {
        body: {
          ownerId: workerId,
          claimToken: firstClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000
        }
      }
    );
    activeClaimToken = undefined;

    await apiRequest(workerToken, "POST", `/v1/runs/${run.id}/approve`, {
      expected: [403],
      body: { decision: "approve", actorId: workerActor }
    });

    step("approving as project owner and resuming the same governed run");
    const approvalQueued = await apiRequest(
      ownerToken,
      "POST",
      `/v1/runs/${run.id}/approve`,
      {
        expected: [202],
        body: { decision: "approve", actorId: ownerActor }
      }
    );
    assert.equal(approvalQueued.id, run.id);
    assert.equal(approvalQueued.status, "queued");
    const secondClaim = await claimRun(
      resumeWorkerToken,
      run.id,
      resumeWorkerId
    );
    activeClaimToken = secondClaim.claimToken;
    activeWorkerToken = resumeWorkerToken;
    activeWorkerId = resumeWorkerId;
    assert.notEqual(
      secondClaim.sandboxAttestation.digest,
      firstClaim.sandboxAttestation.digest
    );
    const resumedClaimRow = await postgresRow(pg, run.id);
    assert.equal(
      secondClaim.sandboxAttestation.claimDigest,
      resumedClaimRow.claim_token_hash
    );
    assert.notEqual(
      secondClaim.sandboxAttestation.claimDigest,
      firstClaim.sandboxAttestation.claimDigest
    );
    resumeSandboxBackend = new runtime.worker.DockerEnforcedSandboxBackend({
      image: secondClaim.sandboxAttestation.policy.runtimeImage.reference,
      attestation: secondClaim.sandboxAttestation,
      expected: {
        runId: run.id,
        tenantId,
        workerId: resumeWorkerId,
        harnessDigest: run.harnessManifest.digest
      },
      runtimeProofAuthority: async ({ attestation, runtimeId }) => {
        const authority = await apiRequest(
          resumeWorkerToken,
          "POST",
          `/v1/run-jobs/queue/${run.id}/sandbox-runtime-proof`,
          {
            body: {
              ownerId: resumeWorkerId,
              claimToken: secondClaim.claimToken,
              capacity: 1,
              ttlMs: 120_000,
              attestation,
              runtimeId
            }
          }
        );
        return authority.runtimeProof;
      }
    });
    const preparedResumeSandbox = await resumeSandboxBackend.prepare({
      projectRoot: fixtureRoot,
      taskId: task.id,
      commandAllowlist: run.harnessManifest.executionPolicy.commandAllowlist ?? [],
      networkAllowlist: []
    });
    resumeSandboxLeaseId = preparedResumeSandbox.leaseId;
    const resumeSandboxExecution = resumeSandboxBackend.executionEvidence(
      resumeSandboxLeaseId
    );
    const resumeProbe = await resumeSandboxBackend.execute(resumeSandboxLeaseId, {
      executable: "node",
      args: ["-e", "process.stdout.write('resumed-in-new-container')"],
      cwd: fixtureRoot,
      timeoutSeconds: 30
    });
    assert.equal(resumeProbe.exitCode, 0, resumeProbe.stderr);
    assert.equal(resumeProbe.stdout, "resumed-in-new-container");
    assert.equal(secondClaim.payload.governedResumeState.digest, initial.state.digest);
    assert.equal(secondClaim.payload.approvalDecision.runId, run.id);
    assert.equal(secondClaim.payload.approvalDecision.decision, "approve");
    const completedState = await resumeApprovedLoop({
      loop: runtime.loop,
      run,
      resumeFrom: secondClaim.payload.governedResumeState,
      decision: secondClaim.payload.approvalDecision,
      handlers: initial.handlers
    });
    const completedRun = {
      ...materializeRun(
        approvalQueued,
        completedState,
        candidate,
        allGateResults,
        passedGates.legacyResults,
        attemptEvidence
      ),
      sandboxAttestation: secondClaim.sandboxAttestation,
      sandboxExecution: resumeSandboxExecution,
      sandboxEvidenceHistory: [
        ...waitingRun.sandboxEvidenceHistory,
        {
          attestation: secondClaim.sandboxAttestation,
          execution: resumeSandboxExecution,
          gateResultIds: [],
          stageAttemptIds: completedState.attempts
            .filter((attempt) => !initial.state.attempts.some((old) => old.id === attempt.id))
            .map((attempt) => attempt.id)
        }
      ]
    };
    const replayedLease = structuredClone(completedRun);
    replayedLease.sandboxAttestation = firstClaim.sandboxAttestation;
    replayedLease.sandboxExecution = sandboxExecution;
    const replayRejected = await apiRequest(
      resumeWorkerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/finish`,
      {
        expected: [400],
        body: {
          ownerId: resumeWorkerId,
          claimToken: secondClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000,
          run: replayedLease,
          governedLoopState: completedState
        }
      }
    );
    assert.match(replayRejected.error, /active claim binding mismatch/u);
    const finished = await apiRequest(
      resumeWorkerToken,
      "POST",
      `/v1/run-jobs/queue/${run.id}/finish`,
      {
        body: {
          ownerId: resumeWorkerId,
          claimToken: secondClaim.claimToken,
          capacity: 1,
          ttlMs: 120_000,
          run: completedRun,
          governedLoopState: completedState
        },
        timeoutMs: 60_000
      }
    );
    assert.equal(finished.run.status, "completed");
    assert.equal(finished.item.status, "completed");
    activeClaimToken = undefined;
    assert.equal(finished.run.stages.at(-1).stage, "learning");
    assert.equal(finished.run.stages.at(-1).status, "completed");
    assert.equal(finished.run.budgetUsage.repairAttempts, 1);
    assert.deepEqual(
      {
        spec: finished.run.governanceSnapshot.specRef.digest,
        governance: finished.run.governanceSnapshot.digest,
        harness: finished.run.harnessManifest.digest,
        workflow: finished.run.workflowRef.digest
      },
      bindings
    );
    const completedRow = await postgresRow(pg, run.id);
    assert.equal(completedRow.status, "completed");
    assert.equal(completedRow.attempt, 2);
    assert.equal(completedRow.claim_token_hash, null);

    const productWorker = await verifyProductWorkerFlow({
      project,
      approvedSpec,
      specRef,
      ownerToken,
      workerToken,
      resumeWorkerToken
    });

    step("proving candidate evidence was persisted to the real S3-compatible store");
    const artifactList = await apiRequest(
      ownerToken,
      "GET",
      `/v1/runs/${run.id}/artifacts`
    );
    const remoteArtifact = artifactList.artifacts.find(
      (artifact) => artifact.remote?.type === "s3"
    );
    assert.ok(remoteArtifact, "completed run must have a persisted S3 artifact");
    assert.match(remoteArtifact.remote.uri, /^s3:\/\//u);
    const s3 = new runtime.artifacts.S3CompatibleArtifactStore({
      endpointUrl: s3Endpoint,
      bucket: s3Bucket,
      region: process.env.MN_ARTIFACT_S3_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: process.env.MN_ARTIFACT_S3_ACCESS_KEY_ID ?? "mn-e2e",
        secretAccessKey:
          process.env.MN_ARTIFACT_S3_SECRET_ACCESS_KEY ?? "mn-e2e-secret-only"
      },
      requestTimeoutMs: 10_000
    });
    const s3Content = await s3.getObject(remoteArtifact.remote.key);
    assert.ok(s3Content);
    assert.equal(sha256(s3Content), remoteArtifact.remote.sha256);
    assert.equal(s3Content.byteLength, remoteArtifact.remote.bytes);

    step("creating Eval/Trace evidence, maturity metrics and a non-auto-activating Learning Proposal");
    const acceptanceIds = approvedSpec.acceptanceCases.map((item) => item.id);
    const evalAssetId = "order-reservation-contract-e2e";
    const evalAsset = await apiRequest(ownerToken, "POST", "/v1/eval-assets", {
      expected: [201],
      body: {
        projectId: project.id,
        asset: {
          id: evalAssetId,
          revision: 1,
          kind: "contract_test",
          title: "Order reservation governed Gate evidence",
          specRef,
          specClauseIds: acceptanceIds,
          serviceIds: ["orders", "inventory"],
          owner: "commerce-platform",
          source: {
            kind: "generated",
            ref: remoteArtifact.remote.uri,
            digest: remoteArtifact.remote.sha256
          },
          contentRef: remoteArtifact.remote.uri,
          contentDigest: remoteArtifact.remote.sha256,
          createdAt: new Date().toISOString(),
          createdBy: ownerActor
        }
      }
    });
    const contractDigest = sha256(
      await readFile(join(fixtureRoot, "services/orders/openapi.yaml"))
    );
    const requiredGates = finalRequiredPassedGates(finished.run);
    const gateNodes = requiredGates.map((gate, index) => ({
      id: `required-gate-${index}`,
      kind: "test_gate",
      ref: gate.id,
      digest: gate.outputDigest,
      serviceIds: ["orders", "inventory"]
    }));
    const clauseNodes = acceptanceIds.map((id) => ({
      id: `clause-${id}`,
      kind: "spec_clause",
      ref: id,
      digest: specRef.digest,
      serviceIds: ["orders", "inventory"]
    }));
    const trace = await apiRequest(ownerToken, "POST", "/v1/trace-graphs", {
      expected: [201],
      body: {
        projectId: project.id,
        id: "order-reservation-e2e-trace",
        graph: {
          nodes: [
            {
              id: "hypothesis",
              kind: "business_hypothesis",
              ref: "order-reservation",
              digest: sha256(approvedSpec.hypothesis),
              serviceIds: ["orders", "inventory"]
            },
            ...clauseNodes,
            {
              id: "contract",
              kind: "design_contract",
              ref: "services/orders/openapi.yaml",
              digest: contractDigest,
              serviceIds: ["orders"]
            },
            {
              id: "repair-diff",
              kind: "diff",
              ref: "services/orders/src/server.mjs",
              digest: completedState.repairHistory[0].diffDigest,
              serviceIds: ["orders"]
            },
            ...gateNodes,
            {
              id: "owner-approval",
              kind: "approval",
              ref: secondClaim.payload.approvalDecision.stageAttemptId,
              digest: secondClaim.payload.approvalDecision.digest,
              serviceIds: ["orders", "inventory"]
            },
            {
              id: "s3-observation",
              kind: "observation",
              ref: remoteArtifact.remote.uri,
              digest: remoteArtifact.remote.sha256,
              serviceIds: ["orders", "inventory"]
            }
          ],
          edges: [
            ...acceptanceIds.flatMap((id) => [
              { from: "hypothesis", to: `clause-${id}`, kind: "derives" },
              { from: `clause-${id}`, to: "contract", kind: "designs" }
            ]),
            { from: "contract", to: "repair-diff", kind: "implements" },
            ...gateNodes.flatMap((gate) => [
              { from: "repair-diff", to: gate.id, kind: "verifies" },
              { from: gate.id, to: "owner-approval", kind: "approves" }
            ]),
            { from: "owner-approval", to: "s3-observation", kind: "observes" }
          ]
        },
        analysis: {
          requiredSpecClauseIds: acceptanceIds,
          contracts: [
            {
              ref: "services/orders/openapi.yaml",
              expectedDigest: contractDigest,
              actualDigest: contractDigest
            }
          ],
          expectedContextDigest: run.harnessManifest.context.digest,
          actualContextDigest: run.harnessManifest.context.digest
        }
      }
    });
    assert.equal(trace.analysis.complete, true);
    assert.equal(trace.analysis.traceabilityRate, 1);
    const maturity = await apiRequest(ownerToken, "POST", "/v1/maturity-report", {
      expected: [201],
      body: {
        projectId: project.id,
        id: "enterprise-api-e2e"
      }
    });
    assert.equal(maturity.source.kind, "server_aggregate-v1");
    assert.match(maturity.source.queryDigest, /^[a-f0-9]{64}$/u);
    assert.match(maturity.source.sourceDigest, /^[a-f0-9]{64}$/u);
    assert.equal(maturity.report.contractCoverageRate, 1);
    assert.equal(maturity.report.contextDriftRate, 0);
    assert.equal(maturity.report.aiReworkRate, 0.5);
    const packsBeforeLearning = await apiRequest(
      governanceToken,
      "GET",
      "/v1/standard-packs"
    );
    const governanceBeforeLearning = await apiRequest(
      governanceToken,
      "GET",
      `/v1/projects/${project.id}/effective-governance?${governanceQuery}`
    );
    const proposalId = "learn-order-reservation-e2e";
    const proposal = await apiRequest(ownerToken, "POST", "/v1/learning-proposals", {
      expected: [201],
      body: {
        projectId: project.id,
        proposal: {
          id: proposalId,
          kind: "standard_pack",
          title: "Retain protected-path repair regression",
          rationale: "The bounded repair found a reusable protected-path failure mode.",
          sourceRunId: run.id,
          sourceEvidenceIds: [evalAsset.id],
          targetRef: `${pack.id}@next`,
          changeDigest: sha256(
            JSON.stringify({ requiredGate: "protected_path", sourceRunId: run.id })
          ),
          createdAt: new Date().toISOString(),
          createdBy: ownerActor
        }
      }
    });
    assert.equal(proposal.status, "draft");
    const submitted = await apiRequest(
      ownerToken,
      "POST",
      `/v1/learning-proposals/${proposalId}/submit`,
      { body: { projectId: project.id } }
    );
    assert.equal(submitted.status, "in_review");
    const reviewed = await apiRequest(
      reviewerToken,
      "POST",
      `/v1/learning-proposals/${proposalId}/review`,
      {
        body: {
          projectId: project.id,
          approved: true,
          reason: "Declarative regression proposal is safe for canary."
        }
      }
    );
    assert.equal(reviewed.status, "approved");
    const canary = await apiRequest(
      reviewerToken,
      "POST",
      `/v1/learning-proposals/${proposalId}/canary`,
      {
        body: {
          projectId: project.id,
          passed: true,
          environment: "enterprise-api-e2e",
          evidenceDigest: evalAsset.digest
        }
      }
    );
    assert.equal(canary.status, "canary_passed");
    const deniedPromotion = await apiRequest(
      governanceToken,
      "POST",
      `/v1/learning-proposals/${proposalId}/promote`,
      {
        expected: [403],
        body: {
          projectId: project.id,
          rollbackRef: `standards-lock:${activated.lock.digest}`,
          signature: {
            algorithm: "ed25519",
            keyId: "untrusted-enterprise-e2e",
            value: "untrusted-signature"
          }
        }
      }
    );
    assert.match(deniedPromotion.error, /not trusted/u);
    const learningCurrent = await apiRequest(
      governanceToken,
      "GET",
      `/v1/learning-proposals/${proposalId}?projectId=${encodeURIComponent(project.id)}`
    );
    assert.equal(learningCurrent.status, "canary_passed");
    const packsAfterLearning = await apiRequest(
      governanceToken,
      "GET",
      "/v1/standard-packs"
    );
    const governanceAfterLearning = await apiRequest(
      governanceToken,
      "GET",
      `/v1/projects/${project.id}/effective-governance?${governanceQuery}`
    );
    assert.equal(
      packsAfterLearning.standardPacks.length,
      packsBeforeLearning.standardPacks.length
    );
    assert.equal(
      governanceAfterLearning.snapshot.digest,
      governanceBeforeLearning.snapshot.digest
    );

    step("verifying tenant-scoped append-only audit evidence");
    const audit = await apiRequest(
      auditorToken,
      "GET",
      `/v1/audit-events?projectId=${encodeURIComponent(project.id)}&limit=1000`
    );
    assert.ok(audit.auditEvents.length > 0);
    for (const action of [
      "POST /v1/tasks",
      `POST /v1/runs/${run.id}/approve`,
      "POST /v1/eval-assets",
      "POST /v1/trace-graphs",
      "POST /v1/maturity-report",
      "POST /v1/learning-proposals"
    ]) {
      assert.ok(
        audit.auditEvents.some((event) => event.action === action),
        `missing audit action ${action}`
      );
    }
    assert.ok(audit.auditEvents.every((event) => event.tenantId === tenantId));
    const pgAudit = await pg.query(
      "SELECT count(*)::int AS count FROM mn_audit_events WHERE tenant_id=$1",
      [tenantId]
    );
    assert.ok(pgAudit.rows[0].count >= audit.auditEvents.length);
    const telemetry = await fetch(otlpStatusUrl, {
      signal: AbortSignal.timeout(5_000)
    }).then(async (response) => {
      assert.equal(response.ok, true, `OTLP status returned ${response.status}`);
      return response.json();
    });
    assert.ok(telemetry.acceptedTraceSpans > 0);

    return {
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      specRef,
      bindings,
      standardPack: { id: pack.id, version: pack.version, digest: imported.digest },
      repair: {
        attempts: completedState.budgetUsage.repairAttempts,
        failedGateIds: failedGates.results
          .filter((gate) => gate.status !== "pass")
          .map((gate) => gate.gateId),
        passedGateIds: [...new Set(passedGates.results.map((gate) => gate.gateId))]
      },
      productWorker,
      postgres: {
        queueBackend: "postgresql",
        attempts: completedRow.attempt,
        terminalStatus: completedRow.status
      },
      s3: {
        bucket: remoteArtifact.remote.bucket,
        key: remoteArtifact.remote.key,
        sha256: remoteArtifact.remote.sha256
      },
      evidence: {
        evalAssetDigest: evalAsset.digest,
        traceDigest: trace.graph.digest,
        traceabilityRate: trace.analysis.traceabilityRate,
        maturityDigest: maturity.report.digest
      },
      learning: {
        id: proposalId,
        status: learningCurrent.status,
        automaticallyActivated: false,
        untrustedPromotionRejected: true
      },
      telemetry: { acceptedTraceSpans: telemetry.acceptedTraceSpans },
      auditEventCount: audit.auditEvents.length
    };
  } finally {
    if (activeClaimToken) {
      await apiRequest(
        activeWorkerToken,
        "POST",
        `/v1/run-jobs/queue/${run.id}/release`,
        {
          expected: [200, 404, 409],
          body: {
            ownerId: activeWorkerId,
            claimToken: activeClaimToken,
            capacity: 1,
            ttlMs: 120_000
          }
        }
      ).catch((error) => {
        console.warn(`[enterprise-api-flow] claim cleanup warning: ${error.message}`);
      });
    }
    if (sandboxBackend && sandboxLeaseId) {
      await sandboxBackend.release(sandboxLeaseId).catch((error) => {
        console.warn(`[enterprise-api-flow] sandbox cleanup warning: ${error.message}`);
      });
    }
    if (resumeSandboxBackend && resumeSandboxLeaseId) {
      await resumeSandboxBackend.release(resumeSandboxLeaseId).catch((error) => {
        console.warn(`[enterprise-api-flow] resume sandbox cleanup warning: ${error.message}`);
      });
    }
    if (pgConnected) await pg.end();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
    void stopApi();
  });
}

let summary;
try {
  await ensureBuiltRuntime();
  await startProviderUpstream();
  stateRoot = await mkdtemp(join(tmpdir(), "mn-enterprise-api-flow-"));
  const fixtureRoot = await prepareFixtureWorkspace(stateRoot);
  await startApi(stateRoot, fixtureRoot);
  const health = await waitForApi();
  if (providerProxyUrl) {
    const proxyProbe = await fetch(`${providerProxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "probe", input: "must-not-dispatch" })
    });
    assert.equal(proxyProbe.status, 401, await responseDetail(proxyProbe));
  }
  const runtime = {
    specs: await import(runtimeModule("packages/specs/dist/index.js")),
    governance: await import(runtimeModule("packages/governance/dist/index.js")),
    loop: await import(runtimeModule("packages/loop/dist/index.js")),
    worker: await import(runtimeModule("apps/worker/dist/index.js")),
    artifacts: await import(runtimeModule("apps/api/dist/artifactRemoteStore.js")),
    pg: await import("pg")
  };
  summary = await runProductOnlyFlow(fixtureRoot, runtime);
  step("locally_verified");
  console.log(
    JSON.stringify(
      {
        status: "locally_verified",
        api: {
          url: apiUrl,
          startedByFlow: !targetExistingApi,
          runtimeProfile: health.runtimeProfile,
          metadataBackend: health.metadataBackend,
          queueBackend: health.queueBackend,
          ...(providerProxyUrl ? { providerProxyUrl } : {})
        },
        ...summary
      },
      null,
      2
    )
  );
} finally {
  await stopApi().catch((error) => {
    console.warn(`[enterprise-api-flow] API cleanup warning: ${error.message}`);
  });
  if (stateRoot && !targetExistingApi) {
    await rm(stateRoot, { recursive: true, force: true }).catch((error) => {
      console.warn(`[enterprise-api-flow] state cleanup warning: ${error.message}`);
    });
  }
  if (providerUpstream) {
    await new Promise((resolve) => providerUpstream.close(resolve));
  }
}

if (interruptedSignal) {
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
}
