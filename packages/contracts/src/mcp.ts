// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2 } from './goals.js';
export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;
export interface McpConnectionV2 {
  readonly id: string; readonly workspaceId: string; readonly label: string; readonly endpoint: string;
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION; readonly status: 'enabled' | 'disabled';
  readonly streamVersion: number; readonly digest: string; readonly credentialConfigured: boolean;
  readonly expiresAt: string; readonly uriPrefixes: readonly string[]; readonly maxRequests: number; readonly usedRequests: number;
  readonly allowedActions: { readonly request: boolean; readonly disable: boolean; readonly enable: boolean; readonly rotateCredential: boolean };
}
export interface CreateMcpConnectionV2 {
  readonly expectedStreamVersion: 0; readonly label: string; readonly endpoint: string; readonly bearerToken?: string;
  readonly expiresAt: string; readonly uriPrefixes: readonly string[]; readonly maxRequests: number;
}
export interface CommandMcpConnectionV2 { readonly expectedStreamVersion: number; readonly command: 'enable' | 'disable' | 'rotate_credential'; readonly bearerToken?: string }
export interface McpResourceV2 { readonly uri: string; readonly name: string; readonly title?: string; readonly description?: string; readonly mimeType?: string }
export interface McpResourceTemplateV2 { readonly uriTemplate: string; readonly name: string; readonly title?: string; readonly description?: string; readonly mimeType?: string; readonly supported: boolean }
export interface CreateMcpRequestV2 {
  readonly expectedStreamVersion: number; readonly kind: 'resources' | 'templates' | 'read'; readonly cursor?: string;
  readonly selection?: { readonly catalogRequestId: string; readonly uri?: string; readonly uriTemplate?: string; readonly variables?: Readonly<Record<string, string>> };
}
export interface McpRequestV2 {
  readonly id: string; readonly workspaceId: string; readonly connectionId: string; readonly streamVersion: number;
  readonly kind: CreateMcpRequestV2['kind']; readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'needs_reconciliation';
  readonly resources?: readonly McpResourceV2[]; readonly templates?: readonly McpResourceTemplateV2[];
  readonly nextCursor?: string; readonly assetRefs?: readonly GoalResourceRefV2[]; readonly reasonCode?: string;
}
