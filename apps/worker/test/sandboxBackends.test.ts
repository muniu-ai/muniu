import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EnforcedSandboxBackend,
  WorktreePostcheckSandboxBackend,
  type EnforcedSandboxPolicy,
  type EnforcedSandboxProvisionRequest
} from "../src/index.js";

test("worktree-postcheck isolates source but refuses to claim network enforcement", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-local-sandbox-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-local-sandbox-workspaces-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(join(projectRoot, "README.md"), "source", "utf8");
  const backend = new WorktreePostcheckSandboxBackend(workspaceRoot);
  assert.equal(backend.enforcement, "postcheck");
  assert.deepEqual(backend.capabilities, ["source-isolation", "diff-postcheck"]);

  await assert.rejects(
    backend.prepare({
      projectRoot,
      taskId: "task-1",
      networkAllowlist: ["api.example.com"]
    }),
    /cannot enforce a network allowlist/u
  );
  const prepared = await backend.prepare({ projectRoot, taskId: "task-1" });
  assert.notEqual(prepared.workspacePath, projectRoot);
  assert.match(prepared.leaseId ?? "", /^[a-f0-9-]{36}$/u);
  await backend.release(prepared.leaseId!);
  await assert.rejects(backend.release(prepared.leaseId!), /already released/u);
});

test("enforced backend validates all policy dimensions and binds a lease", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-enforced-sandbox-project-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let captured: EnforcedSandboxProvisionRequest | undefined;
  const releases: string[] = [];
  const backend = new EnforcedSandboxBackend({
    id: "container-prod",
    version: "1.2.0",
    kind: "container",
    policy: policy(),
    provisioner: {
      async provision(request) {
        captured = request;
        return {
          backendId: "container-prod",
          workspacePath: "/workspace/project",
          leaseId: "lease-1"
        };
      },
      async release(leaseId) {
        releases.push(leaseId);
      }
    }
  });
  assert.equal(backend.enforcement, "enforced");
  assert.ok(backend.capabilities.includes("network-policy"));

  await assert.rejects(
    backend.prepare({
      projectRoot,
      taskId: "task-1",
      networkAllowlist: ["evil.example.com"]
    }),
    /exceeds backend policy/u
  );
  const prepared = await backend.prepare({
    projectRoot,
    taskId: "task-1",
    networkAllowlist: ["api.example.com:443"],
    commandAllowlist: ["npm test"]
  });
  assert.equal(prepared.leaseId, "lease-1");
  assert.equal(captured?.policy.readOnlyRootFilesystem, true);
  assert.ok(Object.isFrozen(captured?.policy));
  await backend.release("lease-1");
  assert.deepEqual(releases, ["lease-1"]);
});

test("enforced backend rejects weak policy and provisioner identity spoofing", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mn-enforced-sandbox-spoof-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  assert.throws(
    () =>
      new EnforcedSandboxBackend({
        id: "bad",
        version: "1",
        kind: "remote",
        policy: { ...policy(), readOnlyRootFilesystem: false as never },
        provisioner: noopProvisioner()
      }),
    /read-only root filesystem/u
  );
  const backend = new EnforcedSandboxBackend({
    id: "remote-prod",
    version: "1",
    kind: "remote",
    policy: policy(),
    provisioner: {
      async provision() {
        return { backendId: "spoofed", workspacePath: "/workspace", leaseId: "lease-2" };
      },
      async release() {}
    }
  });
  await assert.rejects(
    backend.prepare({ projectRoot, taskId: "task-2" }),
    /returned backend spoofed/u
  );
});

function policy(): EnforcedSandboxPolicy {
  return {
    mounts: [
      { source: "project", target: "/workspace/project", readOnly: true },
      { source: "scratch", target: "/workspace/scratch", readOnly: false }
    ],
    networkMode: "allowlist",
    networkAllowlist: ["api.example.com:443"],
    secretNames: ["CI_TOKEN"],
    allowedCommands: ["npm test", "npm run typecheck"],
    resources: { cpu: 2, memoryMb: 2048, pids: 256, timeoutSeconds: 900 },
    readOnlyRootFilesystem: true
  };
}

function noopProvisioner() {
  return {
    async provision() {
      return { backendId: "bad", workspacePath: "/workspace", leaseId: "lease" };
    },
    async release() {}
  };
}
