import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunRecord } from "@mn/core";
import {
  enterpriseRouteAllows,
  normalizeEnterpriseProjectRoots,
  resolveEnterpriseProjectRoot,
  validateEnterpriseExternalRunFilesystem
} from "../src/enterpriseSurface.js";

test("enterprise route allowlist contains only governed increment surfaces", () => {
  for (const [method, pathname] of [
    ["GET", "/v1/capabilities"],
    ["POST", "/v1/standard-packs/import"],
    ["POST", "/v1/spec-sets/spec-1/revisions/1/approve"],
    ["GET", "/v1/projects/project-1/effective-governance"],
    ["POST", "/v1/tasks/task-1/runs"],
    ["POST", "/v1/run-jobs/queue/run-1/finish"],
    ["POST", "/v1/run-jobs/queue/run-1/artifacts"],
    ["POST", "/v1/run-jobs/queue/run-1/measurements"],
    ["POST", "/v1/run-jobs/queue/run-1/resume-diff"],
    ["POST", "/v1/run-jobs/queue/run-1/usage-receipts"],
    ["POST", "/v1/run-jobs/queue/run-1/builtin-executions"],
    ["POST", "/v1/run-jobs/queue/run-1/builtin-executions/execution-1/poll"],
    ["GET", "/v1/agent-sessions/session-1/events"],
    ["POST", "/v1/agent-sessions/session-1/approvals/approval-1"],
    ["GET", "/v1/runs/run-1/artifacts/archive"],
    ["POST", "/v1/learning-proposals/proposal-1/review"],
    ["GET", "/v1/audit-events"],
    ["GET", "/v1/proxy/logs"],
    ["GET", "/v1/usage/summary"],
    ["GET", "/v1/usage/requests"],
    ["GET", "/v1/usage/models"],
    ["GET", "/v1/providers"],
    ["POST", "/v1/providers"]
  ] as const) {
    assert.equal(enterpriseRouteAllows(method, pathname), true, `${method} ${pathname}`);
  }

  for (const pathname of [
    "/v1/system/desktop",
    "/v1/system/diagnostics",
    "/v1/system/env-cleanup",
    "/v1/apps",
    "/v1/mcp/servers",
    "/v1/prompts/presets",
    "/v1/skills",
    "/v1/providers/provider-1",
    "/v1/deep-links/import",
    "/v1/proxy/status",
    "/v1/sessions",
    "/v1/artifacts/store",
    "/v1/runs/run-1/workspaces/cleanup"
  ]) {
    assert.equal(enterpriseRouteAllows("GET", pathname), false, pathname);
    assert.equal(enterpriseRouteAllows("POST", pathname), false, pathname);
    assert.equal(enterpriseRouteAllows("OPTIONS", pathname), false, pathname);
  }
  assert.equal(enterpriseRouteAllows("POST", "/v1/capabilities"), false);
  assert.equal(enterpriseRouteAllows("GET", "/v1/standard-packs/import"), false);
  assert.equal(enterpriseRouteAllows("GET", "/v1/not-yet-reviewed"), false);
});

test("enterprise project roots reject traversal, missing paths and symlink escape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-enterprise-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed");
  const repository = join(allowed, "orders");
  const outside = join(root, "outside");
  await mkdir(repository, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(allowed, "escape"));

  const roots = normalizeEnterpriseProjectRoots([allowed, allowed]);
  assert.deepEqual(roots, [await realpath(allowed)]);
  assert.equal(await resolveEnterpriseProjectRoot(repository, roots), await realpath(repository));
  await assert.rejects(
    resolveEnterpriseProjectRoot(`${allowed}/../outside`, roots),
    /path traversal/u
  );
  await assert.rejects(
    resolveEnterpriseProjectRoot(join(allowed, "escape"), roots),
    /outside the enterprise project root allowlist/u
  );
  await assert.rejects(
    resolveEnterpriseProjectRoot(join(allowed, "missing"), roots),
    /existing directory/u
  );
  await assert.rejects(
    resolveEnterpriseProjectRoot("relative/repository", roots),
    /absolute path/u
  );
  assert.throws(() => normalizeEnterpriseProjectRoots([]), /at least one/u);
});

test("enterprise external runs cannot turn worker paths into API file reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-enterprise-worker-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "repository");
  await mkdir(projectRoot, { recursive: true });
  const digest = "a".repeat(64);
  const run = (worktreePath: string, artifactPath?: string) => ({
    id: "run-1",
    taskId: "task-1",
    projectId: "project-1",
    status: "completed",
    candidates: [
      {
        id: "candidate-1",
        runId: "run-1",
        provider: "codex",
        worktreePath,
        status: "completed",
        result: {
          provider: "codex",
          candidateId: "candidate-1",
          status: "completed",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          summary: "ok",
          artifacts: artifactPath
            ? [{ id: "exfiltrate", kind: "log", path: artifactPath, sha256: digest }]
            : [],
          startedAt: "2026-07-12T00:00:00.000Z",
          finishedAt: "2026-07-12T00:00:01.000Z"
        },
        gates: []
      }
    ],
    gates: [],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z"
  }) as RunRecord;

  assert.match(
    validateEnterpriseExternalRunFilesystem(run("/", "/etc/hosts"), projectRoot) ?? "",
    /not bound to the registered project root/u
  );
  assert.match(
    validateEnterpriseExternalRunFilesystem(
      run(projectRoot, "/etc/hosts"),
      projectRoot
    ) ?? "",
    /cannot contain an external worker local filesystem path/u
  );
  assert.equal(
    validateEnterpriseExternalRunFilesystem(
      run(projectRoot, "mn://worker-artifacts/log"),
      projectRoot
    ),
    undefined
  );

  const remoteSandboxRun = {
    ...run("mn://sandbox/lease-1/candidates/candidate-1"),
    sandboxExecution: { leaseId: "lease-1" }
  } as RunRecord;
  assert.equal(
    validateEnterpriseExternalRunFilesystem(remoteSandboxRun, projectRoot),
    undefined
  );
  assert.match(
    validateEnterpriseExternalRunFilesystem(
      {
        ...remoteSandboxRun,
        candidates: remoteSandboxRun.candidates.map((candidate) => ({
          ...candidate,
          worktreePath: "mn://sandbox/another-lease/candidate"
        }))
      },
      projectRoot
    ) ?? "",
    /not bound to a reported sandbox lease/u
  );

  const gatePath = {
    ...run(projectRoot),
    gateResultsV2: [
      {
        schemaVersion: 2,
        id: "gate-result-1",
        runId: "run-1",
        candidateId: "candidate-1",
        gateId: "unit_test",
        runnerId: "node-test",
        runnerVersion: "1",
        required: true,
        status: "pass",
        summary: "pass",
        specClauseIds: [],
        tool: { id: "node", version: "22" },
        workingDirectory: projectRoot,
        exitCode: 0,
        inputDigest: digest,
        outputDigest: digest,
        artifacts: [
          {
            id: "junit",
            kind: "junit",
            contentType: "application/xml",
            digest,
            byteLength: 42,
            path: "/etc/hosts"
          }
        ],
        startedAt: "2026-07-12T00:00:00.000Z",
        finishedAt: "2026-07-12T00:00:01.000Z",
        freshUntil: "2026-07-12T01:00:00.000Z"
      }
    ]
  } as RunRecord;
  assert.match(
    validateEnterpriseExternalRunFilesystem(gatePath, projectRoot) ?? "",
    /cannot contain an external worker local filesystem path/u
  );
});
