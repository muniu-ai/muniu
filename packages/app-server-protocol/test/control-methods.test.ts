// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MUNIU_CONTROL_OPERATIONS,
  MUNIU_METHODS,
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
