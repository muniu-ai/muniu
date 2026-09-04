#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.JWKS_PORT ?? "8080");
const issuer = (process.env.JWKS_ISSUER ?? `http://127.0.0.1:${port}`).replace(/\/$/u, "");
const audience = process.env.JWKS_AUDIENCE ?? "muniu-v2";
const ttlSeconds = Number(process.env.JWKS_TOKEN_TTL_SECONDS ?? "1800");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("JWKS_PORT 无效");
if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
  throw new Error("JWKS_TOKEN_TTL_SECONDS 必须在 60 到 3600 之间");
}

const keyId = "mn-v2-enterprise-fixture";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: keyId, use: "sig" };

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessToken(tenantId, principalId) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", kid: keyId, typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: audience,
    sub: principalId,
    tenant_id: tenantId,
    iat: now,
    nbf: now - 1,
    exp: now + ttlSeconds,
    jti: randomUUID(),
  });
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", issuer);
  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/jwks.json") {
    send(response, 200, { keys: [publicJwk] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/token") {
    const tenantId = url.searchParams.get("tenant")?.trim();
    const principalId = url.searchParams.get("sub")?.trim();
    if (!tenantId || !principalId) {
      send(response, 400, { code: "TENANT_AND_SUB_REQUIRED" });
      return;
    }
    send(response, 200, {
      access_token: accessToken(tenantId, principalId),
      token_type: "Bearer",
      expires_in: ttlSeconds,
    });
    return;
  }
  send(response, 404, { code: "NOT_FOUND" });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`v2 JWKS fixture 已监听 ${port}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
