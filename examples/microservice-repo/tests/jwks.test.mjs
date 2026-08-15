import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { createJwksServer } from "../infra/jwks-server.mjs";

test("local JWKS stub issues an RS256 token that matches its published key", async (t) => {
  const server = createJwksServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  const { keys } = await fetch(`${baseUrl}/jwks.json`).then((response) => response.json());
  const issued = await fetch(
    `${baseUrl}/token?role=reviewer&tenant=tenant-test&project=commerce-reservation`,
    { method: "POST" }
  ).then((response) => response.json());
  const [encodedHeader, encodedPayload, encodedSignature] = issued.access_token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(header.kid, keys[0].kid);
  assert.equal(payload.tenant_id, "tenant-test");
  assert.deepEqual(payload.roles, ["reviewer"]);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: keys[0], format: "jwk" }),
      Buffer.from(encodedSignature, "base64url")
    ),
    true
  );
});

