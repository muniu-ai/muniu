import assert from "node:assert/strict";
import test from "node:test";

import {
  CODING_WORKFLOW_STAGES,
  advanceCodingTask,
  buildRepositoryIndex,
  codingPlugin,
  createCodingTask,
  createSpec,
  reviseSpec,
} from "../src/index.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

test("Coding 领域采用固定单轨工作流", () => {
  assert.deepEqual(CODING_WORKFLOW_STAGES, [
    "discover",
    "specify",
    "impact",
    "implement",
    "verify",
    "approve",
    "learn",
  ]);

  let task = createCodingTask({
    id: "task-1",
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    title: "修复恢复逻辑",
    request: "已提交事件不得丢失",
    createdAt: "2026-09-04T00:00:00.000Z",
  });
  for (const stage of CODING_WORKFLOW_STAGES.slice(1)) {
    task = advanceCodingTask(task, stage, "2026-09-04T00:01:00.000Z");
  }
  assert.equal(task.stage, "learn");
  assert.equal(task.streamVersion, 6);
  assert.throws(() => advanceCodingTask(task, "discover", "2026-09-04T00:02:00.000Z"), /工作流/);
});

test("Spec 修订创建新快照，不改写旧快照", () => {
  const first = createSpec({
    id: "spec-1",
    taskId: "task-1",
    title: "恢复语义",
    body: "未知结果进入人工核对",
    acceptanceCriteria: ["不得自动重放"],
    createdAt: "2026-09-04T00:00:00.000Z",
  });
  const second = reviseSpec(first, {
    id: "spec-2",
    body: "未知副作用结果进入人工核对",
    createdAt: "2026-09-04T00:01:00.000Z",
  });

  assert.equal(first.revision, 1);
  assert.equal(first.body, "未知结果进入人工核对");
  assert.equal(second.revision, 2);
  assert.equal(second.supersedesSpecId, first.id);
  assert.notEqual(first.digest, second.digest);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.acceptanceCriteria));
  assert.throws(() => {
    first.body = "被篡改";
  }, TypeError);
});

test("仓库索引规范化顺序并拒绝路径逃逸", () => {
  const left = buildRepositoryIndex([
    { path: "src/z.ts", digest: SHA_B, byteLength: 2 },
    { path: "src/a.ts", digest: SHA_A, byteLength: 1 },
  ]);
  const right = buildRepositoryIndex([
    { path: "src/a.ts", digest: SHA_A, byteLength: 1 },
    { path: "src/z.ts", digest: SHA_B, byteLength: 2 },
  ]);
  assert.equal(left.digest, right.digest);
  assert.deepEqual(left.entries.map((entry) => entry.path), ["src/a.ts", "src/z.ts"]);
  assert.throws(
    () => buildRepositoryIndex([{ path: "../secret", digest: SHA_A, byteLength: 1 }]),
    /仓库相对路径/,
  );
});

test("官方 Coding 插件声明成果导向 Skill 和 builtin 默认 Agent", () => {
  assert.equal(codingPlugin.id, "coding");
  assert.equal(codingPlugin.trustBoundary, "process_equivalent");
  assert.equal(codingPlugin.contributions.agents[0].id, "coding.builtin");
  assert.equal(codingPlugin.contributions.skills[0].expectedOutcome, "生成可审阅的代码变更、检查结果和证据");
  assert.deepEqual(codingPlugin.contributions.skills[0].permissionIds, [
    "coding.repository.read",
    "coding.sandbox.write",
  ]);
});
