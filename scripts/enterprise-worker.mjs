#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { writeFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AgentOsWorker, WORKER_LEASE_MILLISECONDS } from "@mn/worker";
import { PostgresStorage } from "@mn/storage";
import pg from "pg";

import { PostgresWorkerStore } from "./lib/postgres-worker-store.mjs";

const { Pool } = pg;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function lockDigest(name) {
  const value = required(name);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} 必须是 64 位小写 SHA-256`);
  return value;
}

function hmacKey() {
  const value = Buffer.from(required("MN_EVENT_HMAC_KEY"), "base64");
  if (value.byteLength < 32) throw new Error("MN_EVENT_HMAC_KEY 解码后至少需要 32 字节");
  return value;
}

if ((process.env.MN_POSTGRES_SCHEMA ?? "mn_v2") !== "mn_v2") {
  throw new Error("0.2 企业 Worker 只允许 PostgreSQL schema mn_v2");
}
if (Number(process.env.MN_JOB_LEASE_MS ?? "30000") !== WORKER_LEASE_MILLISECONDS) {
  throw new Error("Worker 租约固定为 30000 毫秒");
}
if ((process.env.MN_TELEMETRY_ENABLED ?? "false") !== "false") {
  throw new Error("0.2 默认禁止遥测；请将 MN_TELEMETRY_ENABLED 设为 false");
}

const workerId = required("MN_WORKER_INSTANCE_ID");
const pool = new Pool({
  connectionString: required("MN_POSTGRES_URL"),
  application_name: workerId,
  max: Number(process.env.MN_POSTGRES_POOL_SIZE ?? "4"),
});
const eventHmacKey = hmacKey();
const storage = new PostgresStorage({ pool, hmacKey: eventHmacKey });
await storage.initialize();
const store = new PostgresWorkerStore({ pool, hmacKey: eventHmacKey });

const localEngineLock = lockDigest("MN_ENGINE_LOCK_DIGEST");
const localPluginLock = lockDigest("MN_PLUGIN_LOCK_DIGEST");
const databaseLockResult = await pool.query(
  "select engine_digest, plugin_digest from mn_v2.runtime_locks where singleton = true",
);
const databaseLocks = databaseLockResult.rows[0];
if (!databaseLocks) throw new Error("数据库 runtime lock 缺失，Worker 拒绝 claim");
const expectedEngineLock = lockDigest("MN_EXPECTED_ENGINE_LOCK_DIGEST");
const expectedPluginLock = lockDigest("MN_EXPECTED_PLUGIN_LOCK_DIGEST");
const lock = {
  engineLockDigest: localEngineLock,
  expectedEngineLockDigest: databaseLocks ? String(databaseLocks.engine_digest) : expectedEngineLock,
  pluginLockDigest: localPluginLock,
  expectedPluginLockDigest: databaseLocks ? String(databaseLocks.plugin_digest) : expectedPluginLock,
};
if (lock.expectedEngineLockDigest !== expectedEngineLock || lock.expectedPluginLockDigest !== expectedPluginLock) {
  throw new Error("数据库 lock 与部署声明不一致，Worker 拒绝 claim");
}

const handlerModule = process.env.MN_WORKER_HANDLER_MODULE
  ?? new URL("./enterprise-worker-handlers.mjs", import.meta.url).pathname;
if (!handlerModule.startsWith("/")) throw new Error("MN_WORKER_HANDLER_MODULE 必须是绝对路径");
const loaded = await import(pathToFileURL(handlerModule).href);
const handlers = typeof loaded.createHandlers === "function"
  ? await loaded.createHandlers(Object.freeze({ pool, storage, workerId }))
  : loaded.handlers;
if (!handlers || typeof handlers !== "object") {
  throw new Error("Worker bootstrap 模块必须导出 handlers 对象或 createHandlers(context)");
}
if (process.env.MN_WORKER_FIXTURE_MODE !== "true"
  && typeof handlers["agent.execution.run"] !== "function") {
  throw new Error(
    "AGENT_EXECUTION_BOOTSTRAP_MISSING：企业 Worker 未配置 agent.execution.run 的 LLM、Scope 与审批组合",
  );
}

const worker = new AgentOsWorker({ id: workerId, store, lock, handlers });
const readiness = worker.readiness();
if (!readiness.ready) throw new Error(readiness.issues.map((issue) => issue.message).join("；"));

const readyFile = process.env.MN_WORKER_READY_FILE ?? "/tmp/mn-worker-ready";
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { stopped = true; });
}

process.stdout.write(`mn-worker ${workerId} 已就绪，lease=30000ms\n`);
const touchReadiness = () => writeFile(readyFile, new Date().toISOString(), { mode: 0o600 })
  .catch((error) => process.stderr.write(`Worker readiness 写入失败：${error.message}\n`));
await touchReadiness();
const readinessTimer = setInterval(() => { void touchReadiness(); }, 1_000);
readinessTimer.unref();
while (!stopped) {
  try {
    const result = await worker.pollOnce();
    if (result.status !== "idle") process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Worker 轮询失败"}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

clearInterval(readinessTimer);
await unlink(readyFile).catch(() => undefined);
await storage.close();
