import { createHash } from "node:crypto";

export const CODING_WORKFLOW_STAGES = Object.freeze([
  "discover",
  "specify",
  "impact",
  "implement",
  "verify",
  "approve",
  "learn",
] as const);

export type CodingWorkflowStage = typeof CODING_WORKFLOW_STAGES[number];
export type CodingTaskStatus =
  | "active"
  | "waiting_approval"
  | "completed"
  | "needs_human_decision"
  | "needs_reconciliation"
  | "failed"
  | "cancelled";

export interface Repository {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly rootRealPath: string;
  readonly vcs: "git";
  readonly createdAt: string;
}

export interface Service {
  readonly id: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly paths: readonly string[];
}

export interface Spec {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
  readonly digest: string;
  readonly supersedesSpecId?: string;
  readonly createdAt: string;
}

export interface GovernanceSnapshot {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly rules: readonly string[];
  readonly createdAt: string;
}

export interface HarnessSnapshot {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly gateIds: readonly string[];
  readonly verifierIds: readonly string[];
  readonly createdAt: string;
}

export interface RepositoryIndexEntry {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly serviceIds?: readonly string[];
}

export interface RepositoryIndex {
  readonly entries: readonly RepositoryIndexEntry[];
  readonly digest: string;
}

export interface CodingTask {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly title: string;
  readonly request: string;
  readonly stage: CodingWorkflowStage;
  readonly status: CodingTaskStatus;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SandboxEvidence {
  readonly enforced: boolean;
  readonly fallbackUsed: boolean;
  readonly evidenceDigest?: string;
}

export interface Candidate {
  readonly id: string;
  readonly taskId: string;
  readonly runnerId: string;
  readonly sequence: number;
  readonly baseRevision: string;
  readonly diffDigest: string;
  readonly summary: string;
  readonly sandbox: SandboxEvidence;
}

export interface GateCheck {
  readonly id: string;
  readonly status: "passed" | "failed" | "error" | "missing";
  readonly summary: string;
}

export interface GateResult {
  readonly candidateId: string;
  readonly status: "passed" | "failed";
  readonly authoritative: boolean;
  readonly evidenceDigest?: string;
  readonly checks: readonly GateCheck[];
  readonly reason?: string;
}

export interface CodeEvidence {
  readonly taskId: string;
  readonly candidateId: string;
  readonly runnerId: string;
  readonly specDigest: string;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly sandboxDigest: string;
  readonly repositoryIndexDigest: string;
  readonly gateEvidenceDigest: string;
  readonly diffDigest: string;
  readonly digest: string;
}

export interface CreateSpecInput {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
  readonly createdAt: string;
}

export function createSpec(input: CreateSpecInput): Spec {
  requireText(input.id, "Spec ID");
  requireText(input.taskId, "任务 ID");
  requireText(input.title, "Spec 标题");
  requireText(input.body, "Spec 内容");
  if (input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.some((item) => !item.trim())) {
    throw new Error("Spec 必须包含可检查的验收条件");
  }
  return immutable({
    ...input,
    acceptanceCriteria: [...input.acceptanceCriteria],
    revision: 1,
    digest: digest({
      taskId: input.taskId,
      title: input.title,
      body: input.body,
      acceptanceCriteria: input.acceptanceCriteria,
    }),
  });
}

export function reviseSpec(
  previous: Spec,
  input: Pick<CreateSpecInput, "id" | "body" | "createdAt"> &
    Partial<Pick<CreateSpecInput, "title" | "acceptanceCriteria">>,
): Spec {
  if (input.id === previous.id) throw new Error("Spec 修订必须使用新的 ID");
  return immutable({
    id: input.id,
    taskId: previous.taskId,
    revision: previous.revision + 1,
    title: input.title ?? previous.title,
    body: input.body,
    acceptanceCriteria: [...(input.acceptanceCriteria ?? previous.acceptanceCriteria)],
    supersedesSpecId: previous.id,
    createdAt: input.createdAt,
    digest: digest({
      taskId: previous.taskId,
      title: input.title ?? previous.title,
      body: input.body,
      acceptanceCriteria: input.acceptanceCriteria ?? previous.acceptanceCriteria,
      revision: previous.revision + 1,
      supersedesSpecId: previous.id,
    }),
  });
}

export function createGovernanceSnapshot(input: Omit<GovernanceSnapshot, "digest">): GovernanceSnapshot {
  if (input.rules.length === 0) throw new Error("Governance 快照不能为空");
  return immutable({ ...input, rules: [...input.rules], digest: digest(input) });
}

export function createHarnessSnapshot(input: Omit<HarnessSnapshot, "digest">): HarnessSnapshot {
  if (input.gateIds.length === 0 || input.verifierIds.length === 0) {
    throw new Error("Harness 快照必须固定 Gate 和 Verifier");
  }
  return immutable({
    ...input,
    gateIds: [...input.gateIds],
    verifierIds: [...input.verifierIds],
    digest: digest(input),
  });
}

export function buildRepositoryIndex(entries: readonly RepositoryIndexEntry[]): RepositoryIndex {
  const seen = new Set<string>();
  const normalized = entries.map((entry) => {
    assertRepositoryRelativePath(entry.path);
    assertSha256(entry.digest, `仓库文件 ${entry.path}`);
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new Error(`仓库文件 ${entry.path} 大小无效`);
    }
    if (seen.has(entry.path)) throw new Error(`仓库索引包含重复路径 ${entry.path}`);
    seen.add(entry.path);
    return {
      ...entry,
      serviceIds: entry.serviceIds ? [...entry.serviceIds].sort() : undefined,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return immutable({ entries: normalized, digest: digest(normalized) });
}

export interface CreateCodingTaskInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly title: string;
  readonly request: string;
  readonly createdAt: string;
}

export function createCodingTask(input: CreateCodingTaskInput): CodingTask {
  requireText(input.id, "任务 ID");
  requireText(input.workspaceId, "工作区 ID");
  requireText(input.repositoryId, "仓库 ID");
  requireText(input.title, "任务标题");
  requireText(input.request, "任务请求");
  return immutable({
    ...input,
    stage: "discover",
    status: "active",
    streamVersion: 0,
    updatedAt: input.createdAt,
  });
}

export function advanceCodingTask(
  task: CodingTask,
  nextStage: CodingWorkflowStage,
  updatedAt: string,
): CodingTask {
  const currentIndex = CODING_WORKFLOW_STAGES.indexOf(task.stage);
  const nextIndex = CODING_WORKFLOW_STAGES.indexOf(nextStage);
  if (nextIndex !== currentIndex + 1) {
    throw new Error(`Coding 工作流不能从 ${task.stage} 跳转到 ${nextStage}`);
  }
  return immutable({
    ...task,
    stage: nextStage,
    streamVersion: task.streamVersion + 1,
    updatedAt,
  });
}

export function createCandidate(
  taskId: string,
  runnerId: string,
  input: Omit<Candidate, "taskId" | "runnerId">,
): Candidate {
  assertSha256(input.diffDigest, "候选 Diff");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("候选序号无效");
  return immutable({
    ...input,
    sandbox: { ...input.sandbox },
    taskId,
    runnerId,
  });
}

export function createCodeEvidence(input: Omit<CodeEvidence, "digest">): CodeEvidence {
  for (const [label, value] of [
    ["Spec", input.specDigest],
    ["Governance", input.governanceDigest],
    ["Harness", input.harnessDigest],
    ["Sandbox", input.sandboxDigest],
    ["仓库索引", input.repositoryIndexDigest],
    ["Gate Evidence", input.gateEvidenceDigest],
    ["Diff", input.diffDigest],
  ] as const) assertSha256(value, label);
  return immutable({ ...input, digest: digest(input) });
}

export function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} 摘要必须是 SHA-256`);
}

function assertRepositoryRelativePath(path: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")
    || /^[A-Za-z]:/u.test(path)
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`仓库相对路径无效：${path}`);
  }
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} 不能为空`);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function immutable<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  return Object.freeze(value);
}
