// SPDX-License-Identifier: Apache-2.0

export type ActorKind = "human" | "agent";

export interface Actor {
  readonly id: string;
  readonly kind: ActorKind;
}

export type OpportunityProgressState =
  | "captured"
  | "framed"
  | "researching"
  | "interviewing"
  | "evaluating"
  | "offer_ready"
  | "decided";

export type OpportunityState = OpportunityProgressState | "paused" | "abandoned";
export type EvidenceLevel = "none" | "interest" | "commitment" | "paid";
export type SignalRelationship = "support" | "oppose" | "neutral";
export type SignalSourceKind = "public_web" | "pasted" | "file" | "manual";
export type SignalEvidenceKind = "context" | "interest";

export interface Opportunity {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly rawCapture: string;
  readonly state: OpportunityState;
  readonly stateBeforePause?: OpportunityProgressState;
  readonly pauseReason?: string;
  readonly abandonmentReason?: string;
  readonly evidenceLevel: EvidenceLevel;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Hypothesis {
  readonly id: string;
  readonly opportunityId: string;
  readonly targetCustomer: string;
  readonly problem: string;
  readonly statement: string;
  readonly falsifiable: true;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface Signal {
  readonly id: string;
  readonly opportunityId: string;
  readonly sourceKind: SignalSourceKind;
  readonly sourceUrl?: string;
  readonly sourceAssetId?: string;
  readonly observedAt: string;
  readonly excerpt?: string;
  readonly summary: string;
  readonly relationship: SignalRelationship;
  readonly evidenceKind: SignalEvidenceKind;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface SignalInput {
  readonly sourceKind: SignalSourceKind;
  readonly sourceUrl?: string;
  readonly sourceAssetId?: string;
  readonly observedAt: string;
  readonly excerpt?: string;
  readonly summary: string;
  readonly relationship: SignalRelationship;
  readonly evidenceKind: SignalEvidenceKind;
}

export interface InterviewAnnotation {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly actorKind: ActorKind;
}

export interface Interview {
  readonly id: string;
  readonly opportunityId: string;
  readonly participantRef: string;
  readonly occurredAt: string;
  /** 原始记录只存于受保护 Asset；领域事件和投影仅保存不可变引用。 */
  readonly rawRecordAssetId: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly annotations: readonly InterviewAnnotation[];
}

export interface Experiment {
  readonly id: string;
  readonly opportunityId: string;
  readonly question: string;
  readonly method: string;
  readonly successCriterion: string;
  readonly outcome?: string;
  readonly status: "planned" | "completed";
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ExperimentInput {
  readonly question: string;
  readonly method: string;
  readonly successCriterion: string;
  readonly outcome?: string;
  readonly status: "planned" | "completed";
}

export type CommitmentEvidenceLevel = "commitment" | "paid";

export interface CommitmentEvidence {
  readonly id: string;
  readonly opportunityId: string;
  readonly level: CommitmentEvidenceLevel;
  readonly description: string;
  readonly sourceRef: string;
  readonly status: "proposed" | "confirmed";
  readonly proposedAt: string;
  readonly proposedBy: string;
  readonly confirmedAt?: string;
  readonly confirmedBy?: string;
}

export interface CommitmentEvidenceInput {
  readonly level: CommitmentEvidenceLevel;
  readonly description: string;
  readonly sourceRef: string;
}

export interface PriceAssumption {
  readonly amountMinor: string;
  readonly currency: string;
  readonly assumption: string;
}

export interface MinimumPaidOfferInput {
  readonly targetCustomer: string;
  readonly promisedOutcome: string;
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly price: PriceAssumption;
  readonly deliveryFormat: string;
  readonly duration: string;
  readonly acceptanceMethod: string;
  readonly nextCustomerAction: string;
  readonly risks: readonly string[];
}

export interface MinimumPaidOffer extends MinimumPaidOfferInput {
  readonly id: string;
  readonly opportunityId: string;
  readonly preparedAt: string;
  readonly preparedBy: string;
}

export type DecisionChoice = "pursue" | "revise" | "stop";

export interface Decision {
  readonly id: string;
  readonly opportunityId: string;
  readonly choice: DecisionChoice;
  readonly rationale: string;
  readonly decidedAt: string;
  readonly decidedBy: string;
}

export interface OpportunityAggregate extends Opportunity {
  readonly hypotheses: readonly Hypothesis[];
  readonly signals: readonly Signal[];
  readonly interviews: readonly Interview[];
  readonly experiments: readonly Experiment[];
  readonly commitmentEvidence: readonly CommitmentEvidence[];
  readonly minimumPaidOffer?: MinimumPaidOffer;
  readonly decision?: Decision;
}

export interface OpportunityCaptureDraft {
  readonly rawInput: string;
  readonly title: string;
  readonly targetCustomer?: string;
  readonly problem?: string;
  readonly falsifiableHypothesis?: string;
  readonly reviewRequired: true;
  readonly inferredFields: readonly ("title" | "targetCustomer" | "problem" | "falsifiableHypothesis")[];
}
