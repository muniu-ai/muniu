#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import pg from "pg";
import { S3Cas } from "@mn/storage";
import { SigV4S3Client } from "./lib/s3-client.mjs";
import { VaultTransitKeyProvider } from "./lib/enterprise-secrets.mjs";
import { maintainPostgres } from "./lib/postgres-maintenance.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

let client;
let adminClient;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("用法：npm run maintenance:enterprise -- verify|rebuild|gc|upgrade-core-protection --offline --database DATABASE\n必须先停止所有共用数据库与 CAS 的 Host/Worker；失败后数据库保持离线。升级前保存数据库、CAS 和密钥备份；升级不改写历史事件。gc 使用 MN_CAS_ORPHAN_RETENTION_DAYS（默认 7 天）。\n");
  } else {
    if (args.length !== 4 || !["verify", "rebuild", "gc", "upgrade-core-protection"].includes(args[0]) || args[1] !== "--offline" || args[2] !== "--database") {
      throw new Error("维护参数无效；使用 --help 查看用法");
    }
    const hmacKey = Buffer.from(required("MN_EVENT_HMAC_KEY"), "base64");
    if (hmacKey.byteLength < 32) throw new Error("事件 HMAC 密钥无效");
    const cas = new S3Cas({ bucket: required("MN_S3_BUCKET"), prefix: process.env.MN_S3_PREFIX ?? "v2/",
      client: new SigV4S3Client({ endpoint: required("MN_S3_ENDPOINT"), region: process.env.MN_S3_REGION ?? "us-east-1",
        accessKeyId: required("MN_S3_ACCESS_KEY_ID"), secretAccessKey: required("MN_S3_SECRET_ACCESS_KEY"),
        sessionToken: process.env.MN_S3_SESSION_TOKEN }) });
    const keyProvider = new VaultTransitKeyProvider({ address: required("MN_VAULT_ADDR"), token: required("MN_VAULT_TOKEN"),
      mount: process.env.MN_VAULT_TRANSIT_MOUNT ?? "transit", keyName: process.env.MN_VAULT_TRANSIT_KEY ?? "muniu-v2-protected-payloads",
      individuallyRevocable: true, namespace: process.env.MN_VAULT_NAMESPACE });
    const actorId = required("MN_MAINTENANCE_ACTOR");
    if (!await keyProvider.probe()) throw new Error("KMS 不可用");
    client = new pg.Client({ connectionString: required("MN_POSTGRES_URL"), application_name: "mn-v2-maintenance",
      connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
    client.on("error", () => { process.stderr.write("维护数据库连接丢失；数据库可能保持离线，请人工核对。\n"); process.exit(1); });
    await client.connect();
    const controlUrl = new URL(required("MN_POSTGRES_URL"));
    controlUrl.pathname = "/postgres";
    adminClient = new pg.Client({ connectionString: controlUrl.href, application_name: "mn-v2-maintenance-control",
      connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
    adminClient.on("error", () => { process.stderr.write("维护管理连接丢失；请核对数据库离线状态。\n"); process.exit(1); });
    await adminClient.connect();
    const result = await maintainPostgres({ client, adminClient, database: args[3], offlineConfirmed: true, operation: args[0],
      actorId, hmacKey, cas, keyProvider, retentionDays: Number(process.env.MN_CAS_ORPHAN_RETENTION_DAYS ?? 7) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch {
  // Database and service errors can contain credentials or protected payloads.
  process.stderr.write("企业维护未完成。请核对停机状态、目标数据库、配置和权限；维护开始后失败的数据库保持离线，不要自动重试。\n");
  process.exitCode = 1;
} finally { await Promise.all([client?.end().catch(() => undefined), adminClient?.end().catch(() => undefined)]); }
