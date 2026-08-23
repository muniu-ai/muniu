// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  isAgentEventV3,
  type AgentEventV3
} from "@mn/agent-protocol";

import {
  S3ArtifactStoreError,
  type S3CompatibleArtifactStore
} from "./artifactRemoteStore.js";

export interface EnterpriseAgentEventV3ObjectInput {
  readonly tenantId: string;
  readonly threadId: string;
  readonly event: AgentEventV3;
}

export interface EnterpriseAgentEventV3ObjectReceipt {
  readonly objectKey: string;
  readonly objectSha256: string;
  readonly objectBytes: number;
}

export interface EnterpriseAgentEventV3ObjectReference
  extends EnterpriseAgentEventV3ObjectReceipt {
  readonly threadId: string;
  readonly sequence: number;
  readonly eventDigest: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPrefix(value: string | undefined): string {
  return (value ?? "").replace(/^\/+|\/+$/gu, "");
}

export function enterpriseAgentEventV3ObjectKey(
  prefix: string | undefined,
  input: EnterpriseAgentEventV3ObjectInput
): string {
  return [
    normalizedPrefix(prefix),
    "agent-events-v3",
    sha256(input.tenantId).slice(0, 32),
    input.threadId,
    `${String(input.event.sequence).padStart(12, "0")}-${input.event.digest}.json`
  ].filter(Boolean).join("/");
}

export async function storeEnterpriseAgentEventV3Object(options: {
  readonly store: S3CompatibleArtifactStore;
  readonly input: EnterpriseAgentEventV3ObjectInput;
  readonly prefix?: string;
  readonly kmsKeyId?: string;
}): Promise<EnterpriseAgentEventV3ObjectReceipt> {
  const key = enterpriseAgentEventV3ObjectKey(options.prefix, options.input);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 3, event: options.input.event }), "utf8");
  try {
    const stored = await options.store.putObject(key, bytes, {
      contentType: "application/vnd.muniu.agent-event-v3+json",
      ifNoneMatch: "*",
      ...(options.kmsKeyId
        ? { serverSideEncryption: "aws:kms" as const, kmsKeyId: options.kmsKeyId }
        : {}),
      metadata: {
        tenantScope: sha256(options.input.tenantId).slice(0, 32),
        thread: options.input.threadId,
        sequence: String(options.input.event.sequence),
        digest: options.input.event.digest
      }
    });
    return Object.freeze({
      objectKey: stored.key,
      objectSha256: stored.sha256,
      objectBytes: stored.bytes
    });
  } catch (error: unknown) {
    if (!(error instanceof S3ArtifactStoreError)
      || error.statusCode !== 409 && error.statusCode !== 412) throw error;
    const existing = await options.store.getObject(key);
    if (!existing || !existing.equals(bytes)) {
      throw new Error("existing enterprise V3 object conflicts with the event", { cause: error });
    }
    return Object.freeze({
      objectKey: key,
      objectSha256: sha256(bytes),
      objectBytes: bytes.byteLength
    });
  }
}

export async function loadEnterpriseAgentEventV3Object(
  store: S3CompatibleArtifactStore,
  reference: EnterpriseAgentEventV3ObjectReference
): Promise<AgentEventV3> {
  const bytes = await store.getObject(reference.objectKey);
  if (!bytes
    || bytes.byteLength !== reference.objectBytes
    || sha256(bytes) !== reference.objectSha256) {
    throw new Error("enterprise V3 S3 event is missing or has a mismatched digest");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("enterprise V3 S3 event contains invalid JSON");
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("enterprise V3 S3 event envelope is invalid");
  }
  const record = envelope as Record<string, unknown>;
  if (record.schemaVersion !== 3 || !isAgentEventV3(record.event)) {
    throw new Error("enterprise V3 S3 event envelope is invalid");
  }
  const event = record.event;
  if (event.threadId !== reference.threadId
    || event.sequence !== reference.sequence
    || event.digest !== reference.eventDigest) {
    throw new Error("enterprise V3 S3 event does not match its PostgreSQL index");
  }
  return event;
}
