import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import { buildServer } from "../src/server.js";

const ISSUER = "https://id.control-plane.test";
const AUDIENCE = "mn-enterprise";
const ORIGIN = "https://console.control-plane.test";

function authFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const jwk = { ...publicJwk, kid: "control-plane-test", use: "sig", alg: "RS256" };
  const token = (tenantId: string, actorId = `${tenantId}@example.test`) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: actorId,
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        tenant_id: tenantId,
        roles: ["org_admin"],
        project_ids: []
      })
    ).toString("base64url");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      pair.privateKey
    ).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  return { jwk, token };
}

function enterpriseOptions(
  root: string,
  statePath: string,
  fixture: ReturnType<typeof authFixture>
) {
  return {
    runtimeProfile: "enterprise" as const,
    bindHost: "0.0.0.0",
    corsAllowlist: [ORIGIN],
    enterprisePostgres: false as const,
    telemetry: false as const,
    standardPackTrustProfile: false as const,
    sandboxAttestationKey: false as const,
    enterpriseProjectRoots: [root],
    artifactRemoteStore: {
      type: "s3" as const,
      rootDir: join(root, "artifact-mirror"),
      bucket: "mn-control-plane-test",
      endpointUrl: "http://127.0.0.1:19000"
    },
    auth: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/jwks`,
      fetchJwks: async () => ({ keys: [fixture.jwk] })
    },
    apiStatePath: statePath,
    mniuRoot: join(root, "mniu"),
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true
  };
}

function authorized(token: string) {
  return {
    origin: ORIGIN,
    authorization: `Bearer ${token}`
  };
}

function standardPack(requiredGate: string, tenantName: string) {
  return {
    schemaVersion: 1,
    id: "corp/shared-id",
    name: `${tenantName} standards`,
    version: "1.0.0",
    rules: {
      requiredGates: [requiredGate],
      waivableRules: [{ field: "requiredGates", value: requiredGate }],
      deny: [`${tenantName}-deny`],
      allowedProviders: ["codex"],
      commandAllowlist: ["npm"],
      budgets: { maxCandidates: 2, maxRepairAttempts: 2 },
      approvalMode: "before-merge"
    },
    specTemplates: ["service-change"],
    harnessProfiles: ["enterprise"],
    workflows: ["governed-increment-v1"],
    release: {
      sequence: 1,
      publishedAt: "2026-07-10T00:00:00.000Z"
    }
  };
}

function draftSpec(specSetId: string, targetService: string): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId,
    revision: 1,
    status: "draft",
    source: "native",
    title: `${targetService} contract`,
    hypothesis: "Tenant-owned specifications prevent cross-tenant disclosure.",
    outcomes: ["Only the owning tenant can read this revision."],
    nonGoals: ["Do not deploy automatically."],
    targetServices: [targetService],
    contracts: {
      interface: { openapi: `services/${targetService}/openapi.yaml` },
      data: { owner: targetService },
      state: { states: ["pending", "confirmed"] },
      permission: { roles: ["developer"] },
      exception: { timeout: "fail" },
      quality: { p95Ms: 500 },
      observability: { metrics: [`${targetService}_completed_total`] }
    },
    acceptanceCases: [
      {
        id: `accept-${targetService}`,
        kind: "positive",
        title: `Complete ${targetService}`,
        given: ["The request is valid."],
        when: "The operation is submitted.",
        then: ["The operation is confirmed."],
        targetService
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: `${targetService}@example.test`
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

function waiver(id: string, tenantId: string, value: string, reason: string) {
  const now = Date.now();
  return {
    id,
    target: { field: "requiredGates", value },
    scope: { level: "service", id: `${tenantId}-waiver-scope` },
    reason,
    approvedBy: `${tenantId}-reviewer@example.test`,
    approvedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString()
  };
}

test("control-plane resources remain tenant isolated before and after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-control-plane-tenants-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "api-state.json");
  const fixture = authFixture();
  const tenantAToken = fixture.token("tenant-a");
  const tenantBToken = fixture.token("tenant-b");
  const tenantAHeaders = authorized(tenantAToken);
  const tenantBHeaders = authorized(tenantBToken);
  const app = buildServer(enterpriseOptions(root, statePath, fixture));

  const projectA = (
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: tenantAHeaders,
      payload: { name: "tenant-a project", rootPath: root }
    })
  ).json();
  const projectB = (
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: tenantBHeaders,
      payload: { name: "tenant-b project", rootPath: root }
    })
  ).json();

  const importA = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    headers: tenantAHeaders,
    payload: { manifest: standardPack("contract", "tenant-a") }
  });
  const importB = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    headers: tenantBHeaders,
    payload: { manifest: standardPack("security", "tenant-b") }
  });
  assert.equal(importA.statusCode, 201);
  assert.equal(importB.statusCode, 201);
  assert.notEqual(importA.json().digest, importB.json().digest);

  for (const [headers, projectId] of [
    [tenantAHeaders, projectA.id],
    [tenantBHeaders, projectB.id]
  ] as const) {
    const activated = await app.inject({
      method: "POST",
      url: "/v1/standard-packs/activate",
      headers,
      payload: {
        id: "corp/shared-id",
        version: "1.0.0",
        scope: "project",
        scopeId: projectId
      }
    });
    assert.equal(activated.statusCode, 200);
  }

  const foreignActivation = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/activate",
    headers: tenantBHeaders,
    payload: {
      id: "corp/shared-id",
      version: "1.0.0",
      scope: "project",
      scopeId: projectA.id
    }
  });
  assert.equal(foreignActivation.statusCode, 404);

  const foreignOrganization = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/activate",
    headers: tenantBHeaders,
    payload: {
      id: "corp/shared-id",
      version: "1.0.0",
      scope: "organization",
      scopeId: "tenant-a"
    }
  });
  assert.equal(foreignOrganization.statusCode, 400);

  const waiverA = await app.inject({
    method: "POST",
    url: "/v1/waivers",
    headers: tenantAHeaders,
    payload: waiver("shared-waiver", "tenant-a", "contract", "tenant-a reason")
  });
  const waiverB = await app.inject({
    method: "POST",
    url: "/v1/waivers",
    headers: tenantBHeaders,
    payload: waiver("shared-waiver", "tenant-b", "security", "tenant-b reason")
  });
  assert.equal(waiverA.statusCode, 201);
  assert.equal(waiverB.statusCode, 201);

  const specA = draftSpec("tenant-a-spec", "checkout-a");
  const specB = draftSpec("tenant-b-spec", "checkout-b");
  for (const [headers, spec] of [
    [tenantAHeaders, specA],
    [tenantBHeaders, specB]
  ] as const) {
    const created = await app.inject({
      method: "POST",
      url: "/v1/spec-sets",
      headers,
      payload: {
        specSet: {
          id: spec.specSetId,
          title: spec.title,
          latestRevision: 0,
          createdAt: spec.createdAt,
          updatedAt: spec.createdAt
        },
        initialRevision: spec
      }
    });
    assert.equal(created.statusCode, 201, created.body);
  }

  const duplicateForeignSpec = await app.inject({
    method: "POST",
    url: "/v1/spec-sets",
    headers: tenantBHeaders,
    payload: {
      specSet: {
        id: specA.specSetId,
        title: specA.title,
        latestRevision: 0,
        createdAt: specA.createdAt,
        updatedAt: specA.createdAt
      }
    }
  });
  assert.equal(duplicateForeignSpec.statusCode, 409);
  assert.equal(duplicateForeignSpec.json().error, "spec set id is unavailable");

  for (const request of [
    { url: `/v1/spec-sets/${specA.specSetId}`, method: "GET" as const },
    {
      url: `/v1/spec-sets/${specA.specSetId}/revisions/1`,
      method: "GET" as const
    },
    {
      url: `/v1/spec-sets/${specA.specSetId}/revisions/1/approve`,
      method: "POST" as const,
      payload: { approvedBy: "tenant-b@example.test" }
    }
  ]) {
    const response = await app.inject({
      ...request,
      headers: tenantBHeaders
    });
    assert.equal(response.statusCode, 404);
  }

  for (const url of [
    `/v1/projects/${projectA.id}/standards-lock`,
    `/v1/projects/${projectA.id}/effective-governance`,
    `/v1/projects/${projectA.id}/policy/explain`
  ]) {
    const response = await app.inject({ method: "GET", url, headers: tenantBHeaders });
    assert.equal(response.statusCode, 404);
  }
  const forgedOrganizationQuery = await app.inject({
    method: "GET",
    url: `/v1/projects/${projectA.id}/effective-governance?organizationId=tenant-b`,
    headers: tenantAHeaders
  });
  assert.equal(forgedOrganizationQuery.statusCode, 400);

  const assertTenantView = async (
    currentApp: ReturnType<typeof buildServer>,
    headers: ReturnType<typeof authorized>,
    expected: {
      projectId: string;
      gate: string;
      deny: string;
      packDigest: string;
      specSetId: string;
      waiverReason: string;
    }
  ) => {
    const packs = await currentApp.inject({
      method: "GET",
      url: "/v1/standard-packs",
      headers
    });
    assert.equal(packs.statusCode, 200);
    assert.deepEqual(
      packs.json().standardPacks.map((record: { digest: string }) => record.digest),
      [expected.packDigest]
    );

    const diff = await currentApp.inject({
      method: "POST",
      url: "/v1/standard-packs/diff",
      headers,
      payload: { from: "corp/shared-id@1.0.0", to: "corp/shared-id@1.0.0" }
    });
    assert.equal(diff.statusCode, 200);
    assert.equal(diff.json().from.digest, expected.packDigest);

    const waivers = await currentApp.inject({
      method: "GET",
      url: "/v1/waivers",
      headers
    });
    assert.deepEqual(
      waivers.json().waivers.map((item: { reason: string }) => item.reason),
      [expected.waiverReason]
    );

    const specs = await currentApp.inject({
      method: "GET",
      url: "/v1/spec-sets",
      headers
    });
    assert.deepEqual(
      specs.json().specSets.map((record: { id: string }) => record.id),
      [expected.specSetId]
    );

    const effective = await currentApp.inject({
      method: "GET",
      url: `/v1/projects/${expected.projectId}/effective-governance`,
      headers
    });
    assert.equal(effective.statusCode, 200, effective.body);
    assert.ok(effective.json().snapshot.policy.requiredGates.includes(expected.gate));
    assert.equal(
      effective.json().snapshot.policy.deny.includes(
        expected.deny === "tenant-a-deny" ? "tenant-b-deny" : "tenant-a-deny"
      ),
      false
    );
    assert.ok(effective.json().snapshot.policy.deny.includes(expected.deny));
  };

  await assertTenantView(app, tenantAHeaders, {
    projectId: projectA.id,
    gate: "contract",
    deny: "tenant-a-deny",
    packDigest: importA.json().digest,
    specSetId: specA.specSetId,
    waiverReason: "tenant-a reason"
  });
  await assertTenantView(app, tenantBHeaders, {
    projectId: projectB.id,
    gate: "security",
    deny: "tenant-b-deny",
    packDigest: importB.json().digest,
    specSetId: specB.specSetId,
    waiverReason: "tenant-b reason"
  });

  await app.close();
  const restarted = buildServer(enterpriseOptions(root, statePath, fixture));
  t.after(() => restarted.close());
  await assertTenantView(restarted, tenantAHeaders, {
    projectId: projectA.id,
    gate: "contract",
    deny: "tenant-a-deny",
    packDigest: importA.json().digest,
    specSetId: specA.specSetId,
    waiverReason: "tenant-a reason"
  });
  await assertTenantView(restarted, tenantBHeaders, {
    projectId: projectB.id,
    gate: "security",
    deny: "tenant-b-deny",
    packDigest: importB.json().digest,
    specSetId: specB.specSetId,
    waiverReason: "tenant-b reason"
  });
});

test("local resource ids cannot impersonate a tenant-scoped persistence key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-control-plane-local-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "api-state.json");
  const mniuRoot = join(root, "mniu");
  const ambiguousId = JSON.stringify(["tenant-a", "looks-scoped"]);
  const local = buildServer({
    apiStatePath: statePath,
    mniuRoot,
    useMockExecutors: true
  });
  const created = await local.inject({
    method: "POST",
    url: "/v1/waivers",
    payload: waiver(ambiguousId, "local", "contract", "local-only reason")
  });
  assert.equal(created.statusCode, 201, created.body);
  await local.close();

  // Reproduce the ambiguous v2 snapshot emitted by the previous writer: a
  // local key was left raw, then its JSON-shaped id was misclassified as the
  // first array element's tenant. The v2 loader must migrate it back to local.
  const legacySnapshot = JSON.parse(await readFile(statePath, "utf8")) as {
    scopedWaivers: Array<{
      key: string;
      tenantId: string;
      waiver: { id: string };
    }>;
  };
  assert.equal(legacySnapshot.scopedWaivers.length, 1);
  legacySnapshot.scopedWaivers[0]!.key = ambiguousId;
  legacySnapshot.scopedWaivers[0]!.tenantId = "tenant-a";
  await writeFile(statePath, `${JSON.stringify(legacySnapshot, null, 2)}\n`, "utf8");

  const fixture = authFixture();
  const enterprise = buildServer(enterpriseOptions(root, statePath, fixture));
  const tenantView = await enterprise.inject({
    method: "GET",
    url: "/v1/waivers",
    headers: authorized(fixture.token("tenant-a"))
  });
  assert.equal(tenantView.statusCode, 200);
  assert.deepEqual(tenantView.json().waivers, []);
  await enterprise.close();

  const localRestart = buildServer({
    apiStatePath: statePath,
    mniuRoot,
    useMockExecutors: true
  });
  t.after(() => localRestart.close());
  const localView = await localRestart.inject({ method: "GET", url: "/v1/waivers" });
  assert.deepEqual(
    localView.json().waivers.map((item: { id: string }) => item.id),
    [ambiguousId]
  );
});
