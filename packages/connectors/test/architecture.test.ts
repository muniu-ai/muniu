import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import {
  analyzeSpecImpact,
  indexArchitectureRepository,
  indexRepository,
  parseProjectManifest
} from "../src/index.js";

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mn-architecture-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, ".mn"), { recursive: true }),
    mkdir(join(root, ".github", "workflows"), { recursive: true }),
    mkdir(join(root, "services", "checkout", "migrations"), { recursive: true }),
    mkdir(join(root, "services", "payment"), { recursive: true })
  ]);
  await writeFile(
    join(root, ".mn", "project.yaml"),
    `apiVersion: mn.dev/project/v1
kind: Project
metadata:
  id: commerce
  owner: platform
services:
  - id: checkout
    path: services/checkout
    owners: [checkout-team]
    dependencies:
      - service: payment
        kind: sync
        contract: openapi
    data:
      - kind: database
        name: commerce-db
        role: owner
      - kind: topic
        name: checkout.completed
        role: publisher
    commands:
      test: npm test
    observability:
      metrics: [checkout_completed_total]
      traces: [checkout]
    deployment:
      unit: checkout
      rollbackCommand: ./rollback.sh
  - id: payment
    path: services/payment
    owners: [payment-team]
    data:
      - kind: database
        name: commerce-db
        role: writer
      - kind: topic
        name: checkout.completed
        role: consumer
    observability:
      metrics: [payment_completed_total]
      traces: [payment]
    deployment:
      unit: payment
consistency:
  - id: checkout-payment
    participants: [checkout, payment]
    strategy: saga
`,
    "utf8"
  );
  await writeFile(
    join(root, ".github", "CODEOWNERS"),
    "/services/checkout/ @checkout-fallback\n/services/payment/ @payment-fallback\n",
    "utf8"
  );
  await writeFile(join(root, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
  await writeFile(
    join(root, "services", "checkout", "package.json"),
    JSON.stringify({ name: "@corp/checkout", dependencies: { "@corp/payment": "1.0.0" } }),
    "utf8"
  );
  await writeFile(
    join(root, "services", "checkout", "openapi.yaml"),
    "openapi: 3.1.0\ninfo: {title: checkout, version: 1.0.0}\n",
    "utf8"
  );
  await writeFile(
    join(root, "services", "checkout", "events.asyncapi.yaml"),
    "asyncapi: 3.0.0\ninfo: {title: checkout, version: 1.0.0}\n",
    "utf8"
  );
  await writeFile(
    join(root, "services", "checkout", "migrations", "001_checkout.sql"),
    "create table checkout(id bigint primary key);\n",
    "utf8"
  );
  await writeFile(
    join(root, "services", "payment", "go.mod"),
    "module corp/payment\n\ngo 1.23\n",
    "utf8"
  );
  await writeFile(join(root, "services", "payment", "payment.proto"), "syntax = \"proto3\";\n", "utf8");
  return root;
}

function approvedSpec(overrides: Partial<SpecRevision> = {}): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "checkout-payment",
    revision: 1,
    status: "approved",
    source: "native",
    title: "Checkout payment contract",
    hypothesis: "A versioned checkout event keeps payment compatible.",
    outcomes: ["Checkout and payment remain consistent."],
    nonGoals: ["Do not deploy automatically."],
    targetServices: ["checkout", "payment"],
    contracts: {
      interface: { breaking: true, openapi: "services/checkout/openapi.yaml" },
      data: { owner: "checkout", resource: "commerce-db" },
      state: { transition: "pending->confirmed" },
      permission: { roles: ["customer"] },
      exception: { timeout: "compensate" },
      quality: { p95Ms: 500 },
      observability: { metrics: ["checkout_completed_total"] }
    },
    acceptanceCases: [
      {
        id: "accept-checkout",
        kind: "positive",
        title: "Complete checkout",
        given: ["Payment is available."],
        when: "Checkout completes.",
        then: ["Payment observes the event."]
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "architect@example.com",
    approvedAt: "2026-07-11T01:00:00.000Z",
    approvedBy: "reviewer@example.com",
    ...overrides
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

test("parses a strict enterprise project manifest", () => {
  const manifest = parseProjectManifest(`
apiVersion: mn.dev/project/v1
kind: Project
metadata: { id: catalog, owner: platform }
services:
  - id: catalog
    path: services/catalog
    owners: [catalog-team]
`);
  assert.equal(manifest.metadata.id, "catalog");
  assert.equal(manifest.services[0]?.path, "services/catalog");
  assert.ok(Object.isFrozen(manifest));
  assert.throws(
    () => parseProjectManifest("apiVersion: bad\nkind: Project\nservices: []\n"),
    /project manifest/i
  );
});

test("indexes manifest-authoritative services, contracts, owners, migrations, CI and dependencies", async (t) => {
  const root = await fixture(t);
  const index = await indexArchitectureRepository(root);
  assert.equal(index.projectId, "commerce");
  assert.deepEqual(index.services.map((service) => service.id), ["checkout", "payment"]);
  const checkout = index.services[0]!;
  assert.deepEqual(checkout.owners, ["checkout-team"]);
  assert.deepEqual(checkout.contracts.map((contract) => contract.type).sort(), ["asyncapi", "openapi"]);
  assert.equal(checkout.migrations.length, 1);
  assert.deepEqual(checkout.dependencies.map((dependency) => dependency.service), ["payment"]);
  assert.equal(index.ciFiles[0], ".github/workflows/ci.yml");
  assert.match(index.digest, /^[a-f0-9]{64}$/u);
});

test("reports shared data ownership and missing rollback as architecture risks", async (t) => {
  const index = await indexArchitectureRepository(await fixture(t));
  assert.ok(index.issues.some((issue) => issue.code === "SHARED_DATABASE" && issue.level === "L4"));
  assert.ok(index.issues.some((issue) => issue.code === "MISSING_ROLLBACK" && issue.services.includes("payment")));
});

test("builds a conservative L0-L4 Spec impact matrix with required gates", async (t) => {
  const index = await indexArchitectureRepository(await fixture(t));
  const report = analyzeSpecImpact(index, approvedSpec());
  assert.equal(report.overallLevel, "L4");
  assert.ok(report.matrix.some((entry) => entry.dimension === "interface" && entry.level === "L4"));
  assert.ok(report.matrix.some((entry) => entry.dimension === "data"));
  assert.ok(report.requiredGates.includes("contract"));
  assert.ok(report.requiredGates.includes("migration_safety"));
  assert.ok(report.requiredApprovals.includes("cross_service_owner"));
  assert.deepEqual(report.trace.acceptanceCaseIds, ["accept-checkout"]);
});

test("fails closed for unknown target services and path traversal in manifest", async (t) => {
  const root = await fixture(t);
  const index = await indexArchitectureRepository(root);
  const report = analyzeSpecImpact(
    index,
    approvedSpec({ targetServices: ["unknown-service"] })
  );
  assert.equal(report.overallLevel, "L4");
  assert.ok(report.findings.some((finding) => finding.code === "UNKNOWN_TARGET_SERVICE"));

  await writeFile(
    join(root, ".mn", "project.yaml"),
    "apiVersion: mn.dev/project/v1\nkind: Project\nmetadata: {id: bad}\nservices:\n  - id: bad\n    path: ../outside\n    owners: [team]\n",
    "utf8"
  );
  await assert.rejects(indexArchitectureRepository(root), /outside|path traversal|within/i);
});

test("uses repository-relative semantics for stable architecture digests", async (t) => {
  const first = await indexArchitectureRepository(await fixture(t));
  const second = await indexArchitectureRepository(await fixture(t));

  assert.notEqual(first.rootPath, second.rootPath);
  assert.equal(first.digest, second.digest);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.services));
  assert.ok(Object.isFrozen(first.services[0]));
});

test("does not follow symbolic links during service discovery", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "mn-architecture-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(
    join(outside, "escape.openapi.yaml"),
    "openapi: 3.1.0\ninfo: {title: escape, version: 1.0.0}\n",
    "utf8"
  );
  await symlink(outside, join(root, "services", "checkout", "outside-link"));

  const index = await indexArchitectureRepository(root);
  const checkout = index.services.find(({ id }) => id === "checkout")!;
  assert.equal(
    checkout.contracts.some(({ path }) => path.includes("escape.openapi")),
    false
  );
  assert.ok(index.warnings.some((warning) => warning.includes("symbolic link")));
});

test("keeps classic repository indexing compatible with absolute paths", async (t) => {
  const legacy = await indexRepository(await fixture(t));
  const checkout = legacy.services.find(({ id }) => id === "checkout")!;

  assert.deepEqual(checkout.owners, ["checkout-team"]);
  assert.ok(isAbsolute(checkout.path));
  assert.ok(checkout.contracts.every(({ path }) => isAbsolute(path)));
  assert.ok(Object.isFrozen(legacy));
});

test("impact analysis is immutable, deterministic, and rejects a forged index", async (t) => {
  const index = await indexArchitectureRepository(await fixture(t));
  const previous = approvedSpec();
  const current = approvedSpec({
    revision: 2,
    createdAt: "2026-07-12T00:00:00.000Z",
    approvedAt: "2026-07-12T01:00:00.000Z"
  });
  const first = analyzeSpecImpact(index, current, previous);
  const second = analyzeSpecImpact(index, current, previous);

  assert.equal(first.digest, second.digest);
  assert.ok(first.matrix.every(({ level }) => level === "L0"));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.matrix));
  assert.throws(
    () => analyzeSpecImpact({ ...index, projectId: "forged" }, current),
    /digest does not match/i
  );
});

test("detects Redis, topic, observability, owner, and consistency risks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-architecture-risks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, ".mn"), { recursive: true }),
    mkdir(join(root, "services", "alpha"), { recursive: true }),
    mkdir(join(root, "services", "beta"), { recursive: true })
  ]);
  await writeFile(
    join(root, ".mn", "project.yaml"),
    `apiVersion: mn.dev/project/v1
kind: Project
metadata: {id: risk-fixture}
services:
  - id: alpha
    path: services/alpha
    owners: [alpha-team]
    data:
      - {kind: redis, name: shared-cache, role: owner}
      - {kind: topic, name: shared.events, role: publisher}
  - id: beta
    path: services/beta
    owners: [beta-team]
    data:
      - {kind: redis, name: shared-cache, role: writer}
      - {kind: topic, name: shared.events, role: publisher}
`,
    "utf8"
  );

  const index = await indexArchitectureRepository(root);
  const codes = new Set(index.issues.map(({ code }) => code));
  assert.ok(codes.has("SHARED_REDIS_NAMESPACE"));
  assert.ok(codes.has("TOPIC_MULTI_OWNER"));
  assert.ok(codes.has("CROSS_SERVICE_WITHOUT_CONSISTENCY"));
  assert.ok(codes.has("MISSING_OBSERVABILITY"));

  const discoveredRoot = await mkdtemp(
    join(tmpdir(), "mn-architecture-codeowners-")
  );
  t.after(() => rm(discoveredRoot, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(discoveredRoot, ".github"), { recursive: true }),
    mkdir(join(discoveredRoot, "services", "catalog"), { recursive: true }),
    mkdir(join(discoveredRoot, "services", "orphan"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(
      join(discoveredRoot, ".github", "CODEOWNERS"),
      "/services/catalog/ @catalog-team\n",
      "utf8"
    ),
    writeFile(
      join(discoveredRoot, "services", "catalog", "package.json"),
      JSON.stringify({ name: "@corp/catalog" }),
      "utf8"
    ),
    writeFile(
      join(discoveredRoot, "services", "orphan", "package.json"),
      JSON.stringify({ name: "@corp/orphan" }),
      "utf8"
    )
  ]);
  const discovered = await indexArchitectureRepository(discoveredRoot);
  assert.deepEqual(
    discovered.services.find(({ id }) => id === "catalog")?.owners,
    ["@catalog-team"]
  );
  assert.ok(
    discovered.issues.some(
      ({ code, services }) => code === "MISSING_OWNER" && services.includes("orphan")
    )
  );
});

test("classifies business-scope-only Spec revisions as L1", async (t) => {
  const index = await indexArchitectureRepository(await fixture(t));
  const previous = approvedSpec();
  const current = approvedSpec({
    revision: 2,
    hypothesis: "A clarified business hypothesis with no code contract change.",
    createdAt: "2026-07-12T00:00:00.000Z",
    approvedAt: "2026-07-12T01:00:00.000Z"
  });
  const report = analyzeSpecImpact(index, current, previous);
  const regression = report.matrix.find(({ dimension }) => dimension === "regression")!;
  const release = report.matrix.find(({ dimension }) => dimension === "release")!;

  assert.equal(regression.level, "L1");
  assert.equal(release.level, "L1");
  assert.deepEqual(regression.requiredGates, []);
  assert.ok(
    report.matrix
      .filter(({ dimension }) => dimension !== "regression" && dimension !== "release")
      .every(({ level }) => level === "L0")
  );
});
