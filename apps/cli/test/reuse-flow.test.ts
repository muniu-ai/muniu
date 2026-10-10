// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/index.js';
async function command(args: string[]) {
  const requests: { path: string; key: string | null; body?: any }[] = [];
  const code = await runCli([...args, '--json'], { io: { stdout: () => {}, stderr: () => {} }, fetch: async (input, init) => {
    const request = new Request(input, init); requests.push({ path: new URL(request.url).pathname, key: request.headers.get('Idempotency-Key'), ...(request.method !== 'GET' ? { body: await request.json() } : {}) });
    return Response.json({ code: 'STREAM_VERSION_CONFLICT', message: '版本变化', action: '重新读取', fieldIssues: [], traceId: 'test', retryable: false }, { status: 409 });
  } }); return { requests, code };
}
test('技能启用固定版本摘要与评测，并默认关闭自动推荐', async () => {
  const result = await command(['skill', 'enable', 'skill', '--workspace', 'workspace', '--version', '2', '--skill-version', '1', '--digest', 'a'.repeat(64), '--evaluation', 'evaluation', '--key', 'enable-key']);
  assert.deepEqual(result.requests, [{ path: '/v2/workspaces/workspace/team-skills/skill/commands', key: 'enable-key', body: { expectedStreamVersion: 2, command: 'enable', skillRef: { id: 'skill', version: '1', digest: 'a'.repeat(64) }, evaluationId: 'evaluation', recommendationEnabled: false } }]);
});
test('创建跟进显式启用，命令行版本不能被文件覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mn-reuse-cli-')); try {
    const file = join(dir, 'followup.json'); await writeFile(file, JSON.stringify({ enabled: true, expectedStreamVersion: 999, parentGoalId: 'goal' }));
    const result = await command(['followup', 'create', '--workspace', 'workspace', '--file', file, '--key', 'create-key']);
    assert.equal(result.requests[0]?.path, '/v2/workspaces/workspace/followups'); assert.equal(result.requests[0]?.body.expectedStreamVersion, 0); assert.equal(result.requests[0]?.body.enabled, true); assert.equal(result.requests[0]?.key, 'create-key');
    await writeFile(file, JSON.stringify({ enabled: false })); const denied = await command(['followup', 'create', '--workspace', 'workspace', '--file', file]); assert.equal(denied.requests.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('记忆确认携带原版本与幂等身份', async () => {
  const result = await command(['memory', 'accept', 'memory', '--version', '3', '--key', 'memory-key']);
  assert.deepEqual(result.requests, [{ path: '/v2/memories/memory/decisions', key: 'memory-key', body: { expectedStreamVersion: 3, decision: 'accept' } }]);
});
test('技能试用要求完整版本身份且不能和单 Agent 调度混用', async () => {
  const result = await command(['goal', 'plan', 'goal', '--workspace', 'workspace', '--version', '2', '--team', 'research-summary', '--model', 'model', '--skill', 'skill', '--skill-version', '1', '--skill-digest', 'a'.repeat(64), '--key', 'plan-key']);
  assert.deepEqual(result.requests[0]?.body.skillRef, { id: 'skill', version: '1', digest: 'a'.repeat(64) });
  const denied = await command(['goal', 'plan', 'goal', '--workspace', 'workspace', '--version', '2', '--skill', 'skill']); assert.equal(denied.requests.length, 0);
});

test('自动推荐只能通过无值开关显式启用，不能把 false 误当授权', async () => {
 const result = await command(['skill', 'enable', 'skill', '--workspace', 'workspace', '--version', '0', '--skill-version', '1', '--digest', 'a'.repeat(64), '--evaluation', 'evaluation', '--recommend', 'false']);
 assert.equal(result.requests.length, 0);
});
test('技能目录按新目标查询推荐，文件提案保留来源类型', async () => {
 const requests: string[] = [];
 await runCli(['skill', 'list', '--workspace', 'workspace', '--goal', 'new-goal', '--json'], { io: { stdout: () => {}, stderr: () => {} }, fetch: async input => { requests.push(String(input)); return Response.json({ code: 'RESOURCE_DENIED', message: '拒绝', action: '核对', fieldIssues: [], traceId: 'test', retryable: false }, { status: 403 }); } });
 assert.equal(new URL(requests[0]!).search, '?goalId=new-goal');
 const dir = await mkdtemp(join(tmpdir(), 'mn-memory-cli-')); try {
  const file = join(dir, 'memory.json'), provenance = { version: 1, kind: 'preference', origin: 'user', sourceRefs: [] }; await writeFile(file, JSON.stringify({ workspaceId: 'wrong', provenance, value: { summary: '先列来源' } }));
  const result = await command(['memory', 'propose', '--workspace', 'workspace', '--file', file, '--key', 'proposal-key']); assert.equal(result.requests[0]?.body.workspaceId, 'workspace'); assert.deepEqual(result.requests[0]?.body.provenance, provenance); assert.equal(result.requests[0]?.key, 'proposal-key');
 } finally { await rm(dir, { recursive: true, force: true }); }
});
