// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
export function followupMutationSchema(operation: string): JsonObject | undefined {
  const text = { type: 'string', minLength: 1, maxLength: 200 }, integer = { type: 'integer', minimum: 1 }, minor = { type: 'string', pattern: '^(0|[1-9][0-9]{0,15})$' }, currency = { type: 'string', pattern: '^[A-Z]{3}$' };
  const object = (required: string[], properties: JsonObject): JsonObject => ({ type: 'object', additionalProperties: false, required, properties });
  const ref = object(['namespace', 'resourceId', 'streamVersion', 'digest'], { namespace: text, resourceId: text, streamVersion: integer, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
  if (operation === 'commandFollowup') return object(['expectedStreamVersion', 'command'], { expectedStreamVersion: integer, command: { enum: ['pause', 'resume', 'stop'] } });
  if (operation !== 'createFollowup') return;
  return object(['expectedStreamVersion', 'parentGoalId', 'expectedGoalStreamVersion', 'parentPlanDigest', 'title', 'instruction', 'enabled', 'trigger', 'resourceRefs', 'modelBindingId', 'perRunBudget', 'periodBudget', 'maxRuns', 'expiresAt'], {
    expectedStreamVersion: { const: 0 }, parentGoalId: text, expectedGoalStreamVersion: integer, parentPlanDigest: text, title: text, instruction: { type: 'string', minLength: 1, maxLength: 4000 }, enabled: { const: true },
    trigger: object(['kind', 'sourceRef'], { kind: { const: 'business_changed' }, sourceRef: ref }), resourceRefs: { type: 'array', minItems: 1, maxItems: 100, items: ref }, modelBindingId: text,
    perRunBudget: object(['maxTokens', 'maxCostMinorUnits', 'currency', 'maxDurationMs'], { maxTokens: integer, maxCostMinorUnits: minor, currency, maxDurationMs: integer }),
    periodBudget: object(['periodMs', 'maxRuns', 'maxTokens', 'maxCostMinorUnits', 'currency'], { periodMs: { enum: [86400000, 604800000] }, maxRuns: { ...integer, maximum: 1000 }, maxTokens: integer, maxCostMinorUnits: minor, currency }),
    maxRuns: { ...integer, maximum: 1000 }, expiresAt: text,
  });
}
