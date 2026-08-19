// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { RunScopedCasObjectRef } from "./runScopedCas.js";

const CONTENT_TYPE = "application/vnd.muniu.workspace-snapshot.v1+json";
const OBJECT_KEY = /^(?:[a-f0-9]{24}\/)?cas\/v1\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{2}\/[a-f0-9]{64}$/u;

export interface SourceSnapshotScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
}

/** Resolves only a v2 queue-owned snapshot reference bound to this exact scope.
 * The returned object remains subject to CAS byte/digest verification. */
export function sourceSnapshotRefFromPayload(
  payload: Readonly<Record<string, unknown>>,
  scope: SourceSnapshotScope
): RunScopedCasObjectRef {
  const context = payload.executionContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("governed queue payload has no execution context");
  }
  const record = context as Record<string, unknown>;
  if (record.schemaVersion !== 2) {
    throw new TypeError("governed queue payload has no v2 execution context");
  }
  const bindings = record.bindings;
  if (
    !bindings ||
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    (bindings as Record<string, unknown>).tenantId !== scope.tenantId ||
    (bindings as Record<string, unknown>).projectId !== scope.projectId ||
    (bindings as Record<string, unknown>).runId !== scope.runId
  ) {
    throw new TypeError("source snapshot execution scope binding is invalid");
  }
  const value = record.sourceSnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("source snapshot reference is missing");
  }
  const ref = value as Record<string, unknown>;
  if (
    ref.schemaVersion !== 1 ||
    typeof ref.objectKey !== "string" ||
    !OBJECT_KEY.test(ref.objectKey) ||
    typeof ref.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(ref.digest) ||
    !ref.objectKey.endsWith(`/${ref.digest}`) ||
    !objectKeyMatchesScope(ref.objectKey, scope, ref.digest) ||
    !Number.isSafeInteger(ref.byteLength) ||
    (ref.byteLength as number) < 0 ||
    ref.contentType !== CONTENT_TYPE
  ) {
    throw new TypeError("source snapshot reference is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    objectKey: ref.objectKey,
    digest: ref.digest,
    byteLength: ref.byteLength as number,
    contentType: ref.contentType
  });
}

function objectKeyMatchesScope(
  objectKey: string,
  scope: SourceSnapshotScope,
  digest: string
): boolean {
  const hashedScope = [scope.tenantId, scope.projectId, scope.runId]
    .map((value) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24))
    .join("/");
  const suffix = `cas/v1/${hashedScope}/${digest.slice(0, 2)}/${digest}`;
  if (objectKey === suffix) return true;
  const prefix = objectKey.slice(0, -(suffix.length + 1));
  return /^[a-f0-9]{24}$/u.test(prefix) && objectKey === `${prefix}/${suffix}`;
}
