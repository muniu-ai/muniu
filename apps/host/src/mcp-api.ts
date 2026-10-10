// SPDX-License-Identifier: Apache-2.0
import { readBoundedJsonBody } from './http-body.js';
import { commandMcpConnection, createMcpConnection, createMcpRequest, getMcpRequest, listMcpConnections, listMcpRequests, type McpOptions } from './mcp-resources.js';
import { mcpFail } from './mcp-sources.js';
export async function dispatchMcpRequest(options: McpOptions & { readonly request: Request; readonly tenantId: string; readonly principalId: string; readonly mutationKey?: string }): Promise<{ readonly status: number; readonly data: unknown } | undefined> {
  const url = new URL(options.request.url), match = /^\/v2\/workspaces\/([^/]+)\/mcp\/(connections(?:\/([^/]+)\/(commands|requests))?|requests(?:\/([^/]+))?)$/u.exec(url.pathname);
  if (!match) return;
  if (url.searchParams.size) mcpFail('MCP_REQUEST_INVALID');
  const scope = { tenantId: options.tenantId, principalId: options.principalId, workspaceId: decodeURIComponent(match[1]!) };
  if (options.request.method === 'GET') {
    if (match[2] === 'connections') return { status: 200, data: await listMcpConnections(options, scope) };
    if (match[2] === 'requests') return { status: 200, data: await listMcpRequests(options, scope) };
    if (match[5]) return { status: 200, data: await getMcpRequest(options, scope, decodeURIComponent(match[5])) };
    return;
  }
  if (options.request.method !== 'POST' || match[5] || match[2] === 'requests') return;
  const key = options.mutationKey ?? options.request.headers.get('Idempotency-Key'); if (!key?.trim()) mcpFail('IDEMPOTENCY_KEY_REQUIRED');
  const body = await readBoundedJsonBody(options.request);
  if (match[2] === 'connections') return { status: 201, data: await createMcpConnection(options, scope, body, key) };
  if (match[4] === 'commands') return { status: 200, data: await commandMcpConnection(options, scope, decodeURIComponent(match[3]!), body, key) };
  if (match[4] === 'requests') return { status: 202, data: await createMcpRequest(options, scope, decodeURIComponent(match[3]!), body, key) };
}
