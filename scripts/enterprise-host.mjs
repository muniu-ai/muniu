#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  createAgentOsHost,
  createEnterpriseFilePluginRepository,
  enterpriseReadiness,
} from "@mn/host";
import { S3Cas } from "@mn/storage";
import { createPostgresPool } from "./lib/postgres-pool.mjs";

import { PostgresKernelStore, probePostgres } from "./lib/postgres-kernel-store.mjs";
import {
  UnavailableEnterpriseKeyProvider,
  UnavailableEnterpriseSecretStore,
  VaultModelSecretStore,
  VaultTransitKeyProvider,
} from "./lib/enterprise-secrets.mjs";
import { OidcIdentityResolver } from "./lib/oidc-identity.mjs";
import { SigV4S3Client } from "./lib/s3-client.mjs";
import { parseWorkerSupportedKinds } from "./lib/worker-handler-capabilities.mjs";
import { loadEnterpriseBusinessConfiguration } from "./lib/enterprise-business.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function positiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

function boolean(name) {
  const value = required(name);
  if (value !== "true" && value !== "false") throw new Error(`${name} 必须是 true 或 false`);
  return value === "true";
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

function assertV2Configuration() {
  if ((process.env.MN_POSTGRES_SCHEMA ?? "mn_v2") !== "mn_v2") {
    throw new Error("0.2 企业 Host 只允许 PostgreSQL schema mn_v2");
  }
  const prefix = process.env.MN_S3_PREFIX ?? "v2/";
  if (prefix !== "v2/" && !prefix.startsWith("v2/")) {
    throw new Error("0.2 企业 Host 的 S3 前缀必须位于 v2/");
  }
  if ((process.env.MN_TELEMETRY_ENABLED ?? "false") !== "false") {
    throw new Error("0.2 默认禁止遥测；请将 MN_TELEMETRY_ENABLED 设为 false");
  }
}

assertV2Configuration();
const configuredWorkerSupportedKinds = parseWorkerSupportedKinds(process.env.MN_WORKER_SUPPORTED_KINDS);
const workerEnabled = boolean("MN_WORKER_ENABLED");
const business = await loadEnterpriseBusinessConfiguration({
  kinds: configuredWorkerSupportedKinds, workerEnabled, fixtureMode: process.env.MN_WORKER_FIXTURE_MODE === "true",
});

const pool = createPostgresPool({
  connectionString: required("MN_POSTGRES_URL"),
  application_name: process.env.MN_HOST_INSTANCE_ID ?? "mn-host",
  max: Number(process.env.MN_POSTGRES_POOL_SIZE ?? "10"),
});
const store = new PostgresKernelStore({ pool, hmacKey: hmacKey() });
await store.initialize();

const engineLockDigest = lockDigest("MN_ENGINE_LOCK_DIGEST");
const pluginLockDigest = lockDigest("MN_PLUGIN_LOCK_DIGEST");
const expectedEngineLockDigest = lockDigest("MN_EXPECTED_ENGINE_LOCK_DIGEST");
const expectedPluginLockDigest = lockDigest("MN_EXPECTED_PLUGIN_LOCK_DIGEST");
await store.setRuntimeLocks(engineLockDigest, pluginLockDigest);

const s3Client = new SigV4S3Client({
  endpoint: required("MN_S3_ENDPOINT"),
  region: process.env.MN_S3_REGION ?? "us-east-1",
  accessKeyId: required("MN_S3_ACCESS_KEY_ID"),
  secretAccessKey: required("MN_S3_SECRET_ACCESS_KEY"),
  ...(process.env.MN_S3_SESSION_TOKEN ? { sessionToken: process.env.MN_S3_SESSION_TOKEN } : {}),
});
const bucket = required("MN_S3_BUCKET");
const s3Prefix = process.env.MN_S3_PREFIX ?? "v2/";
const cas = new S3Cas({ client: s3Client, bucket, prefix: s3Prefix });
const vaultConfigured = Boolean(process.env.MN_VAULT_ADDR && process.env.MN_VAULT_TOKEN);
const secretStore = vaultConfigured
  ? new VaultModelSecretStore({
      address: process.env.MN_VAULT_ADDR,
      token: process.env.MN_VAULT_TOKEN,
      mount: process.env.MN_VAULT_KV_MOUNT ?? "secret",
      namespace: process.env.MN_VAULT_NAMESPACE,
    })
  : new UnavailableEnterpriseSecretStore();
const protectedPayloadKeyProvider = vaultConfigured
  ? new VaultTransitKeyProvider({
      address: process.env.MN_VAULT_ADDR,
      token: process.env.MN_VAULT_TOKEN,
      mount: process.env.MN_VAULT_TRANSIT_MOUNT ?? "transit",
      keyName: process.env.MN_VAULT_TRANSIT_KEY ?? "muniu-v2-protected-payloads",
      individuallyRevocable: true,
      namespace: process.env.MN_VAULT_NAMESPACE,
    })
  : new UnavailableEnterpriseKeyProvider();

const pluginRepositoryIndex = process.env.MN_PLUGIN_REPOSITORY_INDEX?.trim();
const pluginTrustedRoots = process.env.MN_PLUGIN_TRUSTED_ROOTS?.trim();
const pluginRepositoryDigest = process.env.MN_PLUGIN_REPOSITORY_DIGEST?.trim();
if (Boolean(pluginRepositoryIndex) !== Boolean(pluginTrustedRoots)
  || Boolean(pluginRepositoryIndex) !== Boolean(pluginRepositoryDigest)) {
  throw new Error(
    "MN_PLUGIN_REPOSITORY_INDEX、MN_PLUGIN_TRUSTED_ROOTS 与 MN_PLUGIN_REPOSITORY_DIGEST 必须同时配置",
  );
}
const enterprisePlugins = pluginRepositoryIndex
  ? await createEnterpriseFilePluginRepository({
      indexFile: pluginRepositoryIndex,
      trustedRootsFile: pluginTrustedRoots,
    })
  : undefined;
if (enterprisePlugins && enterprisePlugins.repositoryDigest !== pluginRepositoryDigest) {
  throw new Error("企业插件仓库摘要与 MN_PLUGIN_REPOSITORY_DIGEST 不一致");
}

const retention = {
  businessDays: positiveInteger("MN_RETENTION_BUSINESS_DAYS"),
  executionDays: positiveInteger("MN_RETENTION_EXECUTION_DAYS"),
  deliverableDays: positiveInteger("MN_RETENTION_DELIVERABLE_DAYS"),
  auditDays: positiveInteger("MN_RETENTION_AUDIT_DAYS"),
};
const trustedWorkerSupportedKinds = workerEnabled
  ? configuredWorkerSupportedKinds
  : [];
const oidc = new OidcIdentityResolver({
  issuer: required("MN_OIDC_ISSUER"),
  audience: required("MN_OIDC_AUDIENCE"),
  jwksUrl: required("MN_OIDC_JWKS_URL"),
});

const readiness = async () => {
  const [postgresReady, s3Ready, databaseLocks, kmsReady] = await Promise.all([
    probePostgres(pool),
    s3Client.probe(bucket),
    store.runtimeLocks().catch(() => undefined),
    protectedPayloadKeyProvider.probe(),
  ]);
  const result = enterpriseReadiness({
    retention,
    engineLockDigest,
    workerEngineLockDigest: expectedEngineLockDigest,
    pluginLockDigest,
    workerPluginLockDigest: expectedPluginLockDigest,
    postgresReady,
    s3Ready,
  });
  const issues = [...result.issues];
  if (!kmsReady) {
    issues.push({ code: "KMS_UNAVAILABLE", message: "Vault/KMS 未配置、不可用或密钥权限不足",
      action: "检查 Vault Transit 配置、连接和令牌权限后重试" });
  }
  if (databaseLocks?.engineLockDigest !== engineLockDigest) {
    issues.push({
      code: "DATABASE_ENGINE_LOCK_MISMATCH",
      message: "数据库中的 engine lock 与当前 Host 不一致",
      action: "完成蓝绿切换或使用相同发布物重新部署",
    });
  }
  if (databaseLocks?.pluginLockDigest !== pluginLockDigest) {
    issues.push({
      code: "DATABASE_PLUGIN_LOCK_MISMATCH",
      message: "数据库中的 plugin lock 与当前 Host 不一致",
      action: "排空 execution 并完成插件投影切换",
    });
  }
  return { ready: issues.length === 0, issues };
};

const host = await createAgentOsHost({
  profile: "enterprise",
  store,
  cas,
  secretStore,
  protectedPayloadKeyProvider,
  ...business,
  ...(enterprisePlugins ? {
    pluginRepository: enterprisePlugins.pluginRepository,
    trustedPluginRoots: enterprisePlugins.trustedPluginRoots,
  } : {}),
  readiness,
  trustedWorkerSupportedKinds,
  identityResolver: (request) => oidc.resolve(request),
});
const address = await host.listen({
  host: process.env.MN_HOST_BIND ?? "0.0.0.0",
  port: Number(process.env.MN_HOST_PORT ?? "7318"),
});
const releaseFingerprint = createHash("sha256")
  .update(`${engineLockDigest}:${pluginLockDigest}`)
  .digest("hex")
  .slice(0, 12);
process.stdout.write(`mn-host ${address.host}:${address.port} 已就绪，release=${releaseFingerprint}\n`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  process.stdout.write(`mn-host 收到 ${signal}，停止接收新请求\n`);
  await host.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0), (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Host 关闭失败"}\n`);
      process.exit(1);
    });
  });
}
