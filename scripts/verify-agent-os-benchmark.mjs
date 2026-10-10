// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReport, digest, validateBenchmark } from '../packages/task-orchestration/src/benchmark-comparison.mjs';
export { compareReport, digest, validateBenchmark };
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../benchmarks/agent-os-delivery/v1/', import.meta.url));
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export async function loadBenchmark(directory = DEFAULT_DIRECTORY) {
  const [manifest, tasks, controls] = await Promise.all(['manifest', 'tasks', 'controls'].map(async name => JSON.parse(await readFile(resolve(directory, `${name}.json`), 'utf8'))));
  return validateBenchmark({ manifest, tasks, controls });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    ensure(args.length === 0 || (args.length === 2 && args[0] === '--report' && nonempty(args[1])), 'USAGE_EXPECTED_OPTIONAL_REPORT_PATH');
    const corpus = await loadBenchmark();
    const report = JSON.parse(await readFile(args.length ? resolve(args[1]) : resolve(DEFAULT_DIRECTORY, 'report.template.json'), 'utf8'));
    const comparison = compareReport(corpus, report);
    process.stdout.write(`${JSON.stringify({ datasetVersion: corpus.manifest.version, tasks: corpus.tasks.length, controls: corpus.controls.length, ...comparison }, null, 2)}\n`);
    if (comparison.releaseGate === 'blocked' || (args.length && comparison.releaseGate !== 'passed')) process.exitCode = 1;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'BENCHMARK_VALIDATION_FAILED';
    process.stderr.write(`评测校验失败：${code}\n`); process.exitCode = 1;
  }
}
