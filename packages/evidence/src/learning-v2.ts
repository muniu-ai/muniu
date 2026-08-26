// SPDX-License-Identifier: Apache-2.0

import type {
  LearningProposalCanary,
  LearningProposalPromotion,
  LearningProposalReview,
  LearningProposalSignature,
  LearningProposalStatus
} from "./learning.js";
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

export type LearningProposalKindV2 =
  | "standard_pack"
  | "spec_template"
  | "eval_asset"
  | "harness_profile"
  | "business_pack"
  | "workflow"
  | "plugin_config";

export interface LearningProposalV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly revision: number;
  readonly kind: LearningProposalKindV2;
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

export interface CreateLearningProposalV2Input {
  readonly id: string;
  readonly kind: LearningProposalKindV2;
  readonly title: string;
  readonly rationale: string;
  readonly sourceRunId: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly targetRef: string;
  readonly changeDigest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface LearningProposalV2RegistryOptions {
  readonly verifySignature?: (input: {
    readonly proposal: LearningProposalV2;
    readonly rollbackRef: string;
    readonly signature: LearningProposalSignature;
  }) => boolean;
}

const KINDS = new Set<LearningProposalKindV2>([
  "standard_pack",
  "spec_template",
  "eval_asset",
  "harness_profile",
  "business_pack",
  "workflow",
  "plugin_config"
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

function finalize(semantic: Omit<LearningProposalV2, "digest">): LearningProposalV2 {
  return deepFreeze({ ...semantic, digest: digestCanonical(semantic) });
}

export function createLearningProposalV2(
  input: CreateLearningProposalV2Input
): LearningProposalV2 {
  const safe = declarativeClone(input) as unknown as Record<string, unknown>;
  exactFields(safe, INPUT_FIELDS, "learningProposalV2");
  if (!KINDS.has(safe.kind as LearningProposalKindV2)) {
    throw new TypeError("learningProposalV2.kind is unsupported");
  }
  if (!Array.isArray(safe.sourceEvidenceIds) || safe.sourceEvidenceIds.length === 0) {
    throw new TypeError("learningProposalV2.sourceEvidenceIds cannot be empty");
  }
  const sourceEvidenceIds = safe.sourceEvidenceIds.map((value, index) =>
    requireIdentifier(value, `learningProposalV2.sourceEvidenceIds[${index}]`)
  );
  if (new Set(sourceEvidenceIds).size !== sourceEvidenceIds.length) {
    throw new TypeError("learningProposalV2.sourceEvidenceIds must be unique");
  }
  return finalize({
    schemaVersion: 2,
    id: requireIdentifier(safe.id, "learningProposalV2.id"),
    revision: 1,
    kind: safe.kind as LearningProposalKindV2,
    status: "draft",
    title: requireIdentifier(safe.title, "learningProposalV2.title"),
    rationale: requireIdentifier(safe.rationale, "learningProposalV2.rationale"),
    sourceRunId: requireIdentifier(safe.sourceRunId, "learningProposalV2.sourceRunId"),
    sourceEvidenceIds: sourceEvidenceIds.sort(),
    targetRef: requireIdentifier(safe.targetRef, "learningProposalV2.targetRef"),
    changeDigest: requireDigest(safe.changeDigest, "learningProposalV2.changeDigest"),
    createdAt: requireTimestamp(safe.createdAt, "learningProposalV2.createdAt"),
    createdBy: requireIdentifier(safe.createdBy, "learningProposalV2.createdBy")
  });
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

export class LearningProposalV2Registry {
  readonly #history = new Map<string, LearningProposalV2[]>();

  constructor(private readonly options: LearningProposalV2RegistryOptions = {}) {}

  create(input: CreateLearningProposalV2Input): LearningProposalV2 {
    const proposal = createLearningProposalV2(input);
    if (this.#history.has(proposal.id)) throw new Error(`proposal ${proposal.id} exists`);
    this.#history.set(proposal.id, [proposal]);
    return proposal;
  }

  submit(id: string, actor: string, at: string): LearningProposalV2 {
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
  }): LearningProposalV2 {
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
  }): LearningProposalV2 {
    return this.transition(input.id, "approved", input.passed ? "canary_passed" : "rejected", {
      canary: {
        environment: requireIdentifier(input.environment, "canary environment"),
        evidenceDigest: requireDigest(input.evidenceDigest, "canary evidenceDigest"),
        completedAt: requireTimestamp(input.completedAt, "canary completedAt"),
        completedBy: requireIdentifier(input.completedBy, "canary completedBy")
      }
    });
  }

  promote(input: {
    id: string;
    promotedAt: string;
    promotedBy: string;
    rollbackRef: string;
    signature: LearningProposalSignature;
  }): LearningProposalV2 {
    const current = this.current(input.id);
    if (current.status !== "canary_passed") {
      throw new Error(`proposal ${input.id} must be canary_passed, not ${current.status}`);
    }
    const signature = normalizeSignature(input.signature);
    const rollbackRef = requireIdentifier(input.rollbackRef, "promotion rollbackRef");
    if (typeof this.options.verifySignature !== "function"
      || !this.options.verifySignature({ proposal: current, rollbackRef, signature })) {
      throw new Error("learning proposal V2 promotion signature is not trusted");
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

  rollback(input: { id: string; actor: string; at: string; reason: string }): LearningProposalV2 {
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

  get(id: string, revision?: number): LearningProposalV2 | undefined {
    const history = this.#history.get(requireIdentifier(id, "proposal id"));
    if (history === undefined) return undefined;
    if (revision === undefined) return history.at(-1);
    requirePositiveRevision(revision, "proposal revision");
    return history.find((proposal) => proposal.revision === revision);
  }

  list(): readonly LearningProposalV2[] {
    return deepFreeze([...this.#history.values()]
      .map((history) => history.at(-1)!)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  private current(id: string): LearningProposalV2 {
    const proposal = this.get(id);
    if (proposal === undefined) throw new Error(`proposal ${id} does not exist`);
    return proposal;
  }

  private transition(
    id: string,
    expected: LearningProposalStatus,
    next: LearningProposalStatus,
    patch: Partial<LearningProposalV2>
  ): LearningProposalV2 {
    const current = this.current(id);
    if (current.status !== expected) throw new Error(`proposal ${id} must be ${expected}, not ${current.status}`);
    return this.append(current, next, patch);
  }

  private append(
    current: LearningProposalV2,
    status: LearningProposalStatus,
    patch: Partial<LearningProposalV2>
  ): LearningProposalV2 {
    const { digest: _digest, ...previous } = current;
    const semantic = declarativeClone({
      ...previous,
      ...patch,
      revision: current.revision + 1,
      status,
      previousDigest: current.digest
    }) as Omit<LearningProposalV2, "digest">;
    const times = [semantic.review?.decidedAt, semantic.canary?.completedAt, semantic.promotion?.promotedAt]
      .filter((value): value is string => value !== undefined);
    if (times.some((value) => Date.parse(value) < Date.parse(current.createdAt))) {
      throw new TypeError("proposal transition cannot precede proposal creation");
    }
    const next = finalize(semantic);
    this.#history.get(current.id)!.push(next);
    return next;
  }
}
