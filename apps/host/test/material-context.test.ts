// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssetExtractionV2 } from '@mn/contracts';
import { selectMaterialBlocks } from '../src/material-context.js';

const blocks: AssetExtractionV2['blocks'] = [
  { id: 'intro', text: 'This document discusses gardening and roses.', locator: { paragraph: 1 } },
  { id: 'shipping', text: '交付期限为十月二十日，客户验收须保留独立书面记录。', locator: { paragraph: 2 } },
  { id: 'price', text: '报价 currency 为 CNY，价格计算以登记规则为准。', locator: { paragraph: 3 } },
  { id: 'other', text: 'Another unrelated gardening note.', locator: { paragraph: 4 } },
];
test('短资料完整保留，关键词筛选按原文顺序返回准确定位', () => {
  assert.deepEqual(selectMaterialBlocks(blocks, '交付期限 currency', 10_000), blocks);
  const bytes = Buffer.byteLength(JSON.stringify([blocks[1], blocks[2]]));
  assert.deepEqual(selectMaterialBlocks(blocks, '交付期限 currency', bytes), [blocks[1], blocks[2]]);
  assert.ok(Buffer.byteLength(JSON.stringify(selectMaterialBlocks(blocks, '交付期限 currency', bytes))) <= bytes);
});
test('英文大小写、同分顺序和没有命中均有确定结果，不改写原文', () => {
  const bytes = Buffer.byteLength(JSON.stringify([blocks[2]]));
  assert.deepEqual(selectMaterialBlocks(blocks, 'CURRENCY', bytes), [blocks[2]]);
  assert.deepEqual(selectMaterialBlocks(blocks, '', 110), [blocks[0]]);
  assert.deepEqual(selectMaterialBlocks(blocks, '', 110), selectMaterialBlocks(blocks, '', 110));
});
test('不能容纳任何完整段落时停止；不静默截断事实', () => {
  assert.throws(() => selectMaterialBlocks(blocks, '交付期限', 4), /CONTEXT_MATERIAL_LIMIT|段落/);
  assert.throws(() => selectMaterialBlocks(blocks, '', Number.NaN));
});
