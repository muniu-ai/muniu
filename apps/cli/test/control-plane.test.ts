import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";

const execFileAsync = promisify(execFile);

interface SeenRequest {
  method: string;
  url: string;
  body?: unknown;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

async function createCliFixture(
  t: TestContext,
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    seen: SeenRequest[]
  ) => Promise<void> | void
): Promise<{
  cwd: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  seen: SeenRequest[];
}> {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-control-plane-"));
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response, seen)).catch((error: unknown) => {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({
      apiUrl: `http://127.0.0.1:${address.port}`,
      projectId: "project-1"
    })}\n`
  );
  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const env = { ...process.env };
  delete env.MN_API_URL;
  return {
    cwd,
    entry: join(process.cwd(), "dist-test", "src", "index.js"),
    env,
    seen
  };
}

async function runCli(
  fixture: Awaited<ReturnType<typeof createCliFixture>>,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [fixture.entry, ...args], {
    cwd: fixture.cwd,
    env: fixture.env,
    timeout: 10_000
  });
}

const packYaml = `
schemaVersion: 1
id: enterprise/base
name: Enterprise Base
version: "1.0.0"
rules:
  requiredGates:
    - unit_test
  allowedProviders:
    - codex
`;

test("standards commands accept YAML and call the control-plane APIs", async (t) => {
  const fixture = await createCliFixture(t, async (request, response, seen) => {
    const body = await readBody(request);
    seen.push({ method: request.method ?? "", url: request.url ?? "", body });
    if (request.url === "/v1/standard-packs/validate") {
      sendJson(response, { valid: true, manifest: body });
      return;
    }
    if (request.url === "/v1/standard-packs/import") {
      sendJson(response, { key: "enterprise/base@1.0.0", digest: "a".repeat(64) }, 201);
      return;
    }
    if (request.url === "/v1/standard-packs/diff") {
      sendJson(response, { changed: true, changedFields: ["rules"] });
      return;
    }
    if (request.url === "/v1/standard-packs/activate") {
      sendJson(response, { activated: true });
      return;
    }
    if (request.url === "/v1/projects/project-1/standards-lock") {
      sendJson(response, { projectId: "project-1", lock: { digest: "b".repeat(64) } });
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });
  const file = join(fixture.cwd, "pack.yaml");
  const lockFile = join(fixture.cwd, "standards.lock.json");
  await writeFile(file, packYaml);

  await runCli(fixture, ["standards", "validate", "--file", file]);
  await runCli(fixture, ["standards", "import", "--file", file, "--actor", "alice"]);
  await runCli(fixture, [
    "standards",
    "diff",
    "--from",
    "enterprise/base@1.0.0",
    "--to",
    "enterprise/base@1.1.0"
  ]);
  await runCli(fixture, [
    "standards",
    "activate",
    "enterprise/base@1.0.0",
    "--scope",
    "project",
    "--scope-id",
    "project-1",
    "--actor",
    "alice"
  ]);
  await runCli(fixture, ["standards", "lock", "--out", lockFile]);

  assert.deepEqual(fixture.seen.map(({ method, url }) => `${method} ${url}`), [
    "POST /v1/standard-packs/validate",
    "POST /v1/standard-packs/import",
    "POST /v1/standard-packs/diff",
    "POST /v1/standard-packs/activate",
    "GET /v1/projects/project-1/standards-lock"
  ]);
  const validateBody = fixture.seen[0]?.body as Record<string, unknown>;
  assert.equal(validateBody.id, "enterprise/base");
  assert.deepEqual(fixture.seen[1]?.body, {
    manifest: validateBody,
    importedBy: "alice"
  });
  assert.deepEqual(fixture.seen[3]?.body, {
    id: "enterprise/base",
    version: "1.0.0",
    scope: "project",
    scopeId: "project-1",
    projectId: "project-1",
    activatedBy: "alice"
  });
  assert.equal(JSON.parse(await readFile(lockFile, "utf8")).projectId, "project-1");
});

test("spec commands initialize, validate, import, approve, diff and report status", async (t) => {
  const fixture = await createCliFixture(t, async (request, response, seen) => {
    const body = await readBody(request);
    seen.push({ method: request.method ?? "", url: request.url ?? "", body });
    if (request.method === "POST" && request.url === "/v1/spec-sets") {
      sendJson(response, body, 201);
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/v1/spec-sets/payments/revisions/1/approve"
    ) {
      sendJson(response, { specSetId: "payments", revision: 2, status: "approved" }, 201);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/spec-sets/payments") {
      sendJson(response, { specSet: { id: "payments", latestRevision: 2 }, revisions: [] });
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });
  const first = join(fixture.cwd, "payments.yaml");
  const second = join(fixture.cwd, "payments-v2.yaml");
  const reordered = join(fixture.cwd, "payments-reordered.yaml");

  await runCli(fixture, [
    "spec",
    "init",
    "--id",
    "payments",
    "--title",
    "Safe payment capture",
    "--hypothesis",
    "Approved payments can be captured exactly once.",
    "--service",
    "payments-api",
    "--out",
    first
  ]);
  const validation = await runCli(fixture, ["spec", "validate", "--file", first]);
  assert.match(validation.stdout, /"valid": true/);
  const firstDocument = JSON.parse(await readFile(first, "utf8")) as {
    revision: { contracts: Record<string, unknown> };
  };
  firstDocument.revision.contracts = Object.fromEntries(
    Object.entries(firstDocument.revision.contracts).reverse()
  );
  await writeFile(reordered, `${JSON.stringify(firstDocument, null, 2)}\n`);
  const noDiff = await runCli(fixture, [
    "spec",
    "diff",
    "--from",
    first,
    "--to",
    reordered
  ]);
  assert.match(noDiff.stdout, /"changed": false/);
  await runCli(fixture, ["spec", "import", "--file", first]);
  await runCli(fixture, ["spec", "approve", "payments@1", "--by", "reviewer-1"]);
  await runCli(fixture, ["spec", "status", "payments"]);

  await runCli(fixture, [
    "spec",
    "init",
    "--id",
    "payments",
    "--title",
    "Safer payment capture",
    "--hypothesis",
    "Approved payments can be captured exactly once.",
    "--service",
    "payments-api",
    "--out",
    second
  ]);
  const diff = await runCli(fixture, ["spec", "diff", "--from", first, "--to", second]);
  assert.match(diff.stdout, /"changed": true/);
  assert.match(diff.stdout, /title/);

  const imported = fixture.seen.find(({ url }) => url === "/v1/spec-sets")?.body as {
    specSet: { id: string };
    initialRevision: { source: string };
  };
  assert.equal(imported.specSet.id, "payments");
  assert.equal(imported.initialRevision.source, "native");
  assert.deepEqual(
    fixture.seen.find(({ url }) => url.endsWith("/approve"))?.body,
    { approvedBy: "reviewer-1" }
  );
});

test("task create derives strategy from capabilities and effective governance", async (t) => {
  const fixture = await createCliFixture(t, async (request, response, seen) => {
    const body = await readBody(request);
    seen.push({ method: request.method ?? "", url: request.url ?? "", body });
    if (request.url === "/v1/capabilities") {
      sendJson(response, {
        schemaVersion: 1,
        providers: [
          { kind: "provider", id: "claude", version: "1", status: "unavailable" },
          { kind: "provider", id: "codex", version: "1", status: "available" }
        ],
        gates: [
          { kind: "gate", id: "unit_test", version: "2", status: "available" },
          { kind: "gate", id: "contract", version: "1", status: "available" }
        ],
        workflows: [
          { kind: "workflow", id: "classic-v1", version: "2", status: "available" },
          { kind: "workflow", id: "classic-v1", version: "10", status: "available" }
        ],
        harnessProfiles: []
      });
      return;
    }
    if (request.url === "/v1/projects/project-1/effective-governance") {
      sendJson(response, {
        snapshot: {
          digest: "c".repeat(64),
          policy: {
            requiredGates: ["unit_test", "contract"],
            allowedProviders: ["codex"],
            budgets: { maxCandidates: 1, maxDurationSeconds: 900 },
            approvalMode: "before-merge"
          }
        }
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/tasks") {
      sendJson(response, { id: "task-1", ...(body as object) }, 201);
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });

  await runCli(fixture, [
    "task",
    "create",
    "--title",
    "Governed defaults",
    "--providers",
    "codex,codex"
  ]);

  const taskBody = fixture.seen.find(({ url }) => url === "/v1/tasks")?.body as {
    workflowRef: { id: string; version: string };
    strategy: Record<string, unknown>;
  };
  assert.deepEqual(taskBody.workflowRef, { id: "classic-v1", version: "10" });
  assert.deepEqual(taskBody.strategy, {
    providers: ["codex"],
    candidates: 1,
    sandbox: "isolated-worktree",
    humanApproval: "before-merge",
    requiredGates: ["contract", "unit_test"],
    timeoutSeconds: 900
  });
  await assert.rejects(
    runCli(fixture, [
      "task",
      "create",
      "--title",
      "Cannot bypass governance",
      "--providers",
      "claude",
      "--classic-fallback"
    ]),
    /unavailable or denied/
  );
  assert.equal(
    fixture.seen.filter(({ url }) => url === "/v1/tasks").length,
    1,
    "classic fallback must not bypass resolved governance"
  );
});

test("run --spec resolves approved Spec and runtime capabilities before creating the task", async (t) => {
  const unsignedSpec: Omit<SpecRevision, "digest"> = {
    specSetId: "payments",
    revision: 3,
    status: "approved",
    source: "native",
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "architect",
    approvedAt: "2026-07-11T00:01:00.000Z",
    approvedBy: "reviewer",
    title: "Capture payment",
    hypothesis: "Capture is idempotent.",
    outcomes: ["One capture"],
    nonGoals: ["Do not change settlement."],
    targetServices: ["payments-api"],
    contracts: {
      interface: {}, data: {}, state: {}, permission: {}, exception: {},
      quality: {}, observability: {}
    },
    acceptanceCases: [
      {
        id: "a1",
        kind: "positive",
        title: "Capture once",
        given: ["An approved payment"],
        when: "capture",
        then: ["one charge"]
      }
    ],
    risks: [],
    unknowns: []
  };
  const approvedSpec: SpecRevision = {
    ...unsignedSpec,
    digest: digestSpecRevision(unsignedSpec)
  };
  const specDigest = approvedSpec.digest;
  const fixture = await createCliFixture(t, async (request, response, seen) => {
    const body = await readBody(request);
    seen.push({ method: request.method ?? "", url: request.url ?? "", body });
    if (request.url === "/v1/spec-sets/payments/revisions/3") {
      sendJson(response, approvedSpec);
      return;
    }
    if (request.url === "/v1/capabilities") {
      sendJson(response, {
        providers: [{ kind: "provider", id: "codex", version: "1", status: "available" }],
        gates: [{ kind: "gate", id: "unit_test", version: "1", status: "available" }],
        workflows: [{ kind: "workflow", id: "governed-increment-v1", version: "4", status: "available" }],
        harnessProfiles: [{ kind: "harness_profile", id: "local", version: "2", status: "available" }]
      });
      return;
    }
    if (
      request.url ===
      "/v1/projects/project-1/effective-governance?specSetId=payments&specRevision=3"
    ) {
      sendJson(response, {
        snapshot: {
          digest: "e".repeat(64),
          specRef: { specSetId: "payments", revision: 3, digest: specDigest },
          policy: {
            requiredGates: ["unit_test"],
            allowedProviders: ["codex"],
            budgets: { maxCandidates: 1, maxDurationSeconds: 600 },
            approvalMode: "on-risk"
          }
        }
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/tasks") {
      sendJson(response, { id: "task-spec", ...(body as object) }, 201);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/tasks/task-spec/runs") {
      sendJson(response, { id: "run-spec", status: "queued" }, 201);
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });

  const result = await runCli(fixture, [
    "run",
    "--spec",
    "payments@3",
    "--workflow",
    "governed-increment-v1",
    "--harness-profile",
    "local",
    "--wait"
  ]);
  assert.match(result.stdout, /run-spec/);

  const task = fixture.seen.find(({ url }) => url === "/v1/tasks")?.body as {
    specRef: unknown;
    workflowRef: unknown;
    harnessProfileRef: unknown;
    acceptanceCriteria: string[];
  };
  assert.deepEqual(task.specRef, {
    specSetId: "payments",
    revision: 3,
    digest: specDigest
  });
  assert.deepEqual(task.workflowRef, { id: "governed-increment-v1", version: "4" });
  assert.deepEqual(task.harnessProfileRef, { id: "local", version: "2" });
  assert.deepEqual(task.acceptanceCriteria, ["one charge"]);
});

test("workflow, policy and audit commands expose JSON and file output", async (t) => {
  const fixture = await createCliFixture(t, async (request, response, seen) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "" });
    if (request.url === "/v1/workflows") {
      sendJson(response, {
        workflows: [
          { id: "classic-v1", version: "1", displayName: "Classic", status: "available" },
          { id: "governed-increment-v1", version: "1", displayName: "Governed", status: "available" }
        ]
      });
      return;
    }
    if (request.url === "/v1/projects/project-1/policy/explain?serviceId=payments-api") {
      sendJson(response, { snapshotDigest: "f".repeat(64), explanation: { summary: "strict" } });
      return;
    }
    if (request.url === "/v1/audit-events?projectId=project-1&limit=25") {
      sendJson(response, { auditEvents: [{ id: "audit-1" }] });
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });
  const auditFile = join(fixture.cwd, "audit.json");

  const list = await runCli(fixture, ["workflow", "list"]);
  assert.match(list.stdout, /governed-increment-v1/);
  const show = await runCli(fixture, ["workflow", "show", "classic-v1"]);
  assert.doesNotMatch(show.stdout, /governed-increment-v1/);
  await runCli(fixture, ["policy", "explain", "--service", "payments-api"]);
  await runCli(fixture, ["audit", "export", "--limit", "25", "--out", auditFile]);
  assert.equal(JSON.parse(await readFile(auditFile, "utf8")).auditEvents[0].id, "audit-1");
});

test("legacy task creation requires an explicit classic fallback when discovery is unavailable", async (t) => {
  const fixture = await createCliFixture(t, async (request, response, seen) => {
    const body = await readBody(request);
    seen.push({ method: request.method ?? "", url: request.url ?? "", body });
    if (request.url === "/v1/capabilities") {
      sendJson(response, { error: "old api" }, 404);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/tasks") {
      sendJson(response, { id: "classic-task" }, 201);
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });

  await assert.rejects(
    runCli(fixture, ["task", "create", "--title", "No silent fallback"]),
    /--classic-fallback/
  );
  const fallback = await runCli(fixture, [
    "task",
    "create",
    "--title",
    "Explicit fallback",
    "--classic-fallback"
  ]);
  assert.match(fallback.stderr, /classic-v1 fallback/);
  assert.match(fallback.stdout, /classic-task/);
});

test("help advertises the enterprise Spec-Harness-Loop commands", async (t) => {
  const fixture = await createCliFixture(t, (_request, response) => {
    sendJson(response, { error: "not expected" }, 500);
  });
  const result = await runCli(fixture, ["--help"]);
  assert.match(result.stdout, /mn standards validate/);
  assert.match(result.stdout, /mn spec init/);
  assert.match(result.stdout, /mn policy explain/);
  assert.match(result.stdout, /mn workflow list/);
  assert.match(result.stdout, /mn audit export/);
  assert.match(result.stdout, /mn run --spec/);
  assert.match(result.stdout, /--classic-fallback/);
});
