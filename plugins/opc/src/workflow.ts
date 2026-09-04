import type { WorkflowDefinitionV1 } from "@mn/contracts";
import type { OpportunityProgressState, OpportunityState } from "./model.js";

export const OPC_OPPORTUNITY_WORKFLOW: WorkflowDefinitionV1 = Object.freeze({
  schemaVersion: 1,
  id: "opc.opportunity-validation",
  version: "0.2.0",
  initialState: "captured",
  states: [
    { id: "captured" },
    { id: "framed" },
    { id: "researching" },
    { id: "interviewing" },
    { id: "evaluating" },
    { id: "offer_ready" },
    { id: "decided", terminal: true },
    { id: "paused" },
    { id: "abandoned", terminal: true },
  ],
  transitions: [
    {
      from: "captured",
      event: "frame",
      to: "framed",
      requiredFields: ["targetCustomer", "problem", "falsifiableHypothesis"],
    },
    { from: "framed", event: "start_research", to: "researching" },
    { from: "researching", event: "start_interviewing", to: "interviewing" },
    { from: "interviewing", event: "start_evaluation", to: "evaluating" },
    {
      from: "evaluating",
      event: "prepare_offer",
      to: "offer_ready",
      requiredFields: [
        "targetCustomer",
        "promisedOutcome",
        "inScope",
        "outOfScope",
        "price",
        "deliveryFormat",
        "duration",
        "acceptanceMethod",
        "nextCustomerAction",
        "risks",
      ],
    },
    { from: "offer_ready", event: "decide", to: "decided", humanOnly: true },
    { from: "captured", event: "pause", to: "paused" },
    { from: "framed", event: "pause", to: "paused" },
    { from: "researching", event: "pause", to: "paused" },
    { from: "interviewing", event: "pause", to: "paused" },
    { from: "evaluating", event: "pause", to: "paused" },
    { from: "offer_ready", event: "pause", to: "paused" },
    { from: "captured", event: "abandon", to: "abandoned" },
    { from: "framed", event: "abandon", to: "abandoned" },
    { from: "researching", event: "abandon", to: "abandoned" },
    { from: "interviewing", event: "abandon", to: "abandoned" },
    { from: "evaluating", event: "abandon", to: "abandoned" },
    { from: "offer_ready", event: "abandon", to: "abandoned" },
    { from: "paused", event: "resume_captured", to: "captured" },
    { from: "paused", event: "resume_framed", to: "framed" },
    { from: "paused", event: "resume_researching", to: "researching" },
    { from: "paused", event: "resume_interviewing", to: "interviewing" },
    { from: "paused", event: "resume_evaluating", to: "evaluating" },
    { from: "paused", event: "resume_offer_ready", to: "offer_ready" },
    { from: "paused", event: "abandon", to: "abandoned" },
  ],
});

const ACTIVE_STATES = new Set<OpportunityProgressState>([
  "captured",
  "framed",
  "researching",
  "interviewing",
  "evaluating",
  "offer_ready",
]);

export function isPausableState(state: OpportunityState): state is OpportunityProgressState {
  return ACTIVE_STATES.has(state as OpportunityProgressState);
}
