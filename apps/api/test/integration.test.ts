import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  hashSkillRegistryFiles,
  hashSkillRegistryReleasePayload,
  skillRegistryReleaseSignaturePayload,
  skillRegistrySignaturePayload,
  type SkillRegistryFile
} from "@mn/extensions";
import { FileLocalStore, LocalSecretVault } from "@mn/store";
import { RunJobLeaseManager, type RunJobLease } from "../src/runJobLease.js";
import { RunJobQueue, type RunJobQueueItem } from "../src/runJobQueue.js";
import { buildServer, defaultSecretVaultBackend } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

test("packaged macOS daemon defaults secrets to Keychain", () => {
  assert.equal(defaultSecretVaultBackend({ MN_DESKTOP_PACKAGED: "1" }, "darwin"), "keychain");
  assert.equal(
    defaultSecretVaultBackend(
      { MN_DESKTOP_PACKAGED: "1", MN_SECRET_VAULT_BACKEND: "local_encrypted" },
      "darwin"
    ),
    "local_encrypted"
  );
  assert.equal(defaultSecretVaultBackend({}, "darwin"), "local_encrypted");
});

test("api completes project to run flow with mock executors and npm gates", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-api-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-api-worktrees-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-artifacts-store-"));
  const store = new MemoryStore();
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"console.log('unit test ok')\"",
      typecheck: "node -e \"console.log('typecheck ok')\""
    }
  });
  await mkdir(join(projectRoot, "services", "api"), { recursive: true });
  await writePackageJson(join(projectRoot, "services", "api"), {
    name: "api"
  });

  const app = buildServer({
    store,
    mniuRoot,
    workspaceRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().executorMode, "mock");
  assert.equal(health.json().workspaceRoot, workspaceRoot);

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "demo",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();

  const indexResponse = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/index`,
    payload: {}
  });
  assert.equal(indexResponse.statusCode, 200);
  const canonicalProjectRoot = await realpath(projectRoot);
  assert.equal(
    indexResponse
      .json()
      .project.services.some((service: { name: string }) => service.name === "api"),
    true
  );
  assert.equal(
    indexResponse
      .json()
      .project.services.some(
        (service: { path: string }) => service.path === canonicalProjectRoot
      ),
    true
  );

  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "probe",
      prompt: "make no changes",
      targetServices: ["api"],
      acceptanceCriteria: ["mock executor completes"],
      strategy: {
        providers: ["claude", "codex"],
        candidates: 2,
        sandbox: "workspace-write",
        requiredGates: ["unit_test", "typecheck", "llm_verifier"],
        humanApproval: "never",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);
  const task = taskResponse.json();

  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: {}
  });
  assert.equal(runResponse.statusCode, 201);
  const createdRun = runResponse.json();
  assert.equal(typeof createdRun.id, "string");
  assert.ok(["queued", "preparing", "running", "verifying", "completed"].includes(createdRun.status));
  const run = await waitForRunStatus(app, createdRun.id, "completed");
  assert.equal(run.status, "completed");
  assert.equal(run.candidates.length, 2);
  assert.ok(run.winnerCandidateId);
  const runJobQueue = new RunJobQueue({
    rootDir: join(mniuRoot, "run-job-queue")
  });
  const queuedJob = await waitForRunJobQueueStatus(runJobQueue, run.id, "completed");
  assert.equal(queuedJob.status, "completed");
  assert.equal(queuedJob.projectId, project.id);
  assert.equal(queuedJob.taskId, task.id);
  assert.equal(queuedJob.attempt, 1);
  assert.equal(typeof queuedJob.startedAt, "string");
  assert.equal(typeof queuedJob.finishedAt, "string");
  assert.equal(typeof queuedJob.ownerId, "string");
  assert.equal(runJobQueue.listClaimable().length, 0);
  assert.equal(
    run.gates.some(
      (gate: { gate: string; status: string }) =>
        gate.gate === "unit_test" && gate.status === "pass"
    ),
    true
  );
  assert.equal(
    run.gates.some(
      (gate: { gate: string; status: string }) =>
        gate.gate === "typecheck" && gate.status === "pass"
    ),
    true
  );

  const artifactsResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts`
  });
  assert.equal(artifactsResponse.statusCode, 200);
  const artifacts = artifactsResponse.json().artifacts as Array<{
    kind: string;
    path: string;
    candidateId?: string;
    gate?: string;
    inlineText?: string;
    source?: string;
    persisted?: boolean;
  }>;
  assert.equal(
    artifacts.some(
      (artifact) =>
        artifact.kind === "log" &&
        artifact.path.endsWith("/stdout.txt") &&
        artifact.inlineText?.includes("mock claude completed")
    ),
    true
  );
  assert.equal(
    artifacts.some(
      (artifact) =>
        artifact.kind === "test-report" &&
        artifact.gate === "unit_test" &&
        artifact.source === "gate_result"
    ),
    true
  );
  const filteredArtifactsResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts?candidateId=claude-1&provider=claude&kind=test-report&gate=unit_test`
  });
  assert.equal(filteredArtifactsResponse.statusCode, 200);
  const filteredArtifacts = filteredArtifactsResponse.json().artifacts as Array<{
    kind: string;
    candidateId?: string;
    provider?: string;
    gate?: string;
  }>;
  assert.ok(filteredArtifacts.length > 0);
  assert.equal(
    filteredArtifacts.every(
      (artifact) =>
        artifact.candidateId === "claude-1" &&
        artifact.provider === "claude" &&
        artifact.kind === "test-report" &&
        artifact.gate === "unit_test"
    ),
    true
  );

  const stdoutDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts/${encodeURIComponent("claude-1:stdout")}`
  });
  assert.equal(stdoutDownload.statusCode, 200);
  assert.match(stdoutDownload.body, /mock claude completed/);
  assert.match(stdoutDownload.headers["content-disposition"] as string, /stdout\.txt/);
  assert.match(
    stdoutDownload.headers["access-control-expose-headers"] as string,
    /content-disposition/
  );

  const artifactIndex = JSON.parse(
    await readFile(join(mniuRoot, "artifacts", "runs", run.id, "index.json"), "utf8")
  ) as { artifacts: Array<{ artifactId: string; sha256: string; bytes: number }> };
  assert.equal(
    artifactIndex.artifacts.some(
      (artifact) => artifact.artifactId === "claude-1:stdout" && artifact.bytes > 0
    ),
    true
  );

  const storedRun = store.runs.get(run.id);
  assert.ok(storedRun);
  store.runs.set(run.id, {
    ...storedRun,
    candidates: storedRun.candidates.map((candidate) =>
      candidate.id === "claude-1" && candidate.result
        ? { ...candidate, result: { ...candidate.result, stdout: "" } }
        : candidate
    )
  });

  const persistedArtifactsResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts`
  });
  assert.equal(persistedArtifactsResponse.statusCode, 200);
  assert.equal(
    persistedArtifactsResponse
      .json()
      .artifacts.some(
        (artifact: { id: string; persisted?: boolean }) =>
          artifact.id === "claude-1:stdout" && artifact.persisted === true
      ),
    true
  );

  const persistedStdoutDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts/${encodeURIComponent("claude-1:stdout")}`
  });
  assert.equal(persistedStdoutDownload.statusCode, 200);
  assert.match(persistedStdoutDownload.body, /mock claude completed/);

  const archiveDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts/archive`
  });
  assert.equal(archiveDownload.statusCode, 200);
  assert.match(archiveDownload.headers["content-type"] as string, /application\/x-tar/);
  assert.match(
    archiveDownload.headers["content-disposition"] as string,
    /artifacts\.tar/
  );
  assert.match(archiveDownload.body, /manifest\.json/);
  assert.match(archiveDownload.body, /claude-1:stdout/);
  assert.match(archiveDownload.body, /mock claude completed/);
  const archiveBuffer =
    (archiveDownload as unknown as { rawPayload?: Buffer }).rawPayload ??
    Buffer.from(archiveDownload.body, "binary");
  const archiveEntries = parseTarEntries(archiveBuffer);
  assert.ok(archiveEntries.has("manifest.json"));
  assert.equal(
    JSON.parse(archiveEntries.get("manifest.json")!.toString("utf8")).runId,
    run.id
  );
  assert.equal(
    [...archiveEntries.values()].some((content) =>
      content.toString("utf8").includes("mock claude completed")
    ),
    true
  );
  const filteredArchiveDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts/archive?candidateId=claude-1&kind=test-report&gate=unit_test`
  });
  assert.equal(filteredArchiveDownload.statusCode, 200);
  const filteredArchiveBuffer =
    (filteredArchiveDownload as unknown as { rawPayload?: Buffer }).rawPayload ??
    Buffer.from(filteredArchiveDownload.body, "binary");
  const filteredArchiveEntries = parseTarEntries(filteredArchiveBuffer);
  const filteredManifest = JSON.parse(
    filteredArchiveEntries.get("manifest.json")!.toString("utf8")
  ) as {
    filters: { candidateId?: string; kind?: string; gate?: string };
    artifacts: Array<{ kind: string; candidateId?: string; gate?: string }>;
  };
  assert.deepEqual(filteredManifest.filters, {
    candidateId: "claude-1",
    kind: "test-report",
    gate: "unit_test"
  });
  assert.equal(
    filteredManifest.artifacts.every(
      (artifact) =>
        artifact.candidateId === "claude-1" &&
        artifact.kind === "test-report" &&
        artifact.gate === "unit_test"
    ),
    true
  );
  assert.equal(
    [...filteredArchiveEntries.values()].some((content) =>
      content.toString("utf8").includes("mock claude completed")
    ),
    false
  );

  const gateDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/artifacts/${encodeURIComponent("claude-1:gate:unit_test")}`
  });
  assert.equal(gateDownload.statusCode, 200);
  assert.equal(gateDownload.json().gate, "unit_test");
});

test("api previews and confirms shell env cleanup with backup", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-env-cleanup-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-env-cleanup-mniu-"));
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-process-openai-value";
  t.after(async () => {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await writeFile(
    join(homeDir, ".zshrc"),
    "export OPENAI_API_KEY=sk-file-openai-value\necho keep\n"
  );
  await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(
    join(homeDir, "Library", "LaunchAgents", "dev.muniu.env.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>OPENAI_API_KEY</key>",
      "    <string>sk-launchd-openai-value</string>",
      "  </dict>",
      "</dict>",
      "</plist>"
    ].join("\n") + "\n"
  );

  const app = buildServer({
    homeDir,
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const dryRun = await app.inject({
    method: "POST",
    url: "/v1/system/env-cleanup",
    payload: { names: ["OPENAI_API_KEY"] }
  });
  assert.equal(dryRun.statusCode, 200);
  assert.equal(dryRun.json().dryRun, true);
  assert.equal(dryRun.json().removed.length, 1);
  assert.equal(dryRun.json().manualActions.length, 1);
  assert.equal(dryRun.json().manualActions[0].command, "unset OPENAI_API_KEY");
  assert.match(await readFile(join(homeDir, ".zshrc"), "utf8"), /OPENAI_API_KEY/);

  const confirmed = await app.inject({
    method: "POST",
    url: "/v1/system/env-cleanup",
    payload: { dryRun: false, names: ["OPENAI_API_KEY"] }
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().dryRun, false);
  assert.equal(confirmed.json().removed.length, 1);
  assert.ok(confirmed.json().changedFiles[0].backupPath);
  const cleaned = await readFile(join(homeDir, ".zshrc"), "utf8");
  assert.doesNotMatch(cleaned, /OPENAI_API_KEY/);
  assert.match(cleaned, /echo keep/);

  const launchDryRun = await app.inject({
    method: "POST",
    url: "/v1/system/env-cleanup",
    payload: { sources: ["launch_agent"], names: ["OPENAI_API_KEY"] }
  });
  assert.equal(launchDryRun.statusCode, 200);
  assert.equal(launchDryRun.json().dryRun, true);
  assert.equal(launchDryRun.json().removed.length, 1);

  const launchConfirmed = await app.inject({
    method: "POST",
    url: "/v1/system/env-cleanup",
    payload: { dryRun: false, sources: ["launch_agent"], names: ["OPENAI_API_KEY"] }
  });
  assert.equal(launchConfirmed.statusCode, 200);
  assert.equal(launchConfirmed.json().removed[0].source, "launch_agent");
  assert.ok(launchConfirmed.json().changedFiles[0].backupPath);
  const cleanedLaunchAgent = await readFile(
    join(homeDir, "Library", "LaunchAgents", "dev.muniu.env.plist"),
    "utf8"
  );
  assert.doesNotMatch(cleanedLaunchAgent, /OPENAI_API_KEY/);
});

test("api diagnostics collects redacted mniu log tails", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-diagnostics-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-diagnostics-mniu-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await mkdir(join(mniuRoot, "logs"), { recursive: true });
  await mkdir(join(homeDir, "Library", "Logs", "DiagnosticReports"), {
    recursive: true
  });
  await mkdir(join(homeDir, "Library", "Logs", "dev.muniu.desktop"), {
    recursive: true
  });
  await writeFile(
    join(mniuRoot, "logs", "mn-api.log"),
    [
      "2026-07-07T00:00:00Z starting",
      "Authorization: Bearer settings-log-secret",
      "OPENAI_API_KEY=sk-settings-log-openai",
      "regular line"
    ].join("\n") + "\n"
  );
  await writeFile(join(mniuRoot, "logs", "ignored.bin"), "Bearer should-not-read\n");
  await writeFile(
    join(homeDir, "Library", "Logs", "DiagnosticReports", "Muniu_2026-07-07.crash"),
    [
      "Process: Muniu",
      "Reason: simulated crash",
      "token=crash-secret-token"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "Logs", "DiagnosticReports", "OtherApp_2026-07-07.crash"),
    "Bearer other-app-secret\n"
  );
  await writeFile(
    join(homeDir, "Library", "Logs", "dev.muniu.desktop", "mniu-desktop.log"),
    [
      "desktop packaged app line",
      "password=desktop-app-log-secret"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "Logs", "dev.muniu.desktop", "ignored.dat"),
    "token=ignored-app-log-secret\n"
  );

  const app = buildServer({ homeDir, mniuRoot, useMockExecutors: true });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/system/diagnostics"
  });
  assert.equal(response.statusCode, 200);
  const diagnostics = response.json();
  assert.equal(diagnostics.kind, "mniu.diagnostics");
  assert.equal(diagnostics.doctor.api.mniuRoot, mniuRoot);
  assert.equal(diagnostics.logs.files.length, 1);
  assert.equal(diagnostics.logs.files[0].relativePath, "logs/mn-api.log");
  assert.match(diagnostics.logs.files[0].tail, /Bearer \[REDACTED\]/);
  assert.match(diagnostics.logs.files[0].tail, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(diagnostics.logs.files[0].tail, /settings-log-secret/);
  assert.doesNotMatch(diagnostics.logs.files[0].tail, /sk-settings-log-openai/);
  assert.equal(diagnostics.crashReports.files.length, 1);
  assert.equal(
    diagnostics.crashReports.files[0].relativePath,
    "DiagnosticReports/Muniu_2026-07-07.crash"
  );
  assert.match(diagnostics.crashReports.files[0].tail, /Process: Muniu/);
  assert.match(diagnostics.crashReports.files[0].tail, /token=\[REDACTED\]/);
  assert.doesNotMatch(diagnostics.crashReports.files[0].tail, /crash-secret-token/);
  assert.doesNotMatch(JSON.stringify(diagnostics.crashReports), /other-app-secret/);
  assert.equal(diagnostics.appLogs.files.length, 1);
  assert.equal(
    diagnostics.appLogs.files[0].relativePath,
    "ApplicationLogs/dev.muniu.desktop/mniu-desktop.log"
  );
  assert.match(diagnostics.appLogs.files[0].tail, /desktop packaged app line/);
  assert.match(diagnostics.appLogs.files[0].tail, /password=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(diagnostics.appLogs), /desktop-app-log-secret/);
  assert.doesNotMatch(JSON.stringify(diagnostics.appLogs), /ignored-app-log-secret/);
});

test("api exposes run job queue claim heartbeat and release", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-queue-claim-"));
  t.after(async () => {
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const app = buildServer({
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const queue = new RunJobQueue({
    rootDir: join(mniuRoot, "run-job-queue")
  });
  queue.enqueue({
    runId: "run-api-claim",
    projectId: "project-api",
    taskId: "task-api",
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  });

  const claimableBefore = await app.inject({
    method: "GET",
    url: "/v1/run-jobs/queue?status=claimable"
  });
  assert.equal(claimableBefore.statusCode, 200);
  assert.deepEqual(
    claimableBefore.json().items.map((item: { runId: string }) => item.runId),
    ["run-api-claim"]
  );

  const claimResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    payload: {
      ownerId: "worker-api",
      ttlMs: 60_000
    }
  });
  assert.equal(claimResponse.statusCode, 200);
  const claimBody = claimResponse.json();
  assert.equal(claimBody.item.runId, "run-api-claim");
  assert.equal(claimBody.item.status, "running");
  assert.equal(claimBody.item.ownerId, "worker-api");
  assert.equal(typeof claimBody.claimToken, "string");
  assert.equal(claimBody.item.priority, 0);

  const workersAfterClaim = await app.inject({
    method: "GET",
    url: "/v1/run-jobs/workers"
  });
  assert.equal(workersAfterClaim.statusCode, 200);
  assert.equal(workersAfterClaim.json().summary.running, 1);
  assert.equal(workersAfterClaim.json().summary.capacity, 1);
  assert.equal(workersAfterClaim.json().summary.activeRunCount, 1);
  assert.equal(workersAfterClaim.json().summary.availableSlots, 0);
  assert.equal(workersAfterClaim.json().workers[0].ownerId, "worker-api");
  assert.equal(workersAfterClaim.json().workers[0].activeRunId, "run-api-claim");
  assert.deepEqual(workersAfterClaim.json().workers[0].activeRunIds, ["run-api-claim"]);

  queue.enqueue({
    runId: "run-api-second",
    projectId: "project-api",
    taskId: "task-api",
    priority: 10,
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-06T00:00:02.000Z",
    updatedAt: "2026-07-06T00:00:02.000Z"
  });

  const busyClaimResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    payload: {
      ownerId: "worker-api",
      ttlMs: 60_000
    }
  });
  assert.equal(busyClaimResponse.statusCode, 200);
  assert.equal(busyClaimResponse.json().item, null);
  assert.equal(busyClaimResponse.json().claimToken, null);
  assert.equal(busyClaimResponse.json().reason, "worker_at_capacity");
  assert.equal(queue.read("run-api-second")?.status, "queued");

  const claimableAfter = await app.inject({
    method: "GET",
    url: "/v1/run-jobs/queue?status=claimable"
  });
  assert.equal(claimableAfter.statusCode, 200);
  assert.deepEqual(
    claimableAfter.json().items.map((item: { runId: string }) => item.runId),
    ["run-api-second"]
  );

  const heartbeatResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/run-api-claim/heartbeat",
    payload: {
      ownerId: "worker-api",
      claimToken: claimBody.claimToken,
      ttlMs: 120_000
    }
  });
  assert.equal(heartbeatResponse.statusCode, 200);
  assert.equal(heartbeatResponse.json().item.ownerId, "worker-api");
  assert.equal(typeof heartbeatResponse.json().item.heartbeatAt, "string");

  const runningWorkers = await app.inject({
    method: "GET",
    url: "/v1/run-jobs/workers?state=running"
  });
  assert.equal(runningWorkers.statusCode, 200);
  assert.equal(runningWorkers.json().workers.length, 1);

  const releaseResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/run-api-claim/release",
    payload: {
      ownerId: "worker-api",
      claimToken: claimBody.claimToken
    }
  });
  assert.equal(releaseResponse.statusCode, 200);
  assert.equal(releaseResponse.json().item.status, "queued");
  assert.equal(releaseResponse.json().item.claimToken, undefined);

  const workersAfterRelease = await app.inject({
    method: "GET",
    url: "/v1/run-jobs/workers?ownerId=worker-api"
  });
  assert.equal(workersAfterRelease.statusCode, 200);
  assert.equal(workersAfterRelease.json().summary.idle, 1);
  assert.equal(workersAfterRelease.json().summary.availableSlots, 1);
  assert.equal(workersAfterRelease.json().workers[0].activeRunId, undefined);
  assert.equal(workersAfterRelease.json().workers[0].releasedRunCount, 1);

  const staleHeartbeatResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/run-api-claim/heartbeat",
    payload: {
      ownerId: "worker-api",
      claimToken: claimBody.claimToken
    }
  });
  assert.equal(staleHeartbeatResponse.statusCode, 409);
});

test("api supports queue-only runs and claimed external worker updates", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-api-external-worker-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-api-external-worker-worktrees-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-external-worker-mniu-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  await writePackageJson(projectRoot, { scripts: {} });
  const app = buildServer({
    mniuRoot,
    workspaceRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "external-worker-demo",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();

  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "external worker task",
      prompt: "make no changes",
      targetServices: [],
      acceptanceCriteria: ["external worker completes"],
      strategy: {
        providers: ["claude"],
        candidates: 1,
        sandbox: "workspace-write",
        requiredGates: [],
        humanApproval: "never",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);
  const task = taskResponse.json();

  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: { queueOnly: true, queuePriority: 7 }
  });
  assert.equal(runResponse.statusCode, 201);
  const queuedRun = runResponse.json();
  assert.equal(queuedRun.status, "queued");

  const queue = new RunJobQueue({
    rootDir: join(mniuRoot, "run-job-queue")
  });
  assert.equal(queue.read(queuedRun.id)?.status, "queued");
  assert.equal(queue.read(queuedRun.id)?.priority, 7);

  const claimResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    payload: { ownerId: "external-worker-test", ttlMs: 60_000 }
  });
  assert.equal(claimResponse.statusCode, 200);
  const claim = claimResponse.json();
  assert.equal(claim.item.runId, queuedRun.id);
  assert.equal(claim.item.status, "running");
  assert.equal(claim.item.priority, 7);

  const eventResponse = await app.inject({
    method: "POST",
    url: `/v1/run-jobs/queue/${queuedRun.id}/events`,
    payload: {
      ownerId: "external-worker-test",
      claimToken: claim.claimToken,
      ttlMs: 60_000,
      event: {
        type: "status",
        message: "external worker started",
        timestamp: "2026-07-06T00:00:01.000Z"
      }
    }
  });
  assert.equal(eventResponse.statusCode, 200);

  const runningRun = {
    ...queuedRun,
    status: "running",
    updatedAt: new Date(Date.parse(queuedRun.updatedAt) + 1_000).toISOString()
  };
  const malformedEvidenceResponse = await app.inject({
    method: "POST",
    url: `/v1/run-jobs/queue/${queuedRun.id}/update`,
    payload: {
      ownerId: "external-worker-test",
      claimToken: claim.claimToken,
      ttlMs: 60_000,
      run: {
        ...runningRun,
        gateResultsV2: [{ schemaVersion: 2, artifacts: null }]
      }
    }
  });
  assert.equal(malformedEvidenceResponse.statusCode, 400);
  assert.match(malformedEvidenceResponse.json().error, /Invalid GateResultV2/u);

  const updateResponse = await app.inject({
    method: "POST",
    url: `/v1/run-jobs/queue/${queuedRun.id}/update`,
    payload: {
      ownerId: "external-worker-test",
      claimToken: claim.claimToken,
      ttlMs: 60_000,
      run: runningRun
    }
  });
  assert.equal(updateResponse.statusCode, 200, updateResponse.body);
  assert.equal(updateResponse.json().run.status, "running");

  const completedRun = {
    ...runningRun,
    status: "completed",
    updatedAt: new Date(Date.parse(runningRun.updatedAt) + 1_000).toISOString()
  };
  const finishResponse = await app.inject({
    method: "POST",
    url: `/v1/run-jobs/queue/${queuedRun.id}/finish`,
    payload: {
      ownerId: "external-worker-test",
      claimToken: claim.claimToken,
      ttlMs: 60_000,
      run: completedRun
    }
  });
  assert.equal(finishResponse.statusCode, 200);
  assert.equal(finishResponse.json().run.status, "completed");
  assert.equal(finishResponse.json().item.status, "completed");
  assert.equal(finishResponse.json().item.claimToken, undefined);
  assert.equal(queue.read(queuedRun.id)?.status, "completed");

  const eventsResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${queuedRun.id}/events`
  });
  assert.equal(eventsResponse.statusCode, 200);
  assert.equal(
    eventsResponse
      .json()
      .events.some((event: { message: string }) => event.message === "external worker started"),
    true
  );
});

test("api streams background run events and cancels active jobs", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-api-cancel-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-api-cancel-worktrees-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-cancel-mniu-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"setInterval(() => console.log('still running'), 1000)\""
    }
  });

  const app = buildServer({
    mniuRoot,
    workspaceRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "demo",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();

  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "cancel probe",
      prompt: "make no changes",
      acceptanceCriteria: ["can cancel"],
      strategy: {
        providers: ["claude"],
        candidates: 1,
        sandbox: "workspace-write",
        requiredGates: ["unit_test"],
        humanApproval: "never",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);
  const task = taskResponse.json();

  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: {}
  });
  assert.equal(runResponse.statusCode, 201);
  const run = runResponse.json();

  const streamResponse = await fetch(`${baseUrl}/v1/runs/${run.id}/events/stream`);
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(streamResponse.body);
  const reader = streamResponse.body.getReader();
  const firstEvents = await readSseUntil(reader, "Running candidates");
  assert.match(firstEvents, /Run queued|Preparing run/);

  const cancelResponse = await app.inject({
    method: "POST",
    url: `/v1/runs/${run.id}/cancel`,
    payload: {}
  });
  assert.equal(cancelResponse.statusCode, 200);
  assert.equal(cancelResponse.json().status, "cancelled");

  const cancelEvents = await readSseUntil(reader, "Run cancelled");
  assert.match(cancelEvents, /Run cancellation requested/);
  await reader.cancel();

  const cancelledRun = await waitForRunStatus(app, run.id, "cancelled");
  assert.equal(cancelledRun.status, "cancelled");
  const cancelQueue = new RunJobQueue({
    rootDir: join(mniuRoot, "run-job-queue")
  });
  const cancelledQueueItem = await waitForRunJobQueueStatus(cancelQueue, run.id, "cancelled");
  assert.equal(cancelledQueueItem.status, "cancelled");
  assert.equal(typeof cancelledQueueItem.finishedAt, "string");
  const eventsResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/events`
  });
  assert.equal(eventsResponse.statusCode, 200);
  assert.equal(
    eventsResponse
      .json()
      .events.some((event: { message: string }) => event.message.includes("cancel")),
    true
  );
  const auditResponse = await app.inject({ method: "GET", url: "/v1/audit-events" });
  const cancelAudit = (auditResponse.json().auditEvents as Array<{
    action: string;
    resourceId?: string;
    projectId?: string;
    beforeDigest?: string;
    afterDigest?: string;
    result: string;
  }>).find((event) => event.action === "run.cancel");
  assert.deepEqual(
    {
      resourceId: cancelAudit?.resourceId,
      projectId: cancelAudit?.projectId,
      result: cancelAudit?.result
    },
    { resourceId: run.id, projectId: project.id, result: "success" }
  );
  assert.match(cancelAudit?.beforeDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(cancelAudit?.afterDigest ?? "", /^[a-f0-9]{64}$/u);
});

test("api persists completed runs and events when state path is configured", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-state-"));
  const projectRoot = join(tempRoot, "project");
  const workspaceRoot = join(tempRoot, "worktrees");
  const statePath = join(tempRoot, "api-state.json");
  await mkdir(projectRoot, { recursive: true });
  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"console.log('unit ok')\"",
      typecheck: "node -e \"console.log('typecheck ok')\""
    }
  });
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const app1 = buildServer({
    apiStatePath: statePath,
    workspaceRoot,
    useMockExecutors: true
  });
  const projectResponse = await app1.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "persisted",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();
  await app1.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/index`,
    payload: {}
  });
  const taskResponse = await app1.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "Persist run",
      intent: "implement",
      targetServices: [],
      prompt: "no changes",
      acceptanceCriteria: ["passes"],
      strategy: {
        providers: ["codex"],
        candidates: 1,
        sandbox: "isolated-worktree",
        requiredGates: ["unit_test", "typecheck", "llm_verifier"],
        humanApproval: "never",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);
  const task = taskResponse.json();
  const runResponse = await app1.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: { wait: true }
  });
  assert.equal(runResponse.statusCode, 201);
  const run = runResponse.json();
  assert.equal(run.status, "completed");
  const candidateWorkspace = run.candidates[0]?.worktreePath;
  assert.equal(typeof candidateWorkspace, "string");
  await lstat(candidateWorkspace);
  const eventsResponse = await app1.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/events`
  });
  assert.equal(eventsResponse.statusCode, 200);
  assert.ok(eventsResponse.json().events.length > 0);
  await app1.close();

  const app2 = buildServer({
    apiStatePath: statePath,
    workspaceRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app2.close();
  });
  const persistedRunResponse = await app2.inject({
    method: "GET",
    url: `/v1/runs/${run.id}`
  });
  assert.equal(persistedRunResponse.statusCode, 200);
  assert.equal(persistedRunResponse.json().status, "completed");
  assert.equal(persistedRunResponse.json().winnerCandidateId, "codex-1");

  const persistedEventsResponse = await app2.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/events`
  });
  assert.equal(persistedEventsResponse.statusCode, 200);
  assert.ok(
    persistedEventsResponse
      .json()
      .events.some((event: { message: string }) => event.message.includes("Run completed"))
  );

  const cleanupResponse = await app2.inject({
    method: "POST",
    url: `/v1/runs/${run.id}/workspaces/cleanup`,
    payload: {}
  });
  assert.equal(cleanupResponse.statusCode, 200);
  assert.equal(cleanupResponse.json().results[0].status, "deleted");
  assert.equal(cleanupResponse.json().results[0].candidateId, "codex-1");
  await assert.rejects(lstat(candidateWorkspace));

  const cleanupEventsResponse = await app2.inject({
    method: "GET",
    url: `/v1/runs/${run.id}/events`
  });
  assert.equal(cleanupEventsResponse.statusCode, 200);
  assert.ok(
    cleanupEventsResponse
      .json()
      .events.some((event: { message: string }) =>
        event.message.includes("Workspace cleanup completed")
      )
  );

  await waitForPersistedRunJobStatus(statePath, run.id, "completed");
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  const persistedJob = persisted.runJobs.find(
    (job: { runId: string }) => job.runId === run.id
  );
  assert.equal(persistedJob.status, "completed");
  assert.equal(persistedJob.taskId, task.id);
  assert.equal(persistedJob.projectId, project.id);
  assert.equal(persistedJob.attempt, 1);
  assert.equal(typeof persistedJob.finishedAt, "string");
});

test("api state recovery marks interrupted active runs as failed", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-state-recover-"));
  const statePath = join(tempRoot, "api-state.json");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        projects: [],
        tasks: [],
        runs: [
          {
            id: "run-interrupted",
            taskId: "task-1",
            projectId: "project-1",
            status: "running",
            candidates: [
              {
                id: "codex-1",
                runId: "run-interrupted",
                provider: "codex",
                worktreePath: "/tmp/worktree",
                status: "running",
                gates: []
              }
            ],
            gates: [],
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        runJobs: [
          {
            runId: "run-interrupted",
            taskId: "task-1",
            projectId: "project-1",
            status: "running",
            attempt: 1,
            recovered: false,
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
            startedAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        events: []
      },
      null,
      2
    ),
    "utf8"
  );

  const store = new MemoryStore({ statePath });
  const recovered = store.recoverInterruptedRuns("2026-07-06T01:00:00.000Z");
  assert.deepEqual(recovered, ["run-interrupted"]);
  assert.equal(store.runs.get("run-interrupted")?.status, "failed");
  assert.equal(store.runs.get("run-interrupted")?.candidates[0]?.status, "failed");
  assert.ok(
    (store.events.get("run-interrupted") ?? []).some((event) =>
      event.message.includes("use resume")
    )
  );

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.runs[0].status, "failed");
  assert.equal(persisted.runJobs[0].status, "failed");
  assert.equal(persisted.runJobs[0].interruptedAt, "2026-07-06T01:00:00.000Z");
  assert.equal(persisted.events[0].events[0].type, "error");
});

test("api auto resumes persisted pending runs when enabled", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-pending-replay-"));
  const projectRoot = join(tempRoot, "project");
  const workspaceRoot = join(tempRoot, "worktrees");
  const mniuRoot = join(tempRoot, "mniu");
  const statePath = join(tempRoot, "api-state.json");
  let app: ReturnType<typeof buildServer> | undefined;
  t.after(async () => {
    await app?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(projectRoot, { recursive: true });
  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"console.log('unit ok')\""
    }
  });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        projects: [
          {
            id: "project-pending",
            name: "Pending replay project",
            rootPath: projectRoot,
            defaultBranch: "main",
            services: [],
            policyId: "default"
          }
        ],
        tasks: [
          {
            id: "task-pending",
            projectId: "project-pending",
            title: "Resume queued run",
            intent: "implement",
            targetServices: [],
            prompt: "finish the queued run",
            acceptanceCriteria: ["run completes"],
            strategy: {
              providers: ["codex"],
              candidates: 1,
              sandbox: "isolated-worktree",
              requiredGates: ["unit_test"],
              humanApproval: "never",
              timeoutSeconds: 30
            },
            createdAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        runs: [
          {
            id: "run-pending",
            taskId: "task-pending",
            projectId: "project-pending",
            status: "queued",
            candidates: [],
            gates: [],
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        runJobs: [
          {
            runId: "run-pending",
            taskId: "task-pending",
            projectId: "project-pending",
            status: "queued",
            attempt: 1,
            recovered: false,
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        events: []
      },
      null,
      2
    ),
    "utf8"
  );

  app = buildServer({
    apiStatePath: statePath,
    workspaceRoot,
    mniuRoot,
    useMockExecutors: true,
    autoResumePendingRuns: true
  });

  const run = await waitForRunStatus(app, "run-pending", "completed");
  assert.equal(run.id, "run-pending");
  assert.equal(run.candidates[0]?.provider, "codex");
  assert.equal(run.gates[0]?.status, "pass");

  const eventsResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-pending/events"
  });
  assert.equal(eventsResponse.statusCode, 200);
  assert.ok(
    eventsResponse
      .json()
      .events.some((event: { message: string }) =>
        event.message.includes("Run requeued after API restart")
      )
  );

  await waitForPersistedRunJobStatus(statePath, "run-pending", "completed");
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.runs[0].id, "run-pending");
  assert.equal(persisted.runs[0].status, "completed");
  assert.equal(persisted.runJobs[0].runId, "run-pending");
  assert.equal(persisted.runJobs[0].status, "completed");
  assert.equal(persisted.runJobs[0].attempt, 2);
  assert.equal(persisted.runJobs[0].recovered, true);
});

test("api auto resume skips pending runs leased by another process", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-pending-lease-"));
  const projectRoot = join(tempRoot, "project");
  const workspaceRoot = join(tempRoot, "worktrees");
  const mniuRoot = join(tempRoot, "mniu");
  const statePath = join(tempRoot, "api-state.json");
  let app: ReturnType<typeof buildServer> | undefined;
  let lease: RunJobLease | undefined;
  t.after(async () => {
    await app?.close();
    lease?.release();
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(projectRoot, { recursive: true });
  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"console.log('unit ok')\""
    }
  });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        projects: [
          {
            id: "project-leased",
            name: "Leased replay project",
            rootPath: projectRoot,
            defaultBranch: "main",
            services: [],
            policyId: "default"
          }
        ],
        tasks: [
          {
            id: "task-leased",
            projectId: "project-leased",
            title: "Do not duplicate leased run",
            intent: "implement",
            targetServices: [],
            prompt: "finish the queued run once",
            acceptanceCriteria: ["run completes"],
            strategy: {
              providers: ["codex"],
              candidates: 1,
              sandbox: "isolated-worktree",
              requiredGates: ["unit_test"],
              humanApproval: "never",
              timeoutSeconds: 30
            },
            createdAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        runs: [
          {
            id: "run-leased",
            taskId: "task-leased",
            projectId: "project-leased",
            status: "queued",
            candidates: [],
            gates: [],
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        runJobs: [
          {
            runId: "run-leased",
            taskId: "task-leased",
            projectId: "project-leased",
            status: "queued",
            attempt: 1,
            recovered: false,
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        events: []
      },
      null,
      2
    ),
    "utf8"
  );

  lease = new RunJobLeaseManager({
    rootDir: join(mniuRoot, "run-job-leases"),
    ownerId: "other-api",
    heartbeatMs: 0,
    ttlMs: 60_000
  }).acquire("run-leased");
  assert.ok(lease);

  app = buildServer({
    apiStatePath: statePath,
    workspaceRoot,
    mniuRoot,
    useMockExecutors: true,
    autoResumePendingRuns: true
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-leased"
  });
  assert.equal(runResponse.statusCode, 200);
  assert.equal(runResponse.json().status, "queued");
  assert.equal(runResponse.json().candidates.length, 0);

  const eventsResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-leased/events"
  });
  assert.equal(eventsResponse.statusCode, 200);
  assert.equal(
    eventsResponse
      .json()
      .events.some((event: { message: string }) =>
        event.message.includes("lease is held by another API process")
      ),
    true
  );

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.runs[0].status, "queued");
  assert.equal(persisted.runJobs[0].attempt, 1);
});

test("api auto resumes checkpointed runs without rerunning completed candidates", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-checkpoint-replay-"));
  const projectRoot = join(tempRoot, "project");
  const workspaceRoot = join(tempRoot, "worktrees");
  const mniuRoot = join(tempRoot, "mniu");
  const statePath = join(tempRoot, "api-state.json");
  let app: ReturnType<typeof buildServer> | undefined;
  t.after(async () => {
    await app?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(projectRoot, { recursive: true });
  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"console.log('checkpoint unit ok')\""
    }
  });
  const queuedCodexWorkspace = join(workspaceRoot, "run-queued-checkpoint-codex-2");
  await mkdir(queuedCodexWorkspace, { recursive: true });
  await writePackageJson(queuedCodexWorkspace, {
    scripts: {
      test: "node -e \"console.log('queued checkpoint unit ok')\""
    }
  });
  const checkpointStartedAt = "2026-07-06T00:00:00.000Z";
  const checkpointFinishedAt = "2026-07-06T00:00:01.000Z";
  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        projects: [
          {
            id: "project-checkpoint",
            name: "Checkpoint replay project",
            rootPath: projectRoot,
            defaultBranch: "main",
            services: [],
            policyId: "default"
          }
        ],
        tasks: [
          {
            id: "task-checkpoint",
            projectId: "project-checkpoint",
            title: "Resume checkpointed run",
            intent: "implement",
            targetServices: [],
            prompt: "finish remaining candidates",
            acceptanceCriteria: ["run completes"],
            strategy: {
              providers: ["claude", "codex"],
              candidates: 2,
              sandbox: "isolated-worktree",
              requiredGates: ["unit_test"],
              humanApproval: "never",
              timeoutSeconds: 30
            },
            createdAt: checkpointStartedAt
          }
        ],
        runs: [
          {
            id: "run-checkpoint",
            taskId: "task-checkpoint",
            projectId: "project-checkpoint",
            status: "running",
            candidates: [
              {
                id: "claude-1",
                runId: "run-checkpoint",
                provider: "claude",
                worktreePath: join(workspaceRoot, "checkpointed-claude"),
                status: "completed",
                result: {
                  provider: "claude",
                  candidateId: "claude-1",
                  status: "completed",
                  exitCode: 0,
                  stdout: "checkpointed claude stdout",
                  stderr: "",
                  summary: "checkpointed claude summary",
                  artifacts: [],
                  startedAt: checkpointStartedAt,
                  finishedAt: checkpointFinishedAt
                },
                gates: [
                  {
                    gate: "unit_test",
                    status: "pass",
                    summary: "checkpoint unit already passed",
                    evidence: []
                  }
                ]
              }
            ],
            gates: [],
            createdAt: checkpointStartedAt,
            updatedAt: checkpointFinishedAt
          },
          {
            id: "run-queued-checkpoint",
            taskId: "task-checkpoint",
            projectId: "project-checkpoint",
            status: "running",
            candidates: [
              {
                id: "claude-1",
                runId: "run-queued-checkpoint",
                provider: "claude",
                worktreePath: join(workspaceRoot, "queued-checkpoint-claude"),
                status: "completed",
                result: {
                  provider: "claude",
                  candidateId: "claude-1",
                  status: "completed",
                  exitCode: 0,
                  stdout: "queued checkpoint claude stdout",
                  stderr: "",
                  summary: "queued checkpoint claude summary",
                  artifacts: [],
                  startedAt: checkpointStartedAt,
                  finishedAt: checkpointFinishedAt
                },
                gates: [
                  {
                    gate: "unit_test",
                    status: "pass",
                    summary: "queued checkpoint unit already passed",
                    evidence: []
                  }
                ]
              },
              {
                id: "codex-2",
                runId: "run-queued-checkpoint",
                provider: "codex",
                worktreePath: queuedCodexWorkspace,
                status: "queued",
                gates: []
              }
            ],
            gates: [],
            createdAt: checkpointStartedAt,
            updatedAt: checkpointFinishedAt
          },
          {
            id: "run-unsafe",
            taskId: "task-checkpoint",
            projectId: "project-checkpoint",
            status: "running",
            candidates: [
              {
                id: "claude-1",
                runId: "run-unsafe",
                provider: "claude",
                worktreePath: join(workspaceRoot, "running-claude"),
                status: "running",
                gates: []
              }
            ],
            gates: [],
            createdAt: checkpointStartedAt,
            updatedAt: checkpointFinishedAt
          }
        ],
        runJobs: [
          {
            runId: "run-checkpoint",
            taskId: "task-checkpoint",
            projectId: "project-checkpoint",
            status: "running",
            attempt: 1,
            recovered: false,
            createdAt: checkpointStartedAt,
            updatedAt: checkpointFinishedAt,
            startedAt: checkpointStartedAt
          },
          {
            runId: "run-queued-checkpoint",
            taskId: "task-checkpoint",
            projectId: "project-checkpoint",
            status: "running",
            attempt: 1,
            recovered: false,
            createdAt: checkpointStartedAt,
            updatedAt: checkpointFinishedAt,
            startedAt: checkpointStartedAt
          },
          {
            runId: "run-unsafe",
            taskId: "task-checkpoint",
            projectId: "project-checkpoint",
            status: "running",
            attempt: 1,
            recovered: false,
            createdAt: checkpointStartedAt,
            updatedAt: checkpointFinishedAt,
            startedAt: checkpointStartedAt
          }
        ],
        events: []
      },
      null,
      2
    ),
    "utf8"
  );

  app = buildServer({
    apiStatePath: statePath,
    workspaceRoot,
    mniuRoot,
    useMockExecutors: true,
    autoResumeRuns: true
  });

  const completed = await waitForRunStatus(app, "run-checkpoint", "completed");
  assert.equal(completed.id, "run-checkpoint");
  assert.equal(completed.candidates.length, 2);
  assert.equal(completed.candidates[0]?.id, "claude-1");
  assert.equal(completed.candidates[0]?.result?.stdout, "checkpointed claude stdout");
  assert.equal(completed.candidates[1]?.id, "codex-2");
  assert.equal(completed.candidates[1]?.provider, "codex");
  assert.equal(
    completed.gates.some(
      (gate: { gate: string; status: string }) =>
        gate.gate === "unit_test" && gate.status === "pass"
    ),
    true
  );

  const checkpointEventsResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-checkpoint/events"
  });
  assert.equal(checkpointEventsResponse.statusCode, 200);
  const checkpointEvents = checkpointEventsResponse.json().events as Array<{
    message: string;
  }>;
  assert.equal(
    checkpointEvents.some((event) =>
      event.message.includes("Run resumed from checkpoint after API restart")
    ),
    true
  );
  assert.equal(
    checkpointEvents.some((event) =>
      event.message.includes("Skipping checkpointed candidate claude-1")
    ),
    true
  );
  assert.equal(
    checkpointEvents.some((event) => event.message.includes("mock claude completed")),
    false
  );

  const queuedCompleted = await waitForRunStatus(
    app,
    "run-queued-checkpoint",
    "completed"
  );
  assert.equal(queuedCompleted.id, "run-queued-checkpoint");
  assert.equal(queuedCompleted.candidates.length, 2);
  assert.equal(queuedCompleted.candidates[0]?.result?.stdout, "queued checkpoint claude stdout");
  assert.equal(queuedCompleted.candidates[1]?.id, "codex-2");
  assert.equal(queuedCompleted.candidates[1]?.status, "completed");

  const queuedEventsResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-queued-checkpoint/events"
  });
  assert.equal(queuedEventsResponse.statusCode, 200);
  const queuedEvents = queuedEventsResponse.json().events as Array<{
    message: string;
  }>;
  assert.equal(
    queuedEvents.some((event) =>
      event.message.includes("Resuming queued checkpointed candidate codex-2")
    ),
    true
  );
  assert.equal(
    queuedEvents.some((event) => event.message.includes("mock claude completed")),
    false
  );

  const unsafeResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-unsafe"
  });
  assert.equal(unsafeResponse.statusCode, 200);
  assert.equal(unsafeResponse.json().status, "failed");
  assert.equal(unsafeResponse.json().candidates[0]?.status, "failed");

  await waitForPersistedRunStatus(statePath, "run-checkpoint", "completed");
  await waitForPersistedRunStatus(statePath, "run-queued-checkpoint", "completed");
  await waitForPersistedRunStatus(statePath, "run-unsafe", "failed");
  await waitForPersistedRunJobStatus(statePath, "run-checkpoint", "completed");
  await waitForPersistedRunJobStatus(statePath, "run-queued-checkpoint", "completed");
  await waitForPersistedRunJobStatus(statePath, "run-unsafe", "failed");

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(
    persisted.runs.find((run: { id: string }) => run.id === "run-checkpoint").status,
    "completed"
  );
  assert.equal(
    persisted.runs.find((run: { id: string }) => run.id === "run-queued-checkpoint").status,
    "completed"
  );
  assert.equal(
    persisted.runs.find((run: { id: string }) => run.id === "run-unsafe").status,
    "failed"
  );
  assert.equal(
    persisted.runJobs.find((job: { runId: string }) => job.runId === "run-checkpoint").status,
    "completed"
  );
  assert.equal(
    persisted.runJobs.find((job: { runId: string }) => job.runId === "run-checkpoint").attempt,
    2
  );
  assert.equal(
    persisted.runJobs.find((job: { runId: string }) => job.runId === "run-queued-checkpoint").status,
    "completed"
  );
  assert.equal(
    persisted.runJobs.find((job: { runId: string }) => job.runId === "run-unsafe").status,
    "failed"
  );
  assert.equal(
    typeof persisted.runJobs.find((job: { runId: string }) => job.runId === "run-unsafe").interruptedAt,
    "string"
  );
});

test("api persists artifacts for recovered interrupted runs on startup", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-recovered-artifacts-"));
  const statePath = join(tempRoot, "api-state.json");
  const mniuRoot = join(tempRoot, "mniu");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        projects: [],
        tasks: [],
        runs: [
          {
            id: "run-recovered-artifacts",
            taskId: "task-1",
            projectId: "project-1",
            status: "running",
            candidates: [
              {
                id: "codex-1",
                runId: "run-recovered-artifacts",
                provider: "codex",
                worktreePath: "/tmp/worktree",
                status: "running",
                result: {
                  provider: "codex",
                  candidateId: "codex-1",
                  status: "completed",
                  exitCode: 0,
                  stdout: "partial recovered stdout",
                  stderr: "",
                  summary: "partial recovered summary",
                  artifacts: [],
                  startedAt: "2026-07-06T00:00:00.000Z",
                  finishedAt: "2026-07-06T00:00:01.000Z"
                },
                gates: []
              }
            ],
            gates: [],
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z"
          }
        ],
        events: []
      },
      null,
      2
    ),
    "utf8"
  );

  const app = buildServer({
    apiStatePath: statePath,
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const recoveredRun = await app.inject({
    method: "GET",
    url: "/v1/runs/run-recovered-artifacts"
  });
  assert.equal(recoveredRun.statusCode, 200);
  assert.equal(recoveredRun.json().status, "failed");

  const artifactIndex = await waitForArtifactIndex(mniuRoot, "run-recovered-artifacts");
  assert.equal(
    artifactIndex.artifacts.some(
      (artifact: { artifactId: string; bytes: number }) =>
        artifact.artifactId === "codex-1:stdout" && artifact.bytes > 0
    ),
    true
  );

  const artifactsResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-recovered-artifacts/artifacts"
  });
  assert.equal(artifactsResponse.statusCode, 200);
  assert.equal(
    artifactsResponse
      .json()
      .artifacts.some(
        (artifact: { id: string; persisted?: boolean }) =>
          artifact.id === "codex-1:stdout" && artifact.persisted === true
      ),
    true
  );

  const stdoutDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/run-recovered-artifacts/artifacts/${encodeURIComponent("codex-1:stdout")}`
  });
  assert.equal(stdoutDownload.statusCode, 200);
  assert.match(stdoutDownload.body, /partial recovered stdout/);
});

test("api recovers interrupted running candidate output checkpoints", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-output-checkpoint-"));
  const statePath = join(tempRoot, "api-state.json");
  const mniuRoot = join(tempRoot, "mniu");
  const checkpointDir = join(tempRoot, "checkpoints", "run-output", "codex-1");
  const stdoutPath = join(checkpointDir, "stdout.txt");
  const stderrPath = join(checkpointDir, "stderr.txt");
  let app: ReturnType<typeof buildServer> | undefined;
  t.after(async () => {
    await app?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(checkpointDir, { recursive: true });
  await writeFile(stdoutPath, "partial checkpoint stdout", "utf8");
  await writeFile(stderrPath, "partial checkpoint stderr", "utf8");
  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        projects: [],
        tasks: [],
        runs: [
          {
            id: "run-output-checkpoint",
            taskId: "task-output",
            projectId: "project-output",
            status: "running",
            candidates: [
              {
                id: "codex-1",
                runId: "run-output-checkpoint",
                provider: "codex",
                worktreePath: join(tempRoot, "worktree"),
                status: "running",
                outputCheckpoint: {
                  stdoutPath,
                  stderrPath,
                  startedAt: "2026-07-06T00:00:00.000Z"
                },
                gates: []
              }
            ],
            gates: [],
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:01.000Z"
          }
        ],
        events: []
      },
      null,
      2
    ),
    "utf8"
  );

  app = buildServer({
    apiStatePath: statePath,
    mniuRoot,
    useMockExecutors: true
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-output-checkpoint"
  });
  assert.equal(runResponse.statusCode, 200);
  const recoveredRun = runResponse.json();
  assert.equal(recoveredRun.status, "failed");
  assert.equal(recoveredRun.candidates[0]?.status, "failed");
  assert.equal(recoveredRun.candidates[0]?.result?.stdout, "partial checkpoint stdout");
  assert.equal(recoveredRun.candidates[0]?.result?.stderr, "partial checkpoint stderr");

  const artifactIndex = await waitForArtifactIndex(mniuRoot, "run-output-checkpoint");
  assert.ok(
    artifactIndex.artifacts.some(
      (artifact: { artifactId: string; bytes: number }) =>
        artifact.artifactId === "codex-1:stdout" && artifact.bytes > 0
    )
  );

  const stdoutDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/run-output-checkpoint/artifacts/${encodeURIComponent("codex-1:stdout")}`
  });
  assert.equal(stdoutDownload.statusCode, 200);
  assert.match(stdoutDownload.body, /partial checkpoint stdout/);
});

test("api summarizes and cleans artifact store with retention policy", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-artifact-store-cleanup-"));
  const runDir = join(mniuRoot, "artifacts", "runs", "run-old");
  t.after(async () => {
    await rm(mniuRoot, { recursive: true, force: true });
  });

  await mkdir(join(runDir, "files"), { recursive: true });
  await writeFile(join(runDir, "files", "stdout.txt"), "hello", "utf8");
  await writeFile(
    join(runDir, "index.json"),
    JSON.stringify(
      {
        version: 1,
        runId: "run-old",
        updatedAt: "2026-07-01T00:00:00.000Z",
        artifacts: [
          {
            artifactId: "codex-1:stdout",
            fileName: "stdout.txt",
            contentType: "text/plain",
            bytes: 5,
            sha256: "fake-sha",
            persistedAt: "2026-07-01T00:00:00.000Z",
            summary: {
              id: "codex-1:stdout",
              kind: "log",
              path: "mn://runs/run-old/candidates/codex-1/stdout.txt",
              contentType: "text/plain",
              bytes: 5,
              persisted: true
            }
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const app = buildServer({
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const summaryResponse = await app.inject({
    method: "GET",
    url: "/v1/artifacts/store"
  });
  assert.equal(summaryResponse.statusCode, 200);
  assert.equal(summaryResponse.json().totalRuns, 1);
  assert.equal(summaryResponse.json().totalBytes, 5);
  assert.equal(summaryResponse.json().runs[0].runId, "run-old");
  assert.equal("storeDir" in summaryResponse.json().runs[0], false);

  const quotaDryRunCleanup = await app.inject({
    method: "POST",
    url: "/v1/artifacts/store/cleanup",
    payload: {
      dryRun: true,
      keepLatestRuns: 0,
      maxBytes: 4
    }
  });
  assert.equal(quotaDryRunCleanup.statusCode, 200);
  assert.equal(quotaDryRunCleanup.json().candidateRuns, 1);
  assert.equal(quotaDryRunCleanup.json().policy.maxBytes, 4);
  assert.equal(quotaDryRunCleanup.json().deleted.length, 0);

  const dryRunCleanup = await app.inject({
    method: "POST",
    url: "/v1/artifacts/store/cleanup",
    payload: {
      dryRun: true,
      keepLatestRuns: 0
    }
  });
  assert.equal(dryRunCleanup.statusCode, 200);
  assert.equal(dryRunCleanup.json().candidateRuns, 1);
  assert.equal(dryRunCleanup.json().deleted.length, 0);
  await readFile(join(runDir, "index.json"), "utf8");

  const cleanup = await app.inject({
    method: "POST",
    url: "/v1/artifacts/store/cleanup",
    payload: {
      dryRun: false,
      keepLatestRuns: 0
    }
  });
  assert.equal(cleanup.statusCode, 200);
  assert.equal(cleanup.json().deleted.length, 1);
  assert.equal(cleanup.json().deleted[0].runId, "run-old");
  assert.equal(cleanup.json().audit.trigger, "manual");
  await assert.rejects(readFile(join(runDir, "index.json"), "utf8"));

  const cleanupPolicy = JSON.parse(
    await readFile(join(mniuRoot, "artifacts", "cleanup-policy.json"), "utf8")
  ) as { dryRun: boolean; policy: { keepLatestRuns?: number; scope?: string } };
  assert.equal(cleanupPolicy.dryRun, false);
  assert.equal(cleanupPolicy.policy.keepLatestRuns, 0);
  assert.equal(cleanupPolicy.policy.scope, "local");

  const cleanupAuditLines = (
    await readFile(join(mniuRoot, "artifacts", "cleanup-audit.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; deletedRuns: number; storeDir?: string });
  assert.equal(cleanupAuditLines.length, 3);
  assert.equal(cleanupAuditLines.at(-1)?.deletedRuns, 1);
  assert.equal(cleanupAuditLines.some((entry) => "storeDir" in entry), false);

  const afterCleanupSummary = await app.inject({
    method: "GET",
    url: "/v1/artifacts/store"
  });
  assert.equal(afterCleanupSummary.statusCode, 200);
  assert.equal(afterCleanupSummary.json().cleanup.totalRecords, 3);
  assert.equal(afterCleanupSummary.json().cleanup.latest.deletedRuns, 1);
  assert.equal(afterCleanupSummary.json().cleanup.policy.policy.keepLatestRuns, 0);
});

test("api mirrors persisted artifacts to filesystem remote store and falls back when local content is missing", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-artifact-remote-local-"));
  const remoteRoot = await mkdtemp(join(tmpdir(), "mn-api-artifact-remote-mirror-"));
  const store = new MemoryStore();
  const now = "2026-07-06T01:00:00.000Z";
  const runId = "run-remote-artifacts";
  t.after(async () => {
    await rm(mniuRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  });

  store.runs.set(runId, {
    id: runId,
    taskId: "task-remote-artifacts",
    projectId: "project-remote-artifacts",
    status: "completed",
    candidates: [
      {
        id: "codex-1",
        runId,
        provider: "codex",
        worktreePath: "/tmp/worktree",
        status: "completed",
        result: {
          provider: "codex",
          candidateId: "codex-1",
          status: "completed",
          exitCode: 0,
          stdout: "remote mirror payload",
          stderr: "",
          summary: "remote mirror summary",
          artifacts: [],
          startedAt: now,
          finishedAt: "2026-07-06T01:00:01.000Z"
        },
        gates: []
      }
    ],
    gates: [],
    createdAt: now,
    updatedAt: now
  });

  const app = buildServer({
    store,
    mniuRoot,
    useMockExecutors: true,
    artifactRemoteStore: { rootDir: remoteRoot }
  });
  t.after(async () => {
    await app.close();
  });

  const artifactsResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/artifacts`
  });
  assert.equal(artifactsResponse.statusCode, 200);
  const stdoutArtifact = artifactsResponse
    .json()
    .artifacts.find((artifact: { id: string }) => artifact.id === "codex-1:stdout") as
    | { remote?: { type: string; key: string; uri: string } }
    | undefined;
  assert.equal(stdoutArtifact?.remote?.type, "filesystem");
  assert.equal(typeof stdoutArtifact?.remote?.uri, "string");

  const artifactIndex = JSON.parse(
    await readFile(join(mniuRoot, "artifacts", "runs", runId, "index.json"), "utf8")
  ) as {
    artifacts: Array<{
      artifactId: string;
      fileName: string;
      remote?: { type: string; key: string; bytes: number; sha256: string };
    }>;
  };
  const stdoutEntry = artifactIndex.artifacts.find(
    (artifact) => artifact.artifactId === "codex-1:stdout"
  );
  assert.ok(stdoutEntry);
  assert.ok(stdoutEntry.remote);
  assert.equal(
    await readFile(join(remoteRoot, stdoutEntry.remote.key), "utf8"),
    "remote mirror payload"
  );

  const summaryResponse = await app.inject({
    method: "GET",
    url: "/v1/artifacts/store"
  });
  assert.equal(summaryResponse.statusCode, 200);
  assert.equal(summaryResponse.json().remote.type, "filesystem");
  assert.equal(summaryResponse.json().remote.rootDir, remoteRoot);
  assert.equal(summaryResponse.json().remote.totalRuns, 1);
  assert.equal(summaryResponse.json().remote.runs[0].runId, runId);

  const storedRun = store.runs.get(runId);
  assert.ok(storedRun);
  store.runs.set(runId, {
    ...storedRun,
    candidates: storedRun.candidates.map((candidate) =>
      candidate.id === "codex-1" && candidate.result
        ? { ...candidate, result: { ...candidate.result, stdout: "" } }
        : candidate
    )
  });
  await rm(
    join(mniuRoot, "artifacts", "runs", runId, "files", stdoutEntry.fileName),
    { force: true }
  );

  const downloadResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/artifacts/${encodeURIComponent("codex-1:stdout")}`
  });
  assert.equal(downloadResponse.statusCode, 200);
  assert.equal(downloadResponse.body, "remote mirror payload");

  const archiveDownload = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/artifacts/archive?kind=log`
  });
  assert.equal(archiveDownload.statusCode, 200);
  const archiveBuffer =
    (archiveDownload as unknown as { rawPayload?: Buffer }).rawPayload ??
    Buffer.from(archiveDownload.body, "binary");
  const archiveEntries = parseTarEntries(archiveBuffer);
  assert.equal(
    [...archiveEntries.values()].some((content) =>
      content.toString("utf8").includes("remote mirror payload")
    ),
    true
  );

  const remoteDryRunCleanup = await app.inject({
    method: "POST",
    url: "/v1/artifacts/store/cleanup",
    payload: { dryRun: true, keepLatestRuns: 0, scope: "remote" }
  });
  assert.equal(remoteDryRunCleanup.statusCode, 200);
  assert.equal(remoteDryRunCleanup.json().scope, "remote");
  assert.equal(remoteDryRunCleanup.json().candidateRuns, 1);
  assert.equal(remoteDryRunCleanup.json().candidates[0].scope, "remote");
  assert.equal(remoteDryRunCleanup.json().deleted.length, 0);
  await readFile(join(remoteRoot, "runs", runId, "index.json"), "utf8");

  const remoteCleanup = await app.inject({
    method: "POST",
    url: "/v1/artifacts/store/cleanup",
    payload: { dryRun: false, keepLatestRuns: 0, scope: "remote" }
  });
  assert.equal(remoteCleanup.statusCode, 200);
  assert.equal(remoteCleanup.json().deleted.length, 1);
  assert.equal(remoteCleanup.json().deleted[0].scope, "remote");
  assert.equal(remoteCleanup.json().remote.totalRuns, 1);
  assert.equal(remoteCleanup.json().audit.trigger, "manual");
  await assert.rejects(readFile(join(remoteRoot, "runs", runId, "index.json"), "utf8"));
  await readFile(join(mniuRoot, "artifacts", "runs", runId, "index.json"), "utf8");

  const afterRemoteCleanupSummary = await app.inject({
    method: "GET",
    url: "/v1/artifacts/store"
  });
  assert.equal(afterRemoteCleanupSummary.statusCode, 200);
  assert.equal(afterRemoteCleanupSummary.json().totalRuns, 1);
  assert.equal(afterRemoteCleanupSummary.json().remote.totalRuns, 0);
  assert.equal(afterRemoteCleanupSummary.json().cleanup.totalRecords, 2);
  assert.equal(afterRemoteCleanupSummary.json().cleanup.latest.scope, "remote");
  assert.equal(afterRemoteCleanupSummary.json().cleanup.latest.remote.deletedRuns, 1);
});

test("api mirrors artifacts to S3 and GCS compatible object store backends", async (t) => {
  const configs = [
    {
      type: "s3" as const,
      bucket: "mn-artifacts",
      prefix: "team/dev",
      scheme: "s3"
    },
    {
      type: "gcs" as const,
      bucket: "mn-gcs-artifacts",
      prefix: "release",
      scheme: "gs"
    }
  ];

  for (const config of configs) {
    const mniuRoot = await mkdtemp(join(tmpdir(), `mn-api-artifact-${config.type}-local-`));
    const remoteRoot = await mkdtemp(join(tmpdir(), `mn-api-artifact-${config.type}-remote-`));
    const store = new MemoryStore();
    const now = "2026-07-06T01:10:00.000Z";
    const runId = `run-${config.type}-remote-artifacts`;
    t.after(async () => {
      await rm(mniuRoot, { recursive: true, force: true });
      await rm(remoteRoot, { recursive: true, force: true });
    });

    store.runs.set(runId, {
      id: runId,
      taskId: `task-${config.type}-remote-artifacts`,
      projectId: `project-${config.type}-remote-artifacts`,
      status: "completed",
      candidates: [
        {
          id: "codex-1",
          runId,
          provider: "codex",
          worktreePath: "/tmp/worktree",
          status: "completed",
          result: {
            provider: "codex",
            candidateId: "codex-1",
            status: "completed",
            exitCode: 0,
            stdout: `${config.type} object payload`,
            stderr: "",
            summary: `${config.type} object summary`,
            artifacts: [],
            startedAt: now,
            finishedAt: "2026-07-06T01:10:01.000Z"
          },
          gates: []
        }
      ],
      gates: [],
      createdAt: now,
      updatedAt: now
    });

    const app = buildServer({
      store,
      mniuRoot,
      useMockExecutors: true,
      artifactRemoteStore: {
        type: config.type,
        rootDir: remoteRoot,
        bucket: config.bucket,
        prefix: config.prefix
      }
    });
    t.after(async () => {
      await app.close();
    });

    const artifactsResponse = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/artifacts`
    });
    assert.equal(artifactsResponse.statusCode, 200);
    const stdoutArtifact = artifactsResponse
      .json()
      .artifacts.find((artifact: { id: string }) => artifact.id === "codex-1:stdout") as
      | {
          remote?: {
            type: string;
            key: string;
            uri: string;
            bucket?: string;
            prefix?: string;
          };
        }
      | undefined;
    assert.equal(stdoutArtifact?.remote?.type, config.type);
    assert.equal(stdoutArtifact?.remote?.bucket, config.bucket);
    assert.equal(stdoutArtifact?.remote?.prefix, config.prefix);
    assert.match(
      stdoutArtifact?.remote?.key ?? "",
      new RegExp(`^${config.prefix}/runs/${runId}/files/`)
    );
    assert.equal(
      stdoutArtifact?.remote?.uri.startsWith(
        `${config.scheme}://${config.bucket}/${config.prefix}/runs/${runId}/files/`
      ),
      true
    );

    const artifactIndex = JSON.parse(
      await readFile(join(mniuRoot, "artifacts", "runs", runId, "index.json"), "utf8")
    ) as {
      artifacts: Array<{
        artifactId: string;
        fileName: string;
        remote?: { key: string; type: string; bucket?: string };
      }>;
    };
    const stdoutEntry = artifactIndex.artifacts.find(
      (artifact) => artifact.artifactId === "codex-1:stdout"
    );
    assert.ok(stdoutEntry?.remote);
    assert.equal(stdoutEntry.remote.type, config.type);
    assert.equal(
      await readFile(join(remoteRoot, config.bucket, stdoutEntry.remote.key), "utf8"),
      `${config.type} object payload`
    );

    const summaryResponse = await app.inject({
      method: "GET",
      url: "/v1/artifacts/store"
    });
    assert.equal(summaryResponse.statusCode, 200);
    assert.equal(summaryResponse.json().remote.type, config.type);
    assert.equal(summaryResponse.json().remote.bucket, config.bucket);
    assert.equal(summaryResponse.json().remote.prefix, config.prefix);
    assert.equal(
      summaryResponse.json().remote.uriPrefix,
      `${config.scheme}://${config.bucket}/${config.prefix}/`
    );
    assert.equal(summaryResponse.json().remote.totalRuns, 1);

    const storedRun = store.runs.get(runId);
    assert.ok(storedRun);
    store.runs.set(runId, {
      ...storedRun,
      candidates: storedRun.candidates.map((candidate) =>
        candidate.id === "codex-1" && candidate.result
          ? { ...candidate, result: { ...candidate.result, stdout: "" } }
          : candidate
      )
    });
    await rm(
      join(mniuRoot, "artifacts", "runs", runId, "files", stdoutEntry.fileName),
      { force: true }
    );

    const downloadResponse = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/artifacts/${encodeURIComponent("codex-1:stdout")}`
    });
    assert.equal(downloadResponse.statusCode, 200);
    assert.equal(downloadResponse.body, `${config.type} object payload`);

    const remoteCleanup = await app.inject({
      method: "POST",
      url: "/v1/artifacts/store/cleanup",
      payload: { dryRun: false, keepLatestRuns: 0, scope: "remote" }
    });
    assert.equal(remoteCleanup.statusCode, 200);
    assert.equal(remoteCleanup.json().remote.type, config.type);
    assert.equal(remoteCleanup.json().remote.bucket, config.bucket);
    assert.equal(remoteCleanup.json().deleted[0].scope, "remote");
    await assert.rejects(
      readFile(join(remoteRoot, config.bucket, config.prefix, "runs", runId, "index.json"), "utf8")
    );
    await readFile(join(mniuRoot, "artifacts", "runs", runId, "index.json"), "utf8");
  }
});

test("api auto-cleans artifact store when quota is configured", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-artifact-store-quota-"));
  const oldRunDir = join(mniuRoot, "artifacts", "runs", "run-old");
  t.after(async () => {
    await rm(mniuRoot, { recursive: true, force: true });
  });

  await mkdir(join(oldRunDir, "files"), { recursive: true });
  await writeFile(join(oldRunDir, "files", "stdout.txt"), "old artifact payload", "utf8");
  await writeFile(
    join(oldRunDir, "index.json"),
    JSON.stringify(
      {
        version: 1,
        runId: "run-old",
        updatedAt: "2026-07-01T00:00:00.000Z",
        artifacts: [
          {
            artifactId: "codex-1:stdout",
            fileName: "stdout.txt",
            contentType: "text/plain",
            bytes: 20,
            sha256: "fake-sha",
            persistedAt: "2026-07-01T00:00:00.000Z",
            summary: {
              id: "codex-1:stdout",
              kind: "log",
              path: "mn://runs/run-old/candidates/codex-1/stdout.txt",
              contentType: "text/plain",
              bytes: 20,
              persisted: true
            }
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const store = new MemoryStore();
  const now = "2026-07-06T00:00:00.000Z";
  store.runs.set("run-new", {
    id: "run-new",
    taskId: "task-new",
    projectId: "project-new",
    status: "completed",
    candidates: [
      {
        id: "codex-1",
        runId: "run-new",
        provider: "codex",
        worktreePath: "/tmp/worktree",
        status: "completed",
        result: {
          provider: "codex",
          candidateId: "codex-1",
          status: "completed",
          exitCode: 0,
          stdout: "new artifact payload",
          stderr: "",
          summary: "new run summary",
          artifacts: [],
          startedAt: now,
          finishedAt: "2026-07-06T00:00:01.000Z"
        },
        gates: []
      }
    ],
    gates: [],
    createdAt: now,
    updatedAt: now
  });

  const app = buildServer({
    store,
    mniuRoot,
    useMockExecutors: true,
    artifactStoreQuota: {
      maxBytes: 1,
      keepLatestRuns: 1
    }
  });
  t.after(async () => {
    await app.close();
  });

  const artifactsResponse = await app.inject({
    method: "GET",
    url: "/v1/runs/run-new/artifacts"
  });
  assert.equal(artifactsResponse.statusCode, 200);

  await assert.rejects(readFile(join(oldRunDir, "index.json"), "utf8"));
  await readFile(join(mniuRoot, "artifacts", "runs", "run-new", "index.json"), "utf8");

  const summaryResponse = await app.inject({
    method: "GET",
    url: "/v1/artifacts/store"
  });
  assert.equal(summaryResponse.statusCode, 200);
  assert.deepEqual(
    summaryResponse.json().runs.map((run: { runId: string }) => run.runId),
    ["run-new"]
  );
  assert.equal(summaryResponse.json().cleanup.totalRecords, 1);
  assert.equal(summaryResponse.json().cleanup.latest.trigger, "quota");
  assert.equal(summaryResponse.json().cleanup.latest.deletedRuns, 1);
  assert.equal("policy" in summaryResponse.json().cleanup, false);
});

test("api resumes a failed run by starting a replacement run", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-api-resume-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-api-resume-worktrees-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"console.log('resume unit ok')\""
    }
  });

  const store = new MemoryStore();
  const now = "2026-07-06T01:00:00.000Z";
  store.projects.set("project-resume", {
    id: "project-resume",
    name: "resume-project",
    rootPath: projectRoot,
    defaultBranch: "main",
    services: [],
    policyId: "default"
  });
  store.tasks.set("task-resume", {
    id: "task-resume",
    projectId: "project-resume",
    title: "resume failed run",
    intent: "implement",
    targetServices: [],
    prompt: "retry the task",
    acceptanceCriteria: ["mock completes"],
    strategy: {
      providers: ["codex"],
      candidates: 1,
      sandbox: "isolated-worktree",
      requiredGates: [],
      humanApproval: "never",
      timeoutSeconds: 60
    },
    createdAt: now
  });
  store.runs.set("run-failed", {
    id: "run-failed",
    taskId: "task-resume",
    projectId: "project-resume",
    status: "failed",
    candidates: [],
    gates: [],
    createdAt: now,
    updatedAt: now
  });

  const app = buildServer({
    store,
    workspaceRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const resumeResponse = await app.inject({
    method: "POST",
    url: "/v1/runs/run-failed/resume"
  });
  assert.equal(resumeResponse.statusCode, 201);
  const resumed = resumeResponse.json() as {
    resumedFromRunId: string;
    run: { id: string; status: string };
  };
  assert.equal(resumed.resumedFromRunId, "run-failed");
  assert.notEqual(resumed.run.id, "run-failed");
  assert.equal(resumed.run.status, "queued");

  const completed = await waitForRunStatus(app, resumed.run.id, "completed");
  assert.equal(completed.status, "completed");
  assert.ok(
    (store.events.get("run-failed") ?? []).some((event) =>
      event.message.includes(`Run resumed as ${resumed.run.id}`)
    )
  );
  assert.ok(
    (store.events.get(resumed.run.id) ?? []).some((event) =>
      event.message.includes("Run resumed from run-failed")
    )
  );
  const resumeAudit = [...store.auditEvents.values()].find(
    (event) => event.action === "run.resume"
  );
  assert.deepEqual(
    {
      resourceId: resumeAudit?.resourceId,
      projectId: resumeAudit?.projectId,
      result: resumeAudit?.result
    },
    {
      resourceId: "run-failed",
      projectId: "project-resume",
      result: "success"
    }
  );
  assert.match(resumeAudit?.beforeDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(resumeAudit?.afterDigest ?? "", /^[a-f0-9]{64}$/u);
});

test("api workspace cleanup removes git worktree metadata", async (t) => {
  try {
    await execFileAsync("git", ["--version"]);
  } catch {
    t.skip("git binary is not available");
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "mn-api-git-cleanup-"));
  const projectRoot = join(tempRoot, "project");
  const workspaceRoot = join(tempRoot, "worktrees");
  await mkdir(projectRoot, { recursive: true });
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writePackageJson(projectRoot, {
    scripts: {
      test: "node -e \"console.log('unit ok')\"",
      typecheck: "node -e \"console.log('typecheck ok')\""
    }
  });
  await writeFile(join(projectRoot, "index.js"), "export const ok = true;\n", "utf8");
  await git(projectRoot, ["init"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, [
    "-c",
    "user.email=mn@example.invalid",
    "-c",
    "user.name=mn test",
    "commit",
    "-m",
    "init"
  ]);

  const app = buildServer({
    workspaceRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "git-cleanup",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();
  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "Git cleanup",
      intent: "implement",
      targetServices: [],
      prompt: "no changes",
      acceptanceCriteria: ["passes"],
      strategy: {
        providers: ["codex"],
        candidates: 1,
        sandbox: "isolated-worktree",
        requiredGates: ["unit_test", "typecheck", "llm_verifier"],
        humanApproval: "never",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);

  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${taskResponse.json().id}/runs`,
    payload: { wait: true }
  });
  assert.equal(runResponse.statusCode, 201);
  const run = runResponse.json();
  assert.equal(run.status, "completed");
  const candidateWorkspace = run.candidates[0]?.worktreePath;
  assert.equal(typeof candidateWorkspace, "string");
  await lstat(candidateWorkspace);
  assert.match((await git(projectRoot, ["worktree", "list", "--porcelain"])).stdout, new RegExp(escapeRegExp(candidateWorkspace)));
  assert.match(
    (await git(projectRoot, ["branch", "--list", `mn/${run.id}/codex-1`])).stdout,
    new RegExp(escapeRegExp(`mn/${run.id}/codex-1`))
  );

  const cleanupResponse = await app.inject({
    method: "POST",
    url: `/v1/runs/${run.id}/workspaces/cleanup`,
    payload: {}
  });
  assert.equal(cleanupResponse.statusCode, 200);
  assert.equal(cleanupResponse.json().results[0].status, "deleted");
  assert.equal(cleanupResponse.json().results[0].cleanupMethod, "git_worktree_remove");
  await assert.rejects(lstat(candidateWorkspace));
  assert.doesNotMatch(
    (await git(projectRoot, ["worktree", "list", "--porcelain"])).stdout,
    new RegExp(escapeRegExp(candidateWorkspace))
  );
  assert.equal(
    (await git(projectRoot, ["branch", "--list", `mn/${run.id}/codex-1`])).stdout.trim(),
    ""
  );
});

test("api rejects tasks that violate policy", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-api-policy-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-api-policy-worktrees-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const app = buildServer({
    workspaceRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "demo",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();

  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "cross service without approval",
      prompt: "change two services",
      targetServices: ["api", "worker"],
      strategy: {
        humanApproval: "never"
      }
    }
  });

  assert.equal(taskResponse.statusCode, 400);
  assert.match(taskResponse.body, /Cross-service tasks require human approval/);
});

test("api exposes desktop status for Claude Code and Codex", async (t) => {
  const app = buildServer({ useMockExecutors: true });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/system/desktop"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.api.service, "mn-api");
  assert.equal(body.api.executorMode, "mock");
  assert.deepEqual(
    body.apps.map((app: { id: string }) => app.id),
    ["claude", "codex"]
  );
  assert.equal(body.proxy.status, "stopped");
});

test("api indexes local Codex sessions from a temporary HOME", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-session-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  const sessionPath = join(homeDir, ".codex", "sessions", "codex.jsonl");
  await mkdir(join(homeDir, ".codex", "sessions"), { recursive: true });
  await writeFile(
    sessionPath,
    [
      JSON.stringify({
        timestamp: "2026-07-05T03:00:00.000Z",
        type: "turn_context",
        payload: { cwd: "/Users/alice/api" }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T03:00:01.000Z",
        type: "user_message",
        message: {
          role: "user",
          content: [{ type: "input_text", text: "Summarize this run" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-05T03:00:02.000Z",
        type: "assistant_message",
        message: {
          role: "assistant",
          model: "gpt-5",
          content: [{ type: "output_text", text: "Run is green with Bearer abc.def.ghi" }],
          usage: {
            input_tokens: 9,
            output_tokens: 3,
            total_tokens: 12
          }
        }
      })
    ].join("\n")
  );

  const app = buildServer({
    homeDir,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const listResponse = await app.inject({
    method: "GET",
    url: "/v1/sessions?app=codex&limit=10"
  });
  assert.equal(listResponse.statusCode, 200);
  const sessions = listResponse.json().sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Summarize this run");
  assert.equal(sessions[0].cwd, "/Users/alice/api");
  assert.equal(sessions[0].model, "gpt-5");
  assert.equal(sessions[0].totalTokens, 12);

  const searchResponse = await app.inject({
    method: "GET",
    url: "/v1/sessions?app=codex&query=green&limit=1&offset=0"
  });
  assert.equal(searchResponse.statusCode, 200);
  const searchBody = searchResponse.json();
  assert.equal(searchBody.sessions.length, 1);
  assert.equal(searchBody.sessions[0].title, "Summarize this run");
  assert.deepEqual(searchBody.pagination, {
    limit: 1,
    offset: 0,
    hasMore: false
  });

  const missingSearchResponse = await app.inject({
    method: "GET",
    url: "/v1/sessions?app=codex&query=not-present&limit=1"
  });
  assert.equal(missingSearchResponse.statusCode, 200);
  assert.equal(missingSearchResponse.json().sessions.length, 0);

  const detailResponse = await app.inject({
    method: "GET",
    url: `/v1/sessions/${encodeURIComponent(sessions[0].id)}?app=codex`
  });
  assert.equal(detailResponse.statusCode, 200);
  const detail = detailResponse.json().session;
  assert.equal(detail.messageCount, 2);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].text, "Summarize this run");
  assert.equal(detail.messages[1].usage.inputTokens, 9);

  const redactedDetailResponse = await app.inject({
    method: "GET",
    url: `/v1/sessions/${encodeURIComponent(sessions[0].id)}?app=codex&redact=true`
  });
  assert.equal(redactedDetailResponse.statusCode, 200);
  const redactedDetail = redactedDetailResponse.json().session;
  assert.equal(redactedDetail.cwd, "/Users/<user>/api");
  assert.equal(redactedDetail.messages[1].text, "Run is green with Bearer ****");

  const defaultExportResponse = await app.inject({
    method: "GET",
    url: `/v1/sessions/${encodeURIComponent(sessions[0].id)}/export?app=codex`
  });
  assert.equal(defaultExportResponse.statusCode, 200);
  const defaultExport = defaultExportResponse.json();
  assert.equal(defaultExport.kind, "mniu.session.export");
  assert.equal(defaultExport.redacted, true);
  assert.equal(defaultExport.session.cwd, "/Users/<user>/api");
  assert.equal(defaultExport.session.messages[1].text, "Run is green with Bearer ****");

  const rawExportResponse = await app.inject({
    method: "GET",
    url: `/v1/sessions/${encodeURIComponent(sessions[0].id)}/export?app=codex&redact=false`
  });
  assert.equal(rawExportResponse.statusCode, 200);
  const rawExport = rawExportResponse.json();
  assert.equal(rawExport.redacted, false);
  assert.equal(rawExport.session.cwd, "/Users/alice/api");
  assert.equal(rawExport.session.messages[1].text, "Run is green with Bearer abc.def.ghi");
});

test("api manages provider lifecycle and projects Codex without overwriting auth", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-provider-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-provider-store-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  await writeFile(join(homeDir, ".codex", "auth.json"), "{\"token\":\"official\"}\n");
  const originalConfig = "# user config\nmodel = \"gpt-5\"\n";
  await writeFile(join(homeDir, ".codex", "config.toml"), originalConfig);

  const app = buildServer({
    homeDir,
    mniuRoot,
    localStore: new FileLocalStore({ rootDir: mniuRoot }),
    secretVault: new LocalSecretVault(mniuRoot),
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      presetId: "deepseek",
      apiKey: "sk-deepseek-secret"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();
  assert.equal(provider.apiKeyRef.maskedValue, "sk-d...cret");

  const enableResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/enable`,
    payload: {
      homeDir
    }
  });
  assert.equal(enableResponse.statusCode, 200);
  const enableBody = enableResponse.json();
  assert.equal(enableBody.provider.enabled, true);
  assert.match(enableBody.projection.projectedConfig, /experimental_bearer_token = "\*\*\*\*"/);
  assert.equal(enableBody.projection.filePreviews.length, 1);
  assert.equal(enableBody.projection.filePreviews[0].before, originalConfig);
  assert.match(enableBody.projection.filePreviews[0].after, /experimental_bearer_token = "\*\*\*\*"/);
  assert.equal(JSON.stringify(enableBody.projection.filePreviews).includes("sk-deepseek-secret"), false);

  const config = await readFile(join(homeDir, ".codex", "config.toml"), "utf8");
  const auth = await readFile(join(homeDir, ".codex", "auth.json"), "utf8");
  assert.match(config, /model_provider = /);
  assert.match(config, /base_url = "https:\/\/api.deepseek.com\/v1"/);
  assert.equal(auth, "{\"token\":\"official\"}\n");

  const repeatEnableResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/enable`,
    payload: {
      homeDir,
      dryRun: false
    }
  });
  assert.equal(repeatEnableResponse.statusCode, 200);
  assert.equal(repeatEnableResponse.json().projection.changed, false);

  const restorePreviewResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/restore`,
    payload: { dryRun: true }
  });
  assert.equal(restorePreviewResponse.statusCode, 200);
  assert.equal(restorePreviewResponse.json().restore.restored, true);
  assert.notEqual(
    await readFile(join(homeDir, ".codex", "config.toml"), "utf8"),
    originalConfig
  );

  const restoreResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/restore`,
    payload: { dryRun: false }
  });
  assert.equal(restoreResponse.statusCode, 200);
  assert.equal(restoreResponse.json().provider.enabled, false);
  assert.equal(restoreResponse.json().restore.conflict, false);
  assert.equal(
    await readFile(join(homeDir, ".codex", "config.toml"), "utf8"),
    originalConfig
  );
  const auditRows = (await readFile(
    join(mniuRoot, "logs", "live-config-audit.jsonl"),
    "utf8"
  ))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    auditRows.map((row) => row.action),
    ["provider.enable", "provider.restore"]
  );
  assert.equal(JSON.stringify(auditRows).includes("sk-deepseek-secret"), false);

  const reenableResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/enable`,
    payload: { homeDir }
  });
  assert.equal(reenableResponse.statusCode, 200);
  const editedConfig = `${await readFile(join(homeDir, ".codex", "config.toml"), "utf8")}# user edit\n`;
  await writeFile(join(homeDir, ".codex", "config.toml"), editedConfig);
  const conflictResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/restore`,
    payload: { dryRun: false }
  });
  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(conflictResponse.json().restore.reason, "live_config_changed");
  assert.equal(
    await readFile(join(homeDir, ".codex", "config.toml"), "utf8"),
    editedConfig
  );

  const listResponse = await app.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().providers.length, 1);

  const duplicateResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/duplicate`,
    payload: {
      name: "DeepSeek Copy"
    }
  });
  assert.equal(duplicateResponse.statusCode, 201);
  const duplicate = duplicateResponse.json();
  assert.notEqual(duplicate.id, provider.id);
  assert.equal(duplicate.name, "DeepSeek Copy");
  assert.equal(duplicate.enabled, false);
  assert.equal(duplicate.apiKeyRef.maskedValue, "sk-d...cret");

  const duplicateListResponse = await app.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  });
  assert.equal(duplicateListResponse.statusCode, 200);
  assert.equal(duplicateListResponse.json().providers.length, 2);
});

test("api restores Codex config and auth as one provider projection", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-codex-auth-restore-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-codex-auth-restore-store-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const authPath = join(codexDir, "auth.json");
  const originalConfig = "model_provider = \"openai\"\nmodel = \"gpt-5\"\n";
  const originalAuth =
    '{"tokens":{"access_token":"official-access","refresh_token":"official-refresh"},"auth":"official-auth"}\n';
  await mkdir(codexDir, { recursive: true });
  await writeFile(configPath, originalConfig);
  await writeFile(authPath, originalAuth);
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const app = buildServer({ homeDir, mniuRoot, useMockExecutors: true });
  t.after(async () => app.close());
  const create = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Auth File Provider",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: "https://example.com/v1",
      defaultModel: "example-model",
      apiKey: "sk-auth-file-test"
    }
  });
  assert.equal(create.statusCode, 201);
  const provider = create.json();

  const enable = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/enable`,
    payload: { homeDir, mode: "api_key_auth_file", dryRun: false }
  });
  assert.equal(enable.statusCode, 200);
  assert.equal(enable.json().projection.files.length, 2);
  assert.equal(enable.json().projection.filePreviews.length, 2);
  const enablePreviews = JSON.stringify(enable.json().projection.filePreviews);
  assert.equal(enablePreviews.includes("sk-auth-file-test"), false);
  assert.equal(enablePreviews.includes("official-access"), false);
  assert.equal(enablePreviews.includes("official-refresh"), false);
  assert.equal(enablePreviews.includes("official-auth"), false);
  assert.match(enablePreviews, /access_token/);
  assert.match(enablePreviews, /\*\*\*\*/);
  const authPreview = enable
    .json()
    .projection.filePreviews.find((preview: { targetPath: string }) =>
      preview.targetPath.endsWith("auth.json")
    );
  assert.ok(authPreview);
  assert.equal(authPreview.before.includes("official-access"), false);
  assert.equal(authPreview.before.includes("official-refresh"), false);
  assert.equal(authPreview.before.includes("official-auth"), false);
  assert.equal(authPreview.after.includes("sk-auth-file-test"), false);
  assert.match(authPreview.before, /\*\*\*\*/);
  assert.match(authPreview.after, /\*\*\*\*/);
  assert.match(await readFile(authPath, "utf8"), /sk-auth-file-test/);

  const restore = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/restore`,
    payload: { dryRun: false }
  });
  assert.equal(restore.statusCode, 200);
  assert.equal(restore.json().files.length, 2);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.equal(await readFile(authPath, "utf8"), originalAuth);

  await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/enable`,
    payload: { homeDir, mode: "api_key_auth_file", dryRun: false }
  });
  const editedAuth = '{"OPENAI_API_KEY":"user-edited"}\n';
  await writeFile(authPath, editedAuth);
  const conflict = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/restore`,
    payload: { dryRun: false }
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().files.some((file: { conflict: boolean }) => file.conflict), true);
  assert.equal(await readFile(authPath, "utf8"), editedAuth);
  assert.notEqual(await readFile(configPath, "utf8"), originalConfig);
});

test("api redacts malformed existing Codex auth in provider previews", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-malformed-auth-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-malformed-auth-store-"));
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "config.toml"), 'model = "gpt-5"\n');
  await writeFile(join(codexDir, "auth.json"), "'access_token': 'malformed-auth-old-secret'");
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const app = buildServer({ homeDir, mniuRoot, useMockExecutors: true });
  t.after(async () => app.close());
  const create = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Malformed Auth Provider",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: "https://example.com/v1",
      defaultModel: "example-model",
      apiKey: "malformed-auth-new-secret"
    }
  });
  assert.equal(create.statusCode, 201);

  const enable = await app.inject({
    method: "POST",
    url: `/v1/providers/${create.json().id}/enable`,
    payload: { homeDir, mode: "api_key_auth_file", dryRun: false }
  });
  assert.equal(enable.statusCode, 200);
  const previews = JSON.stringify(enable.json().projection.filePreviews);
  assert.equal(previews.includes("malformed-auth-old-secret"), false);
  assert.equal(previews.includes("malformed-auth-new-secret"), false);
  assert.match(previews, /REDACTED INVALID CONFIG/);
});

test("api keeps unified provider activation independent for Claude and Codex", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-unified-provider-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-unified-provider-store-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });
  const app = buildServer({
    homeDir,
    mniuRoot,
    localStore: new FileLocalStore({ rootDir: mniuRoot }),
    secretVault: new LocalSecretVault(mniuRoot),
    useMockExecutors: true
  });
  t.after(async () => app.close());

  const unifiedResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "unified",
      name: "Unified Relay",
      kind: "relay",
      apiFormat: "openai_chat",
      baseUrl: "https://relay.example.test/v1",
      defaultModel: "relay-model"
    }
  });
  const codexResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Codex Direct",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: "https://codex.example.test/v1",
      defaultModel: "codex-model"
    }
  });
  const unified = unifiedResponse.json();
  const codex = codexResponse.json();

  assert.equal((await app.inject({
    method: "POST",
    url: `/v1/providers/${unified.id}/enable`,
    payload: { app: "claude", homeDir }
  })).statusCode, 200);
  const codexBefore = (await app.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  })).json().providers;
  assert.equal(codexBefore.find((provider: { id: string }) => provider.id === unified.id).enabled, false);

  assert.equal((await app.inject({
    method: "POST",
    url: `/v1/providers/${codex.id}/enable`,
    payload: { app: "codex", homeDir }
  })).statusCode, 200);
  const claudeAfter = (await app.inject({
    method: "GET",
    url: "/v1/providers?app=claude"
  })).json().providers;
  const codexAfter = (await app.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  })).json().providers;
  assert.equal(claudeAfter.find((provider: { id: string }) => provider.id === unified.id).enabled, true);
  assert.equal(codexAfter.find((provider: { id: string }) => provider.id === unified.id).enabled, false);
  assert.equal(codexAfter.find((provider: { id: string }) => provider.id === codex.id).enabled, true);
});

test("api exports providers safely and imports them with dry-run confirmation", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "mn-api-provider-export-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "mn-api-provider-export-target-"));
  t.after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  const sourceApp = buildServer({
    mniuRoot: sourceRoot,
    localStore: new FileLocalStore({ rootDir: sourceRoot }),
    secretVault: new LocalSecretVault(sourceRoot),
    useMockExecutors: true
  });
  const targetApp = buildServer({
    mniuRoot: targetRoot,
    localStore: new FileLocalStore({ rootDir: targetRoot }),
    secretVault: new LocalSecretVault(targetRoot),
    useMockExecutors: true
  });
  t.after(async () => {
    await sourceApp.close();
    await targetApp.close();
  });

  const envProviderResponse = await sourceApp.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Env Provider",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: "https://env.example.test/v1",
      defaultModel: "env-model",
      wireApi: "chat",
      apiKeyEnv: "ENV_PROVIDER_KEY",
      modelCatalog: [
        {
          id: "env-model",
          displayName: "Env Model",
          inputTokenUsdPerMillion: 1.5
        }
      ]
    }
  });
  assert.equal(envProviderResponse.statusCode, 201);

  const encryptedProviderResponse = await sourceApp.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Encrypted Provider",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: "https://encrypted.example.test/v1",
      defaultModel: "encrypted-model",
      apiKey: "sk-export-secret"
    }
  });
  assert.equal(encryptedProviderResponse.statusCode, 201);
  const encryptedProvider = encryptedProviderResponse.json();

  const exportResponse = await sourceApp.inject({
    method: "GET",
    url: "/v1/providers/export?app=codex"
  });
  assert.equal(exportResponse.statusCode, 200);
  const exported = exportResponse.json();
  assert.equal(exported.version, 1);
  assert.equal(exported.secretPolicy, "env_refs_only");
  assert.equal(exported.providers.length, 2);
  const envExport = exported.providers.find(
    (provider: { name: string }) => provider.name === "Env Provider"
  );
  assert.equal(envExport.apiKeyEnv, "ENV_PROVIDER_KEY");
  const encryptedExport = exported.providers.find(
    (provider: { name: string }) => provider.name === "Encrypted Provider"
  );
  assert.equal(encryptedExport.secretOmitted, true);
  assert.equal(encryptedExport.apiKeyEnv, undefined);
  assert.equal(JSON.stringify(exported).includes(encryptedProvider.apiKeyRef.ref), false);
  assert.equal(JSON.stringify(exported).includes("sk-export-secret"), false);

  const dryRunResponse = await targetApp.inject({
    method: "POST",
    url: "/v1/providers/import",
    payload: {
      ...exported,
      dryRun: true
    }
  });
  assert.equal(dryRunResponse.statusCode, 200);
  assert.equal(dryRunResponse.json().wouldImportCount, 2);
  assert.equal(dryRunResponse.json().importedCount, 0);

  const emptyListResponse = await targetApp.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  });
  assert.equal(emptyListResponse.statusCode, 200);
  assert.equal(emptyListResponse.json().providers.length, 0);

  const importResponse = await targetApp.inject({
    method: "POST",
    url: "/v1/providers/import",
    payload: {
      ...exported,
      dryRun: false
    }
  });
  assert.equal(importResponse.statusCode, 200);
  assert.equal(importResponse.json().importedCount, 2);
  assert.equal(importResponse.json().skippedCount, 0);

  const importedListResponse = await targetApp.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  });
  assert.equal(importedListResponse.statusCode, 200);
  const importedProviders = importedListResponse.json().providers;
  assert.equal(importedProviders.length, 2);
  assert.equal(importedProviders.every((provider: { enabled: boolean }) => !provider.enabled), true);
  const importedEnvProvider = importedProviders.find(
    (provider: { name: string }) => provider.name === "Env Provider"
  );
  assert.equal(importedEnvProvider.apiKeyRef.type, "env");
  assert.equal(importedEnvProvider.apiKeyRef.ref, "ENV_PROVIDER_KEY");
  assert.equal(importedEnvProvider.modelCatalog[0].inputTokenUsdPerMillion, 1.5);

  const duplicateImportResponse = await targetApp.inject({
    method: "POST",
    url: "/v1/providers/import",
    payload: {
      ...exported,
      dryRun: false
    }
  });
  assert.equal(duplicateImportResponse.statusCode, 200);
  assert.equal(duplicateImportResponse.json().importedCount, 0);
  assert.equal(duplicateImportResponse.json().skippedCount, 2);
});

test("api previews and imports provider deep links safely", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-deep-link-provider-"));
  t.after(async () => {
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const app = buildServer({
    mniuRoot,
    localStore: new FileLocalStore({ rootDir: mniuRoot }),
    secretVault: new LocalSecretVault(mniuRoot),
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const payload = {
    version: 1,
    providers: [
      {
        app: "codex",
        name: "Deep Link Provider",
        kind: "openai_compatible",
        apiFormat: "openai_chat",
        baseUrl: "https://deep-link.example.test/v1",
        defaultModel: "deep-link-model",
        wireApi: "chat",
        apiKeyEnv: "DEEP_LINK_PROVIDER_KEY"
      }
    ]
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64url");
  const url = `mniu://import/provider?payload=${encoded}`;

  const previewResponse = await app.inject({
    method: "POST",
    url: "/v1/deep-links/preview",
    payload: { url }
  });
  assert.equal(previewResponse.statusCode, 200);
  assert.equal(previewResponse.json().scheme, "mniu");
  assert.equal(previewResponse.json().action, "import");
  assert.equal(previewResponse.json().kind, "providers");
  assert.equal(previewResponse.json().trusted, false);
  assert.equal(previewResponse.json().requiresConfirmation, true);
  assert.equal(previewResponse.json().dryRun, true);
  assert.equal(previewResponse.json().result.wouldImportCount, 1);
  const previewAudit = JSON.parse(
    await readFile(join(mniuRoot, "deeplink-imports", "last-preview.json"), "utf8")
  );
  assert.equal(previewAudit.kind, "providers");
  assert.equal(previewAudit.wouldImportCount, 1);
  assert.equal(typeof previewAudit.previewedAt, "string");
  assert.equal(JSON.stringify(previewAudit).includes(encoded), false);

  const emptyListResponse = await app.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  });
  assert.equal(emptyListResponse.statusCode, 200);
  assert.equal(emptyListResponse.json().providers.length, 0);

  const importResponse = await app.inject({
    method: "POST",
    url: "/v1/deep-links/import",
    payload: { url, dryRun: false }
  });
  assert.equal(importResponse.statusCode, 200);
  assert.equal(importResponse.json().dryRun, false);
  assert.equal(importResponse.json().result.importedCount, 1);

  const importedListResponse = await app.inject({
    method: "GET",
    url: "/v1/providers?app=codex"
  });
  assert.equal(importedListResponse.statusCode, 200);
  const importedProviders = importedListResponse.json().providers;
  assert.equal(importedProviders.length, 1);
  assert.equal(importedProviders[0].name, "Deep Link Provider");
  assert.equal(importedProviders[0].enabled, false);
  assert.equal(importedProviders[0].apiKeyRef.type, "env");
  assert.equal(importedProviders[0].apiKeyRef.ref, "DEEP_LINK_PROVIDER_KEY");

  const duplicateResponse = await app.inject({
    method: "POST",
    url: "/v1/deep-links/import",
    payload: { url, dryRun: false }
  });
  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(duplicateResponse.json().result.importedCount, 0);
  assert.equal(duplicateResponse.json().result.skippedCount, 1);

  const invalidResponse = await app.inject({
    method: "POST",
    url: "/v1/deep-links/preview",
    payload: { url: `https://example.test/import/provider?payload=${encoded}` }
  });
  assert.equal(invalidResponse.statusCode, 400);
});

test("api previews and imports MCP and prompt deep links safely", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-deep-link-extensions-"));
  t.after(async () => {
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const app = buildServer({
    mniuRoot,
    localStore: new FileLocalStore({ rootDir: mniuRoot }),
    secretVault: new LocalSecretVault(mniuRoot),
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const mcpUrl = `mniu://import/mcp?payload=${Buffer.from(
    JSON.stringify({
      server: {
        name: "Deep Link MCP",
        command: "node",
        args: ["--version"],
        env: { TOKEN: "deep-link-secret" },
        apps: ["claude"],
        enabled: true
      }
    }),
    "utf8"
  ).toString("base64url")}`;

  const mcpPreview = await app.inject({
    method: "POST",
    url: "/v1/deep-links/preview",
    payload: { url: mcpUrl }
  });
  assert.equal(mcpPreview.statusCode, 200);
  assert.equal(mcpPreview.json().kind, "mcp_servers");
  assert.equal(mcpPreview.json().result.wouldImportCount, 1);

  const emptyMcpList = await app.inject({
    method: "GET",
    url: "/v1/mcp/servers?app=claude"
  });
  assert.equal(emptyMcpList.statusCode, 200);
  assert.equal(emptyMcpList.json().servers.length, 0);

  const mcpImport = await app.inject({
    method: "POST",
    url: "/v1/deep-links/import",
    payload: { url: mcpUrl, dryRun: false }
  });
  assert.equal(mcpImport.statusCode, 200);
  assert.equal(mcpImport.json().result.importedCount, 1);

  const mcpList = await app.inject({
    method: "GET",
    url: "/v1/mcp/servers?app=claude"
  });
  assert.equal(mcpList.statusCode, 200);
  assert.equal(mcpList.json().servers.length, 1);
  assert.equal(mcpList.json().servers[0].name, "Deep Link MCP");
  assert.equal(mcpList.json().servers[0].command, "node");

  const duplicateMcpImport = await app.inject({
    method: "POST",
    url: "/v1/deep-links/import",
    payload: { url: mcpUrl, dryRun: false }
  });
  assert.equal(duplicateMcpImport.statusCode, 200);
  assert.equal(duplicateMcpImport.json().result.skippedCount, 1);

  const promptUrl = `mniu://import/prompt?payload=${Buffer.from(
    JSON.stringify({
      prompt: {
        name: "Deep Link Prompt",
        content: "# Deep Link Prompt\n\nImported safely.",
        apps: ["codex"]
      }
    }),
    "utf8"
  ).toString("base64url")}`;

  const promptPreview = await app.inject({
    method: "POST",
    url: "/v1/deep-links/preview",
    payload: { url: promptUrl }
  });
  assert.equal(promptPreview.statusCode, 200);
  assert.equal(promptPreview.json().kind, "prompts");
  assert.equal(promptPreview.json().result.wouldImportCount, 1);

  const promptImport = await app.inject({
    method: "POST",
    url: "/v1/deep-links/import",
    payload: { url: promptUrl, dryRun: false }
  });
  assert.equal(promptImport.statusCode, 200);
  assert.equal(promptImport.json().result.importedCount, 1);

  const promptList = await app.inject({
    method: "GET",
    url: "/v1/prompts/presets?app=codex"
  });
  assert.equal(promptList.statusCode, 200);
  assert.equal(promptList.json().prompts.length, 1);
  assert.equal(promptList.json().prompts[0].name, "Deep Link Prompt");
  assert.equal(promptList.json().prompts[0].content.includes("Imported safely."), true);

  const duplicatePromptImport = await app.inject({
    method: "POST",
    url: "/v1/deep-links/import",
    payload: { url: promptUrl, dryRun: false }
  });
  assert.equal(duplicatePromptImport.statusCode, 200);
  assert.equal(duplicatePromptImport.json().result.skippedCount, 1);
});

test("api resolves provider API key from keychain secret vault", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-keychain-provider-"));
  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const saved = new Map<string, string>();
  const optionValue = (args: string[], option: string): string => {
    const value = args[args.indexOf(option) + 1];
    assert.ok(value);
    return value;
  };
  const secretVault = new LocalSecretVault(mniuRoot, {
    backend: "keychain",
    keychain: {
      service: "dev.muniu.api-test",
      accountPrefix: "api:",
      runSecurity: async (args) => {
        const account = optionValue(args, "-a");
        if (args[0] === "add-generic-password") {
          saved.set(account, optionValue(args, "-w"));
          return "";
        }
        if (args[0] === "find-generic-password") {
          const value = saved.get(account);
          if (!value) throw Object.assign(new Error("The specified item could not be found."), { code: 44 });
          return `${value}\n`;
        }
        if (args[0] === "delete-generic-password") {
          saved.delete(account);
          return "";
        }
        throw new Error(`unexpected security command: ${args.join(" ")}`);
      }
    }
  });

  let seenAuthorization = "";
  const upstream = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    seenAuthorization = Array.isArray(authorization)
      ? authorization.join(",")
      : authorization ?? "";
    await readIncomingRequestBody(request);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });

  t.after(async () => {
    upstream.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address() as AddressInfo | null;
  assert.ok(address);

  const app = buildServer({
    mniuRoot,
    localStore,
    secretVault,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Keychain Provider",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      defaultModel: "probe-model",
      apiKey: "sk-keychain-provider-secret"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();
  assert.equal(provider.apiKeyRef.type, "keychain");
  assert.match(provider.apiKeyRef.ref, /^keychain:/);

  const probeResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/test-endpoint`,
    payload: { timeoutMs: 1000 }
  });
  assert.equal(probeResponse.statusCode, 200);
  assert.equal(probeResponse.json().ok, true);
  assert.equal(seenAuthorization, "Bearer sk-keychain-provider-secret");

  const deleteResponse = await app.inject({
    method: "DELETE",
    url: `/v1/providers/${provider.id}`
  });
  assert.equal(deleteResponse.statusCode, 204);
  assert.equal(saved.size, 0);
});

test("api provider endpoint test performs a live HTTP probe", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-provider-probe-"));
  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  let seenUrl = "";
  let seenAuthorization = "";
  let seenBody: Record<string, unknown> = {};
  const upstream = createServer(async (request, response) => {
    seenUrl = request.url ?? "";
    const authorization = request.headers.authorization;
    seenAuthorization = Array.isArray(authorization)
      ? authorization.join(",")
      : authorization ?? "";
    seenBody = JSON.parse((await readIncomingRequestBody(request)).toString("utf8"));
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion",
        model: "probe-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop"
          }
        ]
      }));
  });

  t.after(async () => {
    upstream.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address() as AddressInfo | null;
  assert.ok(address);

  const app = buildServer({
    mniuRoot,
    localStore,
    secretVault: new LocalSecretVault(mniuRoot),
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Probe Provider",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      defaultModel: "probe-model",
      apiKey: "sk-probe-secret"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();

  const probeResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/test-endpoint`,
    payload: { timeoutMs: 1000 }
  });
  assert.equal(probeResponse.statusCode, 200);
  const probe = probeResponse.json();
  assert.equal(probe.ok, true);
  assert.equal(probe.mode, "live_http_probe");
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.targetUrl, `http://127.0.0.1:${address.port}/v1/chat/completions`);
  assert.equal(seenUrl, "/v1/chat/completions");
  assert.equal(seenAuthorization, "Bearer sk-probe-secret");
  assert.equal(seenBody.model, "probe-model");

  const healthResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/health?app=codex"
  });
  assert.equal(healthResponse.statusCode, 200);
  const health = healthResponse
    .json()
    .health.find((item: { providerId: string }) => item.providerId === provider.id);
  assert.equal(health.state, "healthy");
  assert.equal(health.lastStatusCode, 200);
  assert.equal(typeof health.lastLatencyMs, "number");
});

test("api dry-runs Claude projection without writing user config", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-claude-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-claude-store-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const app = buildServer({
    homeDir,
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      presetId: "claude-official",
      apiKeyEnv: "ANTHROPIC_API_KEY"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();

  const enableResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/enable`,
    payload: {
      homeDir,
      dryRun: true
    }
  });
  assert.equal(enableResponse.statusCode, 200);
  assert.equal(enableResponse.json().projection.dryRun, true);

  await assert.rejects(
    () => readFile(join(homeDir, ".claude", "settings.json"), "utf8"),
    /ENOENT/
  );
});

test("api stores provider model pricing for usage cost estimates", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-pricing-store-"));
  t.after(async () => {
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const app = buildServer({
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Priced Provider",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "http://127.0.0.1:65530/v1",
      defaultModel: "priced-model",
      modelCatalog: [
        {
          id: "priced-model",
          displayName: "Priced Model",
          contextWindow: 128000,
          inputTokenUsdPerMillion: 1.25,
          outputTokenUsdPerMillion: 10,
          cachedInputTokenUsdPerMillion: 0.5,
          reasoningOutputTokenUsdPerMillion: 12
        }
      ]
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();
  assert.equal(provider.modelCatalog[0].inputTokenUsdPerMillion, 1.25);
  assert.equal(provider.modelCatalog[0].outputTokenUsdPerMillion, 10);
  assert.equal(provider.modelCatalog[0].cachedInputTokenUsdPerMillion, 0.5);
  assert.equal(provider.modelCatalog[0].reasoningOutputTokenUsdPerMillion, 12);

  const patchResponse = await app.inject({
    method: "PATCH",
    url: `/v1/providers/${provider.id}`,
    payload: {
      modelCatalog: [
        {
          id: "priced-model",
          displayName: "Priced Model",
          inputTokenUsdPerMillion: 2,
          outputTokenUsdPerMillion: 12,
          cacheCreationInputTokenUsdPerMillion: 3,
          cacheReadInputTokenUsdPerMillion: 0.25
        }
      ]
    }
  });
  assert.equal(patchResponse.statusCode, 200);
  const patched = patchResponse.json();
  assert.equal(patched.modelCatalog[0].inputTokenUsdPerMillion, 2);
  assert.equal(patched.modelCatalog[0].outputTokenUsdPerMillion, 12);
  assert.equal(patched.modelCatalog[0].cacheCreationInputTokenUsdPerMillion, 3);
  assert.equal(patched.modelCatalog[0].cacheReadInputTokenUsdPerMillion, 0.25);
});

test("api syncs provider model catalog with dry-run and confirmed URL merge", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-model-catalog-sync-"));
  const catalogServer = createServer((request, response) => {
    assert.equal(request.url, "/catalog.json");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        version: 1,
        models: [
          {
            id: "shared-model",
            displayName: "Shared Model",
            inputTokenUsdPerMillion: 1.75,
            outputTokenUsdPerMillion: 8.5
          },
          {
            id: "url-model",
            displayName: "URL Model",
            inputTokenUsdPerMillion: 0.4,
            outputTokenUsdPerMillion: 1.2
          }
        ]
      }));
  });

  t.after(async () => {
    catalogServer.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => {
    catalogServer.listen(0, "127.0.0.1", resolve);
  });
  const address = catalogServer.address() as AddressInfo | null;
  assert.ok(address);

  const app = buildServer({
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Catalog Sync Provider",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "http://127.0.0.1:65531/v1",
      defaultModel: "old-model",
      modelCatalog: [
        {
          id: "old-model",
          displayName: "Old Model",
          inputTokenUsdPerMillion: 3,
          outputTokenUsdPerMillion: 9
        },
        {
          id: "shared-model",
          displayName: "Shared Model",
          inputTokenUsdPerMillion: 2,
          outputTokenUsdPerMillion: 10
        }
      ]
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();

  const dryRunResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/model-catalog/sync`,
    payload: {
      dryRun: true,
      mode: "replace",
      catalog: {
        version: 1,
        models: [
          {
            id: "shared-model",
            displayName: "Shared Model",
            inputTokenUsdPerMillion: 1.5,
            outputTokenUsdPerMillion: 8
          },
          {
            id: "inline-model",
            displayName: "Inline Model",
            inputTokenUsdPerMillion: 0.25,
            outputTokenUsdPerMillion: 1
          }
        ]
      }
    }
  });
  assert.equal(dryRunResponse.statusCode, 200);
  const dryRun = dryRunResponse.json();
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.mode, "replace");
  assert.equal(dryRun.addedCount, 1);
  assert.equal(dryRun.updatedCount, 1);
  assert.equal(dryRun.removedCount, 1);
  assert.equal(dryRun.finalCount, 2);
  assert.equal(dryRun.previewModelCatalog[0].id, "shared-model");

  const afterDryRunResponse = await app.inject({
    method: "GET",
    url: `/v1/providers/${provider.id}`
  });
  assert.equal(afterDryRunResponse.statusCode, 200);
  assert.equal(afterDryRunResponse.json().modelCatalog.length, 2);
  assert.equal(afterDryRunResponse.json().modelCatalog[0].id, "old-model");
  assert.equal(afterDryRunResponse.json().config?.modelCatalogSync, undefined);

  const neverSyncedAuditResponse = await app.inject({
    method: "GET",
    url: `/v1/providers/${provider.id}/model-catalog/audit`
  });
  assert.equal(neverSyncedAuditResponse.statusCode, 200);
  const neverSyncedAudit = neverSyncedAuditResponse.json();
  assert.equal(neverSyncedAudit.status, "never_synced");
  assert.equal(neverSyncedAudit.stale, true);
  assert.equal(neverSyncedAudit.currentCount, 2);

  const duplicateResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/model-catalog/sync`,
    payload: {
      catalog: [
        { id: "dup-model", displayName: "Dup Model" },
        { id: "dup-model", displayName: "Dup Model Copy" }
      ]
    }
  });
  assert.equal(duplicateResponse.statusCode, 400);

  const syncResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${provider.id}/model-catalog/sync`,
    payload: {
      dryRun: false,
      mode: "merge",
      maxAgeDays: 90,
      sourceUrl: `http://127.0.0.1:${address.port}/catalog.json`
    }
  });
  assert.equal(syncResponse.statusCode, 200);
  const sync = syncResponse.json();
  assert.equal(sync.dryRun, false);
  assert.equal(sync.source.type, "url");
  assert.equal(sync.syncMetadataPersisted, true);
  assert.equal(sync.syncMetadata.source.type, "url");
  assert.equal(sync.syncMetadata.mode, "merge");
  assert.equal(sync.syncMetadata.modelCount, 3);
  assert.equal(sync.syncMetadata.maxAgeDays, 90);
  assert.match(sync.syncMetadata.modelsHash, /^[a-f0-9]{64}$/);
  assert.equal(sync.addedCount, 1);
  assert.equal(sync.updatedCount, 1);
  assert.equal(sync.removedCount, 0);
  assert.equal(sync.finalCount, 3);
  assert.equal(sync.provider.modelCatalog.length, 3);
  assert.equal(sync.provider.config.modelCatalogSync.modelCount, 3);

  const syncedResponse = await app.inject({
    method: "GET",
    url: `/v1/providers/${provider.id}`
  });
  assert.equal(syncedResponse.statusCode, 200);
  const syncedModels = syncedResponse.json().modelCatalog;
  assert.equal(syncedModels.map((model: { id: string }) => model.id).join(","), "old-model,shared-model,url-model");
  const sharedModel = syncedModels.find((model: { id: string }) => model.id === "shared-model");
  assert.equal(sharedModel.inputTokenUsdPerMillion, 1.75);
  assert.equal(sharedModel.outputTokenUsdPerMillion, 8.5);
  const syncedProvider = syncedResponse.json();
  assert.equal(syncedProvider.config.modelCatalogSync.source.url, `http://127.0.0.1:${address.port}/catalog.json`);

  const freshAuditResponse = await app.inject({
    method: "GET",
    url: `/v1/providers/${provider.id}/model-catalog/audit?maxAgeDays=90`
  });
  assert.equal(freshAuditResponse.statusCode, 200);
  const freshAudit = freshAuditResponse.json();
  assert.equal(freshAudit.status, "fresh");
  assert.equal(freshAudit.stale, false);
  assert.equal(freshAudit.hashMatches, true);
  assert.equal(freshAudit.modelCount, 3);
  assert.equal(freshAudit.currentCount, 3);
  assert.equal(freshAudit.maxAgeDays, 90);
  assert.match(freshAudit.currentModelsHash, /^[a-f0-9]{64}$/);
});

test("api syncs due provider model catalog policies", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-model-catalog-due-"));
  let requestCount = 0;
  const catalogServer = createServer((request, response) => {
    requestCount += 1;
    assert.equal(request.url, "/scheduled.json");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        models: [
          {
            id: "scheduled-model",
            displayName: "Scheduled Model",
            inputTokenUsdPerMillion: 0.75,
            outputTokenUsdPerMillion: 2.25
          }
        ]
      }));
  });

  t.after(async () => {
    catalogServer.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => {
    catalogServer.listen(0, "127.0.0.1", resolve);
  });
  const address = catalogServer.address() as AddressInfo | null;
  assert.ok(address);
  const sourceUrl = `http://127.0.0.1:${address.port}/scheduled.json`;

  const app = buildServer({
    mniuRoot,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Scheduled Catalog Provider",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "http://127.0.0.1:65531/v1",
      defaultModel: "old-scheduled-model",
      modelCatalog: [
        {
          id: "old-scheduled-model",
          displayName: "Old Scheduled Model"
        }
      ],
      config: {
        modelCatalogSyncPolicy: {
          sourceUrl,
          mode: "replace",
          maxAgeDays: 30,
          refreshIntervalHours: 24,
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();

  const dryRunResponse = await app.inject({
    method: "POST",
    url: "/v1/providers/model-catalog/sync-due",
    payload: {
      dryRun: true,
      app: "codex"
    }
  });
  assert.equal(dryRunResponse.statusCode, 200);
  const dryRun = dryRunResponse.json();
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.policyCount, 1);
  assert.equal(dryRun.dueCount, 1);
  assert.equal(dryRun.results[0].providerId, provider.id);
  assert.equal(dryRun.results[0].status, "would_sync");
  assert.equal(dryRun.results[0].reason, "never_synced");
  assert.equal(requestCount, 0);

  const syncResponse = await app.inject({
    method: "POST",
    url: "/v1/providers/model-catalog/sync-due",
    payload: {
      dryRun: false,
      providerIds: [provider.id]
    }
  });
  assert.equal(syncResponse.statusCode, 200);
  const syncDue = syncResponse.json();
  assert.equal(syncDue.syncedCount, 1);
  assert.equal(syncDue.failedCount, 0);
  assert.equal(syncDue.results[0].status, "synced");
  assert.equal(syncDue.results[0].sync.finalCount, 1);
  assert.equal(syncDue.results[0].sync.syncMetadata.modelCount, 1);
  assert.equal(syncDue.results[0].audit.status, "fresh");
  assert.equal(requestCount, 1);

  const syncedProviderResponse = await app.inject({
    method: "GET",
    url: `/v1/providers/${provider.id}`
  });
  assert.equal(syncedProviderResponse.statusCode, 200);
  const syncedProvider = syncedProviderResponse.json();
  assert.equal(syncedProvider.modelCatalog[0].id, "scheduled-model");
  assert.equal(syncedProvider.config.modelCatalogSyncPolicy.sourceUrl, sourceUrl);
  assert.equal(syncedProvider.config.modelCatalogSync.modelCount, 1);

  const notDueResponse = await app.inject({
    method: "POST",
    url: "/v1/providers/model-catalog/sync-due",
    payload: {
      dryRun: true,
      providerIds: [provider.id]
    }
  });
  assert.equal(notDueResponse.statusCode, 200);
  const notDue = notDueResponse.json();
  assert.equal(notDue.dueCount, 0);
  assert.equal(notDue.results[0].status, "skipped");
  assert.equal(notDue.results[0].reason, "not_due");
  assert.equal(requestCount, 1);
});

test("api scheduler refreshes due provider model catalog policies", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-model-catalog-scheduler-"));
  let requestCount = 0;
  const catalogServer = createServer((request, response) => {
    requestCount += 1;
    assert.equal(request.url, "/auto.json");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        models: [
          {
            id: "auto-model",
            displayName: "Auto Model",
            inputTokenUsdPerMillion: 0.9,
            outputTokenUsdPerMillion: 3.1
          }
        ]
      }));
  });

  let app: ReturnType<typeof buildServer> | undefined;
  t.after(async () => {
    await app?.close();
    catalogServer.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => {
    catalogServer.listen(0, "127.0.0.1", resolve);
  });
  const address = catalogServer.address() as AddressInfo | null;
  assert.ok(address);
  const sourceUrl = `http://127.0.0.1:${address.port}/auto.json`;

  app = buildServer({
    mniuRoot,
    useMockExecutors: true,
    providerModelCatalogSyncScheduler: {
      intervalMs: 50,
      app: "codex"
    }
  });

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().providerModelCatalogSyncScheduler.enabled, true);
  assert.equal(health.json().providerModelCatalogSyncScheduler.intervalMs, 50);

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      app: "codex",
      name: "Auto Catalog Provider",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "http://127.0.0.1:65531/v1",
      defaultModel: "old-auto-model",
      modelCatalog: [
        {
          id: "old-auto-model",
          displayName: "Old Auto Model"
        }
      ],
      config: {
        modelCatalogSyncPolicy: {
          sourceUrl,
          mode: "replace",
          maxAgeDays: 30,
          refreshIntervalHours: 24,
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const provider = createResponse.json();

  const syncedProvider = await waitForProviderModel(app, provider.id, "auto-model");
  assert.ok(syncedProvider.config.modelCatalogSync);
  assert.ok(syncedProvider.config.modelCatalogSync.source);
  assert.equal(syncedProvider.config.modelCatalogSync.source.url, sourceUrl);
  assert.equal(syncedProvider.config.modelCatalogSync.modelCount, 1);
  assert.equal(requestCount, 1);

  await app.close();
  app = undefined;
  const requestsAfterClose = requestCount;
  await delay(150);
  assert.equal(requestCount, requestsAfterClose);
});

test("api starts local proxy, forwards through enabled provider and records logs", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-store-"));
  const upstream = createServer((request, response) => {
    assert.equal(request.url, "/v1/responses");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        model: "proxy-model",
        ok: true,
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          input_tokens_details: {
            cached_tokens: 5
          },
          output_tokens_details: {
            reasoning_tokens: 2
          }
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "ProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "proxy-model",
    wireApi: "responses",
    modelCatalog: [
      {
        id: "proxy-model",
        displayName: "Proxy Model",
        inputTokenUsdPerMillion: 2,
        outputTokenUsdPerMillion: 8,
        cachedInputTokenUsdPerMillion: 1,
        reasoningOutputTokenUsdPerMillion: 10
      }
    ]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const startBody = startResponse.json();

  const proxyResponse = await fetch(
    `http://127.0.0.1:${startBody.runtime.port}/v1/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mn-app": "codex",
        "x-mn-run-id": "run-api-1",
        "x-mn-candidate-id": "codex-1"
      },
      body: JSON.stringify({ model: "proxy-model", input: "hello" })
    }
  );
  assert.equal(proxyResponse.status, 200);
  assert.deepEqual(await proxyResponse.json(), {
    model: "proxy-model",
    ok: true,
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      input_tokens_details: {
        cached_tokens: 5
      },
      output_tokens_details: {
        reasoning_tokens: 2
      }
    }
  });

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?app=codex"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].statusCode, 200);
  assert.equal(logs[0].inputTokens, 12);
  assert.equal(logs[0].outputTokens, 4);
  assert.equal(logs[0].cachedInputTokens, 5);
  assert.equal(logs[0].reasoningOutputTokens, 2);
  assert.equal(logs[0].runId, "run-api-1");
  assert.equal(logs[0].candidateId, "codex-1");

  const runLogsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?runId=run-api-1&candidateId=codex-1"
  });
  assert.equal(runLogsResponse.statusCode, 200);
  assert.equal(runLogsResponse.json().logs.length, 1);

  const summaryResponse = await app.inject({
    method: "GET",
    url: "/v1/usage/summary?app=codex"
  });
  assert.equal(summaryResponse.statusCode, 200);
  assert.equal(summaryResponse.json().summary.requestCount, 1);
  assert.equal(summaryResponse.json().summary.inputTokens, 12);
  assert.equal(summaryResponse.json().summary.outputTokens, 4);
  assert.equal(summaryResponse.json().summary.cachedInputTokens, 5);
  assert.equal(summaryResponse.json().summary.reasoningOutputTokens, 2);
  assert.equal(summaryResponse.json().summary.estimatedCostUsd, 0.000055);
  assert.deepEqual(
    summaryResponse.json().summary.byRun.map((bucket: { runId: string; requestCount: number }) => [
      bucket.runId,
      bucket.requestCount
    ]),
    [["run-api-1", 1]]
  );
  assert.deepEqual(
    summaryResponse
      .json()
      .summary.byCandidate.map((bucket: { candidateId: string; requestCount: number }) => [
        bucket.candidateId,
        bucket.requestCount
      ]),
    [["codex-1", 1]]
  );

  const runSummaryResponse = await app.inject({
    method: "GET",
    url: "/v1/usage/summary?runId=run-api-1&candidateId=codex-1"
  });
  assert.equal(runSummaryResponse.statusCode, 200);
  assert.equal(runSummaryResponse.json().summary.requestCount, 1);

  const requestsResponse = await app.inject({
    method: "GET",
    url: "/v1/usage/requests?app=codex"
  });
  assert.equal(requestsResponse.statusCode, 200);
  assert.equal(requestsResponse.json().requests[0].inputTokens, 12);
  assert.equal(requestsResponse.json().requests[0].cachedInputTokens, 5);
  assert.equal(requestsResponse.json().requests[0].reasoningOutputTokens, 2);
  assert.equal(requestsResponse.json().requests[0].runId, "run-api-1");

  const modelsResponse = await app.inject({
    method: "GET",
    url: "/v1/usage/models?app=codex&runId=run-api-1"
  });
  assert.equal(modelsResponse.statusCode, 200);
  assert.equal(modelsResponse.json().models[0].model, "proxy-model");
  assert.equal(modelsResponse.json().models[0].totalTokens, 16);
  assert.equal(modelsResponse.json().models[0].cachedInputTokens, 5);
  assert.equal(modelsResponse.json().models[0].reasoningOutputTokens, 2);
  assert.equal(modelsResponse.json().models[0].estimatedCostUsd, 0.000055);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api proxy resolves empty and all-circuit-open provider lists to no candidates", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-empty-circuit-store-"));
  let upstreamHits = 0;
  const upstream = createServer((_request, response) => {
    upstreamHits += 1;
    response.writeHead(500, { "content-type": "application/json" }).end(
      JSON.stringify({ error: "provider unavailable" })
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);
  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const app = buildServer({ mniuRoot, localStore, useMockExecutors: true });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });
  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;
  const requestProxy = () => fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mn-app": "codex" },
    body: JSON.stringify({ model: "circuit-model", input: "hello" })
  });

  const empty = await requestProxy();
  assert.equal(empty.status, 503);
  assert.deepEqual(await empty.json(), { error: "no enabled provider for codex" });
  assert.equal(upstreamHits, 0);

  const provider = await localStore.createProvider({
    app: "codex",
    name: "Only provider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "circuit-model",
    wireApi: "responses",
    modelCatalog: [{ id: "circuit-model", displayName: "Circuit model" }],
    config: {
      healthPolicy: { failureThreshold: 1, circuitOpenMs: 120_000 }
    }
  });
  await localStore.enableProvider(provider.id, "codex");
  const opensCircuit = await requestProxy();
  assert.equal(opensCircuit.status, 500);
  assert.equal(upstreamHits, 1);
  const allCircuitOpen = await requestProxy();
  assert.equal(allCircuitOpen.status, 503);
  assert.deepEqual(await allCircuitOpen.json(), {
    error: "no enabled provider for codex"
  });
  assert.equal(upstreamHits, 1);
  const health = await app.inject({
    method: "GET",
    url: "/v1/proxy/health?app=codex"
  });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().health[0].state, "circuit_open");

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api real Codex executor associates proxy logs through injected base URL", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-api-real-proxy-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-api-real-proxy-worktrees-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-real-proxy-store-"));
  const binaryRoot = await mkdtemp(join(tmpdir(), "mn-api-real-proxy-bin-"));
  const codexBinary = join(binaryRoot, "fake-codex.mjs");
  const previousCodexBinary = process.env.MN_CODEX_BINARY;
  const upstreamRequests: Array<{
    url: string;
    runHeader?: string | string[];
    candidateHeader?: string | string[];
    appHeader?: string | string[];
  }> = [];

  await writePackageJson(projectRoot, {
    name: "real-proxy-project"
  });
  await writeFile(
    codexBinary,
    `#!/usr/bin/env node
const baseUrl = process.env.OPENAI_BASE_URL;
if (!baseUrl) {
  console.error("OPENAI_BASE_URL missing");
  process.exit(2);
}
const response = await fetch(baseUrl.replace(/\\/+$/, "") + "/responses", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mn-app": "codex"
  },
  body: JSON.stringify({ model: "proxy-model", input: "executor proxy probe" })
});
const body = await response.text();
console.log(JSON.stringify({
  status: response.status,
  runId: process.env.MN_RUN_ID,
  candidateId: process.env.MN_CANDIDATE_ID,
  baseUrl,
  body
}));
process.exit(response.ok ? 0 : 3);
`
  );
  await chmod(codexBinary, 0o755);
  process.env.MN_CODEX_BINARY = codexBinary;

  const upstream = createServer(async (request, response) => {
    upstreamRequests.push({
      url: request.url ?? "",
      runHeader: request.headers["x-mn-run-id"],
      candidateHeader: request.headers["x-mn-candidate-id"],
      appHeader: request.headers["x-mn-app"]
    });
    await readIncomingRequestBody(request);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "resp-real-executor",
        model: "proxy-model",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: {
          input_tokens: 3,
          output_tokens: 2
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "RealExecutorProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "proxy-model",
    wireApi: "responses",
    modelCatalog: [{ id: "proxy-model", displayName: "Proxy Model" }]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    workspaceRoot,
    useMockExecutors: false
  });
  t.after(async () => {
    if (previousCodexBinary === undefined) {
      delete process.env.MN_CODEX_BINARY;
    } else {
      process.env.MN_CODEX_BINARY = previousCodexBinary;
    }
    upstream.close();
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
    await rm(binaryRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "real-proxy-project",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();

  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "real executor proxy association",
      prompt: "call proxy through injected base url",
      targetServices: [],
      acceptanceCriteria: ["proxy log includes run and candidate"],
      strategy: {
        providers: ["codex"],
        candidates: 1,
        sandbox: "workspace-write",
        requiredGates: ["llm_verifier"],
        humanApproval: "never",
        timeoutSeconds: 10
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);
  const task = taskResponse.json();

  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: {}
  });
  assert.equal(runResponse.statusCode, 201);
  const createdRun = runResponse.json();
  const run = await waitForRunStatus(app, createdRun.id, "completed");
  assert.equal(run.status, "completed");

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0]?.url, "/v1/responses");
  assert.equal(upstreamRequests[0]?.runHeader, undefined);
  assert.equal(upstreamRequests[0]?.candidateHeader, undefined);
  assert.equal(upstreamRequests[0]?.appHeader, undefined);

  const logsResponse = await app.inject({
    method: "GET",
    url: `/v1/proxy/logs?runId=${createdRun.id}&candidateId=codex-1`
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].runId, createdRun.id);
  assert.equal(logs[0].candidateId, "codex-1");
  assert.equal(logs[0].inputTokens, 3);
  assert.equal(logs[0].outputTokens, 2);
});

test("api real Claude executor associates proxy logs through injected base URL", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-api-real-claude-proxy-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-api-real-claude-proxy-worktrees-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-real-claude-proxy-store-"));
  const binaryRoot = await mkdtemp(join(tmpdir(), "mn-api-real-claude-proxy-bin-"));
  const claudeBinary = join(binaryRoot, "fake-claude.mjs");
  const previousClaudeBinary = process.env.MN_CLAUDE_BINARY;
  const upstreamRequests: Array<{
    url: string;
    runHeader?: string | string[];
    candidateHeader?: string | string[];
    appHeader?: string | string[];
  }> = [];

  await writePackageJson(projectRoot, {
    name: "real-claude-proxy-project"
  });
  await writeFile(
    claudeBinary,
    `#!/usr/bin/env node
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  stdin += chunk;
}
const baseUrl = process.env.ANTHROPIC_BASE_URL;
if (!baseUrl) {
  console.error("ANTHROPIC_BASE_URL missing");
  process.exit(2);
}
const response = await fetch(baseUrl.replace(/\\/+$/, "") + "/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mn-app": "claude"
  },
  body: JSON.stringify({
    model: "claude-proxy-model",
    max_tokens: 16,
    messages: [{ role: "user", content: stdin || "executor proxy probe" }]
  })
});
const body = await response.text();
console.log(JSON.stringify({
  status: response.status,
  runId: process.env.MN_RUN_ID,
  candidateId: process.env.MN_CANDIDATE_ID,
  baseUrl,
  body
}));
process.exit(response.ok ? 0 : 3);
`
  );
  await chmod(claudeBinary, 0o755);
  process.env.MN_CLAUDE_BINARY = claudeBinary;

  const upstream = createServer(async (request, response) => {
    upstreamRequests.push({
      url: request.url ?? "",
      runHeader: request.headers["x-mn-run-id"],
      candidateHeader: request.headers["x-mn-candidate-id"],
      appHeader: request.headers["x-mn-app"]
    });
    await readIncomingRequestBody(request);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "msg-real-executor",
        type: "message",
        role: "assistant",
        model: "claude-proxy-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 7,
          output_tokens: 5
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "claude",
    name: "RealClaudeExecutorProxyProvider",
    kind: "anthropic_compatible",
    apiFormat: "anthropic_messages",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "claude-proxy-model",
    modelCatalog: [{ id: "claude-proxy-model", displayName: "Claude Proxy Model" }]
  });
  await localStore.enableProvider(provider.id, "claude");

  const app = buildServer({
    mniuRoot,
    localStore,
    workspaceRoot,
    useMockExecutors: false
  });
  t.after(async () => {
    if (previousClaudeBinary === undefined) {
      delete process.env.MN_CLAUDE_BINARY;
    } else {
      process.env.MN_CLAUDE_BINARY = previousClaudeBinary;
    }
    upstream.close();
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
    await rm(binaryRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: {
      name: "real-claude-proxy-project",
      rootPath: projectRoot,
      defaultBranch: "main"
    }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();

  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "real claude executor proxy association",
      prompt: "call proxy through injected base url",
      targetServices: [],
      acceptanceCriteria: ["proxy log includes run and candidate"],
      strategy: {
        providers: ["claude"],
        candidates: 1,
        sandbox: "workspace-write",
        requiredGates: ["llm_verifier"],
        humanApproval: "never",
        timeoutSeconds: 10
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);
  const task = taskResponse.json();

  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: {}
  });
  assert.equal(runResponse.statusCode, 201);
  const createdRun = runResponse.json();
  const run = await waitForRunStatus(app, createdRun.id, "completed");
  assert.equal(run.status, "completed");

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0]?.url, "/v1/messages");
  assert.equal(upstreamRequests[0]?.runHeader, undefined);
  assert.equal(upstreamRequests[0]?.candidateHeader, undefined);
  assert.equal(upstreamRequests[0]?.appHeader, undefined);

  const logsResponse = await app.inject({
    method: "GET",
    url: `/v1/proxy/logs?runId=${createdRun.id}&candidateId=claude-1`
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].runId, createdRun.id);
  assert.equal(logs[0].candidateId, "claude-1");
  assert.equal(logs[0].inputTokens, 7);
  assert.equal(logs[0].outputTokens, 5);
});

test("api proxy converts Codex Responses for OpenAI Chat providers", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-chat-store-"));
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-api-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: "converted"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 6,
          completion_tokens: 4,
          total_tokens: 10
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "ChatProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat Model" }]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;

  const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({
      model: "chat-model",
      instructions: "Be concise.",
      input: "hello",
      max_output_tokens: 24
    })
  });

  assert.equal(proxyResponse.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.deepEqual(upstreamRequest?.body.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "hello" }
  ]);
  assert.equal(upstreamRequest?.body.max_tokens, 24);

  const responseBody = await proxyResponse.json() as Record<string, unknown>;
  assert.equal(responseBody.object, "response");
  assert.equal(responseBody.output_text, "converted");
  assert.deepEqual(responseBody.usage, {
    input_tokens: 6,
    output_tokens: 4,
    total_tokens: 10
  });

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?app=codex"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].inputTokens, 6);
  assert.equal(logs[0].outputTokens, 4);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api-managed proxy persists and replays duplicate associated requests", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-replay-store-"));
  let upstreamCalls = 0;
  const upstreamIdempotencyKeys: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    upstreamIdempotencyKeys.push(request.headers["idempotency-key"] as string | undefined);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        model: "replay-model",
        output_text: `fresh-${upstreamCalls}`,
        usage: {
          input_tokens: 11,
          output_tokens: 7
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "ReplayProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "replay-model",
    wireApi: "responses",
    modelCatalog: [{
      id: "replay-model",
      displayName: "Replay Model",
      inputTokenUsdPerMillion: 2,
      outputTokenUsdPerMillion: 4
    }],
    config: { idempotencyHeaderName: "Idempotency-Key" }
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;
  const requestBody = JSON.stringify({
    model: "replay-model",
    input: "repeat me"
  });
  const requestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex",
      "x-mn-run-id": "run-replay",
      "x-mn-candidate-id": "codex-1"
    },
    body: requestBody
  };

  const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, requestInit);
  const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, requestInit);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.match(upstreamIdempotencyKeys[0] ?? "", /^mn-[0-9a-f]{64}$/);
  assert.equal(second.headers.get("x-mn-proxy-replay"), "hit");
  assert.equal((await first.json() as { output_text: string }).output_text, "fresh-1");
  assert.equal((await second.json() as { output_text: string }).output_text, "fresh-1");

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?runId=run-replay&candidateId=codex-1"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 2);
  assert.equal(logs.some((log: { replayed?: boolean }) => log.replayed === true), true);
  assert.deepEqual(
    logs
      .map((log: { replayed?: boolean; inputTokens: number; outputTokens: number }) => ({
        replayed: log.replayed,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens
      }))
      .sort((left: { replayed?: boolean }, right: { replayed?: boolean }) =>
        Number(Boolean(left.replayed)) - Number(Boolean(right.replayed))
      ),
    [
      { replayed: undefined, inputTokens: 11, outputTokens: 7 },
      { replayed: true, inputTokens: 0, outputTokens: 0 }
    ]
  );

  const summaryResponse = await app.inject({
    method: "GET",
    url: "/v1/usage/summary?runId=run-replay&candidateId=codex-1"
  });
  assert.equal(summaryResponse.statusCode, 200);
  assert.deepEqual({
    requestCount: summaryResponse.json().summary.requestCount,
    inputTokens: summaryResponse.json().summary.inputTokens,
    outputTokens: summaryResponse.json().summary.outputTokens,
    estimatedCostUsd: summaryResponse.json().summary.estimatedCostUsd
  }, {
    requestCount: 2,
    inputTokens: 11,
    outputTokens: 7,
    estimatedCostUsd: 0.00005
  });

  const modelsResponse = await app.inject({
    method: "GET",
    url: "/v1/usage/models?runId=run-replay&candidateId=codex-1"
  });
  assert.equal(modelsResponse.statusCode, 200);
  assert.deepEqual(modelsResponse.json().models.map((entry: {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  }) => ({
    requestCount: entry.requestCount,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    estimatedCostUsd: entry.estimatedCostUsd
  })), [{
    requestCount: 2,
    inputTokens: 11,
    outputTokens: 7,
    estimatedCostUsd: 0.00005
  }]);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api-managed proxy persists and replays duplicate associated streaming requests", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-stream-replay-store-"));
  let upstreamCalls = 0;
  const upstream = createServer(async (request, response) => {
    upstreamCalls += 1;
    const body = JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(body.stream, true);
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSseData(response, {
      id: "chatcmpl-api-stream-replay-1",
      created: 123,
      model: "stream-replay-model",
      choices: [{ delta: { content: "re" } }]
    });
    writeSseData(response, {
      id: "chatcmpl-api-stream-replay-1",
      created: 123,
      model: "stream-replay-model",
      choices: [{ delta: { content: "play" }, finish_reason: "stop" }]
    });
    writeSseData(response, {
      id: "chatcmpl-api-stream-replay-1",
      created: 123,
      model: "stream-replay-model",
      choices: [],
      usage: {
        prompt_tokens: 13,
        completion_tokens: 5,
        total_tokens: 18
      }
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "StreamReplayProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "stream-replay-model",
    wireApi: "chat",
    modelCatalog: [{ id: "stream-replay-model", displayName: "Stream Replay Model" }]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;
  const requestBody = JSON.stringify({
    model: "stream-replay-model",
    input: "repeat stream",
    stream: true
  });
  const requestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex",
      "x-mn-run-id": "run-stream-replay",
      "x-mn-candidate-id": "codex-1"
    },
    body: requestBody
  };

  const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, requestInit);
  const firstBody = await first.text();
  const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, requestInit);
  const secondBody = await second.text();
  const storeSnapshot = await localStore.read();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 1, JSON.stringify({
    replayHeader: second.headers.get("x-mn-proxy-replay"),
    records: storeSnapshot.proxyReplayRecords.map((record) => ({
      key: record.key,
      requestHash: record.requestHash,
      targetUrl: record.targetUrl,
      replayCount: record.replayCount
    }))
  }));
  assert.equal(second.headers.get("x-mn-proxy-replay"), "hit");
  assert.equal(firstBody, secondBody);
  assert.match(secondBody, /event: response\.output_text\.delta/);
  assert.match(secondBody, /"delta":"re"/);
  assert.match(secondBody, /"delta":"play"/);
  assert.match(secondBody, /event: response\.completed/);

  assert.equal(storeSnapshot.proxyReplayRecords.length, 1);
  assert.equal(storeSnapshot.proxyReplayRecords[0]?.replayCount, 1);
  assert.equal(
    Buffer.from(storeSnapshot.proxyReplayRecords[0]?.bodyBase64 ?? "", "base64").toString("utf8"),
    firstBody
  );

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?runId=run-stream-replay&candidateId=codex-1"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 2);
  assert.equal(logs.some((log: { replayed?: boolean }) => log.replayed === true), true);
  assert.deepEqual(
    logs
      .map((log: { replayed?: boolean; inputTokens: number; outputTokens: number }) => ({
        replayed: log.replayed,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens
      }))
      .sort((left: { replayed?: boolean }, right: { replayed?: boolean }) =>
        Number(Boolean(left.replayed)) - Number(Boolean(right.replayed))
      ),
    [
      { replayed: undefined, inputTokens: 13, outputTokens: 5 },
      { replayed: true, inputTokens: 0, outputTokens: 0 }
    ]
  );

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api proxy converts Claude Messages for OpenAI Chat providers", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-claude-chat-store-"));
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-api-claude-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: "claude via chat"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6,
          total_tokens: 16
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "claude",
    name: "ClaudeChatProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat Model" }]
  });
  await localStore.enableProvider(provider.id, "claude");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;

  const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "claude"
    },
    body: JSON.stringify({
      model: "claude-model",
      system: "Be concise.",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32
    })
  });

  assert.equal(proxyResponse.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.model, "chat-model");
  assert.deepEqual(upstreamRequest?.body.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "hello" }
  ]);
  assert.equal(upstreamRequest?.body.max_tokens, 32);

  const responseBody = await proxyResponse.json() as Record<string, unknown>;
  assert.equal(responseBody.type, "message");
  assert.equal(responseBody.role, "assistant");
  assert.equal(responseBody.model, "chat-model");
  assert.deepEqual(responseBody.content, [
    { type: "text", text: "claude via chat" }
  ]);
  assert.deepEqual(responseBody.usage, {
    input_tokens: 10,
    output_tokens: 6
  });

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?app=claude"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].inputTokens, 10);
  assert.equal(logs[0].outputTokens, 6);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api proxy converts Claude Messages for OpenAI Responses providers", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-claude-responses-store-"));
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "resp-api-claude-1",
        model: "responses-model",
        output_text: "claude via responses",
        stop_reason: "stop",
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          total_tokens: 19
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "claude",
    name: "ClaudeResponsesProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "responses-model",
    wireApi: "responses",
    modelCatalog: [{ id: "responses-model", displayName: "Responses Model" }]
  });
  await localStore.enableProvider(provider.id, "claude");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;

  const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "claude"
    },
    body: JSON.stringify({
      model: "claude-model",
      system: "Be concise.",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 40
    })
  });

  assert.equal(proxyResponse.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/responses");
  assert.equal(upstreamRequest?.body.model, "responses-model");
  assert.equal(upstreamRequest?.body.instructions, "Be concise.");
  assert.deepEqual(upstreamRequest?.body.input, [
    { role: "user", content: "hello" }
  ]);
  assert.equal(upstreamRequest?.body.max_output_tokens, 40);

  const responseBody = await proxyResponse.json() as Record<string, unknown>;
  assert.equal(responseBody.type, "message");
  assert.equal(responseBody.role, "assistant");
  assert.equal(responseBody.model, "responses-model");
  assert.deepEqual(responseBody.content, [
    { type: "text", text: "claude via responses" }
  ]);
  assert.deepEqual(responseBody.usage, {
    input_tokens: 12,
    output_tokens: 7
  });

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?app=claude"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].inputTokens, 12);
  assert.equal(logs[0].outputTokens, 7);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api proxy maps Claude tools for OpenAI Responses providers", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-claude-tools-store-"));
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "resp-api-claude-tool-1",
        model: "responses-model",
        output: [
          {
            type: "function_call",
            call_id: "toolu_weather",
            name: "get_weather",
            arguments: "{\"city\":\"Hangzhou\"}",
            status: "completed"
          }
        ],
        usage: {
          input_tokens: 16,
          output_tokens: 6,
          total_tokens: 22
        }
      }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "claude",
    name: "ClaudeToolProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "responses-model",
    wireApi: "responses",
    modelCatalog: [{ id: "responses-model", displayName: "Responses Model" }]
  });
  await localStore.enableProvider(provider.id, "claude");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;

  const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "claude"
    },
    body: JSON.stringify({
      model: "claude-model",
      messages: [
        {
          role: "user",
          content: "weather?"
        }
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather.",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string" }
            }
          }
        }
      ],
      tool_choice: { type: "tool", name: "get_weather" },
      max_tokens: 40
    })
  });

  assert.equal(proxyResponse.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/responses");
  assert.deepEqual(upstreamRequest?.body.tools, [
    {
      type: "function",
      name: "get_weather",
      description: "Get weather.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" }
        }
      }
    }
  ]);
  assert.deepEqual(upstreamRequest?.body.tool_choice, {
    type: "function",
    name: "get_weather"
  });

  const responseBody = await proxyResponse.json() as Record<string, unknown>;
  assert.equal(responseBody.stop_reason, "tool_use");
  assert.deepEqual(responseBody.content, [
    {
      type: "tool_use",
      id: "toolu_weather",
      name: "get_weather",
      input: { city: "Hangzhou" }
    }
  ]);

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?app=claude"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].inputTokens, 16);
  assert.equal(logs[0].outputTokens, 6);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api proxy converts streaming Chat Completions SSE to Responses SSE", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-chat-sse-store-"));
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSseData(response, {
      id: "chatcmpl-api-stream-1",
      created: 123,
      model: "chat-model",
      choices: [{ delta: { content: "stream" }, finish_reason: "stop" }]
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "ChatStreamProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat Model" }]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;

  const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({
      model: "chat-model",
      input: "hello",
      stream: true
    })
  });
  assert.equal(proxyResponse.status, 200);
  assert.match(proxyResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.stream, true);
  const body = await proxyResponse.text();
  assert.match(body, /event: response\.output_text\.delta/);
  assert.match(body, /"delta":"stream"/);
  assert.match(body, /event: response\.completed/);
  assert.match(body, /"output_text":"stream"/);
  assert.match(body, /"input_tokens":2/);
  assert.match(body, /"output_tokens":2/);

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?app=codex"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].inputTokens, 2);
  assert.equal(logs[0].outputTokens, 2);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api proxy converts streaming Chat Completions tool call SSE to Responses SSE", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-chat-tool-sse-store-"));
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSseData(response, {
      id: "chatcmpl-api-stream-tool-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "{\"city\""
                }
              }
            ]
          }
        }
      ]
    });
    writeSseData(response, {
      id: "chatcmpl-api-stream-tool-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: ":\"Hangzhou\"}"
                }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14
      }
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address() as AddressInfo | null;
  assert.ok(upstreamAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "ChatToolStreamProxyProvider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat Model" }]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    upstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;

  const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({
      model: "chat-model",
      input: "weather?",
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      ],
      stream: true
    })
  });
  assert.equal(proxyResponse.status, 200);
  assert.match(proxyResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.stream, true);
  const events = parseSseEvents(await proxyResponse.text());
  const argumentDeltas = events
    .filter((event) => event.event === "response.function_call_arguments.delta")
    .map((event) => String((event.data as Record<string, unknown>).delta ?? ""))
    .join("");
  assert.equal(argumentDeltas, "{\"city\":\"Hangzhou\"}");
  const completed = events.find((event) => event.event === "response.completed")?.data as Record<string, unknown>;
  const completedResponse = completed.response as Record<string, unknown>;
  assert.deepEqual(completedResponse.output, [
    {
      id: "call_weather",
      type: "function_call",
      status: "completed",
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Hangzhou\"}"
    }
  ]);
  assert.equal(completedResponse.stop_reason, "tool_calls");

  const logsResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/logs?app=codex"
  });
  assert.equal(logsResponse.statusCode, 200);
  const logs = logsResponse.json().logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerId, provider.id);
  assert.equal(logs[0].inputTokens, 10);
  assert.equal(logs[0].outputTokens, 4);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
});

test("api proxy opens circuit and skips unhealthy provider", async (t) => {
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-proxy-health-store-"));
  let primaryHits = 0;
  let fallbackHits = 0;
  const primaryUpstream = createServer((_request, response) => {
    primaryHits += 1;
    response
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "primary down" }));
  });
  const fallbackUpstream = createServer((_request, response) => {
    fallbackHits += 1;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ model: "fallback-model", ok: true }));
  });
  await Promise.all([
    new Promise<void>((resolve) => {
      primaryUpstream.listen(0, "127.0.0.1", resolve);
    }),
    new Promise<void>((resolve) => {
      fallbackUpstream.listen(0, "127.0.0.1", resolve);
    })
  ]);
  const primaryAddress = primaryUpstream.address() as AddressInfo | null;
  const fallbackAddress = fallbackUpstream.address() as AddressInfo | null;
  assert.ok(primaryAddress);
  assert.ok(fallbackAddress);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const primary = await localStore.createProvider({
    app: "codex",
    name: "Primary",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${primaryAddress.port}`,
    defaultModel: "fallback-model",
    wireApi: "responses",
    modelCatalog: [{ id: "fallback-model", displayName: "Fallback Model" }],
    config: {
      healthPolicy: {
        failureThreshold: 2,
        circuitOpenMs: 120_000
      }
    },
    sortOrder: 1
  });
  await localStore.createProvider({
    app: "codex",
    name: "Fallback",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${fallbackAddress.port}`,
    defaultModel: "fallback-model",
    wireApi: "responses",
    modelCatalog: [{ id: "fallback-model", displayName: "Fallback Model" }],
    sortOrder: 2
  });
  await localStore.enableProvider(primary.id, "codex");

  const app = buildServer({
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    primaryUpstream.close();
    fallbackUpstream.close();
    await app.close();
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);
  const proxyPort = startResponse.json().runtime.port;

  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mn-app": "codex"
      },
      body: JSON.stringify({ model: "fallback-model", input: "hello" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { model: "fallback-model", ok: true });
  }

  assert.equal(primaryHits, 2);
  assert.equal(fallbackHits, 2);

  const healthResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/health?app=codex"
  });
  assert.equal(healthResponse.statusCode, 200);
  const primaryHealth = healthResponse
    .json()
    .health.find((item: { providerId: string }) => item.providerId === primary.id);
  assert.equal(primaryHealth.state, "circuit_open");
  assert.equal(primaryHealth.consecutiveFailures, 2);
  assert.equal(
    Date.parse(primaryHealth.circuitOpenUntil) - Date.parse(primaryHealth.circuitOpenedAt),
    120_000
  );

  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({ model: "fallback-model", input: "hello" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: "fallback-model", ok: true });
  assert.equal(primaryHits, 2);
  assert.equal(fallbackHits, 3);

  const resetResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/health/reset",
    payload: { providerId: primary.id, app: "codex" }
  });
  assert.equal(resetResponse.statusCode, 200);
  assert.equal(resetResponse.json().resetCount, 1);
  assert.equal(resetResponse.json().reset[0].state, "circuit_open");

  const resetHealthResponse = await app.inject({
    method: "GET",
    url: "/v1/proxy/health?app=codex"
  });
  assert.equal(resetHealthResponse.statusCode, 200);
  const resetPrimaryHealth = resetHealthResponse
    .json()
    .health.find((item: { providerId: string }) => item.providerId === primary.id);
  assert.equal(resetPrimaryHealth.state, "unknown");
  assert.equal(resetPrimaryHealth.consecutiveFailures, 0);

  const retryResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({ model: "fallback-model", input: "hello again" })
  });
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), { model: "fallback-model", ok: true });
  assert.equal(primaryHits, 3);
  assert.equal(fallbackHits, 4);
});

test("api proxy takeover writes live config and restore reverts from backup", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-takeover-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-takeover-store-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  const codexConfigPath = join(homeDir, ".codex", "config.toml");
  const originalConfig = [
    "model_provider = \"old\"",
    "model = \"old-model\"",
    "experimental_bearer_token = \"proxy-existing-secret\"",
    ""
  ].join("\n");
  await writeFile(codexConfigPath, originalConfig);

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "TakeoverProvider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: "https://api.example.test/v1",
    defaultModel: "proxy-model",
    wireApi: "responses",
    modelCatalog: [{ id: "proxy-model", displayName: "Proxy Model" }]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    homeDir,
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);

  const takeoverResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/apps/codex/takeover",
    payload: { homeDir }
  });
  assert.equal(takeoverResponse.statusCode, 200);
  const takeoverBody = takeoverResponse.json();
  assert.equal(takeoverBody.proxy.takenOverApps.includes("codex"), true);
  assert.equal(
    JSON.stringify(takeoverBody.projection.filePreviews).includes("proxy-existing-secret"),
    false
  );
  assert.equal(takeoverBody.projection.projectedConfig.includes("proxy-existing-secret"), false);
  assert.equal(
    takeoverBody.projection.filePreviews[0].before.includes("proxy-existing-secret"),
    false
  );
  assert.equal(
    takeoverBody.projection.filePreviews[0].after.includes("proxy-existing-secret"),
    false
  );
  assert.match(JSON.stringify(takeoverBody.projection.filePreviews), /\*\*\*\*/);
  assert.match(
    await readFile(codexConfigPath, "utf8"),
    /base_url = "http:\/\/127.0.0.1:\d+\/v1"/
  );
  const takeoverProjection = await localStore.getLatestProjection({
    app: "codex",
    purpose: "proxy_takeover"
  });
  assert.ok(takeoverProjection?.backupPath);
  await writeFile(
    takeoverProjection.backupPath,
    '"auth.token" = "proxy-malformed-backup-secret"\ninvalid = [\n'
  );

  const stopPreview = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: { dryRun: true }
  });
  assert.equal(stopPreview.statusCode, 200);
  assert.equal(stopPreview.json().runtime.running, true);
  assert.equal(stopPreview.json().restoration.files.length, 1);
  assert.equal(stopPreview.json().filePreviews.length, 1);
  assert.equal(
    JSON.stringify(stopPreview.json().filePreviews).includes("proxy-existing-secret"),
    false
  );
  assert.equal(
    JSON.stringify(stopPreview.json().filePreviews).includes("proxy-malformed-backup-secret"),
    false
  );
  assert.match(JSON.stringify(stopPreview.json().filePreviews), /REDACTED INVALID CONFIG/);
  assert.match(JSON.stringify(stopPreview.json().filePreviews), /\*\*\*\*/);
  assert.equal(
    stopPreview.json().filePreviews[0].before.includes("proxy-existing-secret"),
    false
  );
  assert.equal(
    stopPreview.json().filePreviews[0].after.includes("proxy-malformed-backup-secret"),
    false
  );
  assert.match(await readFile(codexConfigPath, "utf8"), /mniu_proxy_/);
  await writeFile(takeoverProjection.backupPath, originalConfig);

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 200);
  assert.equal(stopResponse.json().runtime.running, false);
  assert.equal(stopResponse.json().restoration.files[0].restored, true);
  assert.deepEqual(stopResponse.json().proxy.takenOverApps, []);
  assert.equal(await readFile(codexConfigPath, "utf8"), originalConfig);
});

test("api proxy restore refuses to overwrite user edits after takeover", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-takeover-conflict-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-takeover-conflict-store-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  const codexConfigPath = join(homeDir, ".codex", "config.toml");
  await writeFile(codexConfigPath, "model_provider = \"old\"\n");

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const provider = await localStore.createProvider({
    app: "codex",
    name: "ConflictProvider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: "https://api.example.test/v1",
    defaultModel: "proxy-model",
    wireApi: "responses",
    modelCatalog: [{ id: "proxy-model", displayName: "Proxy Model" }]
  });
  await localStore.enableProvider(provider.id, "codex");

  const app = buildServer({
    homeDir,
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/start",
    payload: { port: 0 }
  });
  assert.equal(startResponse.statusCode, 200);

  const takeoverResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/apps/codex/takeover",
    payload: { homeDir }
  });
  assert.equal(takeoverResponse.statusCode, 200);
  await writeFile(codexConfigPath, "model_provider = \"manual-change\"\n");

  const stopResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/stop",
    payload: {}
  });
  assert.equal(stopResponse.statusCode, 409);
  assert.match(stopResponse.body, /cannot safely stop/);
  const statusResponse = await app.inject({ method: "GET", url: "/v1/proxy/status" });
  assert.equal(statusResponse.json().runtime.running, true);

  const restoreResponse = await app.inject({
    method: "POST",
    url: "/v1/proxy/apps/codex/restore",
    payload: {}
  });
  assert.equal(restoreResponse.statusCode, 409);
  assert.match(restoreResponse.body, /live config changed after takeover/);
  assert.equal(await readFile(codexConfigPath, "utf8"), "model_provider = \"manual-change\"\n");
});

test("api stores MCP env in keychain secret vault backend", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-mcp-keychain-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-mcp-keychain-root-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const saved = new Map<string, string>();
  const optionValue = (args: string[], option: string): string => {
    const value = args[args.indexOf(option) + 1];
    assert.ok(value);
    return value;
  };
  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const app = buildServer({
    homeDir,
    mniuRoot,
    localStore,
    secretVault: new LocalSecretVault(mniuRoot, {
      backend: "keychain",
      keychain: {
        service: "dev.muniu.mcp-api-test",
        accountPrefix: "mcp:",
        runSecurity: async (args) => {
          const account = optionValue(args, "-a");
          if (args[0] === "add-generic-password") {
            saved.set(account, optionValue(args, "-w"));
            return "";
          }
          if (args[0] === "find-generic-password") {
            const value = saved.get(account);
            if (!value) throw Object.assign(new Error("The specified item could not be found."), { code: 44 });
            return `${value}\n`;
          }
          throw new Error(`unexpected security command: ${args.join(" ")}`);
        }
      }
    }),
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const mcpCreate = await app.inject({
    method: "POST",
    url: "/v1/mcp/servers",
    payload: {
      name: "keychain-weather",
      command: "node",
      args: ["weather.js"],
      env: { WEATHER_TOKEN: "keychain-secret-token" },
      apps: ["codex"]
    }
  });
  assert.equal(mcpCreate.statusCode, 201);
  assert.doesNotMatch(mcpCreate.body, /keychain-secret-token/);
  const mcp = mcpCreate.json();
  const storedMcp = await localStore.getMcpServer(mcp.id);
  assert.match(storedMcp?.env.WEATHER_TOKEN ?? "", /^mniu:keychain:keychain:/);

  const mcpProject = await app.inject({
    method: "POST",
    url: `/v1/mcp/servers/${mcp.id}/project`,
    payload: { homeDir }
  });
  assert.equal(mcpProject.statusCode, 200);
  assert.doesNotMatch(mcpProject.body, /keychain-secret-token/);
  const codexMcpConfig = await readFile(join(homeDir, ".codex", "config.toml"), "utf8");
  assert.match(codexMcpConfig, /\[mcp_servers\.keychain_weather\.env\]/);
  assert.match(codexMcpConfig, /WEATHER_TOKEN = "keychain-secret-token"/);
});

test("api manages MCP projection and prompt activation with live backfill", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-ext-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-ext-root-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const localStore = new FileLocalStore({ rootDir: mniuRoot });
  const app = buildServer({
    homeDir,
    mniuRoot,
    localStore,
    useMockExecutors: true
  });
  t.after(async () => {
    await app.close();
  });

  const mcpCreate = await app.inject({
    method: "POST",
    url: "/v1/mcp/servers",
    payload: {
      name: "weather",
      command: "node",
      args: ["weather.js"],
      env: { WEATHER_TOKEN: "secret-token" },
      apps: ["claude", "codex"]
    }
  });
  assert.equal(mcpCreate.statusCode, 201);
  assert.doesNotMatch(mcpCreate.body, /secret-token/);
  const mcp = mcpCreate.json();
  const storedMcp = await localStore.getMcpServer(mcp.id);
  assert.notEqual(storedMcp?.env.WEATHER_TOKEN, "secret-token");
  assert.match(storedMcp?.env.WEATHER_TOKEN ?? "", /^mniu:local_encrypted:/);

  const mcpProject = await app.inject({
    method: "POST",
    url: `/v1/mcp/servers/${mcp.id}/project`,
    payload: { homeDir }
  });
  assert.equal(mcpProject.statusCode, 200);
  assert.doesNotMatch(mcpProject.body, /secret-token/);
  const claudeMcpConfig = await readFile(join(homeDir, ".claude.json"), "utf8");
  assert.match(claudeMcpConfig, /"weather"/);
  assert.match(claudeMcpConfig, /"WEATHER_TOKEN": "secret-token"/);
  const codexMcpConfig = await readFile(join(homeDir, ".codex", "config.toml"), "utf8");
  assert.match(codexMcpConfig, /\[mcp_servers\.weather\]/);
  assert.match(codexMcpConfig, /args = \[\s*"weather\.js"\s*\]/);
  assert.match(codexMcpConfig, /\[mcp_servers\.weather\.env\]/);
  assert.match(codexMcpConfig, /WEATHER_TOKEN = "secret-token"/);
  assert.doesNotMatch(codexMcpConfig, /args_json|env_json/);
  assert.match(codexMcpConfig, /secret-token/);

  const oldPromptResponse = await app.inject({
    method: "POST",
    url: "/v1/prompts/presets",
    payload: {
      name: "Old Prompt",
      content: "old prompt",
      apps: ["claude"]
    }
  });
  assert.equal(oldPromptResponse.statusCode, 201);
  const oldPrompt = oldPromptResponse.json();

  const firstActivation = await app.inject({
    method: "POST",
    url: `/v1/prompts/presets/${oldPrompt.id}/activate`,
    payload: { app: "claude", homeDir }
  });
  assert.equal(firstActivation.statusCode, 200);
  await writeFile(join(homeDir, ".claude", "CLAUDE.md"), "manual live edit\n");

  const nextPromptResponse = await app.inject({
    method: "POST",
    url: "/v1/prompts/presets",
    payload: {
      name: "Next Prompt",
      content: "next prompt",
      apps: ["claude"]
    }
  });
  assert.equal(nextPromptResponse.statusCode, 201);
  const nextPrompt = nextPromptResponse.json();

  const secondActivation = await app.inject({
    method: "POST",
    url: `/v1/prompts/presets/${nextPrompt.id}/activate`,
    payload: { app: "claude", homeDir }
  });
  assert.equal(secondActivation.statusCode, 200);
  assert.equal(secondActivation.json().backfilledPrompt.content, "manual live edit\n");
  assert.equal(await readFile(join(homeDir, ".claude", "CLAUDE.md"), "utf8"), "next prompt\n");

  const skillSourcePath = join(mniuRoot, "skills", "review");
  await mkdir(skillSourcePath, { recursive: true });
  await writeFile(
    join(skillSourcePath, "SKILL.md"),
    "---\nname: review\nversion: 1.0.0\ndescription: Review changes.\n---\n"
  );

  const discoveredSkills = await app.inject({
    method: "GET",
    url: `/v1/skills/discover?homeDir=${encodeURIComponent(homeDir)}`
  });
  assert.equal(discoveredSkills.statusCode, 200);
  assert.equal(discoveredSkills.json().skills[0].name, "review");

  const skillCreate = await app.inject({
    method: "POST",
    url: "/v1/skills",
    payload: {
      name: "review",
      sourcePath: skillSourcePath,
      apps: ["claude", "codex"]
    }
  });
  assert.equal(skillCreate.statusCode, 201);
  const skill = skillCreate.json();

  const skillInstall = await app.inject({
    method: "POST",
    url: `/v1/skills/${skill.id}/install`,
    payload: {
      app: "claude",
      homeDir,
      mode: "copy"
    }
  });
  assert.equal(skillInstall.statusCode, 200);
  const claudeSkillPath = join(homeDir, ".claude", "skills", "review", "SKILL.md");
  assert.match(await readFile(claudeSkillPath, "utf8"), /Review changes/);
  assert.equal((await localStore.getSkillInstallation(skill.id, "claude"))?.mode, "copy");

  await writeFile(claudeSkillPath, "# local skill edit\n");
  const skillUninstall = await app.inject({
    method: "POST",
    url: `/v1/skills/${skill.id}/uninstall`,
    payload: {
      app: "claude",
      homeDir
    }
  });
  assert.equal(skillUninstall.statusCode, 200);
  const skillUninstallBody = skillUninstall.json();
  assert.equal(
    await readFile(join(skillUninstallBody.result.backupPath, "SKILL.md"), "utf8"),
    "# local skill edit\n"
  );
  assert.equal(await localStore.getSkillInstallation(skill.id, "claude"), undefined);

  const skillSymlinkInstall = await app.inject({
    method: "POST",
    url: `/v1/skills/${skill.id}/install`,
    payload: {
      app: "codex",
      homeDir,
      mode: "symlink"
    }
  });
  assert.equal(skillSymlinkInstall.statusCode, 200);
  const codexSkillPath = join(homeDir, ".codex", "skills", "review");
  assert.equal((await lstat(codexSkillPath)).isSymbolicLink(), true);
  assert.equal(await readlink(codexSkillPath), skillSourcePath);
});

test("api syncs signed skill registry into the local skill store", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-api-skill-registry-home-"));
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-skill-registry-root-"));
  const localStore = new FileLocalStore({ rootDir: join(mniuRoot, "store") });
  const registryPath = join(homeDir, "registry.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const publicKeyId = "api-registry-2026";
  const app = buildServer({ homeDir, mniuRoot, localStore });
  t.after(async () => {
    await app.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(mniuRoot, { recursive: true, force: true });
  });

  const writeRegistry = async (version: string, heading: string) => {
    const files: SkillRegistryFile[] = [
      {
        path: "SKILL.md",
        content: `---\nname: review\nversion: ${version}\ndescription: Review changes.\n---\n# ${heading}\n`
      }
    ];
    const sha256 = hashSkillRegistryFiles(files);
    const entry = {
      name: "review",
      version,
      description: "Review changes.",
      apps: ["claude", "codex"] as Array<"claude" | "codex">,
      files,
      sha256,
      publicKeyId
    };
    const signature = sign(
      null,
      Buffer.from(skillRegistrySignaturePayload(entry)),
      privateKey
    ).toString("base64");
    const registry = {
      version: 1 as const,
      publicKeys: [{ id: publicKeyId, publicKey: publicKeyDer }],
      revokedPublicKeyIds: ["api-registry-2025-retired"],
      signatureAlgorithm: "ed25519" as const,
      skills: [{ ...entry, signature }]
    };
    const releaseMetadata = {
      version: 1 as const,
      sequence: 1,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      registrySha256: hashSkillRegistryReleasePayload(registry),
      publicKeyId
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
      }, null, 2)}\n`
    );
  };

  await writeRegistry("1.0.0", "Review v1");
  const dryRun = await app.inject({
    method: "POST",
    url: "/v1/skills/registry/sync",
    payload: {
      registryUrl: registryPath,
      requireSignature: true,
      requireReleaseMetadata: true
    }
  });
  assert.equal(dryRun.statusCode, 200);
  assert.equal(dryRun.json().dryRun, true);
  assert.equal(dryRun.json().skills[0].status, "new");
  assert.equal(dryRun.json().skills[0].publicKeyId, publicKeyId);
  assert.equal(dryRun.json().releaseMetadata.signatureVerified, true);
  assert.equal(dryRun.json().releaseMetadata.publicKeyId, publicKeyId);
  assert.deepEqual(await localStore.listSkills(), []);

  const sync = await app.inject({
    method: "POST",
    url: "/v1/skills/registry/sync",
    payload: {
      registryUrl: registryPath,
      dryRun: false,
      requireSignature: true,
      requireReleaseMetadata: true
    }
  });
  assert.equal(sync.statusCode, 200);
  assert.equal(sync.json().skills[0].applied, true);
  assert.equal(sync.json().savedSkills[0].version, "1.0.0");
  assert.match(
    await readFile(join(mniuRoot, "skills", "review", "SKILL.md"), "utf8"),
    /Review v1/
  );

  const profileCreate = await app.inject({
    method: "POST",
    url: "/v1/skills/registry/profiles",
    payload: {
      name: "Trusted API Registry",
      registryUrl: registryPath,
      requireSignature: true,
      requireReleaseMetadata: true,
      trustedPublicKeys: [{ id: publicKeyId, publicKey: publicKeyDer }],
      revokedPublicKeyIds: ["api-registry-2025-retired"]
    }
  });
  assert.equal(profileCreate.statusCode, 201);
  assert.equal(profileCreate.json().name, "Trusted API Registry");
  assert.equal(profileCreate.json().requireReleaseMetadata, true);
  assert.equal(profileCreate.json().trustedPublicKeys[0].id, publicKeyId);

  const profileList = await app.inject({
    method: "GET",
    url: "/v1/skills/registry/profiles"
  });
  assert.equal(profileList.statusCode, 200);
  assert.equal(profileList.json().profiles[0].id, profileCreate.json().id);

  const profileDryRun = await app.inject({
    method: "POST",
    url: `/v1/skills/registry/profiles/${profileCreate.json().id}/sync`,
    payload: { dryRun: true }
  });
  assert.equal(profileDryRun.statusCode, 200);
  assert.equal(profileDryRun.json().skills[0].status, "current");
  assert.equal(profileDryRun.json().skills[0].publicKeyId, publicKeyId);
  assert.equal(profileDryRun.json().releaseMetadata.signatureVerified, true);

  await writeRegistry("1.1.0", "Review v2");
  const update = await app.inject({
    method: "POST",
    url: "/v1/skills/registry/sync",
    payload: {
      registryUrl: registryPath,
      dryRun: false,
      requireSignature: true,
      requireReleaseMetadata: true
    }
  });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().skills[0].status, "update");
  assert.equal((await localStore.listSkills())[0]?.version, "1.1.0");
  assert.match(
    await readFile(join(mniuRoot, "skills", "review", "SKILL.md"), "utf8"),
    /Review v2/
  );

  const revoked = await app.inject({
    method: "POST",
    url: "/v1/skills/registry/sync",
    payload: {
      registryUrl: registryPath,
      requireSignature: true,
      requireReleaseMetadata: true,
      revokedPublicKeyIds: [publicKeyId]
    }
  });
  assert.equal(revoked.statusCode, 400);
  assert.match(revoked.body, /public key revoked/);

  const revokedProfile = await app.inject({
    method: "PATCH",
    url: `/v1/skills/registry/profiles/${profileCreate.json().id}`,
    payload: { revokedPublicKeyIds: [publicKeyId] }
  });
  assert.equal(revokedProfile.statusCode, 200);
  const profileRevokedSync = await app.inject({
    method: "POST",
    url: `/v1/skills/registry/profiles/${profileCreate.json().id}/sync`,
    payload: { dryRun: true }
  });
  assert.equal(profileRevokedSync.statusCode, 400);
  assert.match(profileRevokedSync.body, /public key revoked/);
});

interface TestRunRecord {
  id: string;
  status: string;
  candidates: Array<{
    id?: string;
    provider?: string;
    status?: string;
    result?: { stdout?: string };
  }>;
  gates: Array<{ gate: string; status: string }>;
  winnerCandidateId?: string;
}

async function waitForRunStatus(
  app: ReturnType<typeof buildServer>,
  runId: string,
  status: string
): Promise<TestRunRecord> {
  const startedAt = Date.now();
  let lastRun: TestRunRecord | undefined;
  while (Date.now() - startedAt < 10_000) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`
    });
    assert.equal(response.statusCode, 200);
    lastRun = response.json() as TestRunRecord;
    if (lastRun.status === status) return lastRun;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for run ${runId} to become ${status}; last=${lastRun?.status ?? "unknown"}`
  );
}

async function waitForPersistedRunStatus(
  statePath: string,
  runId: string,
  status: string
): Promise<void> {
  const startedAt = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - startedAt < 10_000) {
    const snapshot = JSON.parse(await readFile(statePath, "utf8")) as {
      runs?: Array<{ id: string; status: string }>;
    };
    lastStatus = snapshot.runs?.find((run) => run.id === runId)?.status ?? "missing";
    if (lastStatus === status) return;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for persisted run ${runId} to become ${status}; last=${lastStatus}`
  );
}

async function waitForPersistedRunJobStatus(
  statePath: string,
  runId: string,
  status: string
): Promise<void> {
  const startedAt = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - startedAt < 10_000) {
    const snapshot = JSON.parse(await readFile(statePath, "utf8")) as {
      runJobs?: Array<{ runId: string; status: string }>;
    };
    lastStatus = snapshot.runJobs?.find((job) => job.runId === runId)?.status ?? "missing";
    if (lastStatus === status) return;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for persisted run job ${runId} to become ${status}; last=${lastStatus}`
  );
}

async function waitForRunJobQueueStatus(
  queue: RunJobQueue,
  runId: string,
  status: RunJobQueueItem["status"]
): Promise<RunJobQueueItem> {
  const startedAt = Date.now();
  let lastStatus = "missing";
  while (Date.now() - startedAt < 10_000) {
    const item = queue.read(runId);
    lastStatus = item?.status ?? "missing";
    if (item && item.status === status) return item;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for run job ${runId} to become ${status}; last=${lastStatus}`
  );
}

async function waitForProviderModel(
  app: ReturnType<typeof buildServer>,
  providerId: string,
  modelId: string
): Promise<{
  modelCatalog: Array<{ id: string }>;
  config: {
    modelCatalogSync?: {
      source?: { url?: string };
      modelCount?: number;
    };
  };
}> {
  const startedAt = Date.now();
  let lastModelIds = "";
  while (Date.now() - startedAt < 5_000) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/providers/${providerId}`
    });
    assert.equal(response.statusCode, 200);
    const provider = response.json() as {
      modelCatalog: Array<{ id: string }>;
      config: {
        modelCatalogSync?: {
          source?: { url?: string };
          modelCount?: number;
        };
      };
    };
    lastModelIds = provider.modelCatalog.map((model) => model.id).join(",");
    if (provider.modelCatalog.some((model) => model.id === modelId)) {
      return provider;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for provider ${providerId} to include model ${modelId}; last=${lastModelIds}`
  );
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string
): Promise<string> {
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let text = "";
  while (Date.now() - startedAt < 10_000) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes(needle)) return text;
  }
  throw new Error(`Timed out waiting for SSE frame containing ${needle}. Received:\n${text}`);
}

async function waitForArtifactIndex(
  mniuRoot: string,
  runId: string
): Promise<{ artifacts: Array<{ artifactId: string; bytes: number }> }> {
  const indexPath = join(mniuRoot, "artifacts", "runs", runId, "index.json");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      return JSON.parse(await readFile(indexPath, "utf8")) as {
        artifacts: Array<{ artifactId: string; bytes: number }>;
      };
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for artifact index ${indexPath}`);
}

function parseTarEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.toString("ascii", 0, 100).replace(/\0.*$/, "");
    const sizeText = header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const contentStart = offset + 512;
    entries.set(name, archive.subarray(contentStart, contentStart + size));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writePackageJson(root: string, body: unknown): Promise<void> {
  await writeFile(join(root, "package.json"), `${JSON.stringify(body)}\n`);
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, { cwd });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readIncomingRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeSseData(response: ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseSseEvents(body: string): Array<{ event?: string; data: unknown }> {
  const events: Array<{ event?: string; data: unknown }> = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    let event: string | undefined;
    const dataParts: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
    }
    const rawData = dataParts.join("\n");
    if (!rawData) continue;
    try {
      events.push({ event, data: JSON.parse(rawData) });
    } catch {
      events.push({ event, data: rawData });
    }
  }
  return events;
}
