// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
import { ENTERPRISE_OBJECT_TYPES } from './enterprise-object-types.js';
const text = { type: 'string', minLength: 1, maxLength: 200 };
const version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const timestamp = { type: 'string', format: 'date-time' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties,
  required: Object.keys(properties).filter(key => !optional.includes(key)) });
const list = (items: JsonObject): JsonObject => ({ type: 'array', items, minItems: 1, uniqueItems: true });
const role = { type: 'string', enum: ['sales', 'sales_manager', 'project_owner', 'finance', 'auditor'] };
const operation = { type: 'string', enum: ['read', 'draft', 'write', 'business_approve', 'execution_approve', 'audit'] };
const field = { type: 'string', enum: ['public', 'price', 'cost', 'contact'] };
const objectType = { type: 'string', enum: [...ENTERPRISE_OBJECT_TYPES] };
const base = { id: text, tenantId: text, workspaceId: text, streamVersion: version, revokedAt: timestamp };
const grant = { principalId: text, operations: list(operation), fieldClasses: list(field), expiresAt: timestamp };
const quotaProperties = {
  parallelNodes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  totalNodes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  totalAttempts: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  automaticReplans: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  tenantRunningNodes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  tokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  evaluationDailyTokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  singleEvaluationTokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  costMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,17})$' },
  evaluationDailyCostMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,17})$' },
  singleEvaluationCostMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,17})$' },
  currency: { const: 'CNY' }, validFrom: timestamp, expiresAt: timestamp,
};
export const ENTERPRISE_ACCESS_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseQuotaConfigure: object({ ...quotaProperties, expectedStreamVersion: { ...version, minimum: 0 } }),
  EnterpriseQuotaView: object({ ...quotaProperties, tenantId: text, workspaceId: text, streamVersion: version, capacityEvidenceDigest: text }, ['workspaceId', 'capacityEvidenceDigest']),
  EnterpriseQuotaConfiguration: object({ platform: { oneOf: [ref('EnterpriseQuotaView'), { type: 'null' }] }, workspace: { oneOf: [ref('EnterpriseQuotaView'), { type: 'null' }] } }),
  BusinessAccessScope: { oneOf: [object({ kind: { const: 'owned' } }), object({ kind: { const: 'workspace' } }),
    object({ kind: { const: 'department' }, departmentId: text }),
    object({ kind: { const: 'objects' }, objects: { ...list(object({ objectType, objectId: text })), maxItems: 200 } })] },
  EnterpriseDepartmentCreate: object({ name: text, parentId: text }, ['parentId']),
  EnterpriseDepartmentView: object({ ...base, name: text, parentId: text }, ['parentId', 'revokedAt']),
  BusinessRoleGrantCreate: object({ ...grant, role, scope: ref('BusinessAccessScope') }),
  BusinessRoleGrantView: object({ ...base, ...grant, role, scope: ref('BusinessAccessScope') }, ['revokedAt']),
  BusinessObjectGrantCreate: object({ ...grant, objectType, objectId: text }),
  BusinessObjectGrantView: object({ ...base, ...grant, objectType, objectId: text }, ['revokedAt']),
  EnterpriseAccessRevoke: object({ expectedStreamVersion: version }),
  EnterpriseAccessConfiguration: object({ departments: { type: 'array', items: ref('EnterpriseDepartmentView') }, roles: { type: 'array', items: ref('BusinessRoleGrantView') }, grants: { type: 'array', items: ref('BusinessObjectGrantView') } }),
};
