// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EventId,
  SessionId,
  createProtectedJsonViewV1
} from "@mn/agent-protocol";

import { JsonlAgentEventV3Store } from "../src/index.js";

test("JSONL V3 store creates, appends, lists and reopens one projected thread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-thread-store-v3-"));
  const threadId = SessionId("thread-store-v3");
  const store = new JsonlAgentEventV3Store(root);
  await store.create({
    eventId: EventId("event-store-created"),
    threadId,
    sequence: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "thread/created",
    correlationId: threadId,
    publicControls: {
      source: "appServer",
      providerId: "openai",
      modelId: "gpt-5",
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write" }
    },
    protectedContent: createProtectedJsonViewV1({ cwd: "/workspace/project" })
  });
  await store.append(threadId, {
    eventId: EventId("event-store-archived"),
    occurredAt: "2026-08-23T00:00:01.000Z",
    type: "thread/archived",
    correlationId: threadId,
    publicControls: {},
    protectedContent: createProtectedJsonViewV1(null)
  });

  const reopened = new JsonlAgentEventV3Store(root);
  assert.equal((await reopened.read(threadId)).length, 2);
  assert.equal((await reopened.list())[0]?.archived, true);
  assert.equal((await stat(path.join(root, "threads"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, "threads", threadId, "events.jsonl"))).mode & 0o777, 0o600);
});

test("JSONL V3 store serializes concurrent appends for one thread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-thread-store-v3-concurrent-"));
  const threadId = SessionId("thread-store-v3-concurrent");
  const store = new JsonlAgentEventV3Store(root);
  await store.create({
    eventId: EventId("event-store-created-concurrent"),
    threadId,
    sequence: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "thread/created",
    correlationId: threadId,
    publicControls: {
      source: "appServer",
      providerId: "openai",
      modelId: "gpt-5",
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write" }
    },
    protectedContent: createProtectedJsonViewV1({ cwd: "/workspace/project" })
  });

  await Promise.all([
    store.append(threadId, {
      eventId: EventId("event-store-update-one"),
      occurredAt: "2026-08-23T00:00:01.000Z",
      type: "thread/updated",
      correlationId: threadId,
      publicControls: { modelId: "gpt-5.1" },
      protectedContent: createProtectedJsonViewV1(null)
    }),
    store.append(threadId, {
      eventId: EventId("event-store-update-two"),
      occurredAt: "2026-08-23T00:00:02.000Z",
      type: "thread/updated",
      correlationId: threadId,
      publicControls: { permissionProfile: "read-only" },
      protectedContent: createProtectedJsonViewV1(null)
    })
  ]);

  const events = await new JsonlAgentEventV3Store(root).read(threadId);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2]);
  assert.equal(events[2]?.causationId, events[1]?.eventId);
  assert.equal(events[2]?.previousDigest, events[1]?.digest);
});
