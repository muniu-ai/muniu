// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktopDir, "../..");
const apiUrl = `http://127.0.0.1:${await freePort()}`;
const appUrl = `http://127.0.0.1:${await freePort()}`;
const children = [];
let browser;
try {
  launch(process.execPath, [join(desktopDir, "scripts/real-host-fixture.mjs")], root,
    { MN_FIXTURE_API_PORT: new URL(apiUrl).port, MN_FIXTURE_APP_ORIGIN: appUrl, MN_FIXTURE_MODE: "tasks" });
  await ready(`${apiUrl}/v2/health`);
  launch(join(root, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", new URL(appUrl).port, "--strictPort"], desktopDir, { VITE_MN_API_URL: apiUrl });
  await ready(appUrl);
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "资料验收需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem("muniu:v2:onboarding-complete", "1"));
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  await page.goto(appUrl);
  await page.getByRole("button", { name: "委派任务", exact: true }).click();
  const composer = page.getByRole("form", { name: "委派新任务" });
  await composer.getByLabel("任务目标", { exact: true }).fill("检查文档来源");
  await composer.getByLabel("验收要求", { exact: true }).fill("保留提取位置并说明遗漏");
  const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const sheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
  const officeRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const types = ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'];
  const files = [
    { name: "项目.docx", mimeType: "", buffer: zip([types, ["word/document.xml", `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:t>交付要求</w:t></w:r></w:p></w:body></w:document>`]]), status: "已解析", locator: "word/document.xml · 第 1 段", text: "交付要求" },
    { name: "预算.xlsx", mimeType: "", buffer: zip([types, ["xl/workbook.xml", `<workbook xmlns="${sheet}" xmlns:r="${officeRel}"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>`], ["xl/_rels/workbook.xml.rels", `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${officeRel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`], ["xl/worksheets/sheet1.xml", `<worksheet xmlns="${sheet}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>服务费</t></is></c><c r="B1"><f>100+20</f><v>120</v></c></row></sheetData></worksheet>`]]), status: "部分解析，请核对遗漏", locator: "工作表 预算 · 单元格 A1", text: "服务费" },
    { name: "研究.pdf", mimeType: "application/pdf", buffer: pdf(), status: "部分解析，请核对遗漏", locator: "第 1 页 · 第 1 段", text: "Evidence text" },
  ];
  for (const file of files) {
    await composer.getByLabel("添加文本资料").setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
    await composer.getByText(file.status, { exact: true }).waitFor().catch(async error => { throw new Error(`${error.message}\n${await composer.innerText()}`); });
    await composer.getByRole("button", { name: file.name, exact: true }).click();
    await composer.getByText(file.locator, { exact: true }).waitFor();
    await composer.getByText(file.text, { exact: true }).waitFor();
    assert.equal(await composer.getByRole("button", { name: "准备执行计划", exact: true }).isEnabled(), true);
    await composer.getByRole("button", { name: `移除 ${file.name}`, exact: true }).click();
  }
  console.log(JSON.stringify({ ok: true, scenarios: ["docx-paragraph", "xlsx-partial-and-cell", "pdf-partial-and-page"] }));
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => process.stderr.write(chunk)); children.push(child);
}
function freePort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(address.port)); }); }); }
async function ready(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch { /* Wait for the isolated fixture. */ } await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  throw new Error(`服务未就绪：${url}`);
}

function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [path, value] of entries) {
    const name = Buffer.from(path), bytes = Buffer.from(value); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += header.length + name.length + bytes.length;
  }
  const tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(entries.length, 8); tail.writeUInt16LE(entries.length, 10); tail.writeUInt32LE(Buffer.concat(central).length, 12); tail.writeUInt32LE(offset, 16); return Buffer.concat([...local, ...central, tail]);
}
function pdf() {
  const text = "BT /F1 12 Tf 40 700 Td (Evidence text) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>", "<< /Length 0 >>\nstream\n\nendstream"];
  let value = "%PDF-1.7\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(value); value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`; return Buffer.from(value);
}
