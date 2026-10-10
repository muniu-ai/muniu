// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync, deflateSync } from "node:zlib";
import { extractDocument, DocumentExtractionError } from "../src/document-extraction.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const input = (mediaType: string, bytes: string | Uint8Array) => ({ fileName: `source.${mediaType === DOCX ? "docx" : mediaType === XLSX ? "xlsx" : mediaType.split("/")[1] === "plain" ? "txt" : mediaType.split("/")[1]}`, mediaType, bytes: typeof bytes === "string" ? Buffer.from(bytes) : bytes });

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: readonly { name: string; value: string; compressed?: boolean; encrypted?: boolean; mode?: number; claimedSize?: number }[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const original = Buffer.from(entry.value); const compressed = entry.compressed ? deflateRawSync(original) : original;
    const data = entry.encrypted ? Buffer.concat([Buffer.alloc(12), compressed]) : compressed;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(entry.compressed ? 8 : 0, 8); header.writeUInt32LE(crc32(original), 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.claimedSize ?? original.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.encrypted ? 1 : 0, 8); directory.writeUInt16LE(entry.compressed ? 8 : 0, 10); directory.writeUInt32LE(crc32(original), 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(entry.claimedSize ?? original.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(entries.length, 8); tail.writeUInt16LE(entries.length, 10);
  tail.writeUInt32LE(Buffer.concat(central).length, 12); tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, tail]);
}
function docx(body: string, more: Parameters<typeof zip>[0] = []): Buffer {
  return zip([{ name: "[Content_Types].xml", value: contentTypes }, { name: "word/document.xml", value: `<w:document xmlns:w="${WORD}"><w:body>${body}</w:body></w:document>` }, ...more]);
}
function xlsx(cells: string, more: Parameters<typeof zip>[0] = []): Buffer {
  return zip([
    { name: "[Content_Types].xml", value: contentTypes },
    { name: "xl/workbook.xml", value: `<workbook xmlns="${SHEET}" xmlns:r="${OFFICE_REL}"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", value: `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", value: `<worksheet xmlns="${SHEET}"><sheetData><row r="1">${cells}</row></sheetData></worksheet>` }, ...more,
  ]);
}
function pdf(pages: readonly (string | null)[], options: { encrypted?: boolean; script?: boolean; expandedPadding?: number } = {}): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const [index, text] of pages.entries()) {
    const plain = text === null ? "" : `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
    const content = options.expandedPadding ? deflateSync(Buffer.concat([Buffer.alloc(options.expandedPadding, 32), Buffer.from(plain)])).toString("latin1") : plain;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(content, "latin1")}${options.expandedPadding ? " /Filter /FlateDecode" : ""} >>\nstream\n${content}\nendstream`);
  }
  let trailer = "";
  if (options.encrypted) {
    const id = objects.length + 1;
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
    trailer = ` /Encrypt ${id} 0 R /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]`;
  }
  if (options.script) {
    objects[0] = `<< /Type /Catalog /Pages 2 0 R /OpenAction ${objects.length + 1} 0 R >>`;
    objects.push("<< /S /JavaScript /JS (globalThis.__documentScriptExecuted = true) >>");
  }
  let value = "%PDF-1.7\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(value, "latin1")); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(value, "latin1"); value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(value, "latin1");
}

test("UTF-8 text and Markdown preserve paragraph source positions", async () => {
  const result = await extractDocument(input("text/plain", "第一段\r\n续行\r\n\r\n第二段"));
  assert.equal(result.status, "complete"); assert.equal(result.extractorVersion, "1");
  assert.deepEqual(result.blocks.map(b => [b.text, b.locator.paragraph]), [["第一段\n续行", 1], ["第二段", 2]]);
  assert.equal((await extractDocument(input("text/markdown", "# 标题\n\n段落"))).blocks[1]!.locator.paragraph, 2);
  assert.equal((await extractDocument(input("application/json", '{"value":1}'))).status, "complete");
});

test("invalid encoding, empty content and unsupported format never claim complete", async () => {
  assert.equal((await extractDocument(input("text/plain", new Uint8Array([255])))).status, "unreadable");
  assert.equal((await extractDocument(input("text/plain", " \n\n"))).status, "unreadable");
  assert.equal((await extractDocument(input("application/json", "{broken"))).status, "unreadable");
  assert.equal((await extractDocument(input("image/png", "image"))).status, "unreadable");
});

test("CSV handles escaped quotes, multiline cells, empty cells and literal formulas", async () => {
  const result = await extractDocument(input("text/csv", '名称,说明,金额\r\n"甲,乙","两行\n""引文""",100\r\n空,,=1+1'));
  assert.equal(result.status, "complete");
  assert.equal(result.blocks.find(b => b.locator.cell === "A2")!.text, "甲,乙");
  assert.equal(result.blocks.find(b => b.locator.cell === "B2")!.text, '两行\n"引文"');
  assert.equal(result.blocks.find(b => b.locator.cell === "C3")!.text, "=1+1");
  assert.equal(result.blocks.find(b => b.locator.cell === "C3")!.locator.row, 3);
  assert.equal((await extractDocument(input("text/csv", 'a,"unterminated'))).status, "unreadable");
});

test("DOCX extracts namespaced paragraphs, tables, tabs and notes with part locators", async () => {
  const result = await extractDocument(input(DOCX, docx('<w:p><w:r><w:t>标题 &amp; 内容</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格</w:t><w:tab/><w:t>第二列</w:t></w:r></w:p></w:tc></w:tr></w:tbl>', [{ name: "word/footnotes.xml", value: `<w:footnotes xmlns:w="${WORD}"><w:footnote w:id="1"><w:p><w:r><w:t>注释</w:t></w:r></w:p></w:footnote></w:footnotes>` }])));
  assert.equal(result.status, "complete"); assert.deepEqual(result.blocks.map(b => b.text), ["标题 & 内容", "表格\t第二列", "注释"]);
  assert.deepEqual(result.blocks[2]!.locator, { part: "word/footnotes.xml", paragraph: 1 });
});

test("DOCX ignores macros, embedded objects, links and instructions while reporting partial extraction", async () => {
  const result = await extractDocument(input(DOCX, docx('<w:p><w:r><w:t>正文</w:t><w:instrText>FETCH SECRET</w:instrText></w:r></w:p>', [
    { name: "word/vbaProject.bin", value: "malicious" },
    { name: "word/_rels/document.xml.rels", value: `<Relationships xmlns="${REL}"><Relationship Id="link" Type="${OFFICE_REL}/hyperlink" Target="https://invalid.example" TargetMode="External"/></Relationships>` },
  ])));
  assert.equal(result.status, "partial"); assert.equal(result.blocks[0]!.text, "正文");
  assert.ok(result.issues.some(issue => issue.code === "ACTIVE_CONTENT_IGNORED"));
  assert.ok(result.issues.some(issue => issue.code === "EXTERNAL_LINK_IGNORED"));
});

test("XLSX extracts shared, inline, numeric, boolean and cached formula cells without calculation", async () => {
  const result = await extractDocument(input(XLSX, xlsx('<c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>项目</t></is></c><c r="C1"><v>1200</v></c><c r="D1" t="b"><v>1</v></c><c r="E1"><f>C1*2</f><v>2400</v></c>', [
    { name: "xl/sharedStrings.xml", value: `<sst xmlns="${SHEET}"><si><r><t>共享</t></r><r><t>文本</t></r></si></sst>` },
  ])));
  assert.equal(result.status, "partial");
  assert.deepEqual(result.blocks.map(b => b.text), ["共享文本", "项目", "1200", "true", "2400"]);
  assert.deepEqual(result.blocks[0]!.locator, { sheet: "预算", cell: "A1", row: 1, column: 1 });
  assert.ok(result.issues.some(issue => issue.code === "FORMULA_NOT_EVALUATED"));
});

test("missing formula caches, unknown shared strings and unsupported XLSX parts are not hidden", async () => {
  const result = await extractDocument(input(XLSX, xlsx('<c r="A1"><v>5</v></c><c r="B1"><f>1+1</f></c><c r="C1" t="s"><v>77</v></c>', [{ name: "xl/charts/chart1.xml", value: '<chart xmlns="urn:chart"/>' }])));
  assert.equal(result.status, "partial"); assert.deepEqual(result.blocks.map(b => b.text), ["5"]);
  assert.ok(result.issues.some(issue => issue.code === "MISSING_CELL_VALUE"));
  assert.ok(result.issues.some(issue => issue.code === "UNSUPPORTED_PART"));
});

test("PDF text keeps page locators and textless pages report coverage gaps", async () => {
  const full = await extractDocument(input("application/pdf", pdf(["Page one", "Page two"])));
  assert.equal(full.status, "complete"); assert.deepEqual(full.blocks.map(b => b.locator.page), [1, 2]);
  const partial = await extractDocument(input("application/pdf", pdf(["Only text", null])));
  assert.equal(partial.status, "partial"); assert.ok(partial.issues.some(i => i.code === "NO_PAGE_TEXT" && i.locator?.page === 2));
  assert.equal((await extractDocument(input("application/pdf", pdf([null])))).status, "unreadable");
});

test("PDF encryption is explicit and document scripts cannot execute or fetch", async () => {
  const encrypted = await extractDocument(input("application/pdf", pdf(["hidden"], { encrypted: true })));
  assert.equal(encrypted.status, "unreadable"); assert.equal(encrypted.issues[0]!.code, "ENCRYPTED_DOCUMENT");
  const saved = globalThis.fetch; let requests = 0;
  const scope = globalThis as typeof globalThis & { __documentScriptExecuted?: boolean };
  try {
    globalThis.fetch = async () => { requests++; throw new Error("network prohibited"); };
    const result = await extractDocument(input("application/pdf", pdf(["safe"], { script: true })));
    assert.equal(result.blocks[0]!.text, "safe"); assert.equal(scope.__documentScriptExecuted, undefined); assert.equal(requests, 0);
  } finally { globalThis.fetch = saved; delete scope.__documentScriptExecuted; }
});

test("XLSX supports archive-root worksheet references and rejects wrong XML roots", async () => {
  const source = [
    { name: "[Content_Types].xml", value: contentTypes },
    { name: "xl/workbook.xml", value: `<workbook xmlns="${SHEET}" xmlns:r="${OFFICE_REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", value: `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", value: `<worksheet xmlns="${SHEET}"><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>` },
  ];
  assert.equal((await extractDocument(input(XLSX, zip(source)))).blocks[0]!.text, "7");
  source[3]!.value = source[3]!.value.replaceAll("worksheet", "fake");
  await assert.rejects(extractDocument(input(XLSX, zip(source))), DocumentExtractionError);
});

test("encrypted Office containers and encrypted ZIP are unreadable with explicit reason", async () => {
  const encrypted = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("EncryptedPackage\0EncryptionInfo", "utf16le")]);
  const result = await extractDocument(input(DOCX, encrypted));
  assert.equal(result.status, "unreadable"); assert.equal(result.issues[0]!.code, "ENCRYPTED_DOCUMENT");
  const encryptedZip = zip([{ name: "word/document.xml", value: "hidden", encrypted: true }]);
  assert.equal((await extractDocument(input(DOCX, encryptedZip))).issues[0]!.code, "ENCRYPTED_DOCUMENT");
});

test("ZIP traversal, duplicate names, symlinks, entities and malformed XML fail closed", async () => {
  for (const extra of [
    [{ name: "../private.xml", value: "x" }],
    [{ name: "word/document.xml", value: "duplicate" }],
    [{ name: "word/link.xml", value: "outside", mode: 0o120777 }],
    [{ name: "ignored.xml", value: '<!DOCTYPE x [<!ENTITY danger SYSTEM "file:///secret">]><x>&danger;</x>' }],
  ]) await assert.rejects(extractDocument(input(DOCX, docx('<w:p><w:r><w:t>safe</w:t></w:r></w:p>', extra))), DocumentExtractionError);
  await assert.rejects(extractDocument(input(DOCX, docx('<w:p><w:r><w:t>broken</w:p>'))), DocumentExtractionError);
});

test("ZIP integrity mismatch and fake document roots cannot produce trusted text", async () => {
  const corrupt = docx('<w:p><w:r><w:t>safe</w:t></w:r></w:p>');
  const index = corrupt.indexOf(Buffer.from("safe")); corrupt[index] = "b".charCodeAt(0);
  await assert.rejects(extractDocument(input(DOCX, corrupt)), DocumentExtractionError);
  await assert.rejects(extractDocument(input(DOCX, zip([
    { name: "[Content_Types].xml", value: contentTypes },
    { name: "word/document.xml", value: `<w:fake xmlns:w="${WORD}"><w:p><w:r><w:t>fake</w:t></w:r></w:p></w:fake>` },
  ]))), DocumentExtractionError);
});

test("input, ZIP, XML, output, CSV cells and PDF pages obey hard limits", async () => {
  await assert.rejects(extractDocument(input("text/plain", "12345"), { inputBytes: 4 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input("text/plain", "12345"), { textCharacters: 4 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input("text/plain", "中文"), { textBytes: 5 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input("text/plain", "abc"), { blockCharacters: 2 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input("text/plain", "a\n\nb"), { blocks: 1 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input("text/csv", "a,b"), { cells: 1 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input("application/pdf", pdf(["a", "b"])), { pages: 1 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input(DOCX, docx('<w:p><w:r><w:t>x</w:t></w:r></w:p>')), { xmlDepth: 3 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input(DOCX, docx('<w:p/>')), { zipEntries: 1 }), DocumentExtractionError);
  await assert.rejects(extractDocument(input(DOCX, zip([{ name: "[Content_Types].xml", value: "x".repeat(200000), compressed: true }]))), DocumentExtractionError);
});

test("PDF decompression is terminated at its deadline while the Host event loop remains responsive", async () => {
  const bytes = pdf(["safe"], { expandedPadding: 64 * 1024 * 1024 });
  assert.ok(bytes.length < 100_000);
  let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 30);
  const started = performance.now();
  try {
    await assert.rejects(extractDocument(input("application/pdf", bytes), { pdfTimeoutMs: 150 }),
      (error: unknown) => error instanceof DocumentExtractionError && error.code === "DOCUMENT_LIMIT");
    assert.equal(responsive, true);
    assert.ok(performance.now() - started < 2_000);
  } finally { clearTimeout(timer); }
  assert.equal((await extractDocument(input("application/pdf", pdf(["after cancellation"])))).status, "complete");
});

test("PDF parser enforces memory, queues a third file and bounds queued work", async () => {
  await assert.rejects(extractDocument(input("application/pdf", pdf(["memory"])), { pdfRssMiB: 1 }),
    (error: unknown) => error instanceof DocumentExtractionError && error.code === "DOCUMENT_LIMIT");
  const bytes = pdf(["safe"], { expandedPadding: 64 * 1024 * 1024 });
  const files = await Promise.all(Array.from({ length: 3 }, () => extractDocument(input("application/pdf", pdf(["queued"])))));
  assert.ok(files.every(result => result.status === "complete"));
  const pending = Promise.allSettled(Array.from({ length: 8 }, () => extractDocument(input("application/pdf", bytes), { pdfTimeoutMs: 250 })));
  await assert.rejects(extractDocument(input("application/pdf", pdf(["third"]))),
    (error: unknown) => error instanceof DocumentExtractionError && error.code === "DOCUMENT_BUSY");
  assert.ok((await pending).every(result => result.status === "rejected"));
});

test("large non-text PDF streams are rejected under the default process budget", async () => {
  const bytes = pdf(["safe"], { expandedPadding: 128 * 1024 * 1024 });
  assert.ok(bytes.length < 150_000);
  await assert.rejects(extractDocument(input("application/pdf", bytes)),
    (error: unknown) => error instanceof DocumentExtractionError && error.code === "DOCUMENT_LIMIT");
});
