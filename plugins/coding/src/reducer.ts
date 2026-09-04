import {
  advanceCodingTask,
  assertSha256,
  createCandidate,
  createCodeEvidence,
  createCodingTask,
  createGateResult,
  createRepository,
  createService,
  createSpec,
  immutable,
  reviseSpec,
  type CodingTaskAggregate,
  type RepositoryAggregate,
  type ServiceAggregate,
} from "./domain.ts";
import { CodingDomainError } from "./errors.ts";
import type {
  StoredCodingTaskEvent,
  StoredRepositoryEvent,
  StoredServiceEvent,
} from "./events.ts";

export function reduceRepositoryEvents(
  workspaceId: string,
  repositoryId: string,
  events: readonly StoredRepositoryEvent[],
): RepositoryAggregate | undefined {
  let aggregate: RepositoryAggregate | undefined;
  for (const event of events) {
    assertStoredEvent(event, aggregate?.streamVersion ?? 0);
    if (event.type !== "coding.repository_registered") {
      throw invalidEvent("仓库事件流包含其他聚合的事件");
    }
    if (aggregate) {
      throw new CodingDomainError(
        "IMMUTABLE_SNAPSHOT",
        "仓库登记快照不能覆盖",
        "创建新的仓库记录",
      );
    }
    aggregate = immutable({
      repository: callDomain(() => createRepository({
        id: repositoryId,
        workspaceId,
        name: event.payload.name,
        rootRealPath: event.payload.rootRealPath,
        vcs: event.payload.vcs,
        createdAt: event.occurredAt,
      })),
      streamVersion: event.streamVersion,
    });
  }
  return aggregate;
}

export function reduceServiceEvents(
  serviceId: string,
  events: readonly StoredServiceEvent[],
): ServiceAggregate | undefined {
  let aggregate: ServiceAggregate | undefined;
  for (const event of events) {
    assertStoredEvent(event, aggregate?.streamVersion ?? 0);
    if (event.type !== "coding.service_registered") {
      throw invalidEvent("服务事件流包含其他聚合的事件");
    }
    if (aggregate) {
      throw new CodingDomainError(
        "IMMUTABLE_SNAPSHOT",
        "服务登记快照不能覆盖",
        "创建新的服务记录",
      );
    }
    aggregate = immutable({
      service: callDomain(() => createService({
        id: serviceId,
        repositoryId: event.payload.repositoryId,
        name: event.payload.name,
        paths: event.payload.paths,
      })),
      streamVersion: event.streamVersion,
    });
  }
  return aggregate;
}

export function reduceCodingTaskEvents(
  workspaceId: string,
  taskId: string,
  events: readonly StoredCodingTaskEvent[],
): CodingTaskAggregate | undefined {
  let aggregate: CodingTaskAggregate | undefined;
  for (const event of events) {
    assertStoredEvent(event, aggregate?.streamVersion ?? 0);
    if (event.type === "coding.task_created") {
      if (aggregate) {
        throw new CodingDomainError(
          "IMMUTABLE_SNAPSHOT",
          "Coding 任务创建事件不能覆盖",
          "创建新的 Coding 任务",
        );
      }
      const task = callDomain(() => createCodingTask({
        id: taskId,
        workspaceId,
        repositoryId: event.payload.repositoryId,
        title: event.payload.title,
        request: event.payload.request,
        createdAt: event.occurredAt,
      }));
      aggregate = immutable({
        task: { ...task, streamVersion: event.streamVersion },
        specs: [],
        candidates: [],
        gateResults: [],
        codeEvidence: [],
        streamVersion: event.streamVersion,
      });
      continue;
    }

    const current = requireTaskAggregate(aggregate);
    switch (event.type) {
      case "coding.spec_recorded": {
        if (current.task.stage !== "discover") {
          throw invalidTransition("初始 Spec 只能在 discover 阶段记录");
        }
        if (current.specs.length > 0) {
          throw immutableSnapshot("Spec 已存在，后续变更必须创建修订快照");
        }
        const spec = callDomain(() => createSpec({
          id: event.payload.specId,
          taskId,
          title: event.payload.title,
          body: event.payload.body,
          acceptanceCriteria: event.payload.acceptanceCriteria,
          createdAt: event.occurredAt,
        }));
        aggregate = updateTaskAggregate(current, event, { specs: [...current.specs, spec] });
        break;
      }
      case "coding.spec_revised": {
        if (current.task.stage !== "specify") {
          throw invalidTransition("Spec 只能在 specify 阶段修订");
        }
        const previous = current.specs.at(-1);
        if (!previous) throw missingPrerequisite("修订 Spec 前必须先记录初始 Spec");
        if (previous.id !== event.payload.previousSpecId) {
          throw immutableSnapshot("Spec 修订只能基于最新快照");
        }
        if (current.specs.some((spec) => spec.id === event.payload.specId)) {
          throw immutableSnapshot("Spec ID 已存在，不能覆盖旧快照");
        }
        const spec = callDomain(() => reviseSpec(previous, {
          id: event.payload.specId,
          body: event.payload.body,
          createdAt: event.occurredAt,
          ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
          ...(event.payload.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: event.payload.acceptanceCriteria }),
        }));
        aggregate = updateTaskAggregate(current, event, { specs: [...current.specs, spec] });
        break;
      }
      case "coding.task_advanced": {
        assertStagePrerequisite(current, event.payload.nextStage);
        const task = callDomain(
          () => advanceCodingTask(current.task, event.payload.nextStage, event.occurredAt),
          "INVALID_TRANSITION",
          "按固定 Coding 工作流推进任务",
        );
        aggregate = immutable({ ...current, task, streamVersion: event.streamVersion });
        break;
      }
      case "coding.candidate_recorded": {
        if (current.task.stage !== "implement" && current.task.stage !== "verify") {
          throw invalidTransition("候选变更只能在 implement 或 verify 阶段记录");
        }
        const input = event.payload.candidate;
        if (!input.sandbox.enforced || input.sandbox.fallbackUsed || !input.sandbox.evidenceDigest) {
          throw failClosed("Sandbox 未提供强制执行证据，不能记录候选变更");
        }
        try {
          assertSha256(input.sandbox.evidenceDigest, "Sandbox");
        } catch {
          throw failClosed("Sandbox 证据摘要无效，不能记录候选变更");
        }
        if (current.candidates.some((candidate) => candidate.id === input.id)) {
          throw immutableSnapshot("Candidate ID 已存在，不能覆盖旧快照");
        }
        const expectedSequence = (current.candidates.at(-1)?.sequence ?? 0) + 1;
        if (input.sequence !== expectedSequence) {
          throw new CodingDomainError(
            "INVALID_INPUT",
            `候选序号应为 ${expectedSequence}`,
            "按顺序追加 Candidate",
            "candidate.sequence",
          );
        }
        const candidate = callDomain(
          () => createCandidate(taskId, event.payload.runnerId, input),
        );
        aggregate = updateTaskAggregate(current, event, {
          candidates: [...current.candidates, candidate],
        });
        break;
      }
      case "coding.gate_result_recorded": {
        if (current.task.stage !== "verify") {
          throw invalidTransition("GateResult 只能在 verify 阶段记录");
        }
        const input = event.payload.gateResult;
        if (!current.candidates.some((candidate) => candidate.id === input.candidateId)) {
          throw missingPrerequisite("GateResult 必须引用已记录的 Candidate");
        }
        if (current.gateResults.some((gate) => gate.candidateId === input.candidateId)) {
          throw immutableSnapshot("Candidate 已有 GateResult，不能覆盖旧快照");
        }
        if (input.status === "passed"
          && (!input.authoritative
            || !input.evidenceDigest
            || input.checks.some((check) => check.status !== "passed"))) {
          throw failClosed("Gate 缺少权威证据或检查未全部通过");
        }
        const gateResult = callDomain(
          () => createGateResult(input),
          input.status === "passed" ? "FAIL_CLOSED" : "INVALID_INPUT",
          "修正 GateResult 后重新提交",
        );
        aggregate = updateTaskAggregate(current, event, {
          gateResults: [...current.gateResults, gateResult],
        });
        break;
      }
      case "coding.code_evidence_recorded": {
        if (current.task.stage !== "approve") {
          throw invalidTransition("CodeEvidence 只能在 approve 阶段记录");
        }
        const input = event.payload.evidence;
        const candidate = current.candidates.find((item) => item.id === input.candidateId);
        if (!candidate) throw missingPrerequisite("CodeEvidence 必须引用已记录的 Candidate");
        if (candidate !== current.candidates.at(-1)) {
          throw missingPrerequisite("CodeEvidence 必须引用最新 Candidate");
        }
        const gate = current.gateResults.find((item) => item.candidateId === input.candidateId);
        if (!gate || gate.status !== "passed" || !gate.authoritative || !gate.evidenceDigest) {
          throw failClosed("CodeEvidence 必须引用通过且具有权威证据的 GateResult");
        }
        const spec = current.specs.at(-1);
        if (!spec) throw missingPrerequisite("CodeEvidence 必须引用固定 Spec");
        if (current.codeEvidence.some((evidence) => evidence.candidateId === input.candidateId)) {
          throw immutableSnapshot("Candidate 已有 CodeEvidence，不能覆盖旧快照");
        }
        if (input.specDigest !== spec.digest
          || input.diffDigest !== candidate.diffDigest
          || input.runnerId !== candidate.runnerId
          || input.sandboxDigest !== candidate.sandbox.evidenceDigest
          || input.gateEvidenceDigest !== gate.evidenceDigest) {
          throw failClosed("CodeEvidence 与已固定的 Spec、Candidate、Sandbox 或 GateResult 不一致");
        }
        const evidence = callDomain(() => createCodeEvidence({ ...input, taskId }));
        aggregate = updateTaskAggregate(current, event, {
          codeEvidence: [...current.codeEvidence, evidence],
        });
        break;
      }
      default:
        throw invalidEvent("任务事件流包含其他聚合的事件");
    }
  }
  return aggregate;
}

function assertStagePrerequisite(
  aggregate: CodingTaskAggregate,
  nextStage: CodingTaskAggregate["task"]["stage"],
): void {
  if (nextStage === "specify" && aggregate.specs.length === 0) {
    throw missingPrerequisite("进入 specify 前必须记录 Spec");
  }
  if (nextStage === "impact" && aggregate.specs.length === 0) {
    throw missingPrerequisite("进入 impact 前必须固定 Spec");
  }
  if (nextStage === "verify" && aggregate.candidates.length === 0) {
    throw missingPrerequisite("进入 verify 前必须记录 Candidate");
  }
  const latestCandidate = aggregate.candidates.at(-1);
  if (nextStage === "approve") {
    const gate = latestCandidate
      ? aggregate.gateResults.find((item) => item.candidateId === latestCandidate.id)
      : undefined;
    if (!gate || gate.status !== "passed" || !gate.authoritative || !gate.evidenceDigest) {
      throw missingPrerequisite("进入 approve 前最新 Candidate 必须通过权威 Gate");
    }
  }
  if (nextStage === "learn") {
    const evidence = latestCandidate
      ? aggregate.codeEvidence.find((item) => item.candidateId === latestCandidate.id)
      : undefined;
    if (!evidence) throw missingPrerequisite("进入 learn 前必须记录 CodeEvidence");
  }
}

function updateTaskAggregate(
  aggregate: CodingTaskAggregate,
  event: StoredCodingTaskEvent,
  update: Partial<Pick<CodingTaskAggregate, "specs" | "candidates" | "gateResults" | "codeEvidence">>,
): CodingTaskAggregate {
  return immutable({
    ...aggregate,
    ...update,
    task: {
      ...aggregate.task,
      streamVersion: event.streamVersion,
      updatedAt: event.occurredAt,
    },
    streamVersion: event.streamVersion,
  });
}

function requireTaskAggregate(
  aggregate: CodingTaskAggregate | undefined,
): CodingTaskAggregate {
  if (!aggregate) {
    throw new CodingDomainError(
      "NOT_FOUND",
      "Coding 任务尚未创建",
      "先提交 coding.task_created 事件",
    );
  }
  return aggregate;
}

function assertStoredEvent(
  event: {
    readonly eventId: string;
    readonly streamVersion: number;
    readonly occurredAt: string;
    readonly actor: { readonly id: string; readonly kind: string };
  },
  currentVersion: number,
): void {
  if (!event.eventId.trim()) throw invalidEvent("领域事件 ID 不能为空");
  if (event.streamVersion !== currentVersion + 1) {
    throw new CodingDomainError(
      "STREAM_VERSION_CONFLICT",
      `事件版本 ${event.streamVersion} 不连续，当前版本为 ${currentVersion}`,
      "按连续版本重放事件流",
    );
  }
  if (!event.actor.id.trim()) throw invalidEvent("领域事件必须记录发起人");
  if (!(["human", "agent", "system"] as const).includes(
    event.actor.kind as "human" | "agent" | "system",
  )) {
    throw invalidEvent("领域事件发起人类型无效");
  }
  if (Number.isNaN(Date.parse(event.occurredAt))) throw invalidEvent("领域事件时间无效");
}

function callDomain<T>(
  operation: () => T,
  code: "FAIL_CLOSED" | "INVALID_INPUT" | "INVALID_TRANSITION" = "INVALID_INPUT",
  action = "修正领域数据后重试",
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CodingDomainError) throw error;
    throw new CodingDomainError(
      code,
      error instanceof Error ? error.message : "领域数据无效",
      action,
    );
  }
}

function invalidEvent(message: string): CodingDomainError {
  return new CodingDomainError("INVALID_INPUT", message, "修正事件后重新构建投影");
}

function invalidTransition(message: string): CodingDomainError {
  return new CodingDomainError("INVALID_TRANSITION", message, "按固定 Coding 工作流推进任务");
}

function missingPrerequisite(message: string): CodingDomainError {
  return new CodingDomainError("MISSING_PREREQUISITE", message, "补齐前置控制面快照后重试");
}

function immutableSnapshot(message: string): CodingDomainError {
  return new CodingDomainError("IMMUTABLE_SNAPSHOT", message, "追加新快照，不要修改既有快照");
}

function failClosed(message: string): CodingDomainError {
  return new CodingDomainError("FAIL_CLOSED", message, "补齐权威证据后重试");
}
