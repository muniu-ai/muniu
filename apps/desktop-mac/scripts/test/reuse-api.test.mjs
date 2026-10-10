// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: [new URL('../../src/api.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, define: { 'import.meta.env.VITE_MN_API_URL': '"http://host.test"' } });
const { AgentOsClient } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
test('技能、记忆与跟进请求携带固定版本和重试身份', async () => {
 const original = globalThis.fetch, requests = [];
 globalThis.fetch = async (input, init) => { const request = new Request(input, init), url = new URL(request.url); requests.push({ path: url.pathname, query: url.search, key: request.headers.get('Idempotency-Key'), ...(request.method !== 'GET' ? { body: await request.json() } : {}) }); return Response.json({ code: 'STREAM_VERSION_CONFLICT', message: '版本变化', action: '重新读取', fieldIssues: [], traceId: 'reuse', retryable: false }, { status: 409 }); };
 try {
  const api = new AgentOsClient('http://host.test'), ref = { id: 'skill', version: '3', digest: 'a'.repeat(64) };
  for (const run of [() => api.teamSkills('workspace'), () => api.teamSkill('workspace', 'skill', '3'), () => api.commandTeamSkill('workspace', 'skill', { command: 'enable', expectedStreamVersion: 4, skillRef: ref, evaluationId: 'evaluation', recommendationEnabled: false }, 'enable-key'), () => api.commandFollowup('workspace', 'followup', { command: 'stop', expectedStreamVersion: 2 }, 'stop-key'), () => api.decideMemory('memory', 5, 'accept', 'memory-key'), () => api.planTeamGoal({ goal: { id: 'goal', workspaceId: 'workspace', streamVersion: 2 } }, { templateId: 'research-summary', templateVersion: '1', modelBindingId: 'model', skillRef: ref }, 'trial-key')]) { await assert.rejects(run); }
  assert.deepEqual(requests.map(item => [item.path, item.query, item.key]), [['/v2/workspaces/workspace/team-skills', '', null], ['/v2/workspaces/workspace/team-skills/skill', '?version=3', null], ['/v2/workspaces/workspace/team-skills/skill/commands', '', 'enable-key'], ['/v2/workspaces/workspace/followups/followup/commands', '', 'stop-key'], ['/v2/memories/memory/decisions', '', 'memory-key'], ['/v2/goals/goal/plan-revisions', '', 'trial-key']]);
  assert.deepEqual(requests[2].body, { command: 'enable', expectedStreamVersion: 4, skillRef: ref, evaluationId: 'evaluation', recommendationEnabled: false });
  assert.deepEqual(requests[3].body, { command: 'stop', expectedStreamVersion: 2 }); assert.deepEqual(requests[4].body, { expectedStreamVersion: 5, decision: 'accept' }); assert.deepEqual(requests[5].body.skillRef, ref);
 } finally { globalThis.fetch = original; }
});
