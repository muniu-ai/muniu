// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildServer } from "../src/server.js";

test("v0.2 production surface rejects legacy control REST while retaining health", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-cutover-"));
  const app = buildServer({
    logger: false,
    mniuRoot: root,
    useMockExecutors: true,
    legacyControlApi: false
  });
  t.after(() => app.close());

  const legacy = await app.inject({ method: "GET", url: "/v1/capabilities" });
  assert.equal(legacy.statusCode, 426);
  assert.deepEqual(legacy.json(), {
    error: "app-server protocol v2 is required",
    protocolVersion: "2",
    appServerPath: "local connection metadata"
  });

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);

  const content = await app.inject({
    method: "GET",
    url: "/v1/runs/missing/artifacts/archive"
  });
  assert.equal(content.statusCode, 404);
});

test("v0.2 removes the legacy SSE routes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-sse-cutover-"));
  const app = buildServer({
    logger: false,
    mniuRoot: root,
    useMockExecutors: true,
    legacyControlApi: true
  });
  t.after(() => app.close());

  assert.equal((await app.inject({
    method: "GET",
    url: "/v1/agent-sessions/missing/events"
  })).statusCode, 404);
  assert.equal((await app.inject({
    method: "GET",
    url: "/v1/runs/missing/events/stream"
  })).statusCode, 404);
});
