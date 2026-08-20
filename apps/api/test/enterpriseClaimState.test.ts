// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTask, Project, RunRecord } from "@mn/core";
import type { GovernedRunState } from "@mn/loop";

import { executionStateFromEnterpriseClaim } from "../src/enterpriseClaimState.js";
import type { EnterpriseClaimSnapshot } from "../src/enterprisePostgres.js";

test("enterprise worker authority resolves the latest PostgreSQL claim checkpoint", () => {
  const run = {
    id: "run-a",
    tenantId: "tenant-a",
    projectId: "project-a",
    taskId: "task-a",
    status: "running"
  } as RunRecord;
  const project = {
    id: "project-a",
    tenantId: "tenant-a"
  } as Project;
  const task = {
    id: "task-a",
    tenantId: "tenant-a",
    projectId: "project-a"
  } as AgentTask;
  const state = {
    schemaVersion: 1,
    runId: "run-a",
    status: "running",
    attempts: [{ id: "run-a:implementation:1", status: "running" }]
  } as unknown as GovernedRunState;
  const claim = {
    item: {
      runId: "run-a",
      tenantId: "tenant-a",
      projectId: "project-a",
      taskId: "task-a"
    },
    payload: {
      version: 2,
      run,
      governedResumeState: state,
      executionContext: {
        schemaVersion: 2,
        project,
        task,
        bindings: {
          tenantId: "tenant-a",
          runId: "run-a",
          projectId: "project-a",
          taskId: "task-a"
        }
      }
    },
    checkpointDigest: "1".repeat(64)
  } as unknown as EnterpriseClaimSnapshot;

  assert.deepEqual(executionStateFromEnterpriseClaim(claim), {
    run,
    project,
    task,
    governedLoopState: state
  });
});

test("enterprise claim checkpoint rejects rebound run state", () => {
  const claim = {
    item: {
      runId: "run-a",
      tenantId: "tenant-a",
      projectId: "project-a",
      taskId: "task-a"
    },
    payload: {
      run: {
        id: "run-a",
        tenantId: "tenant-a",
        projectId: "project-a",
        taskId: "task-a"
      },
      governedResumeState: { runId: "run-b" }
    },
    checkpointDigest: null
  } as unknown as EnterpriseClaimSnapshot;
  assert.throws(
    () => executionStateFromEnterpriseClaim(claim),
    /governed Loop binding is invalid/u
  );
});
