// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, verify } from "node:crypto";

function decodeJson(segment, label) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new Error(`OIDC ${label} 无效`);
  }
}

function audienceMatches(value, expected) {
  return typeof value === "string" ? value === expected : Array.isArray(value) && value.includes(expected);
}

export class OidcIdentityResolver {
  #issuer;
  #audience;
  #jwksUrl;
  #fetch;
  #now;
  #cache;

  constructor({ issuer, audience, jwksUrl, fetchImplementation = fetch, now = () => Date.now() }) {
    this.#issuer = issuer.replace(/\/$/u, "");
    this.#audience = audience;
    this.#jwksUrl = new URL(jwksUrl);
    this.#fetch = fetchImplementation;
    this.#now = now;
  }

  async #keys() {
    if (this.#cache && this.#cache.expiresAt > this.#now()) return this.#cache.keys;
    const response = await this.#fetch(this.#jwksUrl, { redirect: "error" });
    if (!response.ok) throw new Error(`OIDC JWKS 读取失败：HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.keys)) throw new Error("OIDC JWKS 格式无效");
    const keys = new Map(body.keys
      .filter((key) => key?.kid && key?.kty === "RSA"
        && (key.alg === undefined || key.alg === "RS256")
        && (key.use === undefined || key.use === "sig"))
      .map((key) => [key.kid, createPublicKey({ key, format: "jwk" })]));
    this.#cache = { keys, expiresAt: this.#now() + 300_000 };
    return keys;
  }

  async resolve(request) {
    const authorization = request.headers.get("authorization") ?? "";
    const match = authorization.match(/^Bearer\s+([^\s]+)$/iu);
    if (!match) return { tenantId: "", principalId: "" };
    const parts = match[1].split(".");
    if (parts.length !== 3) return { tenantId: "", principalId: "" };
    const [encodedHeader, encodedPayload, signature] = parts;
    let header;
    let payload;
    try {
      header = decodeJson(encodedHeader, "header");
      payload = decodeJson(encodedPayload, "payload");
    } catch {
      return { tenantId: "", principalId: "" };
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") return { tenantId: "", principalId: "" };
    const key = (await this.#keys()).get(header.kid);
    if (!key || !verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), key, Buffer.from(signature, "base64url"))) {
      return { tenantId: "", principalId: "" };
    }
    const seconds = Math.floor(this.#now() / 1000);
    if (payload.iss?.replace?.(/\/$/u, "") !== this.#issuer
      || !audienceMatches(payload.aud, this.#audience)
      || typeof payload.exp !== "number" || payload.exp <= seconds
      || (typeof payload.nbf === "number" && payload.nbf > seconds + 30)
      || typeof payload.sub !== "string" || !payload.sub
      || typeof payload.tenant_id !== "string" || !payload.tenant_id) {
      return { tenantId: "", principalId: "" };
    }
    return { tenantId: payload.tenant_id, principalId: payload.sub };
  }
}
