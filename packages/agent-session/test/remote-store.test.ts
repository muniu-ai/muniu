// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  MessageId,
  SessionId,
  createUserMessage,
  type AgentSessionEvent,
  type AgentSessionEventPayloadMap,
  type AgentSessionEventType
} from "@mn/agent-protocol";
import {
  RemoteAgentSessionStore,
  type AgentSessionHeader,
  type RemoteAgentSessionBackend,
  type RemoteAgentSessionSnapshot
} from "../src/index.js";

class MemoryRemoteBackend implements RemoteAgentSessionBackend {
  header?: AgentSessionHeader;
  events: AgentSessionEvent[] = [];
  payloads = new Map<
    number,
    AgentSessionEventPayloadMap[AgentSessionEventType]
  >();

  async create(input: {
    readonly header: AgentSessionHeader;
    readonly event: AgentSessionEvent<"session/created">;
    readonly runtimePayload: AgentSessionEventPayloadMap["session/created"];
  }): Promise<void> {
    this.header = structuredClone(input.header);
    this.events = [structuredClone(input.event)];
    this.payloads = new Map([[0, structuredClone(input.runtimePayload)]]);
  }

  async append(
    event: AgentSessionEvent,
    runtimePayload?: AgentSessionEventPayloadMap[AgentSessionEventType]
  ): Promise<void> {
    if (runtimePayload === undefined) throw new Error("runtime payload required");
    this.events.push(structuredClone(event));
    this.payloads.set(event.seq, structuredClone(runtimePayload));
  }

  async load(sessionId: SessionId): Promise<RemoteAgentSessionSnapshot> {
    if (!this.header || this.header.sessionId !== sessionId) throw new Error("missing");
    return {
      header: structuredClone(this.header),
      events: structuredClone(this.events),
      runtimePayloads: new Map(
        [...this.payloads].map(([seq, payload]) => [seq, structuredClone(payload)])
      )
    };
  }

  async listSessionIds(): Promise<readonly SessionId[]> {
    return this.header ? [this.header.sessionId] : [];
  }
}

test("remote sessions restore exact model-visible history and cwd after process loss", async () => {
  const backend = new MemoryRemoteBackend();
  const first = new RemoteAgentSessionStore(backend);
  const sessionId = SessionId("remote-recovery");
  const created = await first.create({ sessionId, cwd: "/workspace/recovery" });
  await created.append("user/message", {
    turn: 1,
    message: createUserMessage({
      id: MessageId("remote-user-1"),
      source: { kind: "user" },
      content: [{
        type: "text",
        text: "Alice alice@example.com token=sk-runtime-only-credential-material"
      }]
    })
  });

  const restarted = new RemoteAgentSessionStore(backend);
  const reopened = await restarted.open(sessionId);
  assert.equal(reopened.runtimeCwd(), "/workspace/recovery");
  const block = reopened.runtimeMessages()[0]?.content[0];
  assert.equal(block?.type, "text");
  const text = block?.type === "text" ? block.text : "";
  assert.match(text, /Alice alice@example\.com/u);
  assert.doesNotMatch(text, /sk-runtime-only-credential-material/u);
  assert.equal(reopened.events.length, 2);
});

test("remote sessions fail closed when a stored runtime overlay is changed", async () => {
  const backend = new MemoryRemoteBackend();
  const store = new RemoteAgentSessionStore(backend);
  const sessionId = SessionId("remote-tamper");
  await store.create({ sessionId, cwd: "/workspace/original" });
  backend.payloads.set(0, { cwd: "/workspace/tampered" });

  await assert.rejects(
    () => new RemoteAgentSessionStore(backend).open(sessionId),
    /runtime session overlay does not match its protected event/u
  );
});
