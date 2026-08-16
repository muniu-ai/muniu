import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  EventId,
  MessageId,
  PROTECTION_POLICY_DIGEST_V1,
  SessionId,
  createAgentSessionEvent,
  createUserMessage,
  protectAgentSessionPayloadV1,
  type AgentSessionEventV1
} from "@mn/agent-protocol";
import {
  DurableAgentSession,
  InMemoryAgentSessionStore,
  JsonlAgentSessionStore,
  LegacyUnprotectedSessionError,
  RuntimeOverlayRequiredError,
  type AgentSessionHeaderV1
} from "../src/index.js";

const MOBILE = "13800138000";
const PRC_ID = "11010519491231002X";
const CREDENTIAL = "sk-runtime-only-credential-material";

function header(sessionId: SessionId): AgentSessionHeaderV1 {
  return {
    schemaVersion: 1,
    sessionId,
    createdAt: "2026-08-16T00:00:00.000Z",
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1
  };
}

test("JSONL persists only protected headers and protected event payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-protected-session-"));
  const sessionId = SessionId("protected-persistence");
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({
    sessionId,
    cwd: `/workspace/${MOBILE}/alice`,
    labels: {
      owner: "Alice <alice@example.com>",
      identity: PRC_ID,
      apiKey: CREDENTIAL
    }
  });
  const message = createUserMessage({
    id: MessageId("protected-user-1"),
    source: { kind: "user" },
    content: [{
      type: "text",
      text: `Alice alice@example.com phone=${MOBILE} id=${PRC_ID} token=${CREDENTIAL}`
    }]
  });
  await session.append("turn/start", { turn: 1 });
  await session.append("user/message", { turn: 1, message });

  const directory = path.join(root, "sessions", sessionId);
  const headerText = await readFile(path.join(directory, "header.json"), "utf8");
  const eventsText = await readFile(path.join(directory, "events.jsonl"), "utf8");
  const durableBytes = `${headerText}\n${eventsText}`;
  for (const secret of [MOBILE, PRC_ID, CREDENTIAL]) {
    assert.equal(durableBytes.includes(secret), false);
  }
  assert.equal(durableBytes.includes("Alice"), true);
  assert.equal(durableBytes.includes("alice@example.com"), true);
  assert.equal(headerText.includes('"cwd"'), false);
  assert.equal(headerText.includes('"protectedCwd"'), true);
  for (const line of eventsText.trimEnd().split("\n")) {
    const event = JSON.parse(line) as AgentSessionEventV1;
    assert.equal(event.protectionProfile, AGENT_SESSION_PROTECTION_PROFILE_V1);
    assert.equal(event.protectionPolicyDigest, PROTECTION_POLICY_DIGEST_V1);
    assert.equal(event.payload.kind, "agent-session-protected-payload");
    assert.equal(event.payloadDigest, event.payload.digest);
  }
  await store.dispose();
});

test("runtime overlay keeps business values for execution, always protects credentials, and is never rebuilt from disk", async () => {
  const memory = new InMemoryAgentSessionStore();
  const live = await memory.create({ sessionId: SessionId("runtime-overlay-live") });
  await live.append("user/message", {
    turn: 1,
    message: createUserMessage({
      id: MessageId("runtime-user-1"),
      source: { kind: "user" },
      content: [{
        type: "text",
        text: `Alice alice@example.com phone=${MOBILE} id=${PRC_ID} token=${CREDENTIAL}`
      }]
    })
  });
  const runtime = live.runtimeMessages()[0];
  assert.equal(runtime?.content[0]?.type, "text");
  const runtimeText = runtime?.content[0]?.type === "text" ? runtime.content[0].text : "";
  assert.equal(runtimeText.includes(MOBILE), true);
  assert.equal(runtimeText.includes(PRC_ID), true);
  assert.equal(runtimeText.includes(CREDENTIAL), false);
  assert.equal(runtimeText.includes("alice@example.com"), true);

  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-runtime-reopen-"));
  const sessionId = SessionId("runtime-overlay-reopened");
  const writer = new JsonlAgentSessionStore(root);
  const created = await writer.create({ sessionId });
  await created.append("user/message", {
    turn: 1,
    message: createUserMessage({
      id: MessageId("runtime-user-2"),
      source: { kind: "user" },
      content: [{ type: "text", text: "persisted history" }]
    })
  });
  await writer.dispose();

  const reader = new JsonlAgentSessionStore(root);
  const reopened = await reader.open(sessionId);
  assert.throws(
    () => reopened.runtimeMessages(),
    (error: unknown) => error instanceof RuntimeOverlayRequiredError
      && error.code === "RUNTIME_OVERLAY_REQUIRED"
  );
  await reader.dispose();
});

test("durable events publish to memory only after commitDurable resolves", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const session = new DurableAgentSession(header(SessionId("durable-ack")), [], {
    commitDurable: () => gate,
    flush: async () => {}
  });
  const pending = session.append("turn/start", { turn: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.events.length, 0);
  release();
  await pending;
  assert.equal(session.events.length, 1);
});

test("append rejects accessors and proxies before traps run or events persist", async () => {
  const session = new DurableAgentSession(header(SessionId("strict-append-input")), [], {
    commitDurable: async () => {},
    flush: async () => {}
  });
  let getterReads = 0;
  const accessorPayload = {} as { turn: number };
  Object.defineProperty(accessorPayload, "turn", {
    enumerable: true,
    get() {
      getterReads += 1;
      return 1;
    }
  });
  let getterError: unknown;
  try {
    await session.append("turn/start", accessorPayload);
  } catch (error: unknown) {
    getterError = error;
  }

  let proxyTraps = 0;
  const proxyPayload = new Proxy({ turn: 2 }, {
    getPrototypeOf(target) {
      proxyTraps += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      proxyTraps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      proxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    }
  });
  let proxyError: unknown;
  try {
    await session.append("turn/start", proxyPayload);
  } catch (error: unknown) {
    proxyError = error;
  }

  let metadataGetterReads = 0;
  const accessorMetadata = {} as { runId: string };
  Object.defineProperty(accessorMetadata, "runId", {
    enumerable: true,
    get() {
      metadataGetterReads += 1;
      return "run-safe";
    }
  });
  let metadataGetterError: unknown;
  try {
    await session.append("turn/start", { turn: 3 }, accessorMetadata as never);
  } catch (error: unknown) {
    metadataGetterError = error;
  }

  let metadataProxyTraps = 0;
  const proxyMetadata = new Proxy({ runId: "run-safe" }, {
    getPrototypeOf(target) {
      metadataProxyTraps += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      metadataProxyTraps += 1;
      return Reflect.ownKeys(target);
    }
  });
  let metadataProxyError: unknown;
  try {
    await session.append("turn/start", { turn: 4 }, proxyMetadata as never);
  } catch (error: unknown) {
    metadataProxyError = error;
  }

  assert.ok(getterError instanceof Error);
  assert.ok(proxyError instanceof Error);
  assert.ok(metadataGetterError instanceof Error);
  assert.ok(metadataProxyError instanceof Error);
  assert.equal(getterReads, 0);
  assert.equal(proxyTraps, 0);
  assert.equal(metadataGetterReads, 0);
  assert.equal(metadataProxyTraps, 0);
  assert.equal(session.events.length, 0);
});

test("durable constructors cannot inject a public runtime overlay", () => {
  const sessionId = SessionId("runtime-overlay-binding");
  const originalPayload = {
    turn: 1,
    message: createUserMessage({
      id: MessageId("runtime-overlay-original"),
      source: { kind: "user" as const },
      content: [{ type: "text" as const, text: "ORIGINAL" }]
    })
  };
  const durable = createAgentSessionEvent({
    eventId: EventId("runtime-overlay-event"),
    sessionId,
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "user/message",
    payload: protectAgentSessionPayloadV1("user/message", originalPayload)
  });
  const forgedPayload = {
    turn: 1,
    message: createUserMessage({
      id: MessageId("runtime-overlay-original"),
      source: { kind: "user" as const },
      content: [{ type: "text" as const, text: "FORGED" }]
    })
  };
  const persistence = { commitDurable: async () => {}, flush: async () => {} };

  const injected = Reflect.construct(DurableAgentSession, [
    header(sessionId),
    [durable],
    persistence,
    [{ seq: 0, type: "user/message", payload: forgedPayload }]
  ]) as DurableAgentSession;
  assert.throws(
    () => injected.runtimeMessages(),
    (error: unknown) => error instanceof RuntimeOverlayRequiredError
      && error.code === "RUNTIME_OVERLAY_REQUIRED"
  );
});

test("JSONL rejects protected session identifiers before filesystem access or error reflection", async () => {
  const root = path.join(os.tmpdir(), `muniu-invalid-session-${crypto.randomUUID()}`);
  const store = new JsonlAgentSessionStore(root);
  for (const sessionId of [SessionId(MOBILE), SessionId("..")]) {
    for (const operation of [
      () => store.create({ sessionId }),
      () => store.open(sessionId)
    ]) {
      let failure: unknown;
      try {
        await operation();
      } catch (error: unknown) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      assert.equal(failure.message.includes(sessionId), false);
    }
  }
  await assert.rejects(() => stat(root), { code: "ENOENT" });
  await store.dispose();
});

test("legacy raw v1 sessions fail closed without rewriting their bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-legacy-session-"));
  const sessionId = SessionId("legacy-unprotected");
  const directory = path.join(root, "sessions", sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const headerPath = path.join(directory, "header.json");
  const eventsPath = path.join(directory, "events.jsonl");
  const headerBytes = JSON.stringify({
    schemaVersion: 1,
    sessionId,
    createdAt: "2026-08-16T00:00:00.000Z",
    cwd: `/legacy/${MOBILE}`
  });
  const eventBytes = JSON.stringify({
    schemaVersion: 1,
    eventId: "legacy-event-1",
    sessionId,
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "session/created",
    payload: { cwd: `/legacy/${MOBILE}` },
    payloadDigest: "0".repeat(64),
    digest: "0".repeat(64)
  });
  await writeFile(headerPath, headerBytes, { mode: 0o600 });
  await writeFile(eventsPath, eventBytes, { mode: 0o600 });

  const store = new JsonlAgentSessionStore(root);
  await assert.rejects(
    () => store.open(sessionId),
    (error: unknown) => error instanceof LegacyUnprotectedSessionError
      && error.code === "LEGACY_UNPROTECTED_SESSION"
  );
  assert.equal(await readFile(headerPath, "utf8"), headerBytes);
  assert.equal(await readFile(eventsPath, "utf8"), eventBytes);
  await store.dispose();
});

test("a complete legacy event tail without a newline is rejected before tail repair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-legacy-tail-"));
  const sessionId = SessionId("legacy-event-tail");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  await creator.dispose();

  const eventsPath = path.join(root, "sessions", sessionId, "events.jsonl");
  const eventBytes = JSON.stringify({
    schemaVersion: 1,
    eventId: "legacy-tail-event",
    sessionId,
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "session/created",
    payload: { labels: { phone: MOBILE } },
    payloadDigest: "0".repeat(64),
    digest: "0".repeat(64)
  });
  await writeFile(eventsPath, eventBytes, { mode: 0o600 });

  const reader = new JsonlAgentSessionStore(root);
  await assert.rejects(
    () => reader.open(sessionId),
    (error: unknown) => error instanceof LegacyUnprotectedSessionError
  );
  assert.equal(await readFile(eventsPath, "utf8"), eventBytes);
  await reader.dispose();
});

test("idempotent create fails closed when protected low-entropy inputs make equality ambiguous", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-ambiguous-create-"));
  const sessionId = SessionId("ambiguous-protected-create");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId, cwd: `/workspace/${MOBILE}/project` });
  await creator.dispose();

  const contender = new JsonlAgentSessionStore(root);
  try {
    await assert.rejects(
      () => contender.create({ sessionId, cwd: "/workspace/13900139000/project" }),
      /ambiguous.*protected.*creation|cannot.*compare/i
    );
  } finally {
    await contender.dispose();
  }
});
