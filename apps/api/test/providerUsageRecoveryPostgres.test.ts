import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { canonicalJson, sha256Canonical } from "@mn/governance";
import {
  providerUsageAttemptLogId,
  type PreparedProviderUsageIntent,
  type ProviderUsageAttemptLog,
  type ProviderUsageDispatchIntent,
  type ProviderUsageReservationDecision,
  type ProviderUsageUnknownIntent
} from "@mn/local-proxy";
import type { TrustedProxyUsageAssociation } from "@mn/provider-catalog";
import {
  EnterprisePostgresRuntime,
  PendingProviderUsageReservationsError
} from "../src/enterprisePostgres.js";
import { buildServer } from "../src/server.js";
import {
  createProviderUsageEvidenceVerifier,
  providerUsageEvidenceSigningPayload
} from "../src/providerUsageEvidenceTrust.js";

const connectionString = process.env.MN_TEST_POSTGRES_URL;
const ISSUER = "https://provider-recovery.example.test";
const AUDIENCE = "mn-enterprise";
const ORIGIN = "https://console.example.test";

test(
  "prepared provider requests recover only after claim loss and preserve unknown dispatch truth",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();
    await truncate(runtime);

    const active = await enqueueAndClaim(runtime, "run-prepared", "project-a");
    const first = await prepare(runtime, active, "run-prepared", "candidate-a");
    await assert.rejects(
      runtime.heartbeatClaim({
        runId: "run-prepared",
        ownerId: active.ownerId,
        claimToken: active.claimToken
      }),
      PendingProviderUsageReservationsError
    );
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-prepared"
    })).usageLogs.length, 0);

    // A mark transaction already waiting behind the reservation lock must win
    // before recovery can take the run UPDATE lock and inspect fresh evidence.
    const barrier = await runtime.pool.connect();
    await barrier.query("BEGIN");
    await barrier.query(
      "SELECT 1 FROM mn_run_jobs WHERE run_id=$1 FOR SHARE",
      ["run-prepared"]
    );
    await barrier.query(
      "SELECT 1 FROM mn_provider_usage_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR UPDATE",
      ["tenant-a", first.reserved.reservationId]
    );
    let markDone = false;
    let recoveryDone = false;
    const mark = runtime.markProviderUsageAttemptDispatchStarted(
      first.reserved,
      dispatch(first.intent, 1, "provider-a")
    ).then(() => { markDone = true; });
    const recovery = runtime.recoverPreDispatchProviderUsage({
      tenantId: "tenant-a",
      runId: "run-prepared"
    }).then((count) => {
      recoveryDone = true;
      return count;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(markDone, false);
    assert.equal(recoveryDone, false);
    await barrier.query("COMMIT");
    barrier.release();
    await mark;
    assert.equal(await recovery, 0);
    const dispatched = await runtime.readProviderUsageRequest({
      tenantId: "tenant-a",
      logicalRequestId: first.intent.logicalRequestId
    });
    assert.equal(
      dispatched?.lifecycle.filter((event) => event.type === "attempt_dispatch_started").length,
      1
    );

    await expireClaim(runtime, "run-prepared");
    const reclaimedUnknown = await runtime.claimRunJob(claimInput("worker-b"));
    assert.ok(reclaimedUnknown);
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-prepared"
    })).pendingReservations.length, 1);
    await assert.rejects(
      runtime.heartbeatClaim({
        runId: "run-prepared",
        ownerId: "worker-b",
        claimToken: reclaimedUnknown.claimToken
      }),
      PendingProviderUsageReservationsError
    );

    await truncate(runtime);
    const zeroClaim = await enqueueAndClaim(runtime, "run-zero", "project-a");
    const zero = await prepare(runtime, zeroClaim, "run-zero", "candidate-zero");
    await expireClaim(runtime, "run-zero");
    const reclaimedZero = await runtime.claimRunJob(claimInput("worker-b"));
    assert.ok(reclaimedZero);
    const zeroAccounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-zero"
    });
    assert.equal(zeroAccounting.pendingReservations.length, 0);
    assert.equal(zeroAccounting.usageLogs.length, 1);
    assert.equal(zeroAccounting.usageLogs[0]?.usageResolution?.kind, "pre_dispatch_zero");
    assert.equal(zeroAccounting.usageLogs[0]?.authoritativeCostUsd, 0);
    await assert.rejects(
      runtime.markProviderUsageAttemptDispatchStarted(
        zero.reserved,
        dispatch(zero.intent, 1, "provider-a")
      ),
      /current active claim|terminal/u
    );
    assert.ok(await runtime.heartbeatClaim({
      runId: "run-zero",
      ownerId: "worker-b",
      claimToken: reclaimedZero.claimToken
    }));

    await truncate(runtime);
    const fallbackClaim = await enqueueAndClaim(runtime, "run-fallback", "project-a");
    const fallback = await prepare(
      runtime,
      fallbackClaim,
      "run-fallback",
      "candidate-fallback"
    );
    await runtime.markProviderUsageAttemptDispatchStarted(
      fallback.reserved,
      dispatch(fallback.intent, 1, "provider-a")
    );
    await runtime.appendProviderUsageLog(attemptLog({
      association: fallback.reserved,
      intent: fallback.intent,
      attemptIndex: 1,
      providerId: "provider-a",
      terminal: false,
      inputTokens: 3,
      outputTokens: 1,
      statusCode: 500
    }));
    await expireClaim(runtime, "run-fallback");
    const reclaimedFallback = await runtime.claimRunJob(claimInput("worker-b"));
    assert.ok(reclaimedFallback);
    const fallbackAccounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-fallback"
    });
    assert.equal(fallbackAccounting.pendingReservations.length, 0);
    assert.deepEqual(
      fallbackAccounting.usageLogs.map((log) => ({
        index: (log as ProviderUsageAttemptLog).usageAttempt.index,
        terminal: (log as ProviderUsageAttemptLog).usageAttempt.terminal,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens
      })),
      [
        { index: 1, terminal: false, inputTokens: 3, outputTokens: 1 },
        { index: 2, terminal: true, inputTokens: 0, outputTokens: 0 }
      ]
    );
    await assert.rejects(
      runtime.pool.query(`
        UPDATE mn_provider_usage_lifecycle_events
        SET payload='{}'::jsonb WHERE tenant_id='tenant-a'
      `),
      /append-only/u
    );
    await assert.rejects(
      runtime.pool.query(`
        DELETE FROM mn_provider_usage_lifecycle_events WHERE tenant_id='tenant-a'
      `),
      /append-only/u
    );
  }
);

test(
  "org admin reconciles verified exact and conservative evidence with immediate audit projection",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();
    await truncate(runtime);
    const root = await mkdtemp(join(tmpdir(), "mn-provider-reconcile-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = authFixture();
    const evidenceAuthority = generateKeyPairSync("ed25519");
    const evidenceObjects = new Map<string, Buffer>();
    const app = buildServer({
      runtimeProfile: "enterprise",
      bindHost: "0.0.0.0",
      corsAllowlist: [ORIGIN],
      enterprisePostgres: { connectionString },
      telemetry: false,
      standardPackTrustProfile: false,
      providerUsageEvidenceTrustProfile: {
        schemaVersion: 1,
        issuers: [{
          issuer: "billing.example.test",
          providerIds: ["provider-a"],
          providerAccountIds: ["account-provider-a"],
          keys: [{
            keyId: "billing-2026",
            publicKey: evidenceAuthority.publicKey
              .export({ format: "pem", type: "spki" })
              .toString(),
            status: "active"
          }]
        }]
      },
      sandboxAttestationKey: false,
      enterpriseProjectRoots: false,
      artifactRemoteStore: {
        type: "s3",
        rootDir: join(root, "artifact-mirror"),
        bucket: "provider-evidence",
        prefix: "evidence",
        endpointUrl: "http://127.0.0.1:19999"
      },
      providerUsageEvidenceLoader: async ({ key }) => evidenceObjects.get(key),
      auth: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: `${ISSUER}/jwks`,
        fetchJwks: async () => ({ keys: [fixture.jwk] })
      },
      mniuRoot: join(root, "state"),
      useMockExecutors: true
    });
    t.after(() => app.close());
    await app.ready();

    const claim = await enqueueAndClaim(runtime, "run-reconcile", "project-a");
    const prepared = await prepare(
      runtime,
      claim,
      "run-reconcile",
      "candidate-reconcile",
      { maxTokens: 50, maxCostUsd: 3 }
    );
    await runtime.markProviderUsageAttemptDispatchStarted(
      prepared.reserved,
      dispatch(prepared.intent, 1, "provider-a")
    );
    const pending = await runtime.readProviderUsageRequest({
      tenantId: "tenant-a",
      logicalRequestId: prepared.intent.logicalRequestId
    });
    assert.ok(pending);
    const exactUnsigned = {
      schemaVersion: 2 as const,
      algorithm: "ed25519" as const,
      keyId: "billing-2026",
      issuer: "billing.example.test",
      claims: {
        kind: "invoice" as const,
        app: "codex" as const,
        tenantId: "tenant-a",
        runId: "run-reconcile",
        logicalRequestId: prepared.intent.logicalRequestId,
        providerId: "provider-a",
        providerAccountId: "account-provider-a",
        providerRequestId: "provider-request-0001",
        dispatchRequestDigest: prepared.intent.requestDigest,
        outboundRequestKeyDigest:
          prepared.intent.firstOutboundIdempotencyKeyDigest!,
        model: "model-a",
        statusCode: 200,
        tokens: {
          inputTokens: 7,
          outputTokens: 2,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          reasoningOutputTokens: 0
        },
        authoritativeCostUsd: 0.125,
        sourceReference: "invoice-2026-0001",
        issuedAt: new Date().toISOString()
      }
    };
    const exactEnvelope = {
      ...exactUnsigned,
      signature: sign(
        null,
        Buffer.from(providerUsageEvidenceSigningPayload(exactUnsigned)),
        evidenceAuthority.privateKey
      ).toString("base64url")
    };
    const exactBytes = Buffer.from(canonicalJson(exactEnvelope));
    const exactKey = evidenceKey("run-reconcile", prepared.intent.logicalRequestId, "exact.json");
    evidenceObjects.set(exactKey, exactBytes);
    const exactBody = {
      expectedRecoveryDigest: pending.recoveryDigest,
      decision: "exact",
      reason: "Matched the provider invoice",
      ticket: "FIN-1001",
      evidence: {
        uri: `s3://provider-evidence/${exactKey}`,
        sha256: sha256(exactBytes),
        kind: "invoice"
      },
      providerId: "provider-a",
      app: "codex",
      providerRequestId: "provider-request-0001",
      model: "model-a",
      statusCode: 200,
      inputTokens: 7,
      outputTokens: 2,
      authoritativeCostUsd: 0.125
    };
    const auditorHeaders = fixture.headers("tenant-a", ["auditor"]);
    const orgHeaders = fixture.headers("tenant-a", ["org_admin"]);
    const governanceHeaders = fixture.headers("tenant-a", ["governance_admin"]);
    const read = await app.inject({
      method: "GET",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}`,
      headers: auditorHeaders
    });
    assert.equal(read.statusCode, 200, read.body);
    const invalidEvidenceCases = [
      {
        name: "wrong bucket",
        expected: 400,
        body: {
          ...exactBody,
          evidence: {
            ...exactBody.evidence,
            uri: `s3://another-bucket/${exactKey}`
          }
        }
      },
      {
        name: "path traversal",
        expected: 400,
        body: {
          ...exactBody,
          evidence: {
            ...exactBody.evidence,
            uri: `s3://provider-evidence/evidence/tenants/tenant-a/runs/run-reconcile/provider-usage/${prepared.intent.logicalRequestId}/../escape.json`
          }
        }
      },
      {
        name: "missing object",
        expected: 400,
        body: {
          ...exactBody,
          evidence: {
            ...exactBody.evidence,
            uri: `s3://provider-evidence/${evidenceKey(
              "run-reconcile",
              prepared.intent.logicalRequestId,
              "missing.json"
            )}`
          }
        }
      }
    ];
    for (const [index, invalid] of invalidEvidenceCases.entries()) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
        headers: { ...orgHeaders, "idempotency-key": `invalid-${index}` },
        payload: invalid.body
      });
      assert.equal(response.statusCode, invalid.expected, invalid.name);
    }
    const tamperedKey = evidenceKey(
      "run-reconcile",
      prepared.intent.logicalRequestId,
      "tampered.json"
    );
    evidenceObjects.set(tamperedKey, Buffer.from("tampered"));
    const tampered = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...orgHeaders, "idempotency-key": "invalid-tampered" },
      payload: {
        ...exactBody,
        evidence: {
          ...exactBody.evidence,
          uri: `s3://provider-evidence/${tamperedKey}`
        }
      }
    });
    assert.equal(tampered.statusCode, 409);
    const extraEnvelopeKey = evidenceKey(
      "run-reconcile",
      prepared.intent.logicalRequestId,
      "extra-envelope.json"
    );
    const extraEnvelopeBytes = Buffer.from(JSON.stringify({ ...exactEnvelope, extra: true }));
    evidenceObjects.set(extraEnvelopeKey, extraEnvelopeBytes);
    const extraEnvelope = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...orgHeaders, "idempotency-key": "invalid-extra-envelope" },
      payload: {
        ...exactBody,
        evidence: {
          ...exactBody.evidence,
          uri: `s3://provider-evidence/${extraEnvelopeKey}`,
          sha256: sha256(extraEnvelopeBytes)
        }
      }
    });
    assert.equal(extraEnvelope.statusCode, 409);
    const mismatchKey = evidenceKey(
      "run-reconcile",
      prepared.intent.logicalRequestId,
      "mismatch-envelope.json"
    );
    const mismatchBytes = Buffer.from(JSON.stringify({
      ...exactEnvelope,
      tenantId: "tenant-b"
    }));
    evidenceObjects.set(mismatchKey, mismatchBytes);
    const mismatch = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...orgHeaders, "idempotency-key": "invalid-mismatch-envelope" },
      payload: {
        ...exactBody,
        evidence: {
          ...exactBody.evidence,
          uri: `s3://provider-evidence/${mismatchKey}`,
          sha256: sha256(mismatchBytes)
        }
      }
    });
    assert.equal(mismatch.statusCode, 409);
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-reconcile"
    })).usageLogs.length, 0);
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...governanceHeaders, "idempotency-key": "reconcile-exact" },
      payload: exactBody
    });
    assert.equal(forbidden.statusCode, 403);
    const workerForbidden = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: {
        ...fixture.workerHeaders("tenant-a"),
        "idempotency-key": "worker-reconcile"
      },
      payload: exactBody
    });
    assert.equal(workerForbidden.statusCode, 403);
    const exact = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...orgHeaders, "idempotency-key": "reconcile-exact" },
      payload: exactBody
    });
    assert.equal(exact.statusCode, 200, exact.body);
    assert.equal(exact.json().request.status, "finalized");
    // Evidence is re-read on retry. Its observation time is audit metadata,
    // not command semantics, so a later verification remains idempotent.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...orgHeaders, "idempotency-key": "reconcile-exact" },
      payload: exactBody
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    const idempotencyConflict = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...orgHeaders, "idempotency-key": "reconcile-exact" },
      payload: { ...exactBody, reason: "Conflicting retry payload" }
    });
    assert.equal(idempotencyConflict.statusCode, 409);
    assert.equal(idempotencyConflict.json().code, "idempotency_conflict");
    const staleCas = await app.inject({
      method: "POST",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}/reconcile`,
      headers: { ...orgHeaders, "idempotency-key": "reconcile-exact-stale" },
      payload: exactBody
    });
    assert.equal(staleCas.statusCode, 409);
    assert.equal(staleCas.json().code, "cas_conflict");
    const accounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-reconcile"
    });
    assert.equal(accounting.pendingReservations.length, 0);
    assert.equal(accounting.usageLogs[0]?.authoritativeCostUsd, 0.125);
    assert.ok(await runtime.heartbeatClaim({
      runId: "run-reconcile",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken
    }));
    const audit = await app.inject({
      method: "GET",
      url: "/v1/audit-events?actorId=admin%40example.test",
      headers: orgHeaders
    });
    assert.equal(audit.statusCode, 200, audit.body);
    const reconciliationAudit = audit.json().auditEvents.find(
      (event: { action: string }) => event.action === "provider_usage.reconcile"
    );
    assert.ok(reconciliationAudit);
    assert.equal(reconciliationAudit.beforeDigest, pending.recoveryDigest);
    assert.equal(reconciliationAudit.evidence.sha256, exactBody.evidence.sha256);
    assert.equal(reconciliationAudit.evidence.verification.sourceReference, "invoice-2026-0001");
    assert.equal(reconciliationAudit.actorId, "admin@example.test");

    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}`,
      headers: fixture.headers("tenant-b", ["auditor"])
    });
    assert.equal(otherTenant.statusCode, 404);
    const otherProject = await app.inject({
      method: "GET",
      url: `/v1/provider-usage/requests/${prepared.intent.logicalRequestId}`,
      headers: fixture.headers("tenant-a", ["auditor"], ["project-b"])
    });
    assert.equal(otherProject.statusCode, 404);

    const conservativeClaim = await enqueueAndClaim(runtime, "run-conservative", "project-a");
    const conservative = await prepare(
      runtime,
      conservativeClaim,
      "run-conservative",
      "candidate-conservative",
      { maxTokens: 90, maxCostUsd: 4.5 }
    );
    await runtime.markProviderUsageAttemptDispatchStarted(
      conservative.reserved,
      dispatch(conservative.intent, 1, "provider-a")
    );
    const conservativePending = await runtime.readProviderUsageRequest({
      tenantId: "tenant-a",
      logicalRequestId: conservative.intent.logicalRequestId
    });
    assert.ok(conservativePending);
    const conservativeBytes = Buffer.from("reviewed incident evidence");
    const conservativeKey = evidenceKey(
      "run-conservative",
      conservative.intent.logicalRequestId,
      "incident.txt"
    );
    evidenceObjects.set(conservativeKey, conservativeBytes);
    const conservativeBody = {
      expectedRecoveryDigest: conservativePending.recoveryDigest,
      decision: "conservative",
      reason: "Provider result is unknown",
      ticket: "INC-2002",
      evidence: {
        uri: `s3://provider-evidence/${conservativeKey}`,
        sha256: sha256(conservativeBytes),
        kind: "provider"
      }
    };
    const concurrent = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/provider-usage/requests/${conservative.intent.logicalRequestId}/reconcile`,
        headers: { ...orgHeaders, "idempotency-key": "reconcile-conservative-a" },
        payload: conservativeBody
      }),
      app.inject({
        method: "POST",
        url: `/v1/provider-usage/requests/${conservative.intent.logicalRequestId}/reconcile`,
        headers: { ...orgHeaders, "idempotency-key": "reconcile-conservative-b" },
        payload: conservativeBody
      })
    ]);
    assert.deepEqual(
      concurrent.map((response) => response.statusCode).sort(),
      [200, 409]
    );
    const conservativeAccounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-conservative"
    });
    assert.equal(conservativeAccounting.pendingReservations.length, 0);
    assert.equal(conservativeAccounting.usageLogs[0]?.inputTokens, 90);
    assert.equal(conservativeAccounting.usageLogs[0]?.authoritativeCostUsd, 4.5);
    assert.equal(
      conservativeAccounting.usageLogs[0]?.usageResolution?.requiresBudgetStop,
      true
    );
    assert.ok(await runtime.heartbeatClaim({
      runId: "run-conservative",
      ownerId: conservativeClaim.ownerId,
      claimToken: conservativeClaim.claimToken
    }));
    const checkpointPayload = { reconciled: true };
    const checkpointDigest = sha256Canonical(checkpointPayload);
    assert.ok(await runtime.checkpointClaim({
      runId: "run-conservative",
      ownerId: conservativeClaim.ownerId,
      claimToken: conservativeClaim.claimToken,
      payload: checkpointPayload,
      checkpointDigest,
      expectedCheckpointDigest: null
    }));
    assert.equal((await runtime.finishRunJob({
      runId: "run-conservative",
      ownerId: conservativeClaim.ownerId,
      claimToken: conservativeClaim.claimToken,
      status: "completed"
    }))?.status, "completed");
    const durableAudits = await runtime.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM mn_audit_events
      WHERE tenant_id='tenant-a' AND action='provider_usage.reconcile'
    `);
    assert.equal(Number(durableAudits.rows[0]?.count), 2);
    const reconciliationOutbox = await runtime.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM mn_outbox
      WHERE tenant_id='tenant-a' AND event_type='provider_usage.reconciled'
    `);
    assert.equal(Number(reconciliationOutbox.rows[0]?.count), 2);
  }
);

test(
  "dispatch rechecks the database clock after waiting for the reservation lock",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();

    for (const expiry of ["claim", "receipt"] as const) {
      await truncate(runtime);
      const runId = `run-dispatch-clock-${expiry}`;
      const claim = await enqueueAndClaim(runtime, runId, "project-a");
      const expiresAt = new Date(Date.now() + 800).toISOString();
      const { association, intent } = makePreparation(
        claim,
        runId,
        `candidate-${expiry}`,
        expiry === "receipt" ? { expiresAt } : {}
      );
      const reservedResult = await runtime.reserveProviderUsageAssociation(
        association,
        intent
      );
      if ("kind" in reservedResult) assert.fail("unexpected duplicate reservation");
      const reserved = reservedResult;
      if (expiry === "claim") {
        await runtime.pool.query(`
          UPDATE mn_run_jobs
          SET claim_expires_at=clock_timestamp() + interval '800 milliseconds'
          WHERE tenant_id='tenant-a' AND run_id=$1
        `, [runId]);
      }

      const barrier = await runtime.pool.connect();
      try {
        await barrier.query("BEGIN");
        await barrier.query(`
          SELECT 1 FROM mn_provider_usage_reservations
          WHERE tenant_id='tenant-a' AND reservation_id=$1
          FOR UPDATE
        `, [reserved.reservationId]);
        const mark = runtime.markProviderUsageAttemptDispatchStarted(
          reserved,
          dispatch(intent, 1, `provider-${expiry}`)
        );
        let earlyError: unknown;
        void mark.catch((error) => { earlyError = error; });
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (earlyError) throw earlyError;
        await waitForBlockedReservationLock(barrier);
        await new Promise((resolve) => setTimeout(resolve, 900));
        await barrier.query("COMMIT");
        await assert.rejects(mark, /current active claim/u);
      } finally {
        try {
          await barrier.query("ROLLBACK");
        } catch {
          // COMMIT above already completed on the expected path.
        }
        barrier.release();
      }

      const request = await runtime.readProviderUsageRequest({
        tenantId: "tenant-a",
        logicalRequestId: intent.logicalRequestId
      });
      assert.equal(
        request?.lifecycle.filter(
          (event) => event.type === "attempt_dispatch_started"
        ).length,
        0
      );
      assert.equal(request?.status, "pending");
    }
  }
);

test(
  "caller idempotency key is durable across concurrency and restart with semantic CAS",
  { skip: !connectionString },
  async (t) => {
    const initial = new EnterprisePostgresRuntime({ connectionString });
    await initial.migrate();
    await truncate(initial);
    const claim = await enqueueAndClaim(initial, "run-keyed", "project-a");
    const callerDigest = "1".repeat(64);
    const requests = Array.from({ length: 8 }, () => makePreparation(
      claim,
      "run-keyed",
      "candidate-keyed",
      { callerIdempotencyKeyDigest: callerDigest }
    ));
    const acquired = await Promise.all(requests.map(({ association, intent }) =>
      initial.reserveProviderUsageAssociation(association, intent)
    ));
    const createdIndex = acquired.findIndex((result) => !("kind" in result));
    assert.notEqual(createdIndex, -1);
    const created = acquired[createdIndex]!;
    if ("kind" in created) assert.fail("one caller must own the durable reservation");
    const decisions = acquired.filter(
      (result): result is ProviderUsageReservationDecision => "kind" in result
    );
    assert.equal(decisions.length, 7);
    assert.ok(decisions.every((decision) => decision.kind === "duplicate_pending"));
    assert.ok(decisions.every(
      (decision) => decision.logicalRequestId === created.reservationId
    ));
    const reservationCount = await initial.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM mn_provider_usage_reservations
      WHERE tenant_id='tenant-a' AND run_id='run-keyed'
    `);
    assert.equal(Number(reservationCount.rows[0]?.count), 1);
    await initial.close();

    const restarted = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => restarted.close());
    await restarted.migrate();
    const same = makePreparation(claim, "run-keyed", "candidate-keyed", {
      callerIdempotencyKeyDigest: callerDigest
    });
    const pendingRetry = await restarted.reserveProviderUsageAssociation(
      same.association,
      same.intent
    );
    assert.deepEqual(pendingRetry, {
      kind: "duplicate_pending",
      logicalRequestId: created.reservationId
    });
    const changed = makePreparation(claim, "run-keyed", "candidate-keyed", {
      callerIdempotencyKeyDigest: callerDigest,
      requestDigest: "9".repeat(64)
    });
    const conflict = await restarted.reserveProviderUsageAssociation(
      changed.association,
      changed.intent
    );
    assert.deepEqual(conflict, {
      kind: "conflict",
      logicalRequestId: created.reservationId
    });
    const changedPlan = makePreparation(claim, "run-keyed", "candidate-keyed", {
      callerIdempotencyKeyDigest: callerDigest,
      providerPlanDigest: "8".repeat(64)
    });
    assert.deepEqual(
      await restarted.reserveProviderUsageAssociation(
        changedPlan.association,
        changedPlan.intent
      ),
      { kind: "conflict", logicalRequestId: created.reservationId }
    );

    const createdIntent = requests[createdIndex]!.intent;
    const dispatchIntent = dispatch(createdIntent, 1, "provider-keyed");
    await restarted.markProviderUsageAttemptDispatchStarted(created, dispatchIntent);
    await restarted.appendProviderUsageLog(attemptLog({
      association: created,
      intent: createdIntent,
      attemptIndex: 1,
      providerId: "provider-keyed",
      terminal: true,
      inputTokens: 4,
      outputTokens: 2,
      statusCode: 200
    }));
    const finalizedRetry = await restarted.reserveProviderUsageAssociation(
      same.association,
      same.intent
    );
    assert.deepEqual(finalizedRetry, {
      kind: "duplicate_finalized",
      logicalRequestId: created.reservationId
    });
    const durable = await restarted.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "run-keyed"
    });
    assert.equal(durable.pendingReservations.length, 0);
    assert.equal(durable.finalizedReservations.length, 1);
    assert.equal(durable.usageLogs.length, 1);
    const dispatchCount = await restarted.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM mn_provider_usage_lifecycle_events
      WHERE tenant_id='tenant-a' AND event_type='attempt_dispatch_started'
    `);
    assert.equal(Number(dispatchCount.rows[0]?.count), 1);
  }
);

test(
  "unknown dispatch lifecycle remains pending and idempotent across restart",
  { skip: !connectionString },
  async (t) => {
    const initial = new EnterprisePostgresRuntime({ connectionString });
    await initial.migrate();
    await truncate(initial);
    const claim = await enqueueAndClaim(initial, "run-unknown", "project-a");
    const prepared = await prepare(
      initial,
      claim,
      "run-unknown",
      "candidate-unknown"
    );
    const dispatchIntent = dispatch(prepared.intent, 1, "provider-unknown");
    await initial.markProviderUsageAttemptDispatchStarted(
      prepared.reserved,
      dispatchIntent
    );
    const unknownIntent: ProviderUsageUnknownIntent = {
      ...dispatchIntent,
      reason: "timeout",
      observedAt: new Date().toISOString()
    };
    await initial.markProviderUsageAttemptUnknown(prepared.reserved, unknownIntent);
    await initial.markProviderUsageAttemptUnknown(prepared.reserved, unknownIntent);
    await assert.rejects(
      initial.markProviderUsageAttemptDispatchStarted(
        prepared.reserved,
        dispatchIntent
      ),
      /cannot retry an unknown attempt/u
    );
    const beforeRestart = await initial.readProviderUsageRequest({
      tenantId: "tenant-a",
      logicalRequestId: prepared.intent.logicalRequestId
    });
    assert.equal(beforeRestart?.status, "pending");
    assert.equal(beforeRestart?.usageLogs.length, 0);
    assert.equal(
      beforeRestart?.lifecycle.filter((event) => event.type === "attempt_unknown").length,
      1
    );
    await initial.close();

    const restarted = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => restarted.close());
    await restarted.migrate();
    const afterRestart = await restarted.readProviderUsageRequest({
      tenantId: "tenant-a",
      logicalRequestId: prepared.intent.logicalRequestId
    });
    assert.equal(afterRestart?.status, "pending");
    assert.equal(
      afterRestart?.lifecycle.filter((event) => event.type === "attempt_unknown").length,
      1
    );
    await assert.rejects(
      restarted.finishRunJob({
        runId: "run-unknown",
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        status: "completed"
      }),
      PendingProviderUsageReservationsError
    );
    const unknownOutbox = await restarted.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM mn_outbox
      WHERE tenant_id='tenant-a' AND event_type='provider_usage.attempt_unknown'
    `);
    assert.equal(Number(unknownOutbox.rows[0]?.count), 1);
  }
);

test(
  "pre-T035 pending reservation migrates with stable identity and only signed exact recovery",
  { skip: !connectionString },
  async (t) => {
    const bootstrap = new EnterprisePostgresRuntime({ connectionString });
    await bootstrap.migrate();
    await truncate(bootstrap);
    const claim = await enqueueAndClaim(
      bootstrap,
      "run-legacy-provider-usage",
      "project-legacy"
    );
    await bootstrap.pool.query(`
      DROP TABLE mn_provider_usage_lifecycle_events;
      DROP TABLE mn_provider_usage;
      DROP TABLE mn_provider_usage_reservations;
      CREATE TABLE mn_provider_usage_reservations (
        tenant_id text NOT NULL,
        reservation_id uuid NOT NULL,
        run_id text NOT NULL,
        candidate_id text NOT NULL,
        worker_id text NOT NULL,
        claim_token_hash char(64) NOT NULL,
        receipt_digest char(64) NOT NULL,
        verified_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        PRIMARY KEY (tenant_id,reservation_id)
      );
    `);
    const reservationId = randomUUID();
    const now = new Date();
    const legacyAssociation: TrustedProxyUsageAssociation = {
      schemaVersion: 1,
      issuer: "mn-api",
      tenantId: "tenant-a",
      runId: "run-legacy-provider-usage",
      candidateId: "candidate-legacy",
      workerId: claim.ownerId,
      claimDigest: claim.claimDigest,
      receiptDigest: "9".repeat(64),
      reservationId,
      issuedAt: new Date(now.getTime() - 1_000).toISOString(),
      verifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString()
    };
    await bootstrap.pool.query(`
      INSERT INTO mn_provider_usage_reservations
        (tenant_id,reservation_id,run_id,candidate_id,worker_id,
         claim_token_hash,receipt_digest,verified_at,expires_at,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [
      legacyAssociation.tenantId,
      reservationId,
      legacyAssociation.runId,
      legacyAssociation.candidateId,
      legacyAssociation.workerId,
      legacyAssociation.claimDigest,
      legacyAssociation.receiptDigest,
      legacyAssociation.verifiedAt,
      legacyAssociation.expiresAt,
      JSON.stringify(legacyAssociation)
    ]);
    await bootstrap.close();

    const restarted = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => restarted.close());
    await restarted.migrate();
    const pending = await restarted.readProviderUsageRequest({
      tenantId: "tenant-a",
      logicalRequestId: reservationId
    });
    assert.ok(pending);
    assert.equal(pending.legacy, true);
    assert.equal(pending.logicalRequestId, reservationId);
    assert.equal(pending.status, "pending");
    assert.equal(
      await restarted.recoverPreDispatchProviderUsage({
        tenantId: "tenant-a",
        runId: legacyAssociation.runId
      }),
      0
    );

    const evidenceAuthority = generateKeyPairSync("ed25519");
    const trustProfile = {
      schemaVersion: 1 as const,
      issuers: [{
        issuer: "legacy-billing.example.test",
        providerIds: ["provider-legacy"],
        providerAccountIds: ["account-legacy"],
        keys: [{
          keyId: "legacy-billing-2026",
          publicKey: evidenceAuthority.publicKey
            .export({ format: "pem", type: "spki" as const })
            .toString(),
          status: "active" as const
        }]
      }]
    };
    const unsigned = {
      schemaVersion: 2 as const,
      algorithm: "ed25519" as const,
      keyId: "legacy-billing-2026",
      issuer: "legacy-billing.example.test",
      claims: {
        kind: "invoice" as const,
        app: "codex" as const,
        tenantId: "tenant-a",
        runId: legacyAssociation.runId,
        logicalRequestId: reservationId,
        providerId: "provider-legacy",
        providerAccountId: "account-legacy",
        providerRequestId: "provider-request-legacy-1",
        dispatchRequestDigest: pending.recoveryDigest,
        model: "legacy-model",
        statusCode: 200,
        tokens: {
          inputTokens: 11,
          outputTokens: 3,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          reasoningOutputTokens: 1
        },
        authoritativeCostUsd: 0.42,
        sourceReference: "invoice-legacy-2026-1",
        issuedAt: new Date().toISOString()
      }
    };
    const envelope = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(providerUsageEvidenceSigningPayload(unsigned)),
        evidenceAuthority.privateKey
      ).toString("base64url")
    };
    const { issuedAt: _issuedAt, ...expectedLegacyClaims } = unsigned.claims;
    const verified = createProviderUsageEvidenceVerifier(trustProfile).verify(
      envelope,
      {
        ...expectedLegacyClaims,
        verificationTime: new Date().toISOString()
      }
    );
    const evidenceBytes = Buffer.from(canonicalJson(envelope));
    const evidence = {
      uri: `s3://legacy-evidence/tenants/tenant-a/runs/${legacyAssociation.runId}/provider-usage/${reservationId}/invoice.json`,
      sha256: sha256(evidenceBytes),
      kind: "invoice" as const,
      verification: {
        objectKey: `tenants/tenant-a/runs/${legacyAssociation.runId}/provider-usage/${reservationId}/invoice.json`,
        byteLength: evidenceBytes.byteLength,
        verifiedAt: new Date().toISOString(),
        verificationDigest: sha256Canonical({ envelope, verified }),
        envelopeDigest: sha256Canonical(envelope),
        sourceReference: verified.claims.sourceReference,
        issuedAt: verified.claims.issuedAt,
        issuer: verified.issuer,
        keyId: verified.keyId,
        signatureDigest: verified.signatureDigest,
        providerAccountId: verified.claims.providerAccountId,
        providerRequestId: verified.claims.providerRequestId,
        dispatchRequestDigest: verified.claims.dispatchRequestDigest
      }
    };
    await assert.rejects(
      restarted.reconcileProviderUsageRequest({
        tenantId: "tenant-a",
        logicalRequestId: reservationId,
        expectedRecoveryDigest: pending.recoveryDigest,
        idempotencyKey: "legacy-conservative-rejected",
        actorId: "legacy-admin",
        traceId: "trace-legacy-conservative",
        reason: "Unknown legacy callback",
        ticket: "LEGACY-1",
        evidence,
        decision: { kind: "conservative" }
      }),
      /machine pre-dispatch recovery/u
    );
    const reconciled = await restarted.reconcileProviderUsageRequest({
      tenantId: "tenant-a",
      logicalRequestId: reservationId,
      expectedRecoveryDigest: pending.recoveryDigest,
      idempotencyKey: "legacy-signed-exact",
      actorId: "legacy-admin",
      traceId: "trace-legacy-exact",
      reason: "Verified historical invoice",
      ticket: "LEGACY-2",
      evidence,
      decision: {
        kind: "exact",
        app: verified.claims.app,
        providerId: verified.claims.providerId,
        model: verified.claims.model,
        statusCode: verified.claims.statusCode,
        inputTokens: verified.claims.tokens.inputTokens,
        outputTokens: verified.claims.tokens.outputTokens,
        cachedInputTokens: verified.claims.tokens.cachedInputTokens,
        cacheCreationInputTokens:
          verified.claims.tokens.cacheCreationInputTokens,
        cacheReadInputTokens: verified.claims.tokens.cacheReadInputTokens,
        reasoningOutputTokens: verified.claims.tokens.reasoningOutputTokens,
        authoritativeCostUsd: verified.claims.authoritativeCostUsd
      }
    });
    assert.equal(reconciled?.request.status, "finalized");
    assert.equal(reconciled?.request.legacy, true);
    const accounting = await restarted.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: legacyAssociation.runId
    });
    assert.equal(accounting.pendingReservations.length, 0);
    assert.equal(accounting.usageLogs.length, 1);
    assert.equal(accounting.usageLogs[0]?.inputTokens, 11);
    assert.equal(accounting.usageLogs[0]?.authoritativeCostUsd, 0.42);
    const immutableLegacy = await restarted.pool.query<{
      logical_request_id: string | null;
    }>(`
      SELECT logical_request_id FROM mn_provider_usage_reservations
      WHERE tenant_id='tenant-a' AND reservation_id=$1
    `, [reservationId]);
    assert.equal(immutableLegacy.rows[0]?.logical_request_id, null);
  }
);

async function truncate(runtime: EnterprisePostgresRuntime): Promise<void> {
  await runtime.pool.query(
    "TRUNCATE mn_provider_usage_lifecycle_events, mn_provider_usage, mn_provider_usage_reservations, mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata, mn_health_probe RESTART IDENTITY"
  );
}

function claimInput(ownerId: string) {
  return {
    ownerId,
    capabilities: {
      tenantIds: ["tenant-a"],
      sandboxBackends: [{
        backendId: "enterprise-container",
        enforcement: "enforced" as const,
        capabilities: []
      }]
    },
    ttlMs: 60_000
  };
}

async function enqueueAndClaim(
  runtime: EnterprisePostgresRuntime,
  runId: string,
  projectId: string
) {
  await runtime.enqueueRunJob({
    runId,
    tenantId: "tenant-a",
    projectId,
    taskId: `task-${runId}`,
    payload: { workflow: "governed-increment-v1" }
  });
  const claim = await runtime.claimRunJob(claimInput("worker-a"));
  assert.ok(claim?.item.claimTokenHash);
  return {
    ownerId: "worker-a",
    claimToken: claim.claimToken,
    claimDigest: claim.item.claimTokenHash
  };
}

async function prepare(
  runtime: EnterprisePostgresRuntime,
  claim: { ownerId: string; claimDigest: string },
  runId: string,
  candidateId: string,
  hold: { maxTokens: number; maxCostUsd: number } = {
    maxTokens: 100,
    maxCostUsd: 5
  }
) {
  const { association, intent } = makePreparation(
    claim,
    runId,
    candidateId,
    { hold }
  );
  const reserved = await runtime.reserveProviderUsageAssociation(association, intent);
  if ("kind" in reserved) assert.fail(`unexpected reservation decision: ${reserved.kind}`);
  return { intent, reserved };
}

function makePreparation(
  claim: { ownerId: string; claimDigest: string },
  runId: string,
  candidateId: string,
  options: {
    logicalRequestId?: string;
    callerIdempotencyKeyDigest?: string;
    requestDigest?: string;
    providerPlanDigest?: string;
    expiresAt?: string;
    hold?: { maxTokens: number; maxCostUsd: number };
  } = {}
) {
  const now = new Date();
  const association: TrustedProxyUsageAssociation = {
    schemaVersion: 1,
    issuer: "mn-api",
    tenantId: "tenant-a",
    runId,
    candidateId,
    workerId: claim.ownerId,
    claimDigest: claim.claimDigest,
    receiptDigest: "a".repeat(64),
    issuedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: options.expiresAt ?? new Date(now.getTime() + 300_000).toISOString(),
    verifiedAt: now.toISOString()
  };
  const logicalRequestId = options.logicalRequestId ?? randomUUID();
  const hold = options.hold ?? { maxTokens: 100, maxCostUsd: 5 };
  const intent: PreparedProviderUsageIntent = {
    schemaVersion: 1,
    logicalRequestId,
    app: "codex",
    model: "model-a",
    requestDigest: options.requestDigest ?? "b".repeat(64),
    providerPlanDigest: options.providerPlanDigest ?? "c".repeat(64),
    ...(options.callerIdempotencyKeyDigest
      ? { callerIdempotencyKeyDigest: options.callerIdempotencyKeyDigest }
      : {}),
    firstOutboundIdempotencyKeyDigest: "d".repeat(64),
    preparedAt: new Date(now.getTime() + 1).toISOString(),
    conservativeHold: {
      ...hold,
      basisDigest: "e".repeat(64)
    }
  };
  return { association, intent };
}

function dispatch(
  intent: PreparedProviderUsageIntent,
  attemptIndex: number,
  providerId: string
): ProviderUsageDispatchIntent {
  return {
    schemaVersion: 1,
    logicalRequestId: intent.logicalRequestId,
    attemptIndex,
    providerId,
    providerAccountId: `account-${providerId}`,
    model: intent.model,
    requestDigest: intent.requestDigest,
    outboundIdempotencyKeyDigest:
      attemptIndex === 1
        ? intent.firstOutboundIdempotencyKeyDigest
        : "f".repeat(64),
    startedAt: new Date().toISOString()
  };
}

function attemptLog(input: {
  association: TrustedProxyUsageAssociation;
  intent: PreparedProviderUsageIntent;
  attemptIndex: number;
  providerId: string;
  terminal: boolean;
  inputTokens: number;
  outputTokens: number;
  statusCode: number;
}): ProviderUsageAttemptLog {
  return {
    id: providerUsageAttemptLogId(input.intent.logicalRequestId, input.attemptIndex),
    app: input.intent.app,
    providerId: input.providerId,
    model: input.intent.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    statusCode: input.statusCode,
    latencyMs: 1,
    runId: input.association.runId,
    candidateId: input.association.candidateId,
    trustedAssociation: input.association,
    usageAttempt: {
      schemaVersion: 1,
      logicalRequestId: input.intent.logicalRequestId,
      index: input.attemptIndex,
      terminal: input.terminal,
      outcome: "failed",
      retryable: !input.terminal
    },
    createdAt: new Date().toISOString()
  };
}

async function expireClaim(runtime: EnterprisePostgresRuntime, runId: string): Promise<void> {
  await runtime.pool.query(`
    UPDATE mn_run_jobs SET claim_expires_at=clock_timestamp() - interval '1 millisecond'
    WHERE run_id=$1
  `, [runId]);
}

async function waitForBlockedReservationLock(
  client: PoolClient
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const waiting = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_stat_activity
      WHERE datname=current_database()
        AND state='active'
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND query LIKE '%mn_provider_usage_reservations%'
    `);
    if (Number(waiting.rows[0]?.count ?? "0") > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const diagnostic = await client.query(`
    SELECT pid,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity WHERE datname=current_database()
  `);
  assert.fail(
    `dispatch did not block on the reservation row before expiry: ${JSON.stringify(diagnostic.rows)}`
  );
}

function evidenceKey(runId: string, logicalRequestId: string, file: string): string {
  return `evidence/tenants/tenant-a/runs/${runId}/provider-usage/${logicalRequestId}/${file}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const jwk = {
    ...publicJwk,
    kid: "provider-usage-recovery",
    use: "sig",
    alg: "RS256"
  };
  const token = (
    tenantId: string,
    roles: string[],
    projectIds: string[] = [],
    principalType: "human" | "worker" = "human"
  ) => {
    const header = Buffer.from(JSON.stringify({
      alg: "RS256",
      kid: jwk.kid,
      typ: "JWT"
    })).toString("base64url");
    const subject = principalType === "worker"
      ? "worker-machine"
      : roles.includes("org_admin")
      ? "admin@example.test"
      : `${roles[0] ?? "human"}@example.test`;
    const payload = Buffer.from(JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: subject,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      tenant_id: tenantId,
      roles,
      project_ids: projectIds,
      principal_type: principalType,
      scopes: principalType === "worker" ? ["run_jobs:claim"] : []
    })).toString("base64url");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      pair.privateKey
    ).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  return {
    jwk,
    headers: (tenantId: string, roles: string[], projectIds: string[] = []) => ({
      origin: ORIGIN,
      authorization: `Bearer ${token(tenantId, roles, projectIds)}`
    }),
    workerHeaders: (tenantId: string) => ({
      origin: ORIGIN,
      authorization: `Bearer ${token(tenantId, [], [], "worker")}`
    })
  };
}
