#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { writeFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  AgentOsWorker,
  WORKER_LEASE_MILLISECONDS,
  workerHandlerReadiness,
} from "@mn/worker";
import { S3Cas } from "@mn/storage";
import { createPostgresPool } from "./lib/postgres-pool.mjs";
import { createReadinessHeartbeat, probeWorkerLocks } from "./lib/worker-readiness.mjs";

import { PostgresKernelStore } from "./lib/postgres-kernel-store.mjs";
import { PostgresWorkerStore } from "./lib/postgres-worker-store.mjs";
import { createEnterpriseWorkerStore } from "./lib/enterprise-worker-store.mjs";
import { parseWorkerSupportedKinds } from "./lib/worker-handler-capabilities.mjs";
import { VaultTransitKeyProvider, VaultModelSecretStore } from "./lib/enterprise-secrets.mjs";
import { BUSINESS_KINDS, createEnterpriseBusinessHandlers, loadEnterpriseBusinessConfiguration } from "./lib/enterprise-business.mjs";
import { configureProductProjectionJournal, createAgentOsCompositionRoot } from "../apps/host/dist/index.js";
import { SigV4S3Client } from "./lib/s3-client.mjs";

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
const configuredKinds = parseWorkerSupportedKinds(process.env.MN_WORKER_SUPPORTED_KINDS);
const fixtureMode = process.env.MN_WORKER_FIXTURE_MODE === "true";
const business = await loadEnterpriseBusinessConfiguration({ kinds: configuredKinds, fixtureMode });
const pool = createPostgresPool({
  connectionString: required("MN_POSTGRES_URL"),
  application_name: workerId,
  max: Number(process.env.MN_POSTGRES_POOL_SIZE ?? "4"),
});
const eventHmacKey = hmacKey();
const kernelStore = new PostgresKernelStore({ pool, hmacKey: eventHmacKey });
await kernelStore.initialize();
const jobStore = new PostgresWorkerStore({ pool, hmacKey: eventHmacKey });
const store = createEnterpriseWorkerStore({ kernelStore, jobStore });
let cas;
let protectedPayloadKeyProvider;
if (!fixtureMode) {
  const s3Client = new SigV4S3Client({
    endpoint: required("MN_S3_ENDPOINT"),
    region: process.env.MN_S3_REGION ?? "us-east-1",
    accessKeyId: required("MN_S3_ACCESS_KEY_ID"),
    secretAccessKey: required("MN_S3_SECRET_ACCESS_KEY"),
    ...(process.env.MN_S3_SESSION_TOKEN
      ? { sessionToken: process.env.MN_S3_SESSION_TOKEN }
      : {}),
  });
  cas = new S3Cas({
    client: s3Client,
    bucket: required("MN_S3_BUCKET"),
    prefix: process.env.MN_S3_PREFIX ?? "v2/",
  });
  protectedPayloadKeyProvider = new VaultTransitKeyProvider({
    address: required("MN_VAULT_ADDR"),
    token: required("MN_VAULT_TOKEN"),
    mount: process.env.MN_VAULT_TRANSIT_MOUNT ?? "transit",
    keyName: process.env.MN_VAULT_TRANSIT_KEY ?? "muniu-v2-protected-payloads",
    individuallyRevocable: true,
    namespace: process.env.MN_VAULT_NAMESPACE,
  });
  configureProductProjectionJournal(kernelStore, cas, protectedPayloadKeyProvider);
}

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
const composition = await createAgentOsCompositionRoot({ profile: "enterprise", store });
const loadedHandlers = typeof loaded.createHandlers === "function"
  ? await loaded.createHandlers(Object.freeze({
      pool,
      store,
      kernelStore,
      jobStore,
      workerId,
      fixtureMode,
      composition,
      ...(cas ? { cas } : {}),
      ...(protectedPayloadKeyProvider ? { protectedPayloadKeyProvider } : {}),
    }))
  : loaded.handlers;
if (!loadedHandlers || typeof loadedHandlers !== "object") {
  throw new Error("Worker bootstrap 模块必须导出 handlers 对象或 createHandlers(context)");
}
if (business && BUSINESS_KINDS.some(kind => kind in loadedHandlers)) {
  throw new Error("工业任务只能由企业受信组合处理器负责");
}
const businessHandlers = createEnterpriseBusinessHandlers(business, {
  store, composition, cas, protectedPayloadKeyProvider, fixtureMode,
  ...(business ? { secretStore: new VaultModelSecretStore({
    address: required("MN_VAULT_ADDR"), token: required("MN_VAULT_TOKEN"),
    mount: process.env.MN_VAULT_KV_MOUNT ?? "secret", namespace: process.env.MN_VAULT_NAMESPACE,
  }) } : {}),
});
const handlers = Object.freeze({ ...loadedHandlers, ...businessHandlers });
const handlerReadiness = workerHandlerReadiness(
  handlers,
  business ? [...(loaded.supportedKinds ?? []), ...BUSINESS_KINDS] : loaded.supportedKinds,
  configuredKinds,
);
if (!handlerReadiness.ready) {
  throw new Error(handlerReadiness.issues
    .map((issue) => `${issue.code}：${issue.message}`)
    .join("；"));
}
const supportedKinds = handlerReadiness.supportedKinds;
if (process.env.MN_WORKER_FIXTURE_MODE !== "true"
  && typeof handlers["agent.execution.run"] !== "function") {
  throw new Error(
    "AGENT_EXECUTION_BOOTSTRAP_MISSING：企业 Worker 未配置 agent.execution.run 的 LLM、Scope 与审批组合",
  );
}

const worker = new AgentOsWorker({ id: workerId, store, lock, handlers, kinds: supportedKinds });
const readiness = worker.readiness();
if (!readiness.ready) throw new Error(readiness.issues.map((issue) => issue.message).join("；"));

const readyFile = process.env.MN_WORKER_READY_FILE ?? "/tmp/mn-worker-ready";
let stopped = false;
const stopController = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { stopped = true; stopController.abort(); });
}

const heartbeat = createReadinessHeartbeat({
  check: async () => worker.readiness().ready
    && (!protectedPayloadKeyProvider || await protectedPayloadKeyProvider.probe())
    && await probeWorkerLocks(pool, { engine: localEngineLock, plugin: localPluginLock }),
  publish: () => writeFile(readyFile, new Date().toISOString(), { mode: 0o600 }),
  remove: () => unlink(readyFile).catch(error => { if (error.code !== "ENOENT") throw error; }),
});
await heartbeat.tick();
process.stdout.write(`mn-worker ${workerId} 已启动，lease=30000ms\n`);
const readinessTimer = setInterval(() => { void heartbeat.tick(); }, 1_000);
readinessTimer.unref();
while (!stopped) {
  try {
    const result = await worker.pollOnce(stopController.signal);
    if (result.status !== "idle") process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Worker 轮询失败；未确认的执行结果不会自动重放\n");
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

clearInterval(readinessTimer);
await heartbeat.stop();
await composition.context.fiber.dispose();
await kernelStore.close();
