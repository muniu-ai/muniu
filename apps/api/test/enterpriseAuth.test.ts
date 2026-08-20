import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeGovernedIncrement,
  type GovernedStageHandlers
} from "@mn/loop";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import { buildServer } from "../src/server.js";
import {
  EnterpriseJwtAuthenticator,
  principalAllows,
  roleAllows,
  workerOwnerMatchesPrincipal
} from "../src/enterpriseAuth.js";
import { MemoryStore } from "../src/store.js";

const ISSUER = "https://id.example.test";
const AUDIENCE = "mn-enterprise";
const ORIGIN = "https://console.example.test";

function authFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const jwk = { ...publicJwk, kid: "enterprise-test", use: "sig", alg: "RS256" };
  const token = (claims: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }))
      .toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user@example.com",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      tenant_id: "tenant-a",
      roles: ["org_admin"],
      project_ids: [],
      ...claims
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

test("enterprise API refuses insecure startup profiles", () => {
  assert.throws(
    () => buildServer({ runtimeProfile: "enterprise" }),
    /Authentication is required/u
  );
  const fixture = authFixture();
  assert.throws(
    () => buildServer({
      runtimeProfile: "enterprise",
      auth: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: `${ISSUER}/jwks`,
        fetchJwks: async () => ({ keys: [fixture.jwk] })
      }
    }),
    /CORS allowlist/u
  );
  assert.throws(
    () => buildServer({
      runtimeProfile: "enterprise",
      corsAllowlist: [ORIGIN],
      enterprisePostgres: false,
      telemetry: false,
      standardPackTrustProfile: false,
      auth: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: `${ISSUER}/jwks`,
        fetchJwks: async () => ({ keys: [fixture.jwk] })
      }
    }),
    /project root allowlist/u
  );
  assert.throws(
    () => buildServer({ bindHost: "0.0.0.0" }),
    /Authentication is required/u
  );
});

test("evidence contribution RBAC keeps Learning approval and promotion privileged", () => {
  for (const role of ["developer", "project_owner"] as const) {
    assert.equal(roleAllows([role], "POST", "/v1/eval-assets"), true);
    assert.equal(roleAllows([role], "POST", "/v1/trace-graphs"), true);
    assert.equal(roleAllows([role], "POST", "/v1/maturity-report"), true);
    assert.equal(roleAllows([role], "POST", "/v1/learning-proposals"), true);
    assert.equal(
      roleAllows([role], "POST", "/v1/learning-proposals/proposal-1/submit"),
      true
    );
    assert.equal(
      roleAllows([role], "POST", "/v1/learning-proposals/proposal-1/review"),
      false
    );
    assert.equal(
      roleAllows([role], "POST", "/v1/learning-proposals/proposal-1/promote"),
      false
    );
  }
  assert.equal(
    roleAllows(["reviewer"], "POST", "/v1/learning-proposals/proposal-1/review"),
    true
  );
  assert.equal(
    roleAllows(["reviewer"], "POST", "/v1/learning-proposals/proposal-1/canary"),
    true
  );
  assert.equal(
    roleAllows(["reviewer"], "POST", "/v1/learning-proposals/proposal-1/promote"),
    false
  );
  assert.equal(
    roleAllows(
      ["governance_admin"],
      "POST",
      "/v1/learning-proposals/proposal-1/promote"
    ),
    true
  );
});

test("reviewer RBAC grants only the exact Agent approval decision mutation", () => {
  assert.equal(
    roleAllows(
      ["reviewer"],
      "POST",
      "/v1/agent-sessions/session-1/approvals/approval-1"
    ),
    true
  );
  assert.equal(
    roleAllows(["project_owner"], "POST", "/v1/agent-sessions/session-1/approvals/approval-1"),
    false
  );
  assert.equal(
    roleAllows(["reviewer"], "POST", "/v1/agent-sessions/session-1/messages"),
    false
  );
  assert.equal(
    roleAllows(["reviewer"], "DELETE", "/v1/agent-sessions/session-1/approvals/approval-1"),
    false
  );
});

test("machine principal scopes isolate worker queue operations from human approvals", async () => {
  const fixture = authFixture();
  const authenticator = new EnterpriseJwtAuthenticator({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: `${ISSUER}/jwks`,
    fetchJwks: async () => ({ keys: [fixture.jwk] })
  });
  const scopes = [
    "run_jobs:claim",
    "run_jobs:heartbeat",
    "run_jobs:checkpoint",
    "run_jobs:finish",
    "run_jobs:events",
    "run_jobs:release"
  ];
  const worker = await authenticator.authenticate(
    `Bearer ${fixture.token({
      sub: "worker-1",
      principal_type: "worker",
      roles: [],
      scopes
    })}`,
    "trace-worker"
  );
  assert.equal(worker.principalType, "worker");
  assert.deepEqual(worker.scopes, scopes);
  assert.equal(principalAllows(worker, "POST", "/v1/run-jobs/queue/claim"), true);
  assert.equal(principalAllows(worker, "GET", "/v1/run-jobs/queue"), true);
  assert.equal(principalAllows(worker, "GET", "/v1/run-jobs/workers"), true);
  assert.equal(
    principalAllows(worker, "POST", "/v1/run-jobs/queue/run-1/update"),
    true
  );
  assert.equal(
    principalAllows(worker, "POST", "/v1/run-jobs/queue/run-1/artifacts"),
    true
  );
  assert.equal(
    principalAllows(worker, "POST", "/v1/run-jobs/queue/run-1/measurements"),
    true
  );
  assert.equal(
    principalAllows(worker, "POST", "/v1/run-jobs/queue/run-1/resume-diff"),
    true
  );
  assert.equal(
    principalAllows(worker, "POST", "/v1/run-jobs/queue/run-1/usage-receipts"),
    true
  );
  assert.equal(
    principalAllows(
      worker,
      "POST",
      "/v1/run-jobs/queue/run-1/sandbox-runtime-proof"
    ),
    true
  );
  assert.equal(principalAllows(worker, "GET", "/v1/capabilities"), false);
  assert.equal(principalAllows(worker, "POST", "/v1/runs/run-1/approve"), false);
  assert.equal(workerOwnerMatchesPrincipal("worker-1", worker.actorId), true);
  assert.equal(workerOwnerMatchesPrincipal("worker-1@worker-pod-0", worker.actorId), true);
  assert.equal(workerOwnerMatchesPrincipal("worker-1@", worker.actorId), false);
  assert.equal(workerOwnerMatchesPrincipal("worker-10@worker-pod-0", worker.actorId), false);
  assert.equal(workerOwnerMatchesPrincipal("worker-1@../pod", worker.actorId), false);

  const human = await authenticator.authenticate(
    `Bearer ${fixture.token({ roles: ["project_owner"] })}`,
    "trace-human"
  );
  assert.equal(human.principalType, "human");
  assert.equal(principalAllows(human, "GET", "/v1/run-jobs/queue"), true);
  assert.equal(principalAllows(human, "HEAD", "/v1/run-jobs/queue/run-1"), true);
  assert.equal(principalAllows(human, "GET", "/v1/run-jobs/workers"), true);
  assert.equal(principalAllows(human, "GET", "/v1/usage/summary"), true);
  assert.equal(principalAllows(human, "POST", "/v1/run-jobs/queue/claim"), false);
  assert.equal(
    principalAllows(human, "POST", "/v1/run-jobs/queue/run-1/artifacts"),
    false
  );
  assert.equal(
    principalAllows(human, "POST", "/v1/run-jobs/queue/run-1/measurements"),
    false
  );
  assert.equal(
    principalAllows(human, "POST", "/v1/run-jobs/queue/run-1/usage-receipts"),
    false
  );
  assert.equal(
    principalAllows(
      human,
      "POST",
      "/v1/run-jobs/queue/run-1/sandbox-runtime-proof"
    ),
    false
  );
  assert.equal(
    principalAllows(human, "POST", "/v1/run-jobs/workers/heartbeat"),
    false
  );
  assert.equal(principalAllows(human, "POST", "/v1/runs/run-1/approve"), true);

  await assert.rejects(
    authenticator.authenticate(
      `Bearer ${fixture.token({
        principal_type: "worker",
        roles: ["project_owner"],
        scopes
      })}`,
      "trace-escalation"
    ),
    /worker principal cannot contain human roles/u
  );
});

test("enterprise JWT, RBAC, CORS, tenant isolation and audit fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-enterprise-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = authFixture();
  const app = buildServer({
    runtimeProfile: "enterprise",
    bindHost: "0.0.0.0",
    corsAllowlist: [ORIGIN],
    enterprisePostgres: false,
    telemetry: false,
    standardPackTrustProfile: false,
    sandboxAttestationKey: false,
    enterpriseSandboxImage: {
      reference: "node:22-alpine",
      digest: "9".repeat(64)
    },
    enterpriseProjectRoots: [root],
    artifactRemoteStore: {
      type: "s3",
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
    mniuRoot: join(root, "state"),
    useMockExecutors: true
  });
  t.after(() => app.close());

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().runtimeProfile, "enterprise");
  assert.equal("workspaceRoot" in health.json(), false);
  assert.equal("mniuRoot" in health.json(), false);
  assert.equal("secretVaultBackend" in health.json(), false);
  assert.equal("endpoint" in health.json().telemetry, false);
  assert.equal("rootDir" in health.json().artifactRemoteStore, false);

  const noToken = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: { origin: ORIGIN }
  });
  assert.equal(noToken.statusCode, 401);

  const reservedTenant = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${fixture.token({ tenant_id: "local" })}`
    }
  });
  assert.equal(reservedTenant.statusCode, 401);
  assert.match(reservedTenant.json().error, /reserved tenant/u);

  const badOrigin = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: {
      origin: "https://evil.example.test",
      authorization: `Bearer ${fixture.token({})}`
    }
  });
  assert.equal(badOrigin.statusCode, 403);

  const adminToken = fixture.token({});
  for (const [method, url, payload] of [
    ["GET", "/v1/system/diagnostics?homeDir=%2F", undefined],
    ["GET", "/v1/sessions?homeDir=%2F", undefined],
    ["POST", "/v1/providers/provider-1/enable", { homeDir: "/", dryRun: true }],
    ["GET", "/v1/mcp/servers", undefined],
    ["GET", "/v1/prompts/presets", undefined],
    ["GET", "/v1/skills", undefined],
    ["GET", "/v1/proxy/status", undefined],
    ["GET", "/v1/artifacts/store", undefined]
  ] as const) {
    const hidden = await app.inject({
      method,
      url,
      headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` },
      ...(payload === undefined ? {} : { payload })
    });
    assert.equal(hidden.statusCode, 404, `${method} ${url}: ${hidden.body}`);
  }
  const adminProviders = await app.inject({
    method: "GET",
    url: "/v1/providers",
    headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminProviders.statusCode, 200);
  for (const roles of [["auditor"], ["developer"]]) {
    const deniedProviders = await app.inject({
      method: "GET",
      url: "/v1/providers",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${fixture.token({ roles, project_ids: ["project-a"] })}`
      }
    });
    assert.equal(deniedProviders.statusCode, 403, roles[0]);
  }
  const crossTenantProvider = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` },
    payload: {
      app: "codex",
      name: "cross tenant",
      kind: "openai_compatible",
      apiFormat: "openai_responses",
      baseUrl: "https://provider.example.test",
      defaultModel: "model",
      config: { enterpriseScope: { tenantIds: ["tenant-b"], projectIds: [] } }
    }
  });
  assert.equal(crossTenantProvider.statusCode, 400);
  assert.match(crossTenantProvider.json().error, /crosses the authenticated tenant/u);
  const unavailableUsage = await app.inject({
    method: "GET",
    url: "/v1/usage/summary",
    headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` }
  });
  assert.equal(unavailableUsage.statusCode, 503);
  assert.match(unavailableUsage.json().error, /usage ledger is unavailable/u);

  const arbitraryRoot = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` },
    payload: { name: "outside project", rootPath: tmpdir() }
  });
  assert.equal(arbitraryRoot.statusCode, 400);
  assert.match(arbitraryRoot.json().error, /root allowlist/u);

  const traversalRoot = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` },
    payload: { name: "traversal project", rootPath: `${root}/nested/..` }
  });
  assert.equal(traversalRoot.statusCode, 400);
  assert.match(traversalRoot.json().error, /path traversal/u);

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` },
    payload: { name: "tenant-a project", rootPath: root }
  });
  assert.equal(projectResponse.statusCode, 201);
  assert.equal(projectResponse.json().tenantId, "tenant-a");

  const otherTenant = fixture.token({ tenant_id: "tenant-b" });
  const otherTenantHidden = await app.inject({
    method: "GET",
    url: "/v1/sessions?homeDir=%2F",
    headers: { origin: ORIGIN, authorization: `Bearer ${otherTenant}` }
  });
  assert.equal(otherTenantHidden.statusCode, 404);
  const idor = await app.inject({
    method: "GET",
    url: `/v1/projects/${projectResponse.json().id}`,
    headers: { origin: ORIGIN, authorization: `Bearer ${otherTenant}` }
  });
  assert.equal(idor.statusCode, 404);

  const developer = fixture.token({ roles: ["developer"] });
  const forbiddenAudit = await app.inject({
    method: "GET",
    url: "/v1/audit-events",
    headers: { origin: ORIGIN, authorization: `Bearer ${developer}` }
  });
  assert.equal(forbiddenAudit.statusCode, 403);

  const audit = await app.inject({
    method: "GET",
    url: "/v1/audit-events",
    headers: { origin: ORIGIN, authorization: `Bearer ${adminToken}` }
  });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json().auditEvents.length >= 2);
  assert.ok(
    audit.json().auditEvents.every(
      (event: { tenantId: string; traceId: string }) =>
        event.tenantId === "tenant-a" && event.traceId.length > 0
    )
  );

  const otherProjectAuditor = fixture.token({
    roles: ["auditor"],
    project_ids: ["project-b"]
  });
  const projectAuditIdor = await app.inject({
    method: "GET",
    url: `/v1/audit-events?projectId=${encodeURIComponent(projectResponse.json().id)}`,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${otherProjectAuditor}`
    }
  });
  assert.equal(projectAuditIdor.statusCode, 200);
  assert.deepEqual(projectAuditIdor.json().auditEvents, []);

  const scopedAuditor = fixture.token({
    roles: ["auditor"],
    project_ids: [projectResponse.json().id]
  });
  const scopedAudit = await app.inject({
    method: "GET",
    url: `/v1/audit-events?projectId=${encodeURIComponent(projectResponse.json().id)}`,
    headers: { origin: ORIGIN, authorization: `Bearer ${scopedAuditor}` }
  });
  assert.equal(scopedAudit.statusCode, 200);
  assert.ok(scopedAudit.json().auditEvents.length >= 1);
  assert.ok(
    scopedAudit.json().auditEvents.every(
      (event: { projectId?: string }) => event.projectId === projectResponse.json().id
    )
  );
});

test("enterprise worker registry and governance identities are bound to authenticated tenant and actor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-enterprise-worker-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = authFixture();
  const store = new MemoryStore();
  const app = buildServer({
    runtimeProfile: "enterprise",
    bindHost: "0.0.0.0",
    corsAllowlist: [ORIGIN],
    enterprisePostgres: false,
    telemetry: false,
    standardPackTrustProfile: false,
    sandboxAttestationKey: false,
    enterpriseSandboxImage: {
      reference: "node:22-alpine",
      digest: "9".repeat(64)
    },
    enterpriseProjectRoots: [root],
    artifactRemoteStore: {
      type: "s3",
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
    store,
    mniuRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true
  });
  t.after(() => app.close());

  const headersFor = (tenantId: string, actorId: string) => ({
    origin: ORIGIN,
    authorization: `Bearer ${fixture.token({ tenant_id: tenantId, sub: actorId })}`
  });
  const workerHeadersFor = (tenantId: string, actorId: string) => ({
    origin: ORIGIN,
    authorization: `Bearer ${fixture.token({
      tenant_id: tenantId,
      sub: actorId,
      principal_type: "worker",
      roles: [],
      scopes: ["run_jobs:heartbeat"]
    })}`
  });
  const tenantA = headersFor("tenant-a", "reviewer-a@example.test");
  const tenantB = headersFor("tenant-b", "reviewer-b@example.test");
  const workerA = workerHeadersFor("tenant-a", "shared-worker");
  const workerB = workerHeadersFor("tenant-b", "shared-worker");

  const heartbeatA = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/workers/heartbeat",
    headers: workerA,
    payload: {
      ownerId: "shared-worker",
      capacity: 1,
      lastError: "tenant-a-only",
      capabilities: { tenantIds: ["tenant-b"] }
    }
  });
  const heartbeatB = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/workers/heartbeat",
    headers: workerB,
    payload: {
      ownerId: "shared-worker",
      capacity: 2,
      lastError: "tenant-b-only"
    }
  });
  assert.equal(heartbeatA.statusCode, 200, heartbeatA.body);
  assert.equal(heartbeatB.statusCode, 200, heartbeatB.body);
  assert.deepEqual(heartbeatA.json().worker.capabilities.tenantIds, ["tenant-a"]);

  const humanClaimDenied = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    headers: tenantA,
    payload: { ownerId: "reviewer-a@example.test" }
  });
  assert.equal(humanClaimDenied.statusCode, 403);
  const workerControlPlaneDenied = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: workerA
  });
  assert.equal(workerControlPlaneDenied.statusCode, 403);

  const workersA = await app.inject({
    method: "GET",
    url: "/v1/run-jobs/workers",
    headers: tenantA
  });
  const workersB = await app.inject({
    method: "GET",
    url: "/v1/run-jobs/workers",
    headers: tenantB
  });
  assert.equal(workersA.statusCode, 200);
  assert.equal(workersB.statusCode, 200);
  assert.equal(workersA.json().workers.length, 1);
  assert.equal(workersB.json().workers.length, 1);
  assert.equal(workersA.json().workers[0].capacity, 1);
  assert.equal(workersA.json().workers[0].lastError, "tenant-a-only");
  assert.equal(workersB.json().workers[0].capacity, 2);
  assert.equal(workersB.json().workers[0].lastError, "tenant-b-only");

  const instanceHeartbeat = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/workers/heartbeat",
    headers: workerA,
    payload: { ownerId: "shared-worker@worker-pod-0", capacity: 1 }
  });
  assert.equal(instanceHeartbeat.statusCode, 200, instanceHeartbeat.body);
  assert.equal(instanceHeartbeat.json().worker.ownerId, "shared-worker@worker-pod-0");
  const foreignInstanceHeartbeat = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/workers/heartbeat",
    headers: workerA,
    payload: { ownerId: "another-worker@worker-pod-0", capacity: 1 }
  });
  assert.equal(foreignInstanceHeartbeat.statusCode, 403);

  const manifest = {
    schemaVersion: 1,
    id: "corp/identity",
    name: "Identity standards",
    version: "1.0.0",
    rules: {
      requiredGates: ["contract"],
      waivableRules: [{ field: "requiredGates", value: "contract" }],
      allowedProviders: ["codex"],
      commandAllowlist: ["npm"],
      budgets: { maxCandidates: 2, maxRepairAttempts: 2 },
      approvalMode: "before-merge"
    },
    specTemplates: ["service-change"],
    harnessProfiles: ["enterprise"],
    workflows: ["governed-increment-v1"]
  };
  const imported = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    headers: tenantA,
    payload: { manifest, importedBy: "forged-importer@example.test" }
  });
  assert.equal(imported.statusCode, 201, imported.body);
  assert.equal(imported.json().importedBy, "reviewer-a@example.test");

  const project = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: tenantA,
    payload: { name: "identity project", rootPath: root }
  });
  assert.equal(project.statusCode, 201, project.body);
  const activated = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/activate",
    headers: tenantA,
    payload: {
      id: manifest.id,
      version: manifest.version,
      scope: "project",
      scopeId: project.json().id,
      activatedBy: "forged-activator@example.test"
    }
  });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal([...store.governanceLayers.values()][0]?.activatedBy, "reviewer-a@example.test");

  const now = Date.now();
  const waiver = await app.inject({
    method: "POST",
    url: "/v1/waivers",
    headers: tenantA,
    payload: {
      id: "identity-waiver",
      target: { field: "requiredGates", value: "contract" },
      scope: { level: "project", id: project.json().id },
      reason: "approved identity must be authenticated",
      approvedBy: "forged-waiver-reviewer@example.test",
      approvedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString()
    }
  });
  assert.equal(waiver.statusCode, 201, waiver.body);
  assert.equal(waiver.json().approvedBy, "reviewer-a@example.test");
  // The identity assertion is complete; keep the later governed-run fixture
  // independent from waiver semantics under test elsewhere.
  store.waivers.clear();

  const effectiveGovernance = await app.inject({
    method: "GET",
    url: `/v1/projects/${project.json().id}/effective-governance?workflowId=governed-increment-v1&workflowVersion=1&workflowDigest=${"a".repeat(64)}&harnessProfileId=enterprise&harnessProfileVersion=1&harnessProfileDigest=${"b".repeat(64)}`,
    headers: tenantA
  });
  assert.equal(effectiveGovernance.statusCode, 200, effectiveGovernance.body);

  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "identity-spec",
    revision: 1,
    status: "draft",
    source: "native",
    title: "Authenticated approval",
    hypothesis: "Authenticated reviewers provide trustworthy provenance.",
    outcomes: ["Approval records match the JWT subject."],
    nonGoals: ["Do not deploy."],
    targetServices: [],
    contracts: {
      interface: { openapi: "services/identity/openapi.yaml" },
      data: { owner: "identity" },
      state: { states: ["draft", "approved"] },
      permission: { roles: ["reviewer"] },
      exception: { invalid: "reject" },
      quality: { p95Ms: 500 },
      observability: { metrics: ["identity_approved_total"] }
    },
    acceptanceCases: [{
      id: "accept-authenticated-reviewer",
      kind: "positive",
      title: "Bind approval identity",
      given: ["A reviewer is authenticated."],
      when: "The reviewer approves the Spec.",
      then: ["The JWT subject is persisted as approvedBy."],
      targetService: "identity"
    }],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "author@example.test"
  };
  const createdSpec = await app.inject({
    method: "POST",
    url: "/v1/spec-sets",
    headers: tenantA,
    payload: {
      specSet: {
        id: unsigned.specSetId,
        title: unsigned.title,
        latestRevision: 0,
        createdAt: unsigned.createdAt,
        updatedAt: unsigned.createdAt
      },
      initialRevision: { ...unsigned, digest: digestSpecRevision(unsigned) }
    }
  });
  assert.equal(createdSpec.statusCode, 201, createdSpec.body);
  const approved = await app.inject({
    method: "POST",
    url: "/v1/spec-sets/identity-spec/revisions/1/approve",
    headers: tenantA,
    payload: {
      approvedBy: "forged-spec-reviewer@example.test",
      createdBy: "forged-revision-author@example.test",
      approvedAt: "2026-07-11T01:00:00.000Z"
    }
  });
  assert.equal(approved.statusCode, 201, approved.body);
  assert.equal(approved.json().approvedBy, "reviewer-a@example.test");
  assert.equal(approved.json().createdBy, "reviewer-a@example.test");

  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: tenantA,
    payload: {
      projectId: project.json().id,
      title: "Authenticated run approval",
      prompt: "Exercise the governed approval identity binding.",
      specRef: {
        specSetId: unsigned.specSetId,
        revision: approved.json().revision,
        digest: approved.json().digest
      },
      strategy: {
        providers: ["codex"],
        candidates: 1,
        requiredGates: ["contract"],
        humanApproval: "before-merge"
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201, taskResponse.body);
  const queuedResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${taskResponse.json().id}/runs`,
    headers: tenantA,
    payload: { queueOnly: true }
  });
  assert.equal(queuedResponse.statusCode, 201, queuedResponse.body);
  const queued = queuedResponse.json();
  assert.ok(queued.governanceSnapshot && queued.harnessManifest);

  const completedStage = async () => ({
    status: "completed" as const,
    artifacts: []
  });
  const handlers: GovernedStageHandlers = {
    discovery: completedStage,
    specification: completedStage,
    impact_architecture: completedStage,
    implementation: completedStage,
    verification: completedStage,
    approval_demo: async () => ({
      status: "waiting_approval",
      artifacts: []
    }),
    learning: completedStage
  };
  const waiting = await executeGovernedIncrement({
    schemaVersion: 1,
    runId: queued.id,
    specRef: taskResponse.json().specRef,
    governanceSnapshot: queued.governanceSnapshot,
    harnessManifest: queued.harnessManifest,
    handlers,
    onCheckpoint: () => undefined,
    now: () => queued.updatedAt
  });
  assert.equal(waiting.status, "waiting_approval");
  store.governedLoopStates.set(queued.id, waiting);
  store.runs.set(queued.id, {
    ...queued,
    status: "waiting_approval",
    updatedAt: waiting.updatedAt
  });

  const runApproval = await app.inject({
    method: "POST",
    url: `/v1/runs/${queued.id}/approve`,
    headers: tenantA,
    payload: {
      decision: "approve",
      actorId: "forged-run-reviewer@example.test"
    }
  });
  assert.equal(runApproval.statusCode, 200, runApproval.body);
  assert.equal(
    store.governedLoopStates.get(queued.id)?.approval?.actorId,
    "reviewer-a@example.test",
    JSON.stringify(store.governedLoopStates.get(queued.id))
  );

  const rejectedActivation = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/activate",
    headers: tenantA,
    payload: {
      id: "corp/missing",
      version: "1.0.0",
      scope: "project",
      scopeId: project.json().id,
      activatedBy: "reviewer-a@example.test"
    }
  });
  assert.equal(rejectedActivation.statusCode, 404, rejectedActivation.body);

  const domainAudits = [...store.auditEvents.values()].filter(
    (event) => !event.action.includes(" ")
  );
  const successfulActions = new Set(
    domainAudits
      .filter((event) => event.result === "success")
      .map((event) => event.action)
  );
  for (const action of [
    "standard_pack.import",
    "standard_pack.activate",
    "standards_lock.update",
    "waiver.create",
    "spec_set.create",
    "spec_revision.approve",
    "governance.resolve_override",
    "task.create",
    "run.approve"
  ]) {
    assert.equal(successfulActions.has(action), true, `missing domain audit ${action}`);
  }
  assert.ok(
    domainAudits
      .filter((event) => event.result === "success")
      .every(
        (event) =>
          event.actorId === "reviewer-a@example.test" &&
          event.tenantId === "tenant-a" &&
          event.policyDecision === "allow" &&
          Boolean(event.resourceId) &&
          /^[a-f0-9]{64}$/u.test(event.afterDigest ?? "")
      )
  );
  assert.equal(
    domainAudits.find((event) => event.action === "standard_pack.import")?.resourceId,
    "corp/identity@1.0.0"
  );
  assert.equal(
    domainAudits.find((event) => event.action === "waiver.create")?.resourceId,
    "identity-waiver"
  );
  assert.equal(
    domainAudits.find((event) => event.action === "spec_set.create")?.resourceId,
    "identity-spec"
  );
  assert.ok(
    domainAudits.some(
      (event) =>
        event.action === "standard_pack.activate" &&
        event.resourceId === `project:${project.json().id}:corp/missing` &&
        event.result === "failure" &&
        event.policyDecision === "deny" &&
        event.statusCode === 404 &&
        event.afterDigest === undefined
    ),
    "a failed governance mutation must not forge success evidence"
  );
});
