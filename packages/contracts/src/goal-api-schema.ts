// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from "./json.js";

export function goalMutationSchema(operationId: string): JsonObject | undefined {
  const string = { type: "string", minLength: 1, maxLength: 200 };
  const version = { type: "integer", minimum: 0 };
  const object = (required: readonly string[], properties: JsonObject): JsonObject => ({ type: "object", additionalProperties: false, required: [...required], properties });
  const array = (items: JsonObject, minItems = 0, maxItems = 100): JsonObject => ({ type: "array", items, minItems, maxItems });
  const base = { workspaceId: string, expectedStreamVersion: version };
  const resource = object(["namespace", "resourceId", "streamVersion"], { namespace: string, resourceId: string, streamVersion: version, digest: string });
  const criterion = object(["id", "description"], { id: string, description: { type: "string", minLength: 1, maxLength: 2000 } });
  if (operationId === "createGoal") return object(["threadId", "objective", "resourceRefs", "budget", "deliverables"], {
    threadId: string, objective: { type: "string", minLength: 1, maxLength: 16000 }, resourceRefs: array(resource),
    budget: object(["maxTokens", "maxCostMinorUnits", "currency", "maxDurationMs"], { maxTokens: { type: "integer", minimum: 1 }, maxCostMinorUnits: { type: "string", pattern: "^(0|[1-9][0-9]{0,23})$" }, currency: { type: "string", pattern: "^[A-Z]{3}$" }, maxDurationMs: { type: "integer", minimum: 1 } }),
    deliverables: array(object(["key", "title", "required", "criteria"], { key: string, title: string, required: { type: "boolean" }, criteria: array(criterion, 1, 20) }), 1, 20),
  });
  const minor = { type: "string", pattern: "^(0|[1-9][0-9]{0,17})$" };
  if (operationId === "proposeGoalPlan") return { oneOf: [
    object(["workspaceId", "expectedStreamVersion", "modelBindingId"], { ...base, modelBindingId: string }),
    object(["workspaceId", "expectedStreamVersion", "scheduling"], { ...base,
      scheduling: object(["runnerId", "strategy"], { runnerId: { enum: ["auto", "builtin", "codex-cli", "claude-cli"] }, strategy: { enum: ["quality", "balanced", "cost"] }, modelBindingId: string, expectedValueMinorUnits: minor, timeCostMinorUnitsPerHour: minor }),
    }),
    object(["workspaceId", "expectedStreamVersion", "kind", "templateId", "templateVersion", "modelBindingId"], { ...base,
      kind: { const: "team-v1" }, templateId: { enum: ["research-summary", "business-proposal", "code-delivery"] }, templateVersion: { const: "1" }, modelBindingId: string }),
  ] };
  if (operationId === "commandGoal") return { oneOf: [
    object(["workspaceId", "expectedStreamVersion", "command", "usage", "source"], { ...base, command: { const: "record_external_usage" }, source: { type: "string", minLength: 1, maxLength: 2000 }, usage: object(["tokens", "costMinorUnits", "currency"], { tokens: version, costMinorUnits: minor, currency: { type: "string", pattern: "^[A-Z]{3}$" } }) }),
    object(["workspaceId", "expectedStreamVersion", "command", "planRevisionId", "planDigest"], { ...base, command: { const: "start" }, planRevisionId: string, planDigest: string }),
    object(["workspaceId", "expectedStreamVersion", "command"], { ...base, command: { enum: ["refresh", "cancel", "pause", "resume"] } }),
    object(["workspaceId", "expectedStreamVersion", "command", "nodeId", "decision"], { ...base, command: { const: "decide" }, nodeId: string, decision: { enum: ["continue", "stop"] } }),
  ] };
  if (operationId === "acceptGoalDelivery") return object(["workspaceId", "expectedStreamVersion", "deliverySetId", "criteriaVersion", "items"], {
    ...base, deliverySetId: string, criteriaVersion: string,
    items: array(object(["key", "digest", "reviewedCriterionIds"], { key: string, digest: string, reviewedCriterionIds: array(string, 1, 20) }), 1, 20),
  });
  if (operationId === "decideGoalDelivery") return object(["workspaceId", "expectedStreamVersion", "deliverySetId", "criteriaVersion", "items"], {
    ...base, deliverySetId: string, criteriaVersion: string, items: array({ oneOf: [
      object(["key", "digest", "decision", "reviewedCriterionIds"], { key: string, digest: string, decision: { const: "accept" }, reviewedCriterionIds: array(string, 1, 20) }),
      object(["key", "digest", "decision", "failedCriterionIds", "instruction"], { key: string, digest: string, decision: { const: "request_changes" }, failedCriterionIds: array(string, 1, 20), instruction: { type: "string", minLength: 1, maxLength: 4000 } }),
      object(["key", "digest", "decision"], { key: string, digest: string, decision: { const: "defer" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }),
    ] }, 1, 20),
  });
  if (operationId === "previewGoalRework") return object(["workspaceId", "expectedStreamVersion", "decisionId"], { ...base, decisionId: string });
  if (operationId === "reworkGoal") return object(["workspaceId", "expectedStreamVersion", "previewId", "previewDigest"], { ...base, previewId: string, previewDigest: string });
  return undefined;
}
