// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPostgresPool } from "./lib/postgres-pool.mjs";
import { captureCodingRepository, captureCodingTask, configureProductProjectionJournal, validateProjectionJournal, createAgentOsCompositionRoot } from "@mn/host";
import { S3Cas, storeProtectedJson } from "@mn/storage";
import { AgentOsWorker } from "@mn/worker";
import { createHandlers, supportedKinds } from "./enterprise-worker-handlers.mjs";
import { PostgresKernelStore } from "./lib/postgres-kernel-store.mjs";
import { PostgresWorkerStore } from "./lib/postgres-worker-store.mjs";
import { createEnterpriseWorkerStore } from "./lib/enterprise-worker-store.mjs";
import { SigV4S3Client } from "./lib/s3-client.mjs";
import { VaultTransitKeyProvider } from "./lib/enterprise-secrets.mjs";
import { readPendingKindApproval } from "./lib/kind-coding-observer.mjs";

assert.equal(process.env.MN_WORKER_FIXTURE_MODE, "false");
const tenantId = `coding-proof-${randomUUID()}`;
const pool = createPostgresPool({ connectionString: process.env.MN_POSTGRES_URL });
const hmacKey = Buffer.from(process.env.MN_EVENT_HMAC_KEY, "base64");
const kernelStore = new PostgresKernelStore({ pool, hmacKey });
await kernelStore.initialize();
const jobStore = new PostgresWorkerStore({ pool, hmacKey });
const store = createEnterpriseWorkerStore({ kernelStore, jobStore });
const cas = new S3Cas({ bucket: process.env.MN_S3_BUCKET, prefix: process.env.MN_S3_PREFIX,
  client: new SigV4S3Client({ endpoint: process.env.MN_S3_ENDPOINT, region: process.env.MN_S3_REGION,
    accessKeyId: process.env.MN_S3_ACCESS_KEY_ID, secretAccessKey: process.env.MN_S3_SECRET_ACCESS_KEY }) });
const protectedPayloadKeyProvider = new VaultTransitKeyProvider({ address: process.env.MN_VAULT_ADDR,
  token: process.env.MN_VAULT_TOKEN, mount: process.env.MN_VAULT_TRANSIT_MOUNT,
  keyName: process.env.MN_VAULT_TRANSIT_KEY, individuallyRevocable: true });
configureProductProjectionJournal(kernelStore, cas, protectedPayloadKeyProvider);
configureProductProjectionJournal(jobStore, cas, protectedPayloadKeyProvider);
await validateProjectionJournal(kernelStore);
const composition = await createAgentOsCompositionRoot({ profile: "enterprise", store });
const kernel = composition.kernel;
const fixtureRoot = await mkdtemp(join(process.env.MN_KUBERNETES_SHARED_ROOT, "production-proof-"));
const exec = promisify(execFile);
let workerRun;
const abort = new AbortController();
try {
  const repositoryPath = join(fixtureRoot, "repository");
  await mkdir(repositoryPath);
  await exec("/usr/bin/git", ["init", "--quiet", repositoryPath]);
  await writeFile(join(repositoryPath, "message.txt"), "old value\n");
  await exec("/usr/bin/git", ["add", "message.txt"], { cwd: repositoryPath });
  await exec("/usr/bin/git", ["-c", "user.name=Kind Fixture", "-c", "user.email=fixture@muniu.invalid",
    "commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
  const workspace = await kernel.createWorkspace(tenantId, "fixture-owner", "workspace", {
    name: "生产 Coding 验证", viewMode: "business", pluginIds: ["coding"],
  });
  const productOptions = { store, tenantId, workspaceId: workspace.id, actorId: "fixture-owner",
    expectedStreamVersion: 0, now: () => new Date().toISOString(), id: (kind) => `${kind}-${randomUUID()}` };
  const repository = await captureCodingRepository({ ...productOptions, idempotencyKey: "repository",
    input: await realpath(repositoryPath) });
  const task = await captureCodingTask({ ...productOptions, idempotencyKey: "task",
    input: "将 old value 改为 new value" });
  const thread = (await kernel.listThreads(tenantId, workspace.id))
    .find((value) => value.resourceRef?.namespace === "coding.task" && value.resourceRef.resourceId === task.id);
  assert.ok(thread, "Host 必须创建绑定 Coding 任务的 Thread");
  await store.transact(tenantId, (tx) => {
    tx.putProjection("modelConnection", "fixture-model", { id: "fixture-model", tenantId,
      presetId: "deepseek", secretRef: "vault://muniu/v2/models/fixture", defaultModel: "fixture-model", status: "ready" });
  });
  const execution = await kernel.submitTurn(tenantId, "fixture-owner", "turn", {
    preparedMessage: await storeProtectedJson({ tenantId, workspaceId: workspace.id, ownerType: "thread",
      ownerId: thread.id, protectedPayloadRef: `thread-payload-${randomUUID()}`, value: { message: task.request },
      cas, keyProvider: protectedPayloadKeyProvider, createdAt: new Date().toISOString() }),
    workspaceId: workspace.id, threadId: thread.id, expectedStreamVersion: thread.streamVersion,
    message: task.request, agentDefinitionId: "coding.builtin", modelBindingId: "fixture-model",
    executionPrincipalId: "agent:coding", runnerId: "builtin",
    authority: { workspaceId: workspace.id, principalId: "agent:coding",
      toolIds: ["coding.repository.read", "coding.sandbox.write", "coding.gate.verify", "coding.candidate.accept"],
      dataScopes: [{ namespace: "repository", resourceId: repository.id }],
      autoAllowedEffects: ["local_read", "local_reversible_write"],
      budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 10000, maxCostMinorUnits: "0",
        currency: "CNY", maxDurationMs: 300000 } },
  });
  let modelCalls = 0;
  const handlers = await createHandlers({ store, composition, fixtureMode: false, cas,
    protectedPayloadKeyProvider,
    secretStore: { async read() { return "fixture-only"; } },
    modelInvoker: async () => {
      modelCalls += 1;
      return { text: "更新消息", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }, toolCalls: [{ id: "fixture-patch", toolId: "coding.sandbox.write",
        arguments: { summary: "更新消息", patch: "diff --git a/message.txt b/message.txt\n--- a/message.txt\n+++ b/message.txt\n@@ -1 +1 @@\n-old value\n+new value\n" } }] };
    },
    modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100,
      rates: { id: "non-billable-fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0",
        cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }),
  });
  const worker = new AgentOsWorker({ id: `proof-${randomUUID()}`, store, handlers, tenantId,
    kinds: supportedKinds,
    lock: { engineLockDigest: "proof", expectedEngineLockDigest: "proof",
      pluginLockDigest: "proof", expectedPluginLockDigest: "proof" } });
  workerRun = worker.pollOnce(abort.signal);
  let completed = false;
  workerRun.finally(() => { completed = true; }).catch(() => {});
  const deadline = Date.now() + 240000;
  let approved = false;
  while (!completed && Date.now() < deadline) {
    const pending = await readPendingKindApproval(pool, tenantId, execution.id, { cas, keyProvider: protectedPayloadKeyProvider, namespaces: ["approval"] });
    if (pending) {
      assert.equal(pending.effectClass, "privileged");
      await kernel.decideApproval(tenantId, "fixture-owner", "approve", pending.id, pending.streamVersion, "approve_once");
      approved = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!completed) { abort.abort(); throw new Error("生产 Coding Worker 超时"); }
  const result = await workerRun;
  const failure = result.status === "failed"
    ? (await pool.query("select failure_json from mn_v2.jobs where tenant_id=$1 and job_id=$2", [tenantId, result.jobId])).rows[0]?.failure_json
    : undefined;
  assert.equal(result.status, "completed", JSON.stringify({ ...result, failure }));
  assert.equal(approved, true);
  assert.equal(modelCalls, 1);
  const state = await store.transact(tenantId, (tx) => ({
    execution: tx.getProjection("execution", execution.id),
    gates: tx.listProjections("coding.gate-result"), evidence: tx.listProjections("coding.code-evidence"),
    deliverables: tx.listProjections("deliverable"), candidates: tx.listProjections("coding.candidate"),
  }));
  assert.equal(state.execution.status, "completed");
  assert.equal(state.gates[0].authoritative, true);
  assert.equal(state.gates[0].status, "passed");
  assert.equal(state.evidence.length, 1);
  assert.equal(state.deliverables.length, 1);
  assert.match(state.candidates[0].diff, /\+new value/u);
  process.stdout.write(`${JSON.stringify({ kindProductionCoding: "passed", runtime: "kubernetes",
    store: "PostgreSQL/S3", runner: "builtin", approved, modelCalls, authoritativeGate: true })}\n`);
} finally {
  abort.abort();
  await workerRun?.catch(() => {});
  await composition.context.fiber.dispose();
  await rm(fixtureRoot, { recursive: true, force: true });
  await pool.end();
}
