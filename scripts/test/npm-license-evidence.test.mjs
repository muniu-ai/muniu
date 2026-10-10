// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { npmPackagesWithLicenseEvidence } from '../lib/npm-license-evidence.mjs';

const root = new URL('../../', import.meta.url);
test('npm 缺失许可仅以固定包身份与原文证据补齐，未知依赖仍拒绝', async () => {
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  const overrides = JSON.parse(await readFile(new URL('docs/upstream-provenance/npm-license-evidence.json', root), 'utf8'));
  const license = await readFile(new URL('node_modules/png-js/LICENSE', root));
  const directory = await mkdtemp(join(tmpdir(), 'mn-license-'));
  const entry = lock.packages['node_modules/png-js'];
  const fixtureLock = { packages: { 'node_modules/png-js': entry, 'node_modules/unknown': { version: '1.0.0' } } };
  try {
    await mkdir(join(directory, 'node_modules/png-js'), { recursive: true });
    await mkdir(join(directory, 'LICENSES'));
    await writeFile(join(directory, 'node_modules/png-js/LICENSE'), license);
    await writeFile(join(directory, 'LICENSES/png-js-MIT.txt'), license);
    await writeFile(join(directory, 'node_modules/png-js/package.json'), JSON.stringify({ name: 'png-js', version: '2.0.0' }));
    const resolve = (value = fixtureLock, evidence = overrides) => npmPackagesWithLicenseEvidence(value, directory, evidence);
    const packages = resolve();
    assert.equal(packages[0].license, 'MIT');
    assert.equal(packages[0].licenseEvidence.sha256, createHash('sha256').update(license).digest('hex'));
    assert.equal(packages[1].license, null);
    for (const change of [{ version: '2.0.1' }, { resolved: 'https://example.invalid/png.tgz' }, { integrity: 'sha512-changed' }, { license: 'GPL-3.0' }]) {
      assert.throws(() => resolve({ packages: { 'node_modules/png-js': { ...entry, ...change } } }), /license evidence/iu);
    }
    assert.throws(() => resolve({ packages: {} }), /license evidence/iu);
    assert.throws(() => resolve(fixtureLock, { ...overrides, packages: [...overrides.packages, overrides.packages[0]] }), /license evidence/iu);
    await writeFile(join(directory, 'node_modules/png-js/LICENSE'), 'MIT');
    assert.throws(() => resolve(), /license evidence/iu);
    await writeFile(join(directory, 'node_modules/png-js/LICENSE'), license);
    await writeFile(join(directory, 'LICENSES/png-js-MIT.txt'), 'MIT');
    assert.throws(() => resolve(), /license evidence/iu);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
