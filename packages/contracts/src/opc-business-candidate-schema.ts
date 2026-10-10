// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from "./json.js";
const text: JsonObject = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" };
const digest: JsonObject = { type: "string", pattern: "^[a-f0-9]{64}$" };
const version: JsonObject = { type: "integer", minimum: 0 };
const object = (properties: JsonObject): JsonObject => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export function opcBusinessCandidateCreateSchema(): JsonObject {
  return object({ workspaceId: text, expectedStreamVersion: { const: 0 }, proposalKey: { ...text, maxLength: 100 },
    origin: object({ goalId: text, planRevisionId: text, deliverySetId: text, outputKey: text, outputDigest: digest }) });
}
export function opcBusinessCandidateDecisionSchema(): JsonObject {
  return object({ workspaceId: text, expectedStreamVersion: { ...version, minimum: 1 }, expectedBusinessStreamVersion: version,
    candidateDigest: digest, previewDigest: digest, decision: { enum: ["apply", "reject"] } });
}
