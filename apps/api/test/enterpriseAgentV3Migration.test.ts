// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  EventId,
  SessionId,
  createAgentSessionEventV2,
  protectAgentSessionPayloadV2
} from "@mn/agent-protocol";

import {
  EnterpriseAgentV3MigrationJob,
  type EnterpriseAgentV3MigrationActivation,
  type EnterpriseAgentV3MigrationBackend,
  type EnterpriseLegacyThreadV3,
  type EnterpriseStoredEventV3
} from "../src/enterpriseAgentV3Migration.js";

function sourceThread(): EnterpriseLegacyThreadV3 {
  const created = createAgentSessionEventV2({
    eventId: EventId("evt-enterprise-created"),
    sessionId: SessionId("session-enterprise-v3"),
    seq: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "session/created",
    payload: protectAgentSessionPayloadV2("session/created", {
      cwd: "/workspace/project",
      modelBinding: {
        schemaVersion: 1,
        kind: "agent-model-binding",
        providerId: "openai",
        modelId: "gpt-5"
      }
    })
  });
  const turn = createAgentSessionEventV2({
    eventId: EventId("evt-enterprise-turn"),
    sessionId: created.sessionId,
    seq: 1,
    occurredAt: "2026-08-23T00:00:01.000Z",
    type: "turn/start",
    payload: protectAgentSessionPayloadV2("turn/start", { turn: 1 }),
    previousDigest: created.digest
  });
  return {
    tenantId: "tenant-one",
    threadId: created.sessionId,
    header: {
      schemaVersion: 2,
      sessionId: created.sessionId,
      createdAt: created.occurredAt
    },
    events: [created, turn]
  };
}

class MemoryMigrationBackend implements EnterpriseAgentV3MigrationBackend {
  readonly writes: EnterpriseStoredEventV3[] = [];
  activation: EnterpriseAgentV3MigrationActivation | undefined;
  extraWrites = 0;

  constructor(readonly source: readonly EnterpriseLegacyThreadV3[]) {}

  loadLegacyThreads(): Promise<readonly EnterpriseLegacyThreadV3[]> {
    return Promise.resolve(this.source);
  }

  storeEvent(event: EnterpriseStoredEventV3): Promise<EnterpriseStoredEventV3> {
    this.writes.push(event);
    return Promise.resolve(event);
  }

  activate(input: EnterpriseAgentV3MigrationActivation): Promise<void> {
    assert.equal(this.writes.length, input.eventCount);
    this.activation = input;
    return Promise.resolve();
  }

  rollback(): Promise<EnterpriseAgentV3MigrationActivation> {
    if (!this.activation) return Promise.reject(new Error("no active migration"));
    if (this.extraWrites > 0) return Promise.reject(new Error("V3 write detected"));
    return Promise.resolve(this.activation);
  }
}

test("enterprise migration dry-run is read-only and apply activates only after immutable writes", async () => {
  const backend = new MemoryMigrationBackend([sourceThread()]);
  const job = new EnterpriseAgentV3MigrationJob(backend);

  const dryRun = await job.inspect();
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.threadCount, 1);
  assert.equal(dryRun.eventCount, 2);
  assert.equal(backend.writes.length, 0);
  assert.equal(backend.activation, undefined);

  const applied = await job.apply();
  assert.equal(applied.mode, "applied");
  assert.equal(backend.writes.length, 2);
  const activation = backend.activation as EnterpriseAgentV3MigrationActivation | undefined;
  assert.equal(activation?.newRootDigest, dryRun.newRootDigest);
  assert.deepEqual(backend.writes.map((entry) => entry.event.source?.schemaVersion), [2, 2]);
});

test("enterprise rollback refuses a target with any post-migration V3 write", async () => {
  const backend = new MemoryMigrationBackend([sourceThread()]);
  const job = new EnterpriseAgentV3MigrationJob(backend);
  await job.apply();
  assert.equal((await job.rollback()).mode, "rolled-back");

  const changed = new MemoryMigrationBackend([sourceThread()]);
  const changedJob = new EnterpriseAgentV3MigrationJob(changed);
  await changedJob.apply();
  changed.extraWrites = 1;
  await assert.rejects(() => changedJob.rollback(), /V3 write/iu);
});
