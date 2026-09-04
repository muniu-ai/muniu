import type { ToolEffectClass } from "@mn/contracts";
import {
  assertSha256,
  createCandidate,
  createCodeEvidence,
  immutable,
  type Candidate,
  type CodeEvidence,
  type CodingTask,
  type GateCheck,
  type GateResult,
} from "./domain.ts";

export const CODING_DEFAULT_LIMITS = Object.freeze({
  maxRepairAttempts: 3,
  maxDurationMs: 3_600_000,
});

export interface CodingExecutionLimits {
  readonly maxRepairAttempts: number;
  readonly maxDurationMs: number;
}

export interface CodingControlPlaneCommitment {
  readonly protocol: "coding-v2";
  readonly specDigest: string;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly sandboxDigest: string;
  readonly repositoryIndexDigest: string;
}

export interface CandidateDraft {
  readonly id: string;
  readonly sequence: number;
  readonly baseRevision: string;
  readonly diffDigest: string;
  readonly summary: string;
  readonly sandbox: {
    readonly enforced: boolean;
    readonly fallbackUsed: boolean;
    readonly evidenceDigest?: string;
  };
}

export type RunnerEvent =
  | { readonly type: "candidate"; readonly candidate: CandidateDraft }
  | {
    readonly type: "result";
    readonly status: "completed" | "failed" | "cancelled" | "unknown";
    readonly reason?: string;
  }
  | { readonly type: "progress"; readonly stage: string; readonly summary: string }
  | { readonly type: "runner_event"; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly type: "diagnostic"; readonly message: string };

export interface RunnerSession {
  readonly sessionId: string;
}

export interface RunnerStartInput {
  readonly executionId: string;
  readonly repositoryPath: string;
  readonly expectedRepositoryRealPath: string;
  readonly resourceDigest: string;
  readonly preparedInput: string;
  readonly explicitlySelected: boolean;
}

export interface RunnerResumeInput {
  readonly kind: "gate_feedback";
  readonly candidateId: string;
  readonly failedChecks: readonly GateCheck[];
  readonly preparedInput: string;
  readonly explicitlySelected: boolean;
}

export interface CodingRunnerAdapter {
  readonly id: string;
  readonly external: boolean;
  start(input: RunnerStartInput): Promise<RunnerSession>;
  events(sessionId: string): AsyncIterable<RunnerEvent>;
  cancel(sessionId: string): Promise<void>;
  resume(sessionId: string, input: RunnerResumeInput): Promise<void>;
}

export interface RawGateReport {
  readonly status: "passed" | "failed" | "error" | "missing";
  readonly authoritative: boolean;
  readonly evidenceDigest?: string;
  readonly checks: readonly GateCheck[];
  readonly reason?: string;
}

export interface GateVerifier {
  verify(candidate: Candidate, controlPlane: CodingControlPlaneCommitment): Promise<RawGateReport>;
}

export interface ApprovalRequest {
  readonly effectClass: ToolEffectClass;
  readonly intent: string;
  readonly candidate: Candidate;
  readonly evidence: CodeEvidence;
}

export type ApprovalDecision = "approved_once" | "denied";

export interface CodeDeliverable {
  readonly kind: "code_change";
  readonly title: string;
  readonly summary: string;
  readonly diffDigest: string;
  readonly nextStep: string;
}

export type CodingExecutionStatus =
  | "waiting_approval"
  | "completed"
  | "needs_human_decision"
  | "needs_reconciliation"
  | "failed"
  | "cancelled";

export interface CodingExecutionResult {
  readonly task: CodingTask;
  readonly runnerId: string;
  readonly status: CodingExecutionStatus;
  readonly candidates: readonly Candidate[];
  readonly gates: readonly GateResult[];
  readonly evidence?: CodeEvidence;
  readonly approval?: ApprovalDecision | "pending";
  readonly deliverable?: CodeDeliverable;
  readonly nextStep: string;
  readonly limits: CodingExecutionLimits;
  readonly controlPlane: CodingControlPlaneCommitment;
}

export interface ExecuteCodingInput {
  readonly task: CodingTask;
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly gateVerifier: GateVerifier;
  readonly selectedRunnerId?: string;
  readonly externalRunnerConfirmed?: boolean;
  readonly executionId?: string;
  readonly repositoryPath?: string;
  readonly expectedRepositoryRealPath?: string;
  readonly limits?: Partial<CodingExecutionLimits>;
  readonly approval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface CodingExecutionEngineOptions {
  readonly runners: readonly CodingRunnerAdapter[];
  readonly now?: () => number;
}

export class CodingExecutionEngine {
  readonly #runners = new Map<string, CodingRunnerAdapter>();
  readonly #now: () => number;

  constructor(options: CodingExecutionEngineOptions) {
    for (const runner of options.runners) {
      if (this.#runners.has(runner.id)) throw new Error(`Runner ID 重复：${runner.id}`);
      this.#runners.set(runner.id, runner);
    }
    if (!this.#runners.has("builtin")) throw new Error("Coding 执行必须注册 builtin Runner");
    this.#now = options.now ?? (() => Date.now());
  }

  async execute(input: ExecuteCodingInput): Promise<CodingExecutionResult> {
    validateControlPlane(input.controlPlane);
    const limits = resolveLimits(input.limits);
    const runnerId = input.selectedRunnerId ?? "builtin";
    const runner = this.#runners.get(runnerId);
    if (!runner) throw new Error(`Runner 未注册：${runnerId}`);
    if (runner.external && (input.selectedRunnerId === undefined || !input.externalRunnerConfirmed)) {
      throw new Error("外部 Runner 必须显式选择，并在二进制身份重新确认后使用");
    }
    if (runner.external
      && (!input.repositoryPath || !input.expectedRepositoryRealPath || !input.executionId)) {
      throw new Error("外部 Runner 必须固定 Execution 和仓库真实路径");
    }

    const startedAt = this.#now();
    const candidates: Candidate[] = [];
    const gates: GateResult[] = [];
    let session: RunnerSession;
    try {
      session = await runner.start({
        executionId: input.executionId ?? input.task.id,
        repositoryPath: input.repositoryPath ?? "",
        expectedRepositoryRealPath: input.expectedRepositoryRealPath ?? "",
        resourceDigest: input.controlPlane.repositoryIndexDigest,
        preparedInput: input.task.request,
        explicitlySelected: runner.external,
      });
    } catch (error) {
      return outcome(input, runnerId, limits, candidates, gates, "failed", undefined,
        `Runner 启动失败：${safeMessage(error)}`);
    }

    while (true) {
      let draft: CandidateDraft | undefined;
      let terminal: Extract<RunnerEvent, { type: "result" }> | undefined;
      try {
        for await (const event of runner.events(session.sessionId)) {
          if (event.type === "candidate") {
            draft = event.candidate;
            break;
          }
          if (event.type === "result") {
            terminal = event;
            break;
          }
        }
      } catch (error) {
        return outcome(input, runnerId, limits, candidates, gates, "needs_reconciliation", undefined,
          `Runner 事件流中断：${safeMessage(error)}`);
      }

      if (!draft) {
        if (!terminal || terminal.status === "unknown" || terminal.status === "completed") {
          return outcome(
            input,
            runnerId,
            limits,
            candidates,
            gates,
            "needs_reconciliation",
            undefined,
            terminal?.reason ?? "Runner 未提供可核验候选，结果未知",
          );
        }
        if (terminal.status === "cancelled") {
          return outcome(input, runnerId, limits, candidates, gates, "cancelled", undefined,
            terminal.reason ?? "执行已取消");
        }
        return outcome(input, runnerId, limits, candidates, gates, "failed", undefined,
          terminal.reason ?? "Runner 执行失败");
      }

      let candidate: Candidate;
      try {
        candidate = createCandidate(input.task.id, runnerId, draft);
      } catch (error) {
        return outcome(input, runnerId, limits, candidates, gates, "needs_reconciliation", undefined,
          `候选记录无效：${safeMessage(error)}`);
      }
      if (candidate.sequence !== candidates.length + 1) {
        return outcome(input, runnerId, limits, candidates, gates, "needs_reconciliation", undefined,
          "候选序号不连续，无法确认执行结果");
      }
      candidates.push(candidate);

      if (this.#now() - startedAt >= limits.maxDurationMs) {
        try {
          await runner.cancel(session.sessionId);
        } catch {
          // 预算已耗尽时不因取消确认失败而自动重放或继续执行。
        }
        return outcome(input, runnerId, limits, candidates, gates, "needs_human_decision", undefined,
          "执行已达到一小时上限，检查当前 Diff 后决定继续或终止");
      }

      const gate = candidate.sandbox.enforced && !candidate.sandbox.fallbackUsed
        && candidate.sandbox.evidenceDigest
        ? await verifyFailClosed(input.gateVerifier, candidate, input.controlPlane)
        : sandboxFailure(candidate);
      gates.push(gate);

      if (gate.status === "passed") {
        const evidence = createCodeEvidence({
          taskId: input.task.id,
          candidateId: candidate.id,
          runnerId,
          specDigest: input.controlPlane.specDigest,
          governanceDigest: input.controlPlane.governanceDigest,
          harnessDigest: input.controlPlane.harnessDigest,
          sandboxDigest: input.controlPlane.sandboxDigest,
          repositoryIndexDigest: input.controlPlane.repositoryIndexDigest,
          gateEvidenceDigest: gate.evidenceDigest!,
          diffDigest: candidate.diffDigest,
        });
        if (!input.approval) {
          return outcome(input, runnerId, limits, candidates, gates, "waiting_approval", evidence,
            "审阅 Diff、检查结果和证据后决定是否批准");
        }
        const approval = await input.approval({
          effectClass: "local_reversible_write",
          intent: `批准 Coding 任务“${input.task.title}”的代码变更`,
          candidate,
          evidence,
        });
        if (approval === "denied") {
          return outcome(input, runnerId, limits, candidates, gates, "cancelled", evidence,
            "变更已拒绝，任务未应用", approval);
        }
        const deliverable = immutable({
          kind: "code_change" as const,
          title: input.task.title,
          summary: candidate.summary,
          diffDigest: candidate.diffDigest,
          nextStep: "查看成果并记录学习结论",
        });
        return outcome(input, runnerId, limits, candidates, gates, "completed", evidence,
          deliverable.nextStep, approval, deliverable);
      }

      const repairsUsed = candidates.length - 1;
      if (repairsUsed >= limits.maxRepairAttempts || this.#now() - startedAt >= limits.maxDurationMs) {
        return outcome(input, runnerId, limits, candidates, gates, "needs_human_decision", undefined,
          "检查失败原因，决定修改方案或终止任务");
      }
      try {
        await runner.resume(session.sessionId, {
          kind: "gate_feedback",
          candidateId: candidate.id,
          failedChecks: gate.checks,
          preparedInput: gateFeedback(gate),
          explicitlySelected: runner.external,
        });
      } catch (error) {
        return outcome(input, runnerId, limits, candidates, gates, "needs_reconciliation", undefined,
          `修复请求结果未知：${safeMessage(error)}`);
      }
    }
  }
}

async function verifyFailClosed(
  verifier: GateVerifier,
  candidate: Candidate,
  controlPlane: CodingControlPlaneCommitment,
): Promise<GateResult> {
  let report: RawGateReport;
  try {
    report = await verifier.verify(candidate, controlPlane);
  } catch (error) {
    return immutable({
      candidateId: candidate.id,
      status: "failed",
      authoritative: false,
      checks: [],
      reason: `Gate 执行异常：${safeMessage(error)}`,
    });
  }
  if (report.status !== "passed") {
    return immutable({
      candidateId: candidate.id,
      status: "failed",
      authoritative: report.authoritative,
      evidenceDigest: report.evidenceDigest,
      checks: [...report.checks],
      reason: report.reason ?? "至少一项权威检查未通过",
    });
  }
  if (!report.authoritative || !report.evidenceDigest) {
    return immutable({
      candidateId: candidate.id,
      status: "failed",
      authoritative: false,
      checks: [...report.checks],
      reason: "Gate 缺少权威证据，已按失败处理",
    });
  }
  try {
    assertSha256(report.evidenceDigest, "Gate Evidence");
  } catch (error) {
    return immutable({
      candidateId: candidate.id,
      status: "failed",
      authoritative: false,
      checks: [...report.checks],
      reason: safeMessage(error),
    });
  }
  if (report.checks.length === 0 || report.checks.some((check) => check.status !== "passed")) {
    return immutable({
      candidateId: candidate.id,
      status: "failed",
      authoritative: true,
      evidenceDigest: report.evidenceDigest,
      checks: [...report.checks],
      reason: "Gate 未返回完整的通过检查，已按失败处理",
    });
  }
  return immutable({
    candidateId: candidate.id,
    status: "passed",
    authoritative: true,
    evidenceDigest: report.evidenceDigest,
    checks: [...report.checks],
  });
}

function sandboxFailure(candidate: Candidate): GateResult {
  return immutable({
    candidateId: candidate.id,
    status: "failed",
    authoritative: false,
    checks: [],
    reason: "Sandbox 未强制生效或发生降级，已按失败处理",
  });
}

function resolveLimits(input?: Partial<CodingExecutionLimits>): CodingExecutionLimits {
  const limits = {
    maxRepairAttempts: input?.maxRepairAttempts ?? CODING_DEFAULT_LIMITS.maxRepairAttempts,
    maxDurationMs: input?.maxDurationMs ?? CODING_DEFAULT_LIMITS.maxDurationMs,
  };
  if (!Number.isSafeInteger(limits.maxRepairAttempts) || limits.maxRepairAttempts < 0
    || limits.maxRepairAttempts > CODING_DEFAULT_LIMITS.maxRepairAttempts) {
    throw new Error("修复次数必须在 0 到 3 之间");
  }
  if (!Number.isSafeInteger(limits.maxDurationMs) || limits.maxDurationMs < 1
    || limits.maxDurationMs > CODING_DEFAULT_LIMITS.maxDurationMs) {
    throw new Error("执行时长必须在 1 到 3600000 毫秒之间");
  }
  return immutable(limits);
}

function validateControlPlane(controlPlane: CodingControlPlaneCommitment): void {
  if (controlPlane.protocol !== "coding-v2") throw new Error("只接受 coding-v2 单轨协议");
  assertSha256(controlPlane.specDigest, "Spec");
  assertSha256(controlPlane.governanceDigest, "Governance");
  assertSha256(controlPlane.harnessDigest, "Harness");
  assertSha256(controlPlane.sandboxDigest, "Sandbox");
  assertSha256(controlPlane.repositoryIndexDigest, "仓库索引");
}

function outcome(
  input: ExecuteCodingInput,
  runnerId: string,
  limits: CodingExecutionLimits,
  candidates: readonly Candidate[],
  gates: readonly GateResult[],
  status: CodingExecutionStatus,
  evidence: CodeEvidence | undefined,
  detail: string,
  approval?: ApprovalDecision,
  deliverable?: CodeDeliverable,
): CodingExecutionResult {
  const nextStep = status === "needs_reconciliation"
    ? "核对外部执行结果，再选择终止、标记完成或创建新调用"
    : detail;
  return immutable({
    task: input.task,
    runnerId,
    status,
    candidates: [...candidates],
    gates: [...gates],
    evidence,
    approval: approval ?? (status === "waiting_approval" ? "pending" : undefined),
    deliverable,
    nextStep,
    limits,
    controlPlane: { ...input.controlPlane },
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function gateFeedback(gate: GateResult): string {
  const summaries = gate.checks
    .filter((check) => check.status !== "passed")
    .map((check) => `${check.id}: ${check.summary}`);
  return ["修复以下 Gate 失败，保持已批准的 Spec、Governance 和 Harness 不变：", ...summaries]
    .join("\n");
}

export interface CodingResultView {
  readonly task: Pick<CodingTask, "id" | "title"> & { readonly status: CodingExecutionStatus };
  readonly diff?: { readonly digest: string; readonly summary: string };
  readonly checks: readonly GateCheck[];
  readonly approval?: ApprovalDecision | "pending";
  readonly deliverable?: CodeDeliverable;
  readonly nextStep: string;
  readonly harness?: { readonly digest: string };
  readonly candidates?: readonly Candidate[];
  readonly budget?: CodingExecutionLimits;
}

export function presentCodingResult(
  result: CodingExecutionResult,
  options: { readonly advanced?: boolean } = {},
): CodingResultView {
  const candidate = result.candidates.at(-1);
  const gate = result.gates.at(-1);
  const base: CodingResultView = {
    task: { id: result.task.id, title: result.task.title, status: result.status },
    diff: candidate ? { digest: candidate.diffDigest, summary: candidate.summary } : undefined,
    checks: gate?.checks ?? [],
    approval: result.approval,
    deliverable: result.deliverable,
    nextStep: result.nextStep,
  };
  if (!options.advanced) return immutable(base);
  return immutable({
    ...base,
    harness: { digest: result.controlPlane.harnessDigest },
    candidates: [...result.candidates],
    budget: { ...result.limits },
  });
}
