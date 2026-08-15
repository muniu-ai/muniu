import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNextSpecRevision,
  digestSpecRevision,
  type SpecRevision
} from "@mn/specs";
import { buildServer } from "../src/server.js";

function draftSpec(): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "checkout-contract",
    revision: 1,
    status: "draft",
    source: "native",
    title: "Checkout contract",
    hypothesis: "A governed contract reduces integration failures.",
    outcomes: ["Contract tests prove compatibility."],
    nonGoals: ["Do not deploy automatically."],
    targetServices: ["checkout"],
    contracts: {
      interface: { openapi: "services/checkout/openapi.yaml" },
      data: { owner: "checkout" },
      state: { states: ["pending", "confirmed"] },
      permission: { roles: ["customer"] },
      exception: { timeout: "fail" },
      quality: { p95Ms: 500 },
      observability: { metrics: ["checkout_completed_total"] }
    },
    acceptanceCases: [
      {
        id: "accept-checkout",
        kind: "positive",
        title: "Complete checkout",
        given: ["Stock is available."],
        when: "The customer checks out.",
        then: ["The order is confirmed."],
        targetService: "checkout"
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "product@example.com"
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

function standardPack(version = "1.0.0") {
  return {
    schemaVersion: 1,
    id: "corp/checkout",
    name: "Checkout standards",
    version,
    rules: {
      requiredGates: ["contract"],
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

test("control plane persists Spec revisions and approves by appending a new revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-control-spec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = buildServer({
    mniuRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true
  });
  t.after(() => app.close());
  const draft = draftSpec();
  const create = await app.inject({
    method: "POST",
    url: "/v1/spec-sets",
    payload: {
      specSet: {
        id: draft.specSetId,
        title: draft.title,
        latestRevision: 0,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt
      },
      initialRevision: draft
    }
  });
  assert.equal(create.statusCode, 201);

  const approve = await app.inject({
    method: "POST",
    url: `/v1/spec-sets/${draft.specSetId}/revisions/1/approve`,
    payload: {
      approvedBy: "architect@example.com",
      approvedAt: "2026-07-11T01:00:00.000Z"
    }
  });
  assert.equal(approve.statusCode, 201);
  assert.equal(approve.json().revision, 2);
  assert.equal(approve.json().status, "approved");

  const nextRevision = createNextSpecRevision(approve.json() as SpecRevision, {
    hypothesis: "A revised governed contract also records an immutable audit trail.",
    createdAt: "2026-07-11T02:00:00.000Z"
  });
  const appendRevision = await app.inject({
    method: "POST",
    url: `/v1/spec-sets/${draft.specSetId}/revisions`,
    payload: nextRevision
  });
  assert.equal(appendRevision.statusCode, 201, appendRevision.body);
  assert.equal(appendRevision.json().revisions.at(-1).revision, 3);

  const get = await app.inject({
    method: "GET",
    url: `/v1/spec-sets/${draft.specSetId}`
  });
  assert.deepEqual(get.json().revisions.map((revision: { revision: number }) => revision.revision), [1, 2, 3]);
  assert.equal(get.json().specSet.latestRevision, 3);

  const audit = await app.inject({ method: "GET", url: "/v1/audit-events" });
  const domainAudits = (audit.json().auditEvents as Array<{
    action: string;
    resourceId?: string;
    beforeDigest?: string;
    afterDigest?: string;
  }>).filter((event) => !event.action.includes(" "));
  assert.deepEqual(
    domainAudits.map((event) => [event.action, event.resourceId]),
    [
      ["spec_set.create", draft.specSetId],
      ["spec_revision.approve", `${draft.specSetId}@2`],
      ["spec_revision.create", `${draft.specSetId}@3`]
    ]
  );
  assert.ok(
    domainAudits.slice(1).every(
      (event) =>
        /^[a-f0-9]{64}$/u.test(event.beforeDigest ?? "") &&
        /^[a-f0-9]{64}$/u.test(event.afterDigest ?? "")
    )
  );
});

test("standard pack activation yields deterministic effective governance, explain, and lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-control-governance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = buildServer({
    mniuRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true
  });
  t.after(() => app.close());
  const project = (
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "checkout", rootPath: root }
    })
  ).json();

  const imported = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: { manifest: standardPack(), importedBy: "governance@example.com" }
  });
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.json().trust, "local");

  const activated = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/activate",
    payload: {
      id: "corp/checkout",
      version: "1.0.0",
      scope: "project",
      scopeId: project.id,
      activatedBy: "governance@example.com"
    }
  });
  assert.equal(activated.statusCode, 200);
  assert.match(activated.json().lock.digest, /^[a-f0-9]{64}$/u);

  const effective = await app.inject({
    method: "GET",
    url: `/v1/projects/${project.id}/effective-governance?now=2026-07-11T02%3A00%3A00.000Z`
  });
  assert.equal(effective.statusCode, 200);
  assert.ok(effective.json().snapshot.policy.requiredGates.includes("contract"));
  assert.deepEqual(effective.json().snapshot.policy.allowedProviders, ["codex"]);
  assert.equal(effective.json().snapshot.policy.budgets.maxCandidates, 2);
  assert.equal(effective.json().snapshot.policy.approvalMode, "before-merge");

  const explanation = await app.inject({
    method: "GET",
    url: `/v1/projects/${project.id}/policy/explain?now=2026-07-11T02%3A00%3A00.000Z`
  });
  assert.equal(explanation.statusCode, 200);
  assert.equal(explanation.json().explanation.sources.length, 2);
  const lock = await app.inject({
    method: "GET",
    url: `/v1/projects/${project.id}/standards-lock`
  });
  assert.equal(lock.statusCode, 200);
  assert.equal(lock.json().lock.packs[0].id, "corp/checkout");
  assert.equal(lock.json().lock.packs[0].sequence, 1);
});

test("standard pack import rejects executable or version-conflicting content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-control-pack-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = buildServer({ mniuRoot: join(root, "state"), useMockExecutors: true });
  t.after(() => app.close());
  const invalid = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: { manifest: { ...standardPack(), scripts: { postinstall: "node evil.js" } } }
  });
  assert.equal(invalid.statusCode, 400);

  const first = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: { manifest: standardPack() }
  });
  assert.equal(first.statusCode, 201);
  const conflict = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: {
      manifest: {
        ...standardPack(),
        rules: { ...standardPack().rules, requiredGates: ["security"] }
      }
    }
  });
  assert.equal(conflict.statusCode, 409);
});

test("v2 API state retains imported packs and activated layers across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-control-persist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "api-state.json");
  const app1 = buildServer({
    apiStatePath: statePath,
    mniuRoot: join(root, "state"),
    useMockExecutors: true
  });
  const project = (
    await app1.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "persisted", rootPath: root }
    })
  ).json();
  await app1.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: { manifest: standardPack() }
  });
  await app1.inject({
    method: "POST",
    url: "/v1/standard-packs/activate",
    payload: {
      id: "corp/checkout",
      version: "1.0.0",
      scope: "project",
      scopeId: project.id
    }
  });
  await app1.close();

  const app2 = buildServer({
    apiStatePath: statePath,
    mniuRoot: join(root, "state"),
    useMockExecutors: true
  });
  t.after(() => app2.close());
  const packs = await app2.inject({ method: "GET", url: "/v1/standard-packs" });
  assert.equal(packs.json().standardPacks.length, 1);
  const effective = await app2.inject({
    method: "GET",
    url: `/v1/projects/${project.id}/effective-governance?now=2026-07-11T02%3A00%3A00.000Z`
  });
  assert.equal(effective.statusCode, 200);
  assert.ok(effective.json().snapshot.policy.requiredGates.includes("contract"));
});
