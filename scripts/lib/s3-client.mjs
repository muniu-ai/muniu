// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function encodePath(value) {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlDecode(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function awsTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

export class SigV4S3Client {
  #endpoint;
  #region;
  #accessKeyId;
  #secretAccessKey;
  #sessionToken;
  #fetch;
  #now;

  constructor({
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    fetchImplementation = fetch,
    now = () => new Date(),
  }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError("S3 endpoint 必须使用 HTTP(S)");
    this.#endpoint = url;
    this.#region = region;
    this.#accessKeyId = accessKeyId;
    this.#secretAccessKey = secretAccessKey;
    this.#sessionToken = sessionToken;
    this.#fetch = fetchImplementation;
    this.#now = now;
  }

  async #request(method, bucket, key = "", { body = new Uint8Array(), headers = {}, query = {} } = {}) {
    const url = new URL(this.#endpoint);
    const prefix = url.pathname.replace(/\/$/u, "");
    url.pathname = `${prefix}/${encodeURIComponent(bucket)}${key ? `/${encodePath(key)}` : ""}`;
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    url.searchParams.sort();

    const bytes = body instanceof Uint8Array ? body : Buffer.from(body);
    const payloadHash = sha256(bytes);
    const timestamp = awsTimestamp(this.#now());
    const date = timestamp.slice(0, 8);
    const signedHeaders = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()])),
      ...(this.#sessionToken ? { "x-amz-security-token": this.#sessionToken } : {}),
    };
    const names = Object.keys(signedHeaders).sort();
    const canonicalHeaders = names.map((name) => `${name}:${signedHeaders[name]}\n`).join("");
    const canonicalRequest = [
      method,
      url.pathname,
      url.searchParams.toString(),
      canonicalHeaders,
      names.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.#region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${this.#secretAccessKey}`, date);
    const regionKey = hmac(dateKey, this.#region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = hmac(signingKey, stringToSign, "hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    return this.#fetch(url, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: { ...signedHeaders, authorization },
      ...(method === "GET" || method === "HEAD" ? {} : { body: bytes }),
      redirect: "error",
    });
  }

  async probe(bucket) {
    try {
      const response = await this.#request("GET", bucket, "", { query: { "list-type": "2", "max-keys": "1" } });
      return response.ok;
    } catch {
      return false;
    }
  }

  async headObject({ bucket, key }) {
    const response = await this.#request("HEAD", bucket, key);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`S3 HEAD 失败：HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    return Number.isSafeInteger(length) && length >= 0 ? { contentLength: length } : {};
  }

  async putObject({ bucket, key, body, ifNoneMatch, checksumSha256 }) {
    const response = await this.#request("PUT", bucket, key, {
      body,
      headers: { "if-none-match": ifNoneMatch, "x-amz-checksum-sha256": checksumSha256 },
    });
    if (response.status === 409 || response.status === 412) return false;
    if (!response.ok) throw new Error(`S3 PUT 失败：HTTP ${response.status}`);
    return true;
  }

  async getObject({ bucket, key }) {
    const response = await this.#request("GET", bucket, key);
    if (!response.ok) throw new Error(`S3 GET 失败：HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async listObjects({ bucket, prefix }) {
    const objects = [];
    const tokens = new Set();
    let token;
    for (let page = 0; page < 10_000; page++) {
      const response = await this.#request("GET", bucket, "", {
        query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) },
      });
      if (!response.ok) throw new Error(`S3 LIST 失败：HTTP ${response.status}`);
      const xml = await response.text();
      const truncated = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/u)?.[1];
      if (!/<ListBucketResult(?:\s[^>]*)?>/u.test(xml) || !xml.includes("</ListBucketResult>")
        || !truncated || /<!DOCTYPE|<!ENTITY|<Error\b/u.test(xml)) throw new Error("S3 LIST 响应无效");
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
        const key = xmlDecode(match[1].match(/<Key>([\s\S]*?)<\/Key>/u)?.[1] ?? "");
        const lastModified = new Date(match[1].match(/<LastModified>([\s\S]*?)<\/LastModified>/u)?.[1] ?? "");
        if (!key.startsWith(prefix) || !Number.isFinite(lastModified.getTime())) throw new Error("S3 LIST 对象描述无效");
        objects.push({ key, lastModified });
      }
      if (truncated === "false") return objects;
      token = xmlDecode(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u)?.[1] ?? "");
      if (!token || tokens.has(token)) throw new Error("S3 LIST 分页游标无效");
      tokens.add(token);
    }
    throw new Error("S3 LIST 超过分页上限");
  }

  async deleteObjects({ bucket, keys }) {
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const batch = keys.slice(offset, offset + 1000);
      const body = Buffer.from(`<Delete>${batch.map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`).join("")}<Quiet>true</Quiet></Delete>`);
      const response = await this.#request("POST", bucket, "", {
        body,
        headers: { "content-md5": createHash("md5").update(body).digest("base64") },
        query: { delete: "" },
      });
      if (!response.ok) throw new Error(`S3 DELETE 失败：HTTP ${response.status}`);
      const xml = await response.text();
      if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<DeleteResult(?:\s[^>]*)?(?:\s*\/>|>[\s\S]*<\/DeleteResult>)\s*$/u.test(xml)
        || /<!DOCTYPE|<!ENTITY|<Error\b/u.test(xml)) {
        throw new Error("S3 DELETE 未确认全部对象删除；请核对结果");
      }
    }
  }
}
