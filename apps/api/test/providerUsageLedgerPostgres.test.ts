import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { sha256Canonical } from "@mn/governance";
import {
  LocalProxyServer,
  type ProviderUsageAttemptLog
} from "@mn/local-proxy";
import type { ProviderRecord, ProxyRequestLog } from "@mn/provider-catalog";
import { FileLocalStore } from "@mn/store";
import { Pool } from "pg";
import { EnterprisePostgresRuntime } from "../src/enterprisePostgres.js";
import {
  issueProviderUsageReceipt,
  verifyProviderUsageReceipt
} from "../src/providerUsageReceipt.js";
import { buildServer } from "../src/server.js";

const connectionString = process.env.MN_TEST_POSTGRES_URL;
const ISSUER = "https://provider-usage.example.test";
const AUDIENCE = "mn-enterprise";
const ORIGIN = "https://console.example.test";

test(
  "PostgreSQL pending usage survives reclaim and blocks heartbeat, checkpoint and finish",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_provider_usage_lifecycle_events, mn_provider_usage, mn_provider_usage_reservations, mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata, mn_health_probe RESTART IDENTITY"
    );
    const root = await mkdtemp(join(tmpdir(), "mn-provider-usage-routes-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = authFixture();
    const app = buildServer({
      runtimeProfile: "enterprise",
      bindHost: "0.0.0.0",
      corsAllowlist: [ORIGIN],
      enterprisePostgres: { connectionString },
      telemetry: false,
      standardPackTrustProfile: false,
      sandboxAttestationKey: false,
      enterpriseProjectRoots: false,
      artifactRemoteStore: {
        type: "s3",
        rootDir: join(root, "artifact-mirror"),
        bucket: "mn-provider-usage-test",
        endpointUrl: "http://127.0.0.1:19000"
      },
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
    const headers = {
      origin: ORIGIN,
      authorization: `Bearer ${fixture.token("tenant-a")}`
    };
    await runtime.enqueueRunJob({
      runId: "usage-run-a",
      tenantId: "tenant-a",
      projectId: "project-a",
      taskId: "task-a",
      payload: { workflow: "governed-increment-v1" }
    });
    const first = await runtime.claimRunJob({
      ownerId: "worker-a",
      capabilities: {
        tenantIds: ["tenant-a"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 60_000
    });
    assert.ok(first?.item.claimTokenHash);
    const oldLog = usageLog("request-old", first.item.claimTokenHash, {});
    oldLog.trustedAssociation = await runtime.reserveProviderUsageAssociation(
      oldLog.trustedAssociation!
    );
    const reservationId = oldLog.trustedAssociation.reservationId!;
    const initialAccounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-a"
    });
    assert.equal(initialAccounting.usageLogs.length, 0);
    assert.equal(initialAccounting.finalizedReservations.length, 0);
    assert.deepEqual(
      initialAccounting.pendingReservations.map((pending) => ({
        status: pending.status,
        reservationId: pending.reservationId,
        claimDigest: pending.claimDigest
      })),
      [{
        status: "pending",
        reservationId,
        claimDigest: first.item.claimTokenHash
      }]
    );
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-b",
      runId: "usage-run-a"
    })).pendingReservations.length, 0);
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-b"
    })).pendingReservations.length, 0);
    for (const url of [
      "/v1/proxy/logs?runId=usage-run-a&app=codex",
      "/v1/usage/summary?runId=usage-run-a&app=codex",
      "/v1/usage/requests?runId=usage-run-a&app=codex",
      "/v1/usage/models?runId=usage-run-a&app=codex"
    ]) {
      const response = await app.inject({ method: "GET", url, headers });
      assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
      assert.equal(response.json().accounting.status, "pending");
      assert.equal(response.json().accounting.pendingReservationCount, 1);
      assert.equal(
        response.json().accounting.pendingReservations[0].reservationId,
        reservationId
      );
    }
    const pendingAudit = await waitForHttpAudit(runtime.pool, {
      tenantId: "tenant-a",
      action: "GET /v1/usage/summary"
    });
    assert.deepEqual(pendingAudit, {
      policy_decision: "deny",
      result: "failure",
      status_code: 409
    });
    await assert.rejects(
      runtime.heartbeatClaim({
        runId: "usage-run-a",
        ownerId: "worker-a",
        claimToken: first.claimToken
      }),
      /pending reservation/u
    );

    // Simulate a worker crash: the first lease expires without releasing or
    // finalizing its reserved provider request, then another lease reclaims it.
    await runtime.pool.query(`
      UPDATE mn_run_jobs
      SET claim_expires_at=clock_timestamp() - interval '1 millisecond'
      WHERE run_id=$1
    `, ["usage-run-a"]);
    const second = await runtime.claimRunJob({
      ownerId: "worker-a",
      capabilities: {
        tenantIds: ["tenant-a"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 60_000
    });
    assert.ok(second?.item.claimTokenHash);
    assert.notEqual(second.item.claimTokenHash, first.item.claimTokenHash);
    const reclaimedAccounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-a"
    });
    assert.deepEqual(
      reclaimedAccounting.pendingReservations.map((pending) => ({
        reservationId: pending.reservationId,
        claimDigest: pending.claimDigest
      })),
      [{ reservationId, claimDigest: first.item.claimTokenHash }]
    );
    await assert.rejects(
      runtime.heartbeatClaim({
        runId: "usage-run-a",
        ownerId: "worker-a",
        claimToken: second.claimToken
      }),
      /pending reservation/u
    );
    // The request was authorized before release, so its eventual provider
    // response must remain countable after a reclaim.
    await runtime.appendProviderUsageLog(oldLog);
    await runtime.appendProviderUsageLog(oldLog);
    const finalizedAccounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-a"
    });
    assert.equal(finalizedAccounting.usageLogs.length, 1);
    assert.equal(finalizedAccounting.pendingReservations.length, 0);
    assert.deepEqual(
      finalizedAccounting.finalizedReservations.map((finalized) => ({
        status: finalized.status,
        reservationId: finalized.reservationId,
        requestId: finalized.requestId
      })),
      [{ status: "finalized", reservationId, requestId: oldLog.id }]
    );
    const settledProxy = await app.inject({
      method: "GET",
      url: "/v1/proxy/logs?runId=usage-run-a&app=codex",
      headers
    });
    assert.equal(settledProxy.statusCode, 200, settledProxy.body);
    assert.equal(settledProxy.json().accounting.status, "settled");
    assert.equal(settledProxy.json().logs.length, 1);
    assert.equal(settledProxy.json().logs[0].id, oldLog.id);
    const settledSummary = await app.inject({
      method: "GET",
      url: "/v1/usage/summary?runId=usage-run-a&app=codex",
      headers
    });
    assert.equal(settledSummary.statusCode, 200, settledSummary.body);
    assert.equal(settledSummary.json().accounting.status, "settled");
    assert.equal(settledSummary.json().summary.requestCount, 1);
    assert.equal(settledSummary.json().summary.inputTokens, 2);
    assert.equal(settledSummary.json().summary.outputTokens, 1);
    const settledRequests = await app.inject({
      method: "GET",
      url: "/v1/usage/requests?runId=usage-run-a&app=codex",
      headers
    });
    assert.equal(settledRequests.statusCode, 200, settledRequests.body);
    assert.equal(settledRequests.json().accounting.status, "settled");
    assert.equal(settledRequests.json().requests[0].id, oldLog.id);
    const settledModels = await app.inject({
      method: "GET",
      url: "/v1/usage/models?runId=usage-run-a&app=codex",
      headers
    });
    assert.equal(settledModels.statusCode, 200, settledModels.body);
    assert.equal(settledModels.json().accounting.status, "settled");
    assert.equal(settledModels.json().models[0].model, "model-a");
    assert.equal(settledModels.json().models[0].totalTokens, 3);
    const otherTenantSummary = await app.inject({
      method: "GET",
      url: "/v1/usage/summary?runId=usage-run-a",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${fixture.token("tenant-b")}`
      }
    });
    assert.equal(otherTenantSummary.statusCode, 200, otherTenantSummary.body);
    assert.equal(otherTenantSummary.json().accounting.status, "settled");
    assert.equal(otherTenantSummary.json().summary.requestCount, 0);
    const otherProjectSummary = await app.inject({
      method: "GET",
      url: "/v1/usage/summary?runId=usage-run-a",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${fixture.token("tenant-a", ["project-b"])}`
      }
    });
    assert.equal(otherProjectSummary.statusCode, 200, otherProjectSummary.body);
    assert.equal(otherProjectSummary.json().accounting.status, "settled");
    assert.equal(otherProjectSummary.json().summary.requestCount, 0);
    assert.ok(await runtime.heartbeatClaim({
      runId: "usage-run-a",
      ownerId: "worker-a",
      claimToken: second.claimToken
    }));
    await assert.rejects(
      runtime.reserveProviderUsageAssociation(
        usageLog("request-old-replay", first.item.claimTokenHash, {
          runId: "usage-run-a"
        }).trustedAssociation!
      ),
      /current active claim/u
    );
    const crossRun = usageLog("request-cross-run", second.item.claimTokenHash, {});
    crossRun.trustedAssociation = await runtime.reserveProviderUsageAssociation(
      crossRun.trustedAssociation!
    );
    const authorizedCrossRun = structuredClone(crossRun);
    crossRun.runId = "usage-run-b";
    await assert.rejects(
      runtime.appendProviderUsageLog(crossRun),
      /association is inconsistent/u
    );
    const canonicalCrossRun = structuredClone(authorizedCrossRun);
    canonicalCrossRun.runId = "usage-run-b";
    canonicalCrossRun.trustedAssociation = {
      ...canonicalCrossRun.trustedAssociation!,
      runId: "usage-run-b"
    };
    await assert.rejects(
      runtime.appendProviderUsageLog(canonicalCrossRun),
      /no matching preauthorized reservation/u
    );
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-a"
    })).pendingReservations.length, 1);
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-b"
    })).pendingReservations.length, 0);
    await runtime.appendProviderUsageLog(authorizedCrossRun);
    await assert.rejects(
      runtime.appendProviderUsageLog({
        ...structuredClone(authorizedCrossRun),
        id: "request-reservation-reuse"
      }),
      /idempotency conflict/u
    );

    await runtime.enqueueRunJob({
      runId: "usage-run-finish",
      tenantId: "tenant-a",
      projectId: "project-a",
      taskId: "task-finish",
      payload: { workflow: "governed-increment-v1" }
    });
    const finishClaim = await runtime.claimRunJob({
      ownerId: "worker-finish",
      capabilities: {
        tenantIds: ["tenant-a"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 60_000
    });
    assert.equal(finishClaim?.item.runId, "usage-run-finish");
    assert.ok(finishClaim?.item.claimTokenHash);
    const finishLog = usageLog("request-finish", finishClaim.item.claimTokenHash, {
      runId: "usage-run-finish",
      workerId: "worker-finish",
      candidateId: "codex-finish"
    });
    finishLog.trustedAssociation = await runtime.reserveProviderUsageAssociation(
      finishLog.trustedAssociation!
    );
    const checkpointPayload = {
      version: 1,
      run: { id: "usage-run-finish", status: "running" }
    };
    const checkpointDigest = sha256Canonical(checkpointPayload);
    await assert.rejects(
      runtime.checkpointClaim({
        runId: "usage-run-finish",
        ownerId: "worker-finish",
        claimToken: finishClaim.claimToken,
        payload: checkpointPayload,
        checkpointDigest,
        expectedCheckpointDigest: null
      }),
      /pending reservation/u
    );
    await assert.rejects(
      runtime.finishRunJob({
        runId: "usage-run-finish",
        ownerId: "worker-finish",
        claimToken: finishClaim.claimToken,
        status: "completed"
      }),
      /pending reservation/u
    );
    await runtime.appendProviderUsageLog(finishLog);
    assert.ok(await runtime.checkpointClaim({
      runId: "usage-run-finish",
      ownerId: "worker-finish",
      claimToken: finishClaim.claimToken,
      payload: checkpointPayload,
      checkpointDigest,
      expectedCheckpointDigest: null
    }));
    assert.equal((await runtime.finishRunJob({
      runId: "usage-run-finish",
      ownerId: "worker-finish",
      claimToken: finishClaim.claimToken,
      status: "completed",
      payload: checkpointPayload,
      checkpointDigest,
      expectedCheckpointDigest: checkpointDigest
    }))?.status, "completed");

    const concurrent = await Promise.all(
      Array.from({ length: 250 }, async (_, index) => {
        const log = usageLog(
          `request-${String(index).padStart(4, "0")}`,
          second.item.claimTokenHash!,
          {}
        );
        log.trustedAssociation = await runtime.reserveProviderUsageAssociation(
          log.trustedAssociation!
        );
        return log;
      })
    );
    await Promise.all(concurrent.map((log) => runtime.appendProviderUsageLog(log)));
    const all = await runtime.listProviderUsageLogs({
      tenantId: "tenant-a",
      runId: "usage-run-a"
    });
    assert.equal(all.length, 252);
    assert.equal(new Set(all.map((log) => log.id)).size, 252);
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-a"
    })).pendingReservations.length, 0);
  }
);

async function waitForHttpAudit(
  pool: Pool,
  input: { tenantId: string; action: string },
  timeoutMs = 2_000
): Promise<{
  policy_decision: string;
  result: string;
  status_code: number;
}> {
  const deadline = Date.now() + timeoutMs;
  do {
    const audit = await pool.query<{
      policy_decision: string;
      result: string;
      status_code: number;
    }>(`
      SELECT policy_decision,result,status_code
      FROM mn_audit_events
      WHERE tenant_id=$1 AND action=$2
      ORDER BY occurred_at DESC LIMIT 1
    `, [input.tenantId, input.action]);
    if (audit.rows[0]) return audit.rows[0];
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for audit event ${input.action}`);
}

test(
  "PostgreSQL keeps failover pending until terminal success and usage routes fail 503",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_provider_usage_lifecycle_events, mn_provider_usage, mn_provider_usage_reservations, mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata, mn_health_probe RESTART IDENTITY"
    );
    const root = await mkdtemp(join(tmpdir(), "mn-provider-failover-ledger-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const localStore = new FileLocalStore({ rootDir: join(root, "store") });
    const primary = await localStore.createProvider({
      app: "codex",
      name: "Primary",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "failover-model",
      wireApi: "responses",
      modelCatalog: [{
        id: "failover-model",
        displayName: "Failover Model",
        inputTokenUsdPerMillion: 1,
        outputTokenUsdPerMillion: 2
      }],
      sortOrder: 1
    });
    const fallback = await localStore.createProvider({
      app: "codex",
      name: "Fallback",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "failover-model",
      wireApi: "responses",
      modelCatalog: [{
        id: "failover-model",
        displayName: "Failover Model",
        inputTokenUsdPerMillion: 1,
        outputTokenUsdPerMillion: 2
      }],
      sortOrder: 2
    });
    await runtime.enqueueRunJob({
      runId: "usage-run-failover",
      tenantId: "tenant-a",
      projectId: "project-a",
      taskId: "task-a",
      payload: { workflow: "governed-increment-v1" }
    });
    const claim = await runtime.claimRunJob({
      ownerId: "worker-a",
      capabilities: {
        tenantIds: ["tenant-a"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 60_000
    });
    assert.ok(claim?.item.claimTokenHash);
    const association = usageLog("association-template", claim.item.claimTokenHash, {
      runId: "usage-run-failover",
      candidateId: "codex-failover",
      workerId: "worker-a"
    }).trustedAssociation!;

    const primaryUpstream = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: "primary unavailable",
          usage: { input_tokens: 3, output_tokens: 1 }
        })
      );
    });
    let releaseFallback!: () => void;
    const fallbackRelease = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    let fallbackStarted!: () => void;
    const fallbackStart = new Promise<void>((resolve) => {
      fallbackStarted = resolve;
    });
    const fallbackUpstream = createServer(async (_request, response) => {
      fallbackStarted();
      await fallbackRelease;
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          model: "failover-model",
          usage: { input_tokens: 9, output_tokens: 4 }
        })
      );
    });
    await Promise.all([
      new Promise<void>((resolve) => primaryUpstream.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => fallbackUpstream.listen(0, "127.0.0.1", resolve))
    ]);
    t.after(() => {
      releaseFallback();
      primaryUpstream.close();
      fallbackUpstream.close();
    });
    const primaryRuntime = {
      ...primary,
      baseUrl: `http://127.0.0.1:${(primaryUpstream.address() as AddressInfo).port}`
    };
    const fallbackRuntime = {
      ...fallback,
      baseUrl: `http://127.0.0.1:${(fallbackUpstream.address() as AddressInfo).port}`
    };
    const appended: ProviderUsageAttemptLog[] = [];
    const proxy = new LocalProxyServer({
      port: 0,
      requireTrustedUsageAssociation: true,
      resolveProvider: async () => ({ app: "codex", provider: primaryRuntime }),
      resolveProviders: async () => [
        { app: "codex", provider: primaryRuntime },
        { app: "codex", provider: fallbackRuntime }
      ],
      verifyUsageAssociationReceipt: async (receipt) => {
        assert.equal(receipt, "signed-failover-receipt");
        return association;
      },
      reserveTrustedUsageAssociation: (verified) =>
        runtime.reserveProviderUsageAssociation(verified),
      appendLog: async (log) => {
        await runtime.appendProviderUsageLog(log);
        appended.push(log);
      }
    });
    const proxyStatus = await proxy.start();
    t.after(async () => {
      releaseFallback();
      await proxy.stop();
    });
    const responsePromise = fetch(
      `http://${proxyStatus.host}:${proxyStatus.port}/mn/usage-receipts/signed-failover-receipt/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-mn-app": "codex" },
        body: JSON.stringify({ model: "failover-model", input: "hello" })
      }
    );
    const startOutcome = await Promise.race([
      fallbackStart.then(() => ({ kind: "fallback" as const })),
      responsePromise.then((earlyResponse) => ({
        kind: "response" as const,
        response: earlyResponse
      })),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("fallback did not start")), 5_000).unref();
      })
    ]);
    if (startOutcome.kind === "response") {
      assert.fail(
        `proxy returned before fallback: ${startOutcome.response.status} ${
          await startOutcome.response.text()
        }`
      );
    }

    const inFlight = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-failover"
    });
    assert.equal(inFlight.usageLogs.length, 1);
    assert.equal(inFlight.usageLogs[0]!.inputTokens, 3);
    assert.equal(inFlight.usageLogs[0]!.outputTokens, 1);
    assert.equal(inFlight.pendingReservations.length, 1);
    assert.equal(inFlight.finalizedReservations.length, 0);
    assert.deepEqual(
      (inFlight.usageLogs[0] as ProviderUsageAttemptLog).usageAttempt,
      {
        schemaVersion: 1,
        logicalRequestId: inFlight.pendingReservations[0]!.reservationId,
        index: 1,
        terminal: false,
        outcome: "failed",
        retryable: true
      }
    );
    await Promise.all([
      runtime.appendProviderUsageLog(appended[0]!),
      runtime.appendProviderUsageLog(appended[0]!)
    ]);
    await runtime.pool.query(`
      UPDATE mn_run_jobs
      SET claim_expires_at=clock_timestamp() - interval '1 millisecond'
      WHERE run_id=$1
    `, ["usage-run-failover"]);
    const restartedRuntime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => restartedRuntime.close());
    assert.equal((await restartedRuntime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-failover"
    })).pendingReservations.length, 1);
    const reclaimed = await restartedRuntime.claimRunJob({
      ownerId: "worker-a",
      capabilities: {
        tenantIds: ["tenant-a"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 60_000
    });
    assert.ok(reclaimed);
    assert.notEqual(reclaimed.item.claimTokenHash, claim.item.claimTokenHash);
    await assert.rejects(
      restartedRuntime.heartbeatClaim({
        runId: "usage-run-failover",
        ownerId: "worker-a",
        claimToken: reclaimed.claimToken
      }),
      /pending reservation/u
    );

    releaseFallback();
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { model: string }).model, "failover-model");
    const settled = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-a",
      runId: "usage-run-failover"
    });
    assert.equal(settled.usageLogs.length, 2);
    assert.equal(settled.pendingReservations.length, 0);
    assert.equal(settled.finalizedReservations.length, 1);
    const successful = settled.usageLogs.find((log) => log.statusCode === 200);
    assert.equal(successful?.inputTokens, 9);
    assert.equal(successful?.outputTokens, 4);
    assert.equal((successful as ProviderUsageAttemptLog).usageAttempt.terminal, true);
    assert.equal((successful as ProviderUsageAttemptLog).usageAttempt.index, 2);
    await Promise.all([
      runtime.appendProviderUsageLog(appended[1]!),
      runtime.appendProviderUsageLog(appended[1]!)
    ]);
    assert.equal((await runtime.listProviderUsageLogs({
      tenantId: "tenant-a",
      runId: "usage-run-failover"
    })).length, 2);
    await assert.rejects(
      runtime.appendProviderUsageLog({ ...appended[1]!, id: "duplicate-final-callback" }),
      /attempt conflict|idempotency conflict/u
    );
    await assert.rejects(
      runtime.appendProviderUsageLog({
        ...appended[1]!,
        id: "cross-logical-request",
        usageAttempt: {
          ...appended[1]!.usageAttempt,
          logicalRequestId: "another-logical-request"
        }
      }),
      /association is inconsistent/u
    );

    const fixture = authFixture();
    const routePool = new Pool({ connectionString });
    const app = buildServer({
      runtimeProfile: "enterprise",
      bindHost: "0.0.0.0",
      corsAllowlist: [ORIGIN],
      enterprisePostgres: { pool: routePool },
      telemetry: false,
      standardPackTrustProfile: false,
      sandboxAttestationKey: false,
      enterpriseProjectRoots: [root],
      artifactRemoteStore: {
        type: "s3",
        rootDir: join(root, "artifact-mirror"),
        bucket: "mn-provider-failover-test",
        endpointUrl: "http://127.0.0.1:19000"
      },
      auth: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: `${ISSUER}/jwks`,
        fetchJwks: async () => ({ keys: [fixture.jwk] })
      },
      mniuRoot: join(root, "api-state"),
      localStore,
      useMockExecutors: true
    });
    t.after(() => app.close());
    await app.ready();
    const headers = {
      origin: ORIGIN,
      authorization: `Bearer ${fixture.token("tenant-a")}`
    };
    const summary = await app.inject({
      method: "GET",
      url: "/v1/usage/summary?runId=usage-run-failover",
      headers
    });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json().accounting.status, "settled");
    assert.equal(summary.json().summary.requestCount, 2);
    assert.equal(summary.json().summary.inputTokens, 12);
    assert.equal(summary.json().summary.outputTokens, 5);
    assert.equal(summary.json().summary.estimatedCostUsd, 0.000022);

    await routePool.end();
    for (const url of [
      "/v1/proxy/logs?runId=usage-run-failover",
      "/v1/usage/summary?runId=usage-run-failover",
      "/v1/usage/requests?runId=usage-run-failover",
      "/v1/usage/models?runId=usage-run-failover"
    ]) {
      const unavailable = await app.inject({ method: "GET", url, headers });
      assert.equal(unavailable.statusCode, 503, `${url}: ${unavailable.body}`);
      assert.deepEqual(unavailable.json(), {
        error: "enterprise provider usage ledger is unavailable"
      });
      assert.doesNotMatch(unavailable.body, /ended|postgres|connection|stack/iu);
    }
  }
);

test(
  "PostgreSQL zero-candidate proxy requests leave no reservation across restart and reclaim",
  { skip: !connectionString },
  async (t) => {
    let runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_provider_usage_lifecycle_events, mn_provider_usage, mn_provider_usage_reservations, mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata, mn_health_probe RESTART IDENTITY"
    );
    await runtime.enqueueRunJob({
      runId: "usage-run-zero-candidate",
      tenantId: "tenant-zero",
      projectId: "project-zero",
      taskId: "task-zero",
      payload: { workflow: "governed-increment-v1" },
      now: "2026-07-12T00:00:00.000Z"
    });
    const initialClaim = await runtime.claimRunJob({
      ownerId: "worker-zero",
      capabilities: {
        tenantIds: ["tenant-zero"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 1_000,
      now: "2026-07-12T00:00:01.000Z"
    });
    assert.ok(initialClaim?.item.claimTokenHash);
    const signingKey = "zero-candidate-receipt-key-0123456789abcdef0123456789abcdef";
    const issued = issueProviderUsageReceipt({
      tenantId: "tenant-zero",
      runId: "usage-run-zero-candidate",
      candidateId: "codex-zero",
      workerId: "worker-zero",
      claimDigest: initialClaim.item.claimTokenHash,
      authorityExpiresAt: "2026-07-12T00:00:02.000Z",
      signingKey,
      now: "2026-07-12T00:00:01.100Z"
    });
    let verifiedCount = 0;
    let reserveCount = 0;
    let appendCount = 0;
    const proxy = new LocalProxyServer({
      port: 0,
      requireTrustedUsageAssociation: true,
      resolveProvider: async () => undefined,
      // Product API returns this exact empty list when no providers exist or
      // every candidate is filtered by an open circuit.
      resolveProviders: async () => [],
      verifyUsageAssociationReceipt: async (receipt) => {
        const verified = verifyProviderUsageReceipt({
          receipt,
          signingKey,
          now: "2026-07-12T00:00:01.500Z"
        });
        const active = await runtime.inspectClaim({
          runId: verified.runId,
          ownerId: verified.workerId,
          claimToken: initialClaim.claimToken,
          now: "2026-07-12T00:00:01.500Z"
        });
        assert.equal(active?.item.tenantId, verified.tenantId);
        assert.equal(active?.item.claimTokenHash, verified.claimDigest);
        verifiedCount += 1;
        return verified;
      },
      reserveTrustedUsageAssociation: async (association) => {
        reserveCount += 1;
        return runtime.reserveProviderUsageAssociation(association);
      },
      appendLog: async (log) => {
        appendCount += 1;
        await runtime.appendProviderUsageLog(log);
      }
    });
    const proxyStatus = await proxy.start();
    t.after(() => proxy.stop());

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => fetch(
        `http://${proxyStatus.host}:${proxyStatus.port}/mn/usage-receipts/${issued.receipt}/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-mn-app": "codex" },
          body: JSON.stringify({ model: "zero-model", input: "no provider" })
        }
      ))
    );
    assert.deepEqual(responses.map((response) => response.status), [503, 503, 503, 503]);
    assert.equal(verifiedCount, 4);
    assert.equal(reserveCount, 0);
    assert.equal(appendCount, 0);
    const beforeRestart = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-zero",
      runId: "usage-run-zero-candidate"
    });
    assert.equal(beforeRestart.pendingReservations.length, 0);
    assert.equal(beforeRestart.finalizedReservations.length, 0);
    assert.equal(beforeRestart.usageLogs.length, 0);

    await proxy.stop();
    await runtime.close();
    runtime = new EnterprisePostgresRuntime({ connectionString });
    await runtime.migrate();
    const afterRestart = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-zero",
      runId: "usage-run-zero-candidate"
    });
    assert.equal(afterRestart.pendingReservations.length, 0);
    assert.equal(afterRestart.finalizedReservations.length, 0);
    assert.equal(afterRestart.usageLogs.length, 0);

    const reclaimed = await runtime.claimRunJob({
      ownerId: "worker-zero",
      capabilities: {
        tenantIds: ["tenant-zero"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 60_000,
      now: "2026-07-12T00:00:03.000Z"
    });
    assert.ok(reclaimed);
    assert.notEqual(reclaimed.item.claimTokenHash, initialClaim.item.claimTokenHash);
    assert.ok(await runtime.heartbeatClaim({
      runId: "usage-run-zero-candidate",
      ownerId: "worker-zero",
      claimToken: reclaimed.claimToken,
      ttlMs: 60_000,
      now: "2026-07-12T00:00:04.000Z"
    }));
    const checkpointPayload = {
      workflow: "governed-increment-v1",
      zeroCandidateRequests: 4
    };
    const checkpointDigest = sha256Canonical(checkpointPayload);
    assert.ok(await runtime.checkpointClaim({
      runId: "usage-run-zero-candidate",
      ownerId: "worker-zero",
      claimToken: reclaimed.claimToken,
      payload: checkpointPayload,
      checkpointDigest,
      expectedCheckpointDigest: null,
      now: "2026-07-12T00:00:05.000Z"
    }));
    assert.equal((await runtime.finishRunJob({
      runId: "usage-run-zero-candidate",
      ownerId: "worker-zero",
      claimToken: reclaimed.claimToken,
      status: "completed",
      now: "2026-07-12T00:00:06.000Z"
    }))?.status, "completed");
  }
);

test(
  "PostgreSQL rejects a receipt that expires while the proxy reads the request body",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_provider_usage_lifecycle_events, mn_provider_usage, mn_provider_usage_reservations, mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata, mn_health_probe RESTART IDENTITY"
    );
    await runtime.enqueueRunJob({
      runId: "usage-run-expiring-body",
      tenantId: "tenant-expiring",
      projectId: "project-expiring",
      taskId: "task-expiring",
      payload: { workflow: "governed-increment-v1" }
    });
    const claim = await runtime.claimRunJob({
      ownerId: "worker-expiring",
      capabilities: {
        tenantIds: ["tenant-expiring"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: []
        }]
      },
      ttlMs: 60_000
    });
    assert.ok(claim?.item.claimTokenHash);
    const provider: ProviderRecord = {
      id: "provider-expiring-body",
      app: "codex",
      name: "Expiring body provider",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "expiring-model",
      disableResponseStorage: true,
      wireApi: "responses",
      modelCatalog: [{ id: "expiring-model", displayName: "Expiring model" }],
      config: {},
      enabled: true,
      sortOrder: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    let upstreamCount = 0;
    const upstream = createServer((_request, response) => {
      upstreamCount += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => upstream.close());
    const runtimeProvider = {
      ...provider,
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    };
    const signingKey = "expiring-body-receipt-key-0123456789abcdef0123456789abcdef";
    let verifiedSignal!: () => void;
    const verified = new Promise<void>((resolve) => {
      verifiedSignal = resolve;
    });
    let reserveCount = 0;
    let appendCount = 0;
    let issuedReceipt = "";
    const proxy = new LocalProxyServer({
      port: 0,
      requireTrustedUsageAssociation: true,
      resolveProvider: async () => ({ app: "codex", provider: runtimeProvider }),
      resolveProviders: async () => [{ app: "codex", provider: runtimeProvider }],
      verifyUsageAssociationReceipt: async (receipt) => {
        assert.equal(receipt, issuedReceipt);
        const now = new Date().toISOString();
        const association = verifyProviderUsageReceipt({ receipt, signingKey, now });
        const active = await runtime.inspectClaim({
          runId: association.runId,
          ownerId: association.workerId,
          claimToken: claim.claimToken,
          now
        });
        assert.equal(active?.item.claimTokenHash, association.claimDigest);
        verifiedSignal();
        return association;
      },
      reserveTrustedUsageAssociation: async (association) => {
        reserveCount += 1;
        return runtime.reserveProviderUsageAssociation(association);
      },
      appendLog: async (log) => {
        appendCount += 1;
        await runtime.appendProviderUsageLog(log);
      }
    });
    const proxyStatus = await proxy.start();
    t.after(() => proxy.stop());
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    issuedReceipt = issueProviderUsageReceipt({
      tenantId: "tenant-expiring",
      runId: "usage-run-expiring-body",
      candidateId: "codex-expiring",
      workerId: "worker-expiring",
      claimDigest: claim.item.claimTokenHash,
      authorityExpiresAt: expiresAt,
      signingKey,
      now: issuedAt
    }).receipt;
    const body = Buffer.from(JSON.stringify({ model: "expiring-model", input: "slow" }));
    let finishBody!: () => void;
    const finishBodySignal = new Promise<void>((resolve) => {
      finishBody = resolve;
    });
    const responseResult = new Promise<{ statusCode: number; body: string }>(
      (resolve, reject) => {
        const client = httpRequest(
          `http://${proxyStatus.host}:${proxyStatus.port}/mn/usage-receipts/${issuedReceipt}/v1/responses`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": body.length,
              "x-mn-app": "codex"
            }
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8")
            }));
          }
        );
        client.on("error", reject);
        client.write(body.subarray(0, 8));
        void finishBodySignal.then(() => client.end(body.subarray(8)));
      }
    );
    await verified;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(0, Date.parse(expiresAt) - Date.now() + 100)
    ));
    finishBody();
    const response = await responseResult;
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), {
      error: "provider usage accounting is unavailable"
    });
    assert.equal(reserveCount, 1);
    assert.equal(appendCount, 0);
    assert.equal(upstreamCount, 0);
    const accounting = await runtime.readProviderUsageAccounting({
      tenantId: "tenant-expiring",
      runId: "usage-run-expiring-body"
    });
    assert.equal(accounting.pendingReservations.length, 0);
    assert.equal(accounting.finalizedReservations.length, 0);
    assert.equal(accounting.usageLogs.length, 0);

    await runtime.pool.query(`
      UPDATE mn_run_jobs
      SET claim_expires_at=clock_timestamp() - interval '1 millisecond'
      WHERE run_id=$1
    `, ["usage-run-expiring-body"]);
    await assert.rejects(
      runtime.reserveProviderUsageAssociation(
        usageLog("expired-claim-reservation", claim.item.claimTokenHash, {
          runId: "usage-run-expiring-body",
          candidateId: "codex-expiring",
          workerId: "worker-expiring"
        }).trustedAssociation!
      ),
      /current active claim/u
    );
    assert.equal((await runtime.readProviderUsageAccounting({
      tenantId: "tenant-expiring",
      runId: "usage-run-expiring-body"
    })).pendingReservations.length, 0);
  }
);

function authFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const jwk = {
    ...publicJwk,
    kid: "provider-usage-routes",
    use: "sig",
    alg: "RS256"
  };
  return {
    jwk,
    token: (tenantId: string, projectIds: string[] = []) => {
      const header = Buffer.from(JSON.stringify({
        alg: "RS256",
        kid: jwk.kid,
        typ: "JWT"
      })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "auditor@example.test",
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        tenant_id: tenantId,
        roles: ["auditor"],
        project_ids: projectIds
      })).toString("base64url");
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        pair.privateKey
      ).toString("base64url");
      return `${header}.${payload}.${signature}`;
    }
  };
}

function usageLog(
  id: string,
  claimDigest: string,
  input: {
    verifiedAt?: string;
    runId?: string;
    candidateId?: string;
    workerId?: string;
    issuedAt?: string;
    expiresAt?: string;
  }
): ProxyRequestLog {
  const runId = input.runId ?? "usage-run-a";
  const candidateId = input.candidateId ?? "codex-1";
  const workerId = input.workerId ?? "worker-a";
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const issuedAt = input.issuedAt ?? new Date(Date.parse(verifiedAt) - 1_000).toISOString();
  const expiresAt = input.expiresAt ?? new Date(Date.parse(verifiedAt) + 60_000).toISOString();
  return {
    id,
    app: "codex",
    providerId: "provider-a",
    model: "model-a",
    inputTokens: 2,
    outputTokens: 1,
    statusCode: 200,
    latencyMs: 10,
    runId,
    candidateId,
    trustedAssociation: {
      schemaVersion: 1,
      issuer: "mn-api",
      tenantId: "tenant-a",
      runId,
      candidateId,
      workerId,
      claimDigest,
      receiptDigest: "a".repeat(64),
      issuedAt,
      expiresAt,
      verifiedAt
    },
    createdAt: verifiedAt
  };
}
