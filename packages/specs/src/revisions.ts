import {
  canonicalJson,
  digestSpecRevision,
  sha256Digest
} from "./canonical.js";
import type {
  ApproveSpecRevisionInput,
  LegacySpecRevisionInput,
  NextSpecRevisionChanges,
  SpecContracts,
  SpecRevision,
  SpecRevisionContent
} from "./types.js";
import { isStrictTimestamp, validateSpecRevision } from "./validation.js";

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function emptyContracts(): SpecContracts {
  return {
    interface: {},
    data: {},
    state: {},
    permission: {},
    exception: {},
    quality: {},
    observability: {}
  };
}

function ensureValid(revision: SpecRevision, operation: string): void {
  const validation = validateSpecRevision(revision);
  if (!validation.valid) {
    const details = validation.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    throw new TypeError(`${operation} produced an invalid revision: ${details}`);
  }
}

function defaultLegacyTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "Legacy task").slice(0, 120);
}

function legacySpecSetIdentity(input: LegacySpecRevisionInput): string {
  const taskId = input.taskId?.trim();
  if (taskId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(taskId)) {
    return taskId;
  }
  return sha256Digest({
    ...(taskId ? { taskId } : {}),
    prompt: input.prompt.trim(),
    acceptanceCriteria: input.acceptanceCriteria.map((criterion) => criterion.trim())
  }).slice(0, 24);
}

export function createLegacySpecRevision(
  input: LegacySpecRevisionInput
): SpecRevision {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new TypeError("Legacy prompt must be a non-empty string");
  }

  const acceptanceCriteria = input.acceptanceCriteria
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0);
  if (acceptanceCriteria.length === 0) {
    throw new TypeError("Legacy acceptance criteria must contain at least one item");
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const identity = legacySpecSetIdentity(input);
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: `legacy-${identity}`,
    revision: 1,
    status: "approved",
    source: "legacy",
    title: input.title?.trim() || defaultLegacyTitle(prompt),
    hypothesis: prompt,
    outcomes: [...acceptanceCriteria],
    nonGoals: [
      "Do not infer scope beyond the legacy prompt and acceptance criteria."
    ],
    targetServices: [...(input.targetServices ?? [])],
    contracts: emptyContracts(),
    acceptanceCases: acceptanceCriteria.map((criterion, index) => ({
      id: `legacy-acceptance-${index + 1}`,
      kind: "positive",
      title: criterion,
      given: ["The legacy task prompt is available."],
      when: prompt,
      then: [criterion]
    })),
    risks: [],
    unknowns: [],
    createdAt,
    createdBy: input.createdBy?.trim() || "legacy-adapter",
    approvedAt: createdAt,
    approvedBy: "legacy-adapter"
  };
  const revision: SpecRevision = {
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  };
  ensureValid(revision, "Legacy adapter");
  return deepFreeze(revision);
}

function selectContent(
  current: SpecRevision,
  changes: NextSpecRevisionChanges
): SpecRevisionContent {
  return cloneJsonValue({
    title: changes.title ?? current.title,
    hypothesis: changes.hypothesis ?? current.hypothesis,
    outcomes: changes.outcomes ?? current.outcomes,
    nonGoals: changes.nonGoals ?? current.nonGoals,
    targetServices: changes.targetServices ?? current.targetServices,
    contracts: changes.contracts ?? current.contracts,
    acceptanceCases: changes.acceptanceCases ?? current.acceptanceCases,
    risks: changes.risks ?? current.risks,
    unknowns: changes.unknowns ?? current.unknowns
  });
}

function revisionEventFloor(revision: SpecRevision): number {
  const createdAt = Date.parse(revision.createdAt);
  const approvedAt =
    revision.approvedAt === undefined ? createdAt : Date.parse(revision.approvedAt);
  return Math.max(createdAt, approvedAt);
}

export function createNextSpecRevision(
  current: SpecRevision,
  changes: NextSpecRevisionChanges = {}
): SpecRevision {
  const currentValidation = validateSpecRevision(current);
  if (!currentValidation.valid) {
    throw new TypeError("Cannot create a revision from an invalid predecessor");
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Spec revision cannot exceed Number.MAX_SAFE_INTEGER");
  }

  const createdAt = changes.createdAt ?? new Date().toISOString();
  if (
    !isStrictTimestamp(createdAt) ||
    !isStrictTimestamp(current.createdAt) ||
    (current.approvedAt !== undefined && !isStrictTimestamp(current.approvedAt)) ||
    Date.parse(createdAt) < revisionEventFloor(current)
  ) {
    throw new TypeError(
      "Next revision createdAt must be a strict timestamp at or after the predecessor event floor"
    );
  }
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: current.specSetId,
    revision: current.revision + 1,
    status: "draft",
    source: current.source,
    ...selectContent(current, changes),
    createdAt,
    createdBy: changes.createdBy?.trim() || current.createdBy
  };
  const next: SpecRevision = {
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  };
  ensureValid(next, "Next revision factory");
  return deepFreeze(next);
}

export function approveSpecRevision(
  predecessor: SpecRevision,
  input: ApproveSpecRevisionInput
): SpecRevision {
  const approvedBy = input.approvedBy.trim();
  if (approvedBy.length === 0) {
    throw new TypeError("approvedBy must be a non-empty string");
  }
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  const approvedTimestamp = Date.parse(approvedAt);
  const predecessorTimestamp = revisionEventFloor(predecessor);
  if (
    !isStrictTimestamp(approvedAt) ||
    !isStrictTimestamp(predecessor.createdAt) ||
    (predecessor.approvedAt !== undefined &&
      !isStrictTimestamp(predecessor.approvedAt)) ||
    approvedTimestamp < predecessorTimestamp
  ) {
    throw new TypeError(
      "approvedAt must be a valid timestamp at or after the predecessor event floor"
    );
  }
  const draft = createNextSpecRevision(predecessor, {
    createdAt: approvedAt,
    createdBy: input.createdBy?.trim() || approvedBy
  });
  const { digest: _draftDigest, ...draftContent } = draft;
  const unsigned: Omit<SpecRevision, "digest"> = {
    ...draftContent,
    status: "approved",
    approvedAt,
    approvedBy
  };
  const approved: SpecRevision = {
    ...unsigned,
    digest: digestSpecRevision(unsigned)
  };
  ensureValid(approved, "Approval");
  return deepFreeze(approved);
}
