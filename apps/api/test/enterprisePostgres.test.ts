import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "@mn/governance";
import {
  FileSpecRepository,
  digestSpecRevision,
  type SpecRevision
} from "@mn/specs";
import { EvalAssetRegistry } from "@mn/evidence";
import { EnterprisePostgresRuntime } from "../src/enterprisePostgres.js";
import { RunJobQueue } from "../src/runJobQueue.js";
import { buildServer } from "../src/server.js";
import { MemoryStore, scopedEvidenceRecordKey } from "../src/store.js";

const connectionString = process.env.MN_TEST_POSTGRES_URL;
const ISSUER = "https://postgres-restart.example.test";
const AUDIENCE = "mn-enterprise";
const ORIGIN = "https://console.example.test";

function authFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const jwk = { ...publicJwk, kid: "postgres-restart", use: "sig", alg: "RS256" };
  const token = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }))
      .toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "admin@example.test",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      tenant_id: "tenant-restart",
      roles: ["org_admin"],
      project_ids: []
    })).toString("base64url");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      pair.privateKey
    ).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  return { jwk, token };
}

test(
  "PostgreSQL enterprise metadata, transactional queue, outbox and audit are enforced",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    t.after(() => runtime.close());
    await runtime.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata RESTART IDENTITY"
    );

    const metadataPayload = { name: "Project A" };
    const metadataDigest = sha256Canonical(metadataPayload);
    const metadata = await runtime.upsertMetadata({
      tenantId: "tenant-a",
      kind: "project",
      id: "project-a",
      digest: metadataDigest,
      payload: metadataPayload,
      now: "2026-07-11T00:00:00.000Z"
    });
    assert.equal(metadata.version, 1);
    const unchangedMetadata = await runtime.upsertMetadata({
      tenantId: "tenant-a",
      kind: "project",
      id: "project-a",
      digest: metadataDigest,
      payload: metadataPayload,
      now: "2026-07-11T00:00:00.500Z"
    });
    assert.equal(unchangedMetadata.version, 1);
    assert.equal((await runtime.listMetadata()).length, 1);
    await assert.rejects(
      runtime.upsertMetadata({
        tenantId: "tenant-a",
        kind: "task",
        id: "corrupt-task",
        digest: "f".repeat(64),
        payload: { id: "corrupt-task" }
      }),
      /does not match metadata payload/u
    );
    const staleTaskPayload = { id: "stale-task" };
    await runtime.upsertMetadata({
      tenantId: "tenant-a",
      kind: "task",
      id: "stale-task",
      digest: sha256Canonical(staleTaskPayload),
      payload: staleTaskPayload
    });
    await runtime.reconcileMetadata({
      records: [{
        tenantId: "tenant-a",
        kind: "project",
        id: "project-a",
        digest: metadataDigest,
        payload: metadataPayload
      }],
      managedKinds: ["project", "task"],
      now: "2026-07-11T00:00:00.600Z"
    });
    assert.deepEqual(
      (await runtime.listMetadata()).map((record) => `${record.kind}/${record.id}`),
      ["project/project-a"]
    );
    await runtime.checkReadWrite("2026-07-11T00:00:00.750Z");

    const runId = randomUUID();
    const queued = await runtime.enqueueRunJob({
      runId,
      tenantId: "tenant-a",
      projectId: "project-a",
      taskId: "task-a",
      requirements: {
        requiredProviders: ["codex"],
        requiredGateRunnerIds: ["contract"],
        sandbox: {
          allowedBackendIds: ["enterprise-container"],
          minEnforcement: "enforced",
          requiredCapabilities: ["network-policy"]
        }
      },
      payload: { workflow: "governed-increment-v1" },
      now: "2026-07-11T00:00:01.000Z"
    });
    assert.equal(queued.version, 2);
    const queuedSnapshot = await runtime.readRunJobSnapshot(runId);
    assert.equal(queuedSnapshot?.item.status, "queued");
    assert.deepEqual(queuedSnapshot?.payload, { workflow: "governed-increment-v1" });
    assert.equal(queuedSnapshot?.checkpointDigest, null);

    const incompatible = await runtime.claimRunJob({
      ownerId: "worker-weak",
      capabilities: {
        tenantIds: ["tenant-a"],
        providers: ["codex"]
      },
      now: "2026-07-11T00:00:02.000Z"
    });
    assert.equal(incompatible, undefined);

    const claim = await runtime.claimRunJob({
      ownerId: "worker-enterprise",
      capabilities: {
        tenantIds: ["tenant-a"],
        providers: ["codex"],
        gateRunnerIds: ["contract"],
        sandboxBackends: [{
          backendId: "enterprise-container",
          enforcement: "enforced",
          capabilities: ["network-policy"]
        }]
      },
      ttlMs: 60_000,
      now: "2026-07-11T00:00:03.000Z"
    });
    assert.equal(claim?.item.runId, runId);
    assert.equal(claim?.item.claimToken, undefined);
    assert.equal(claim?.payload.workflow, "governed-increment-v1");
    const runningSnapshot = await runtime.readRunJobSnapshot(runId);
    assert.equal(runningSnapshot?.item.status, "running");
    assert.equal(runningSnapshot?.item.claimToken, undefined);
    assert.deepEqual(runningSnapshot?.payload, claim?.payload);
    await assert.rejects(
      runtime.enqueueRunJob({
        runId,
        tenantId: "tenant-a",
        projectId: "project-a",
        taskId: "task-a",
        requirements: queued.requirements,
        payload: { workflow: "governed-increment-v1" },
        now: "2026-07-11T00:00:03.500Z"
      }),
      /active enterprise claim/u
    );

    assert.equal(
      await runtime.heartbeatClaim({
        runId,
        ownerId: "worker-enterprise",
        claimToken: "forged",
        now: "2026-07-11T00:00:04.000Z"
      }),
      undefined
    );
    const heartbeat = await runtime.heartbeatClaim({
      runId,
      ownerId: "worker-enterprise",
      claimToken: claim!.claimToken,
      ttlMs: 60_000,
      now: "2026-07-11T00:00:04.000Z"
    });
    assert.ok(heartbeat);
    assert.notEqual(heartbeat.claimBindingDigest, claim!.item.claimBindingDigest);
    const finished = await runtime.finishRunJob({
      runId,
      ownerId: "worker-enterprise",
      claimToken: claim!.claimToken,
      status: "completed",
      now: "2026-07-11T00:00:05.000Z"
    });
    assert.equal(finished?.status, "completed");
    await assert.rejects(
      runtime.enqueueRunJob({
        runId,
        tenantId: "tenant-a",
        projectId: "project-a",
        taskId: "task-a",
        requirements: { requiredProviders: ["claude"] },
        payload: { workflow: "governed-increment-v1" },
        now: "2026-07-11T00:00:05.500Z"
      }),
      /requirements are immutable/u
    );

    const expiredRunId = randomUUID();
    await runtime.enqueueRunJob({
      runId: expiredRunId,
      tenantId: "tenant-a",
      projectId: "project-a",
      taskId: "task-expired",
      payload: {},
      now: "2026-07-11T00:01:00.000Z"
    });
    const expiredClaim = await runtime.claimRunJob({
      ownerId: "worker-expired",
      capabilities: {
        tenantIds: ["tenant-a"],
        sandboxBackends: [{
          backendId: "any",
          enforcement: "none",
          capabilities: []
        }]
      },
      ttlMs: 1_000,
      now: "2026-07-11T00:01:01.000Z"
    });
    assert.ok(expiredClaim);
    const checkpointPayload = {
      version: 1,
      run: { id: expiredRunId, status: "running" },
      governedResumeState: { runId: expiredRunId, status: "running" }
    };
    const checkpointDigest = sha256Canonical(checkpointPayload);
    assert.equal(
      await runtime.checkpointClaim({
        runId: expiredRunId,
        ownerId: "worker-expired",
        claimToken: "forged",
        payload: checkpointPayload,
        checkpointDigest,
        expectedCheckpointDigest: null,
        now: "2026-07-11T00:01:01.500Z"
      }),
      undefined
    );
    const checkpointed = await runtime.checkpointClaim({
      runId: expiredRunId,
      ownerId: "worker-expired",
      claimToken: expiredClaim!.claimToken,
      payload: checkpointPayload,
      checkpointDigest,
      expectedCheckpointDigest: null,
      ttlMs: 1_000,
      now: "2026-07-11T00:01:01.500Z"
    });
    assert.ok(checkpointed);
    assert.equal(
      await runtime.checkpointClaim({
        runId: expiredRunId,
        ownerId: "worker-expired",
        claimToken: expiredClaim!.claimToken,
        payload: checkpointPayload,
        checkpointDigest,
        expectedCheckpointDigest: null,
        now: "2026-07-11T00:01:01.750Z"
      }),
      undefined,
      "a stale checkpoint digest must lose the CAS"
    );
    assert.equal(
      await runtime.finishRunJob({
        runId: expiredRunId,
        ownerId: "worker-expired",
        claimToken: expiredClaim!.claimToken,
        status: "completed",
        now: "2026-07-11T00:01:02.500Z"
      }),
      undefined
    );
    const restartedRuntime = new EnterprisePostgresRuntime({ connectionString });
    await restartedRuntime.migrate();
    const reclaimed = await restartedRuntime.claimRunJob({
      ownerId: "worker-reclaimed",
      capabilities: {
        tenantIds: ["tenant-a"],
        sandboxBackends: [{
          backendId: "any",
          enforcement: "none",
          capabilities: []
        }]
      },
      ttlMs: 1_000,
      now: "2026-07-11T00:01:03.000Z"
    });
    assert.equal(reclaimed?.item.runId, expiredRunId);
    assert.deepEqual(reclaimed?.payload, checkpointPayload);
    assert.equal(reclaimed?.checkpointDigest, checkpointDigest);
    const snapshot = await restartedRuntime.readStateSnapshot();
    assert.equal(
      snapshot.runJobs.find((job) => job.item.runId === expiredRunId)?.checkpointDigest,
      checkpointDigest
    );
    await restartedRuntime.close();

    const domainAuditId = randomUUID();
    const governedMetadataPayload = { name: "Project A governed" };
    const governedMetadataDigest = sha256Canonical(governedMetadataPayload);
    const domainAudit = {
      id: domainAuditId,
      tenantId: "tenant-a",
      actorId: "governance-admin@example.com",
      action: "standard_pack.activate",
      resourceType: "governance_layer",
      resourceId: "project:project-a:corp/default",
      projectId: "project-a",
      policyDecision: "allow" as const,
      beforeDigest: metadataDigest,
      afterDigest: governedMetadataDigest,
      packDigest: "a".repeat(64),
      traceId: "trace-domain-a",
      result: "success" as const,
      timestamp: "2026-07-11T00:00:06.000Z",
      statusCode: 200
    };
    await runtime.reconcileMetadata({
      records: [{
        tenantId: "tenant-a",
        kind: "project",
        id: "project-a",
        digest: governedMetadataDigest,
        payload: governedMetadataPayload
      }],
      managedKinds: ["project", "task"],
      auditEvents: [domainAudit],
      now: domainAudit.timestamp
    });
    const committedCounts = await runtime.pool.query<{
      outbox: string;
      audit: string;
    }>(`SELECT
      (SELECT count(*) FROM mn_outbox)::text AS outbox,
      (SELECT count(*) FROM mn_audit_events)::text AS audit`);
    assert.equal(Number(committedCounts.rows[0]!.audit), 1);
    const committedOutbox = Number(committedCounts.rows[0]!.outbox);

    // Retrying the same request/trace is idempotent: neither the metadata nor
    // the domain audit outbox grows.
    await runtime.reconcileMetadata({
      records: [{
        tenantId: "tenant-a",
        kind: "project",
        id: "project-a",
        digest: governedMetadataDigest,
        payload: governedMetadataPayload
      }],
      managedKinds: ["project", "task"],
      auditEvents: [domainAudit],
      now: domainAudit.timestamp
    });
    const retryCounts = await runtime.pool.query<{ outbox: string; audit: string }>(`SELECT
      (SELECT count(*) FROM mn_outbox)::text AS outbox,
      (SELECT count(*) FROM mn_audit_events)::text AS audit`);
    assert.equal(Number(retryCounts.rows[0]!.outbox), committedOutbox);
    assert.equal(Number(retryCounts.rows[0]!.audit), 1);

    // An audit id collision rolls back its accompanying metadata/outbox. This
    // is the atomicity guarantee required by enterprise mutation routes.
    const rejectedPayload = { name: "must roll back" };
    await assert.rejects(
      runtime.reconcileMetadata({
        records: [{
          tenantId: "tenant-a",
          kind: "project",
          id: "project-a",
          digest: sha256Canonical(rejectedPayload),
          payload: rejectedPayload
        }],
        managedKinds: ["project", "task"],
        auditEvents: [{ ...domainAudit, action: "forged.success" }],
        now: "2026-07-11T00:00:07.000Z"
      }),
      /idempotency conflict/u
    );
    assert.equal(
      (await runtime.listMetadata({ tenantId: "tenant-a", kinds: ["project"] }))[0]?.digest,
      governedMetadataDigest
    );
    const rollbackCounts = await runtime.pool.query<{ outbox: string; audit: string }>(`SELECT
      (SELECT count(*) FROM mn_outbox)::text AS outbox,
      (SELECT count(*) FROM mn_audit_events)::text AS audit`);
    assert.equal(Number(rollbackCounts.rows[0]!.outbox), committedOutbox);
    assert.equal(Number(rollbackCounts.rows[0]!.audit), 1);

    const auditId = randomUUID();
    const httpAudit = {
      id: auditId,
      tenantId: "tenant-a",
      actorId: "reviewer@example.com",
      action: "POST /v1/runs/id/approve",
      resourceType: "runs",
      resourceId: runId,
      projectId: "project-a",
      policyDecision: "allow",
      traceId: "trace-a",
      result: "success",
      timestamp: "2026-07-11T00:00:06.000Z",
      statusCode: 200
    } as const;
    await runtime.appendAuditEvent(httpAudit);
    await runtime.appendAuditEvent(httpAudit);
    await assert.rejects(
      runtime.appendAuditEvent({ ...httpAudit, action: "tampered" }),
      /idempotency conflict/u
    );
    await assert.rejects(
      runtime.pool.query(
        "UPDATE mn_audit_events SET actor_id='tampered' WHERE id=$1",
        [auditId]
      ),
      /append-only/u
    );
    const counts = await runtime.pool.query<{
      outbox: string;
      audit: string;
    }>(`SELECT
      (SELECT count(*) FROM mn_outbox)::text AS outbox,
      (SELECT count(*) FROM mn_audit_events)::text AS audit`);
    assert.equal(Number(counts.rows[0]!.outbox), committedOutbox);
    assert.equal(Number(counts.rows[0]!.audit), 2);
  }
);

test(
  "enterprise run create, checkpoint, and finish roll back queue metadata and outbox when domain audit fails",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    await runtime.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata RESTART IDENTITY"
    );
    t.after(async () => {
      await runtime.pool.query(
        "DROP TRIGGER IF EXISTS mn_test_reject_run_domain_success ON mn_audit_events"
      ).catch(() => undefined);
      await runtime.pool.query(
        "DROP FUNCTION IF EXISTS mn_test_reject_run_domain_success()"
      ).catch(() => undefined);
      await runtime.close();
    });

    const runId = randomUUID();
    await runtime.enqueueRunJob({
      runId,
      tenantId: "tenant-run-audit",
      projectId: "project-run-audit",
      taskId: "task-run-audit",
      payload: { version: 1, run: { id: runId, status: "queued" } },
      now: "2026-07-12T01:00:00.000Z"
    });
    const claim = await runtime.claimRunJob({
      ownerId: "worker-run-audit",
      capabilities: {
        tenantIds: ["tenant-run-audit"],
        sandboxBackends: [{
          backendId: "any",
          enforcement: "none",
          capabilities: []
        }]
      },
      ttlMs: 60_000,
      now: "2026-07-12T01:00:01.000Z"
    });
    assert.equal(claim?.item.runId, runId);
    await runtime.pool.query(`
      DROP TRIGGER IF EXISTS mn_test_reject_run_domain_success ON mn_audit_events;
      CREATE OR REPLACE FUNCTION mn_test_reject_run_domain_success()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tenant_id='tenant-run-audit' AND
           NEW.result='success' AND NEW.action IN
          ('run.create','run.checkpoint','run.finish') THEN
          RAISE EXCEPTION 'injected run domain audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mn_test_reject_run_domain_success
        BEFORE INSERT ON mn_audit_events
        FOR EACH ROW EXECUTE FUNCTION mn_test_reject_run_domain_success();
    `);
    const audit = (
      action: "run.create" | "run.checkpoint" | "run.finish",
      resourceId: string,
      at: string
    ) => ({
      id: randomUUID(),
      tenantId: "tenant-run-audit",
      actorId: "worker-run-audit",
      action,
      resourceType: action === "run.checkpoint" ? "run_checkpoint" : "run",
      resourceId,
      projectId: "project-run-audit",
      policyDecision: "allow" as const,
      beforeDigest: "a".repeat(64),
      afterDigest: "b".repeat(64),
      packDigest: "c".repeat(64),
      traceId: `trace-${action}`,
      result: "success" as const,
      timestamp: at,
      statusCode: action === "run.create" ? 201 : 200
    });
    const outboxBefore = Number((await runtime.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mn_outbox"
    )).rows[0]!.count);
    const checkpointPayload = {
      version: 1,
      run: { id: runId, status: "waiting_approval" }
    };
    const checkpointDigest = sha256Canonical(checkpointPayload);
    const checkpointRunMetadata = {
      id: runId,
      projectId: "project-run-audit",
      taskId: "task-run-audit",
      status: "waiting_approval"
    };
    await assert.rejects(
      runtime.checkpointClaim({
        runId,
        ownerId: "worker-run-audit",
        claimToken: claim!.claimToken,
        payload: checkpointPayload,
        checkpointDigest,
        expectedCheckpointDigest: null,
        metadataRecords: [{
          tenantId: "tenant-run-audit",
          kind: "run",
          id: runId,
          payload: checkpointRunMetadata,
          digest: sha256Canonical(checkpointRunMetadata)
        }],
        auditEvent: audit("run.checkpoint", runId, "2026-07-12T01:00:02.000Z"),
        now: "2026-07-12T01:00:02.000Z"
      }),
      /injected run domain audit failure/u
    );
    const afterCheckpointFailure = await runtime.inspectClaim({
      runId,
      ownerId: "worker-run-audit",
      claimToken: claim!.claimToken,
      now: "2026-07-12T01:00:03.000Z"
    });
    assert.deepEqual(afterCheckpointFailure?.payload, claim!.payload);
    assert.equal(afterCheckpointFailure?.checkpointDigest, null);
    assert.equal((await runtime.listMetadata({ kinds: ["run"] })).length, 0);
    assert.equal(
      Number((await runtime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_outbox"
      )).rows[0]!.count),
      outboxBefore
    );

    const finishedMetadata = {
      ...checkpointRunMetadata,
      status: "completed"
    };
    await assert.rejects(
      runtime.finishRunJob({
        runId,
        ownerId: "worker-run-audit",
        claimToken: claim!.claimToken,
        status: "completed",
        metadataRecords: [{
          tenantId: "tenant-run-audit",
          kind: "run",
          id: runId,
          payload: finishedMetadata,
          digest: sha256Canonical(finishedMetadata)
        }],
        auditEvent: audit("run.finish", runId, "2026-07-12T01:00:04.000Z"),
        now: "2026-07-12T01:00:04.000Z"
      }),
      /injected run domain audit failure/u
    );
    assert.equal((await runtime.readRunJob(runId))?.status, "running");
    assert.equal((await runtime.listMetadata({ kinds: ["run"] })).length, 0);
    assert.equal(
      Number((await runtime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_outbox"
      )).rows[0]!.count),
      outboxBefore
    );

    const createRunId = randomUUID();
    const createMetadata = {
      id: createRunId,
      projectId: "project-run-audit",
      taskId: "task-run-create",
      status: "queued"
    };
    await assert.rejects(
      runtime.enqueueRunJob({
        runId: createRunId,
        tenantId: "tenant-run-audit",
        projectId: "project-run-audit",
        taskId: "task-run-create",
        payload: { version: 1, run: createMetadata },
        metadataRecords: [{
          tenantId: "tenant-run-audit",
          kind: "run",
          id: createRunId,
          payload: createMetadata,
          digest: sha256Canonical(createMetadata)
        }],
        auditEvent: audit("run.create", createRunId, "2026-07-12T01:00:05.000Z"),
        now: "2026-07-12T01:00:05.000Z"
      }),
      /injected run domain audit failure/u
    );
    assert.equal(await runtime.readRunJob(createRunId), undefined);
    assert.equal(
      (await runtime.listMetadata({ kinds: ["run"] }))
        .some((record) => record.id === createRunId),
      false
    );
    assert.equal(
      Number((await runtime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_outbox"
      )).rows[0]!.count),
      outboxBefore
    );
    assert.equal(
      Number((await runtime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_audit_events"
      )).rows[0]!.count),
      0
    );
  }
);

test(
  "enterprise API hydrates PostgreSQL metadata after restart with an empty local state",
  { skip: !connectionString },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mn-postgres-restart-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cleanup = new EnterprisePostgresRuntime({ connectionString });
    await cleanup.migrate();
    await cleanup.pool.query(
      "TRUNCATE mn_outbox, mn_audit_events, mn_run_jobs, mn_metadata, mn_health_probe RESTART IDENTITY"
    );
    await cleanup.close();

    const fixture = authFixture();
    const projectRoot = join(root, "project");
    await mkdir(join(projectRoot, ".mn"), { recursive: true });
    await mkdir(join(projectRoot, "services", "orders"), { recursive: true });
    await mkdir(join(projectRoot, "tests"), { recursive: true });
    const evidenceContent = "postgres restore evidence\n";
    const evidenceDigest = createHash("sha256").update(evidenceContent).digest("hex");
    await writeFile(
      join(projectRoot, "tests", "postgres-restore.test.ts"),
      evidenceContent,
      "utf8"
    );
    await writeFile(
      join(projectRoot, ".mn", "project.yaml"),
      [
        "apiVersion: mn.dev/project/v1",
        "kind: Project",
        "metadata:",
        "  id: postgres-durable-project",
        "  owner: platform-team",
        "services:",
        "  - id: orders",
        "    path: services/orders",
        "    owners: [platform-team]",
        "    language: javascript",
        ""
      ].join("\n"),
      "utf8"
    );
    const headers = {
      origin: ORIGIN,
      authorization: `Bearer ${fixture.token()}`
    };
    const common = {
      runtimeProfile: "enterprise" as const,
      bindHost: "0.0.0.0",
      corsAllowlist: [ORIGIN],
      enterprisePostgres: { connectionString: connectionString! },
      telemetry: false as const,
      standardPackTrustProfile: false as const,
      sandboxAttestationKey: false as const,
      enterpriseProjectRoots: [projectRoot],
      artifactRemoteStore: {
        type: "s3" as const,
        rootDir: join(root, "artifact-mirror"),
        bucket: "mn-enterprise-test",
        endpointUrl: "http://127.0.0.1:19000"
      },
      auth: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: `${ISSUER}/jwks`,
        fetchJwks: async () => ({ keys: [fixture.jwk] })
      },
      useMockExecutors: true
    };

    const firstStore = new MemoryStore();
    const first = buildServer({
      ...common,
      store: firstStore,
      mniuRoot: join(root, "first-state")
    });
    await first.ready();
    const created = await first.inject({
      method: "POST",
      url: "/v1/projects",
      headers,
      payload: { name: "PostgreSQL durable project", rootPath: projectRoot }
    });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().id as string;
    const indexed = await first.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/index`,
      headers,
      payload: {}
    });
    assert.equal(indexed.statusCode, 200, indexed.body);
    assert.equal(indexed.json().project.services[0].id, "orders");

    const manifest = {
      schemaVersion: 1,
      id: "corp/postgres-durable",
      name: "PostgreSQL durable standards",
      version: "1.0.0",
      rules: {
        requiredGates: ["contract"],
        waivableRules: [{ field: "requiredGates", value: "contract" }],
        allowedProviders: ["codex"],
        commandAllowlist: ["npm"],
        budgets: { maxCandidates: 1, maxRepairAttempts: 1 },
        approvalMode: "before-merge"
      },
      specTemplates: ["service-change"],
      harnessProfiles: ["enterprise"],
      workflows: ["governed-increment-v1"]
    };
    const importedPack = await first.inject({
      method: "POST",
      url: "/v1/standard-packs/import",
      headers,
      payload: { manifest, importedBy: "admin@example.test" }
    });
    assert.equal(importedPack.statusCode, 201, importedPack.body);
    const activatedPack = await first.inject({
      method: "POST",
      url: "/v1/standard-packs/activate",
      headers,
      payload: {
        id: manifest.id,
        version: manifest.version,
        scope: "project",
        scopeId: projectId,
        activatedBy: "admin@example.test"
      }
    });
    assert.equal(activatedPack.statusCode, 200, activatedPack.body);

    const faultRuntime = new EnterprisePostgresRuntime({ connectionString });
    t.after(async () => {
      await faultRuntime.pool.query(
        "DROP TRIGGER IF EXISTS mn_test_reject_domain_success ON mn_audit_events"
      ).catch(() => undefined);
      await faultRuntime.pool.query(
        "DROP FUNCTION IF EXISTS mn_test_reject_domain_success()"
      ).catch(() => undefined);
      await faultRuntime.close();
    });
    await faultRuntime.pool.query(`
      CREATE OR REPLACE FUNCTION mn_test_reject_domain_success()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.result='success' AND
           NEW.action='waiver.create' AND
           NEW.resource_id='postgres-rejected-waiver' THEN
          RAISE EXCEPTION 'injected domain audit failure';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS mn_test_reject_domain_success ON mn_audit_events;
      CREATE TRIGGER mn_test_reject_domain_success
        BEFORE INSERT ON mn_audit_events
        FOR EACH ROW EXECUTE FUNCTION mn_test_reject_domain_success();
    `);
    const outboxBeforeRejectedWaiver = Number((await faultRuntime.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mn_outbox"
    )).rows[0]!.count);
    const rejectedNow = Date.now();
    const rejectedWaiver = await first.inject({
      method: "POST",
      url: "/v1/waivers",
      headers,
      payload: {
        id: "postgres-rejected-waiver",
        target: { field: "requiredGates", value: "contract" },
        scope: { level: "project", id: projectId },
        reason: "The injected PostgreSQL fault must compensate this mutation",
        approvedBy: "admin@example.test",
        approvedAt: new Date(rejectedNow - 1_000).toISOString(),
        expiresAt: new Date(rejectedNow + 3_600_000).toISOString()
      }
    });
    assert.equal(rejectedWaiver.statusCode, 500, rejectedWaiver.body);
    assert.equal(
      [...firstStore.waivers.values()].some(
        (entry) => entry.id === "postgres-rejected-waiver"
      ),
      false,
      "failed enterprise commit must restore the in-process cache"
    );
    assert.equal(
      (await faultRuntime.listMetadata({ tenantId: "tenant-restart", kinds: ["waiver"] }))
        .some((entry) => entry.id === "postgres-rejected-waiver"),
      false
    );
    assert.equal(
      Number((await faultRuntime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_outbox"
      )).rows[0]!.count),
      outboxBeforeRejectedWaiver,
      "metadata and outbox must roll back with the rejected domain audit"
    );
    const rejectedWaiverAudits = await faultRuntime.pool.query<{
      action: string;
      result: string;
    }>(`
      SELECT action,result FROM mn_audit_events
      WHERE resource_id='postgres-rejected-waiver'
    `);
    assert.equal(
      rejectedWaiverAudits.rows.some((event) => event.result === "success"),
      false
    );
    assert.equal(
      rejectedWaiverAudits.rows.some((event) => event.result === "failure"),
      true
    );
    await faultRuntime.pool.query(
      "DROP TRIGGER mn_test_reject_domain_success ON mn_audit_events"
    );

    const now = Date.now();
    const waiver = await first.inject({
      method: "POST",
      url: "/v1/waivers",
      headers,
      payload: {
        id: "postgres-durable-waiver",
        target: { field: "requiredGates", value: "contract" },
        scope: { level: "project", id: projectId },
        reason: "Exercise durable waiver storage",
        approvedBy: "admin@example.test",
        approvedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString()
      }
    });
    assert.equal(waiver.statusCode, 201, waiver.body);

    const unsignedRevision: Omit<SpecRevision, "digest"> = {
      specSetId: "postgres-durable-spec",
      revision: 1,
      status: "draft",
      source: "native",
      title: "Restore the enterprise control plane",
      hypothesis: "PostgreSQL can reconstruct a stateless API process.",
      outcomes: ["A restarted API serves the same Spec revision."],
      nonGoals: ["Do not deploy."],
      targetServices: ["orders"],
      contracts: {
        interface: { openapi: "services/orders/openapi.yaml" },
        data: { owner: "orders" },
        state: { states: ["draft", "ready"] },
        permission: { roles: ["org_admin"] },
        exception: { invalid: "reject" },
        quality: { p95Ms: 500 },
        observability: { metrics: ["restore_total"] }
      },
      acceptanceCases: [{
        id: "accept-postgres-restore",
        kind: "positive",
        title: "Restore after restart",
        given: ["Enterprise metadata exists in PostgreSQL."],
        when: "The API starts with an empty local state.",
        then: ["The Spec is readable."],
        targetService: "orders"
      }],
      risks: [],
      unknowns: [],
      createdAt: "2026-07-12T00:00:00.000Z",
      createdBy: "admin@example.test"
    };
    await faultRuntime.pool.query(`
      CREATE OR REPLACE FUNCTION mn_test_reject_domain_success()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.result='success' AND
           NEW.action='spec_set.create' AND
           NEW.resource_id='postgres-rejected-spec' THEN
          RAISE EXCEPTION 'injected domain audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mn_test_reject_domain_success
        BEFORE INSERT ON mn_audit_events
        FOR EACH ROW EXECUTE FUNCTION mn_test_reject_domain_success();
    `);
    const rejectedSpecUnsigned = {
      ...unsignedRevision,
      specSetId: "postgres-rejected-spec",
      title: "This Spec must be compensated"
    };
    const outboxBeforeRejectedSpec = Number((await faultRuntime.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mn_outbox"
    )).rows[0]!.count);
    const rejectedSpec = await first.inject({
      method: "POST",
      url: "/v1/spec-sets",
      headers,
      payload: {
        specSet: {
          id: rejectedSpecUnsigned.specSetId,
          title: rejectedSpecUnsigned.title,
          latestRevision: 0,
          createdAt: rejectedSpecUnsigned.createdAt,
          updatedAt: rejectedSpecUnsigned.createdAt
        },
        initialRevision: {
          ...rejectedSpecUnsigned,
          digest: digestSpecRevision(rejectedSpecUnsigned)
        }
      }
    });
    assert.equal(rejectedSpec.statusCode, 500, rejectedSpec.body);
    assert.equal(firstStore.specSetTenants.has(rejectedSpecUnsigned.specSetId), false);
    assert.equal(
      await new FileSpecRepository(
        join(root, "first-state", "control-plane")
      ).get(rejectedSpecUnsigned.specSetId),
      undefined,
      "failed enterprise commit must remove the uncommitted Spec document"
    );
    assert.equal(
      (await faultRuntime.listMetadata({
        tenantId: "tenant-restart",
        kinds: ["spec_set_owner", "spec_repository"]
      })).some((entry) => entry.id === rejectedSpecUnsigned.specSetId),
      false
    );
    assert.equal(
      Number((await faultRuntime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_outbox"
      )).rows[0]!.count),
      outboxBeforeRejectedSpec
    );
    const rejectedSpecAudits = await faultRuntime.pool.query<{ result: string }>(`
      SELECT result FROM mn_audit_events
      WHERE resource_id='postgres-rejected-spec'
    `);
    assert.equal(rejectedSpecAudits.rows.some((event) => event.result === "success"), false);
    assert.equal(rejectedSpecAudits.rows.some((event) => event.result === "failure"), true);
    await faultRuntime.pool.query(
      "DROP TRIGGER mn_test_reject_domain_success ON mn_audit_events"
    );

    const createdSpec = await first.inject({
      method: "POST",
      url: "/v1/spec-sets",
      headers,
      payload: {
        specSet: {
          id: unsignedRevision.specSetId,
          title: unsignedRevision.title,
          latestRevision: 0,
          createdAt: unsignedRevision.createdAt,
          updatedAt: unsignedRevision.createdAt
        },
        initialRevision: {
          ...unsignedRevision,
          digest: digestSpecRevision(unsignedRevision)
        }
      }
    });
    assert.equal(createdSpec.statusCode, 201, createdSpec.body);
    const approvedSpec = await first.inject({
      method: "POST",
      url: `/v1/spec-sets/${unsignedRevision.specSetId}/revisions/1/approve`,
      headers,
      payload: {
        approvedBy: "admin@example.test",
        createdBy: "admin@example.test",
        approvedAt: "2026-07-12T00:05:00.000Z"
      }
    });
    assert.equal(approvedSpec.statusCode, 201, approvedSpec.body);
    const governedTask = await first.inject({
      method: "POST",
      url: "/v1/tasks",
      headers,
      payload: {
        projectId,
        title: "Bind durable evidence to an approved Spec",
        prompt: "Create the server-owned evidence binding.",
        acceptanceCriteria: ["Evidence references the approved Spec exactly."],
        specRef: {
          specSetId: unsignedRevision.specSetId,
          revision: approvedSpec.json().revision,
          digest: approvedSpec.json().digest
        },
        strategy: {
          providers: ["codex"],
          candidates: 1,
          requiredGates: ["contract"],
          humanApproval: "before-merge"
        }
      }
    });
    assert.equal(governedTask.statusCode, 201, governedTask.body);

    const faultRunTask = await first.inject({
      method: "POST",
      url: "/v1/tasks",
      headers,
      payload: {
        projectId,
        title: "Atomic run create failure probe",
        prompt: "The queue transaction must roll back.",
        acceptanceCriteria: ["No orphan queue row remains."],
        strategy: {
          providers: ["codex"],
          candidates: 1,
          requiredGates: ["unit_test"],
          humanApproval: "never"
        }
      }
    });
    assert.equal(faultRunTask.statusCode, 201, faultRunTask.body);

    await faultRuntime.pool.query(`
      CREATE OR REPLACE FUNCTION mn_test_reject_domain_success()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.result='success' AND NEW.action='run.create' THEN
          RAISE EXCEPTION 'injected domain audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mn_test_reject_domain_success
        BEFORE INSERT ON mn_audit_events
        FOR EACH ROW EXECUTE FUNCTION mn_test_reject_domain_success();
    `);
    const runsBeforeRejectedCreate = firstStore.runs.size;
    const jobsBeforeRejectedCreate = Number((await faultRuntime.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mn_run_jobs"
    )).rows[0]!.count);
    const outboxBeforeRejectedCreate = Number((await faultRuntime.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mn_outbox"
    )).rows[0]!.count);
    const rejectedRunCreate = await first.inject({
      method: "POST",
      url: `/v1/tasks/${faultRunTask.json().id}/runs`,
      headers,
      payload: {}
    });
    assert.equal(rejectedRunCreate.statusCode, 500, rejectedRunCreate.body);
    assert.equal(firstStore.runs.size, runsBeforeRejectedCreate);
    assert.equal(
      Number((await faultRuntime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_run_jobs"
      )).rows[0]!.count),
      jobsBeforeRejectedCreate,
      "failed run.create audit must not leave an orphan queue row"
    );
    assert.equal(
      Number((await faultRuntime.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mn_outbox"
      )).rows[0]!.count),
      outboxBeforeRejectedCreate
    );
    await faultRuntime.pool.query(
      "DROP TRIGGER mn_test_reject_domain_success ON mn_audit_events"
    );

    const evalAsset = new EvalAssetRegistry().register({
      id: "postgres-restore-contract",
      revision: 1,
      kind: "contract_test",
      title: "PostgreSQL restore contract",
      specRef: {
        specSetId: unsignedRevision.specSetId,
        revision: approvedSpec.json().revision,
        digest: approvedSpec.json().digest
      },
      specClauseIds: ["accept-postgres-restore"],
      serviceIds: ["orders"],
      owner: "platform-team",
      source: {
        kind: "spec",
        ref: `spec:${unsignedRevision.specSetId}@${approvedSpec.json().revision}`,
        digest: approvedSpec.json().digest
      },
      contentRef: "tests/postgres-restore.test.ts",
      contentDigest: evidenceDigest,
      createdAt: "2026-07-12T00:10:00.000Z",
      createdBy: "admin@example.test"
    });
    firstStore.evalAssets.set(
      scopedEvidenceRecordKey(
        "tenant-restart",
        projectId,
        evalAsset.id,
        evalAsset.revision
      ),
      { tenantId: "tenant-restart", projectId, asset: evalAsset }
    );

    const task = await first.inject({
      method: "POST",
      url: "/v1/tasks",
      headers,
      payload: {
        projectId,
        title: "Durable classic task",
        prompt: "Verify enterprise metadata recovery.",
        acceptanceCriteria: ["Restart preserves the queued run."],
        strategy: {
          providers: ["codex"],
          candidates: 1,
          sandbox: "workspace-write",
          requiredGates: ["unit_test"],
          humanApproval: "never",
          timeoutSeconds: 60
        }
      }
    });
    assert.equal(task.statusCode, 201, task.body);
    const queuedRun = await first.inject({
      method: "POST",
      url: `/v1/tasks/${task.json().id}/runs`,
      headers,
      payload: {}
    });
    assert.equal(queuedRun.statusCode, 201, queuedRun.body);
    const runId = queuedRun.json().id as string;
    const enterpriseShadowQueue = new RunJobQueue({
      rootDir: join(root, "first-state", "run-job-queue")
    });
    assert.equal(
      enterpriseShadowQueue.read(runId),
      undefined,
      "enterprise queue must not create a file-backed shadow item"
    );
    const cancelledRun = await first.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers,
      payload: {}
    });
    assert.equal(cancelledRun.statusCode, 200, cancelledRun.body);
    const resumed = await first.inject({
      method: "POST",
      url: `/v1/runs/${runId}/resume`,
      headers,
      payload: {}
    });
    assert.equal(resumed.statusCode, 201, resumed.body);
    const resumedRunId = resumed.json().run.id as string;
    assert.equal(
      enterpriseShadowQueue.read(resumedRunId),
      undefined,
      "enterprise resume must use PostgreSQL as its only durable queue"
    );
    await first.close();

    const second = buildServer({ ...common, mniuRoot: join(root, "empty-second-state") });
    await second.ready();
    t.after(() => second.close());
    const restored = await second.inject({
      method: "GET",
      url: `/v1/projects/${projectId}`,
      headers
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().name, "PostgreSQL durable project");
    assert.equal(restored.json().tenantId, "tenant-restart");

    const restoredPack = await second.inject({
      method: "GET",
      url: "/v1/standard-packs",
      headers
    });
    assert.equal(restoredPack.statusCode, 200, restoredPack.body);
    assert.equal(restoredPack.json().standardPacks[0].key, `${manifest.id}@${manifest.version}`);
    const restoredLock = await second.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/standards-lock`,
      headers
    });
    assert.equal(restoredLock.statusCode, 200, restoredLock.body);
    const restoredWaivers = await second.inject({
      method: "GET",
      url: "/v1/waivers",
      headers
    });
    assert.equal(restoredWaivers.statusCode, 200, restoredWaivers.body);
    assert.equal(restoredWaivers.json().waivers[0].id, "postgres-durable-waiver");
    const restoredSpec = await second.inject({
      method: "GET",
      url: `/v1/spec-sets/${unsignedRevision.specSetId}`,
      headers
    });
    assert.equal(restoredSpec.statusCode, 200, restoredSpec.body);
    assert.equal(restoredSpec.json().revisions.at(-1).digest, approvedSpec.json().digest);
    const restoredAssets = await second.inject({
      method: "GET",
      url: `/v1/eval-assets?projectId=${projectId}`,
      headers
    });
    assert.equal(restoredAssets.statusCode, 200, restoredAssets.body);
    assert.equal(restoredAssets.json().evalAssets[0].id, "postgres-restore-contract");
    const restoredRun = await second.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers
    });
    assert.equal(restoredRun.statusCode, 200, restoredRun.body);
    assert.equal(restoredRun.json().taskId, task.json().id);
    const restoredEvents = await second.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events`,
      headers
    });
    assert.equal(restoredEvents.statusCode, 200, restoredEvents.body);
    assert.ok(
      restoredEvents.json().events.some(
        (event: { data?: { resumedRunId?: string } }) =>
          event.data?.resumedRunId === resumedRunId
      ),
      "source Run resume linkage must survive restart"
    );
    const restoredResumedRun = await second.inject({
      method: "GET",
      url: `/v1/runs/${resumedRunId}`,
      headers
    });
    assert.equal(restoredResumedRun.statusCode, 200, restoredResumedRun.body);
    const restoredResumedEvents = await second.inject({
      method: "GET",
      url: `/v1/runs/${resumedRunId}/events`,
      headers
    });
    assert.equal(restoredResumedEvents.statusCode, 200, restoredResumedEvents.body);
    assert.ok(
      restoredResumedEvents.json().events.some(
        (event: { data?: { sourceRunId?: string } }) =>
          event.data?.sourceRunId === runId
      ),
      "resumed Run source linkage must survive restart"
    );

    const health = await second.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200, health.body);
    assert.equal(health.json().metadataBackend, "postgresql");
    assert.equal(health.json().queueBackend, "postgresql");
    const audits = await second.inject({
      method: "GET",
      url: "/v1/audit-events",
      headers
    });
    assert.equal(audits.statusCode, 200, audits.body);
    assert.ok(audits.json().auditEvents.length >= 1);
    const persistedDomainAudits = (audits.json().auditEvents as Array<{
      action: string;
      actorId: string;
      tenantId: string;
      resourceId?: string;
      result: string;
      afterDigest?: string;
    }>).filter((event) => !event.action.includes(" "));
    const persistedActions = new Set(
      persistedDomainAudits.map((event) => event.action)
    );
    for (const action of [
      "standard_pack.import",
      "standard_pack.activate",
      "standards_lock.update",
      "waiver.create",
      "spec_set.create",
      "spec_revision.approve",
      "task.create",
      "run.create",
      "run.cancel",
      "run.resume"
    ]) {
      assert.equal(persistedActions.has(action), true, `missing durable domain audit ${action}`);
    }
    assert.ok(
      persistedDomainAudits
        .filter((event) => event.result === "success")
        .every(
        (event) =>
          event.actorId === "admin@example.test" &&
          event.tenantId === "tenant-restart" &&
          Boolean(event.resourceId) &&
          /^[a-f0-9]{64}$/u.test(event.afterDigest ?? "")
        )
    );
  }
);
