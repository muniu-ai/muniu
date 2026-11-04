// SPDX-License-Identifier: Apache-2.0
import pg from "pg";

export function createPostgresPool(options, { Pool = pg.Pool, log = line => process.stderr.write(line) } = {}) {
  // A lost Pod may leave a half-open TCP session holding the tenant lock.
  // Release its uncommitted transaction before the 30-second Job lease expires.
  const pool = new Pool({ connectionTimeoutMillis: 5000, ...options,
    idle_in_transaction_session_timeout: 20000 });
  const watched = new WeakSet(), reported = new WeakSet();
  const report = (client, code) => {
    if (client && reported.has(client)) return;
    if (client) reported.add(client);
    log(`${JSON.stringify({ code, message: "PostgreSQL 连接已断开，后续请求将重新建立连接" })}\n`);
  };
  // pg rejects pending queries and discards broken clients. Handle its separate
  // Client error event as well, without retrying an unknown transaction result.
  pool.on("connect", client => {
    if (watched.has(client)) return;
    watched.add(client);
    client.on("error", () => report(client, "POSTGRES_CONNECTION_LOST"));
  });
  pool.on("error", (_error, client) => report(client, "POSTGRES_IDLE_CONNECTION_LOST"));
  return pool;
}
