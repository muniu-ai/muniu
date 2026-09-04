// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { OidcIdentityResolver } from "../lib/oidc-identity.mjs";
import { SigV4S3Client } from "../lib/s3-client.mjs";

function jwt(privateKey, kid, payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${claims}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

test("OIDC resolver verifies RS256 identity and rejects malformed or expired tokens", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "fixture";
  let jwksReads = 0;
  const resolver = new OidcIdentityResolver({
    issuer: "https://identity.example.test/",
    audience: "muniu-v2",
    jwksUrl: "https://identity.example.test/jwks.json",
    now: () => 1_700_000_000_000,
    fetchImplementation: async () => {
      jwksReads += 1;
      return Response.json({
        keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }],
      });
    },
  });
  const token = jwt(privateKey, kid, {
    iss: "https://identity.example.test",
    aud: "muniu-v2",
    sub: "owner@example.test",
    tenant_id: "tenant-a",
    nbf: 1_699_999_999,
    exp: 1_700_000_300,
  });
  assert.deepEqual(await resolver.resolve(new Request("https://host.test/v2/workspaces", {
    headers: { authorization: `Bearer ${token}` },
  })), { tenantId: "tenant-a", principalId: "owner@example.test" });
  assert.deepEqual(await resolver.resolve(new Request("https://host.test/v2/workspaces", {
    headers: { authorization: `Bearer ${token}` },
  })), { tenantId: "tenant-a", principalId: "owner@example.test" });
  assert.equal(jwksReads, 1, "JWKS should be cached for five minutes");

  const expired = jwt(privateKey, kid, {
    iss: "https://identity.example.test", aud: "muniu-v2", sub: "owner", tenant_id: "tenant-a",
    exp: 1_699_999_999,
  });
  assert.deepEqual(await resolver.resolve(new Request("https://host.test/v2/workspaces", {
    headers: { authorization: `Bearer ${expired}` },
  })), { tenantId: "", principalId: "" });
  assert.deepEqual(await resolver.resolve(new Request("https://host.test/v2/workspaces", {
    headers: { authorization: "Bearer not-json.not-json.not-json" },
  })), { tenantId: "", principalId: "" });
});

test("S3 client signs create-only v2 CAS operations and parses listings", async () => {
  const requests = [];
  const responses = [
    new Response(null, { status: 200 }),
    new Response("bytes", { status: 200 }),
    new Response("<ListBucketResult><Contents><Key>v2/sha256/a&amp;b</Key><LastModified>2025-01-02T03:04:05Z</LastModified></Contents></ListBucketResult>", { status: 200 }),
    new Response("", { status: 200 }),
  ];
  const client = new SigV4S3Client({
    endpoint: "https://s3.example.test/base",
    region: "test-1",
    accessKeyId: "access",
    secretAccessKey: "secret",
    now: () => new Date("2025-01-02T03:04:05Z"),
    fetchImplementation: async (url, init) => {
      requests.push({ url: String(url), init });
      return responses.shift();
    },
  });

  assert.equal(await client.putObject({
    bucket: "artifacts", key: "v2/sha256/abc", body: Buffer.from("bytes"),
    ifNoneMatch: "*", checksumSha256: "Y2hlY2tzdW0=",
  }), true);
  assert.deepEqual(Buffer.from(await client.getObject({ bucket: "artifacts", key: "v2/sha256/abc" })), Buffer.from("bytes"));
  assert.deepEqual(await client.listObjects({ bucket: "artifacts", prefix: "v2/sha256/" }), [{
    key: "v2/sha256/a&b", lastModified: new Date("2025-01-02T03:04:05Z"),
  }]);
  await client.deleteObjects({ bucket: "artifacts", keys: ["v2/sha256/a&b"] });

  assert.equal(requests[0].init.headers["if-none-match"], "*");
  assert.match(requests[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=access\/20250102\/test-1\/s3\/aws4_request,/u);
  assert.equal(new URL(requests[0].url).pathname, "/base/artifacts/v2/sha256/abc");
  assert.equal(new URL(requests[2].url).searchParams.get("prefix"), "v2/sha256/");
  assert.equal(new URL(requests[3].url).searchParams.has("delete"), true);
  assert.match(Buffer.from(requests[3].init.body).toString(), /a&amp;b/u);
});

test("S3 create-only conflict is reported without overwriting", async () => {
  const client = new SigV4S3Client({
    endpoint: "https://s3.example.test",
    region: "test-1",
    accessKeyId: "access",
    secretAccessKey: "secret",
    fetchImplementation: async () => new Response(null, { status: 412 }),
  });
  assert.equal(await client.putObject({
    bucket: "artifacts", key: "v2/sha256/abc", body: Buffer.from("bytes"),
    ifNoneMatch: "*", checksumSha256: "Y2hlY2tzdW0=",
  }), false);
});
