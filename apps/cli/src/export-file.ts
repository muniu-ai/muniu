// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
interface ExportMetadata { readonly format: 'pdf' | 'docx' | 'xlsx'; readonly fileName: string; readonly mediaType: string; readonly byteLength: number; readonly contentSha256: string }
const maxBytes = 20 * 1024 * 1024;
const mediaTypes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export async function saveExportFile(metadata: ExportMetadata, content: Uint8Array, output: string): Promise<void> {
  const path = resolve(output), names = [metadata.fileName, basename(path)];
  if (!Object.hasOwn(mediaTypes, metadata.format) || mediaTypes[metadata.format] !== metadata.mediaType || names.some(name => !name || name.startsWith('.') || Buffer.byteLength(name) > 240 || /[\\/<>:"|?*\u0000-\u001f\u007f]/u.test(name) || !name.endsWith(`.${metadata.format}`))) throw new Error('成果文件名或格式无效');
  if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1 || metadata.byteLength > maxBytes || content.byteLength !== metadata.byteLength) throw new Error('成果大小不符或超过 20 MiB');
  const bytes = Buffer.from(content), header = Buffer.from(metadata.format === 'pdf' ? '%PDF-' : 'PK\x03\x04');
  if (!bytes.subarray(0, header.length).equals(header) || createHash('sha256').update(bytes).digest('hex') !== metadata.contentSha256) throw new Error('成果内容摘要或格式不符');
  const file = await open(path, 'wx', 0o600).catch(() => { throw new Error('文件已存在或目录不可写，请选择新的文件名'); });
  const created = await file.stat();
  try { await file.writeFile(bytes); await file.sync(); }
  catch {
    const current = await lstat(path).catch(() => undefined);
    if (current?.isFile() && current.ino === created.ino && current.dev === created.dev) await unlink(path).catch(() => {});
    throw new Error('成果写入失败，请核对本次文件');
  } finally { await file.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } catch { throw new Error('文件已写入，但目录同步失败，请核对文件'); } finally { await directory.close(); }
}
export async function readExportBytes(response: Response, expectedBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) throw new Error('导出记录的文件大小无效');
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== expectedBytes) throw new Error('下载长度与导出记录不符');
  if (!response.body) throw new Error('成果下载为空');
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > expectedBytes) { await reader.cancel(); throw new Error('下载内容超过导出记录大小'); } chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  if (size !== expectedBytes) throw new Error('下载内容不完整');
  return Buffer.concat(chunks, size);
}
