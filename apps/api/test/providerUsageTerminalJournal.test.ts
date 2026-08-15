import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { canonicalJson, sha256Canonical } from "@mn/governance";
import type { ProviderUsageAttemptLog } from "@mn/local-proxy";
import { providerUsageAttemptLogId } from "@mn/local-proxy";
import { S3CompatibleArtifactStore } from "../src/artifactRemoteStore.js";
import {
  ProviderUsageTerminalJournal,
  ProviderUsageTerminalJournalIntegrityError,
  type ProviderUsageTerminalJournalRevocationCheckpointInput
} from "../src/providerUsageTerminalJournal.js";

const OLD_JOURNAL_KEY = "old-provider-usage-journal-key-0123456789abcdef";
const NEW_JOURNAL_KEY = "new-provider-usage-journal-key-0123456789abcdef";
const NEXT_JOURNAL_KEY = "next-provider-usage-journal-key-0123456789abcdef";
const integrity = {
  activeKeyId: "journal-2026-a",
  keys: [{ id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "active" }]
} as const;

test("provider usage journal is create-only, exact-replayable and retained", async (t) => {
  const remote = await fakeS3(t);
  const journal = new ProviderUsageTerminalJournal({
    store: remote.store,
    prefix: "enterprise/evidence",
    integrity
  });
  const log = usageLog();

  const first = await journal.persist(log);
  const duplicate = await journal.persist(log);
  assert.deepEqual(duplicate, first);
  assert.equal(remote.puts.length, 2);
  assert.equal(remote.puts[0]?.ifNoneMatch, "*");
  assert.equal(remote.puts[1]?.statusCode, 412);
  assert.equal(remote.objects.size, 1);

  const appended: Array<{ id: string; digest: string }> = [];
  const result = await journal.replayAll(async (replayed, ref) => {
    appended.push({ id: replayed.id, digest: ref.digest });
  });
  assert.deepEqual(result, { scanned: 1, replayed: 1 });
  assert.deepEqual(appended, [{ id: log.id, digest: first.digest }]);
  assert.equal(remote.objects.has(first.objectKey), true);

  let failedOnce = false;
  await assert.rejects(
    journal.replayAll(async () => {
      failedOnce = true;
      throw new Error("simulated PostgreSQL outage");
    }),
    /simulated PostgreSQL outage/u
  );
  assert.equal(failedOnce, true);
  assert.deepEqual(
    await journal.replayAll(async (replayed, ref) => {
      assert.equal(replayed.id, log.id);
      assert.equal(ref.objectKey, first.objectKey);
    }),
    { scanned: 1, replayed: 1 }
  );
});

test("provider usage journal rejects conflict, tamper and cross-scope object keys", async (t) => {
  const remote = await fakeS3(t);
  const journal = new ProviderUsageTerminalJournal({
    store: remote.store,
    prefix: "journal",
    integrity
  });
  const log = usageLog();
  const ref = await journal.persist(log);

  await assert.rejects(
    journal.persist({ ...log, inputTokens: 999 }),
    ProviderUsageTerminalJournalIntegrityError
  );

  const original = remote.objects.get(ref.objectKey)!;
  const forged = JSON.parse(original.toString("utf8")) as {
    payload: ProviderUsageAttemptLog;
    payloadDigest: string;
  };
  forged.payload = { ...forged.payload, inputTokens: 8 };
  forged.payloadDigest = sha256Canonical(forged.payload);
  remote.objects.set(ref.objectKey, Buffer.from(canonicalJson(forged)));
  await assert.rejects(
    journal.replayAll(async () => {}),
    /integrity signature is invalid/u
  );

  const unknownKey = JSON.parse(original.toString("utf8")) as {
    integrity: { keyId: string };
  };
  unknownKey.integrity.keyId = "unknown-key";
  remote.objects.set(ref.objectKey, Buffer.from(canonicalJson(unknownKey)));
  await assert.rejects(
    journal.replayAll(async () => {}),
    /integrity key is not trusted/u
  );

  remote.objects.delete(ref.objectKey);
  const wrongKey = ref.objectKey.replace(/tenants\/[a-f0-9]{64}/u, `tenants/${"0".repeat(64)}`);
  remote.objects.set(wrongKey, original);
  await assert.rejects(
    journal.replayAll(async () => {}),
    /object key does not match its tenant\/run bindings/u
  );

  assert.throws(
    () => new ProviderUsageTerminalJournal({
      store: remote.store,
      prefix: "enterprise/../escape",
      integrity
    }),
    /prefix is unsafe/u
  );

  const missingTokens = { ...log } as Partial<ProviderUsageAttemptLog>;
  delete missingTokens.inputTokens;
  await assert.rejects(
    journal.persist(missingTokens as ProviderUsageAttemptLog),
    /inputTokens is invalid/u
  );
  await assert.rejects(
    journal.persist({
      ...log,
      candidateId: "",
      trustedAssociation: {
        ...log.trustedAssociation!,
        candidateId: ""
      }
    }),
    /candidateId is invalid/u
  );
});

test("provider usage journal fails closed when create-only S3 write fails", async (t) => {
  const remote = await fakeS3(t);
  remote.failPut = true;
  const journal = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  await assert.rejects(journal.persist(usageLog()), /HTTP 503/u);
  assert.equal(remote.objects.size, 0);
});

test("provider usage journal resolves 409, 5xx and transport ACK ambiguity by exact GET", async (t) => {
  const remote = await fakeS3(t);
  const journal = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  remote.nextPutOutcome = "commit-503";
  const committedDespite503 = await journal.persist(usageLog());
  assert.equal(remote.objects.has(committedDespite503.objectKey), true);

  remote.nextPutOutcome = "conflict-409";
  assert.deepEqual(await journal.persist(usageLog()), committedDespite503);

  const secondRemote = await fakeS3(t);
  const secondJournal = new ProviderUsageTerminalJournal({
    store: secondRemote.store,
    integrity
  });
  secondRemote.nextPutOutcome = "commit-reset";
  const committedDespiteReset = await secondJournal.persist(usageLog());
  assert.equal(secondRemote.objects.has(committedDespiteReset.objectKey), true);
});

test("provider usage journal verifies retired keys across rotation and rejects revoked keys", async (t) => {
  const remote = await fakeS3(t);
  const oldJournal = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  const log = usageLog();
  const oldRef = await oldJournal.persist(log);

  const rotated = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: {
      activeKeyId: "journal-2026-b",
      keys: [
        { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "retired" },
        { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "active" }
      ]
    }
  });
  assert.deepEqual(await rotated.persist(log), oldRef);
  assert.deepEqual(
    await rotated.replayAll(async (replayed) => assert.equal(replayed.id, log.id)),
    { scanned: 1, replayed: 1 }
  );

  const original = remote.objects.get(oldRef.objectKey)!;
  const aliased = JSON.parse(original.toString("utf8")) as {
    integrity: { keyId: string };
  };
  aliased.integrity.keyId = "journal-2026-b";
  remote.objects.set(oldRef.objectKey, Buffer.from(canonicalJson(aliased)));
  await assert.rejects(
    rotated.replayAll(async () => {}),
    /integrity signature is invalid/u
  );
  remote.objects.set(oldRef.objectKey, original);

  assert.throws(
    () => new ProviderUsageTerminalJournal({
      store: remote.store,
      integrity: {
        activeKeyId: "journal-2026-b",
        keys: [
          { id: "journal-2026-a", secret: NEW_JOURNAL_KEY, status: "retired" },
          { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "active" }
        ]
      }
    }),
    /must not alias the same secret/u
  );

  const revoked = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: {
      activeKeyId: "journal-2026-b",
      keys: [
        { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "revoked" },
        { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "active" }
      ]
    }
  });
  await assert.rejects(
    revoked.replayAll(async () => {}),
    /has no revocation checkpoint/u
  );
});

test("provider usage journal replays attempts in numeric lifecycle order", async (t) => {
  const remote = await fakeS3(t);
  const journal = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  for (let attempt = 10; attempt >= 1; attempt -= 1) {
    await journal.persist(usageLog(attempt, attempt === 10));
  }
  const indexes: number[] = [];
  await journal.replayAll(async (log) => {
    indexes.push(log.usageAttempt.index);
  });
  assert.deepEqual(indexes, Array.from({ length: 10 }, (_, index) => index + 1));
});

test("manual retired-key checkpoint authorizes revoked replay and remains immutable", async (t) => {
  const remote = await fakeS3(t);
  const writer = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  const log = usageLog();
  const journalRef = await writer.persist(log);
  const approver = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: retiredJournalProfile()
  });
  const approval = checkpointInput(journalRef.objectKey);
  remote.nextPutOutcome = "commit-503";
  const checkpoint = await approver.createRevocationCheckpoint(approval);
  assert.equal(checkpoint.journalObjectDigest, journalRef.digest);
  assert.equal(checkpoint.payloadDigest, journalRef.payloadDigest);
  assert.equal(checkpoint.journalIntegrityKeyId, "journal-2026-a");
  assert.equal(checkpoint.authorityKeyId, "journal-2026-b");
  assert.equal(checkpoint.approvalAuditEventId, approval.approvalAuditEventId);
  assert.equal(checkpoint.approvalAuditDigest, approval.approvalAuditDigest);
  assert.equal(checkpoint.evidenceDigest, approval.evidenceDigest);
  assert.equal(Object.isFrozen(checkpoint), true);

  remote.nextPutOutcome = "conflict-409";
  assert.deepEqual(await approver.createRevocationCheckpoint(approval), checkpoint);
  assert.deepEqual(await approver.createRevocationCheckpoint(approval), checkpoint);
  assert.equal(
    remote.puts.some((put) =>
      put.key === checkpoint.checkpointObjectKey && put.statusCode === 409
    ),
    true
  );
  assert.equal(
    remote.puts.some((put) =>
      put.key === checkpoint.checkpointObjectKey && put.statusCode === 412
    ),
    true
  );
  await assert.rejects(
    approver.createRevocationCheckpoint({
      ...approval,
      reason: "a conflicting human approval"
    }),
    /conflicting immutable content/u
  );

  const revoked = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: revokedJournalProfile()
  });
  let replayedRef: Parameters<Parameters<typeof revoked.replayAll>[0]>[1] | undefined;
  let replayedLog: ProviderUsageAttemptLog | undefined;
  assert.deepEqual(
    await revoked.replayAll(async (replayed, ref) => {
      replayedLog = replayed;
      replayedRef = ref;
    }),
    { scanned: 1, replayed: 1 }
  );
  assert.equal(replayedRef?.revocationCheckpoint?.checkpointDigest, checkpoint.checkpointDigest);
  assert.equal(replayedRef?.revocationCheckpoint?.authorityKeyId, "journal-2026-b");
  assert.equal(Object.isFrozen(replayedRef), true);
  assert.equal(Object.isFrozen(replayedRef?.revocationCheckpoint), true);
  assert.equal(Object.isFrozen(replayedLog), true);
  assert.equal(Object.isFrozen(replayedLog?.trustedAssociation), true);

  const checkpointObjects = [...remote.objects.keys()].filter((key) =>
    key.startsWith(`${approver.revocationCheckpointPrefix()}/`)
  );
  assert.deepEqual(checkpointObjects, [checkpoint.checkpointObjectKey]);
  const objectCount = remote.objects.size;
  const putCount = remote.puts.length;
  await revoked.replayAll(async () => {});
  assert.equal(remote.objects.size, objectCount);
  assert.equal(remote.puts.length, putCount);
  assert.equal(remote.objects.has(checkpoint.checkpointObjectKey), true);
});

test("checkpoint creation rejects active and already-revoked journal keys", async (t) => {
  const remote = await fakeS3(t);
  const active = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  const ref = await active.persist(usageLog());
  const approval = checkpointInput(ref.objectKey);
  await assert.rejects(
    active.createRevocationCheckpoint(approval),
    /require a retired journal key/u
  );

  const revoked = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: revokedJournalProfile()
  });
  await assert.rejects(
    revoked.createRevocationCheckpoint(approval),
    /require a retired journal key/u
  );
  assert.equal(
    [...remote.objects.keys()].some((key) =>
      key.startsWith(`${active.revocationCheckpointPrefix()}/`)
    ),
    false
  );
});

test("checkpoint tamper, forgery, wrong identity and audit evidence fail closed", async (t) => {
  const remote = await fakeS3(t);
  const writer = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  const firstRef = await writer.persist(usageLog());
  const secondRef = await writer.persist(usageLog(1, true, {
    tenantId: "tenant-b",
    runId: "run-b",
    candidateId: "candidate-b",
    logicalRequestId: "00000000-0000-4000-8000-000000000456"
  }));
  const approver = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: retiredJournalProfile()
  });
  const firstCheckpoint = await approver.createRevocationCheckpoint(
    checkpointInput(firstRef.objectKey)
  );
  const secondCheckpoint = await approver.createRevocationCheckpoint(
    checkpointInput(secondRef.objectKey, "audit-event-b")
  );
  const firstBytes = remote.objects.get(firstCheckpoint.checkpointObjectKey)!;
  const secondBytes = remote.objects.get(secondCheckpoint.checkpointObjectKey)!;
  const revoked = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: revokedJournalProfile()
  });
  let appendCount = 0;
  const replay = () => revoked.replayAll(async () => {
    appendCount += 1;
  });

  const badAudit = JSON.parse(firstBytes.toString("utf8")) as {
    approval: { approvalAuditDigest: string; evidenceDigest: string };
  };
  badAudit.approval.approvalAuditDigest = "e".repeat(64);
  badAudit.approval.evidenceDigest = "f".repeat(64);
  remote.objects.set(
    firstCheckpoint.checkpointObjectKey,
    Buffer.from(canonicalJson(badAudit))
  );
  await assert.rejects(replay(), /checkpoint digest is invalid/u);
  assert.equal(appendCount, 0);

  const forged = JSON.parse(firstBytes.toString("utf8")) as {
    integrity: { signature: string };
  };
  forged.integrity.signature = "A".repeat(43);
  remote.objects.set(
    firstCheckpoint.checkpointObjectKey,
    Buffer.from(canonicalJson(forged))
  );
  await assert.rejects(replay(), /checkpoint signature is invalid/u);
  assert.equal(appendCount, 0);

  remote.objects.set(firstCheckpoint.checkpointObjectKey, secondBytes);
  await assert.rejects(replay(), /checkpoint object key is invalid/u);
  assert.equal(appendCount, 0);

  remote.objects.set(
    firstCheckpoint.checkpointObjectKey,
    Buffer.concat([firstBytes, Buffer.from("\n")])
  );
  await assert.rejects(replay(), /checkpoint is not canonically encoded/u);
  assert.equal(appendCount, 0);
});

test("revoked checkpoint authority requires a new active authority sidecar", async (t) => {
  const remote = await fakeS3(t);
  const writer = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity
  });
  const ref = await writer.persist(usageLog());
  const firstApprover = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: {
      activeKeyId: "journal-2026-b",
      keys: [
        { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "retired" },
        { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "active" },
        { id: "journal-2026-c", secret: NEXT_JOURNAL_KEY, status: "revoked" }
      ]
    }
  });
  const firstCheckpoint = await firstApprover.createRevocationCheckpoint(
    checkpointInput(ref.objectKey)
  );
  const productionProfile = {
    activeKeyId: "journal-2026-c",
    keys: [
      { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "revoked" as const },
      { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "revoked" as const },
      { id: "journal-2026-c", secret: NEXT_JOURNAL_KEY, status: "active" as const }
    ]
  };
  const beforeResign = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: productionProfile
  });
  await assert.rejects(
    beforeResign.replayAll(async () => {}),
    /no checkpoint signed by a non-revoked authority/u
  );

  const newApprover = new ProviderUsageTerminalJournal({
    store: remote.store,
    integrity: {
      activeKeyId: "journal-2026-c",
      keys: [
        { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "retired" },
        { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "revoked" },
        { id: "journal-2026-c", secret: NEXT_JOURNAL_KEY, status: "active" }
      ]
    }
  });
  const secondCheckpoint = await newApprover.createRevocationCheckpoint(
    checkpointInput(ref.objectKey, "audit-event-c")
  );
  let authorityKeyId: string | undefined;
  await beforeResign.replayAll(async (_log, replayRef) => {
    authorityKeyId = replayRef.revocationCheckpoint?.authorityKeyId;
  });
  assert.equal(authorityKeyId, "journal-2026-c");
  assert.notEqual(secondCheckpoint.checkpointObjectKey, firstCheckpoint.checkpointObjectKey);
  assert.equal(remote.objects.has(firstCheckpoint.checkpointObjectKey), true);
  assert.equal(remote.objects.has(secondCheckpoint.checkpointObjectKey), true);
});

test("replay preflight prevents partial append for gaps, terminal successors and scope drift", async (t) => {
  await t.test("attempt gap", async (child) => {
    const remote = await fakeS3(child);
    const journal = new ProviderUsageTerminalJournal({ store: remote.store, integrity });
    await journal.persist(usageLog(1, false));
    await journal.persist(usageLog(3, true));
    let appended = 0;
    await assert.rejects(
      journal.replayAll(async () => { appended += 1; }),
      /not continuous from index 1/u
    );
    assert.equal(appended, 0);
  });

  await t.test("terminal successor", async (child) => {
    const remote = await fakeS3(child);
    const journal = new ProviderUsageTerminalJournal({ store: remote.store, integrity });
    await journal.persist(usageLog(1, true));
    await journal.persist(usageLog(2, true));
    let appended = 0;
    await assert.rejects(
      journal.replayAll(async () => { appended += 1; }),
      /terminal attempt has a successor/u
    );
    assert.equal(appended, 0);
  });

  await t.test("reservation scope drift", async (child) => {
    const remote = await fakeS3(child);
    const journal = new ProviderUsageTerminalJournal({ store: remote.store, integrity });
    await journal.persist(usageLog(1, false));
    await journal.persist(usageLog(2, true, { runId: "run-b" }));
    let appended = 0;
    await assert.rejects(
      journal.replayAll(async () => { appended += 1; }),
      /reservation bindings are inconsistent/u
    );
    assert.equal(appended, 0);
  });

  await t.test("different keys with the same attempt identity", async (child) => {
    const remote = await fakeS3(child);
    const journal = new ProviderUsageTerminalJournal({ store: remote.store, integrity });
    await journal.persist(usageLog(1, true));
    await journal.persist(usageLog(1, true, { runId: "run-b" }));
    let appended = 0;
    await assert.rejects(
      journal.replayAll(async () => { appended += 1; }),
      /conflicting attempt identities/u
    );
    assert.equal(appended, 0);
  });
});

test("replay deduplicates repeated list keys and rejects oversized objects", async (t) => {
  const remote = await fakeS3(t);
  const journal = new ProviderUsageTerminalJournal({ store: remote.store, integrity });
  await journal.persist(usageLog());
  remote.duplicateListEntries = true;
  let appended = 0;
  assert.deepEqual(
    await journal.replayAll(async () => { appended += 1; }),
    { scanned: 1, replayed: 1 }
  );
  assert.equal(appended, 1);

  remote.duplicateListEntries = false;
  remote.objects.set(
    `${journal.journalPrefix()}/oversized`,
    Buffer.alloc(4 * 1024 * 1024 + 1)
  );
  await assert.rejects(
    journal.replayAll(async () => {}),
    /exceeds the supported size limit/u
  );
});

test("profile status and replay/tool metadata are strict", async (t) => {
  const remote = await fakeS3(t);
  assert.throws(
    () => new ProviderUsageTerminalJournal({
      store: remote.store,
      integrity: {
        activeKeyId: "journal-2026-a",
        keys: [{ id: "journal-2026-a", secret: OLD_JOURNAL_KEY }]
      } as never
    }),
    /status must be explicit/u
  );
  assert.throws(
    () => new ProviderUsageTerminalJournal({
      store: remote.store,
      integrity: {
        activeKeyId: "journal-2026-a",
        keys: [
          { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "active" },
          { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "active" }
        ]
      }
    }),
    /exactly its declared active key/u
  );

  const journal = new ProviderUsageTerminalJournal({ store: remote.store, integrity });
  await assert.rejects(
    journal.persist({ ...usageLog(), replayed: "yes" } as unknown as ProviderUsageAttemptLog),
    /replayed flag is invalid/u
  );
  await assert.rejects(
    journal.persist({ ...usageLog(), containsToolCall: true }),
    /containsToolCall requires toolCalls/u
  );
  await assert.rejects(
    journal.persist({
      ...usageLog(),
      containsToolCall: true,
      toolCalls: [{ name: "tool", effect: "unknown", replaySafe: false, forged: true }]
    } as unknown as ProviderUsageAttemptLog),
    /toolCall contains unsupported fields/u
  );
});

function retiredJournalProfile() {
  return {
    activeKeyId: "journal-2026-b",
    keys: [
      { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "retired" as const },
      { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "active" as const }
    ]
  };
}

function revokedJournalProfile() {
  return {
    activeKeyId: "journal-2026-b",
    keys: [
      { id: "journal-2026-a", secret: OLD_JOURNAL_KEY, status: "revoked" as const },
      { id: "journal-2026-b", secret: NEW_JOURNAL_KEY, status: "active" as const }
    ]
  };
}

function checkpointInput(
  journalObjectKey: string,
  approvalAuditEventId = "audit-event-a"
): ProviderUsageTerminalJournalRevocationCheckpointInput {
  return {
    journalObjectKey,
    reason: "security-approved historical journal recovery",
    ticket: "SEC-1234",
    approvedBy: "security-admin@example.test",
    approvedAt: "2026-07-12T00:10:00.000Z",
    approvalAuditEventId,
    approvalAuditDigest: "c".repeat(64),
    evidenceDigest: "d".repeat(64)
  };
}

function usageLog(
  attemptIndex = 1,
  terminal = true,
  scope: Partial<{
    tenantId: string;
    runId: string;
    candidateId: string;
    logicalRequestId: string;
  }> = {}
): ProviderUsageAttemptLog {
  const logicalRequestId =
    scope.logicalRequestId ?? "00000000-0000-4000-8000-000000000123";
  const association = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    tenantId: scope.tenantId ?? "tenant-a",
    runId: scope.runId ?? "run-a",
    candidateId: scope.candidateId ?? "candidate-a",
    workerId: "worker-a",
    claimDigest: "a".repeat(64),
    receiptDigest: "b".repeat(64),
    reservationId: logicalRequestId,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T01:00:00.000Z",
    verifiedAt: "2026-07-12T00:00:01.000Z",
    providerPlan: {
      schemaVersion: 1 as const,
      projectId: "project-a",
      app: "codex" as const,
      providerIds: ["provider-a"],
      digest: "c".repeat(64)
    }
  };
  return {
    id: providerUsageAttemptLogId(logicalRequestId, attemptIndex),
    app: "codex",
    providerId: "provider-a",
    model: "model-a",
    inputTokens: 7,
    outputTokens: 2,
    statusCode: terminal ? 200 : 503,
    latencyMs: 15,
    runId: association.runId,
    candidateId: association.candidateId,
    trustedAssociation: association,
    usageAttempt: {
      schemaVersion: 1,
      logicalRequestId,
      index: attemptIndex,
      terminal,
      outcome: terminal ? "succeeded" : "failed",
      retryable: !terminal
    },
    createdAt: "2026-07-12T00:00:05.000Z"
  };
}

interface FakeS3 {
  readonly store: S3CompatibleArtifactStore;
  readonly objects: Map<string, Buffer>;
  readonly puts: Array<{
    key: string;
    ifNoneMatch?: string;
    statusCode: number;
  }>; 
  failPut: boolean;
  nextPutOutcome: "normal" | "commit-503" | "commit-reset" | "conflict-409";
  duplicateListEntries: boolean;
}

async function fakeS3(t: test.TestContext): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const puts: FakeS3["puts"] = [];
  const state: {
    failPut: boolean;
    nextPutOutcome: FakeS3["nextPutOutcome"];
    duplicateListEntries: boolean;
  } = {
    failPut: false,
    nextPutOutcome: "normal",
    duplicateListEntries: false
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const bucketPrefix = "/provider-journal/";
    if (url.pathname === "/provider-journal" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const matches = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      const listed = state.duplicateListEntries
        ? matches.flatMap((entry) => [entry, entry])
        : matches;
      response.statusCode = 200;
      response.setHeader("content-type", "application/xml");
      response.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        ...listed.map(([key, value]) =>
          `<Contents><Key>${xmlEscape(key)}</Key><Size>${value.byteLength}</Size></Contents>`
        ),
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (!url.pathname.startsWith(bucketPrefix)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(bucketPrefix.length));
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (state.failPut) {
        puts.push({ key, statusCode: 503 });
        response.statusCode = 503;
        response.end("<Error><Code>ServiceUnavailable</Code></Error>");
        return;
      }
      if (state.nextPutOutcome === "commit-503") {
        state.nextPutOutcome = "normal";
        objects.set(key, Buffer.concat(chunks));
        puts.push({ key, ifNoneMatch: "*", statusCode: 503 });
        response.statusCode = 503;
        response.end("<Error><Code>ServiceUnavailable</Code></Error>");
        return;
      }
      if (state.nextPutOutcome === "commit-reset") {
        state.nextPutOutcome = "normal";
        objects.set(key, Buffer.concat(chunks));
        puts.push({ key, ifNoneMatch: "*", statusCode: 0 });
        response.destroy();
        return;
      }
      if (state.nextPutOutcome === "conflict-409" && objects.has(key)) {
        state.nextPutOutcome = "normal";
        puts.push({ key, ifNoneMatch: "*", statusCode: 409 });
        response.statusCode = 409;
        response.end("<Error><Code>Conflict</Code></Error>");
        return;
      }
      if (request.headers["if-none-match"] === "*" && objects.has(key)) {
        puts.push({ key, ifNoneMatch: "*", statusCode: 412 });
        response.statusCode = 412;
        response.end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      objects.set(key, Buffer.concat(chunks));
      puts.push({
        key,
        ...(request.headers["if-none-match"]
          ? { ifNoneMatch: String(request.headers["if-none-match"]) }
          : {}),
        statusCode: 200
      });
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method === "GET") {
      const value = objects.get(key);
      if (!value) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.end(value);
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  await listen(server);
  t.after(() => close(server));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fake: FakeS3 = {
    store: new S3CompatibleArtifactStore({
      endpointUrl: `http://127.0.0.1:${address.port}`,
      bucket: "provider-journal"
    }),
    objects,
    puts,
    get failPut() {
      return state.failPut;
    },
    set failPut(value: boolean) {
      state.failPut = value;
    },
    get nextPutOutcome() {
      return state.nextPutOutcome;
    },
    set nextPutOutcome(value: FakeS3["nextPutOutcome"]) {
      state.nextPutOutcome = value;
    },
    get duplicateListEntries() {
      return state.duplicateListEntries;
    },
    set duplicateListEntries(value: boolean) {
      state.duplicateListEntries = value;
    }
  };
  return fake;
}

async function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
