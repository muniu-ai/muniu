#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

async function token(jwksUrl, tenantId, principalId) {
  const endpoint = new URL("/token", jwksUrl);
  endpoint.searchParams.set("tenant", tenantId);
  endpoint.searchParams.set("sub", principalId);
  endpoint.searchParams.set("role", "owner");
  const response = await fetch(endpoint, { method: "POST" });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text).access_token;
}

async function request(baseUrl, accessToken, method, path, body, key) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, text, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined };
}

export async function seedHostFlow({
  hostA = "http://127.0.0.1:17318",
  hostB = "http://127.0.0.1:17319",
  jwks = "http://127.0.0.1:59080",
  tenantId = "tenant-enterprise-e2e",
  principalId = "owner@example.test",
} = {}) {
  const accessToken = await token(jwks, tenantId, principalId);
  for (const host of [hostA, hostB]) {
    const health = await request(host, accessToken, "GET", "/v2/health");
    assert.equal(health.response.status, 200, health.text);
    assert.equal(health.body.data.core.status, "healthy");
    const readiness = await request(host, accessToken, "GET", "/v2/readiness");
    assert.equal(readiness.response.status, 200, readiness.text);
    assert.equal(readiness.body.data.ready, true);
  }
  const legacy = await request(hostA, accessToken, "GET", "/v1");
  assert.equal(legacy.response.status, 404, "旧控制面必须返回 404");

  const createBody = { name: "企业故障恢复", viewMode: "professional", pluginIds: ["opc", "coding"] };
  const created = await request(hostA, accessToken, "POST", "/v2/workspaces", createBody, "workspace-rpo0");
  assert.equal(created.response.status, 201, created.text);
  const replayed = await request(hostB, accessToken, "POST", "/v2/workspaces", createBody, "workspace-rpo0");
  assert.equal(replayed.response.status, 201, replayed.text);
  assert.equal(replayed.body.data.id, created.body.data.id, "跨 Host 幂等重放必须返回相同对象");

  const conflict = await request(hostB, accessToken, "PATCH", `/v2/workspaces/${created.body.data.id}`, {
    name: "错误并发写入",
    expectedStreamVersion: 0,
  }, "workspace-version-conflict");
  assert.equal(conflict.response.status, 409, conflict.text);
  assert.equal(conflict.body.code, "STREAM_VERSION_CONFLICT");

  const installations = await request(hostB, accessToken, "GET", "/v2/plugins/installations");
  assert.equal(installations.response.status, 200, installations.text);
  assert.deepEqual(installations.body.data.map((plugin) => plugin.pluginId).sort(), ["coding", "opc"]);

  const events = await request(
    hostB,
    accessToken,
    "GET",
    `/v2/workspaces/${created.body.data.id}/events?after=0`,
  );
  assert.equal(events.response.status, 200, events.text);
  assert.match(events.text, /event: kernel/u);
  const cursor = Number([...events.text.matchAll(/^id: (\d+)$/gmu)].at(-1)?.[1]);
  assert.ok(Number.isSafeInteger(cursor) && cursor > 0);
  return { accessToken, tenantId, workspaceId: created.body.data.id, cursor, hostA, hostB };
}

export async function verifyCommittedEvent(state) {
  const listed = await request(state.hostB, state.accessToken, "GET", "/v2/workspaces");
  assert.equal(listed.response.status, 200, listed.text);
  assert.ok(listed.body.data.some((workspace) => workspace.id === state.workspaceId));
  const events = await request(
    state.hostB,
    state.accessToken,
    "GET",
    `/v2/workspaces/${state.workspaceId}/events?after=0`,
  );
  assert.equal(events.response.status, 200, events.text);
  assert.match(events.text, new RegExp(`id: ${state.cursor}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = await seedHostFlow();
  process.stdout.write(`${JSON.stringify({ ...state, accessToken: "[redacted]" })}\n`);
}
