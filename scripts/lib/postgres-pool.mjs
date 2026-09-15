// SPDX-License-Identifier: Apache-2.0
import pg from "pg";

export function createPostgresPool(options, { Pool = pg.Pool, log = line => process.stderr.write(line) } = {}) {
  // A lost Pod may leave a half-open TCP session holding the tenant lock.
  // Release its uncommitted transaction before the 30-second Job lease expires.
  const pool = new Pool({ connectionTimeoutMillis: 5000, ...options,
    idle_in_transaction_session_timeout: 20000 });
  // pg removes the failed idle client itself; never print its credential-bearing error context.
  pool.on("error", () => log(`${JSON.stringify({ code: "POSTGRES_IDLE_CONNECTION_LOST",
    message: "PostgreSQL 空闲连接已断开，后续请求将重新建立连接" })}\n`));
  return pool;
}
