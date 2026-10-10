// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentExtractionError, type DocumentExtraction, type DocumentExtractionLimits } from "./document-extraction.js";

const MAX_CONCURRENT_PDFS = 2;
const MAX_QUEUED_PDFS = 6;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
let active = 0;
const waiting: { start: () => void }[] = [];

async function acquire(timeoutMs: number): Promise<void> {
  if (active < MAX_CONCURRENT_PDFS) { active++; return; }
  if (waiting.length >= MAX_QUEUED_PDFS) throw new DocumentExtractionError("DOCUMENT_BUSY", "PDF 解析任务已满，请稍后重试");
  await new Promise<void>((resolve, reject) => {
    const item = { start: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(item), 1);
      reject(new DocumentExtractionError("DOCUMENT_LIMIT", "PDF 等待解析超过时间限制"));
    }, timeoutMs);
    waiting.push(item);
  });
}

function release(): void {
  const next = waiting.shift();
  if (next) next.start(); else active--;
}

export async function isolatePdfExtraction(bytes: Uint8Array, limits: DocumentExtractionLimits): Promise<DocumentExtraction> {
  if (!["darwin", "linux"].includes(process.platform)) throw new DocumentExtractionError("PDF_ISOLATION_UNAVAILABLE", "当前系统未提供受限 PDF 解析环境");
  const expiresAt = Date.now() + limits.pdfTimeoutMs;
  await acquire(limits.pdfTimeoutMs);
  let directory: string | undefined;
  try {
    const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
    let entry = fileURLToPath(new URL("./document-extraction-pdf-worker.js", import.meta.url));
    if (packaged) {
      // Only bundled, trusted parser code touches disk; document bytes stay in pipes.
      const code = await readFile(fileURLToPath(new URL("./pdf-extraction-child.cjs", import.meta.url)));
      directory = await mkdtemp(join(tmpdir(), "mn-pdf-parser-"));
      entry = join(directory, "parser.cjs");
      await writeFile(entry, code, { mode: 0o400, flag: "wx" });
    }
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) throw new DocumentExtractionError("DOCUMENT_LIMIT", "PDF 等待解析超过时间限制");
    return await new Promise<DocumentExtraction>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${limits.pdfHeapMiB}`, "--disallow-code-generation-from-strings", entry, JSON.stringify(limits)], {
        env: { TZ: "UTC", ...(packaged ? { PKG_EXECPATH: "PKG_INVOKE_NODEJS" } : {}) }, stdio: ["pipe", "pipe", "ignore"],
      });
      let error: DocumentExtractionError | undefined;
      let size = 0; const chunks: Buffer[] = []; let polling = false; let closed = false;
      const stop = (code: string, message: string) => {
        error ??= new DocumentExtractionError(code, message);
        if (!closed) child.kill("SIGKILL");
      };
      const deadline = setTimeout(() => stop("DOCUMENT_LIMIT", "PDF 解析超过时间限制"), remainingMs);
      // RSS includes native ArrayBuffers, unlike the V8 heap limit. Sampling is a
      // kill threshold, not a kernel allocation cap; transient overshoot is possible.
      const inspect = () => {
        if (polling || closed || !child.pid) return;
        polling = true;
        const sampled = (cause: unknown, stdout: string) => {
          polling = false;
          if (closed || child.exitCode !== null || child.signalCode !== null) return;
          if (cause || !/^\s*\d+\s*$/u.test(stdout)) { stop("PDF_ISOLATION_UNAVAILABLE", "无法核对 PDF 解析进程的内存限制"); return; }
          if (Number(stdout.trim()) * 1024 > limits.pdfRssMiB * 1024 * 1024) stop("DOCUMENT_LIMIT", "PDF 解析超过内存限制");
        };
        if (process.platform === "linux") {
          void readFile(`/proc/${child.pid}/status`, "utf8")
            .then(status => sampled(undefined, /^VmRSS:\s*(\d+)\s+kB$/mu.exec(status)?.[1] ?? ""), cause => sampled(cause, ""));
        } else execFile("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 500, maxBuffer: 1024, env: { LC_ALL: "C" } }, sampled);
      };
      const memory = setInterval(inspect, 25);
      inspect();
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { stop("DOCUMENT_LIMIT", "PDF 提取结果超过传输限制"); return; }
        chunks.push(chunk);
      });
      child.stdin.on("error", () => { /* Process termination closes the input pipe. */ });
      child.once("error", () => stop("PDF_ISOLATION_UNAVAILABLE", "PDF 解析进程无法启动"));
      child.once("close", (code, signal) => {
        closed = true; clearTimeout(deadline); clearInterval(memory);
        if (error) { reject(error); return; }
        if (code !== 0 || signal) { reject(new DocumentExtractionError("DOCUMENT_LIMIT", "PDF 解析进程异常退出或超过资源限制")); return; }
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (reply.error?.code && typeof reply.error.code === "string") {
            reject(new DocumentExtractionError(reply.error.code, "PDF 提取未完成，请检查资料或资源限制")); return;
          }
          const result = reply.result as DocumentExtraction;
          if (!result || result.extractorVersion !== "1" || !Array.isArray(result.blocks) || !Array.isArray(result.issues)
            || result.blocks.length > limits.blocks || result.issues.length > limits.blocks) throw new Error();
          resolve(result);
        } catch { reject(new DocumentExtractionError("PDF_INVALID_RESULT", "PDF 解析进程未返回有效结果")); }
      });
      child.stdin.end(bytes);
    });
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { release(); }
  }
}
