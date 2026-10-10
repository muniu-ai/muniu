// SPDX-License-Identifier: Apache-2.0
import { posix } from "node:path";
import { crc32 } from "node:zlib";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { fromBufferPromise } from "yauzl";
import { isolatePdfExtraction } from "./document-extraction-pdf-isolation.js";

export interface DocumentLocator {
  readonly page?: number; readonly paragraph?: number; readonly sheet?: string; readonly cell?: string;
  readonly row?: number; readonly column?: number; readonly part?: string;
}
export interface DocumentBlock { readonly id: string; readonly text: string; readonly locator: DocumentLocator }
export interface DocumentIssue { readonly code: string; readonly message: string; readonly locator?: DocumentLocator }
export interface DocumentExtraction {
  readonly extractorVersion: "1"; readonly status: "complete" | "partial" | "unreadable";
  readonly blocks: readonly DocumentBlock[]; readonly issues: readonly DocumentIssue[];
}
export const DOCUMENT_EXTRACTION_LIMITS = Object.freeze({
  inputBytes: 20 * 1024 * 1024, textCharacters: 1_000_000, textBytes: 4 * 1024 * 1024,
  blockCharacters: 20_000, blocks: 10_000, pages: 300, cells: 20_000,
  zipEntries: 2048, zipEntryBytes: 8 * 1024 * 1024, zipTotalBytes: 40 * 1024 * 1024, zipRatio: 100,
  xmlDepth: 128, xmlNodes: 200_000,
  pdfTimeoutMs: 5_000, pdfHeapMiB: 128, pdfRssMiB: 256,
});
export type DocumentExtractionLimits = { -readonly [K in keyof typeof DOCUMENT_EXTRACTION_LIMITS]: number };
type Limits = DocumentExtractionLimits;
export class DocumentExtractionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DocumentExtractionError"; }
}
function fail(code: string, message: string): never { throw new DocumentExtractionError(code, message); }
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORD = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
const SHEET = new Set(["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]);
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"]);

class Extraction {
  readonly blocks: DocumentBlock[] = []; readonly issues: DocumentIssue[] = [];
  private characters = 0; private bytes = 0;
  constructor(readonly limits: Limits) {}
  issue(code: string, message: string, locator?: DocumentLocator): void {
    if (this.issues.length >= this.limits.blocks) fail("DOCUMENT_LIMIT", "资料问题数量超过限制");
    this.issues.push({ code, message, ...(locator ? { locator } : {}) });
  }
  add(text: string, locator: DocumentLocator): void {
    const normalized = text.replace(/\r\n?/gu, "\n").trim();
    if (!normalized) return;
    this.characters += normalized.length; this.bytes += Buffer.byteLength(normalized);
    if (normalized.length > this.limits.blockCharacters || this.characters > this.limits.textCharacters
      || this.bytes > this.limits.textBytes || this.blocks.length >= this.limits.blocks) fail("DOCUMENT_LIMIT", "提取正文超过长度或段落数量限制");
    this.blocks.push({ id: `block-${this.blocks.length + 1}`, text: normalized, locator });
  }
  result(): DocumentExtraction {
    if (!this.blocks.length && !this.issues.length) this.issue("NO_EXTRACTABLE_TEXT", "资料中没有可提取的文字");
    return { extractorVersion: "1", status: !this.blocks.length ? "unreadable" : this.issues.length ? "partial" : "complete", blocks: this.blocks, issues: this.issues };
  }
}

function decode(bytes: Uint8Array): string {
  try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.includes("\0")) fail("DOCUMENT_ENCODING", "资料包含非文本内容"); return text; }
  catch (error) { if (error instanceof DocumentExtractionError) throw error; return fail("DOCUMENT_ENCODING", "资料不是有效的 UTF-8 文本"); }
}
function paragraphs(text: string, output: Extraction, location: DocumentLocator = {}): void {
  const parts = text.replace(/\r\n?/gu, "\n").split(/\n[ \t]*\n/gu);
  parts.forEach((part, index) => output.add(part, { ...location, paragraph: index + 1 }));
}
function columnName(index: number): string {
  let value = index; let label = "";
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
}
function csv(text: string, output: Extraction): void {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; let closed = false; let cellCount = 0;
  const push = () => { if (++cellCount > output.limits.cells) fail("DOCUMENT_LIMIT", "表格单元格数量超过限制"); row.push(field); field = ""; closed = false; };
  const normalized = text.replace(/\r\n?/gu, "\n");
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (quoted) {
      if (char === '"') { if (normalized[index + 1] === '"') { field += '"'; index++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === ",") push();
    else if (char === "\n") { push(); rows.push(row); row = []; }
    else if (char === '"' && field === "" && !closed) quoted = true;
    else if (char === '"' || closed) fail("CSV_INVALID", "CSV 引号或分隔符结构无效");
    else field += char;
    if (field.length > output.limits.blockCharacters) fail("DOCUMENT_LIMIT", "表格单元格文字超过限制");
  }
  if (quoted) fail("CSV_INVALID", "CSV 引号未闭合");
  if (field || row.length || closed || normalized.endsWith(",")) { push(); rows.push(row); }
  const width = rows[0]?.length;
  rows.forEach((cells, rowIndex) => {
    if (cells.length !== width) output.issue("INCONSISTENT_COLUMNS", "此行列数与首行不同", { row: rowIndex + 1 });
    cells.forEach((value, column) => output.add(value, { row: rowIndex + 1, column: column + 1, cell: `${columnName(column + 1)}${rowIndex + 1}` }));
  });
}

function attribute(tag: SaxesTagNS, name: string, namespace?: ReadonlySet<string>): string | undefined {
  return Object.values(tag.attributes).find(attr => attr.local === name && (namespace ? namespace.has(attr.uri) : !attr.uri))?.value;
}
function xml(text: string, limits: Limits, handlers: { root?: { namespaces: ReadonlySet<string>; local: string }; open?: (tag: SaxesTagNS) => void; close?: (tag: SaxesTagNS) => void; text?: (value: string) => void } = {}): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) fail("XML_UNSAFE", "资料不允许包含实体声明");
  const parser = new SaxesParser({ xmlns: true }); let depth = 0; let nodes = 0;
  parser.on("doctype", () => fail("XML_UNSAFE", "资料不允许包含文档类型声明"));
  parser.on("error", () => fail("XML_INVALID", "资料 XML 结构无效"));
  parser.on("opentag", tag => {
    if (++depth > limits.xmlDepth || ++nodes > limits.xmlNodes) fail("DOCUMENT_LIMIT", "XML 嵌套或节点数量超过限制");
    if (depth === 1 && handlers.root && (!handlers.root.namespaces.has(tag.uri) || tag.local !== handlers.root.local)) fail("DOCUMENT_INVALID", "文档部分的 XML 根元素无效");
    handlers.open?.(tag);
  });
  parser.on("closetag", tag => { handlers.close?.(tag); depth--; });
  parser.on("text", value => handlers.text?.(value)); parser.on("cdata", value => handlers.text?.(value));
  try { parser.write(text).close(); }
  catch (error) { if (error instanceof DocumentExtractionError) throw error; fail("XML_INVALID", "资料 XML 无法解析"); }
}

async function archive(bytes: Uint8Array, output: Extraction): Promise<Map<string, string> | undefined> {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    const encrypted = buffer.includes(Buffer.from("EncryptedPackage", "utf16le")) && buffer.includes(Buffer.from("EncryptionInfo", "utf16le"));
    output.issue(encrypted ? "ENCRYPTED_DOCUMENT" : "UNSUPPORTED_CONTAINER", encrypted ? "资料已加密，请提供未加密副本" : "不支持此 Office 容器格式"); return undefined;
  }
  const parts = new Map<string, string>(); const names = new Set<string>(); const limits = output.limits;
  let zip: Awaited<ReturnType<typeof fromBufferPromise>> | undefined;
  let count = 0; let total = 0; let declared = 0;
  try {
    zip = await fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (++count > limits.zipEntries || entry.uncompressedSize > limits.zipEntryBytes
        || (declared += entry.uncompressedSize) > limits.zipTotalBytes
        || entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.zipRatio) fail("ARCHIVE_LIMIT", "归档条目、展开体积或压缩比超过限制");
      if (entry.isEncrypted()) { output.issue("ENCRYPTED_DOCUMENT", "资料已加密，请提供未加密副本"); return undefined; }
      if (names.has(name) || /(^\/|\\|(^|\/)\.\.?(\/|$)|^[a-z]:|[\u0000-\u001f])/iu.test(name)
        || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) fail("ARCHIVE_UNSAFE", "归档包含不安全、重复或链接路径");
      names.add(name);
      if (name.endsWith("/")) continue;
      const stream = await zip.openReadStreamPromise(entry); let size = 0; let checksum = 0; const chunks: Buffer[] = [];
      try {
        for await (const chunk of stream) {
          size += chunk.length; total += chunk.length;
          checksum = crc32(chunk, checksum);
          if (size > limits.zipEntryBytes || total > limits.zipTotalBytes) fail("ARCHIVE_LIMIT", "归档展开体积超过限制");
          if (/\.(?:xml|rels)$/iu.test(name)) chunks.push(Buffer.from(chunk));
        }
      } finally { stream.destroy(); }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32) fail("ARCHIVE_INVALID", "归档内容与声明体积或校验值不一致");
      if (/\.(?:xml|rels)$/iu.test(name)) {
        const value = decode(Buffer.concat(chunks));
        xml(value, limits, { open: tag => {
          if (tag.uri === REL && tag.local === "Relationship" && (attribute(tag, "TargetMode") === "External" || /^[a-z][a-z0-9+.-]*:/iu.test(attribute(tag, "Target") ?? ""))) {
            output.issue("EXTERNAL_LINK_IGNORED", "未访问资料中的外部链接", { part: name });
          }
        } });
        parts.set(name, value);
      }
      if (/vbaProject|activeX|embeddings|scripts/iu.test(name)) output.issue("ACTIVE_CONTENT_IGNORED", "未执行宏、脚本或嵌入对象", { part: name });
      else if (/\/(?:media|charts|drawings)\//u.test(name)) output.issue("UNSUPPORTED_PART", "此部分包含图片、图表或绘图，未提取其视觉内容", { part: name });
    }
    if (!parts.has("[Content_Types].xml")) fail("ARCHIVE_INVALID", "Office 资料缺少内容类型清单");
    return parts;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    return fail("ARCHIVE_INVALID", "Office 归档无效或已损坏");
  } finally { zip?.close(); }
}

function word(parts: Map<string, string>, output: Extraction): void {
  if (!parts.has("word/document.xml")) fail("DOCUMENT_INVALID", "DOCX 缺少正文");
  const selected = [...parts.keys()].filter(name => /^word\/(?:document|footnotes|endnotes|comments|header[0-9]+|footer[0-9]+)\.xml$/u.test(name))
    .sort((a, b) => a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a < b ? -1 : 1);
  for (const part of selected) {
    let paragraph = 0; let value: string | undefined; let text = false; let root = false;
    xml(parts.get(part)!, output.limits, {
      root: { namespaces: WORD, local: /\/header[0-9]+\./u.test(part) ? "hdr" : /\/footer[0-9]+\./u.test(part) ? "ftr" : posix.basename(part, ".xml") },
      open: tag => {
        if (!root) {
          if (!WORD.has(tag.uri) || !["document", "footnotes", "endnotes", "comments", "hdr", "ftr"].includes(tag.local)) fail("DOCUMENT_INVALID", "DOCX 正文根元素无效");
          root = true;
        }
        if (!WORD.has(tag.uri)) return;
        if (tag.local === "p") { if (value !== undefined) fail("DOCUMENT_INVALID", "DOCX 段落结构无效"); paragraph++; value = ""; }
        if (tag.local === "t") text = true;
        if (value !== undefined && ["tab", "br", "cr"].includes(tag.local)) value += tag.local === "tab" ? "\t" : "\n";
        if (["instrText", "altChunk", "object", "drawing", "del", "ins"].includes(tag.local)) output.issue("ACTIVE_CONTENT_IGNORED", "未执行域指令；修订、嵌入对象或绘图可能未完整提取", { part, paragraph: Math.max(1, paragraph) });
      },
      text: content => { if (text && value !== undefined) { value += content; if (value.length > output.limits.blockCharacters) fail("DOCUMENT_LIMIT", "文档单段文字超过限制"); } },
      close: tag => {
        if (!WORD.has(tag.uri)) return;
        if (tag.local === "t") text = false;
        if (tag.local === "p") { output.add(value ?? "", { part, paragraph }); value = undefined; }
      },
    });
  }
}

function cellPosition(cell: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/u.exec(cell);
  if (!match) return fail("DOCUMENT_INVALID", "工作表单元格位置无效");
  const column = [...match[1]!].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0); const row = Number(match[2]);
  if (column > 16384 || row > 1048576) fail("DOCUMENT_INVALID", "工作表单元格位置超出范围");
  return { row, column };
}
function workbook(parts: Map<string, string>, output: Extraction): void {
  if (!parts.has("xl/workbook.xml") || !parts.has("xl/_rels/workbook.xml.rels")) fail("DOCUMENT_INVALID", "XLSX 缺少工作簿或关系清单");
  const shared: string[] = []; let sharedValue: string | undefined; let sharedText = false; let phonetic = 0;
  if (parts.has("xl/sharedStrings.xml")) xml(parts.get("xl/sharedStrings.xml")!, output.limits, {
    root: { namespaces: SHEET, local: "sst" },
    open: tag => { if (!SHEET.has(tag.uri)) return; if (tag.local === "si") sharedValue = ""; if (tag.local === "rPh") phonetic++; if (tag.local === "t" && !phonetic) sharedText = true; },
    text: value => { if (sharedText && sharedValue !== undefined) { sharedValue += value; if (sharedValue.length > output.limits.blockCharacters) fail("DOCUMENT_LIMIT", "共享字符串超过限制"); } },
    close: tag => { if (!SHEET.has(tag.uri)) return; if (tag.local === "t") sharedText = false; if (tag.local === "rPh") phonetic--; if (tag.local === "si") { shared.push(sharedValue ?? ""); sharedValue = undefined; } },
  });
  const relationships = new Map<string, string>();
  xml(parts.get("xl/_rels/workbook.xml.rels")!, output.limits, { root: { namespaces: new Set([REL]), local: "Relationships" }, open: tag => {
    if (tag.uri !== REL || tag.local !== "Relationship" || !/\/worksheet$/u.test(attribute(tag, "Type") ?? "") || attribute(tag, "TargetMode") === "External") return;
    const id = attribute(tag, "Id"); const target = attribute(tag, "Target");
    if (!id || !target || relationships.has(id) || /(\\|(^|\/)\.\.?(\/|$)|:|%)/u.test(target)) fail("ARCHIVE_UNSAFE", "工作表引用路径无效");
    const path = target.startsWith("/") ? target.slice(1) : posix.join("xl", target);
    if (!/^xl\/worksheets\/[^/]+\.xml$/u.test(path)) fail("ARCHIVE_UNSAFE", "工作表引用必须指向归档内的工作表");
    relationships.set(id, path);
  } });
  const sheets: { name: string; relation?: string }[] = [];
  xml(parts.get("xl/workbook.xml")!, output.limits, { root: { namespaces: SHEET, local: "workbook" }, open: tag => {
    if (!SHEET.has(tag.uri) || tag.local !== "sheet") return;
    const name = attribute(tag, "name"); if (!name || sheets.some(sheet => sheet.name === name)) fail("DOCUMENT_INVALID", "工作表名称无效或重复");
    sheets.push({ name, relation: attribute(tag, "id", OFFICE_REL) });
    if (attribute(tag, "state") && attribute(tag, "state") !== "visible") output.issue("HIDDEN_SHEET", "此工作表在原文件中隐藏，按保存内容提取", { sheet: name });
  } });
  if (!sheets.length) fail("DOCUMENT_INVALID", "XLSX 没有可识别的工作表");
  let count = 0;
  for (const sheet of sheets) {
    const part = sheet.relation ? relationships.get(sheet.relation) : undefined;
    if (!part || !parts.has(part)) { output.issue("MISSING_SHEET", "无法读取工作表内容", { sheet: sheet.name }); continue; }
    const seen = new Set<string>();
    let cell: { name: string; type: string; value: string; inline: string; formula: boolean; formatted: boolean } | undefined;
    let capture: "value" | "inline" | undefined;
    xml(parts.get(part)!, output.limits, {
      root: { namespaces: SHEET, local: "worksheet" },
      open: tag => {
        if (!SHEET.has(tag.uri)) return;
        if (tag.local === "c") {
          const name = attribute(tag, "r"); if (!name || seen.has(name) || cell) fail("DOCUMENT_INVALID", "工作表单元格位置缺失、重复或嵌套"); cellPosition(name); seen.add(name);
          if (++count > output.limits.cells) fail("DOCUMENT_LIMIT", "表格单元格数量超过限制");
          cell = { name, type: attribute(tag, "t") ?? "n", value: "", inline: "", formula: false, formatted: Boolean(attribute(tag, "s") && attribute(tag, "s") !== "0") };
        }
        if (cell && tag.local === "f") cell.formula = true;
        if (cell && tag.local === "v") capture = "value";
        if (cell && tag.local === "t") capture = "inline";
      },
      text: value => { if (cell && capture) { cell[capture] += value; if (cell[capture].length > output.limits.blockCharacters) fail("DOCUMENT_LIMIT", "表格单元格文字超过限制"); } },
      close: tag => {
        if (!SHEET.has(tag.uri)) return;
        if (tag.local === "v" || tag.local === "t") capture = undefined;
        if (tag.local !== "c" || !cell) return;
        const locator = { sheet: sheet.name, cell: cell.name, ...cellPosition(cell.name) };
        if (cell.formula) output.issue("FORMULA_NOT_EVALUATED", "只读取公式已保存的缓存值，未重新计算", locator);
        if (cell.formatted) output.issue("FORMATTING_NOT_APPLIED", "只读取单元格保存值，未应用数字或日期显示格式", locator);
        let value: string | undefined = cell.value;
        if (cell.type === "s") value = /^(0|[1-9][0-9]*)$/u.test(value) ? shared[Number(value)] : undefined;
        else if (cell.type === "inlineStr") value = cell.inline;
        else if (cell.type === "b") value = value === "1" ? "true" : value === "0" ? "false" : undefined;
        else if (cell.type === "e") output.issue("CELL_ERROR", "单元格保存值为错误，不能作为有效计算结果", locator);
        else if (!["n", "str", "d"].includes(cell.type)) value = undefined;
        if (value === undefined || (cell.formula && value === "")) output.issue("MISSING_CELL_VALUE", "单元格内容缺失或无法解释", locator);
        else output.add(value, locator);
        cell = undefined;
      },
    });
  }
}

/** Internal child-process entry; the public extractor always uses process isolation. */
export async function extractPdfInChild(bytes: Uint8Array, limits: Limits): Promise<DocumentExtraction> {
  const output = new Extraction(limits);
  await pdf(bytes, output);
  return output.result();
}

async function pdf(bytes: Uint8Array, output: Extraction): Promise<void> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // @ts-expect-error PDF.js has no declaration for the worker bundle.
  const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };
  class DenyExternalData { async fetch(): Promise<never> { return fail("EXTERNAL_DATA_DENIED", "PDF 所需的外部字体或数据未获准读取"); } }
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, useWasm: false,
    enableXfa: false, ...{ isEvalSupported: false }, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true,
    disableAutoFetch: true, disableStream: true, disableRange: true, BinaryDataFactory: DenyExternalData, verbosity: 0 });
  try {
    const document = await task.promise;
    if (await document.getPermissions() !== null) { output.issue("ENCRYPTED_DOCUMENT", "PDF 已加密，请提供未加密副本"); return; }
    if (document.numPages > output.limits.pages) fail("DOCUMENT_LIMIT", "PDF 页数超过限制");
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const before = output.blocks.length;
      try {
        const page = await document.getPage(pageNumber); const reader = page.streamTextContent().getReader(); let value = ""; let paragraph = 0;
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break;
            for (const text of item.value.items) {
              if (!("str" in text)) continue;
              value += text.str;
              if (value.length > output.limits.blockCharacters) fail("DOCUMENT_LIMIT", "PDF 单段文字超过限制");
              if (text.hasEOL) { output.add(value, { page: pageNumber, paragraph: ++paragraph }); value = ""; } else value += " ";
            }
          }
          output.add(value, { page: pageNumber, paragraph: ++paragraph });
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); page.cleanup(); }
        if (output.blocks.length === before) output.issue("NO_PAGE_TEXT", "此页没有可提取的文字，可能是扫描页或空白页；未执行 OCR", { page: pageNumber });
      } catch (error) {
        if (error instanceof DocumentExtractionError && error.code === "DOCUMENT_LIMIT") throw error;
        output.issue("PAGE_UNREADABLE", "此页未能完整提取，不能视为已读取", { page: pageNumber });
      }
    }
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    const encrypted = error instanceof Error && error.name === "PasswordException";
    output.issue(encrypted ? "ENCRYPTED_DOCUMENT" : "INVALID_PDF", encrypted ? "PDF 已加密，请提供未加密副本" : "PDF 无法解析，请提供有效文件");
  } finally { await task.destroy(); }
}

export async function extractDocument(input: { readonly fileName: string; readonly mediaType: string; readonly bytes: Uint8Array }, overrides: Partial<Limits> = {}): Promise<DocumentExtraction> {
  const limits: Limits = { ...DOCUMENT_EXTRACTION_LIMITS };
  for (const key of Object.keys(overrides) as (keyof Limits)[]) {
    const value = overrides[key];
    if (!(key in DOCUMENT_EXTRACTION_LIMITS) || value === undefined || !Number.isSafeInteger(value) || value <= 0 || value > limits[key]) fail("INVALID_LIMIT", "提取限制只能在默认上限内缩紧");
    limits[key] = value;
  }
  if (input.bytes.byteLength > limits.inputBytes) fail("DOCUMENT_LIMIT", "资料文件超过大小限制");
  const output = new Extraction(limits);
  if (["text/plain", "text/markdown", "application/json", "text/csv"].includes(input.mediaType)) {
    try {
      const text = decode(input.bytes);
      if (input.mediaType === "application/json") { try { JSON.parse(text); } catch { fail("JSON_INVALID", "JSON 结构无效"); } }
      if (input.mediaType === "text/csv") csv(text, output); else paragraphs(text, output);
    } catch (error) {
      if (!(error instanceof DocumentExtractionError) || !["DOCUMENT_ENCODING", "CSV_INVALID", "JSON_INVALID"].includes(error.code)) throw error;
      output.blocks.splice(0); output.issue(error.code, error.message);
    }
  } else if (input.mediaType === DOCX || input.mediaType === XLSX) {
    const parts = await archive(input.bytes, output); if (parts) { if (input.mediaType === DOCX) word(parts, output); else workbook(parts, output); }
  } else if (input.mediaType === "application/pdf") {
    const result = await isolatePdfExtraction(input.bytes, limits);
    for (const block of result.blocks) output.add(block.text, block.locator);
    for (const issue of result.issues) output.issue(issue.code, issue.message, issue.locator);
  }
  else output.issue("UNSUPPORTED_FORMAT", "此格式尚不支持正文提取");
  return output.result();
}
