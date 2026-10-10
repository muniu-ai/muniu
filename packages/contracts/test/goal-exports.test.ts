// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCreateGoalExportV2 } from '../src/goal-exports.js';
test('导出请求固定成果身份且不接受正文、路径或权限字段', () => {
  const input = { workspaceId: 'w', expectedStreamVersion: 0, planRevisionId: 'p', deliverySetId: 'd', outputKey: 'report', outputDigest: 'a'.repeat(64), format: 'pdf' };
  assert.deepEqual(parseCreateGoalExportV2(input), input);
  for (const change of [{text:'unsafe'}, {fileName:'../x'}, {sourceRefs:[]}, {format:'html'}, {outputDigest:'bad'}, {expectedStreamVersion:1}, {outputKey:''}]) {
    assert.throws(() => parseCreateGoalExportV2({ ...input, ...change }));
  }
});
