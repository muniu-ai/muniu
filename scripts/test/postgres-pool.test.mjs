// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPostgresPool } from "../lib/postgres-pool.mjs";

test("PostgreSQL idle disconnect is handled without logging the error or client secrets", () => {
  class Pool extends EventEmitter { constructor(options) { super(); this.options = options; } }
  const logs = [];
  const pool = createPostgresPool({ application_name: "host-a", max: 4 }, { Pool, log: line => logs.push(line) });
  assert.equal(pool.options.connectionTimeoutMillis, 5000);
  assert.equal(pool.options.max, 4);
  assert.doesNotThrow(() => pool.emit("error", new Error("postgresql://user:private-password@db"),
    { password: "private-password", secretKey: "backend-key" }));
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).code, "POSTGRES_IDLE_CONNECTION_LOST");
  assert.doesNotMatch(logs[0], /private-password|backend-key|postgresql:/);
});
