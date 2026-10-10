// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpTransport, parseMcpEndpoint, type McpHttpResponse } from '../src/mcp-transport.js';
const endpoint = 'https://mcp.example.com/resources';
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
function response(bytes: Uint8Array, contentType = 'application/json', extra: Partial<McpHttpResponse> = {}): McpHttpResponse {
  return { status: 200, contentType, remoteAddress: '8.8.8.8', body: (async function* () { yield bytes; })(), discard() {}, ...extra };
}
test('2026协议每次请求带元数据，UTF8名称编码，无initialize或会话', async () => {
  let sent: any;
  const transport = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async input => { sent = input; return response(body({ jsonrpc: '2.0', id: 'request', result: { resultType: 'complete', contents: [] } })); } });
  await transport({ endpoint, id: 'request', method: 'resources/read', params: { uri: 'store://中文' }, token: 'secret', signal: new AbortController().signal });
  assert.equal(sent.headers['Mcp-Name'], '=?base64?' + Buffer.from('store://中文').toString('base64') + '?=');
  assert.equal(sent.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(JSON.parse(sent.body).params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.deepEqual(JSON.parse(sent.body).params._meta['io.modelcontextprotocol/clientCapabilities'], {});
  assert.equal(sent.headers['Mcp-Session-Id'], undefined);
});
test('JSON和分块SSE只接受匹配的唯一最终结果', async () => {
  const sse = ': ping\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\ndata: {"jsonrpc":"2.0","id":"r","result":{"resultType":"complete","resources":[]}}\r\n\r\n';
  const transport = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async () => response(Buffer.from(sse), 'text/event-stream') });
  assert.deepEqual(await transport({ endpoint, id: 'r', method: 'resources/list', params: {}, signal: new AbortController().signal }), { resultType: 'complete', resources: [] });
  for (const invalid of [ [{ jsonrpc: '2.0', id: 'r', result: {} }], { jsonrpc: '2.0', id: 'other', result: {} }, { jsonrpc: '2.0', id: 'r', method: 'sampling/createMessage' }, { jsonrpc: '2.0', id: 'r', result: { inputRequests: [] } } ]) {
    const denied = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async () => response(body(invalid)) });
    await assert.rejects(denied({ endpoint, id: 'r', method: 'resources/list', params: {}, signal: new AbortController().signal }), /MCP/u);
  }
});
test('固定HTTPS端点、所有DNS地址与实际对端均拒绝SSRF及重定向', async () => {
  for (const url of ['http://mcp.example.com', 'https://user:pass@mcp.example.com', 'https://127.0.0.1', 'https://mcp.example.com?token=x', 'https://mcp.example.com/#x']) assert.throws(() => parseMcpEndpoint(url));
  let calls = 0;
  const privateDns = createMcpTransport({ lookup: async () => ['8.8.8.8', '::ffff:127.0.0.1'], request: async () => { calls++; return response(body({})); } });
  await assert.rejects(privateDns({ endpoint, id: 'r', method: 'resources/list', params: {}, signal: new AbortController().signal })); assert.equal(calls, 0);
  for (const extra of [{ status: 302 }, { remoteAddress: '127.0.0.1' }, { remoteAddress: '1.1.1.1' }, { contentEncoding: 'gzip' }]) {
    const transport = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async () => response(body({ jsonrpc: '2.0', id: 'r', result: {} }), 'application/json', extra) });
    await assert.rejects(transport({ endpoint, id: 'r', method: 'resources/list', params: {}, signal: new AbortController().signal }));
  }
});
test('总响应、消息数与总期限均有限；错误正文不传播secret或授权URL', async () => {
  const base = { endpoint, id: 'r', method: 'resources/list' as const, params: {}, signal: new AbortController().signal };
  for (const result of [response(Buffer.alloc(2 * 1024 * 1024 + 1)), response(Buffer.from('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'.repeat(70)), 'text/event-stream'), response(body({ jsonrpc: '2.0', id: 'r', error: { message: 'secret https://evil.test/auth' } }))]) {
    const transport = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async () => result });
    await assert.rejects(transport(base), error => error instanceof Error && !error.message.includes('secret') && !error.message.includes('evil.test'));
  }
  const slow = createMcpTransport({ timeoutMs: 5, lookup: async () => new Promise(() => {}), request: async () => response(body({})) });
  await assert.rejects(slow(base), /MCP/u);
});
test('当前协议只接受 complete 结果，拒绝旧协议及输入请求', async () => {
  for (const result of [{ resources: [] }, { resultType: 'input_required' }, { resultType: 'complete', inputRequests: [] }]) {
    const transport = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async () => response(body({ jsonrpc: '2.0', id: 'r', result })) });
    await assert.rejects(transport({ endpoint, id: 'r', method: 'resources/list', params: {}, signal: new AbortController().signal }));
  }
});
test('SSE 支持跨块 CR、CRLF 和 LF，最终结果后关闭流', async () => {
  for (const newline of ['\r', '\r\n', '\n']) {
    let discarded = false;
    const stream = `: ping${newline}${newline}data: ${JSON.stringify({ jsonrpc: '2.0', id: 'r', result: { resultType: 'complete', resources: [] } })}${newline}${newline}`;
    const transport = createMcpTransport({ lookup: async () => ['8.8.8.8'], request: async () => response(Buffer.alloc(0), 'text/event-stream', {
      body: (async function* () { for (const character of stream) yield Buffer.from(character); })(), discard() { discarded = true; }
    }) });
    assert.equal((await transport({ endpoint, id: 'r', method: 'resources/list', params: {}, signal: new AbortController().signal })).resultType, 'complete');
    assert.equal(discarded, true);
  }
});
