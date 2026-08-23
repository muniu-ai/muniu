// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MUNIU_CONTROL_OPERATIONS,
  MUNIU_METHODS,
  controlRequestForHttp,
  controlOperationForMethod,
  parseClientRequest
} from "../src/index.js";

test("maps every legacy control operation to one unique namespaced RPC method", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../../schema/legacy-openapi-operations.json", import.meta.url),
    "utf8"
  )) as Array<{ operationId: string }>;
  assert.equal(fixture.length, 150);
  assert.equal(MUNIU_CONTROL_OPERATIONS.length, fixture.length);
  assert.equal(new Set(MUNIU_METHODS).size, fixture.length);
  assert.deepEqual(
    MUNIU_CONTROL_OPERATIONS.map((entry) => entry.operationId),
    fixture.map((entry) => entry.operationId)
  );
  assert.ok(MUNIU_METHODS.every((method) => /^muniu\/(?:project|task|run|runJob|evidence|artifact|provider|modelCatalog|policy|approval|extension|skillRegistry|config|diagnostics)\//u.test(method)));
});

test("resolves legacy HTTP paths to typed control RPC calls without static-route shadowing", () => {
  assert.deepEqual(controlRequestForHttp("GET", "/v1/providers/export?app=codex"), {
    method: "muniu/provider/providers/export/get",
    params: { query: { app: "codex" } }
  });
  assert.deepEqual(controlRequestForHttp(
    "POST",
    "/v1/agent-sessions/session%2D1/approvals/approval%2D1",
    { decision: "accept" },
    "request-1"
  ), {
    method: "muniu/approval/agentSessions/byId/approvals/byApprovalId/post",
    params: {
      path: { id: "session-1", approvalId: "approval-1" },
      body: { decision: "accept" },
      idempotencyKey: "request-1"
    }
  });
  assert.deepEqual(controlRequestForHttp(
    "POST",
    "/v1/artifacts/store/cleanup",
    { keepLatestRuns: 1, maxAgeDays: undefined, nested: { omitted: undefined } }
  ), {
    method: "muniu/artifact/artifacts/store/cleanup/post",
    params: { body: { keepLatestRuns: 1, nested: {} } }
  });
  assert.throws(() => controlRequestForHttp("GET", "/healthz"), /control operation/iu);
  assert.throws(() => controlRequestForHttp("GET", "/v1/providers/%E0%A4%A"), /encoded/iu);
});

test("parses strict control envelopes and retains the old operation identity", () => {
  const request = parseClientRequest({
    id: "control-1",
    method: "muniu/run/runs/byId/resume/post",
    params: {
      path: { id: "run-1" },
      body: { dryRun: true },
      idempotencyKey: "resume-1"
    }
  });
  assert.equal(request.method, "muniu/run/runs/byId/resume/post");
  assert.equal(controlOperationForMethod(request.method)?.operationId, "post__v1_runs_id_resume");
  assert.throws(() => parseClientRequest({
    id: "control-2",
    method: "muniu/run/runs/byId/resume/post",
    params: { body: {}, experimental: true }
  }));
});
