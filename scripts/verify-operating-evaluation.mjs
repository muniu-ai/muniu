// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readOperatingEvidence, verifyOperatingLogs } from './lib/operating-evaluation-files.mjs';
import { evaluateOperatingEvidence } from './lib/operating-evaluation.mjs';
import { verifyAcceptanceDigest, validateAcceptanceSpec } from './lib/enterprise-acceptance-spec.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
try {
  const source = await readFile(resolve(root, 'docs/enterprise-acceptance/baseline.json'), 'utf8'), lock = JSON.parse(await readFile(resolve(root, 'docs/enterprise-acceptance/baseline.lock.json'), 'utf8'));
  verifyAcceptanceDigest(source, lock); const baseline = JSON.parse(source); validateAcceptanceSpec(baseline);
  if (args.length === 1 && args[0] === '--self-test') {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'scripts/test/operating-evaluation.test.mjs'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = 1;
    else process.stdout.write('仅通过合成数据的计分与证据校验测试；真实离线质量和试点仍未验收。\n');
  } else {
    if (args[0] !== '--evidence' || !args[1] || ![2, 4].includes(args.length) || (args.length === 4 && args[2] !== '--output')) throw new Error('需要 --evidence <评测记录.json>；无真实记录时只能运行 --self-test');
    const { file, evidence } = await readOperatingEvidence(args[1]);
    const report = evaluateOperatingEvidence(baseline, lock, evidence), verifiedLogCount = await verifyOperatingLogs(file, evidence);
    const output = JSON.stringify({ baselineVersion: baseline.version, baselineDigest: lock.sha256, configurationDigest: evidence.configurationDigest, verifiedLogCount, ...report }, null, 2) + '\n';
    if (args[3]) await writeFile(resolve(args[3]), output, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(output);
    if (!report.passed) process.exitCode = 1;
  }
} catch (error) { process.stderr.write((error instanceof Error && !('code' in error) ? error.message : '评测文件读取或写入失败') + '\n'); process.exitCode = 1; }
