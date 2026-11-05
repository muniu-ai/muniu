// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, readdir, lstat, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { schemaType } from './lib/schema-types.mjs';

const execute = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILES = Object.freeze(['enterprise-schema.json', 'enterprise-types.d.ts', 'provider-types.d.ts', 'provider-contract-suite.mjs', 'validate.mjs', 'verify.mjs', 'package.json']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')));

async function git(root, ...args) {
  const { stdout } = await execute('git', ['-C', root, ...args], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
function sourcePath(root, path) {
  const name = relative(root, path).split(sep).join('/');
  if (!name || name.startsWith('../') || name.startsWith('/') || name.split('/').includes('node_modules')) throw new Error('Only repository source files may enter the contract bundle');
  return name;
}
function typeDeclarations(schemas) {
  return '// Generated from enterprise-schema.ts. Do not edit.\n// SPDX-License-Identifier: Apache-2.0\n'
    + Object.entries(schemas).map(([name, schema]) => 'export type ' + name + ' = ' + schemaType(schema) + ';').join('\n')
    + '\nexport interface EnterpriseContractTypes {\n'
    + Object.keys(schemas).map(name => '  readonly ' + name + ': ' + name + ';').join('\n') + '\n}\n';
}
function portableProviderTypes(source) {
  const importPattern = /from (['"])@mn\/contracts\1/gu;
  const matches = source.match(importPattern);
  if (matches?.length !== 1) throw new Error('The authoritative provider SDK import changed; review the portable type export');
  const result = source.replace(importPattern, "from './enterprise-types.js'");
  if (/@mn\//u.test(result) || /\bexport\s+(?:const|let|var|class|function)\b/u.test(result)) throw new Error('Provider declarations must remain type-only and portable');
  return '// Generated from packages/plugin-sdk/src/business-provider.ts. Do not edit.\n' + result;
}
function standaloneVerifier() {
  return [
    '// Generated standalone bundle integrity verifier. Do not edit.',
    '// SPDX-License-Identifier: Apache-2.0',
    "import { createHash } from 'node:crypto';",
    "import { createReadStream } from 'node:fs';",
    "import { readFile, readdir, lstat } from 'node:fs/promises';",
    "import { dirname, join, resolve } from 'node:path';",
    'const FILES = Object.freeze(' + JSON.stringify(FILES) + ');',
    verifyProviderContractBundle.toString(),
    'export { verifyProviderContractBundle };',
    "if (!('main' in import.meta)) throw new Error('Node.js 22.19.x is required');",
    'if (import.meta.main) {',
    '  try {',
    "    if (process.argv.length !== 2) throw new Error('Usage: node <bundle>/verify.mjs');",
    '    const directory = dirname(resolve(process.argv[1]));',
    '    const manifest = await verifyProviderContractBundle(directory);',
    "    const manifestSha256 = createHash('sha256').update(await readFile(join(directory, 'manifest.json'))).digest('hex');",
    "    process.stdout.write(JSON.stringify({ status: 'integrity-verified', source: manifest.source.gitCommit, workingTreeDirty: manifest.source.workingTreeDirty, manifestSha256 }) + '\\n');",
    "  } catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }",
    '}',
    '',
  ].join('\n');
}

/** Export source-derived contracts; never copy runtime configuration, credentials or databases. */
export async function exportProviderContracts({ outputDir, allowDirty = false } = {}) {
  if (typeof outputDir !== 'string' || outputDir.length === 0) throw new Error('An explicit output directory is required');
  const root = await git(REPOSITORY_ROOT, 'rev-parse', '--show-toplevel');
  const output = resolve(outputDir), sourceCommit = await git(root, 'rev-parse', 'HEAD');
  if (output === root) throw new Error('The repository root cannot be the output directory');
  try { await lstat(output); throw new Error('Output directory already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const beforeDirty = (await git(root, 'status', '--porcelain', '--untracked-files=all')).length > 0;
  if (beforeDirty && !allowDirty) throw new Error('The source worktree is dirty; commit it before freezing a bundle or explicitly use --allow-dirty for development');

  const sourceFiles = new Map();
  async function capture(path) {
    const bytes = await readFile(path), name = sourcePath(root, path), hash = digest(bytes);
    if (sourceFiles.has(name) && sourceFiles.get(name) !== hash) throw new Error('Source changed during export: ' + name);
    sourceFiles.set(name, hash); return bytes;
  }
  const capturePlugin = { name: 'record-contract-source', setup(builder) {
    builder.onLoad({ filter: /\.(ts|mjs)$/ }, async args => ({ contents: await capture(args.path), loader: args.path.endsWith('.ts') ? 'ts' : 'js' }));
  } };
  const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, treeShaking: true, sourcemap: false, legalComments: 'inline', plugins: [capturePlugin], logLevel: 'silent' };
  const schemaBundle = await build({ ...common, entryPoints: ['packages/contracts/src/enterprise-schema.ts'] });
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(schemaBundle.outputFiles[0].contents).toString('base64'));
  const schemas = loaded.ENTERPRISE_SCHEMAS, ports = loaded.ENTERPRISE_PROVIDER_PORTS;
  if (!schemas?.EnterpriseProviderActionPreparation || !schemas?.ActionIntent || !schemas?.ActionReceipt || ports?.length !== 5) throw new Error('Missing authoritative provider schemas');
  const validatorBundle = await build({ ...common, stdin: {
    contents: "export { parseEnterpriseContract } from './packages/contracts/src/enterprise-contracts.ts';",
    resolveDir: root, sourcefile: 'portable-provider-validator.mjs', loader: 'js',
  } });
  const sdk = await capture(join(root, 'packages/plugin-sdk/src/business-provider.ts'));
  const suite = await capture(join(root, 'scripts/lib/provider-contract-suite.mjs'));
  for (const name of ['scripts/export-provider-contracts.mjs', 'scripts/lib/schema-types.mjs', 'package-lock.json']) await capture(join(root, name));
  const files = {
    'enterprise-schema.json': json({ format: 'muniu-provider-contracts-v1', ports, components: { schemas } }),
    'enterprise-types.d.ts': typeDeclarations(schemas),
    'provider-types.d.ts': portableProviderTypes(sdk.toString('utf8')),
    'provider-contract-suite.mjs': suite,
    'validate.mjs': validatorBundle.outputFiles[0].contents,
    'verify.mjs': standaloneVerifier(),
    'package.json': json({ name: '@muniu/provider-contract-tests', version: '0.0.0', private: true, type: 'module', engines: { node: '22.19.x' }, license: 'Apache-2.0', exports: {
      './suite': './provider-contract-suite.mjs', './schema': './enterprise-schema.json', './validator': './validate.mjs', './verify': './verify.mjs', './provider-types': { types: './provider-types.d.ts' },
    } }),
  };
  for (const [name, expected] of sourceFiles) {
    if (digest(await readFile(join(root, name))) !== expected) throw new Error('Source changed during export: ' + name);
  }
  if (await git(root, 'rev-parse', 'HEAD') !== sourceCommit) throw new Error('Source commit changed during export');
  const afterDirty = (await git(root, 'status', '--porcelain', '--untracked-files=all')).length > 0;
  if (afterDirty && !allowDirty) throw new Error('Source became dirty during export');
  const manifest = {
    format: 'muniu-provider-contract-bundle-v1',
    source: { gitCommit: sourceCommit, workingTreeDirty: beforeDirty || afterDirty, files: sorted(Object.fromEntries(sourceFiles)) },
    generator: { node: process.versions.node, esbuild: esbuildVersion },
    files: sorted(Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, { sha256: digest(contents), bytes: Buffer.byteLength(contents) }]))),
  };
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.provider-contract-'));
  try {
    for (const [name, contents] of Object.entries(files)) await writeFile(join(staging, name), contents, { flag: 'wx' });
    await writeFile(join(staging, 'manifest.json'), json(manifest), { flag: 'wx' });
    // The destination must remain absent; never replace an existing bundle or user directory.
    try { await lstat(output); throw new Error('Output directory already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staging, output);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return manifest;
}

/** Integrity checking does not authenticate the producer; compare the manifest to the agreed source commit. */
export async function verifyProviderContractBundle(directory) {
  const root = resolve(directory), directoryInfo = await lstat(root);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Provider bundle must be a regular directory');
  const manifestPath = join(root, 'manifest.json'), manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 1024 * 1024) throw new Error('Provider bundle manifest must be a bounded regular file');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.format !== 'muniu-provider-contract-bundle-v1' || !/^[a-f0-9]{40}$/u.test(manifest.source?.gitCommit ?? '')
    || typeof manifest.source?.workingTreeDirty !== 'boolean') throw new Error('Invalid provider bundle manifest');
  const sources = manifest.source.files;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)
    || !Object.hasOwn(sources, 'packages/contracts/src/enterprise-schema.ts')
    || !Object.hasOwn(sources, 'packages/plugin-sdk/src/business-provider.ts')) throw new Error('Invalid provider bundle source inventory');
  for (const [name, hash] of Object.entries(sources)) {
    if (!name.split('/').every(part => /^[A-Za-z0-9._-]+$/u.test(part) && part !== '.' && part !== '..')) throw new Error('Invalid provider bundle source path');
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid provider bundle source digest');
  }
  const keys = Object.keys(manifest.files ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...FILES].sort())) throw new Error('Invalid provider bundle file inventory');
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify([...FILES, 'manifest.json'].sort())) throw new Error('Unexpected files in provider bundle');
  for (const name of FILES) {
    const expected = manifest.files[name], filePath = join(root, name), info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || !expected || typeof expected.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0
      || info.size !== expected.bytes) throw new Error('Provider bundle integrity check failed: ' + name);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(filePath)) hash.update(bytes);
    if (hash.digest('hex') !== expected.sha256) throw new Error('Provider bundle integrity check failed: ' + name);
  }
  return manifest;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/export-provider-contracts.mjs --out <new-directory> [--allow-dirty]\n       node scripts/export-provider-contracts.mjs --check <bundle-directory>\n'); return;
  }
  if (args.length === 2 && args[0] === '--check') {
    const manifest = await verifyProviderContractBundle(resolve(args[1]));
    const manifestSha256 = digest(await readFile(join(resolve(args[1]), 'manifest.json')));
    process.stdout.write(json({ status: 'integrity-verified', source: manifest.source.gitCommit, workingTreeDirty: manifest.source.workingTreeDirty, manifestSha256 })); return;
  }
  if (![2, 3].includes(args.length) || args[0] !== '--out' || !args[1] || (args.length === 3 && args[2] !== '--allow-dirty')) throw new Error('Use --help for supported arguments');
  const manifest = await exportProviderContracts({ outputDir: args[1], allowDirty: args[2] === '--allow-dirty' });
  process.stdout.write(json({ status: 'exported', outputDir: resolve(args[1]), source: manifest.source.gitCommit, workingTreeDirty: manifest.source.workingTreeDirty, manifestSha256: digest(json(manifest)) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
