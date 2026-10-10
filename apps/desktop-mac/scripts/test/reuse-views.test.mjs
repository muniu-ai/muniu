// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
let directory, fixture;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'muniu-reuse-views-'));
  const file = join(directory, 'fixture.cjs');
  await build({ entryPoints: [new URL('../fixtures/reuse-views.tsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile: file });
  fixture = createRequire(import.meta.url)(file);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
test('模型记忆候选明确标注类型和来源，确认必须由 Host 允许', () => {
  const html = fixture.memoryMarkup({ allowedActions: ['reject', 'delete'] });
  for (const text of ['偏好', '模型提议', '待确认', 'asset', '版本 3', '拒绝']) assert.ok(html.includes(text), text);
  assert.equal(html.includes('>接受</button>'), false);
});
test('撤权记忆隐藏旧正文和候选操作，仅保留安全状态与删除', () => {
  const html = fixture.memoryMarkup({ access: 'revoked', allowedActions: ['delete'] });
  assert.equal(html.includes('受保护偏好正文'), false);
  assert.equal(html.includes('>接受</button>'), false);
  assert.equal(html.includes('>修改</button>'), false);
  assert.ok(html.includes('来源已撤权'));
  assert.ok(html.includes('>删除</button>'));
});
test('旧记忆无新增来源字段时保留既有确认操作', () => {
  const html = fixture.memoryMarkup({ provenance: undefined, access: undefined, allowedActions: undefined });
  assert.ok(html.includes('>接受</button>'));
  assert.ok(html.includes('>修改</button>'));
});
test('未测技能允许明确试用，不能显示启用或已通过', () => {
  const html = fixture.skillMarkup();
  for (const text of ['尚未评测', '试用为新任务', '独立复核', 'research', '来源可核对', '核对反证']) assert.ok(html.includes(text), text);
  assert.equal(html.includes('>启用此版本</button>'), false);
  assert.equal(html.includes('>回滚到此版本</button>'), false);
});
test('技能不可用时保留原因并按 Host 禁止试用', () => {
  const html = fixture.skillMarkup({ staleReasons: ['来源已撤权'], allowedActions: { trial: false, createVersion: false, enable: false, rollback: false, disable: true } });
  assert.match(html, /<button[^>]*disabled=""[^>]*>试用为新任务/u);
  assert.ok(html.includes('来源已撤权'));
  assert.ok(html.includes('>停用技能</button>'));
});
test('跟进费用未知不能显示已结算为零，继续操作服从 Host', () => {
  const html = fixture.followupMarkup();
  assert.ok(html.includes('费用尚未核对，不按零结算'));
  assert.equal(html.includes('>继续跟进</button>'), false);
  assert.ok(html.includes('>停止跟进</button>'));
  assert.ok(html.includes('>查看跟进任务</button>'));
});

test('受控跟进只接受已批准的只读内置单 Agent 目标', () => {
  assert.equal(fixture.followupEligible(), true);
  for (const change of [{ plan: { kind: 'team-v1' } }, { goal: { status: 'accepted' } }, { goal: { status: 'needs_reconciliation' } }, { goal: { cancellationRequestedAt: '2026-10-10T00:00:00Z' } }, { goal: { authorization: undefined } }, { plan: { runnerId: 'codex-cli' } }, { plan: { toolIds: ['write'] } }]) assert.equal(fixture.followupEligible(change), false);
});
test('计划建议只显示 Host 推荐且可用的已评测版本，仍需明确采用', () => {
 const html = fixture.recommendationMarkup();
 assert.ok(html.includes('已验证研究流程')); assert.ok(html.includes('采用建议技能生成计划'));
 assert.equal(html.includes('未测流程'), false); assert.equal(html.includes('未授权流程'), false); assert.equal(html.includes('未推荐流程'), false);
});
