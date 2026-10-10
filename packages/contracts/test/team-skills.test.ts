// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import * as skills from '../src/team-skills.js';
const ref = { id: 'skill', version: '1', digest: 'a'.repeat(64) };
const source = { goalId: 'g', planRevisionId: 'p', deliverySetId: 'd', deliveryDigest: 'b'.repeat(64) };
test('技能版本只接受声明式改进和固定来源，不能传入图、权限或绑定', () => {
  const input = { skillId: 'skill', expectedStreamVersion: 0, source, title: '研究流程', description: '来源及反证复核', roles: [{ nodeId: 'review', instructions: '检查反证', sourceRefs: [] }] };
  assert.deepEqual(skills.parseCreateTeamSkillVersionV2(input), input);
  for (const value of [{ ...input, toolIds: ['shell'] }, { ...input, executor: 'forged' }, { ...input, nodes: [] }, { ...input, source: { ...source, deliveryDigest: 'bad' } }, { ...input, roles: [...input.roles, ...input.roles] }])
    assert.throws(() => skills.parseCreateTeamSkillVersionV2(value));
});
test('技能启用、回滚和停用命令严格互斥，不能省略证据或目标版本', () => {
  const input = { expectedStreamVersion: 0, command: 'enable', skillRef: ref, evaluationId: 'eval', recommendationEnabled: true };
  assert.deepEqual(skills.parseCommandTeamSkillV2(input), input);
  assert.deepEqual(skills.parseCommandTeamSkillV2({ expectedStreamVersion: 1, command: 'disable' }), { expectedStreamVersion: 1, command: 'disable' });
  for (const value of [{ ...input, command: 'auto' }, { ...input, evaluationId: '' }, { ...input, skillRef: { ...ref, version: 'latest' } }, { ...input, command: 'disable' }, { ...input, principalId: 'forged' }])
    assert.throws(() => skills.parseCommandTeamSkillV2(value));
});
