// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateLicenseExpression } from './open-source-policy.mjs';

/** Only fill absent lock metadata after checking the locked package and both original notices. */
export function npmPackagesWithLicenseEvidence(lock, root, evidence = JSON.parse(readFileSync(join(root, 'docs/upstream-provenance/npm-license-evidence.json'), 'utf8'))) {
  const fail = () => { throw new Error('npm license evidence identity, content or provenance mismatch'); };
  if (evidence?.schemaVersion !== 1 || !Array.isArray(evidence.packages)) fail();
  const overrides = new Map();
  for (const entry of evidence.packages) {
    if (!entry || typeof entry.name !== 'string' || overrides.has(entry.name)
      || typeof entry.version !== 'string' || !entry.version
      || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')
      || typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
      || !validateLicenseExpression(entry.license)
      || !/^[A-Za-z0-9._-]+$/u.test(entry.licensePath)
      || !/^LICENSES\/[A-Za-z0-9._-]+\.txt$/u.test(entry.noticePath)
      || !/^[0-9a-f]{64}$/u.test(entry.licenseSha256)
      || typeof entry.reason !== 'string' || !entry.reason.trim()) fail();
    overrides.set(entry.name, entry);
  }
  const used = new Set();
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const packages = Object.entries(lock.packages ?? {})
    .filter(([location, entry]) => location.includes('node_modules/') && entry.link !== true)
    .map(([location, entry]) => {
      const name = entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const result = { name, version: entry.version, license: entry.license ?? null, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null };
      const override = overrides.get(name);
      if (!override) return result;
      if (entry.license != null || entry.version !== override.version || entry.resolved !== override.resolved || entry.integrity !== override.integrity
        || location.split('/').some((part) => !part || part === '.' || part === '..') || location.includes('\\') || location.startsWith('/')) fail();
      let installed, original, retained;
      try {
        installed = JSON.parse(readFileSync(join(root, location, 'package.json'), 'utf8'));
        original = readFileSync(join(root, location, override.licensePath));
        retained = readFileSync(join(root, override.noticePath));
      } catch { fail(); }
      if (installed.name !== name || installed.version !== entry.version
        || digest(original) !== override.licenseSha256 || digest(retained) !== override.licenseSha256) fail();
      used.add(name);
      return { ...result, license: override.license, licenseEvidence: { path: override.noticePath, sha256: override.licenseSha256, source: `${override.resolved}#${override.licensePath}` } };
    });
  if (used.size !== overrides.size) fail();
  return packages.sort((left, right) => compare(left.name, right.name) || compare(left.version, right.version) || compare(left.resolved ?? '', right.resolved ?? ''));
}

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
