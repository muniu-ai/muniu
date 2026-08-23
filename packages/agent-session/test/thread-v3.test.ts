// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  EventId,
  SessionId,
  createAgentEventV3,
  createProtectedJsonViewV1
} from "@mn/agent-protocol";

import { projectThreadV3 } from "../src/index.js";

test("projects thread, turn, item, fork, archive, and tombstone state", () => {
  const common = {
    threadId: SessionId("thread-projection"),
    correlationId: "thread-projection"
  };
  const created = createAgentEventV3({
    ...common,
    eventId: EventId("eventv-created"),
    sequence: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "thread/created",
    publicControls: {
      source: "appServer",
      providerId: "openai",
      modelId: "gpt-5",
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write" }
    },
    protectedContent: createProtectedJsonViewV1({ cwd: "/workspace/project" })
  });
  const turn = createAgentEventV3({
    ...common,
    eventId: EventId("eventv-turn"),
    turnId: "turn-one",
    sequence: 1,
    occurredAt: "2026-08-23T00:00:01.000Z",
    type: "turn/started",
    publicControls: { ordinal: 1 },
    protectedContent: createProtectedJsonViewV1(null),
    previousDigest: created.digest
  });
  const item = createAgentEventV3({
    ...common,
    eventId: EventId("eventv-item"),
    turnId: "turn-one",
    itemId: "item-one",
    sequence: 2,
    occurredAt: "2026-08-23T00:00:02.000Z",
    type: "item/recorded",
    publicControls: { itemKind: "agentMessage", status: "completed" },
    protectedContent: createProtectedJsonViewV1({ text: "done" }),
    previousDigest: turn.digest
  });
  const archived = createAgentEventV3({
    ...common,
    eventId: EventId("eventv-archived"),
    sequence: 3,
    occurredAt: "2026-08-23T00:00:03.000Z",
    type: "thread/archived",
    publicControls: {},
    protectedContent: createProtectedJsonViewV1(null),
    previousDigest: item.digest
  });
  const tombstoned = createAgentEventV3({
    ...common,
    eventId: EventId("eventv-tombstoned"),
    sequence: 4,
    occurredAt: "2026-08-23T00:00:04.000Z",
    type: "thread/tombstoned",
    publicControls: { retention: "evidence-preserved" },
    protectedContent: createProtectedJsonViewV1(null),
    previousDigest: archived.digest
  });

  const projection = projectThreadV3([created, turn, item, archived, tombstoned]);
  assert.equal(projection.threadId, "thread-projection");
  assert.equal(projection.cwd, "/workspace/project");
  assert.equal(projection.status, "idle");
  assert.equal(projection.archived, true);
  assert.equal(projection.tombstoned, true);
  assert.equal(projection.turns[0]?.turnId, "turn-one");
  assert.equal(projection.turns[0]?.status, "inProgress");
  assert.equal(projection.items[0]?.itemId, "item-one");
  assert.equal(projection.items[0]?.kind, "agentMessage");
});
