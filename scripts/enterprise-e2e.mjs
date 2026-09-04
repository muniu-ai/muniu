#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { seedHostFlow, verifyCommittedEvent } from "./enterprise-host-flow.mjs";
import { SigV4S3Client } from "./lib/s3-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(root, "docker-compose.enterprise.yml");
const argumentsSet = new Set(process.argv.slice(2));
const staticOnly = argumentsSet.delete("--static");
const composeRequested = argumentsSet.delete("--with-compose");
const keepCompose = argumentsSet.delete("--keep-compose");
if (argumentsSet.size > 0) throw new Error(`未知参数：${[...argumentsSet].join(", ")}`);
if (staticOnly && (composeRequested || keepCompose)) {
  throw new Error("--static 不能与 --with-compose 或 --keep-compose 同时使用");
}
const withCompose = !staticOnly;

function command(executable, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0 || allowFailure) resolveCommand({ code, signal, stdout, stderr });
      else rejectCommand(new Error(`${executable} ${args.join(" ")} 失败：${stderr.trim() || stdout.trim() || signal || code}`));
    });
  });
}

const compose = (...args) => command("docker", ["compose", "-f", composeFile, ...args]);

async function staticFixture() {
  await command(process.execPath, ["--test", "scripts/test/deployment-v2.test.mjs"]);
  await command(process.execPath, ["scripts/verify-helm-chart.mjs"]);
  const [storage, worker, host, composeSource] = await Promise.all([
    readFile(join(root, "packages/storage/src/postgres.ts"), "utf8"),
    readFile(join(root, "apps/worker/src/index.ts"), "utf8"),
    readFile(join(root, "apps/host/src/host.ts"), "utf8"),
    readFile(composeFile, "utf8"),
  ]);
  assert.match(storage, /create schema if not exists mn_v2/u);
  assert.match(storage, /JOB_LEASE_MILLISECONDS/u);
  assert.match(worker, /WORKER_LEASE_MILLISECONDS/u);
  assert.match(worker, /StaleFencingTokenError/u);
  assert.match(host, /EVENT_CURSOR_EXPIRED/u);
  assert.match(composeSource, /host-a:[\s\S]*host-b:[\s\S]*worker-a:[\s\S]*worker-b:/u);
  process.stdout.write("企业 v2 静态 fixture 通过：mn_v2、30000ms lease、fencing、RPO 0 恢复路径已锁定\n");
}

async function waitFor(check, label, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} 超时${lastError ? `：${lastError.message}` : ""}`);
}

async function composeFixture() {
  const pg = await import("pg");
  await compose("config", "--quiet");
  await compose("up", "--build", "--detach", "--wait");
  const pool = new pg.default.Pool({ connectionString: "postgresql://mn:mn-e2e-only@127.0.0.1:55432/mn_enterprise" });
  try {
    const state = await seedHostFlow();
    const tenantBTokenResponse = await fetch("http://127.0.0.1:59080/token?tenant=tenant-b&sub=owner-b@example.test", { method: "POST" });
    const tenantBTokenText = await tenantBTokenResponse.text();
    assert.equal(tenantBTokenResponse.status, 200, tenantBTokenText);
    const tenantBToken = JSON.parse(tenantBTokenText).access_token;
    const tenantB = await fetch("http://127.0.0.1:17319/v2/workspaces", {
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    assert.deepEqual((await tenantB.json()).data, [], "tenant B 不得读取 tenant A 工作区");
    const foreignWorkspace = await fetch(`http://127.0.0.1:17319/v2/workspaces/${state.workspaceId}`, {
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    assert.equal(foreignWorkspace.status, 404, "tenant B 不得按 ID 读取 tenant A 工作区");
    const foreignPlugin = await fetch(
      `http://127.0.0.1:17319/v2/workspaces/${state.workspaceId}/plugin-activations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenantBToken}`,
          "content-type": "application/json",
          "Idempotency-Key": "tenant-b-foreign-plugin",
        },
        body: JSON.stringify({ pluginId: "opc", expectedStreamVersion: 1 }),
      },
    );
    assert.equal(foreignPlugin.status, 404, "tenant B 不得激活 tenant A 的插件");

    await compose("kill", "--signal", "SIGKILL", "host-a");
    await verifyCommittedEvent(state);
    process.stdout.write("Host owner 丢失后，已提交事件 RPO 0\n");

    await verifyS3Cas();
    await verifyWorkers(pool, state.workspaceId);

    await compose("restart", "postgres");
    await waitFor(async () => {
      const response = await fetch("http://127.0.0.1:17319/v2/readiness").catch(() => undefined);
      return response?.ok;
    }, "PostgreSQL 重启后的 Host readiness");
    await verifyCommittedEvent(state);
    process.stdout.write("PostgreSQL 重启后，已提交事件仍可读取，RPO 0\n");

    await pool.query("update mn_v2.tenant_heads set retention_floor = $2 where tenant_id = $1", [state.tenantId, state.cursor + 1]);
    const expired = await fetch(`http://127.0.0.1:17319/v2/workspaces/${state.workspaceId}/events?after=0`, {
      headers: { authorization: `Bearer ${state.accessToken}` },
    });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, "EVENT_CURSOR_EXPIRED");
  } finally {
    await pool.end();
  }
}

async function verifyS3Cas() {
  const client = new SigV4S3Client({
    endpoint: "http://127.0.0.1:59000",
    region: "us-east-1",
    accessKeyId: "mn-e2e",
    secretAccessKey: "mn-e2e-secret-only",
  });
  const bytes = Buffer.from("mn-v2-enterprise-cas-rpo0");
  const objectDigest = createHash("sha256").update(bytes).digest("hex");
  const key = `v2/fixture/sha256/${objectDigest}`;
  const created = await client.putObject({
    bucket: "mn-v2-artifacts",
    key,
    body: bytes,
    ifNoneMatch: "*",
    checksumSha256: Buffer.from(objectDigest, "hex").toString("base64"),
  });
  assert.equal(typeof created, "boolean");
  assert.deepEqual(Buffer.from(await client.getObject({ bucket: "mn-v2-artifacts", key })), bytes);
  await compose("restart", "minio");
  await waitFor(() => client.probe("mn-v2-artifacts"), "MinIO 重启恢复");
  assert.deepEqual(Buffer.from(await client.getObject({ bucket: "mn-v2-artifacts", key })), bytes);
  process.stdout.write("S3 v2/ CAS 在对象存储重启后保持可读\n");
}

async function enqueue(pool, { id, kind, payload, workspaceId }) {
  await pool.query(`
    insert into mn_v2.jobs (
      job_id, tenant_id, workspace_id, kind, payload_json, status, attempts,
      available_at, fencing_token, idempotency_key, created_at, updated_at
    ) values ($1, 'tenant-enterprise-e2e', $2, $3, $4::jsonb, 'available', 0,
      now(), 0, $5, now(), now())
  `, [id, workspaceId ?? null, kind, JSON.stringify(payload), `fixture:${id}`]);
}

async function job(pool, id) {
  return (await pool.query("select * from mn_v2.jobs where job_id = $1", [id])).rows[0];
}

async function verifyWorkers(pool, workspaceId) {
  await enqueue(pool, { id: "job-echo", kind: "fixture.echo", payload: { value: "ok" } });
  const echoed = await waitFor(async () => {
    const row = await job(pool, "job-echo");
    return row?.status === "completed" ? row : undefined;
  }, "双 Worker 正常 claim");
  assert.equal(echoed.result_json.value, "ok");

  await pool.query(`
    insert into mn_v2.projections (
      tenant_id, namespace, projection_key, stream_version, value_json, updated_at
    ) values (
      'tenant-enterprise-e2e', 'execution', 'execution-reconcile', 0,
      $1::jsonb, now()
    )
  `, [JSON.stringify({
    id: "execution-reconcile",
    tenantId: "tenant-enterprise-e2e",
    workspaceId,
    status: "running",
    generation: 1,
    streamVersion: 0,
  })]);
  await enqueue(pool, {
    id: "job-reconcile",
    kind: "fixture.external_unknown",
    payload: { executionId: "execution-reconcile" },
    workspaceId,
  });
  const unknown = await waitFor(async () => {
    const row = await job(pool, "job-reconcile");
    return row?.status === "failed" ? row : undefined;
  }, "未知外部副作用进入人工核对");
  assert.equal(unknown.failure_json.code, "UNKNOWN_EXTERNAL_SIDE_EFFECT");
  const reconciliation = await pool.query(
    "select status from mn_v2.reconciliations where execution_id = 'execution-reconcile'",
  );
  assert.equal(reconciliation.rows[0]?.status, "needs_reconciliation");
  const event = await pool.query(`
    select event_type from mn_v2.events
    where tenant_id = 'tenant-enterprise-e2e'
      and aggregate_type = 'execution' and aggregate_id = 'execution-reconcile'
  `);
  assert.equal(event.rows[0]?.event_type, "execution.needs_reconciliation");
  const execution = await pool.query(`
    select stream_version, value_json from mn_v2.projections
    where tenant_id = 'tenant-enterprise-e2e'
      and namespace = 'execution' and projection_key = 'execution-reconcile'
  `);
  assert.equal(execution.rows[0]?.value_json.status, "needs_reconciliation");
  assert.equal(Number(execution.rows[0]?.stream_version), 1);
  const inbox = await pool.query(`
    select value_json from mn_v2.projections
    where tenant_id = 'tenant-enterprise-e2e'
      and namespace = 'inbox'
      and projection_key = 'reconciliation:execution-reconcile:job-reconcile'
  `);
  assert.equal(inbox.rows[0]?.value_json.status, "open");
  const outbox = await pool.query(`
    select topic from mn_v2.outbox
    where tenant_id = 'tenant-enterprise-e2e'
      and message_id = 'reconciliation:execution-reconcile:job-reconcile'
  `);
  assert.equal(outbox.rows[0]?.topic, "execution.reconciliation_required");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await job(pool, "job-reconcile")).attempts, 1, "结果未知的外部副作用不得自动重放");

  await enqueue(pool, {
    id: "job-owner-loss",
    kind: "fixture.wait",
    payload: { delayMs: 60000, recoveryDelayMs: 3000 },
  });
  const firstClaim = await waitFor(async () => {
    const row = await job(pool, "job-owner-loss");
    return row?.status === "leased" ? row : undefined;
  }, "首个 Worker claim");
  const originalOwner = firstClaim.lease_owner;
  const originalFencing = Number(firstClaim.fencing_token);
  assert.ok(["worker-a", "worker-b"].includes(originalOwner));
  await compose("kill", "--signal", "SIGKILL", originalOwner);
  const takeover = await waitFor(async () => {
    const row = await job(pool, "job-owner-loss");
    return row?.status === "leased" && Number(row.fencing_token) > originalFencing ? row : undefined;
  }, "30 秒租约过期后的 Worker 接管", 60_000);
  assert.notEqual(takeover.lease_owner, originalOwner);
  const stale = await pool.query(`
    update mn_v2.jobs set result_json = '{"stale":true}'::jsonb
    where job_id = 'job-owner-loss' and status = 'leased' and lease_owner = $1 and fencing_token = $2
  `, [originalOwner, originalFencing]);
  assert.equal(stale.rowCount, 0, "陈旧 fencing token 必须被数据库拒绝");
  const completed = await waitFor(async () => {
    const row = await job(pool, "job-owner-loss");
    return row?.status === "completed" ? row : undefined;
  }, "接管 Worker 完成任务");
  assert.equal(completed.result_json.recovered, true);
  assert.equal(Number(completed.fencing_token), originalFencing + 1);
  process.stdout.write("Worker owner 丢失后在 60 秒窗口内恢复，陈旧 fencing token 被拒绝\n");
}

await staticFixture();
if (withCompose) {
  try {
    await composeFixture();
  } finally {
    if (!keepCompose) await compose("down", "--volumes", "--remove-orphans");
  }
}
