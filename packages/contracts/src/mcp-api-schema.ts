// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
export function mcpMutationSchema(operation: string): JsonObject | undefined {
  const text = { type: 'string', minLength: 1, maxLength: 2048 }, version = { type: 'integer', minimum: 1 };
  const object = (required: string[], properties: JsonObject): JsonObject => ({ type: 'object', additionalProperties: false, required, properties });
  const token = { type: 'string', minLength: 1, maxLength: 8192 };
  if (operation === 'createMcpConnection') return object(['expectedStreamVersion', 'label', 'endpoint', 'expiresAt', 'uriPrefixes', 'maxRequests'], {
    expectedStreamVersion: { const: 0 }, label: { ...text, maxLength: 120 }, endpoint: text, bearerToken: token, expiresAt: text,
    uriPrefixes: { type: 'array', minItems: 1, maxItems: 20, items: text }, maxRequests: { type: 'integer', minimum: 1, maximum: 1000 },
  });
  if (operation === 'commandMcpConnection') return object(['expectedStreamVersion', 'command'], { expectedStreamVersion: version, command: { enum: ['enable', 'disable', 'rotate_credential'] }, bearerToken: token });
  if (operation === 'createMcpRequest') return object(['expectedStreamVersion', 'kind'], { expectedStreamVersion: version, kind: { enum: ['resources', 'templates', 'read'] }, cursor: { ...text, maxLength: 4096 },
    selection: object(['catalogRequestId'], { catalogRequestId: text, uri: text, uriTemplate: text, variables: { type: 'object', maxProperties: 20, additionalProperties: { ...text, maxLength: 1024 } } }),
  });
}
