// SPDX-License-Identifier: Apache-2.0

interface NativeShell {
  readonly core: { invoke<T>(command: string, args: Readonly<Record<string, unknown>>): Promise<T> };
}

export class ExportFileError extends Error {
  override readonly name = "ExportFileError";
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
