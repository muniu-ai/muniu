import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionBudgetExceededError } from "@mn/contracts";

import {
  CODING_DEFAULT_LIMITS,
  CodingExecutionEngine,
  createCodingTask,
  decideCodingExecution,
  presentCodingResult,
} from "../src/index.ts";

const SHA = (character) => character.repeat(64);

test("模型预算暂停向内核传播，不触发修复或未知 Runner 结果", async () => {
  const error = new ExecutionBudgetExceededError("model_unknown");
  const runner = fakeRunner([]);
  runner.events = async function* () { throw error; };
  await assert.rejects(new CodingExecutionEngine({ runners: [runner] }).execute({
    task: task(), controlPlane: controlPlane(),
    gateVerifier: { async verify() { throw new Error("不应执行 Gate"); } },
  }), value => value === error);
  assert.equal(runner.state.resumes, 0);
});

function task() {
  return createCodingTask({
    id: "task-1",
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    title: "增加恢复测试",
    request: "验证未知结果不会重放",
    createdAt: "2026-09-04T00:00:00.000Z",
  });
}

function controlPlane() {
  return {
    protocol: "coding-v2",
    specDigest: SHA("1"),
    governanceDigest: SHA("2"),
    harnessDigest: SHA("3"),
    sandboxDigest: SHA("4"),
    repositoryIndexDigest: SHA("5"),
  };
}

function candidate(sequence) {
  return {
    id: `candidate-${sequence}`,
    sequence,
    baseRevision: "abc123",
    diffDigest: SHA(String(sequence)),
    summary: `候选 ${sequence}`,
    sandbox: {
      enforced: true,
      fallbackUsed: false,
      evidenceDigest: SHA("4"),
    },
  };
}

function fakeRunner(attempts, options = {}) {
  let stream = 0;
  const state = { starts: 0, resumes: 0, cancels: 0 };
  return {
    id: options.id ?? "builtin",
    external: options.external ?? false,
    state,
    async start() {
      state.starts += 1;
      return { sessionId: "session-1" };
    },
    async *events() {
      const events = attempts[stream] ?? [];
      stream += 1;
      for (const event of events) yield event;
    },
    async resume() {
      state.resumes += 1;
    },
    async cancel() {
      state.cancels += 1;
    },
  };
}

test("Gate 连续失败时只修复三次并交给人工决定", async () => {
  const runner = fakeRunner([1, 2, 3, 4].map((sequence) => [
    { type: "candidate", candidate: candidate(sequence) },
  ]));
  const engine = new CodingExecutionEngine({ runners: [runner] });
  const result = await engine.execute({
    task: task(),
    controlPlane: controlPlane(),
    gateVerifier: {
      async verify(value) {
        return {
          status: "failed",
          authoritative: true,
          evidenceDigest: SHA("8"),
          checks: [{ id: "test", status: "failed", summary: `${value.id} 未通过` }],
        };
      },
    },
  });

  assert.equal(CODING_DEFAULT_LIMITS.maxRepairAttempts, 3);
  assert.equal(CODING_DEFAULT_LIMITS.maxDurationMs, 3_600_000);
  assert.equal(runner.state.starts, 1);
  assert.equal(runner.state.resumes, 3);
  assert.equal(result.candidates.length, 4);
  assert.equal(result.status, "needs_human_decision");
  assert.equal(result.nextStep, "检查失败原因，决定修改方案或终止任务");
});

test("Gate、Evidence 和 Sandbox 缺失时失败关闭", async (t) => {
  await t.test("Gate 缺失权威证据视为失败", async () => {
    const runner = fakeRunner([[{ type: "candidate", candidate: candidate(1) }]]);
    const result = await new CodingExecutionEngine({ runners: [runner] }).execute({
      task: task(),
      controlPlane: controlPlane(),
      limits: { maxRepairAttempts: 0, maxDurationMs: 3_600_000 },
      gateVerifier: {
        async verify() {
          return { status: "passed", authoritative: false, checks: [] };
        },
      },
    });
    assert.equal(result.status, "needs_human_decision");
    assert.equal(result.gates[0].status, "failed");
    assert.match(result.gates[0].reason, /权威证据/);
  });

  await t.test("Sandbox 降级不执行 Gate", async () => {
    const unsafe = candidate(1);
    unsafe.sandbox = { enforced: false, fallbackUsed: true };
    let gateCalls = 0;
    const runner = fakeRunner([[{ type: "candidate", candidate: unsafe }]]);
    const result = await new CodingExecutionEngine({ runners: [runner] }).execute({
      task: task(),
      controlPlane: controlPlane(),
      limits: { maxRepairAttempts: 0, maxDurationMs: 3_600_000 },
      gateVerifier: {
        async verify() {
          gateCalls += 1;
          return { status: "passed", authoritative: true, evidenceDigest: SHA("8"), checks: [] };
        },
      },
    });
    assert.equal(gateCalls, 0);
    assert.equal(result.status, "needs_human_decision");
    assert.match(result.gates[0].reason, /Sandbox/);
  });

  await t.test("Sandbox 证据与固定控制面不一致时不执行 Gate", async () => {
    let gateCalls = 0;
    const mismatched = candidate(1);
    mismatched.sandbox = { enforced: true, fallbackUsed: false, evidenceDigest: SHA("9") };
    const runner = fakeRunner([[{ type: "candidate", candidate: mismatched }]]);
    const result = await new CodingExecutionEngine({ runners: [runner] }).execute({
      task: task(),
      controlPlane: controlPlane(),
      limits: { maxRepairAttempts: 0, maxDurationMs: 3_600_000 },
      gateVerifier: {
        async verify() {
          gateCalls += 1;
          return { status: "passed", authoritative: true, evidenceDigest: SHA("8"), checks: [] };
        },
      },
    });
    assert.equal(gateCalls, 0);
    assert.equal(result.status, "needs_human_decision");
    assert.match(result.gates[0].reason, /固定控制面不一致/);
  });
});

test("Gate 的租约中断不会被降格为普通检查失败", async () => {
  const runner = fakeRunner([[{ type: "candidate", candidate: candidate(1) }]]);
  const interrupted = new Error("lease lost");
  interrupted.name = "AbortError";
  await assert.rejects(
    new CodingExecutionEngine({ runners: [runner] }).execute({
      task: task(),
      controlPlane: controlPlane(),
      gateVerifier: { async verify() { throw interrupted; } },
    }),
    (error) => error === interrupted,
  );
  assert.equal(runner.state.resumes, 0);
});

test("等待审批的持久结果可在恢复后完成，且不会重新执行 Runner", async () => {
  const runner = fakeRunner([[{ type: "candidate", candidate: {
    ...candidate(1),
    sandbox: { enforced: true, fallbackUsed: false, evidenceDigest: SHA("4") },
  } }]]);
  const pending = await new CodingExecutionEngine({ runners: [runner] }).execute({
    task: task(),
    controlPlane: controlPlane(),
    gateVerifier: {
      async verify() {
        return {
          status: "passed",
          authoritative: true,
          evidenceDigest: SHA("8"),
          checks: [{ id: "test", status: "passed", summary: "全部通过" }],
        };
      },
    },
  });

  assert.equal(pending.status, "waiting_approval");
  const completed = decideCodingExecution(pending, "approved_once");
  assert.equal(completed.status, "completed");
  assert.equal(completed.deliverable.diffDigest, SHA("1"));
  assert.equal(runner.state.starts, 1);
  assert.throws(() => decideCodingExecution(completed, "approved_once"), /等待审批/);
});

test("完整执行生成不可变证据、审批和成果", async () => {
  const runner = fakeRunner([[{ type: "candidate", candidate: candidate(1) }]]);
  const result = await new CodingExecutionEngine({ runners: [runner] }).execute({
    task: task(),
    controlPlane: controlPlane(),
    gateVerifier: {
      async verify() {
        return {
          status: "passed",
          authoritative: true,
          evidenceDigest: SHA("8"),
          checks: [{ id: "test", status: "passed", summary: "全部通过" }],
        };
      },
    },
    approval: async (request) => {
      assert.equal(request.effectClass, "local_reversible_write");
      assert.equal(request.candidate.diffDigest, SHA("1"));
      return "approved_once";
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.approval, "approved_once");
  assert.equal(result.evidence.specDigest, SHA("1"));
  assert.equal(result.deliverable.kind, "code_change");
  assert.ok(Object.isFrozen(result.evidence));

  const business = presentCodingResult(result);
  assert.deepEqual(Object.keys(business), [
    "task",
    "diff",
    "checks",
    "approval",
    "deliverable",
    "nextStep",
  ]);
  assert.equal("harness" in business, false);
  const professional = presentCodingResult(result, { advanced: true });
  assert.equal(professional.harness.digest, SHA("3"));
  assert.equal(professional.candidates.length, 1);
  assert.deepEqual(professional.budget, CODING_DEFAULT_LIMITS);
});

test("外部 Runner 只在显式选择并确认后使用，且不会隐式回退", async () => {
  const builtin = fakeRunner([[{ type: "result", status: "failed", reason: "builtin failed" }]]);
  const external = fakeRunner([[{ type: "result", status: "failed", reason: "external failed" }]], {
    id: "claude-cli",
    external: true,
  });
  const engine = new CodingExecutionEngine({ runners: [external, builtin] });

  await assert.rejects(() => engine.execute({
    task: task(),
    controlPlane: controlPlane(),
    selectedRunnerId: "claude-cli",
    gateVerifier: { async verify() { throw new Error("不应调用"); } },
  }), /重新确认/);
  assert.equal(external.state.starts, 0);

  const selected = await engine.execute({
    task: task(),
    controlPlane: controlPlane(),
    selectedRunnerId: "claude-cli",
    externalRunnerConfirmed: true,
    executionId: "execution-1",
    repositoryPath: "/repo",
    expectedRepositoryRealPath: "/repo",
    gateVerifier: { async verify() { throw new Error("不应调用"); } },
  });
  assert.equal(selected.status, "failed");
  assert.equal(external.state.starts, 1);
  assert.equal(builtin.state.starts, 0);
});

test("Runner 外部结果未知时进入人工核对且不重放", async () => {
  const runner = fakeRunner([[{ type: "result", status: "unknown", reason: "连接中断" }]]);
  const result = await new CodingExecutionEngine({ runners: [runner] }).execute({
    task: task(),
    controlPlane: controlPlane(),
    gateVerifier: { async verify() { throw new Error("不应调用"); } },
  });
  assert.equal(result.status, "needs_reconciliation");
  assert.equal(runner.state.resumes, 0);
  assert.equal(result.nextStep, "核对外部执行结果，再选择终止、标记完成或创建新调用");
});

test("达到一小时总时长后停止 Gate 和修复，转由人工决定", async () => {
  const runner = fakeRunner([[{ type: "candidate", candidate: candidate(1) }]]);
  const times = [0, 3_600_000];
  let gateCalls = 0;
  const result = await new CodingExecutionEngine({
    runners: [runner],
    now: () => times.shift() ?? 3_600_000,
  }).execute({
    task: task(),
    controlPlane: controlPlane(),
    gateVerifier: {
      async verify() {
        gateCalls += 1;
        throw new Error("超时后不应调用");
      },
    },
  });
  assert.equal(gateCalls, 0);
  assert.equal(result.status, "needs_human_decision");
  assert.equal(runner.state.resumes, 0);
});
