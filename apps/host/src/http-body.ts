// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from "@mn/contracts";
import { KernelError } from "@mn/kernel";

const NORMAL_JSON_LIMIT = 2 * 1024 * 1024;
const ASSET_JSON_LIMIT = Math.ceil(100 * 1024 * 1024 / 3) * 4 + 1024 * 1024;

export async function readBoundedJsonBody(request: Pick<Request, "body" | "headers" | "url">, options: { readonly maxBytes?: number; readonly timeoutMs?: number } = {}): Promise<JsonObject> {
  if (!request.body) return {};
  const limit = options.maxBytes ?? (new URL(request.url).pathname === "/v2/assets" ? ASSET_JSON_LIMIT : NORMAL_JSON_LIMIT);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("请求正文限制无效");
  const tooLarge = () => new KernelError("REQUEST_BODY_TOO_LARGE", "请求正文超过大小限制", "减少本次提交的内容或附件数量");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || BigInt(declared) > BigInt(limit))) {
    void request.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new KernelError(
    "REQUEST_BODY_TIMEOUT", "读取请求正文超时", "检查连接后重新提交")), timeoutMs); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw tooLarge();
      chunks.push(value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))); }
    catch { throw new KernelError("REQUEST_JSON_INVALID", "请求正文不是有效的 UTF-8 JSON", "检查请求格式"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new KernelError("REQUEST_JSON_INVALID", "请求正文必须是 JSON 对象", "检查请求格式");
    return parsed as JsonObject;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
