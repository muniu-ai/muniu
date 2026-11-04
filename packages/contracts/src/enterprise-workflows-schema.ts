// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200 }, positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
const list = (items: JsonObject, minItems = 1, maxItems = 100): JsonObject => ({ type: 'array', items, minItems, maxItems, uniqueItems: true });
const flowId = { type: 'string', enum: ['opportunity', 'quote', 'delivery', 'receivable', 'review'] };
export const ENTERPRISE_WORKFLOW_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseWorkflowRef: object({ id: flowId, version: positive, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } }),
  EnterpriseWorkflowDefinition: object({ flowId, title: text, sourceTypes: list(text), acceptanceCriteria: list(text), humanDecisions: list(text), stages: list(object({ id: text, capabilityId: { type: 'string', enum: ['business.analyze', 'business.review', 'business.summarize'] }, instruction: { type: 'string', minLength: 1, maxLength: 4000 } }), 1, 40) }),
  EnterpriseWorkflowState: object({ id: text, tenantId: text, workspaceId: text, streamVersion: positive, flowId, versions: list(ref('EnterpriseWorkflowRef')), active: ref('EnterpriseWorkflowRef') }, ['active']),
  EnterpriseWorkflowVersion: object({ reference: ref('EnterpriseWorkflowRef'), definition: ref('EnterpriseWorkflowDefinition') }),
  EnterpriseWorkflowCatalog: object({ builtins: list(ref('EnterpriseWorkflowDefinition'), 5, 5), states: list(ref('EnterpriseWorkflowState'), 0, 5) }),
  EnterpriseWorkflowPublish: object({ expectedStreamVersion: { ...positive, minimum: 0 }, definition: ref('EnterpriseWorkflowDefinition') }),
  EnterpriseWorkflowSelect: object({ expectedStreamVersion: positive, reference: { oneOf: [ref('EnterpriseWorkflowRef'), { type: 'null' }] } }),
};
