// SPDX-License-Identifier: Apache-2.0
import pg from "pg";

export function createPostgresPool(options, { Pool = pg.Pool, log = line => process.stderr.write(line) } = {}) {
  const pool = new Pool({ connectionTimeoutMillis: 5000, ...options });
  // pg removes the failed idle client itself; never print its credential-bearing error context.
  pool.on("error", () => log(`${JSON.stringify({ code: "POSTGRES_IDLE_CONNECTION_LOST",
    message: "PostgreSQL 空闲连接已断开，后续请求将重新建立连接" })}\n`));
  return pool;
}
