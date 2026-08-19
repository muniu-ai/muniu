import { createHash, createHmac } from "node:crypto";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_LIST_PAGES = 10_000;
const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3CompatibleArtifactStoreOptions {
  endpointUrl: string;
  bucket: string;
  region?: string;
  credentials?: S3Credentials;
  requestTimeoutMs?: number;
}

export interface S3ArtifactRequestOptions {
  signal?: AbortSignal;
}

export interface S3PutArtifactOptions extends S3ArtifactRequestOptions {
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
  /** Create-only write used by immutable evidence journals. S3-compatible
   * stores evaluate this atomically at the object boundary. */
  ifNoneMatch?: "*";
  serverSideEncryption?: "AES256" | "aws:kms";
  kmsKeyId?: string;
}

export interface S3StoredArtifactObject {
  key: string;
  bytes: number;
  sha256: string;
  etag?: string;
  versionId?: string;
}

export interface S3ArtifactObjectSummary {
  key: string;
  bytes: number;
  etag?: string;
  lastModified?: string;
}

export interface S3ArtifactObjectHead extends S3ArtifactObjectSummary {
  contentType?: string;
  metadata: Record<string, string>;
  versionId?: string;
}

export class S3ArtifactStoreError extends Error {
  readonly operation: string;
  readonly statusCode?: number;
  readonly s3Code?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    details: {
      operation: string;
      statusCode?: number;
      s3Code?: string;
      requestId?: string;
      cause?: unknown;
    }
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "S3ArtifactStoreError";
    this.operation = details.operation;
    this.statusCode = details.statusCode;
    this.s3Code = details.s3Code;
    this.requestId = details.requestId;
  }
}

/**
 * Minimal S3 REST client for artifact persistence. It uses path-style URLs so it
 * works with MinIO and signs requests with AWS Signature Version 4 when
 * credentials are configured. With no credentials it deliberately makes
 * anonymous requests, which is useful only for explicitly public test buckets.
 *
 * Keys passed to this class are already-qualified object keys. The caller owns
 * application prefixes such as `team/dev/runs/...`; this avoids applying the
 * existing mn mirror prefix twice during migration.
 */
export class S3CompatibleArtifactStore {
  readonly endpointUrl: string;
  readonly bucket: string;
  readonly region: string;

  private readonly endpoint: URL;
  private readonly credentials?: S3Credentials;
  private readonly requestTimeoutMs: number;

  constructor(options: S3CompatibleArtifactStoreOptions) {
    this.endpoint = normalizeEndpoint(options.endpointUrl);
    this.endpointUrl = this.endpoint.toString().replace(/\/$/u, "");
    this.bucket = normalizeBucket(options.bucket);
    this.region = normalizeRegion(options.region ?? DEFAULT_REGION);
    this.credentials = normalizeCredentials(options.credentials);
    this.requestTimeoutMs = normalizeRequestTimeout(options.requestTimeoutMs);
  }

  async putObject(
    key: string,
    content: Buffer | Uint8Array | string,
    options: S3PutArtifactOptions = {}
  ): Promise<S3StoredArtifactObject> {
    const normalizedKey = normalizeObjectKey(key);
    const body = toBuffer(content);
    const headers = new Headers();
    if (options.contentType !== undefined) {
      headers.set("content-type", normalizeHeaderValue(options.contentType, "content type"));
    }
    if (options.ifNoneMatch !== undefined) {
      if (options.ifNoneMatch !== "*") {
        throw new TypeError("S3 putObject ifNoneMatch must be '*'");
      }
      headers.set("if-none-match", options.ifNoneMatch);
    }
    if (options.serverSideEncryption) {
      headers.set("x-amz-server-side-encryption", options.serverSideEncryption);
      if (options.kmsKeyId) {
        if (options.serverSideEncryption !== "aws:kms") {
          throw new TypeError("an S3 KMS key requires aws:kms server-side encryption");
        }
        headers.set(
          "x-amz-server-side-encryption-aws-kms-key-id",
          normalizeHeaderValue(options.kmsKeyId, "KMS key id")
        );
      }
    } else if (options.kmsKeyId) {
      throw new TypeError("an S3 KMS key requires server-side encryption");
    }
    for (const [name, value] of Object.entries(options.metadata ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      headers.set(
        `x-amz-meta-${normalizeMetadataName(name)}`,
        normalizeHeaderValue(value, `metadata ${name}`)
      );
    }
    const response = await this.request(
      "PUT",
      normalizedKey,
      { headers, body },
      options.signal,
      "putObject"
    );
    await requireSuccess(response, "putObject");
    return {
      key: normalizedKey,
      bytes: body.byteLength,
      sha256: sha256Hex(body),
      ...optionalHeader(response.headers, "etag", "etag"),
      ...optionalHeader(response.headers, "x-amz-version-id", "versionId")
    };
  }

  async getObject(
    key: string,
    options: S3ArtifactRequestOptions = {}
  ): Promise<Buffer | undefined> {
    const response = await this.request(
      "GET",
      normalizeObjectKey(key),
      {},
      options.signal,
      "getObject"
    );
    if (response.status === 404) {
      await discardResponse(response);
      return undefined;
    }
    await requireSuccess(response, "getObject");
    return Buffer.from(await response.arrayBuffer());
  }

  async headObject(
    key: string,
    options: S3ArtifactRequestOptions = {}
  ): Promise<S3ArtifactObjectHead | undefined> {
    const normalizedKey = normalizeObjectKey(key);
    const response = await this.request(
      "HEAD",
      normalizedKey,
      {},
      options.signal,
      "headObject"
    );
    if (response.status === 404) {
      await discardResponse(response);
      return undefined;
    }
    await requireSuccess(response, "headObject");
    const rawLength = response.headers.get("content-length");
    const bytes = rawLength === null ? 0 : Number(rawLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new S3ArtifactStoreError("S3 headObject returned an invalid content length", {
        operation: "headObject",
        statusCode: response.status
      });
    }
    const metadata: Record<string, string> = {};
    for (const [name, value] of response.headers.entries()) {
      if (name.startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
    }
    return {
      key: normalizedKey,
      bytes,
      metadata,
      ...optionalHeader(response.headers, "etag", "etag"),
      ...optionalHeader(response.headers, "last-modified", "lastModified"),
      ...optionalHeader(response.headers, "content-type", "contentType"),
      ...optionalHeader(response.headers, "x-amz-version-id", "versionId")
    };
  }

  async deleteObject(
    key: string,
    options: S3ArtifactRequestOptions = {}
  ): Promise<void> {
    const response = await this.request(
      "DELETE",
      normalizeObjectKey(key),
      {},
      options.signal,
      "deleteObject"
    );
    await requireSuccess(response, "deleteObject");
  }

  async listObjects(
    prefix = "",
    options: S3ArtifactRequestOptions = {}
  ): Promise<S3ArtifactObjectSummary[]> {
    const normalizedPrefix = normalizeObjectPrefix(prefix);
    const objects: S3ArtifactObjectSummary[] = [];
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query: Array<[string, string]> = [
        ["list-type", "2"],
        ["encoding-type", "url"]
      ];
      if (normalizedPrefix) query.push(["prefix", normalizedPrefix]);
      if (continuationToken !== undefined) {
        query.push(["continuation-token", continuationToken]);
      }
      const response = await this.request(
        "GET",
        undefined,
        { query },
        options.signal,
        "listObjects"
      );
      await requireSuccess(response, "listObjects");
      const parsed = parseListObjectsV2(await response.text());
      objects.push(...parsed.objects);
      if (!parsed.isTruncated) return objects;
      if (!parsed.nextContinuationToken) {
        throw new S3ArtifactStoreError(
          "S3 listObjects returned a truncated page without a continuation token",
          { operation: "listObjects", statusCode: response.status }
        );
      }
      if (seenTokens.has(parsed.nextContinuationToken)) {
        throw new S3ArtifactStoreError(
          "S3 listObjects repeated a continuation token",
          { operation: "listObjects", statusCode: response.status }
        );
      }
      seenTokens.add(parsed.nextContinuationToken);
      continuationToken = parsed.nextContinuationToken;
    }

    throw new S3ArtifactStoreError("S3 listObjects exceeded the pagination safety limit", {
      operation: "listObjects"
    });
  }

  async deletePrefix(
    prefix: string,
    options: S3ArtifactRequestOptions = {}
  ): Promise<number> {
    const normalizedPrefix = normalizeObjectPrefix(prefix);
    if (!normalizedPrefix) {
      throw new Error("Refusing to delete an empty S3 artifact prefix");
    }
    const objects = await this.listObjects(normalizedPrefix, options);
    for (const object of objects) await this.deleteObject(object.key, options);
    return objects.length;
  }

  private async request(
    method: "DELETE" | "GET" | "HEAD" | "PUT",
    key: string | undefined,
    init: {
      headers?: Headers;
      body?: Buffer;
      query?: ReadonlyArray<readonly [string, string]>;
    },
    signal: AbortSignal | undefined,
    operation: string
  ): Promise<Response> {
    const url = objectRequestUrl(this.endpoint, this.bucket, key, init.query ?? []);
    const body = init.body;
    const headers = new Headers(init.headers);
    const payloadHash = body === undefined ? EMPTY_SHA256 : sha256Hex(body);
    if (this.credentials) {
      applySignatureV4(headers, {
        method,
        url,
        payloadHash,
        region: this.region,
        credentials: this.credentials,
        now: new Date()
      });
    } else {
      headers.set("x-amz-content-sha256", payloadHash);
    }
    const abort = createRequestAbortSignal(signal, this.requestTimeoutMs);
    try {
      return await fetch(url, {
        method,
        headers,
        // Node's fetch accepts Buffer, while the DOM BodyInit declaration used by
        // this workspace does not include Node's Buffer subtype.
        ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
        signal: abort.signal
      });
    } catch (error) {
      if (error instanceof S3ArtifactStoreError) throw error;
      const reason = abort.didTimeout()
        ? ` after ${this.requestTimeoutMs}ms`
        : signal?.aborted
          ? " because the request was cancelled"
          : "";
      throw new S3ArtifactStoreError(`S3 ${operation} request failed${reason}`, {
        operation,
        cause: error
      });
    } finally {
      abort.dispose();
    }
  }
}

export function s3CredentialsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): S3Credentials | undefined {
  const accessKeyId = firstDefined(
    environment.MN_ARTIFACT_S3_ACCESS_KEY_ID,
    environment.AWS_ACCESS_KEY_ID
  );
  const secretAccessKey = firstDefined(
    environment.MN_ARTIFACT_S3_SECRET_ACCESS_KEY,
    environment.AWS_SECRET_ACCESS_KEY
  );
  const sessionToken = firstDefined(
    environment.MN_ARTIFACT_S3_SESSION_TOKEN,
    environment.AWS_SESSION_TOKEN
  );
  if (accessKeyId === undefined && secretAccessKey === undefined && sessionToken === undefined) {
    return undefined;
  }
  return normalizeCredentials({
    accessKeyId: accessKeyId ?? "",
    secretAccessKey: secretAccessKey ?? "",
    ...(sessionToken === undefined ? {} : { sessionToken })
  });
}

export function s3RegionFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  return normalizeRegion(
    firstDefined(
      environment.MN_ARTIFACT_S3_REGION,
      environment.AWS_REGION,
      environment.AWS_DEFAULT_REGION
    ) ?? DEFAULT_REGION
  );
}

interface SignatureV4Input {
  method: string;
  url: URL;
  payloadHash: string;
  region: string;
  credentials: S3Credentials;
  now: Date;
}

function applySignatureV4(headers: Headers, input: SignatureV4Input): void {
  const amzDate = formatAmzDate(input.now);
  const dateStamp = amzDate.slice(0, 8);
  headers.set("host", input.url.host);
  headers.set("x-amz-content-sha256", input.payloadHash);
  headers.set("x-amz-date", amzDate);
  if (input.credentials.sessionToken) {
    headers.set("x-amz-security-token", input.credentials.sessionToken);
  }
  const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(headers);
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname,
    canonicalQueryFromUrl(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
  headers.delete("host");
}

function canonicalizeHeaders(headers: Headers): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const values = [...headers.entries()]
    .filter(([name]) => name.toLowerCase() !== "authorization")
    .map(([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    canonicalHeaders: `${values.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    signedHeaders: values.map(([name]) => name).join(";")
  };
}

function objectRequestUrl(
  endpoint: URL,
  bucket: string,
  key: string | undefined,
  query: ReadonlyArray<readonly [string, string]>
): URL {
  const url = new URL(endpoint.toString());
  const basePath = canonicalizeEndpointPath(endpoint.pathname);
  const objectPath = key === undefined
    ? encodeRfc3986(bucket)
    : `${encodeRfc3986(bucket)}/${encodeObjectKey(key)}`;
  url.pathname = `${basePath}/${objectPath}`.replace(/^\/+/u, "/");
  url.search = canonicalQuery(query);
  return url;
}

function canonicalizeEndpointPath(pathname: string): string {
  const encoded = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => encodeRfc3986(decodeUrlComponent(part, "S3 endpoint path")))
    .join("/");
  return encoded ? `/${encoded}` : "";
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function canonicalQuery(values: ReadonlyArray<readonly [string, string]>): string {
  return values
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalQueryFromUrl(url: URL): string {
  return canonicalQuery([...url.searchParams.entries()]);
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function normalizeEndpoint(raw: string): URL {
  const value = raw.trim();
  if (!value) throw new Error("S3 artifact endpoint URL is required");
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("S3 artifact endpoint URL is invalid");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("S3 artifact endpoint URL must use http or https");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("S3 artifact endpoint URL cannot contain credentials");
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error("S3 artifact endpoint URL cannot contain a query or fragment");
  }
  canonicalizeEndpointPath(endpoint.pathname);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "") || "/";
  return endpoint;
}

function normalizeBucket(raw: string): string {
  const bucket = raw.trim();
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9.-]+$/u.test(bucket) ||
    bucket.includes("..") ||
    bucket.split(".").some((label) =>
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    ) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bucket)
  ) {
    throw new Error("S3 artifact bucket must be a valid DNS-compatible bucket name");
  }
  return bucket;
}

function normalizeRegion(raw: string): string {
  const region = raw.trim();
  if (!region || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(region)) {
    throw new Error("S3 artifact region is invalid");
  }
  return region;
}

function normalizeCredentials(input: S3Credentials | undefined): S3Credentials | undefined {
  if (!input) return undefined;
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  const sessionToken = input.sessionToken?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("S3 artifact credentials require both access key ID and secret access key");
  }
  if (accessKeyId.includes("/") || /[\r\n]/u.test(accessKeyId)) {
    throw new Error("S3 artifact access key ID is invalid");
  }
  if (/[\r\n]/u.test(secretAccessKey) || (sessionToken !== undefined && /[\r\n]/u.test(sessionToken))) {
    throw new Error("S3 artifact credentials contain invalid characters");
  }
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function normalizeRequestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 10 * 60_000) {
    throw new Error("S3 artifact request timeout must be between 1 and 600000ms");
  }
  return timeout;
}

function normalizeObjectKey(raw: string): string {
  if (
    !raw ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw new Error("S3 artifact object key is invalid");
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("S3 artifact object key contains an unsafe path segment");
  }
  return raw;
}

function normalizeObjectPrefix(raw: string): string {
  if (!raw) return "";
  const hasTrailingDelimiter = raw.endsWith("/");
  const withoutTrailingSlash = raw.replace(/\/+$/u, "");
  if (!withoutTrailingSlash) return "";
  const prefix = normalizeObjectKey(withoutTrailingSlash);
  return hasTrailingDelimiter ? `${prefix}/` : prefix;
}

function normalizeMetadataName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
    throw new Error(`S3 artifact metadata name is invalid: ${raw}`);
  }
  return name;
}

function normalizeHeaderValue(raw: string, label: string): string {
  const value = raw.trim();
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error(`S3 artifact ${label} is invalid`);
  }
  return value;
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function formatAmzDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("S3 signing time is invalid");
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function toBuffer(content: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(content)) return content;
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function optionalHeader<Key extends string>(
  headers: Headers,
  headerName: string,
  propertyName: Key
): Partial<Record<Key, string>> {
  const value = headers.get(headerName);
  return value === null ? {} : ({ [propertyName]: value } as Partial<Record<Key, string>>);
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim();
}

async function requireSuccess(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const body = await readBoundedErrorBody(response);
  const s3Code = xmlElement(body, "Code");
  const requestId =
    response.headers.get("x-amz-request-id") ?? xmlElement(body, "RequestId") ?? undefined;
  throw new S3ArtifactStoreError(
    `S3 ${operation} failed with HTTP ${response.status}${s3Code ? ` (${s3Code})` : ""}`,
    {
      operation,
      statusCode: response.status,
      ...(s3Code ? { s3Code } : {}),
      ...(requestId ? { requestId } : {})
    }
  );
}

async function readBoundedErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BODY_BYTES - bytes;
      const chunk = Buffer.from(value).subarray(0, remaining);
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function parseListObjectsV2(xml: string): {
  objects: S3ArtifactObjectSummary[];
  isTruncated: boolean;
  nextContinuationToken?: string;
} {
  const objects = xmlElements(xml, "Contents").map((entry) => {
    const encodedKey = requiredXmlElement(entry, "Key", "listObjects key");
    const key = decodeUrlComponent(encodedKey, "S3 listObjects key");
    const rawSize = requiredXmlElement(entry, "Size", "listObjects size");
    const bytes = Number(rawSize);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new S3ArtifactStoreError("S3 listObjects returned an invalid object size", {
        operation: "listObjects"
      });
    }
    return {
      key: normalizeObjectKey(key),
      bytes,
      ...optionalXmlElement(entry, "ETag", "etag"),
      ...optionalXmlElement(entry, "LastModified", "lastModified")
    };
  });
  const rawIsTruncated = xmlElement(xml, "IsTruncated")?.trim().toLowerCase();
  if (rawIsTruncated !== "true" && rawIsTruncated !== "false") {
    throw new S3ArtifactStoreError("S3 listObjects returned an invalid truncation marker", {
      operation: "listObjects"
    });
  }
  const isTruncated = rawIsTruncated === "true";
  const encodedToken = xmlElement(xml, "NextContinuationToken");
  return {
    objects,
    isTruncated,
    ...(encodedToken === undefined
      ? {}
      : { nextContinuationToken: xmlDecode(encodedToken) })
  };
}

function xmlElements(xml: string, name: string): string[] {
  const escaped = escapeRegExp(name);
  return [...xml.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "giu"))]
    .map((match) => match[1] ?? "");
}

function xmlElement(xml: string, name: string): string | undefined {
  return xmlElements(xml, name).at(0);
}

function requiredXmlElement(xml: string, name: string, label: string): string {
  const value = xmlElement(xml, name);
  if (value === undefined) {
    throw new S3ArtifactStoreError(`S3 ${label} is missing`, { operation: "listObjects" });
  }
  return xmlDecode(value);
}

function optionalXmlElement<Key extends string>(
  xml: string,
  elementName: string,
  propertyName: Key
): Partial<Record<Key, string>> {
  const value = xmlElement(xml, elementName);
  return value === undefined
    ? {}
    : ({ [propertyName]: xmlDecode(value) } as Partial<Record<Key, string>>);
}

function xmlDecode(value: string): string {
  return value.replace(
    /&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/giu,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&lt;": return "<";
        case "&gt;": return ">";
        case "&amp;": return "&";
        case "&quot;": return "\"";
        case "&apos;": return "'";
        default: {
          const hexadecimal = entity.slice(0, 3).toLowerCase() === "&#x";
          const raw = entity.slice(hexadecimal ? 3 : 2, -1);
          const codePoint = Number.parseInt(raw, hexadecimal ? 16 : 10);
          return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
        }
      }
    }
  );
}

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new S3ArtifactStoreError(`${label} contains invalid percent encoding`, {
      operation: "decode"
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createRequestAbortSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromUpstream = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) abortFromUpstream();
  else upstream?.addEventListener("abort", abortFromUpstream, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`S3 artifact request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      upstream?.removeEventListener("abort", abortFromUpstream);
    }
  };
}
