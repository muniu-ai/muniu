// SPDX-License-Identifier: Apache-2.0
import { readFile, access } from 'node:fs/promises';
import { validateAcceptanceSpec, verifyAcceptanceDigest } from './lib/enterprise-acceptance-spec.mjs';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('docs/enterprise-acceptance/baseline.json', root), 'utf8');
const lock = JSON.parse(await readFile(new URL('docs/enterprise-acceptance/baseline.lock.json', root), 'utf8'));
verifyAcceptanceDigest(source, lock);
const spec = JSON.parse(source);
const result = validateAcceptanceSpec(spec);
const scripts = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).scripts;
for (const item of spec.legacyCoverage) await access(new URL(item.path, root));
for (const item of spec.legacyUiGates) if (!Object.hasOwn(scripts, item.command)) throw new Error(`旧 UI 门禁不存在：${item.command}`);
process.stdout.write(`验收规格通过：${result.tasks} 项两模式任务，${result.safetyTasks} 项安全恢复规格，${result.requirements} 项要求。产品与外部集成仍未验收。\n`);
