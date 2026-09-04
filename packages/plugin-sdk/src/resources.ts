import path from "node:path";
import { sha256Hex } from "./canonical.js";
import { PluginPolicyError } from "./errors.js";

export const PLUGIN_PROCESS_TRUST_NOTICE =
  "插件与宿主进程等价，不是沙箱；插件代码可使用宿主进程可见的能力";

export const DEVELOPMENT_TRUST_WARNING =
  `开发${PLUGIN_PROCESS_TRUST_NOTICE}；仅加载你完全信任的本地代码`;

export const PRODUCTION_PLUGIN_CSP = Object.freeze({
  scriptSrc: "'self'",
  objectSrc: "'none'",
  frameSrc: "'none'",
  baseUri: "'none'",
  formAction: "'none'",
});

export interface PluginResourceCheck {
  readonly mode: "production" | "development";
  readonly resource: string;
  readonly content: Uint8Array;
  readonly expectedSha256: string;
}

export interface DevelopmentPluginSource {
  readonly localPath: string;
  readonly hmrUrl?: string;
}

export function assertPluginResource(input: PluginResourceCheck): void {
  if (input.mode === "production" && !isPackageLocalResource(input.resource)) {
    throw new PluginPolicyError(
      "REMOTE_RESOURCE_FORBIDDEN",
      "生产插件只能加载包内同源资源",
      "将资源放入插件包并重新签名",
    );
  }
  if (sha256Hex(input.content) !== input.expectedSha256) {
    throw new PluginPolicyError(
      "RESOURCE_DIGEST_MISMATCH",
      "插件资源摘要不匹配",
      "停止加载并重新安装插件",
    );
  }
}

export function assertDevelopmentSource(source: DevelopmentPluginSource): void {
  if (!path.isAbsolute(source.localPath) || source.localPath.includes("\0")) {
    throw invalidDevelopmentSource("开发插件目录必须是绝对本地路径");
  }
  if (!source.hmrUrl) return;
  let url: URL;
  try {
    url = new URL(source.hmrUrl);
  } catch {
    throw invalidDevelopmentSource("HMR 地址无效");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!localHosts.has(url.hostname) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw invalidDevelopmentSource("HMR 只能连接本机 HTTP 或 HTTPS 地址");
  }
  if (url.username || url.password) {
    throw invalidDevelopmentSource("HMR 地址不得包含凭据");
  }
}

function isPackageLocalResource(resource: string): boolean {
  if (!resource || resource.includes("\0") || resource.includes("\\")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(resource) || resource.startsWith("//")) return false;
  if (path.posix.isAbsolute(resource)) return false;
  const normalized = path.posix.normalize(resource.replace(/^\.\//u, ""));
  return normalized !== ".." && !normalized.startsWith("../") && normalized !== ".";
}

function invalidDevelopmentSource(message: string): PluginPolicyError {
  return new PluginPolicyError(
    "DEVELOPMENT_SOURCE_INVALID",
    message,
    "选择可信本地目录并使用本机 HMR",
  );
}
