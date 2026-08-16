import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { JsonlAgentSessionStore } from "@mn/agent-session";
import { SessionId } from "@mn/agent-protocol";

import { buildServer } from "../src/server.js";
import { LocalMockAgentSessionService } from "../src/agentSessionService.js";

function appAt(root: string) {
  return buildServer({
    mniuRoot: root,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
}

test("agent session routes run multiple protected mock turns and resume SSE by cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));

  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: {
      clientRequestId: "create-request-1",
      provider: "mock",
      model: "local-mock",
      cwd: "/Users/alice/project",
      labels: { owner: "Alice", email: "alice@example.com" }
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const sessionId = (created.json() as { sessionId: string }).sessionId;

  const first = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: {
      clientRequestId: "message-request-1",
      prompt: "Alice alice@example.com /Users/alice/project 手机：13800138000 身份证：11010519491231002X token=top-secret"
    }
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.body;
  assert.doesNotMatch(firstBody, /13800138000|11010519491231002X|top-secret/u);
  assert.match(firstBody, /Alice/u);
  assert.match(firstBody, /alice@example\.com/u);
  assert.match(firstBody, /\/Users\/alice\/project/u);
  const mutationFacts = await readFile(join(root, "agent-service", "mutations.jsonl"), "utf8");
  assert.doesNotMatch(mutationFacts, /13800138000|11010519491231002X|top-secret/u);
  const eventFacts = await readFile(
    join(root, "agent-service", "sessions", sessionId, "events.jsonl"),
    "utf8"
  );
  assert.doesNotMatch(eventFacts, /13800138000|11010519491231002X|top-secret/u);
  assert.match(eventFacts, /Alice/u);
  assert.match(eventFacts, /alice@example\.com/u);
  assert.match(eventFacts, /\/Users\/alice\/project/u);

  const duplicate = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: {
      clientRequestId: "message-request-1",
      prompt: "different input must never execute"
    }
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.body, first.body);

  const second = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "message-request-2", prompt: "second turn" }
  });
  assert.equal(second.statusCode, 200, second.body);

  const inspected = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const events = (inspected.json() as { events: Array<{ seq: number }> }).events;
  assert.ok(events.length > 1);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));

});

test("agent mutation DTOs are exact and approvals use the closed decision enum", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-exact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));

  const invalidCreate = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "create-exact", unexpected: true }
  });
  assert.equal(invalidCreate.statusCode, 400, invalidCreate.body);
  const unsafeControl = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "13800138000" }
  });
  assert.equal(unsafeControl.statusCode, 400, unsafeControl.body);
  assert.doesNotMatch(unsafeControl.body, /13800138000/u);

  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "create-exact-2" }
  });
  const sessionId = (created.json() as { sessionId: string }).sessionId;
  const invalidApproval = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/approval-1`,
    payload: { clientRequestId: "approval-request-1", decision: "approve_forever" }
  });
  assert.equal(invalidApproval.statusCode, 400, invalidApproval.body);
  for (const [index, decision] of ["approve_once", "approve_session_scope", "deny"].entries()) {
    const approval = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/approvals/approval-${index}`,
      payload: { clientRequestId: `approval-request-${index + 2}`, decision }
    });
    assert.equal(approval.statusCode, 200, approval.body);
    assert.equal(approval.json().decision, decision);
  }
});

test("agent sessions recover interrupted JSONL facts after restart without replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const durableRoot = join(root, "agent-service");
  const sessionId = SessionId("restart-recovery-session");
  const seed = new JsonlAgentSessionStore(durableRoot);
  const session = await seed.create({ sessionId });
  await session.append("turn/start", { turn: 1 });
  await session.flush();
  await seed.dispose();

  const app = appAt(root);
  t.after(() => app.close());
  const inspected = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const body = inspected.json() as {
    state: string;
    events: Array<{ type: string; payload: { publicControls?: { reason?: string } } }>;
  };
  assert.equal(body.state, "interrupted");
  assert.equal(body.events.at(-1)?.type, "turn/end");
  assert.equal(body.events.at(-1)?.payload.publicControls?.reason, "interrupted");
  assert.equal(body.events.some((event) => event.type === "assistant/message"), false);
  const afterFirstRead = await readFile(join(durableRoot, "sessions", sessionId, "events.jsonl"), "utf8");
  const secondRead = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(secondRead.statusCode, 200, secondRead.body);
  assert.equal(
    await readFile(join(durableRoot, "sessions", sessionId, "events.jsonl"), "utf8"),
    afterFirstRead,
    "ordinary GET must not append recovery facts"
  );
});

test("agent session close and cancel mutations are idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "create-controls" }
  });
  const sessionId = created.json().sessionId as string;

  for (const operation of ["cancel", "close"] as const) {
    const payload = { clientRequestId: `${operation}-request` };
    const first = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/${operation}`,
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/${operation}`,
      payload
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.body, first.body);
  }
  const blocked = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "closed-message", prompt: "must not run" }
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
});

test("concurrent messages serialize monotonic turns and an active run can be cancelled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "create-concurrent" }
  });
  const sessionId = created.json().sessionId as string;
  const concurrent = await Promise.all(["a", "b"].map((prompt, index) => app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: `concurrent-${index}`, prompt }
  })));
  assert.deepEqual(concurrent.map((response) => response.statusCode), [200, 200]);
  const afterConcurrent = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  const turnStarts = (afterConcurrent.json() as { events: Array<{ type: string; payload: { publicControls: { turn?: number } } }> })
    .events
    .filter((event) => event.type === "turn/start")
    .map((event) => event.payload.publicControls.turn);
  assert.deepEqual(turnStarts, [1, 2]);

  const running = app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "cancelled-message", prompt: "cancel me" }
  });
  await new Promise<void>((resolve) => { setTimeout(resolve, 8); });
  const cancelled = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/cancel`,
    payload: { clientRequestId: "cancel-active" }
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().cancelled, true);
  const runResult = await running;
  assert.equal(runResult.statusCode, 200, runResult.body);
  assert.equal(runResult.json().state, "cancelled");
});

test("completed mutation receipts survive restart and never execute twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-idempotent-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstApp = appAt(root);
  const first = await firstApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "restart-create" }
  });
  assert.equal(first.statusCode, 201, first.body);
  await firstApp.close();

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const duplicate = await restarted.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "restart-create" }
  });
  assert.equal(duplicate.statusCode, 201, duplicate.body);
  assert.equal(duplicate.body, first.body);
});

test("a message receipt stays byte-exact across a concurrent close and restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-close-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstApp = appAt(root);
  const created = await firstApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "close-race-create" }
  });
  const sessionId = (created.json() as { sessionId: string }).sessionId;
  const messageRequest = {
    method: "POST" as const,
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "close-race-message", prompt: "close while active" }
  };
  const firstPromise = firstApp.inject(messageRequest);
  await new Promise<void>((resolve) => { setTimeout(resolve, 8); });
  const close = await firstApp.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/close`,
    payload: { clientRequestId: "close-race-close" }
  });
  assert.equal(close.statusCode, 200, close.body);
  const first = await firstPromise;
  assert.equal(first.statusCode, 200, first.body);
  const immediateDuplicate = await firstApp.inject(messageRequest);
  assert.equal(immediateDuplicate.body, first.body);
  await firstApp.close();

  const restarted = appAt(root);
  t.after(() => restarted.close().catch(() => undefined));
  const restartedDuplicate = await restarted.inject(messageRequest);
  assert.equal(restartedDuplicate.statusCode, first.statusCode);
  assert.equal(restartedDuplicate.body, first.body);
});

test("in-memory idempotency responses are detached frozen values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-frozen-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  t.after(() => service.dispose());
  const created = await service.create({ clientRequestId: "frozen-receipt-create" });
  const body = created.body as { state: string; events: Array<{ seq: number }> };
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(body), true);
  assert.equal(Object.isFrozen(body.events), true);
  assert.throws(() => { body.state = "forged"; }, TypeError);
  assert.throws(() => { body.events[0]!.seq = 999; }, TypeError);
  const duplicate = await service.create({ clientRequestId: "frozen-receipt-create" });
  assert.equal((duplicate.body as { state: string }).state, "idle");
});

test("bounded receipts survive maximum legal messages and reconstruct the exact response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-max-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "max-receipt-create" }
  });
  const sessionId = created.json().sessionId as string;
  const prompt = "x".repeat(1_000_000);
  let terminalBody = "";
  for (let index = 0; index < 3; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/messages`,
      payload: { clientRequestId: `max-receipt-message-${index}`, prompt }
    });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
    terminalBody = response.body;
  }
  await app.close();
  const journal = await readFile(join(root, "agent-service", "mutations.jsonl"), "utf8");
  assert.ok(Buffer.byteLength(journal, "utf8") < 32_768);

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const duplicate = await restarted.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "max-receipt-message-2", prompt: "different" }
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body.slice(0, 200));
  assert.equal(duplicate.body, terminalBody);
});

test("many legal messages keep the mutation journal bounded across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-total-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "total-receipt-create" }
  });
  const sessionId = created.json().sessionId as string;
  const prompt = "y".repeat(100_000);
  for (let index = 0; index < 20; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/messages`,
      payload: { clientRequestId: `total-receipt-message-${index}`, prompt }
    });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
  }
  await app.close();
  const journalPath = join(root, "agent-service", "mutations.jsonl");
  assert.ok(Buffer.byteLength(await readFile(journalPath), "utf8") < 128_000);
  const restarted = appAt(root);
  t.after(() => restarted.close());
  const inspected = await restarted.inject({
    method: "GET",
    url: `/v1/agent-sessions/${sessionId}`
  });
  assert.equal(inspected.statusCode, 200, inspected.body.slice(0, 200));
});

test("restart never guesses protected history into a runtime overlay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-overlay-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstApp = appAt(root);
  const created = await firstApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "overlay-create" }
  });
  const sessionId = created.json().sessionId as string;
  const firstMessage = await firstApp.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "overlay-first", prompt: "first" }
  });
  assert.equal(firstMessage.statusCode, 200, firstMessage.body);
  const eventCount = firstMessage.json().events.length as number;
  await firstApp.close();

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const resumed = await restarted.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "overlay-second", prompt: "must fail closed" }
  });
  assert.equal(resumed.statusCode, 409, resumed.body);
  assert.equal(resumed.json().error, "RUNTIME_OVERLAY_REQUIRED");
  const inspected = await restarted.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.json().events.length, eventCount);
});

test("SQLite remains a rebuildable protected projection of JSONL facts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "projection-create" }
  });
  const sessionId = created.json().sessionId as string;
  const message = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: { clientRequestId: "projection-message", prompt: "Alice 手机：13800138000" }
  });
  const lastSeq = message.json().events.at(-1).seq as number;
  await app.close();

  const databasePath = join(root, "agent-service", "projection.db");
  const projection = new DatabaseSync(databasePath);
  projection.prepare(`
    update agent_session_projection
    set last_seq = 999, state = 'forged', projection_json = '{"raw":"13800138000"}'
    where session_id = ?
  `).run(sessionId);
  projection.close();

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const inspected = await restarted.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const rebuilt = new DatabaseSync(databasePath, { readOnly: true });
  const row = rebuilt.prepare(`
    select last_seq as lastSeq, state, projection_json as projectionJson
    from agent_session_projection where session_id = ?
  `).get(sessionId) as { lastSeq: number; state: string; projectionJson: string };
  rebuilt.close();
  assert.equal(row.lastSeq, lastSeq);
  assert.equal(row.state, "completed");
  assert.doesNotMatch(row.projectionJson, /13800138000/u);
  assert.match(row.projectionJson, /Alice/u);
});

test("ordinary GET leaves the derived SQLite projection unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-readonly-get-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "readonly-get-create" }
  });
  const sessionId = created.json().sessionId as string;
  const databasePath = join(root, "agent-service", "projection.db");
  const projection = new DatabaseSync(databasePath);
  projection.prepare(`
    update agent_session_projection
    set last_seq = 777, state = 'sentinel', projection_json = '{"sentinel":true}'
    where session_id = ?
  `).run(sessionId);
  projection.close();

  const inspected = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const after = new DatabaseSync(databasePath, { readOnly: true });
  const row = after.prepare(`
    select last_seq as lastSeq, state, projection_json as projectionJson
    from agent_session_projection where session_id = ?
  `).get(sessionId) as { lastSeq: number; state: string; projectionJson: string };
  after.close();
  assert.equal(row.lastSeq, 777);
  assert.equal(row.state, "sentinel");
  assert.equal(row.projectionJson, '{"sentinel":true}');
});

test("missing sessions are 404 while corrupt durable sessions fail closed as 5xx", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cleanApp = appAt(root);
  const missing = await cleanApp.inject({ method: "GET", url: "/v1/agent-sessions/missing-session" });
  assert.equal(missing.statusCode, 404, missing.body);
  await cleanApp.close();
  const durableRoot = join(root, "agent-service");
  const sessionId = SessionId("corrupt-session");
  const seed = new JsonlAgentSessionStore(durableRoot);
  await seed.create({ sessionId });
  await seed.dispose();
  await writeFile(join(durableRoot, "sessions", sessionId, "header.json"), "{invalid", "utf8");

  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const corrupt = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.ok(corrupt.statusCode >= 500, corrupt.body);
});

test("oversized mutation journals fail closed without parsing an unbounded line", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-journal-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serviceRoot = join(root, "agent-service");
  await mkdir(serviceRoot, { recursive: true });
  await writeFile(join(serviceRoot, "mutations.jsonl"), "x".repeat(16 * 1024 * 1024), "utf8");
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const response = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "bounded-journal-request" }
  });
  assert.ok(response.statusCode >= 500, response.body);
});

test("a root directory sync failure rejects acceptance before any session effect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-journal-dir-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serviceRoot = join(root, "agent-service");
  class FailingDirectorySyncService extends LocalMockAgentSessionService {
    protected override beforeJournalDirectorySync(): void {
      throw new Error("injected directory sync failure");
    }
  }
  const service = new FailingDirectorySyncService(serviceRoot);
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "directory-sync-create" }
  });
  assert.ok(response.statusCode >= 500, response.body);
  assert.equal((await readdir(serviceRoot)).includes("sessions"), false);
  await app.close().catch(() => undefined);
});

test("agent service refuses journal and projection symlinks without modifying their targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const journalServiceRoot = join(root, "journal-service");
  await mkdir(journalServiceRoot, { recursive: true });
  const journalTarget = join(root, "outside-journal.txt");
  await writeFile(journalTarget, "outside-journal-sentinel", "utf8");
  await symlink(journalTarget, join(journalServiceRoot, "mutations.jsonl"));
  const journalService = new LocalMockAgentSessionService(journalServiceRoot);
  const journalApp = buildServer({
    mniuRoot: root,
    agentSessionService: journalService,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  const journalResponse = await journalApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "symlink-journal-create" }
  });
  assert.ok(journalResponse.statusCode >= 500, journalResponse.body);
  assert.equal(await readFile(journalTarget, "utf8"), "outside-journal-sentinel");
  await journalApp.close().catch(() => undefined);

  const projectionServiceRoot = join(root, "projection-service");
  await mkdir(projectionServiceRoot, { recursive: true });
  const projectionTarget = join(root, "outside-projection.db");
  await writeFile(projectionTarget, new Uint8Array());
  await symlink(projectionTarget, join(projectionServiceRoot, "projection.db"));
  const projectionService = new LocalMockAgentSessionService(projectionServiceRoot);
  const projectionApp = buildServer({
    mniuRoot: root,
    agentSessionService: projectionService,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  const projectionResponse = await projectionApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "symlink-projection-create" }
  });
  assert.ok(projectionResponse.statusCode >= 500, projectionResponse.body);
  assert.equal((await readFile(projectionTarget)).byteLength, 0);
  await projectionApp.close().catch(() => undefined);
});

test("SSE sends cursor backlog then live events and releases the subscription on disconnect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-live-sse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/v1/agent-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "live-create" })
  });
  const sessionId = ((await created.json()) as { sessionId: string }).sessionId;
  const controller = new AbortController();
  const stream = await fetch(`${base}/v1/agent-sessions/${sessionId}/events?after=-1`, {
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const readUntil = async (pattern: RegExp): Promise<void> => {
    const deadline = Date.now() + 3_000;
    while (!pattern.test(received) && Date.now() < deadline) {
      const part = await reader.read();
      if (part.done) break;
      received += decoder.decode(part.value, { stream: true });
    }
    assert.match(received, pattern);
  };
  await readUntil(/event: session\/created/u);
  assert.equal(service.activeSubscriptionCount, 1);
  const message = await fetch(`${base}/v1/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "live-message", prompt: "live" })
  });
  assert.equal(message.status, 200);
  await readUntil(/event: assistant\/message/u);
  controller.abort();
  await assert.rejects(() => reader.read(), /abort/i);
  await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  assert.equal(service.activeSubscriptionCount, 0);
});

test("event subscriptions pause backlog delivery on backpressure and resume from the exact cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-pressure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  t.after(() => service.dispose());
  const created = await service.create({ clientRequestId: "pressure-create" });
  const sessionId = (created.body as { sessionId: string }).sessionId;
  await service.message(sessionId, { clientRequestId: "pressure-message", prompt: "backlog" });
  const received: number[] = [];
  const subscription = await service.subscribeEvents(sessionId, -1, (event) => {
    received.push(event.seq);
    return received.length !== 1;
  });
  assert.deepEqual(received, [0]);
  await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
  assert.deepEqual(received, [0]);
  subscription.resume();
  assert.ok(received.length > 1);
  assert.deepEqual(received, received.map((_, index) => index));
  subscription.unsubscribe();
  assert.equal(service.activeSubscriptionCount, 0);
});

test("service disposal permanently invalidates every subscription handle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-dispose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  const created = await service.create({ clientRequestId: "dispose-subscription-create" });
  const sessionId = (created.body as { sessionId: string }).sessionId;
  await service.message(sessionId, {
    clientRequestId: "dispose-subscription-message",
    prompt: "backlog before dispose"
  });
  let calls = 0;
  const subscription = await service.subscribeEvents(sessionId, -1, () => {
    calls += 1;
    return false;
  });
  assert.equal(calls, 1);

  await service.dispose();
  subscription.resume();
  subscription.pause();
  subscription.unsubscribe();
  subscription.resume();
  assert.equal(calls, 1);
  assert.equal(service.activeSubscriptionCount, 0);
});

test("SSE disconnect before session lookup completes never creates a subscription", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-early-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseLookup: (() => void) | undefined;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  class DelayedLookupService extends LocalMockAgentSessionService {
    subscribeCalls = 0;

    override async get(sessionId: string) {
      await lookupGate;
      return super.get(sessionId);
    }

    override async subscribeEvents(
      ...input: Parameters<LocalMockAgentSessionService["subscribeEvents"]>
    ) {
      this.subscribeCalls += 1;
      return super.subscribeEvents(...input);
    }
  }
  const service = new DelayedLookupService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address() as AddressInfo;
  const created = await service.create({ clientRequestId: "early-close-create" });
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const request = httpRequest({
    host: "127.0.0.1",
    port: address.port,
    path: `/v1/agent-sessions/${sessionId}/events?after=-1`,
    method: "GET"
  });
  request.on("error", () => undefined);
  request.end();
  await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  request.destroy();
  await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  releaseLookup?.();
  await new Promise<void>((resolve) => { setTimeout(resolve, 100); });

  assert.equal(service.subscribeCalls, 0);
  assert.equal(service.activeSubscriptionCount, 0);
});

test("server shutdown cancels an SSE handler still waiting for session lookup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-pending-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseLookup: (() => void) | undefined;
  let markLookupStarted: (() => void) | undefined;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
  class DelayedLookupService extends LocalMockAgentSessionService {
    subscribeCalls = 0;

    override async get(sessionId: string) {
      markLookupStarted?.();
      await lookupGate;
      return super.get(sessionId);
    }

    override async subscribeEvents(
      ...input: Parameters<LocalMockAgentSessionService["subscribeEvents"]>
    ) {
      this.subscribeCalls += 1;
      return super.subscribeEvents(...input);
    }
  }
  const service = new DelayedLookupService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const created = await service.create({ clientRequestId: "pending-shutdown-create" });
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const request = httpRequest({
    host: "127.0.0.1",
    port: address.port,
    path: `/v1/agent-sessions/${sessionId}/events?after=-1`,
    method: "GET"
  });
  request.on("error", () => undefined);
  request.end();
  await lookupStarted;
  const closing = app.close();
  await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  releaseLookup?.();
  await Promise.race([
    closing,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("server shutdown waited for pending SSE lookup")), 500);
    })
  ]);
  request.destroy();

  assert.equal(service.subscribeCalls, 0);
  assert.equal(service.activeSubscriptionCount, 0);
});

test("server shutdown closes active SSE connections without waiting for the client", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/v1/agent-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "shutdown-create" })
  });
  const sessionId = ((await created.json()) as { sessionId: string }).sessionId;
  const stream = await fetch(`${base}/v1/agent-sessions/${sessionId}/events?after=-1`);
  assert.ok(stream.body);
  const reader = stream.body!.getReader();
  await reader.read();
  assert.equal(service.activeSubscriptionCount, 1);

  await Promise.race([
    app.close(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("server shutdown waited for the SSE client")), 500);
    })
  ]);
  assert.equal(service.activeSubscriptionCount, 0);
  const terminal = await reader.read();
  assert.equal(terminal.done, true);
});
