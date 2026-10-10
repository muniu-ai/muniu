// SPDX-License-Identifier: Apache-2.0
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { KernelError } from '@mn/kernel';
import { isPublicAddress } from '@mn/plugin-opc';
export const MCP_VERSION = '2026-07-28';
export const MCP_RESPONSE_BYTES = 2 * 1024 * 1024;
export type McpMethod = 'resources/list' | 'resources/templates/list' | 'resources/read';
export interface McpHttpInput { readonly endpoint: string; readonly address: string; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly signal: AbortSignal }
export interface McpHttpResponse { readonly status: number; readonly contentType: string; readonly contentEncoding?: string; readonly remoteAddress: string; readonly body: AsyncIterable<Uint8Array>; discard(): void }
export interface McpTransportInput { readonly endpoint: string; readonly id: string; readonly method: McpMethod; readonly params: Readonly<Record<string, unknown>>; readonly requestBody?: string; readonly token?: string; readonly signal: AbortSignal; readonly assertAllowed?: () => Promise<void> }
export type McpTransport = (input: McpTransportInput) => Promise<Record<string, unknown>>;
export function mcpError(code: string): KernelError { return new KernelError(code, 'MCP 读取未完成或请求不受支持', '核对连接授权、资源范围和协议版本'); }
export function parseMcpEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw mcpError('MCP_ENDPOINT_INVALID'); }
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || isIP(url.hostname.replace(/^\[|\]$/gu, '')) || !url.hostname.includes('.') || (url.port && url.port !== '443')) throw mcpError('MCP_ENDPOINT_INVALID');
  return url;
}
export function mcpHeaderValue(value: string): string {
  return /^[\x20-\x7e]+$/u.test(value) && value.trim() === value && !value.startsWith('=?base64?') ? value : `=?base64?${Buffer.from(value).toString('base64')}?=`;
}
async function nodeRequest(input: McpHttpInput): Promise<McpHttpResponse> {
  const url = parseMcpEndpoint(input.endpoint), family = isIP(input.address);
  if (family !== 4 && family !== 6) throw mcpError('MCP_ADDRESS_DENIED');
  const pinned: LookupFunction = (_host, options, callback) => options.all ? callback(null, [{ address: input.address, family }]) : callback(null, input.address, family);
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: url.hostname, port: 443, path: url.pathname, method: 'POST', headers: input.headers, agent: false,
      lookup: pinned, signal: input.signal, maxHeaderSize: 16384 }, incoming => resolve({ status: incoming.statusCode ?? 0,
      contentType: String(incoming.headers['content-type'] ?? ''), contentEncoding: incoming.headers['content-encoding'],
      remoteAddress: incoming.socket.remoteAddress ?? '', body: incoming, discard: () => incoming.destroy() }));
    outgoing.once('error', () => reject(mcpError('MCP_TRANSPORT_FAILED'))); outgoing.end(input.body);
  });
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function message(value: unknown, id: string, notification: boolean): Record<string, unknown> | undefined {
  if (!object(value) || value.jsonrpc !== '2.0') throw mcpError('MCP_RESPONSE_INVALID');
  if ('method' in value) {
    if (!notification || 'id' in value || !['notifications/progress', 'notifications/message'].includes(String(value.method))) throw mcpError('MCP_SERVER_REQUEST_DENIED');
    return;
  }
  if (value.id !== id || ('result' in value) === ('error' in value)) throw mcpError('MCP_RESPONSE_INVALID');
  if ('error' in value) throw mcpError('MCP_REMOTE_ERROR');
  if (!object(value.result) || value.result.resultType !== 'complete' || 'inputRequests' in value.result || 'inputResponses' in value.result) throw mcpError('MCP_INPUT_REQUEST_DENIED');
  return value.result;
}
function decode(value: string): unknown { try { return JSON.parse(value); } catch { throw mcpError('MCP_RESPONSE_INVALID'); } }
async function readResponse(response: McpHttpResponse, id: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const type = response.contentType.split(';')[0]?.trim().toLowerCase();
  if (response.status !== 200 || (response.contentEncoding && response.contentEncoding !== 'identity') || !['application/json', 'text/event-stream'].includes(type ?? '')) throw mcpError('MCP_RESPONSE_INVALID');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0, count = 0, trailingCr = false;
  for await (const chunk of response.body) {
    signal.throwIfAborted(); bytes += chunk.byteLength; if (bytes > MCP_RESPONSE_BYTES) throw mcpError('MCP_RESPONSE_LIMIT');
    let decoded = decoder.decode(chunk, { stream: true });
    if (type === 'text/event-stream' && decoded) {
      if (trailingCr && decoded.startsWith('\n')) decoded = decoded.slice(1);
      trailingCr = decoded.endsWith('\r');
      decoded = decoded.replace(/\r\n?/gu, '\n');
    }
    text += decoded;
    if (type !== 'text/event-stream') continue;
    let final: Record<string, unknown> | undefined;
    for (;;) {
      const boundary = /\n\n/u.exec(text); if (!boundary) break;
      const frame = text.slice(0, boundary.index); text = text.slice(boundary.index + boundary[0].length);
      const lines = frame.split('\n'), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
      if (!data) continue;
      if (++count > 64 || final) throw mcpError('MCP_RESPONSE_LIMIT');
      final = message(decode(data), id, true);
    }
    if (final) { if (text.trim() && !text.trim().startsWith(':')) throw mcpError('MCP_RESPONSE_INVALID'); return final; }
  }
  text += decoder.decode();
  if (type === 'text/event-stream') throw mcpError('MCP_RESPONSE_INCOMPLETE');
  return message(decode(text), id, false)!;
}
export function mcpRequestBody(id: string, method: McpMethod, parameters: Readonly<Record<string, unknown>>): string {
  const params = { ...parameters, _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_VERSION, 'io.modelcontextprotocol/clientInfo': { name: 'Muniu', version: '0.2.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } };
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  if (Buffer.byteLength(body) > 16384) throw mcpError('MCP_REQUEST_LIMIT');
  return body;
}
export function createMcpTransport(options: { readonly lookup?: (hostname: string) => Promise<readonly string[]>; readonly request?: (input: McpHttpInput) => Promise<McpHttpResponse>; readonly timeoutMs?: number } = {}): McpTransport {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw mcpError('MCP_LIMIT_INVALID');
  return async input => {
    const url = parseMcpEndpoint(input.endpoint);
    if (!['resources/list', 'resources/templates/list', 'resources/read'].includes(input.method) || !input.id || input.id.length > 200
      || (input.token !== undefined && (!input.token || input.token.length > 8192 || !/^[\x21-\x7e]+$/u.test(input.token)))) throw mcpError('MCP_REQUEST_INVALID');
    const controller = new AbortController(), aborted = () => controller.abort(), timer = setTimeout(aborted, timeoutMs);
    input.signal.addEventListener('abort', aborted, { once: true }); if (input.signal.aborted) aborted();
    let response: McpHttpResponse | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => { const fail = () => reject(mcpError('MCP_REQUEST_CANCELLED')); controller.signal.addEventListener('abort', fail, { once: true }); if (controller.signal.aborted) fail(); });
    try {
      return await Promise.race([cancellation, (async () => {
        const addresses = await (options.lookup ?? (async host => (await lookup(host, { all: true, verbatim: true })).map(record => record.address)))(url.hostname);
        controller.signal.throwIfAborted();
        if (!addresses.length || addresses.length > 32 || addresses.some(address => !isPublicAddress(address))) throw mcpError('MCP_ADDRESS_DENIED');
        const body = mcpRequestBody(input.id, input.method, input.params);
        if (input.requestBody !== undefined && input.requestBody !== body) throw mcpError('MCP_REQUEST_INVALID');
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_VERSION, 'Mcp-Method': input.method, 'Content-Length': String(Buffer.byteLength(body)) };
        if (input.method === 'resources/read') { if (typeof input.params.uri !== 'string') throw mcpError('MCP_REQUEST_INVALID'); headers['Mcp-Name'] = mcpHeaderValue(input.params.uri); }
        if (input.token) headers.Authorization = `Bearer ${input.token}`;
        await input.assertAllowed?.(); controller.signal.throwIfAborted();
        response = await (options.request ?? nodeRequest)({ endpoint: url.href, address: addresses[0]!, headers, body, signal: controller.signal });
        controller.signal.throwIfAborted();
        const normalize = (address: string) => address.toLowerCase().replace(/^::ffff:/u, '');
        if (!isPublicAddress(response.remoteAddress) || normalize(response.remoteAddress) !== normalize(addresses[0]!)) throw mcpError('MCP_ADDRESS_DENIED');
        return await readResponse(response, input.id, controller.signal);
      })()]);
    } catch (error) { if (error instanceof KernelError) throw error; throw mcpError('MCP_TRANSPORT_FAILED'); }
    finally { clearTimeout(timer); controller.abort(); response?.discard(); input.signal.removeEventListener('abort', aborted); }
  };
}
