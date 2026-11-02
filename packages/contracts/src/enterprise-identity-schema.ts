// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200 };
const integer = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const timestamp = { type: 'string', format: 'date-time' };
const bool = { type: 'boolean' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties).filter(key => !optional.includes(key)) });
export const ENTERPRISE_IDENTITY_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  OrganizationView: object({ id: text, name: text, issuer: text, maxMembers: integer, streamVersion: integer }),
  OrganizationList: { type: 'array', items: ref('OrganizationView') },
  OrganizationMemberView: object({ id: text, tenantId: text, issuer: text, subject: text, displayName: text, organizationAdmin: bool,
    status: { type: 'string', enum: ['invited', 'active', 'disabled', 'removed'] }, streamVersion: integer, sessionEpoch: integer, invitedUntil: timestamp }, ['invitedUntil']),
  OrganizationMemberList: { type: 'array', items: ref('OrganizationMemberView') },
  EnterpriseWorkspaceView: object({ id: text, tenantId: text, name: text, mode: { type: 'string', enum: ['builtin', 'sales'] }, streamVersion: integer }),
  EnterpriseWorkspaceList: { type: 'array', items: ref('EnterpriseWorkspaceView') },
  EnterpriseWorkspaceCreate: object({ name: text, mode: { type: 'string', enum: ['builtin', 'sales'] } }),
  OrganizationInvitationCreate: object({ subject: text, displayName: text, organizationAdmin: bool }),
  OrganizationInvitationView: object({ id: text, member: ref('OrganizationMemberView'), token: text }),
  OrganizationInvitationAccept: object({ expectedStreamVersion: integer, token: text }),
  OrganizationMemberCommand: { oneOf: [
    object({ expectedStreamVersion: integer, type: { type: 'string', enum: ['disable', 'activate', 'remove'] } }),
    object({ expectedStreamVersion: integer, type: { const: 'rebind' }, subject: text }),
  ] },
  EnterpriseSessionView: object({ tenantId: text, principalId: text, displayName: text,
    status: { type: 'string', enum: ['invited', 'active'] }, organizationAdmin: bool, csrfToken: text, expiresAt: timestamp,
    profile: { type: 'string', enum: ['development', 'hosted'] } }),
  EnterpriseHealthView: object({ status: { const: 'healthy' }, profile: { type: 'string', enum: ['development', 'hosted'] } }),
  EnterpriseApiError: object({ code: text, message: text, action: text, traceId: text, retryable: bool,
    fieldIssues: { type: 'array', items: object({ field: text, message: text }) } }),
};
