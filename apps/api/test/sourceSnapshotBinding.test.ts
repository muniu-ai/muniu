import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sourceSnapshotRefFromPayload } from "../src/sourceSnapshotBinding.js";

test("source snapshot queue binding accepts one exact Run-scoped CAS reference", () => {
  const digest = "a".repeat(64);
  const scope = { tenantId: "tenant-a", projectId: "project-a", runId: "run-a" };
  const scopePath = [scope.tenantId, scope.projectId, scope.runId]
    .map((value) => createHash("sha256").update(value).digest("hex").slice(0, 24))
    .join("/");
  const ref = {
    schemaVersion: 1,
    objectKey: `cas/v1/${scopePath}/aa/${digest}`,
    digest,
    byteLength: 42,
    contentType: "application/vnd.muniu.workspace-snapshot.v1+json"
  };
  const payload = {
    version: 2,
    executionContext: {
      schemaVersion: 2,
      bindings: scope,
      sourceSnapshot: ref
    }
  };
  assert.deepEqual(sourceSnapshotRefFromPayload(payload, scope), ref);
  assert.throws(
    () => sourceSnapshotRefFromPayload(payload, { ...scope, runId: "run-b" }),
    /scope binding/u
  );
  assert.throws(
    () => sourceSnapshotRefFromPayload({
      ...payload,
      executionContext: {
        ...payload.executionContext,
        sourceSnapshot: {
          ...ref,
          objectKey: `cas/v1/${"1".repeat(24)}/${"2".repeat(24)}/${"3".repeat(24)}/aa/${"b".repeat(64)}`
        }
      }
    }, scope),
    /reference is invalid/u
  );
  assert.throws(
    () => sourceSnapshotRefFromPayload({
      ...payload,
      executionContext: {
        ...payload.executionContext,
        sourceSnapshot: {
          ...ref,
          objectKey: `cas/v1/${"1".repeat(24)}/${"2".repeat(24)}/${"3".repeat(24)}/aa/${digest}`
        }
      }
    }, scope),
    /reference is invalid/u
  );
});
