import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Execution,
  ExecutionAuthority,
  Thread,
} from "@mn/contracts";
import { CODING_RUNNER_CONFIGURATION_NAMESPACE } from "@mn/contracts";
import {
  InMemoryKernelStore,
  sha256,
  type InboxItem,
  type KernelStore,
} from "@mn/kernel";
import type {
  Candidate,
  CodeEvidence,
  CodingControlPlaneCommitment,
  CodingExecutionResult,
  CodingTask,
  GateResult,
} from "@mn/plugin-coding";
import { createCodeEvidence } from "@mn/plugin-coding";
import { SqliteStorage } from "@mn/storage";

import {
  createAgentOsHost,
  type AgentOsHost,
  type ModelSecretStore,
} from "../src/index.js";

const NOW = "2026-09-04T08:00:00.000Z";
const CONTROL_PLANE: CodingControlPlaneCommitment = {
  protocol: "coding-v2",
  specDigest: sha256("spec"),
  governanceDigest: sha256("governance"),
  harnessDigest: sha256("harness"),
  sandboxDigest: sha256("sandbox"),
  repositoryIndexDigest: sha256("repository-index"),
};

const secrets: ModelSecretStore = {
  async save(connectionId) { return `keychain://muniu.v2/${connectionId}`; },
  async read() { return "fixture-key"; },
};

interface ReconciliationFixture<TStore extends KernelStore = InMemoryKernelStore> {
  readonly store: TStore;
  readonly host: AgentOsHost;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly taskId: string;
}

function mutation(path: string, body: unknown, key?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (key) headers.set("Idempotency-Key", key);
  return new Request(`http://host.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function responseBody(response: Response): Promise<any> {
  return response.json();
}

async function createFixture<TStore extends KernelStore = InMemoryKernelStore>(
  authoritativeEvidence = false,
  providedStore?: TStore,
): Promise<ReconciliationFixture<TStore>> {
  const store = providedStore
    ?? new InMemoryKernelStore(undefined, () => NOW) as unknown as TStore;
  let ordinal = 0;
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    now: () => NOW,
    id: (kind) => `${kind}-${++ordinal}`,
  });
  const workspace = (await responseBody(await host.dispatch(mutation("/v2/workspaces", {
    name: "核对工作区",
    viewMode: "professional",
    pluginIds: ["coding", "runner-claude-cli"],
  }, "workspace")))).data;
  const executionId = "execution-reconciliation";
  const taskId = "task-reconciliation";
  const threadId = "thread-reconciliation";
  const candidate: Candidate = {
    id: "candidate-reconciliation",
    taskId,
    runnerId: "claude-cli",
    sequence: 1,
    baseRevision: sha256("base-revision"),
    diffDigest: sha256("diff"),
    summary: "已生成候选",
    sandbox: {
      enforced: true,
      fallbackUsed: false,
      evidenceDigest: CONTROL_PLANE.sandboxDigest,
    },
  };
  const gate: GateResult = {
    candidateId: candidate.id,
    status: "passed",
    authoritative: authoritativeEvidence,
    evidenceDigest: sha256("gate-evidence"),
    checks: [{ id: "tests", status: "passed", summary: "测试通过" }],
  };
  const evidence: CodeEvidence = createCodeEvidence({
    taskId,
    candidateId: candidate.id,
    runnerId: "claude-cli",
    specDigest: CONTROL_PLANE.specDigest,
    governanceDigest: CONTROL_PLANE.governanceDigest,
    harnessDigest: CONTROL_PLANE.harnessDigest,
    sandboxDigest: CONTROL_PLANE.sandboxDigest,
    repositoryIndexDigest: CONTROL_PLANE.repositoryIndexDigest,
    gateEvidenceDigest: gate.evidenceDigest!,
    diffDigest: candidate.diffDigest,
  });
  const task: CodingTask = {
    id: taskId,
    workspaceId: workspace.id,
    repositoryId: "repository-reconciliation",
    title: "核对外部 Runner",
    request: "修复核对流程",
    stage: "verify",
    status: "needs_reconciliation",
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const result: CodingExecutionResult = {
    task,
    runnerId: "claude-cli",
    status: "needs_reconciliation",
    candidates: authoritativeEvidence ? [candidate] : [],
    gates: authoritativeEvidence ? [gate] : [],
    ...(authoritativeEvidence ? { evidence } : {}),
    nextStep: "人工核对外部执行结果",
    limits: { maxRepairAttempts: 3, maxDurationMs: 3_600_000 },
    controlPlane: CONTROL_PLANE,
  };
  const runnerIdentity = {
    requestedPath: "/opt/muniu/bin/claude",
    realPath: "/opt/muniu/bin/claude",
    version: "1.0.0",
    sha256: "a".repeat(64),
    device: "1",
    inode: "2",
    byteLength: 1024,
    modifiedAtMs: 1,
  };
  const runnerIdentityDigest = sha256(runnerIdentity);
  const execution: Execution = {
    id: executionId,
    tenantId: "local",
    workspaceId: workspace.id,
    threadId,
    pluginId: "coding",
    agentDefinitionId: "coding.builtin",
    modelBindingId: "model-reconciliation",
    initiatedBy: "local-owner",
    executionPrincipalId: "agent:coding",
    generation: 1,
    status: "needs_reconciliation",
    authorityId: "authority-reconciliation",
    runnerId: "claude-cli",
    failureCode: "UNKNOWN_EXTERNAL_SIDE_EFFECT",
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const authorityPolicy = {
    principalId: "agent:coding",
    toolIds: [
      "coding.repository.read",
      "coding.sandbox.write",
      "coding.gate.verify",
      "coding.candidate.accept",
      "runner.claude.execute",
    ],
    dataScopes: [{ namespace: "coding", resourceId: "*" }],
    autoAllowedEffects: ["local_read", "local_reversible_write"],
    budget: {
      maxSubagentDepth: 2,
      maxSubagents: 4,
      maxTokens: 100_000,
      maxCostMinorUnits: "5000",
      currency: "CNY",
      maxDurationMs: 3_600_000,
    },
  } as const;
  const authority: ExecutionAuthority = {
    id: execution.authorityId,
    tenantId: "local",
    workspaceId: workspace.id,
    executionId,
    ...authorityPolicy,
    commitment: sha256({
      executionId,
      workspaceId: workspace.id,
      ...authorityPolicy,
      parentAuthorityId: undefined,
      runnerId: "claude-cli",
    }),
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const thread: Thread = {
    id: threadId,
    tenantId: "local",
    workspaceId: workspace.id,
    subject: task.title,
    pluginId: "coding",
    resourceRef: { namespace: "coding.task", resourceId: taskId },
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };

  await store.transact("local", (transaction) => {
    transaction.putProjection("execution", executionId, execution);
    transaction.putProjection("authority", authority.id, authority);
    transaction.putProjection("thread", thread.id, thread);
    transaction.putProjection("modelConnection", execution.modelBindingId, {
      id: execution.modelBindingId,
      tenantId: "local",
      presetId: "deepseek",
      secretRef: "keychain://muniu.v2/model-reconciliation",
      defaultModel: "deepseek-chat",
      status: "ready",
      streamVersion: 1,
    });
    transaction.putProjection(CODING_RUNNER_CONFIGURATION_NAMESPACE, `${workspace.id}:claude-cli`, {
      id: `${workspace.id}:claude-cli`,
      tenantId: "local",
      workspaceId: workspace.id,
      runnerId: "claude-cli",
      status: "confirmed",
      identity: runnerIdentity,
      identityDigest: runnerIdentityDigest,
      confirmedBy: "local-owner",
      confirmedAt: NOW,
      streamVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    transaction.putProjection("coding.task", taskId, task);
    transaction.putProjection("coding.execution", executionId, {
      executionId,
      generation: 1,
      taskId,
      repositoryId: task.repositoryId,
      status: "needs_reconciliation",
      controlPlane: CONTROL_PLANE,
      baseRevision: candidate.baseRevision,
      runnerId: "claude-cli",
      externalInvocation: {
        runnerId: "claude-cli",
        attempt: 1,
        identityDigest: runnerIdentityDigest,
        sandboxPath: "/private/var/tmp/muniu/candidate-reconciliation",
        runnerArtifactPath: "/private/var/tmp/muniu/runner-reconciliation/runner",
        status: "outcome_unknown",
        startedAt: NOW,
        updatedAt: NOW,
      },
      result,
      streamVersion: 2,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const inboxItems: readonly InboxItem[] = [
      {
        id: "reconciliation:execution-reconciliation:job-original",
        tenantId: "local",
        workspaceId: workspace.id,
        executionId,
        kind: "reconciliation",
        title: "外部操作结果需要人工核对",
        summary: "结果未知",
        createdAt: NOW,
        status: "open",
      },
      {
        id: "coding-review:execution-reconciliation",
        tenantId: "local",
        workspaceId: workspace.id,
        executionId,
        kind: "failure",
        title: "Coding 执行受阻",
        summary: "等待人工处理",
        createdAt: NOW,
        status: "open",
      },
    ];
    for (const item of inboxItems) transaction.putProjection("inbox", item.id, item);
    if (authoritativeEvidence) {
      transaction.putProjection("coding.candidate", candidate.id, {
        ...candidate,
        tenantId: "local",
        workspaceId: workspace.id,
        executionId,
        diff: "diff --git a/a b/a",
        createdAt: NOW,
      });
      transaction.putProjection("coding.gate-result", candidate.id, {
        ...gate,
        tenantId: "local",
        workspaceId: workspace.id,
        executionId,
        createdAt: NOW,
      });
      transaction.putProjection("coding.code-evidence", evidence.digest, {
        ...evidence,
        tenantId: "local",
        workspaceId: workspace.id,
        executionId,
        createdAt: NOW,
      });
    }
    transaction.appendEvent({
      tenantId: "local",
      aggregateType: "execution",
      aggregateId: executionId,
      expectedStreamVersion: 0,
      type: "execution.needs_reconciliation",
      actorId: "worker:fixture",
      executionId,
      generation: 1,
      publicPayload: { workspaceId: workspace.id },
      correlationId: "fixture-execution",
    });
    transaction.appendEvent({
      tenantId: "local",
      aggregateType: "thread",
      aggregateId: threadId,
      expectedStreamVersion: 0,
      type: "thread.turn_submitted",
      actorId: "local-owner",
      executionId,
      generation: 1,
      publicPayload: { workspaceId: workspace.id },
      correlationId: "fixture-thread",
    });
    transaction.appendEvent({
      tenantId: "local",
      aggregateType: "coding.task",
      aggregateId: taskId,
      expectedStreamVersion: 0,
      type: "coding.execution_needs_reconciliation",
      actorId: "agent:coding",
      executionId,
      generation: 1,
      publicPayload: { workspaceId: workspace.id },
      correlationId: "fixture-task",
    });
    for (let version = 0; version < 2; version += 1) {
      transaction.appendEvent({
        tenantId: "local",
        aggregateType: "coding.execution",
        aggregateId: executionId,
        expectedStreamVersion: version,
        type: version === 0 ? "coding.execution_started" : "coding.execution_result_persisted",
        actorId: "agent:coding",
        executionId,
        generation: 1,
        publicPayload: { workspaceId: workspace.id },
        correlationId: "fixture-coding-execution",
      });
    }
  });
  return { store, host, workspaceId: workspace.id, executionId, taskId };
}

test("terminate 原子终结未知 Coding 执行、关闭收件箱并入队清理 Job", async () => {
  const fixture = await createFixture();
  const viewPath = `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation`;
  const path = `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`;

  const viewResponse = await fixture.host.dispatch(new Request(`http://host.test${viewPath}`));
  assert.equal(viewResponse.status, 200);
  const view = (await responseBody(viewResponse)).data;
  assert.deepEqual(view, {
    executionId: fixture.executionId,
    workspaceId: fixture.workspaceId,
    taskTitle: "核对外部 Runner",
    nextStep: "人工核对外部执行结果",
    runnerId: "claude-cli",
    status: "needs_reconciliation",
    expectedStreamVersion: 1,
    expectedCodingStreamVersion: 2,
    evidence: {
      candidateCount: 0,
      gateCount: 0,
      markCompletedAllowed: false,
      summary: "尚无可用于标记完成的权威 Gate 与 CodeEvidence",
    },
    availableDecisions: ["terminate", "create_new_call"],
  });
  assert.doesNotMatch(JSON.stringify(view), /\/private\/var\/tmp/u);

  const missingKey = await fixture.host.dispatch(mutation(path, {
    expectedStreamVersion: 1,
    expectedCodingStreamVersion: 2,
    decision: "terminate",
  }));
  assert.equal(missingKey.status, 400);

  const stale = await fixture.host.dispatch(mutation(path, {
    expectedStreamVersion: 1,
    expectedCodingStreamVersion: 1,
    decision: "terminate",
  }, "stale"));
  assert.equal(stale.status, 409);
  assert.equal((await responseBody(stale)).code, "STREAM_VERSION_CONFLICT");
  assert.equal(fixture.store.readJobs("local").length, 0);

  const requestBody = {
    expectedStreamVersion: 1,
    expectedCodingStreamVersion: 2,
    decision: "terminate",
  } as const;
  const decided = await fixture.host.dispatch(mutation(path, requestBody, "terminate"));
  assert.equal(decided.status, 200);
  const response = (await responseBody(decided)).data;
  assert.equal(response.decision, "terminate");
  assert.equal(response.execution.status, "cancelled");
  assert.equal(response.codingExecution.status, "cancelled");
  assert.equal(response.task.status, "cancelled");
  assert.doesNotMatch(JSON.stringify(response), /\/private\/var\/tmp/u);

  const replay = await responseBody(await fixture.host.dispatch(mutation(
    path,
    requestBody,
    "terminate",
  )));
  assert.deepEqual(replay.data, response);
  const reused = await fixture.host.dispatch(mutation(path, {
    ...requestBody,
    decision: "mark_completed",
  }, "terminate"));
  assert.equal(reused.status, 409);
  assert.equal((await responseBody(reused)).code, "IDEMPOTENCY_KEY_REUSED");

  await fixture.store.transact("local", (transaction) => {
    const inbox = transaction.listProjections<InboxItem>("inbox")
      .filter((item) => item.executionId === fixture.executionId);
    assert.equal(inbox.length, 2);
    assert.ok(inbox.every((item) => item.status === "resolved"));
    const cleanup = transaction.getProjection<any>("job", response.cleanupJobId);
    assert.equal(cleanup.kind, "coding.sandbox.cleanup");
    assert.equal(cleanup.payload.reconciliationExecutionId, fixture.executionId);
    assert.equal("executionId" in cleanup.payload, false);
  });
  assert.equal(fixture.store.readJobs("local").length, 1);
  assert.ok(fixture.store.readOutbox("local").some((message) =>
    message.topic === "job.available"
    && message.payload.jobId === response.cleanupJobId));
  await fixture.host.close();
});

test("mark_completed 没有权威 Gate 与 CodeEvidence 时 fail closed", async () => {
  const fixture = await createFixture();
  const response = await fixture.host.dispatch(mutation(
    `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
    {
      expectedStreamVersion: 1,
      expectedCodingStreamVersion: 2,
      decision: "mark_completed",
    },
    "mark-without-evidence",
  ));
  assert.equal(response.status, 422);
  assert.equal((await responseBody(response)).code, "CODING_RECONCILIATION_EVIDENCE_REQUIRED");
  assert.equal(fixture.store.readJobs("local").length, 0);
  const execution = await fixture.store.transact("local", (transaction) =>
    transaction.getProjection<Execution>("execution", fixture.executionId));
  assert.equal(execution?.status, "needs_reconciliation");
  await fixture.host.close();
});

test("mark_completed 只用已持久化的权威 Gate 与 CodeEvidence 收敛完成态", async () => {
  const fixture = await createFixture(true);
  const view = (await responseBody(await fixture.host.dispatch(new Request(
    `http://host.test/v2/plugins/coding/executions/${fixture.executionId}/reconciliation`,
  )))).data;
  assert.equal(view.evidence.markCompletedAllowed, true);
  assert.equal(view.evidence.candidateCount, 1);
  assert.equal(view.evidence.gateCount, 1);
  assert.equal(view.evidence.codeEvidenceDigest.length, 64);
  assert.deepEqual(view.availableDecisions, ["terminate", "mark_completed", "create_new_call"]);
  const response = await fixture.host.dispatch(mutation(
    `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
    {
      expectedStreamVersion: 1,
      expectedCodingStreamVersion: 2,
      decision: "mark_completed",
    },
    "mark-with-evidence",
  ));
  assert.equal(response.status, 200);
  const data = (await responseBody(response)).data;
  assert.equal(data.execution.status, "completed");
  assert.equal(data.codingExecution.result.status, "completed");
  assert.equal(data.task.stage, "learn");
  assert.equal(data.task.status, "completed");
  assert.equal(fixture.store.readJobs("local").length, 1);
  await fixture.host.close();
});

test("create_new_call 原子终止旧调用并以新 Execution 入队，绝不重放旧 Job", async () => {
  const fixture = await createFixture();
  const requestBody = {
    expectedStreamVersion: 1,
    expectedCodingStreamVersion: 2,
    decision: "create_new_call",
  } as const;
  const response = await fixture.host.dispatch(mutation(
    `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
    requestBody,
    "create-new-call",
  ));
  assert.equal(response.status, 200);
  const data = (await responseBody(response)).data;
  assert.equal(data.execution.status, "cancelled");
  assert.equal(data.codingExecution.status, "cancelled");
  assert.equal(data.task.status, "active");
  assert.equal(data.newExecution.status, "queued");
  assert.notEqual(data.newExecution.id, fixture.executionId);

  const jobs = fixture.store.readJobs("local");
  assert.equal(jobs.length, 2);
  const cleanup = jobs.find((job) => job.kind === "coding.sandbox.cleanup")!;
  const rerun = jobs.find((job) => job.kind === "agent.execution.run")!;
  assert.equal(cleanup.payload.reconciliationExecutionId, fixture.executionId);
  assert.equal("executionId" in cleanup.payload, false);
  assert.equal(rerun.payload.executionId, data.newExecution.id);
  assert.notEqual(rerun.idempotencyKey, `execution:${fixture.executionId}:generation:1`);

  await fixture.store.transact("local", (transaction) => {
    const workspace = transaction.getProjection<any>("workspace", fixture.workspaceId)!;
    transaction.putProjection("workspace", fixture.workspaceId, {
      ...workspace,
      activePluginIds: ["coding"],
    });
  });
  const replay = await responseBody(await fixture.host.dispatch(mutation(
    `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
    requestBody,
    "create-new-call",
  )));
  assert.deepEqual(replay.data, data);
  await fixture.host.close();
});

test("人工核对拒绝 Runner 绑定、权限或确认身份被篡改的状态", async (context) => {
  await context.test("Runner 绑定不一致", async () => {
    const fixture = await createFixture();
    await fixture.store.transact("local", (transaction) => {
      const run = transaction.getProjection<any>("coding.execution", fixture.executionId)!;
      transaction.putProjection("coding.execution", fixture.executionId, {
        ...run,
        externalInvocation: { ...run.externalInvocation, runnerId: "codex-cli" },
      });
    });
    const response = await fixture.host.dispatch(mutation(
      `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
      {
        expectedStreamVersion: 1,
        expectedCodingStreamVersion: 2,
        decision: "terminate",
      },
      "tampered-runner",
    ));
    assert.equal(response.status, 422);
    assert.equal((await responseBody(response)).code, "CODING_RECONCILIATION_STATE_INVALID");
    assert.equal(fixture.store.readJobs("local").length, 0);
    await fixture.host.close();
  });

  await context.test("新调用缺少 Runner 工具权限", async () => {
    const fixture = await createFixture();
    await fixture.store.transact("local", (transaction) => {
      const authority = transaction.getProjection<ExecutionAuthority>(
        "authority",
        "authority-reconciliation",
      )!;
      transaction.putProjection("authority", authority.id, {
        ...authority,
        toolIds: authority.toolIds.filter((toolId) => toolId !== "runner.claude.execute"),
      });
    });
    const response = await fixture.host.dispatch(mutation(
      `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
      {
        expectedStreamVersion: 1,
        expectedCodingStreamVersion: 2,
        decision: "create_new_call",
      },
      "tampered-authority",
    ));
    assert.equal(response.status, 422);
    assert.equal((await responseBody(response)).code, "CODING_NEW_CALL_NOT_READY");
    assert.equal(fixture.store.readJobs("local").length, 0);
    await fixture.host.close();
  });

  await context.test("新调用的 Runner 确认摘要不自洽", async () => {
    const fixture = await createFixture();
    await fixture.store.transact("local", (transaction) => {
      const key = `${fixture.workspaceId}:claude-cli`;
      const configuration = transaction.getProjection<any>(
        CODING_RUNNER_CONFIGURATION_NAMESPACE,
        key,
      );
      assert.ok(configuration);
      transaction.putProjection(CODING_RUNNER_CONFIGURATION_NAMESPACE, key, {
        ...configuration,
        identityDigest: "tampered",
      });
    });
    const response = await fixture.host.dispatch(mutation(
      `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
      {
        expectedStreamVersion: 1,
        expectedCodingStreamVersion: 2,
        decision: "create_new_call",
      },
      "tampered-confirmation",
    ));
    assert.equal(response.status, 422);
    assert.equal((await responseBody(response)).code, "CODING_NEW_CALL_NOT_READY");
    assert.equal(fixture.store.readJobs("local").length, 0);
    await fixture.host.close();
  });
});

test("SQLite 把核对状态、清理 Job 与 outbox 作为一个持久事务提交", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-reconciliation-sqlite-"));
  const databaseFile = join(directory, "state.sqlite3");
  const hmacKey = Buffer.from("coding-reconciliation-sqlite-hmac-key");
  try {
    const storage = new SqliteStorage({ databaseFile, hmacKey, now: () => new Date(NOW) });
    const fixture = await createFixture(false, storage);
    const response = await fixture.host.dispatch(mutation(
      `/v2/plugins/coding/executions/${fixture.executionId}/reconciliation-decisions`,
      {
        expectedStreamVersion: 1,
        expectedCodingStreamVersion: 2,
        decision: "terminate",
      },
      "sqlite-terminate",
    ));
    assert.equal(response.status, 200);
    const data = (await responseBody(response)).data;
    const physicalJob = await storage.getJob(data.cleanupJobId);
    assert.equal(physicalJob?.kind, "coding.sandbox.cleanup");
    assert.deepEqual(physicalJob?.payload, {
      reconciliationExecutionId: fixture.executionId,
    });
    assert.ok((await storage.listOutbox("local", 100)).some((message) =>
      message.topic === "job.available"
      && message.payload.jobId === data.cleanupJobId));
    await fixture.host.close();

    const reopened = new SqliteStorage({ databaseFile, hmacKey, now: () => new Date(NOW) });
    assert.equal(
      (await reopened.getProjection("local", "execution", fixture.executionId))?.status,
      "cancelled",
    );
    assert.equal(
      (await reopened.getProjection("local", "coding.execution", fixture.executionId))?.status,
      "cancelled",
    );
    assert.equal(
      (await reopened.getProjection("local", "coding.task", fixture.taskId))?.status,
      "cancelled",
    );
    assert.equal(
      (await reopened.getProjection(
        "local",
        "inbox",
        "reconciliation:execution-reconciliation:job-original",
      ))?.status,
      "resolved",
    );
    assert.equal((await reopened.getJob(data.cleanupJobId))?.status, "available");
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
