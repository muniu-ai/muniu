import type {
  Actor,
  CommitmentEvidenceInput,
  DecisionChoice,
  ExperimentInput,
  MinimumPaidOfferInput,
  OpportunityProgressState,
  SignalInput,
} from "./model.js";

interface OpcEventEnvelope<TType extends string, TPayload> {
  readonly eventId?: string;
  readonly type: TType;
  readonly actor: Actor;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export type OpcEvent =
  | OpcEventEnvelope<"opportunity.captured", { readonly title: string; readonly rawInput: string }>
  | OpcEventEnvelope<"opportunity.framed", {
      readonly hypothesisId: string;
      readonly targetCustomer: string;
      readonly problem: string;
      readonly falsifiableHypothesis: string;
    }>
  | OpcEventEnvelope<"opportunity.research_started", Record<string, never>>
  | OpcEventEnvelope<"opportunity.signal_recorded", { readonly signalId: string; readonly signal: SignalInput }>
  | OpcEventEnvelope<"opportunity.interviewing_started", Record<string, never>>
  | OpcEventEnvelope<"opportunity.interview_recorded", {
      readonly interviewId: string;
      readonly participantRef: string;
      readonly interviewOccurredAt: string;
      readonly rawRecord: string;
    }>
  | OpcEventEnvelope<"opportunity.interview_annotated", {
      readonly interviewId: string;
      readonly annotationId: string;
      readonly text: string;
    }>
  | OpcEventEnvelope<"opportunity.evaluation_started", Record<string, never>>
  | OpcEventEnvelope<"opportunity.experiment_recorded", { readonly experimentId: string; readonly experiment: ExperimentInput }>
  | OpcEventEnvelope<"opportunity.commitment_evidence_proposed", {
      readonly evidenceId: string;
      readonly evidence: CommitmentEvidenceInput;
    }>
  | OpcEventEnvelope<"opportunity.commitment_evidence_confirmed", { readonly evidenceId: string }>
  | OpcEventEnvelope<"opportunity.offer_prepared", { readonly offerId: string; readonly offer: MinimumPaidOfferInput }>
  | OpcEventEnvelope<"opportunity.decided", {
      readonly decisionId: string;
      readonly choice: DecisionChoice;
      readonly rationale: string;
    }>
  | OpcEventEnvelope<"opportunity.paused", { readonly previousState: OpportunityProgressState; readonly reason: string }>
  | OpcEventEnvelope<"opportunity.resumed", { readonly resumedState: OpportunityProgressState }>
  | OpcEventEnvelope<"opportunity.abandoned", { readonly reason: string }>;

export type StoredOpcEvent = OpcEvent & {
  readonly eventId: string;
  readonly streamVersion: number;
};
