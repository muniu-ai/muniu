import { isIP } from "node:net";

export type OpcWebReadErrorCode =
  | "CONFIG_INVALID"
  | "CROSS_PROTOCOL_REDIRECT"
  | "DNS_REBINDING"
  | "HTTP_ERROR"
  | "MIME_FORBIDDEN"
  | "PRIVATE_ADDRESS"
  | "REDIRECT_INVALID"
  | "REDIRECT_LIMIT"
  | "REQUEST_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "URL_FORBIDDEN";

export class OpcWebReadError extends Error {
  constructor(
    readonly code: OpcWebReadErrorCode,
    message: string,
    readonly action: string,
  ) {
    super(message);
    this.name = "OpcWebReadError";
  }
}

export interface PinnedHttpRequest {
  readonly url: string;
  readonly method: "GET";
  /** 传输层必须只连接这些解析结果，不得再次自行解析域名。 */
  readonly resolvedAddresses: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface PinnedHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** 实际 socket 的远端地址，用于核对固定的 DNS 结果。 */
  readonly remoteAddress: string;
  readonly discard?: () => Promise<void> | void;
}

export interface PublicWebReaderDependencies {
  readonly dnsLookup: (hostname: string) => Promise<readonly string[]>;
  readonly request: (request: PinnedHttpRequest) => Promise<PinnedHttpResponse>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly allowedMediaTypes?: readonly string[];
}

export interface PublicWebReadResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly mediaType: string;
  readonly body: string;
  readonly byteLength: number;
  readonly redirects: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const HARD_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const HARD_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const HARD_MAX_REDIRECTS = 5;
const DEFAULT_MEDIA_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xhtml+xml",
] as const;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOCAL_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

type HopResult =
  | { readonly kind: "redirect"; readonly location: string }
  | {
      readonly kind: "content";
      readonly status: number;
      readonly mediaType: string;
      readonly body: string;
      readonly byteLength: number;
    };

export class SafePublicWebReader {
  readonly #dnsLookup: PublicWebReaderDependencies["dnsLookup"];
  readonly #request: PublicWebReaderDependencies["request"];
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #allowedMediaTypes: ReadonlySet<string>;

  constructor(dependencies: PublicWebReaderDependencies) {
    this.#dnsLookup = dependencies.dnsLookup;
    this.#request = dependencies.request;
    this.#maxBytes = boundedInteger(
      dependencies.maxBytes ?? DEFAULT_MAX_BYTES,
      HARD_MAX_BYTES,
      "maxBytes",
    );
    this.#timeoutMs = boundedInteger(
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      HARD_MAX_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxRedirects = boundedInteger(
      dependencies.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      HARD_MAX_REDIRECTS,
      "maxRedirects",
      true,
    );
    const mediaTypes = dependencies.allowedMediaTypes ?? DEFAULT_MEDIA_TYPES;
    if (mediaTypes.length === 0) {
      throw new OpcWebReadError("MIME_FORBIDDEN", "允许的响应类型不能为空", "配置至少一种文本类型");
    }
    this.#allowedMediaTypes = new Set(mediaTypes.map((item) => item.toLowerCase()));
  }

  async read(input: string): Promise<PublicWebReadResult> {
    let current = parsePublicUrl(input);
    let redirects = 0;

    while (true) {
      const resolvedAddresses = await withTimeout(
        () => this.#resolvePublicAddresses(current),
        this.#timeoutMs,
      );
      const hop = await withAbortableTimeout(
        (signal) => this.#readHop(current, resolvedAddresses, signal),
        this.#timeoutMs,
      );
      if (hop.kind === "content") {
        return {
          finalUrl: current.href,
          status: hop.status,
          mediaType: hop.mediaType,
          body: hop.body,
          byteLength: hop.byteLength,
          redirects,
        };
      }
      if (redirects >= this.#maxRedirects) {
        throw new OpcWebReadError("REDIRECT_LIMIT", "网页重定向次数过多", "改用最终公开地址");
      }
      let next: URL;
      try {
        next = new URL(hop.location, current);
      } catch {
        throw new OpcWebReadError("REDIRECT_INVALID", "网页返回了无效重定向地址", "改用可直接访问的公开地址");
      }
      if (next.protocol !== current.protocol) {
        throw new OpcWebReadError(
          "CROSS_PROTOCOL_REDIRECT",
          "网页重定向改变了协议",
          "直接提供相同协议的最终公开地址",
        );
      }
      current = parsePublicUrl(next.href);
      redirects += 1;
    }
  }

  async #resolvePublicAddresses(url: URL): Promise<readonly string[]> {
    const hostname = normalizedHostname(url);
    const literal = normalizeIpAddress(hostname);
    const addresses = literal ? [literal] : await this.#dnsLookup(hostname);
    if (addresses.length === 0) {
      throw new OpcWebReadError("URL_FORBIDDEN", "域名没有可用地址", "检查地址后重试");
    }
    const normalized = [...new Set(addresses.map((address) => {
      const parsed = normalizeIpAddress(address);
      if (!parsed || !isPublicAddress(parsed)) {
        throw new OpcWebReadError(
          "PRIVATE_ADDRESS",
          "网页地址解析到本机、私网或保留地址",
          "改用公开互联网地址",
        );
      }
      return parsed;
    }))];
    return normalized;
  }

  async #readHop(
    url: URL,
    resolvedAddresses: readonly string[],
    signal: AbortSignal,
  ): Promise<HopResult> {
    const response = await this.#request({
      url: url.href,
      method: "GET",
      resolvedAddresses,
      headers: {
        accept: "text/html,text/plain,text/markdown,application/json,application/xhtml+xml",
        "accept-encoding": "identity",
        "user-agent": "Muniu-OPC/0.2 public-research",
      },
      timeoutMs: this.#timeoutMs,
      signal,
    });
    const remoteAddress = normalizeIpAddress(response.remoteAddress);
    if (!remoteAddress
      || !isPublicAddress(remoteAddress)
      || !resolvedAddresses.includes(remoteAddress)) {
      await response.discard?.();
      throw new OpcWebReadError(
        "DNS_REBINDING",
        "实际连接地址与已核对的 DNS 结果不一致",
        "停止读取并检查域名解析",
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = header(response.headers, "location");
      await response.discard?.();
      if (!location) {
        throw new OpcWebReadError("REDIRECT_INVALID", "网页重定向缺少目标地址", "改用最终公开地址");
      }
      return { kind: "redirect", location };
    }
    if (response.status < 200 || response.status >= 300) {
      await response.discard?.();
      throw new OpcWebReadError("HTTP_ERROR", `网页返回 HTTP ${response.status}`, "检查公开地址后重试");
    }

    const mediaType = (header(response.headers, "content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
    if (!this.#allowedMediaTypes.has(mediaType)) {
      await response.discard?.();
      throw new OpcWebReadError("MIME_FORBIDDEN", `不支持响应类型 ${mediaType || "未知"}`, "仅使用文本、HTML 或 JSON 页面");
    }
    const contentLength = Number(header(response.headers, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.#maxBytes) {
      await response.discard?.();
      throw new OpcWebReadError("RESPONSE_TOO_LARGE", "网页响应超过大小限制", "选择较小的页面或粘贴必要摘录");
    }

    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for await (const chunk of response.body) {
      byteLength += chunk.byteLength;
      if (byteLength > this.#maxBytes) {
        await response.discard?.();
        throw new OpcWebReadError("RESPONSE_TOO_LARGE", "网页响应超过大小限制", "选择较小的页面或粘贴必要摘录");
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new OpcWebReadError("MIME_FORBIDDEN", "网页内容不是有效 UTF-8 文本", "改用 UTF-8 文本页面");
    }
    return { kind: "content", status: response.status, mediaType, body, byteLength };
  }
}

export function isPublicAddress(input: string): boolean {
  const address = stripAddressDecorations(input);
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const words = parseIpv6(address);
  if (!words) return false;
  const mapped = mappedIpv4(words);
  if (mapped) return isPublicIpv4(mapped);
  if (words.every((word) => word === 0)) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return false;
  if ((words[0]! & 0xfe00) === 0xfc00) return false;
  if ((words[0]! & 0xffc0) === 0xfe80) return false;
  if ((words[0]! & 0xffc0) === 0xfec0) return false;
  if ((words[0]! & 0xff00) === 0xff00) return false;
  if (words.slice(0, 6).every((word) => word === 0)) return false;
  if (words[0] === 0x0064 && words[1] === 0xff9b) return false;
  if (words[0] === 0x2002) return false;
  if (words[0] === 0x2001 && words[1] === 0x0000) return false;
  if (words[0] === 0x2001 && (words[1]! & 0xfff0) === 0x0010) return false;
  if (words[0] === 0x2001 && (words[1]! & 0xfff0) === 0x0020) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  return true;
}

function parsePublicUrl(input: string): URL {
  if (input.length > 2_048) {
    throw new OpcWebReadError("URL_FORBIDDEN", "网页地址过长", "使用较短的公开地址");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OpcWebReadError("URL_FORBIDDEN", "网页地址无效", "填写完整 HTTP 或 HTTPS 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpcWebReadError("URL_FORBIDDEN", "只允许 HTTP 或 HTTPS 网页", "改用公开网页地址");
  }
  if (url.username || url.password) {
    throw new OpcWebReadError("URL_FORBIDDEN", "网页地址不得包含凭据", "移除用户名和密码");
  }
  const hostname = normalizedHostname(url);
  if (!hostname
    || LOCAL_HOSTS.has(hostname)
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")) {
    throw new OpcWebReadError("URL_FORBIDDEN", "不允许访问本机或内部域名", "改用公开互联网地址");
  }
  const literal = normalizeIpAddress(hostname);
  if (literal && !isPublicAddress(literal)) {
    throw new OpcWebReadError("PRIVATE_ADDRESS", "不允许访问本机、私网或保留地址", "改用公开互联网地址");
  }
  return url;
}

function normalizedHostname(url: URL): string {
  return stripAddressDecorations(url.hostname).toLowerCase().replace(/\.$/u, "");
}

function normalizeIpAddress(input: string): string | undefined {
  const address = stripAddressDecorations(input).toLowerCase();
  const family = isIP(address);
  if (family === 4) return normalizeIpv4(address);
  if (family !== 6) return undefined;
  const words = parseIpv6(address);
  if (!words) return undefined;
  const mapped = mappedIpv4(words);
  if (mapped) return normalizeIpv4(mapped);
  return words.map((word) => word.toString(16).padStart(4, "0")).join(":");
}

function stripAddressDecorations(input: string): string {
  const unbracketed = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  return unbracketed.split("%", 1)[0] ?? unbracketed;
}

function normalizeIpv4(address: string): string {
  return address.split(".").map((part) => String(Number(part))).join(".");
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6(address: string): readonly number[] | undefined {
  let normalized = address.toLowerCase();
  const dottedIndex = normalized.lastIndexOf(":");
  if (normalized.includes(".") && dottedIndex >= 0) {
    const ipv4 = normalized.slice(dottedIndex + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split(".").map(Number);
    normalized = `${normalized.slice(0, dottedIndex)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const pieces = halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    : left;
  const words = pieces.map((piece) => Number.parseInt(piece, 16));
  if (words.length !== 8
    || pieces.some((piece) => !/^[0-9a-f]{1,4}$/u.test(piece))
    || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return undefined;
  }
  return words;
}

function mappedIpv4(words: readonly number[]): string | undefined {
  if (words.length !== 8
    || !words.slice(0, 5).every((word) => word === 0)
    || words[5] !== 0xffff) {
    return undefined;
  }
  return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join(".");
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const matched = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return matched?.[1];
}

function boundedInteger(value: number, maximum: number, field: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new OpcWebReadError(
      "CONFIG_INVALID",
      `${field} 必须是 ${minimum} 到 ${maximum} 之间的整数`,
      `修正 ${field} 后重试`,
    );
  }
  return value;
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OpcWebReadError("REQUEST_TIMEOUT", "网页请求超时", "稍后重试或改用粘贴内容"));
    }, timeoutMs);
    operation().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new OpcWebReadError("REQUEST_TIMEOUT", "网页请求超时", "稍后重试或改用粘贴内容"));
    }, timeoutMs);
    operation(controller.signal).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
