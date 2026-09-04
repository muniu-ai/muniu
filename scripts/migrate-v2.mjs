#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import pg from "pg";

import { PostgresKernelStore } from "./lib/postgres-kernel-store.mjs";

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

if ((process.env.MN_POSTGRES_SCHEMA ?? "mn_v2") !== "mn_v2") {
  throw new Error("0.2 数据库迁移只允许 schema mn_v2");
}
const key = Buffer.from(required("MN_EVENT_HMAC_KEY"), "base64");
if (key.byteLength < 32) throw new Error("MN_EVENT_HMAC_KEY 解码后至少需要 32 字节");

const pool = new Pool({ connectionString: required("MN_POSTGRES_URL"), application_name: "mn-v2-migrate" });
const store = new PostgresKernelStore({ pool, hmacKey: key });
try {
  await store.initialize();
  await store.setRuntimeLocks(lockDigest("MN_ENGINE_LOCK_DIGEST"), lockDigest("MN_PLUGIN_LOCK_DIGEST"));
  const locks = await store.runtimeLocks();
  if (locks?.engineLockDigest !== process.env.MN_ENGINE_LOCK_DIGEST
    || locks?.pluginLockDigest !== process.env.MN_PLUGIN_LOCK_DIGEST) {
    throw new Error("数据库已有不同的 engine/plugin lock；禁止混合版本迁移");
  }
  process.stdout.write("mn_v2 schema 已就绪\n");
} finally {
  await store.close();
}
