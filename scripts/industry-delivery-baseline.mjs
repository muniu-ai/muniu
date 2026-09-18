// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const targets = [
  { component: 'agent_os', path: root, baselineCommit: '89eb29591a6f9294faa3aa379debb47a6d6bbc3c', requiredTypeScript: '5.7.2' },
  { component: 'sales', path: process.argv[2] ?? resolve(root, '../创业项目/muniu-ai-sales-rfq'), baselineCommit: '8913a94c567403bd2f3021d09b0bf9474bd4102d', requiredTypeScript: '5.9.3' },
];
const git = (path, args) => execFileSync('git', args, { cwd: path, encoding: 'utf8' });
const hash = value => createHash('sha256').update(value).digest('hex');
const versions = { node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), nodeExecutable: process.execPath };
const output = {
  schemaVersion: 1, capturedAt: new Date().toISOString(), operation: 'read_only_baseline_capture',
  toolchain: { required: { node: '22.19.x', npm: '11.10.1' }, actual: versions,
    matchesOsRequirement: /^v22\.19\./.test(versions.node) && versions.npm === '11.10.1' },
  components: targets.map(target => {
    const manifest = JSON.parse(git(target.path, ['show', `${target.baselineCommit}:package.json`]));
    const lock = git(target.path, ['show', `${target.baselineCommit}:package-lock.json`]);
    const status = git(target.path, ['status', '--porcelain=v1', '--untracked-files=normal']).trim();
    return { ...target, currentHead: git(target.path, ['rev-parse', 'HEAD']).trim(), baselineLockSha256: hash(lock),
      baselineTypeScript: manifest.devDependencies.typescript, baselineEngines: manifest.engines,
      baselinePackageManager: manifest.packageManager ?? null,
      currentWorkingTree: { clean: status.length === 0, statusLines: status ? status.split('\n') : [] },
      verification: 'source_identity_only_no_test_result' };
  }),
};
console.log(JSON.stringify(output, null, 2));
