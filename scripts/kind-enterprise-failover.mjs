#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { seedHostFlow, verifyCommittedEvent } from "./enterprise-host-flow.mjs";
import { SigV4S3Client } from "./lib/s3-client.mjs";

const namespace = process.env.MN_KIND_NAMESPACE ?? "muniu-kind";
const release = process.env.MN_KIND_RELEASE ?? "muniu";
const forwards = [];

function run(args, { capture = true } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("kubectl", ["--namespace", namespace, ...args], {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else rejectRun(new Error(`kubectl ${args.join(" ")} 失败：${stderr.trim() || code}`));
    });
  });
}

function portForward(resource, mapping) {
  const child = spawn("kubectl", ["--namespace", namespace, "port-forward", resource, mapping], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  forwards.push(child);
  return { child, diagnostics: () => diagnostics };
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

async function waitHttp(url, forward) {
  await waitFor(async () => {
    if (forward.child.exitCode !== null) throw new Error(forward.diagnostics());
    const response = await fetch(url).catch(() => undefined);
    return response?.ok;
  }, url);
}

async function psql(sql) {
  return run([
    "exec", "deployment/muniu-kind-postgres", "--",
    "psql", "--username", "mn", "--dbname", "muniu", "--tuples-only", "--no-align", "--command", sql,
  ]);
}

async function job(id) {
  const output = await psql(`select row_to_json(value)::text from (select * from mn_v2.jobs where job_id='${id}') value;`);
  return output ? JSON.parse(output.split("\n").at(-1)) : undefined;
}

function stopForwards() {
  for (const child of forwards) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

process.once("SIGINT", () => { stopForwards(); process.exit(130); });
process.once("SIGTERM", () => { stopForwards(); process.exit(143); });

try {
  const hostPods = JSON.parse(await run([
    "get", "pods",
    "--selector", `app.kubernetes.io/instance=${release},app.kubernetes.io/component=host`,
    "--output", "json",
  ])).items.map((item) => item.metadata.name).sort();
  assert.equal(hostPods.length, 2, "Kind 必须运行两个 Host");
  const workerPods = JSON.parse(await run([
    "get", "pods",
    "--selector", `app.kubernetes.io/instance=${release},app.kubernetes.io/component=worker`,
    "--output", "json",
  ])).items.map((item) => item.metadata.name).sort();
  assert.equal(workerPods.length, 2, "Kind 必须运行两个 Worker");

  const hostAForward = portForward(`pod/${hostPods[0]}`, "27318:7318");
  const hostBForward = portForward(`pod/${hostPods[1]}`, "27319:7318");
  const fixtureForward = portForward("service/muniu-kind-fixture", "28080:8080");
  const s3Forward = portForward("service/muniu-kind-minio", "29000:9000");
  await Promise.all([
    waitHttp("http://127.0.0.1:27318/v2/health", hostAForward),
    waitHttp("http://127.0.0.1:27319/v2/health", hostBForward),
    waitHttp("http://127.0.0.1:28080/health", fixtureForward),
    waitHttp("http://127.0.0.1:29000/minio/health/live", s3Forward),
  ]);

  const state = await seedHostFlow({
    hostA: "http://127.0.0.1:27318",
    hostB: "http://127.0.0.1:27319",
    jwks: "http://127.0.0.1:28080",
    tenantId: "tenant-kind-v2",
    principalId: "kind-owner@example.test",
  });
  await run(["delete", "pod", hostPods[0], "--wait=false"], { capture: false });
  await verifyCommittedEvent(state);
  process.stdout.write("Kind Host owner 丢失后，已提交事件 RPO 0\n");

  const s3 = new SigV4S3Client({
    endpoint: "http://127.0.0.1:29000",
    region: "us-east-1",
    accessKeyId: "mn-kind",
    secretAccessKey: "mn-kind-secret-only",
  });
  const content = Buffer.from("kind-v2-cas");
  const contentDigest = createHash("sha256").update(content).digest("hex");
  const objectKey = `v2/kind-failover/sha256/${contentDigest}`;
  assert.equal(await s3.putObject({
    bucket: "muniu-kind-v2",
    key: objectKey,
    body: content,
    ifNoneMatch: "*",
    checksumSha256: Buffer.from(contentDigest, "hex").toString("base64"),
  }), true);
  assert.deepEqual(Buffer.from(await s3.getObject({ bucket: "muniu-kind-v2", key: objectKey })), content);

  await psql(`
    insert into mn_v2.jobs (
      job_id,tenant_id,kind,payload_json,status,attempts,available_at,fencing_token,
      idempotency_key,created_at,updated_at
    ) values (
      'kind-owner-loss','tenant-kind-v2','fixture.wait',
      '{"delayMs":60000,"recoveryDelayMs":3000}'::jsonb,'available',0,now(),0,
      'kind-owner-loss',now(),now()
    );
  `);
  const initial = await waitFor(async () => {
    const value = await job("kind-owner-loss");
    return value?.status === "leased" ? value : undefined;
  }, "Kind Worker 首次 claim");
  const originalOwner = initial.lease_owner;
  const originalFencing = Number(initial.fencing_token);
  assert.ok(workerPods.includes(originalOwner));
  await run(["delete", "pod", originalOwner, "--grace-period=0", "--force", "--wait=false"], { capture: false });
  const takeover = await waitFor(async () => {
    const value = await job("kind-owner-loss");
    return value?.status === "leased" && Number(value.fencing_token) > originalFencing ? value : undefined;
  }, "30 秒租约过期后的 Kind Worker 接管", 60_000);
  assert.notEqual(takeover.lease_owner, originalOwner);
  const stale = await psql(`
    update mn_v2.jobs set result_json='{"stale":true}'::jsonb
    where job_id='kind-owner-loss' and status='leased'
      and lease_owner='${originalOwner}' and fencing_token=${originalFencing};
  `);
  assert.match(stale, /UPDATE 0/u, "数据库必须拒绝陈旧 fencing token");
  const completed = await waitFor(async () => {
    const value = await job("kind-owner-loss");
    return value?.status === "completed" ? value : undefined;
  }, "Kind Worker 接管完成");
  assert.equal(completed.result_json.recovered, true);

  const postgresPod = (await run([
    "get", "pods", "--selector", "app=muniu-kind-postgres", "--output", "jsonpath={.items[0].metadata.name}",
  ])).trim();
  await run(["delete", "pod", postgresPod, "--wait=false"], { capture: false });
  await run(["rollout", "status", "deployment/muniu-kind-postgres", "--timeout=180s"], { capture: false });
  await waitFor(async () => {
    const response = await fetch("http://127.0.0.1:27319/v2/readiness").catch(() => undefined);
    return response?.ok;
  }, "PostgreSQL 重启后的 Host readiness", 180_000);
  await verifyCommittedEvent(state);
  process.stdout.write("Kind PostgreSQL 重启后，已提交事件保持 RPO 0\n");

  process.stdout.write(JSON.stringify({
    kindEnterpriseV2: "passed",
    schema: "mn_v2",
    hosts: 2,
    workers: 2,
    leaseMilliseconds: 30000,
    fencing: "stale-rejected",
    rpo: 0,
    s3Prefix: "v2/",
  }) + "\n");
} finally {
  stopForwards();
}
