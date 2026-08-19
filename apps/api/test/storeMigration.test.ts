import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_DEFAULT_STANDARD_PACK,
  LOCAL_TENANT_ID,
  MemoryStore
} from "../src/store.js";

test("hydrates v1 snapshots into the implicit local tenant and persists v3", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-state-v1-migration-"));
  const statePath = join(root, "api-state.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "project-1",
          name: "Legacy",
          rootPath: "/tmp/legacy",
          defaultBranch: "main",
          services: [],
          policyId: "default"
        }
      ],
      tasks: [
        {
          id: "task-1",
          projectId: "project-1",
          title: "Legacy task",
          intent: "implement",
          targetServices: [],
          prompt: "keep working",
          acceptanceCriteria: ["passes"],
          strategy: {
            providers: ["codex"],
            candidates: 1,
            sandbox: "isolated-worktree",
            requiredGates: ["unit_test"],
            humanApproval: "never",
            timeoutSeconds: 60
          },
          createdAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-1",
          taskId: "task-1",
          projectId: "project-1",
          status: "completed",
          candidates: [],
          gates: [],
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      runJobs: [
        {
          runId: "run-1",
          projectId: "project-1",
          taskId: "task-1",
          status: "completed",
          priority: 0,
          attempt: 1,
          recovered: false,
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      events: []
    }),
    "utf8"
  );

  const store = new MemoryStore({ statePath });
  assert.equal(store.projects.get("project-1")?.tenantId, LOCAL_TENANT_ID);
  assert.equal(
    store.projects.get("project-1")?.policyId,
    BUILTIN_DEFAULT_STANDARD_PACK
  );
  assert.equal(store.tasks.get("task-1")?.workflowRef?.id, "classic-v1");
  assert.equal(store.tasks.get("task-1")?.strategy.schemaVersion, 2);
  assert.equal(store.runs.get("run-1")?.tenantId, LOCAL_TENANT_ID);
  assert.equal(store.runs.get("run-1")?.workflowRef?.id, "classic-v1");
  assert.equal(store.runJobs.get("run-1")?.tenantId, LOCAL_TENANT_ID);

  store.events.set("run-1", []);
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
    version: number;
    tenantId: string;
  };
  assert.equal(persisted.version, 3);
  assert.equal(persisted.tenantId, LOCAL_TENANT_ID);
  const backup = JSON.parse(await readFile(`${statePath}.v1.bak`, "utf8")) as {
    version: number;
  };
  assert.equal(backup.version, 1);

  new MemoryStore({ statePath });
  const persistedAgain = JSON.parse(await readFile(statePath, "utf8")) as {
    version: number;
  };
  assert.equal(persistedAgain.version, 3);
});

test("rejects unknown state snapshot versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-state-version-"));
  const statePath = join(root, "api-state.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(statePath, JSON.stringify({ version: 99 }), "utf8");
  assert.throws(() => new MemoryStore({ statePath }), /Unsupported API state snapshot version/);
});
