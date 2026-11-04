// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...count, minimum: 1 };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
const list = (items: JsonObject, minItems = 0, maxItems = 100): JsonObject => ({ type: 'array', items, minItems, maxItems, uniqueItems: true });
const classification = list({ type: 'string', enum: ['public', 'price', 'cost', 'contact'] }, 1, 4);
const locator = object({ page: positive, paragraph: positive, sheet: text, cell: text, row: positive, column: positive, part: { type: 'string', maxLength: 4000 } }, ['page', 'paragraph', 'sheet', 'cell', 'row', 'column', 'part']);
export const ENTERPRISE_KNOWLEDGE_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseDocumentImport: object({ documentId: text, expectedStreamVersion: count, title: text, fileName: text, mediaType: text, contentBase64: { type: 'string', minLength: 1, maxLength: 12 * 1024 * 1024 }, bindings: list(ref('EnterpriseSourceScope'), 1), classification, visibility: { type: 'string', enum: ['private', 'business_scope'] } }),
  EnterpriseKnowledgeDocumentState: object({ documentId: text, streamVersion: positive, status: { type: 'string', enum: ['active', 'withdrawn'] } }),
  EnterpriseKnowledgeShare: object({ reference: ref('BusinessObjectRef'), expectedStreamVersion: positive, enabled: { type: 'boolean' } }),
  EnterpriseKnowledgeSharing: object({ documentId: text, streamVersion: positive, shared: { type: 'boolean' } }),
  EnterpriseKnowledgeExport: object({ reference: ref('BusinessObjectRef'), format: { type: 'string', enum: ['docx', 'pdf', 'xlsx'] } }),
  EnterpriseKnowledgeExportResult: object({ reference: ref('BusinessObjectRef'), mediaType: text, bytesBase64: { type: 'string', minLength: 1 } }),
  EnterpriseKnowledgeControl: object({ expectedStreamVersion: positive }),
  EnterpriseKnowledgeBlock: object({ id: text, text: { type: 'string', minLength: 1, maxLength: 20000 }, locator }),
  EnterpriseKnowledgeExtraction: object({ extractorVersion: { const: '1' }, status: { type: 'string', enum: ['complete', 'partial', 'unreadable'] }, blocks: list(ref('EnterpriseKnowledgeBlock'), 0, 10000), issues: list(object({ code: text, message: { type: 'string', minLength: 1, maxLength: 2000 }, locator }, ['locator']), 0, 10000) }),
  EnterpriseKnowledgeView: object({ reference: ref('BusinessObjectRef'), documentId: text, revision: positive, title: text, sourceKind: { type: 'string', enum: ['raw_material', 'business_fact', 'human_decision', 'candidate_experience'] }, classification, sources: list(ref('EnterpriseSourceScope'), 1), extraction: ref('EnterpriseKnowledgeExtraction'), createdAt: { type: 'string', format: 'date-time' } }),
  EnterpriseKnowledgeSearch: object({ query: { type: 'string', minLength: 1, maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['limit']),
  EnterpriseKnowledgeSearchResult: object({ hits: list(object({ reference: ref('BusinessObjectRef'), title: text, text: { type: 'string', minLength: 1, maxLength: 20000 }, citation: ref('EvidenceRef') }), 0, 50) }),
  EnterpriseKnowledgeCitation: object({ reference: ref('BusinessObjectRef'), title: text, text: { type: 'string', minLength: 1, maxLength: 20000 }, citation: ref('EvidenceRef') }),
};
