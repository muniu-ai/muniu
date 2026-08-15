import {
  declarativeClone,
  deepFreeze,
  digestCanonical,
  exactFields,
  requireDigest,
  requireIdentifier,
  requirePositiveRevision,
  requireTimestamp
} from "./shared.js";

export type LearningProposalKind =
  | "standard_pack"
  | "spec_template"
  | "eval_asset"
  | "harness_profile";

export type LearningProposalStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "canary_passed"
  | "rejected"
  | "promoted"
  | "rolled_back";

export interface LearningProposalSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface LearningProposalReview {
  readonly actor: string;
  readonly decidedAt: string;
  readonly reason: string;
}

export interface LearningProposalCanary {
  readonly environment: string;
  readonly evidenceDigest: string;
  readonly completedAt: string;
  readonly completedBy: string;
}

export interface LearningProposalPromotion {
  readonly promotedAt: string;
  readonly promotedBy: string;
  readonly rollbackRef: string;
  readonly signature: LearningProposalSignature;
}

export interface LearningProposal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly kind: LearningProposalKind;
  readonly status: LearningProposalStatus;
  readonly title: string;
  readonly rationale: string;
  readonly sourceRunId: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly targetRef: string;
  readonly changeDigest: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly previousDigest?: string;
  readonly review?: LearningProposalReview;
  readonly canary?: LearningProposalCanary;
  readonly promotion?: LearningProposalPromotion;
  readonly rollbackReason?: string;
  readonly digest: string;
}

export interface CreateLearningProposalInput {
  readonly id: string;
  readonly kind: LearningProposalKind;
  readonly title: string;
  readonly rationale: string;
  readonly sourceRunId: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly targetRef: string;
  readonly changeDigest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface LearningProposalRegistryOptions {
  readonly verifySignature?: (input: {
    readonly proposal: LearningProposal;
    readonly rollbackRef: string;
    readonly signature: LearningProposalSignature;
  }) => boolean;
}

const KINDS = new Set<LearningProposalKind>([
  "standard_pack",
  "spec_template",
  "eval_asset",
  "harness_profile"
]);
const INPUT_FIELDS = new Set([
  "id",
  "kind",
  "title",
  "rationale",
  "sourceRunId",
  "sourceEvidenceIds",
  "targetRef",
  "changeDigest",
  "createdAt",
  "createdBy"
]);

export function createLearningProposal(
  input: CreateLearningProposalInput
): LearningProposal {
  const safe = declarativeClone(input) as unknown as Record<string, unknown>;
  exactFields(safe, INPUT_FIELDS, "learningProposal");
  if (!KINDS.has(safe.kind as LearningProposalKind)) {
    throw new TypeError("learningProposal.kind is unsupported");
  }
  if (!Array.isArray(safe.sourceEvidenceIds) || safe.sourceEvidenceIds.length === 0) {
    throw new TypeError("learningProposal.sourceEvidenceIds cannot be empty");
  }
  const evidenceIds = safe.sourceEvidenceIds.map((value, index) =>
    requireIdentifier(value, `learningProposal.sourceEvidenceIds[${index}]`)
  );
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new TypeError("learningProposal.sourceEvidenceIds must be unique");
  }
  const semantic = {
    schemaVersion: 1 as const,
    id: requireIdentifier(safe.id, "learningProposal.id"),
    revision: 1,
    kind: safe.kind as LearningProposalKind,
    status: "draft" as const,
    title: requireIdentifier(safe.title, "learningProposal.title"),
    rationale: requireIdentifier(safe.rationale, "learningProposal.rationale"),
    sourceRunId: requireIdentifier(safe.sourceRunId, "learningProposal.sourceRunId"),
    sourceEvidenceIds: evidenceIds.sort(),
    targetRef: requireIdentifier(safe.targetRef, "learningProposal.targetRef"),
    changeDigest: requireDigest(safe.changeDigest, "learningProposal.changeDigest"),
    createdAt: requireTimestamp(safe.createdAt, "learningProposal.createdAt"),
    createdBy: requireIdentifier(safe.createdBy, "learningProposal.createdBy")
  };
  return finalize(semantic);
}

export class LearningProposalRegistry {
  readonly #history = new Map<string, LearningProposal[]>();

  constructor(private readonly options: LearningProposalRegistryOptions = {}) {}

  create(input: CreateLearningProposalInput): LearningProposal {
    const proposal = createLearningProposal(input);
    if (this.#history.has(proposal.id)) throw new Error(`proposal ${proposal.id} exists`);
    this.#history.set(proposal.id, [proposal]);
    return proposal;
  }

  submit(id: string, actor: string, at: string): LearningProposal {
    return this.transition(id, "draft", "in_review", {
      review: {
        actor: requireIdentifier(actor, "review actor"),
        decidedAt: requireTimestamp(at, "review submittedAt"),
        reason: "Submitted for review"
      }
    });
  }

  review(input: {
    id: string;
    approved: boolean;
    actor: string;
    decidedAt: string;
    reason: string;
  }): LearningProposal {
    return this.transition(input.id, "in_review", input.approved ? "approved" : "rejected", {
      review: {
        actor: requireIdentifier(input.actor, "review actor"),
        decidedAt: requireTimestamp(input.decidedAt, "review decidedAt"),
        reason: requireIdentifier(input.reason, "review reason")
      }
    });
  }

  recordCanary(input: {
    id: string;
    passed: boolean;
    environment: string;
    evidenceDigest: string;
    completedAt: string;
    completedBy: string;
  }): LearningProposal {
    const canary = {
      environment: requireIdentifier(input.environment, "canary environment"),
      evidenceDigest: requireDigest(input.evidenceDigest, "canary evidenceDigest"),
      completedAt: requireTimestamp(input.completedAt, "canary completedAt"),
      completedBy: requireIdentifier(input.completedBy, "canary completedBy")
    };
    return this.transition(
      input.id,
      "approved",
      input.passed ? "canary_passed" : "rejected",
      { canary }
    );
  }

  promote(input: {
    id: string;
    promotedAt: string;
    promotedBy: string;
    rollbackRef: string;
    signature: LearningProposalSignature;
  }): LearningProposal {
    const signature = normalizeSignature(input.signature);
    const current = this.current(input.id);
    if (current.status !== "canary_passed") {
      throw new Error(`proposal ${input.id} must be canary_passed, not ${current.status}`);
    }
    const rollbackRef = requireIdentifier(input.rollbackRef, "promotion rollbackRef");
    if (
      typeof this.options.verifySignature !== "function" ||
      !this.options.verifySignature({ proposal: current, rollbackRef, signature })
    ) {
      throw new Error("learning proposal promotion signature is not trusted");
    }
    return this.transition(input.id, "canary_passed", "promoted", {
      promotion: {
        promotedAt: requireTimestamp(input.promotedAt, "promotion promotedAt"),
        promotedBy: requireIdentifier(input.promotedBy, "promotion promotedBy"),
        rollbackRef,
        signature
      }
    });
  }

  rollback(input: {
    id: string;
    actor: string;
    at: string;
    reason: string;
  }): LearningProposal {
    const current = this.current(input.id);
    if (current.status !== "promoted") throw new Error("only promoted proposals can roll back");
    return this.append(current, "rolled_back", {
      review: {
        actor: requireIdentifier(input.actor, "rollback actor"),
        decidedAt: requireTimestamp(input.at, "rollback at"),
        reason: requireIdentifier(input.reason, "rollback reason")
      },
      rollbackReason: requireIdentifier(input.reason, "rollback reason")
    });
  }

  get(id: string, revision?: number): LearningProposal | undefined {
    const history = this.#history.get(requireIdentifier(id, "proposal id"));
    if (!history) return undefined;
    if (revision === undefined) return history.at(-1);
    requirePositiveRevision(revision, "proposal revision");
    return history.find((proposal) => proposal.revision === revision);
  }

  list(): readonly LearningProposal[] {
    return deepFreeze(
      [...this.#history.values()]
        .map((history) => history.at(-1)!)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    );
  }

  private current(id: string): LearningProposal {
    const current = this.get(id);
    if (!current) throw new Error(`proposal ${id} does not exist`);
    return current;
  }

  private transition(
    id: string,
    expected: LearningProposalStatus,
    next: LearningProposalStatus,
    patch: Partial<LearningProposal>
  ): LearningProposal {
    const current = this.current(id);
    if (current.status !== expected) {
      throw new Error(`proposal ${id} must be ${expected}, not ${current.status}`);
    }
    return this.append(current, next, patch);
  }

  private append(
    current: LearningProposal,
    status: LearningProposalStatus,
    patch: Partial<LearningProposal>
  ): LearningProposal {
    const { digest: _digest, ...previous } = current;
    const semantic = declarativeClone({
      ...previous,
      ...patch,
      revision: current.revision + 1,
      status,
      previousDigest: current.digest
    });
    validateTransitionTimeline(current, semantic as Omit<LearningProposal, "digest">);
    const next = finalize(semantic as Omit<LearningProposal, "digest">);
    this.#history.get(current.id)!.push(next);
    return next;
  }
}

function normalizeSignature(value: LearningProposalSignature): LearningProposalSignature {
  const safe = declarativeClone(value) as unknown as Record<string, unknown>;
  exactFields(safe, new Set(["algorithm", "keyId", "value"]), "signature");
  if (safe.algorithm !== "ed25519") throw new TypeError("signature algorithm must be ed25519");
  return {
    algorithm: "ed25519",
    keyId: requireIdentifier(safe.keyId, "signature keyId"),
    value: requireIdentifier(safe.value, "signature value")
  };
}

function validateTransitionTimeline(
  current: LearningProposal,
  next: Omit<LearningProposal, "digest">
): void {
  const transitionTimes = [
    next.review?.decidedAt,
    next.canary?.completedAt,
    next.promotion?.promotedAt
  ].filter((value): value is string => value !== undefined);
  if (transitionTimes.some((value) => Date.parse(value) < Date.parse(current.createdAt))) {
    throw new TypeError("proposal transition cannot precede proposal creation");
  }
}

function finalize(
  semantic: Omit<LearningProposal, "digest">
): LearningProposal {
  return deepFreeze({ ...semantic, digest: digestCanonical(semantic) });
}
