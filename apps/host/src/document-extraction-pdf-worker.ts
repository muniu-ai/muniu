// SPDX-License-Identifier: Apache-2.0
import { DOCUMENT_EXTRACTION_LIMITS, DocumentExtractionError, extractPdfInChild, type DocumentExtractionLimits } from "./document-extraction.js";

async function main(): Promise<void> {
  const limits = JSON.parse(process.argv[2] ?? "null") as DocumentExtractionLimits;
  for (const key of Object.keys(DOCUMENT_EXTRACTION_LIMITS) as (keyof DocumentExtractionLimits)[]) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] <= 0 || limits[key] > DOCUMENT_EXTRACTION_LIMITS[key]) throw new Error("Invalid parser limits");
  }
  // PDF.js is allowed only the supplied bytes, with no external resource fetches.
  globalThis.fetch = async () => { throw new Error("External PDF resources are disabled"); };
  let size = 0; const chunks: Buffer[] = [];
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > limits.inputBytes) throw new DocumentExtractionError("DOCUMENT_LIMIT", "PDF 文件超过大小限制");
    chunks.push(chunk);
  }
  const result = await extractPdfInChild(Buffer.concat(chunks), limits);
  process.stdout.write(JSON.stringify({ result }));
}

void main().catch(error => {
  process.stdout.write(JSON.stringify({ error: { code: error instanceof DocumentExtractionError ? error.code : "PDF_PARSE_FAILED" } }));
});
