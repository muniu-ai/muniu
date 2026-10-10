// SPDX-License-Identifier: Apache-2.0
import type { AssetExtractionV2 } from '@mn/contracts';
import { KernelError } from '@mn/kernel';

function terms(query: string): readonly string[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  const values = [...normalized.matchAll(/[a-z0-9_]{2,}/gu)].map(match => match[0]);
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = [...match[0]];
    for (let index = 0; index < chars.length - 1; index++) values.push(chars[index]! + chars[index + 1]!);
  }
  return [...new Set(values)].slice(0, 512);
}

/** Retrieval operates only on already-authorized extraction blocks and never changes their text or locators. */
export function selectMaterialBlocks(blocks: AssetExtractionV2['blocks'], query: string, maxBytes: number): AssetExtractionV2['blocks'] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) throw new KernelError('CONTEXT_MATERIAL_LIMIT', '没有可用的资料空间', '缩小资料范围或减少必要上下文');
  if (Buffer.byteLength(JSON.stringify(blocks)) <= maxBytes) return blocks;
  const keywords = terms(query);
  const ranked = blocks.map((block, index) => {
    const text = block.text.normalize('NFKC').toLowerCase();
    return { block, index, score: keywords.reduce((score, term) => score + Number(text.includes(term)), 0),
      bytes: Buffer.byteLength(JSON.stringify(block)) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: typeof ranked = [];
  let used = 2;
  for (const candidate of ranked) {
    const bytes = candidate.bytes + Number(selected.length > 0);
    if (used + bytes > maxBytes) continue;
    selected.push(candidate); used += bytes;
  }
  if (!selected.length) throw new KernelError('CONTEXT_MATERIAL_LIMIT', '资料空间不足以容纳任何完整段落', '缩小资料范围或将长段落整理后重新上传');
  return selected.sort((a, b) => a.index - b.index).map(item => item.block);
}
