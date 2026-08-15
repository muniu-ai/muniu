import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CLASSIC_WORKFLOW_REF,
  GOVERNED_INCREMENT_WORKFLOW_REF
} from "@mn/core";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import {
  buildCapabilitiesDocument,
  createDefaultRuntimeCapabilityCatalog,
  type RuntimeCapabilityCatalog
} from "../src/capabilities.js";
import { buildServer } from "../src/server.js";
import {
  BUILTIN_DEFAULT_STANDARD_PACK,
  LOCAL_TENANT_ID,
  MemoryStore
} from "../src/store.js";

test("default catalog truthfully declares providers, legacy gates, workflows, and profiles", () => {
  const catalog = createDefaultRuntimeCapabilityCatalog();

  assert.deepEqual(
    catalog.providers.map(({ id }) => id),
    ["claude", "codex"]
  );
  assert.deepEqual(
    catalog.gates.map(({ id }) => id),
    [
      "acceptance_coverage",
      "contract",
      "diff_scope",
      "human_approval",
      "lint",
      "llm_verifier",
      "migration_safety",
      "protected_path",
      "security",
      "spec_approval",
      "spec_schema",
      "typecheck",
      "unit_test"
    ]
  );
  assert.equal(
    catalog.gates.find(({ id }) => id === "unit_test")?.status,
    "available"
  );
  assert.equal(
    catalog.gates.find(({ id }) => id === "contract")?.status,
    "available"
  );
  assert.deepEqual(
    catalog.workflows.map(({ id, status }) => ({ id, status })),
    [
      { id: "classic-v1", status: "available" },
      { id: "governed-increment-v1", status: "available" }
    ]
  );
  assert.deepEqual(
    catalog.harnessProfiles.map(({ id, status }) => ({ id, status })),
    [
      { id: "enterprise", status: "declared" },
      { id: "local", status: "available" }
    ]
  );
});

test("capability document sorting and semantic digest ignore generatedAt", () => {
  const injected: RuntimeCapabilityCatalog = {
    providers: [
      descriptor("provider", "codex", "available"),
      descriptor("provider", "claude", "available")
    ],
    gates: [
      descriptor("gate", "z-gate", "unavailable"),
      descriptor("gate", "a-gate", "available")
    ],
    workflows: [
      descriptor("workflow", "z-workflow", "declared"),
      descriptor("workflow", "a-workflow", "available")
    ],
    harnessProfiles: [
      descriptor("harness_profile", "z-profile", "declared"),
      descriptor("harness_profile", "a-profile", "available")
    ]
  };

  const first = buildCapabilitiesDocument(
    injected,
    "2026-07-11T00:00:00.000Z"
  );
  const second = buildCapabilitiesDocument(
    injected,
    "2026-07-11T00:00:01.000Z"
  );

  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.providers.map(({ id }) => id), ["claude", "codex"]);
  assert.deepEqual(first.gates.map(({ id }) => id), ["a-gate", "z-gate"]);
  assert.deepEqual(first.workflows.map(({ id }) => id), [
    "a-workflow",
    "z-workflow"
  ]);
  assert.deepEqual(first.harnessProfiles.map(({ id }) => id), [
    "a-profile",
    "z-profile"
  ]);
});

test("capability discovery endpoints consume an injected catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-api-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capabilityCatalog: RuntimeCapabilityCatalog = {
    providers: [descriptor("provider", "codex", "available")],
    gates: [descriptor("gate", "custom_gate", "available")],
    workflows: [descriptor("workflow", "custom-workflow", "available")],
    harnessProfiles: [
      descriptor("harness_profile", "custom-profile", "declared")
    ]
  };
  const app = buildServer({
    capabilityCatalog,
    mniuRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true
  });
  t.after(() => app.close());

  const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
  const workflows = await app.inject({ method: "GET", url: "/v1/workflows" });
  const profiles = await app.inject({
    method: "GET",
    url: "/v1/harness-profiles"
  });

  assert.equal(capabilities.statusCode, 200);
  assert.equal(workflows.statusCode, 200);
  assert.equal(profiles.statusCode, 200);
  assert.deepEqual(capabilities.json().providers.map(({ id }: { id: string }) => id), [
    "codex"
  ]);
  assert.deepEqual(workflows.json().workflows.map(({ id }: { id: string }) => id), [
    "custom-workflow"
  ]);
  assert.deepEqual(
    profiles.json().harnessProfiles.map(({ id }: { id: string }) => id),
    ["custom-profile"]
  );
  assert.match(capabilities.json().digest, /^[a-f0-9]{64}$/);
  assert.match(workflows.json().digest, /^[a-f0-9]{64}$/);
  assert.match(profiles.json().digest, /^[a-f0-9]{64}$/);
});

test("new tasks and runs persist deterministic workflow and local tenant bindings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-api-task-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryStore();
  const app = buildServer({
    store,
    mniuRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true
  });
  t.after(() => app.close());

  const projectResponse = await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: { name: "demo", rootPath: root, defaultBranch: "main" }
  });
  assert.equal(projectResponse.statusCode, 201);
  const project = projectResponse.json();
  assert.equal(project.tenantId, LOCAL_TENANT_ID);
  assert.equal(project.policyId, BUILTIN_DEFAULT_STANDARD_PACK);

  const legacyResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "legacy",
      prompt: "keep classic behavior"
    }
  });
  assert.equal(legacyResponse.statusCode, 201);
  const legacy = legacyResponse.json();
  assert.equal(legacy.tenantId, LOCAL_TENANT_ID);
  assert.deepEqual(legacy.workflowRef, CLASSIC_WORKFLOW_REF);

  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${legacy.id}/runs`,
    payload: { queueOnly: true }
  });
  assert.equal(runResponse.statusCode, 201);
  assert.equal(runResponse.json().tenantId, LOCAL_TENANT_ID);
  assert.deepEqual(runResponse.json().workflowRef, CLASSIC_WORKFLOW_REF);

  const specRef = await createApprovedSpec(app, "checkout");

  const governedResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "governed",
      prompt: "implement the approved spec",
      specRef,
      harnessProfileRef: { id: "local", version: "1" }
    }
  });
  assert.equal(governedResponse.statusCode, 201);
  assert.deepEqual(
    governedResponse.json().workflowRef,
    GOVERNED_INCREMENT_WORKFLOW_REF
  );
  const localProfile = createDefaultRuntimeCapabilityCatalog().harnessProfiles.find(
    ({ id }) => id === "local"
  )!;
  assert.deepEqual(governedResponse.json().harnessProfileRef, {
    id: "local",
    version: "1",
    digest: localProfile.digest
  });
  const governedRunResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${governedResponse.json().id}/runs`,
    payload: { queueOnly: true }
  });
  assert.equal(governedRunResponse.statusCode, 201, governedRunResponse.body);
  const governedRunAudit = [...store.auditEvents.values()].find(
    (event) =>
      event.action === "run.create" &&
      event.resourceId === governedRunResponse.json().id
  );
  assert.deepEqual(
    {
      resourceType: governedRunAudit?.resourceType,
      projectId: governedRunAudit?.projectId,
      result: governedRunAudit?.result
    },
    { resourceType: "run", projectId: project.id, result: "success" }
  );
  assert.match(governedRunAudit?.afterDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(governedRunAudit?.packDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(
    [...store.auditEvents.values()].some(
      (event) =>
        event.action === "governance.override" &&
        event.resourceId === governedResponse.json().id
    ),
    true
  );
});

test("task creation rejects malformed governed references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-api-invalid-task-binding-"));
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
      payload: { name: "demo", rootPath: root }
    })
  ).json();

  const missingSpec = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "invalid governed task",
      prompt: "must fail",
      workflowRef: { id: "governed-increment-v1", version: "1" }
    }
  });
  assert.equal(missingSpec.statusCode, 400);
  assert.match(missingSpec.body, /requires specRef/);

  const malformedSpec = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "bad digest",
      prompt: "must fail",
      specRef: { specSetId: "checkout", revision: 0, digest: "BAD" }
    }
  });
  assert.equal(malformedSpec.statusCode, 400);
  assert.match(malformedSpec.body, /specRef.revision/);
  assert.match(malformedSpec.body, /specRef.digest/);
});

test("governed queue claims require a matching tenant, Gate, provider, and sandbox", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-api-governed-claim-"));
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
      payload: { name: "demo", rootPath: root }
    })
  ).json();
  const specRef = await createApprovedSpec(app, "checkout");
  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "governed claim",
      prompt: "implement",
      specRef,
      harnessProfileRef: { id: "local", version: "1" },
      strategy: {
        providers: ["claude"],
        candidates: 1,
        requiredGates: ["unit_test"],
        sandbox: "isolated-worktree",
        humanApproval: "never",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201);
  const queuedResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${taskResponse.json().id}/runs`,
    payload: { queueOnly: true }
  });
  assert.equal(queuedResponse.statusCode, 201);
  const queueItem = (
    await app.inject({ method: "GET", url: "/v1/run-jobs/queue?status=claimable" })
  ).json().items[0];
  assert.equal(queueItem.version, 2);
  assert.equal(queueItem.tenantId, LOCAL_TENANT_ID);

  const weak = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    payload: {
      ownerId: "weak-worker",
      capabilities: {
        providers: ["claude"],
        tenantIds: [LOCAL_TENANT_ID]
      }
    }
  });
  assert.equal(weak.json().item, null);
  assert.equal(weak.json().reason, "no_compatible_job");

  const compatible = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    payload: {
      ownerId: "local-worker",
      capabilities: {
        providers: ["claude"],
        gateRunnerIds: [
          "contract",
          "lint",
          "llm_verifier",
          "security",
          "typecheck",
          "unit_test"
        ],
        tenantIds: [LOCAL_TENANT_ID],
        tools: [
          "cargo",
          "git",
          "go",
          "node",
          "npm",
          "npx",
          "pnpm",
          "pytest",
          "python",
          "tsc",
          "vitest",
          "yarn"
        ],
        sandboxBackends: [
          {
            backendId: "worktree-postcheck",
            enforcement: "postcheck",
            capabilities: ["source-isolation", "diff-postcheck"]
          }
        ]
      }
    }
  });
  assert.equal(compatible.json().item.runId, queuedResponse.json().id);
  assert.equal(compatible.json().item.claimToken, undefined);
  assert.match(compatible.json().claimToken, /^[a-f0-9-]{36}$/u);
});

async function createApprovedSpec(
  app: ReturnType<typeof buildServer>,
  specSetId: string
): Promise<{ specSetId: string; revision: number; digest: string }> {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId,
    revision: 1,
    status: "draft",
    source: "native",
    title: "Governed test increment",
    hypothesis: "Immutable specifications produce verifiable changes.",
    outcomes: ["The governed task is bound to approved evidence."],
    nonGoals: ["Production deployment is excluded."],
    targetServices: [],
    contracts: {
      interface: {},
      data: {},
      state: {},
      permission: {},
      exception: {},
      quality: {},
      observability: {}
    },
    acceptanceCases: [{
      id: "accepted",
      kind: "positive",
      title: "Approved behavior",
      given: ["An approved specification exists."],
      when: "A governed task is created.",
      then: ["The exact revision is bound."]
    }],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "product@example.com"
  };
  const draft: SpecRevision = {
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  };
  const created = await app.inject({
    method: "POST",
    url: "/v1/spec-sets",
    payload: {
      specSet: {
        id: specSetId,
        title: draft.title,
        latestRevision: 0,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt
      },
      initialRevision: draft
    }
  });
  assert.equal(created.statusCode, 201);
  const approved = await app.inject({
    method: "POST",
    url: `/v1/spec-sets/${specSetId}/revisions/1/approve`,
    payload: {
      approvedBy: "reviewer@example.com",
      approvedAt: "2026-07-11T01:00:00.000Z"
    }
  });
  assert.equal(approved.statusCode, 201);
  return {
    specSetId,
    revision: approved.json().revision,
    digest: approved.json().digest
  };
}

function descriptor(
  kind: "provider" | "gate" | "workflow" | "harness_profile",
  id: string,
  status: "available" | "unavailable" | "declared"
) {
  return {
    kind,
    id,
    version: "1",
    displayName: id,
    status
  } as const;
}
