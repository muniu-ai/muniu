import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import { createDefaultGateRegistry, runGateEngineV2 } from "../src/index.js";

function spec(status: SpecRevision["status"] = "approved"): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "checkout",
    revision: 1,
    status,
    source: "native",
    title: "Checkout",
    hypothesis: "Checkout remains compatible.",
    outcomes: ["Checkout completes."],
    nonGoals: ["No deployment."],
    targetServices: ["checkout"],
    contracts: {
      interface: { openapi: "openapi.yaml" },
      data: { owner: "checkout" },
      state: { states: ["pending", "confirmed"] },
      permission: { role: "customer" },
      exception: { timeout: "fail" },
      quality: { p95Ms: 500 },
      observability: { metric: "checkout_total" }
    },
    acceptanceCases: [
      {
        id: "accept-checkout",
        kind: "positive",
        title: "Complete checkout",
        given: ["Stock exists."],
        when: "Checkout starts.",
        then: ["Order is confirmed."]
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "owner@example.com",
    ...(status === "approved"
      ? {
          approvedAt: "2026-07-11T01:00:00.000Z",
          approvedBy: "reviewer@example.com"
        }
      : {})
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mn-policy-gates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function run(
  cwd: string,
  gateId: string,
  facts: Record<string, unknown>
) {
  const [result] = await runGateEngineV2({
    cwd,
    gates: [
      {
        id: gateId,
        required: true,
        language: "typescript",
        specClauseIds: ["accept-checkout"],
        facts
      }
    ],
    registry: createDefaultGateRegistry(),
    runId: "run-1",
    candidateId: "candidate-1",
    failClosed: true
  });
  return result!;
}

test("Spec schema, approval, and acceptance coverage gates bind evidence clauses", async (t) => {
  const root = await workspace(t);
  const approved = spec();
  assert.equal((await run(root, "spec_schema", { spec: approved })).status, "pass");
  assert.equal((await run(root, "spec_approval", { spec: approved })).status, "pass");
  const covered = await run(root, "acceptance_coverage", {
    spec: approved,
    coveredSpecClauseIds: ["accept-checkout"]
  });
  assert.equal(covered.status, "pass");
  assert.deepEqual(covered.specClauseIds, ["accept-checkout"]);

  const draft = await run(root, "spec_approval", { spec: spec("draft") });
  assert.equal(draft.status, "fail");
  const missing = await run(root, "acceptance_coverage", {
    spec: approved,
    coveredSpecClauseIds: []
  });
  assert.equal(missing.status, "fail");
});

test("protected path and diff scope gates fail closed", async (t) => {
  const root = await workspace(t);
  const protectedResult = await run(root, "protected_path", {
    changedPaths: ["src/app.ts", ".env"],
    protectedPaths: [".env", "secrets/**"]
  });
  assert.equal(protectedResult.status, "fail");
  assert.match(protectedResult.summary, /protected path/u);

  const diff = await run(root, "diff_scope", {
    changedPaths: ["services/checkout/app.ts", "services/payment/app.ts"],
    allowedPaths: ["services/checkout/**"]
  });
  assert.equal(diff.status, "fail");
});

test("OpenAPI and AsyncAPI contract gate detects removed surface", async (t) => {
  const root = await workspace(t);
  const current = `openapi: 3.1.0
paths:
  /v1/orders:
    get: {responses: {'200': {description: ok}}}
`;
  const previous = `openapi: 3.1.0
paths:
  /v1/orders:
    get: {responses: {'200': {description: ok}}}
  /v1/orders/{id}:
    get: {responses: {'200': {description: ok}}}
`;
  const broken = await run(root, "contract", {
    spec: spec(),
    contractDocuments: [
      {
        type: "openapi",
        path: "openapi.yaml",
        content: current,
        previousContent: previous
      }
    ]
  });
  assert.equal(broken.status, "fail");
  assert.match(broken.summary, /compatibility issue/u);
  assert.equal(broken.artifacts[0]?.kind, "contract");

  const asyncPass = await run(root, "contract", {
    contractDocuments: [
      {
        type: "asyncapi",
        path: "asyncapi.yaml",
        content: "asyncapi: 3.0.0\nchannels:\n  checkout.completed: {}\n"
      }
    ]
  });
  assert.equal(asyncPass.status, "pass");
});

test("migration safety requires matching rollback and flags destructive SQL", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, "migrations"));
  await writeFile(join(root, "migrations", "001_create.sql"), "create table orders(id bigint);\n");
  await writeFile(join(root, "migrations", "001_create_down.sql"), "drop table orders;\n");
  const safe = await run(root, "migration_safety", {
    changedPaths: ["migrations/001_create.sql"],
    rollbackPaths: ["migrations/001_create_down.sql"]
  });
  assert.equal(safe.status, "pass");

  await writeFile(join(root, "migrations", "002_drop.sql"), "drop table customers;\n");
  const unsafe = await run(root, "migration_safety", {
    changedPaths: ["migrations/002_drop.sql"],
    rollbackPaths: []
  });
  assert.equal(unsafe.status, "fail");
  assert.match(unsafe.summary, /migration safety issue/u);
});

test("security gate emits redacted SARIF-style evidence without secret content", async (t) => {
  const root = await workspace(t);
  const secret = "sk-1234567890abcdefghijklmnop";
  await writeFile(join(root, "config.ts"), `export const token = "${secret}";\n`);
  const result = await run(root, "security", { changedPaths: ["config.ts"] });
  assert.equal(result.status, "fail");
  assert.equal(result.artifacts[0]?.kind, "sarif");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("file-backed gates reject symlink and traversal inputs as errors", async (t) => {
  const root = await workspace(t);
  const external = await workspace(t);
  await writeFile(join(external, "migration.sql"), "drop table secrets;\n");
  await mkdir(join(root, "migrations"));
  await symlink(join(external, "migration.sql"), join(root, "migrations", "003.sql"));
  const symlinkResult = await run(root, "migration_safety", {
    changedPaths: ["migrations/003.sql"],
    rollbackPaths: []
  });
  assert.equal(symlinkResult.status, "error");

  const traversal = await run(root, "security", {
    changedPaths: ["../outside.ts"]
  });
  assert.equal(traversal.status, "error");
});
