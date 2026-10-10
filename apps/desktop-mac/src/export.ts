// SPDX-License-Identifier: Apache-2.0

interface NativeShell {
  readonly core: { invoke<T>(command: string, args: Readonly<Record<string, unknown>>): Promise<T> };
}

export class ExportFileError extends Error {
  override readonly name = "ExportFileError";
}

interface BinaryExportMetadata {
  readonly format: 'pdf' | 'docx' | 'xlsx';
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentSha256: string;
}
const binaryMediaTypes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const maxExportBytes = 20 * 1024 * 1024;

export async function saveBinaryExport(metadata: BinaryExportMetadata, content: Blob, verifyCurrent: () => Promise<void>, signal?: AbortSignal): Promise<'saved' | 'download_started' | 'cancelled'> {
  signal?.throwIfAborted();
  const { format, fileName, mediaType, byteLength, contentSha256 } = metadata;
  if (!Object.hasOwn(binaryMediaTypes, format) || binaryMediaTypes[format] !== mediaType || !fileName || fileName.startsWith('.') || new TextEncoder().encode(fileName).length > 240
    || /[\\/<>:"|?*\u0000-\u001f\u007f]/u.test(fileName) || !fileName.endsWith(`.${format}`)) throw new ExportFileError('成果文件名或格式无效');
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maxExportBytes || content.size !== byteLength) throw new ExportFileError('成果大小不符或超过 20 MiB，请重新核对导出记录');
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) throw new ExportFileError('成果缺少有效内容摘要');
  const bytes = new Uint8Array(await content.arrayBuffer());
  const header = format === 'pdf' ? [37, 80, 68, 70, 45] : [80, 75, 3, 4];
  if (!header.every((value, index) => bytes[index] === value)) throw new ExportFileError('成果文件内容与格式不符');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') !== contentSha256) throw new ExportFileError('成果内容摘要不符，请重新核对导出记录');
  signal?.throwIfAborted();
  const native = (window as Window & { __TAURI__?: NativeShell }).__TAURI__;
  if (native) {
    let ticket: string | null;
    try { ticket = await native.core.invoke<string | null>('prepare_binary_export', {fileName,mediaType,contentSha256,byteLength}); }
    catch { throw new ExportFileError('保存位置未选择，请重试'); }
    if (ticket === null) return 'cancelled';
    if (typeof ticket !== 'string' || !ticket) throw new ExportFileError('保存凭据无效，请重新选择位置');
    try {
      signal?.throwIfAborted(); await verifyCurrent(); signal?.throwIfAborted();
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
      try { await native.core.invoke('commit_binary_export', {ticket,contentBase64:btoa(binary)}); }
      catch { throw new ExportFileError('文件未保存，请选择新的文件名并检查目录权限'); }
      return 'saved';
    } finally { await native.core.invoke('discard_binary_export', {ticket}).catch(()=>{}); }
  }
  await verifyCurrent(); signal?.throwIfAborted();
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType })), link = document.createElement('a');
  link.href = url; link.download = fileName; document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  return 'download_started';
}

export async function saveJsonExport(title: string, value: unknown): Promise<"saved" | "download_started" | "cancelled"> {
  const stem = title.replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/gu, "_").replace(/^\.+/u, "").slice(0, 64) || "机会成果";
  const fileName = `${stem}.json`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (new TextEncoder().encode(content).byteLength > 20 * 1024 * 1024) throw new ExportFileError("成果文件超过 20 MiB，当前无法保存完整文件；请保留原始资料");
  const native = (window as Window & { __TAURI__?: NativeShell }).__TAURI__;
  if (native) {
    try { return await native.core.invoke<boolean>("save_json_export", { fileName, content }) ? "saved" : "cancelled"; }
    catch { throw new ExportFileError("文件未保存，请选择新的 JSON 文件名并检查目录权限"); }
  }
  const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = fileName;
  document.body.appendChild(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
  return "download_started";
}
