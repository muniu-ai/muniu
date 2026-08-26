// SPDX-License-Identifier: Apache-2.0

import type { BusinessPackManifestV1, VisitStateV1 } from "./types.js";

const ACTIVE_STATES: readonly VisitStateV1[] = [
  "draft",
  "prepared",
  "in_progress",
  "processing",
  "review_required",
  "confirmed",
  "writeback_pending"
];

const CORE_TRANSITIONS = [
  ["draft", "prepared"],
  ["prepared", "in_progress"],
  ["in_progress", "processing"],
  ["processing", "review_required"],
  ["review_required", "processing"],
  ["review_required", "confirmed"],
  ["confirmed", "writeback_pending"],
  ["confirmed", "completed"],
  ["writeback_pending", "completed"]
] as const;

const VISIT_TRANSITIONS = [
  ...CORE_TRANSITIONS,
  ...ACTIVE_STATES.flatMap((from) => [[from, "failed"], [from, "cancelled"]] as const)
] as const;

const TRANSITION_KEYS = new Set(VISIT_TRANSITIONS.map(([from, to]) => `${from}:${to}`));

export const VISIT_ASSISTANT_PACK_V1: BusinessPackManifestV1 = Object.freeze({
  schemaVersion: 1,
  id: "opc.visit-assistant",
  version: "1.0.0",
  domainId: "opc",
  recordSchemas: Object.freeze([
    "opc.visit.v1",
    "opc.visit-source.v1",
    "opc.visit-claim.v1",
    "opc.commitment.v1",
    "opc.next-action.v1",
    "opc.writeback-request.v1"
  ]),
  states: Object.freeze([
    ...ACTIVE_STATES,
    "completed",
    "failed",
    "cancelled"
  ]),
  transitions: Object.freeze(VISIT_TRANSITIONS.map(([from, to]) => Object.freeze({ from, to }))),
  workflows: Object.freeze(["opc.visit-assistant.v1"]),
  gates: Object.freeze(["opc.visit.source-trace.v1", "opc.visit.tenant-isolation.v1"]),
  approvalTemplates: Object.freeze(["opc.external-write.v1"]),
  connectors: Object.freeze(["dingtalk"]),
  renderers: Object.freeze(["opc.visit.review.v1"]),
  externalEffects: Object.freeze(["dingtalk.todo.create", "crm.record.write"]),
  acceptanceCases: Object.freeze([
    "opc.visit.confirmed-fields-have-sources",
    "opc.visit.external-write-requires-approval",
    "opc.visit.cross-tenant-source-is-rejected"
  ])
});

export function transitionVisitState(current: VisitStateV1, next: VisitStateV1): VisitStateV1 {
  if (!TRANSITION_KEYS.has(`${current}:${next}`)) {
    throw new Error(`invalid visit transition: ${current} -> ${next}`);
  }
  return next;
}
