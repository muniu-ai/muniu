import assert from "node:assert/strict";
import test from "node:test";

import {
  CodingDomainError,
  CodingService,
  InMemoryCodingRepository,
  reduceCodingTaskEvents,
} from "../src/index.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const SHA_1 = "1".repeat(64);

const actor = Object.freeze({ id: "operator-1", kind: "human" });

function createFixture() {
  let eventSequence = 0;
  const repository = new InMemoryCodingRepository();
  const service = new CodingService({
    repository,
    clock: () => "2026-09-04T08:00:00.000Z",
    createEventId: () => `coding-event-${++eventSequence}`,
  });
  return { repository, service };
}

function context(expectedStreamVersion, idempotencyKey) {
  return {
    workspaceId: "workspace-1",
    expectedStreamVersion,
    idempotencyKey,
    actor,
  };
}

async function createRepositoryAndTask(service) {
  await service.registerRepository({
    ...context(0, "register-repository"),
    repositoryId: "repository-1",
    name: "木牛",
    rootRealPath: "/workspace/muniu",
  });
  await service.createTask({
    ...context(0, "create-task"),
    taskId: "task-1",
    repositoryId: "repository-1",
    title: "补齐恢复控制面",
    request: "恢复后不得重复执行副作用",
  });
}

test("Coding 控制面以类型化事件完成固定单轨流程", async () => {
  const { repository, service } = createFixture();

  const registered = await service.registerRepository({
    ...context(0, "register-repository"),
    repositoryId: "repository-1",
    name: "木牛",
    rootRealPath: "/workspace/muniu",
  });
  assert.equal(registered.streamVersion, 1);
  assert.equal(registered.repository.vcs, "git");

  const registeredService = await service.registerService({
    ...context(0, "register-service"),
    serviceId: "service-1",
    repositoryId: "repository-1",
    name: "Agent Runtime",
    paths: ["packages/agent-runtime"],
  });
  assert.equal(registeredService.streamVersion, 1);

  let aggregate = await service.createTask({
    ...context(0, "create-task"),
    taskId: "task-1",
    repositoryId: "repository-1",
    title: "补齐恢复控制面",
    request: "恢复后不得重复执行副作用",
  });
  assert.equal(aggregate.task.stage, "discover");
  assert.equal(aggregate.streamVersion, 1);

  aggregate = await service.recordSpec({
    ...context(1, "record-spec-1"),
    taskId: "task-1",
    specId: "spec-1",
    title: "审批恢复语义",
    body: "从已持久化模型响应恢复工具续点",
    acceptanceCriteria: ["不得重发模型请求", "不得重复执行已完成工具"],
  });
  aggregate = await service.advanceTask({
    ...context(2, "advance-specify"),
    taskId: "task-1",
    nextStage: "specify",
  });
  aggregate = await service.reviseSpec({
    ...context(3, "revise-spec"),
    taskId: "task-1",
    previousSpecId: "spec-1",
    specId: "spec-2",
    body: "从已持久化模型响应恢复同一工具续点",
  });
  aggregate = await service.advanceTask({
    ...context(4, "advance-impact"),
    taskId: "task-1",
    nextStage: "impact",
  });
  aggregate = await service.advanceTask({
    ...context(5, "advance-implement"),
    taskId: "task-1",
    nextStage: "implement",
  });
  aggregate = await service.recordCandidate({
    ...context(6, "record-candidate"),
    taskId: "task-1",
    runnerId: "coding.builtin",
    candidate: {
      id: "candidate-1",
      sequence: 1,
      baseRevision: "a5943b3",
      diffDigest: SHA_A,
      summary: "增加持久恢复续点",
      sandbox: { enforced: true, fallbackUsed: false, evidenceDigest: SHA_B },
    },
  });
  aggregate = await service.advanceTask({
    ...context(7, "advance-verify"),
    taskId: "task-1",
    nextStage: "verify",
  });
  aggregate = await service.recordGateResult({
    ...context(8, "record-gate"),
    taskId: "task-1",
    gateResult: {
      candidateId: "candidate-1",
      status: "passed",
      authoritative: true,
      evidenceDigest: SHA_C,
      checks: [{ id: "test", status: "passed", summary: "Focused suite 通过" }],
    },
  });
  aggregate = await service.advanceTask({
    ...context(9, "advance-approve"),
    taskId: "task-1",
    nextStage: "approve",
  });
  aggregate = await service.recordCodeEvidence({
    ...context(10, "record-evidence"),
    taskId: "task-1",
    evidence: {
      candidateId: "candidate-1",
      runnerId: "coding.builtin",
      specDigest: aggregate.specs.at(-1).digest,
      governanceDigest: SHA_D,
      harnessDigest: SHA_E,
      sandboxDigest: SHA_B,
      repositoryIndexDigest: SHA_F,
      gateEvidenceDigest: SHA_C,
      diffDigest: SHA_A,
    },
  });
  await assert.rejects(
    service.recordCodeEvidence({
      ...context(11, "replace-evidence"),
      taskId: "task-1",
      evidence: {
        candidateId: "candidate-1",
        runnerId: "coding.builtin",
        specDigest: aggregate.specs.at(-1).digest,
        governanceDigest: SHA_D,
        harnessDigest: SHA_E,
        sandboxDigest: SHA_B,
        repositoryIndexDigest: SHA_F,
        gateEvidenceDigest: SHA_C,
        diffDigest: SHA_A,
      },
    }),
    (error) => error instanceof CodingDomainError && error.code === "IMMUTABLE_SNAPSHOT",
  );
  aggregate = await service.advanceTask({
    ...context(11, "advance-learn"),
    taskId: "task-1",
    nextStage: "learn",
  });

  assert.equal(aggregate.task.stage, "learn");
  assert.equal(aggregate.task.status, "completed");
  assert.equal(aggregate.streamVersion, 12);
  assert.deepEqual(aggregate.specs.map((spec) => spec.revision), [1, 2]);
  assert.equal(aggregate.specs[0].body, "从已持久化模型响应恢复工具续点");
  assert.equal(aggregate.specs[1].supersedesSpecId, "spec-1");
  assert.equal(aggregate.gateResults[0].status, "passed");
  assert.equal(aggregate.codeEvidence[0].gateEvidenceDigest, SHA_C);
  assert.ok(Object.isFrozen(aggregate));
  assert.ok(Object.isFrozen(aggregate.gateResults[0].checks));
  assert.ok(Object.isFrozen(aggregate.codeEvidence[0]));

  const events = await repository.events({
    workspaceId: "workspace-1",
    aggregateType: "task",
    aggregateId: "task-1",
  });
  assert.deepEqual(events.map((event) => event.type), [
    "coding.task_created",
    "coding.spec_recorded",
    "coding.task_advanced",
    "coding.spec_revised",
    "coding.task_advanced",
    "coding.task_advanced",
    "coding.candidate_recorded",
    "coding.task_advanced",
    "coding.gate_result_recorded",
    "coding.task_advanced",
    "coding.code_evidence_recorded",
    "coding.task_advanced",
  ]);
  assert.deepEqual(events.map((event) => event.streamVersion), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(
    reduceCodingTaskEvents("workspace-1", "task-1", events),
    aggregate,
  );
});

test("expectedStreamVersion 与幂等键在提交前生效", async () => {
  const { repository, service } = createFixture();
  const command = {
    ...context(0, "same-register"),
    repositoryId: "repository-1",
    name: "木牛",
    rootRealPath: "/workspace/muniu",
  };

  const first = await service.registerRepository(command);
  const replay = await service.registerRepository(command);
  assert.deepEqual(replay, first);
  assert.equal((await repository.events({
    workspaceId: "workspace-1",
    aggregateType: "repository",
    aggregateId: "repository-1",
  })).length, 1);

  await assert.rejects(
    service.registerRepository({ ...command, name: "另一个仓库" }),
    (error) => error instanceof CodingDomainError && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  await assert.rejects(
    service.registerRepository({ ...command, idempotencyKey: "wrong-version", expectedStreamVersion: 0 }),
    (error) => error instanceof CodingDomainError && error.code === "STREAM_VERSION_CONFLICT",
  );
  assert.equal((await repository.events({
    workspaceId: "workspace-1",
    aggregateType: "repository",
    aggregateId: "repository-1",
  })).length, 1);
});

test("非法流程和不可变快照采用 fail-closed 原子提交", async () => {
  const { repository, service } = createFixture();
  await createRepositoryAndTask(service);

  await assert.rejects(
    service.advanceTask({
      ...context(1, "advance-without-spec"),
      taskId: "task-1",
      nextStage: "specify",
    }),
    (error) => error instanceof CodingDomainError && error.code === "MISSING_PREREQUISITE",
  );
  assert.equal((await repository.events({
    workspaceId: "workspace-1",
    aggregateType: "task",
    aggregateId: "task-1",
  })).length, 1);

  let aggregate = await service.recordSpec({
    ...context(1, "spec"),
    taskId: "task-1",
    specId: "spec-1",
    title: "不可变控制面",
    body: "所有控制面快照只追加",
    acceptanceCriteria: ["旧快照保持可验证"],
  });
  aggregate = await service.advanceTask({
    ...context(2, "specify"),
    taskId: "task-1",
    nextStage: "specify",
  });

  await assert.rejects(
    service.reviseSpec({
      ...context(3, "reuse-spec-id"),
      taskId: "task-1",
      previousSpecId: "spec-1",
      specId: "spec-1",
      body: "尝试覆盖旧快照",
    }),
    (error) => error instanceof CodingDomainError && error.code === "IMMUTABLE_SNAPSHOT",
  );
  assert.equal((await service.getTask("workspace-1", "task-1")).streamVersion, 3);

  aggregate = await service.advanceTask({
    ...context(3, "impact"),
    taskId: "task-1",
    nextStage: "impact",
  });
  aggregate = await service.advanceTask({
    ...context(4, "implement"),
    taskId: "task-1",
    nextStage: "implement",
  });
  aggregate = await service.recordCandidate({
    ...context(5, "candidate"),
    taskId: "task-1",
    runnerId: "coding.builtin",
    candidate: {
      id: "candidate-1",
      sequence: 1,
      baseRevision: "a5943b3",
      diffDigest: SHA_A,
      summary: "候选变更",
      sandbox: { enforced: true, fallbackUsed: false, evidenceDigest: SHA_B },
    },
  });
  aggregate = await service.advanceTask({
    ...context(6, "verify"),
    taskId: "task-1",
    nextStage: "verify",
  });

  await assert.rejects(
    service.recordGateResult({
      ...context(7, "non-authoritative-gate"),
      taskId: "task-1",
      gateResult: {
        candidateId: "candidate-1",
        status: "passed",
        authoritative: false,
        evidenceDigest: SHA_C,
        checks: [{ id: "test", status: "passed", summary: "非权威检查" }],
      },
    }),
    (error) => error instanceof CodingDomainError && error.code === "FAIL_CLOSED",
  );
  assert.equal((await service.getTask("workspace-1", "task-1")).streamVersion, 7);

  aggregate = await service.recordGateResult({
    ...context(7, "failed-gate"),
    taskId: "task-1",
    gateResult: {
      candidateId: "candidate-1",
      status: "failed",
      authoritative: true,
      evidenceDigest: SHA_C,
      checks: [{ id: "test", status: "failed", summary: "测试失败" }],
      reason: "测试失败",
    },
  });
  await assert.rejects(
    service.recordGateResult({
      ...context(8, "replace-gate"),
      taskId: "task-1",
      gateResult: {
        candidateId: "candidate-1",
        status: "passed",
        authoritative: true,
        evidenceDigest: SHA_1,
        checks: [{ id: "test", status: "passed", summary: "重新运行通过" }],
      },
    }),
    (error) => error instanceof CodingDomainError && error.code === "IMMUTABLE_SNAPSHOT",
  );
  await assert.rejects(
    service.advanceTask({
      ...context(8, "approve-after-failure"),
      taskId: "task-1",
      nextStage: "approve",
    }),
    (error) => error instanceof CodingDomainError && error.code === "MISSING_PREREQUISITE",
  );
  assert.equal((await service.getTask("workspace-1", "task-1")).streamVersion, 8);
});

test("Service 和 CodingTask 必须引用同一工作区内的已登记仓库", async () => {
  const { service } = createFixture();

  await assert.rejects(
    service.registerService({
      ...context(0, "missing-service-repository"),
      serviceId: "service-1",
      repositoryId: "missing",
      name: "未知服务",
      paths: ["src"],
    }),
    (error) => error instanceof CodingDomainError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    service.createTask({
      ...context(0, "missing-task-repository"),
      taskId: "task-1",
      repositoryId: "missing",
      title: "错误任务",
      request: "不得创建",
    }),
    (error) => error instanceof CodingDomainError && error.code === "NOT_FOUND",
  );
});
