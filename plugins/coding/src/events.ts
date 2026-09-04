import type {
  Candidate,
  CodeEvidence,
  CodingWorkflowStage,
  GateResult,
} from "./domain.ts";

export interface CodingActor {
  readonly id: string;
  readonly kind: "human" | "agent" | "system";
}

interface CodingEventEnvelope<TType extends string, TPayload> {
  readonly eventId?: string;
  readonly type: TType;
  readonly actor: CodingActor;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export type RepositoryEvent = CodingEventEnvelope<"coding.repository_registered", {
  readonly name: string;
  readonly rootRealPath: string;
  readonly vcs: "git";
}>;

export type ServiceEvent = CodingEventEnvelope<"coding.service_registered", {
  readonly repositoryId: string;
  readonly name: string;
  readonly paths: readonly string[];
}>;

export type CodingTaskEvent =
  | CodingEventEnvelope<"coding.task_created", {
      readonly repositoryId: string;
      readonly title: string;
      readonly request: string;
    }>
  | CodingEventEnvelope<"coding.spec_recorded", {
      readonly specId: string;
      readonly title: string;
      readonly body: string;
      readonly acceptanceCriteria: readonly string[];
    }>
  | CodingEventEnvelope<"coding.spec_revised", {
      readonly previousSpecId: string;
      readonly specId: string;
      readonly title?: string;
      readonly body: string;
      readonly acceptanceCriteria?: readonly string[];
    }>
  | CodingEventEnvelope<"coding.task_advanced", { readonly nextStage: CodingWorkflowStage }>
  | CodingEventEnvelope<"coding.candidate_recorded", {
      readonly runnerId: string;
      readonly candidate: Omit<Candidate, "taskId" | "runnerId">;
    }>
  | CodingEventEnvelope<"coding.gate_result_recorded", { readonly gateResult: GateResult }>
  | CodingEventEnvelope<"coding.code_evidence_recorded", {
      readonly evidence: Omit<CodeEvidence, "taskId" | "digest">;
    }>;

export type CodingEvent = RepositoryEvent | ServiceEvent | CodingTaskEvent;

export type StoredCodingEvent<TEvent extends CodingEvent = CodingEvent> =
  TEvent extends CodingEvent
    ? TEvent & { readonly eventId: string; readonly streamVersion: number }
    : never;

export type StoredRepositoryEvent = StoredCodingEvent<RepositoryEvent>;
export type StoredServiceEvent = StoredCodingEvent<ServiceEvent>;
export type StoredCodingTaskEvent = StoredCodingEvent<CodingTaskEvent>;
