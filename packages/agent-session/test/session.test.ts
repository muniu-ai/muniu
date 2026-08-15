import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CallId,
  CandidateId,
  EventId,
  MessageId,
  RunId,
  SessionId,
  createAgentSessionEvent,
  createAssistantMessage,
  createUserMessage,
  verifyAgentSessionEventChain
} from "@mn/agent-protocol";
import {
  InMemoryAgentSessionStore,
  JsonlAgentSessionStore,
  DurableAgentSession,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  projectSession,
  recoverInterruptedSession
} from "../src/index.js";
import type { AgentSessionExclusiveView } from "../src/index.js";

test("withExclusive serializes inner operations, waits for them, and expires its scoped view", async () => {
  const sessionId = SessionId("exclusive-scope");
  let activeAppends = 0;
  let maximumActiveAppends = 0;
  const session = new DurableAgentSession({
    schemaVersion: 1,
    sessionId,
    createdAt: "2026-08-15T00:00:00.000Z"
  }, [], {
    append: async () => {
      activeAppends += 1;
      maximumActiveAppends = Math.max(maximumActiveAppends, activeAppends);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeAppends -= 1;
    },
    flush: async () => {}
  });

  let leakedView: Parameters<Parameters<DurableAgentSession["withExclusive"]>[0]>[0] | undefined;
  const result = await session.withExclusive(async (view) => {
    leakedView = view;
    const created = view.append("session/created", {});
    const turn = view.append("turn/start", { turn: 1 });
    void view.append("step/start", { turn: 1, step: 1 });
    await Promise.all([created, turn]);
    return "complete";
  });

  assert.equal(result, "complete");
  assert.equal(maximumActiveAppends, 1);
  assert.deepEqual(session.events.map((event) => event.seq), [0, 1, 2]);
  assert.doesNotThrow(() => verifyAgentSessionEventChain(session.events));
  const expiredView = leakedView;
  assert.ok(expiredView);
  assert.throws(() => expiredView.append("turn/end", { turn: 1, reason: "completed" }), /expired|exclusive/i);
  assert.throws(() => expiredView.events, /expired|exclusive/i);
});

test("withExclusive drains started work and expires its view when the callback throws synchronously", async () => {
  const session = new DurableAgentSession({
    schemaVersion: 1,
    sessionId: SessionId("exclusive-sync-throw"),
    createdAt: "2026-08-15T00:00:00.000Z"
  }, [], {
    append: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
    flush: async () => {}
  });
  let leakedView: Parameters<Parameters<DurableAgentSession["withExclusive"]>[0]>[0] | undefined;

  await assert.rejects(() => session.withExclusive((view: AgentSessionExclusiveView) => {
    leakedView = view;
    void view.append("session/created", {});
    throw new Error("callback failed synchronously");
  }), /callback failed synchronously/i);

  assert.deepEqual(session.events.map((event) => event.type), ["session/created"]);
  const expiredView = leakedView;
  assert.ok(expiredView);
  assert.throws(() => expiredView.events, /expired|exclusive/i);
});

test("withExclusive rejects when unawaited scoped work rejects without an error value", async () => {
  const session = new DurableAgentSession({
    schemaVersion: 1,
    sessionId: SessionId("exclusive-undefined-rejection"),
    createdAt: "2026-08-15T00:00:00.000Z"
  }, [], {
    append: () => Promise.reject(undefined),
    flush: async () => {}
  });

  const [outcome] = await Promise.allSettled([
    session.withExclusive(async (view) => { void view.append("session/created", {}); })
  ]);
  assert.equal(outcome?.status, "rejected");
});

test("stores synchronously snapshot and validate create options with one getter read", async () => {
  const stores = [
    new InMemoryAgentSessionStore(),
    new JsonlAgentSessionStore(await mkdtemp(path.join(os.tmpdir(), "muniu-options-")))
  ];

  for (const [index, store] of stores.entries()) {
    let sessionId = SessionId(`option-session-${index}`);
    let cwd = `/workspace/${index}`;
    let label = `value-${index}`;
    const reads = { sessionId: 0, cwd: 0, labels: 0, label: 0 };
    const labels = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() { reads.label += 1; return label; }
    }) as Record<string, string>;
    const options = {
      get sessionId() { reads.sessionId += 1; return sessionId; },
      get cwd() { reads.cwd += 1; return cwd; },
      get labels() { reads.labels += 1; return labels; }
    };

    const created = store.create(options);
    sessionId = SessionId(`mutated-${index}`);
    cwd = `/mutated/${index}`;
    label = `mutated-${index}`;
    const session = await created;

    assert.equal(session.header.sessionId, SessionId(`option-session-${index}`));
    assert.equal(session.header.cwd, `/workspace/${index}`);
    assert.deepEqual(session.events[0]?.payload, { cwd: `/workspace/${index}`, labels: { kind: `value-${index}` } });
    assert.deepEqual(reads, { sessionId: 1, cwd: 1, labels: 1, label: 1 });
    if ("dispose" in store) await store.dispose();
  }

  const invalid = new InMemoryAgentSessionStore();
  let synchronousError: unknown;
  try {
    const pending = invalid.create({ sessionId: SessionId("invalid-options"), cwd: 42 } as never);
    void pending.catch(() => {});
  } catch (error: unknown) {
    synchronousError = error;
  }
  assert.match(String(synchronousError), /cwd.*string|invalid.*cwd/i);
  const retried = await invalid.create({ sessionId: SessionId("invalid-options") });
  assert.deepEqual(retried.events.map((event) => event.type), ["session/created"]);

  const disk = new JsonlAgentSessionStore(await mkdtemp(path.join(os.tmpdir(), "muniu-invalid-session-id-")));
  let unsafeIdError: unknown;
  try {
    const pending = disk.create({ sessionId: SessionId("../escape") });
    void pending.catch(() => {});
  } catch (error: unknown) {
    unsafeIdError = error;
  }
  assert.match(String(unsafeIdError), /session id.*safe/i);
  await disk.dispose();
});

test("session is poisoned after an uncertain persistence failure and never retries", async () => {
  const sessionId = SessionId("poisoned-session");
  let appendAttempts = 0;
  let flushAttempts = 0;
  const session = new DurableAgentSession({
    schemaVersion: 1,
    sessionId,
    createdAt: "2026-08-15T00:00:00.000Z"
  }, [], {
    append: async () => {
      appendAttempts += 1;
      throw new Error("write outcome unknown");
    },
    flush: async () => { flushAttempts += 1; }
  });

  const first = session.append("session/created", {});
  const queued = session.append("turn/start", { turn: 1 });
  await assert.rejects(() => first, /write outcome unknown/i);
  await assert.rejects(() => queued, /poisoned|persistence failure/i);
  await assert.rejects(() => session.append("turn/start", { turn: 1 }), /poisoned|persistence failure/i);
  await assert.rejects(() => session.flush(), /poisoned|persistence failure/i);
  assert.equal(appendAttempts, 1);
  assert.equal(flushAttempts, 0);
  assert.equal(session.events.length, 0);
});

test("append snapshots payload synchronously before queued persistence", async () => {
  const session = new DurableAgentSession({
    schemaVersion: 1,
    sessionId: SessionId("snapshot-session"),
    createdAt: "2026-08-15T00:00:00.000Z"
  }, [], {
    append: async () => {},
    flush: async () => {}
  });
  const payload = { turn: 1 };
  const pending = session.append("turn/start", payload);
  payload.turn = 99;
  const event = await pending;
  assert.equal(event.payload.turn, 1);
  assert.equal(Object.isFrozen(event.payload), true);
});

test("in-memory store serializes concurrent appends into a verified chain", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("memory-session") });
  await Promise.all(Array.from({ length: 20 }, (_, index) => session.append("turn/start", { turn: index + 1 })));

  assert.deepEqual(session.events.map((event) => event.seq), Array.from({ length: 21 }, (_, index) => index));
  assert.doesNotThrow(() => verifyAgentSessionEventChain(session.events));
  assert.equal(session.events[0]?.type, "session/created");
});

test("JSONL store persists mode 0700/0600 and reopens a verified session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-"));
  await chmod(root, 0o777);
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("disk-session"), cwd: "/tmp/project" });
  await session.append("turn/start", { turn: 1 });
  await session.flush();

  const sessionDir = path.join(root, "sessions", "disk-session");
  assert.equal((await stat(path.join(root, "sessions"))).mode & 0o777, 0o700);
  assert.equal((await stat(sessionDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(sessionDir, "header.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(sessionDir, "events.jsonl"))).mode & 0o777, 0o600);

  await store.dispose();
  const reopenStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenStore.open(SessionId("disk-session"));
  assert.equal(reopened.header.cwd, "/tmp/project");
  assert.deepEqual(reopened.events.map((event) => event.type), ["session/created", "turn/start"]);
  await reopenStore.dispose();
});

test("JSONL load truncates a torn final line but fails closed on middle corruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-tail-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("tail-session") });
  await session.append("turn/start", { turn: 1 });
  const eventsPath = path.join(root, "sessions", "tail-session", "events.jsonl");
  const committed = await readFile(eventsPath);
  await writeFile(eventsPath, Buffer.concat([committed, Buffer.from('{"schemaVersion":1')]));

  await store.dispose();
  const reopenStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenStore.open(SessionId("tail-session"));
  assert.equal(reopened.events.length, 2);
  assert.deepEqual(await readFile(eventsPath), committed);
  await reopenStore.dispose();

  const lines = committed.toString("utf8").trimEnd().split("\n");
  await writeFile(eventsPath, `${lines[0]}\nnot-json\n${lines[1]}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("tail-session")), /corrupt.*line 2/i);
});

test("JSONL load rejects empty logs, a non-creation first event, and header/event id mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-binding-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("bound-session") });
  const eventsPath = path.join(root, "sessions", "bound-session", "events.jsonl");
  const headerPath = path.join(root, "sessions", "bound-session", "header.json");
  const originalHeader = JSON.parse(await readFile(headerPath, "utf8")) as Record<string, unknown>;
  const originalEvents = await readFile(eventsPath, "utf8");
  await store.dispose();

  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, unexpected: true })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /invalid session header/i);
  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, createdAt: "2026-08-15" })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /invalid session header/i);
  const tamperedCreatedAt = originalHeader.createdAt === "2000-01-01T00:00:00.000Z"
    ? "2001-01-01T00:00:00.000Z"
    : "2000-01-01T00:00:00.000Z";
  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, createdAt: tamperedCreatedAt })}\n`);
  await assert.rejects(
    () => new JsonlAgentSessionStore(root).open(SessionId("bound-session")),
    /creation time.*creation event/i
  );
  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, cwd: "/tampered" })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /cwd.*creation event/i);
  await writeFile(headerPath, `${JSON.stringify(originalHeader)}\n`);
  await writeFile(eventsPath, originalEvents);

  await writeFile(eventsPath, "");
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /empty event log/i);

  const notCreated = createAgentSessionEvent({
    eventId: EventId("not-created"),
    sessionId: SessionId("bound-session"),
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "turn/start",
    payload: { turn: 1 }
  });
  await writeFile(eventsPath, `${JSON.stringify(notCreated)}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /first event.*session\/created/i);

  const mismatched = createAgentSessionEvent({
    eventId: EventId("wrong-session"),
    sessionId: SessionId("another-session"),
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "session/created",
    payload: {}
  });
  await writeFile(eventsPath, `${JSON.stringify(mismatched)}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /event session id.*header/i);
  assert.equal(session.events.length, 1);
});

test("JSONL stores enforce one canonical in-process writer and coalesce concurrent opens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-lease-"));
  const sessionId = SessionId("leased-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  const contender = new JsonlAgentSessionStore(root);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);

  await creator.dispose();
  const reader = new JsonlAgentSessionStore(root);
  const [first, second] = await Promise.all([reader.open(sessionId), reader.open(sessionId)]);
  assert.equal(first, second);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);
  await reader.dispose();
  const transferred = await contender.open(sessionId);
  assert.equal(transferred.header.sessionId, sessionId);
  await contender.dispose();

  const createRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-session-create-"));
  const creating = new JsonlAgentSessionStore(createRoot);
  const results = await Promise.allSettled([
    creating.create({ sessionId: SessionId("concurrent-create") }),
    creating.create({ sessionId: SessionId("concurrent-create") })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await creating.dispose();
});

test("JSONL dispose holds its lease until an active durable append settles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-dispose-"));
  let enterAppend!: () => void;
  const appendEntered = new Promise<void>((resolve) => { enterAppend = resolve; });
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const sessionId = SessionId("dispose-race");
  const store = new JsonlAgentSessionStore(root, {
    beforeAppend: async (event) => {
      if (event.type !== "turn/start") return;
      enterAppend();
      await appendGate;
    }
  });
  const session = await store.create({ sessionId });
  const append = session.append("turn/start", { turn: 1 });
  await appendEntered;
  let disposeSettled = false;
  const disposing = store.dispose().then(() => { disposeSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposeSettled, false);

  const contender = new JsonlAgentSessionStore(root);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);
  releaseAppend();
  await append;
  await disposing;
  assert.equal(disposeSettled, true);
  const transferred = await contender.open(sessionId);
  assert.deepEqual(transferred.events.map((event) => event.type), ["session/created", "turn/start"]);
  await contender.dispose();
});

test("JSONL create publishes a complete session atomically and can retry after the first append fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-atomic-"));
  const sessionId = SessionId("atomic-session");
  let attempts = 0;
  const store = new JsonlAgentSessionStore(root, {
    beforeAppend: (event) => {
      if (event.type === "session/created" && attempts++ === 0) throw new Error("injected initial append failure");
    }
  });

  await assert.rejects(() => store.create({ sessionId }), /injected initial append failure/i);
  await assert.rejects(() => stat(path.join(root, "sessions", sessionId)), /ENOENT/);
  assert.deepEqual(await readdir(path.join(root, "sessions")), []);

  const session = await store.create({ sessionId });
  assert.deepEqual(session.events.map((event) => event.type), ["session/created"]);
  assert.equal(session.header.createdAt, session.events[0]?.occurredAt);
  await store.dispose();
});

test("JSONL open rejects symlinked session paths and files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-symlink-"));
  const sessionId = SessionId("linked-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  await creator.dispose();
  const sessionDir = path.join(root, "sessions", sessionId);
  const realDir = `${sessionDir}.real`;

  await rename(sessionDir, realDir);
  await symlink(realDir, sessionDir, "dir");
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(sessionId), /symbolic link|symlink/i);
  await unlink(sessionDir);
  await rename(realDir, sessionDir);

  for (const fileName of ["header.json", "events.jsonl"]) {
    const filePath = path.join(sessionDir, fileName);
    const realFile = `${filePath}.real`;
    await rename(filePath, realFile);
    await symlink(realFile, filePath, "file");
    const contender = new JsonlAgentSessionStore(root);
    await assert.rejects(() => contender.open(sessionId), /symbolic link|symlink|too many levels/i);
    await contender.dispose();
    await unlink(filePath);
    await rename(realFile, filePath);
  }
});

test("JSONL writer leases converge across symlink roots and hard-linked event aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-alias-"));
  const sessionId = SessionId("alias-session");
  const owner = new JsonlAgentSessionStore(root);
  await owner.create({ sessionId });

  const symlinkRoot = `${root}-symlink`;
  await symlink(root, symlinkRoot, "dir");
  const symlinkContender = new JsonlAgentSessionStore(symlinkRoot);
  await assert.rejects(() => symlinkContender.open(sessionId), /lease|writer/i);
  await symlinkContender.dispose();

  const hardlinkRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-session-hardlink-"));
  const hardlinkDir = path.join(hardlinkRoot, "sessions", sessionId);
  await mkdir(hardlinkDir, { recursive: true });
  const ownerDir = path.join(root, "sessions", sessionId);
  await link(path.join(ownerDir, "header.json"), path.join(hardlinkDir, "header.json"));
  await link(path.join(ownerDir, "events.jsonl"), path.join(hardlinkDir, "events.jsonl"));
  const hardlinkContender = new JsonlAgentSessionStore(hardlinkRoot);
  await assert.rejects(() => hardlinkContender.open(sessionId), /lease|writer|alias/i);
  await hardlinkContender.dispose();
  await owner.dispose();
});

test("JSONL append fails closed if the leased event file inode is replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-replaced-"));
  const sessionId = SessionId("replaced-events");
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId });
  const eventsPath = path.join(root, "sessions", sessionId, "events.jsonl");
  await rename(eventsPath, `${eventsPath}.replaced`);
  await writeFile(eventsPath, "", { mode: 0o600 });

  await assert.rejects(() => session.append("turn/start", { turn: 1 }), /lease|inode|identity|replaced/i);
  assert.deepEqual(session.events.map((event) => event.type), ["session/created"]);
  await store.dispose();
});

test("recovery closes started and unstarted tool effects without replaying either", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("recover-session") });
  const user = createUserMessage({
    id: MessageId("user-1"),
    content: [{ type: "text", text: "run tools" }],
    source: { kind: "user" }
  });
  const started = CallId("call-started");
  const unstarted = CallId("call-unstarted");
  const assistant = createAssistantMessage({
    id: MessageId("assistant-1"),
    content: [
      { type: "tool-call", id: started, name: "write", arguments: "{}" },
      { type: "tool-call", id: unstarted, name: "read", arguments: "{}" }
    ],
    source: { kind: "model", provider: "mock", model: "scripted" }
  });
  const runId = RunId("recovery-run");
  const turnCandidateId = CandidateId("recovery-turn-candidate");
  const assistantCandidateId = CandidateId("recovery-assistant-candidate");
  const startedCandidateId = CandidateId("recovery-started-candidate");
  await session.append("turn/start", { turn: 1 }, { runId, candidateId: turnCandidateId });
  await session.append("user/message", { turn: 1, message: user });
  await session.append("step/start", { turn: 1, step: 1 });
  await session.append(
    "assistant/message",
    { turn: 1, step: 1, message: assistant },
    { runId, candidateId: assistantCandidateId }
  );
  await session.append(
    "tool/call",
    { turn: 1, step: 1, callId: started, name: "write", arguments: "{}" },
    { runId, candidateId: startedCandidateId }
  );

  const firstRecovery = recoverInterruptedSession(session);
  const concurrentRecovery = recoverInterruptedSession(session);
  const [recovered, duplicate] = await Promise.all([firstRecovery, concurrentRecovery]);
  assert.deepEqual(duplicate, []);
  assert.deepEqual(
    recovered.filter((event) => event.type === "tool/result").map((event) => event.type === "tool/result" ? event.payload.error?.code : undefined),
    [TOOL_OUTCOME_UNKNOWN, TOOL_NOT_STARTED]
  );
  assert.deepEqual(recovered.slice(-2).map((event) => event.type), ["step/end", "turn/end"]);
  const recoveredToolResults = recovered.filter((event) => event.type === "tool/result");
  assert.deepEqual(
    recoveredToolResults.map((event) => event.candidateId),
    [startedCandidateId, assistantCandidateId]
  );
  assert.deepEqual(recoveredToolResults.map((event) => event.runId), [runId, runId]);
  assert.deepEqual(
    recovered.slice(-2).map((event) => ({ runId: event.runId, candidateId: event.candidateId })),
    [
      { runId, candidateId: turnCandidateId },
      { runId, candidateId: turnCandidateId }
    ]
  );
  const last = recovered.at(-1);
  assert.equal(last?.type === "turn/end" ? last.payload.reason : undefined, "interrupted");
  assert.equal((await recoverInterruptedSession(session)).length, 0);

  const projection = projectSession(session.events);
  assert.equal(projection.status, "interrupted");
  assert.equal(projection.pendingToolCalls.length, 0);
  assert.deepEqual(projection.messages.map((message) => message.id), ["user-1", "assistant-1", "recovery-call-started", "recovery-call-unstarted"]);
});
