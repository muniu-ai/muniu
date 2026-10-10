// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Readable} from 'node:stream';
import {ZipFile} from 'yazl';
import {create as createFont} from 'fontkit';
import type {GoalExportFormatV2} from '@mn/contracts';
import {EXPORT_FONT_BYTES,EXPORT_FONT_SHA256,EXPORT_MAX_BYTES,GoalExportError,validateExportDocument,type GoalExportDocument} from './goal-export-renderer-types.js';
// The audited Node entry avoids the ESM package entry's runtime createRequire adapter when bundled.
import PDFDocument from 'pdfkit';
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const declaration='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const rels=(target:string,type:string)=>declaration+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;
function lines(doc:GoalExportDocument):string[]{return [doc.title,`来源：${doc.sourceLabel}`,`成果接收：${doc.accepted?'已接收':'尚未接收'}`,`导出时间：${doc.createdAt}`,'',...doc.text.replace(/\r\n?/g,'\n').split('\n')];}
async function zip(entries:Record<string,string>):Promise<Uint8Array>{
 const archive=new ZipFile();const chunks:Buffer[]=[];let count=0;
 const result=new Promise<Uint8Array>((resolve,reject)=>{archive.outputStream.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>EXPORT_MAX_BYTES){(archive.outputStream as Readable).destroy(new GoalExportError('EXPORT_LIMIT','导出文件超过大小限制'));return;}chunks.push(chunk);});archive.outputStream.once('error',reject);archive.outputStream.once('end',()=>resolve(Buffer.concat(chunks)));});
 for(const [name,body] of Object.entries(entries))archive.addBuffer(Buffer.from(body),name,{mtime:new Date('2000-01-01T00:00:00Z'),mode:0o100600,compress:true});
 archive.end();return result;
}
function docx(doc:GoalExportDocument):Promise<Uint8Array>{
 const paragraphs=lines(doc).map((line,i)=>`<w:p><w:pPr>${i===0?'<w:pStyle w:val="Title"/>':''}<w:spacing w:after="${i===0?'240':'120'}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Noto Sans CJK SC" w:eastAsia="Noto Sans CJK SC" w:hAnsi="Noto Sans CJK SC"/><w:sz w:val="${i===0?'32':'22'}"/></w:rPr><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join('');
 return zip({'[Content_Types].xml':declaration+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
 '_rels/.rels':rels('word/document.xml','officeDocument'),
 'word/_rels/document.xml.rels':rels('styles.xml','styles'),
 'word/styles.xml':declaration+'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="000000"/><w:sz w:val="32"/></w:rPr></w:style></w:styles>',
 'word/document.xml':declaration+`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`});
}
function xlsx(doc:GoalExportDocument):Promise<Uint8Array>{
 // Every value is inline text, including leading =/+/-/@. No formula, external relationship, macro, or hyperlink is emitted.
 const values=lines(doc),widthUnits=(s:string)=>[...s].reduce((n,c)=>n+(c.codePointAt(0)!>255?2:1),0);if(values.some(x=>x.length>32767 || widthUnits(x)>1125))throw new GoalExportError('EXPORT_LIMIT','单个工作表单元格超过字符限制');
 const rows=values.map((s,i)=>`<row r="${i+1}" ht="${Math.max(30,Math.ceil(widthUnits(s)/75)*24+8)}" customHeight="1"><c r="A${i+1}" s="0" t="inlineStr"><is><t xml:space="preserve">${xml(s)}</t></is></c></row>`).join('');
 return zip({'[Content_Types].xml':declaration+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
 '_rels/.rels':rels('xl/workbook.xml','officeDocument'),
 'xl/workbook.xml':declaration+'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="成果" sheetId="1" r:id="rId1"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':declaration+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
 'xl/styles.xml':declaration+'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Noto Sans CJK SC"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
 'xl/worksheets/sheet1.xml':declaration+`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="100" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`});
}
async function pdf(doc:GoalExportDocument,fontPath:string):Promise<Uint8Array>{
 const bytes=await readFile(fontPath);if(bytes.length!==EXPORT_FONT_BYTES || createHash('sha256').update(bytes).digest('hex')!==EXPORT_FONT_SHA256)throw new GoalExportError('EXPORT_FONT_INVALID','导出字体校验失败');
 const font=createFont(bytes);if(!('hasGlyphForCodePoint' in font))throw new GoalExportError('EXPORT_FONT_INVALID','导出字体格式无效');
 const content=lines(doc);for(const ch of content.join('\n'))if(!/[\r\n\t]/u.test(ch) && !font.hasGlyphForCodePoint(ch.codePointAt(0)!))throw new GoalExportError('EXPORT_GLYPH_UNAVAILABLE','固定字体不含成果所需字形');
 return new Promise((resolve,reject)=>{
  const document=new PDFDocument({size:'A4',margin:48,font:bytes as unknown as string,compress:true,info:{Title:doc.title,Author:'Muniu',Creator:'Muniu local export',CreationDate:new Date(doc.createdAt),ModDate:new Date(doc.createdAt)}});
  const chunks:Buffer[]=[];let count=0,pages=1;document.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>EXPORT_MAX_BYTES){document.destroy(new GoalExportError('EXPORT_LIMIT','导出文件超过大小限制'));return;}chunks.push(chunk);});
  document.once('error',reject);document.once('end',()=>resolve(Buffer.concat(chunks)));document.on('pageAdded',()=>{if(++pages>100)throw new GoalExportError('EXPORT_LIMIT','PDF 超过页数限制');});
  try{document.fontSize(18).fillColor('#152238').text(content[0]!,{lineGap:4});document.moveDown(0.5);document.fontSize(8).fillColor('#586474').text(content.slice(1,4).join('\n'),{lineGap:3});document.moveDown();document.fontSize(11).fillColor('#17212e').text(doc.text,{lineGap:5});document.end();}catch(error){document.destroy();reject(error);}
 });
}
export async function writeGoalExport(format:GoalExportFormatV2,doc:GoalExportDocument,fontPath:string):Promise<Uint8Array>{validateExportDocument(format,doc);return format==='pdf'?pdf(doc,fontPath):format==='docx'?docx(doc):xlsx(doc);}
