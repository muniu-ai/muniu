// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_METHODS,
  InitializeParamsSchema,
  ThreadItemSchema,
  parseClientRequest
} from "../src/index.js";

const expectedMethods = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
  "thread/unsubscribe",
  "thread/name/set",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "thread/compact/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  "model/list",
  "skills/list",
  "skills/extraRoots/set",
  "hooks/list",
  "config/read",
  "config/mcpServer/reload",
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "mcpServer/tool/call"
] as const;

test("publishes only the selected stable Codex method subset", () => {
  assert.deepEqual(CLIENT_METHODS, expectedMethods);
});

test("accepts a stable initialize request and rejects experimental capability fields", () => {
  assert.deepEqual(
    InitializeParamsSchema.parse({
      clientInfo: { name: "desktop", title: "Muniu Desktop", version: "0.2.0" },
      capabilities: { optOutNotificationMethods: ["warning"] }
    }),
    {
      clientInfo: { name: "desktop", title: "Muniu Desktop", version: "0.2.0" },
      capabilities: { optOutNotificationMethods: ["warning"] }
    }
  );
  assert.throws(() =>
    InitializeParamsSchema.parse({
      clientInfo: { name: "desktop", version: "0.2.0" },
      capabilities: { experimentalApi: true }
    })
  );
});

test("validates method params before dispatch and rejects unknown fields", () => {
  const request = parseClientRequest({
    id: 7,
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Use the focused test." }],
      clientUserMessageId: "message-1"
    }
  });
  assert.equal(request.method, "turn/steer");

  assert.throws(() =>
    parseClientRequest({
      id: 8,
      method: "thread/start",
      params: { mockExperimentalField: "must fail" }
    })
  );
  assert.throws(() =>
    parseClientRequest({ id: 9, method: "thread/list", params: null })
  );
});

test("reasoning items expose summaries without accepting hidden reasoning content", () => {
  assert.deepEqual(
    ThreadItemSchema.parse({ id: "item-1", type: "reasoning", summary: ["Checked the policy."] }),
    { id: "item-1", type: "reasoning", summary: ["Checked the policy."] }
  );
  assert.throws(() =>
    ThreadItemSchema.parse({
      id: "item-1",
      type: "reasoning",
      summary: ["Checked the policy."],
      content: ["hidden chain of thought"]
    })
  );
});
