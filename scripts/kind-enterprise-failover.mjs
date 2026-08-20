// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { digestSpecRevision } from "../packages/specs/dist/index.js";

const mode = process.argv[2];
const statePath = resolve(process.env.MN_KIND_FAILOVER_STATE ?? "/tmp/muniu-kind-failover.json");
const workerTokenPath = resolve(
  process.env.MN_KIND_WORKER_TOKEN_FILE ?? "/tmp/muniu-kind-worker-token"
);
const apiUrl = (process.env.MN_KIND_API_URL ?? "http://127.0.0.1:57318").replace(/\/+$/u, "");
const fixtureUrl = (process.env.MN_KIND_FIXTURE_URL ?? "http://127.0.0.1:58080").replace(/\/+$/u, "");
const postgresUrl = process.env.MN_KIND_POSTGRES_URL ??
  "postgresql://mn:mn-kind-only@127.0.0.1:55433/muniu";
const tenantId = "tenant-kind-failover";
const fixtureRoot = resolve("examples/microservice-repo");

if (mode === "bootstrap") {
  await bootstrap();
} else if (mode === "capture") {
  await captureOwner();
} else if (mode === "verify") {
  await verify();
} else if (mode === "post-restart") {
  await postRestart();
} else {
  throw new Error(
    "usage: node scripts/kind-enterprise-failover.mjs bootstrap|capture|verify|post-restart"
  );
}

async function bootstrap() {
  const bootstrapOwnerToken = await issueToken("project_owner", "bootstrap", "kind-owner");
  const adminToken = await issueToken("org_admin", "bootstrap", "kind-admin");
  const deniedCapabilities = await api(
    bootstrapOwnerToken,
    "GET",
    "/v1/capabilities",
    undefined,
    [403]
  );
  assert.equal(deniedCapabilities.error, "role is not authorized for this operation");
  const capabilities = await api(adminToken, "GET", "/v1/capabilities");
  const workflow = capabilities.workflows.find((item) => item.id === "governed-increment-v1");
  const harness = capabilities.harnessProfiles.find((item) => item.id === "enterprise");
  assert.equal(workflow?.status, "available");
  assert.equal(harness?.status, "available");

  const project = await api(bootstrapOwnerToken, "POST", "/v1/projects", {
    name: "kind-enterprise-failover",
    rootPath: "/work/sandboxes/fixture",
    defaultBranch: "main"
  }, [201]);
  const ownerToken = await issueToken("project_owner", project.id, "kind-owner");
  const reviewerToken = await issueToken("reviewer", project.id, "kind-reviewer");
  const workerToken = await issueToken("developer", project.id, "kind-worker", {
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
  const provider = await api(adminToken, "POST", "/v1/providers", {
    app: "agent",
    name: "Kind deterministic builtin model",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: "https://muniu-kind-fixture:8443/v1",
    defaultModel: "kind-deterministic-model",
    modelCatalog: [{ id: "kind-deterministic-model", displayName: "Kind deterministic model" }],
    enabled: true,
    config: {
      providerAccountId: "kind-fixture",
      enterpriseScope: { tenantIds: [tenantId], projectIds: [project.id] }
    }
  }, [201]);
  const indexed = await api(ownerToken, "POST", `/v1/projects/${project.id}/index`, {});
  assert.deepEqual(indexed.project.services.map((service) => service.id).sort(), [
    "inventory",
    "orders"
  ]);

  const approvedSource = JSON.parse(
    await readFile(resolve(fixtureRoot, "specs/order-reservation/spec.yaml"), "utf8")
  ).revision;
  const {
    approvedAt: _approvedAt,
    approvedBy: _approvedBy,
    digest: _digest,
    ...revisionBase
  } = approvedSource;
  const semanticRevision = { ...revisionBase, revision: 1, status: "draft" };
  const draft = { ...semanticRevision, digest: digestSpecRevision(semanticRevision) };
  await api(ownerToken, "POST", "/v1/spec-sets", {
    specSet: {
      id: draft.specSetId,
      title: draft.title,
      description: "Kind API owner failover acceptance Spec.",
      latestRevision: 0,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt
    },
    initialRevision: draft
  }, [201]);
  const approved = await api(
    reviewerToken,
    "POST",
    `/v1/spec-sets/${draft.specSetId}/revisions/1/approve`,
    { approvedBy: "kind-reviewer" },
    [201]
  );
  const specRef = {
    specSetId: approved.specSetId,
    revision: approved.revision,
    digest: approved.digest
  };
  const task = await api(ownerToken, "POST", "/v1/tasks", {
    projectId: project.id,
    title: "Recover builtin execution after API owner loss",
    intent: "implement",
    targetServices: approved.targetServices,
    prompt: "Write kind-failover.txt exactly as requested, then verify the repository.",
    acceptanceCriteria: ["kind-failover.txt is created", "all required Gates pass"],
    specRef,
    workflowRef: capabilityRef(workflow),
    harnessProfileRef: capabilityRef(harness),
    strategy: {
      schemaVersion: 2,
      targets: [{
        runtimeId: "builtin",
        providerId: provider.id,
        modelId: "kind-deterministic-model",
        candidates: 1
      }],
      sandbox: "isolated-worktree",
      requiredGates: ["unit_test", "lint", "typecheck", "contract", "security", "llm_verifier"],
      humanApproval: "on-risk",
      timeoutSeconds: 600
    }
  }, [201]);
  const run = await api(ownerToken, "POST", `/v1/tasks/${task.id}/runs`, {
    queueOnly: true,
    queuePriority: 500
  }, [201]);
  assert.equal(run.status, "queued");
  assert.equal(run.harnessManifest.profile.id, "enterprise");

  const state = {
    schemaVersion: 1,
    tenantId,
    projectId: project.id,
    taskId: task.id,
    runId: run.id,
    ownerToken,
    providerId: provider.id
  };
  await writePrivateJson(statePath, state);
  await writeFile(workerTokenPath, workerToken, { mode: 0o600 });
  await chmod(workerTokenPath, 0o600);
  console.log(JSON.stringify({
    kindEnterpriseBootstrap: "passed",
    projectId: project.id,
    taskId: task.id,
    runId: run.id,
    statePath,
    workerTokenPath
  }));
}

async function verify() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.schemaVersion, 1);
  assert.ok(state.firstExecution);
  const first = state.firstExecution;
  const pg = new Client({ connectionString: postgresUrl });
  await pg.connect();
  try {
    const takeover = await waitFor(async () => {
      const result = await pg.query(`
        SELECT e.execution_id,e.generation,e.owner_instance_id,e.session_id,
               a.approval_id
        FROM mn_builtin_agent_executions e
        JOIN mn_builtin_agent_approvals a
          ON a.tenant_id=e.tenant_id AND a.execution_id=e.execution_id
         AND a.generation=e.generation
        WHERE e.tenant_id=$1 AND e.run_id=$2 AND e.state='running'
          AND e.generation > $3 AND a.decision IS NULL
        ORDER BY e.generation DESC
        LIMIT 1
      `, [state.tenantId, state.runId, first.generation]);
      return result.rows[0];
    }, 180_000, "takeover approval generation");
    assert.notEqual(takeover.owner_instance_id, first.owner_instance_id);
    await api(
      state.ownerToken,
      "POST",
      `/v1/agent-sessions/${encodeURIComponent(takeover.session_id)}` +
        `/approvals/${encodeURIComponent(takeover.approval_id)}`,
      {
        schemaVersion: 1,
        kind: "agent-approval-decision-request",
        clientRequestId: "kind-takeover-approval",
        decision: "approve_once"
      }
    );

    let completed = await waitFor(
      async () => {
        const run = await api(state.ownerToken, "GET", `/v1/runs/${state.runId}`);
        if (run.status === "waiting_approval") {
          await api(state.ownerToken, "POST", `/v1/runs/${state.runId}/approve`, {
            decision: "approve"
          }, [200, 202]);
          return undefined;
        }
        if (["failed", "cancelled"].includes(run.status)) {
          throw new Error(`run became terminal with status ${run.status}`);
        }
        return run.status === "completed" ? run : undefined;
      },
      300_000,
      "completed failover run"
    );
    assert.ok(completed.gateResultsV2.length > 0);
    assert.equal(
      completed.gateResultsV2.some((gate) => gate.required && gate.status !== "pass"),
      false
    );
    assert.ok(completed.sandboxEvidenceHistory.length >= 2);
    assert.ok(completed.candidates.some((candidate) =>
      candidate.executionBinding?.runtimeId === "builtin" &&
      candidate.executionBinding?.providerId === state.providerId
    ));

    const generations = await pg.query(`
      SELECT generation,state,owner_instance_id
      FROM mn_builtin_agent_executions
      WHERE tenant_id=$1 AND run_id=$2
      ORDER BY generation
    `, [state.tenantId, state.runId]);
    assert.ok(generations.rows.length >= 2);
    assert.equal(generations.rows[0].state, "cancelled");
    assert.equal(generations.rows.at(-1).state, "completed");
    const interrupted = await pg.query(`
      SELECT decision,resolution,decision_digest
      FROM mn_builtin_agent_approvals
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
    `, [state.tenantId, first.execution_id, first.generation]);
    assert.ok(interrupted.rows.some((row) =>
      row.decision === "deny" && row.resolution === "interrupted" &&
      /^[a-f0-9]{64}$/u.test(row.decision_digest)
    ));

    const archive = await apiBytes(
      state.ownerToken,
      `/v1/runs/${state.runId}/artifacts/archive`
    );
    assert.ok(archive.byteLength > 1024);
    const modelStatus = await fetch(`${fixtureUrl}/model/status`).then(checkJson);
    assert.ok(modelStatus.modelRequests >= 2);
    assert.ok(modelStatus.modelToolCalls >= 2);
    console.log(JSON.stringify({
      kindEnterpriseFailover: "passed",
      runId: state.runId,
      deletedOwner: first.owner_instance_id,
      takeoverOwner: takeover.owner_instance_id,
      generations: generations.rows.length,
      sandboxLeases: completed.sandboxEvidenceHistory.length,
      gateResults: completed.gateResultsV2.length,
      evidenceArchiveBytes: archive.byteLength,
      modelRequests: modelStatus.modelRequests
    }));
  } finally {
    await pg.end();
  }
}

async function captureOwner() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const pg = new Client({ connectionString: postgresUrl });
  await pg.connect();
  try {
    const firstExecution = await waitFor(async () => {
      const result = await pg.query(`
        SELECT e.execution_id,e.generation,e.owner_instance_id,e.session_id,
               a.approval_id
        FROM mn_builtin_agent_executions e
        JOIN mn_builtin_agent_approvals a
          ON a.tenant_id=e.tenant_id AND a.execution_id=e.execution_id
         AND a.generation=e.generation
        WHERE e.tenant_id=$1 AND e.run_id=$2 AND e.state='running'
          AND a.decision IS NULL
        ORDER BY e.generation DESC
        LIMIT 1
      `, [state.tenantId, state.runId]);
      return result.rows[0];
    }, 180_000, "first durable builtin approval");
    assert.match(firstExecution.owner_instance_id, /^muniu-api-/u);
    await writePrivateJson(statePath, { ...state, firstExecution });
    console.log(JSON.stringify({
      kindEnterpriseOwnerCapture: "passed",
      ownerPod: firstExecution.owner_instance_id,
      generation: firstExecution.generation
    }));
  } finally {
    await pg.end();
  }
}

async function postRestart() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const run = await waitFor(async () => {
    const current = await api(state.ownerToken, "GET", `/v1/runs/${state.runId}`);
    return current.status === "completed" ? current : undefined;
  }, 120_000, "completed run after PostgreSQL restart");
  const archive = await apiBytes(
    state.ownerToken,
    `/v1/runs/${state.runId}/artifacts/archive`
  );
  assert.ok(archive.byteLength > 1024);
  console.log(JSON.stringify({
    kindEnterprisePostgresRestart: "passed",
    runId: run.id,
    evidenceArchiveBytes: archive.byteLength
  }));
}

function capabilityRef(capability) {
  return { id: capability.id, version: capability.version, digest: capability.digest };
}

async function issueToken(role, projectId, sub, options = {}) {
  const query = new URLSearchParams({
    role,
    tenant: tenantId,
    project: projectId,
    sub,
    principal_type: options.principalType ?? "human",
    scopes: (options.scopes ?? []).join(",")
  });
  const response = await fetch(`${fixtureUrl}/token?${query}`, { method: "POST" });
  return (await checkJson(response)).access_token;
}

async function api(token, method, path, body, expected = [200]) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function apiBytes(token, path) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function checkJson(response) {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function waitFor(operation, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== null) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${description}`, { cause: lastError });
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
