// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200 };
const version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
export const ENTERPRISE_ARTIFACT_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseExperienceDecision: object({ expectedStreamVersion: version, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, enabled: { type: 'boolean' } }),
  EnterpriseExperienceProposal: object({ id: text, title: text, text: { type: 'string', minLength: 1, maxLength: 200000 } }),
  EnterpriseExperienceView: object({ id: text, tenantId: text, workspaceId: text, streamVersion: version, artifactId: text, reference: ref('BusinessObjectRef'), status: { type: 'string', enum: ['proposed', 'enabled', 'disabled'] }, proposedBy: text, decidedBy: text, createdAt: { type: 'string', format: 'date-time' } }, ['decidedBy']),
  EnterpriseArtifactDecisionMaterial: object({ artifactId: text }),
  EnterpriseArtifactFreeze: object({ goalId: text, attemptId: text }),
  EnterpriseArtifactView: object({ id: text, tenantId: text, workspaceId: text, streamVersion: version, goalId: text, attemptId: text, reference: ref('BusinessObjectRef'), status: { type: 'string', enum: ['candidate', 'accepted'] }, title: text, decisionId: text, createdAt: { type: 'string', format: 'date-time' } }, ['decisionId']),
  EnterpriseArtifactAccept: object({ expectedStreamVersion: version, expectedGoalVersion: version, criteria: { type: 'array', items: text, minItems: 1, maxItems: 100, uniqueItems: true }, attestation: { type: 'string', minLength: 1, maxLength: 2000 } }),
};
