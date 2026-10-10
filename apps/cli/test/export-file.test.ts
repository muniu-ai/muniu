// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveExportFile, readExportBytes } from '../src/export-file.js';

const content = Buffer.from('%PDF-1.7\nSynthetic output\n%%EOF');
const metadata = { format: 'pdf' as const, fileName: '成果.pdf', mediaType: 'application/pdf', byteLength: content.length, contentSha256: createHash('sha256').update(content).digest('hex') };
test('CLI按固定摘要独占保存文件，不覆盖现有文件或符号链接', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mn-cli-export-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, '成果.pdf');
  await saveExportFile(metadata, content, output);
  assert.deepEqual(await readFile(output), content); assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(() => saveExportFile(metadata, content, output));
  const alias = join(directory, 'alias.pdf'); await symlink(output, alias); await assert.rejects(() => saveExportFile(metadata, content, alias));
  assert.deepEqual(await readFile(output), content);
});
test('CLI在写文件前拒绝改名脚本、错误大小摘要和伪造文件格式', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mn-cli-export-invalid-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, '成果.pdf');
  for (const changed of [{ contentSha256: '0'.repeat(64) }, { byteLength: 1 }, { mediaType: 'text/plain' }]) await assert.rejects(() => saveExportFile({ ...metadata, ...changed }, content, output));
  await assert.rejects(() => saveExportFile(metadata, content, join(directory, 'script.sh')));
  const fake = Buffer.from('not a PDF'); await assert.rejects(() => saveExportFile({ ...metadata, byteLength: fake.length, contentSha256: createHash('sha256').update(fake).digest('hex') }, fake, output));
  await assert.rejects(() => stat(output));
});
test('CLI有界读取下载流，拒绝超出服务器固定长度和20MiB上限', async () => {
  assert.deepEqual(await readExportBytes(new Response(content), content.length), content);
  await assert.rejects(() => readExportBytes(new Response(content), content.length - 1));
  await assert.rejects(() => readExportBytes(new Response(content), 20 * 1024 * 1024 + 1));
  await assert.rejects(() => readExportBytes(new Response(content), content.length + 1));
});
