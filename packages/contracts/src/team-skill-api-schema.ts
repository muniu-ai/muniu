// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const revision = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const version = { type: 'integer', minimum: 0 };
const object = (properties: JsonObject, optional: readonly string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, required: Object.keys(properties).filter(key => !optional.includes(key)), properties });
const array = (items: JsonObject, maxItems: number, minItems = 0): JsonObject => ({ type: 'array', items, minItems, maxItems });
const sourceRef = () => object({ namespace: text, resourceId: text, streamVersion: { ...version, minimum: 1 }, digest });
export function teamSkillRefSchema(): JsonObject { return object({ id: text, version: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' }, digest }); }
export function teamSkillVersionCreateSchema(): JsonObject {
  return object({ skillId: text, expectedStreamVersion: version, source: object({ goalId: text, planRevisionId: text, deliverySetId: text, deliveryDigest: digest }),
    title: text, description: { ...text, maxLength: 2000 }, roles: array(object({ nodeId: text, instructions: { ...text, maxLength: 4000 }, sourceRefs: array(sourceRef(), 20) }), 12) });
}
export function teamSkillEvaluationRegisterSchema(): JsonObject {
  return object({ expectedStreamVersion: { const: 0 }, skillRef: teamSkillRefSchema(), executionMode: { enum: ['measured', 'test_fixture'] }, baselineRevision: revision, candidateRevision: revision,
    configuration: object({ model: object({ provider: text, name: text, revision: text, parameters: object({ temperature: { type: 'number', minimum: 0, maximum: 2 } }) }), promptSha256: digest, policySha256: digest, materialsSha256: digest,
      budget: object({ revision: { const: 'budget-v1' }, maxTokens: { type: 'integer', minimum: 1 }, maxCostMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,29})$' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }) }) });
}
export function teamSkillEvaluationSubmitSchema(): JsonObject {
  const evidence = { oneOf: [object({ artifactRef: sourceRef(), artifactSha256: digest, method: { const: 'human' }, reviewer: text }), object({ artifactRef: sourceRef(), artifactSha256: digest, method: { const: 'deterministic' }, check: text })] };
  return object({ expectedStreamVersion: { ...version, minimum: 1 }, reportRef: sourceRef(), evidence: array(evidence, 2000, 1) });
}
export function teamSkillCommandSchema(): JsonObject {
  return { oneOf: [object({ expectedStreamVersion: version, command: { const: 'disable' } }), object({ expectedStreamVersion: version, command: { enum: ['enable', 'rollback'] }, skillRef: teamSkillRefSchema(), evaluationId: text, recommendationEnabled: { type: 'boolean' } })] };
}
