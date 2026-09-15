// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { UnavailableEnterpriseKeyProvider, VaultTransitKeyProvider } from "../lib/enterprise-secrets.mjs";

test("Vault readiness checks authenticated key capabilities and fails closed without writing keys", async () => {
  let mode = "ready";
  const provider = new VaultTransitKeyProvider({ address: "https://vault.test", token: "fixture",
    individuallyRevocable: true, fetchImplementation: async (url, init) => {
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      if (mode === "unavailable") throw new Error("unavailable");
      if (url.pathname === "/v1/sys/health") return new Response(null, { status: mode === "sealed" ? 503 : 200 });
      assert.equal(url.pathname, "/v1/sys/capabilities-self");
      assert.equal(init.method, "POST");
      if (mode === "invalid-token") return new Response(null, { status: 403 });
      const { paths } = JSON.parse(init.body);
      assert.equal(paths.length, 4);
      return Response.json(Object.fromEntries(paths.map(path => [path,
        mode === "denied" ? ["read"] : mode === "root" ? ["root"] : ["create", "read", "update", "delete"],
      ])));
    } });
  for (const value of ["ready", "root", "denied", "invalid-token", "sealed", "unavailable"]) {
    mode = value;
    assert.equal(await provider.probe(), ["ready", "root"].includes(value), value);
  }
  assert.equal(await new UnavailableEnterpriseKeyProvider().probe(), false);
});

test("Vault payload keys are independently revocable without restoring deleted keys", async () => {
  const keys = new Map();
  const calls = [];
  let denied = false;
  const fetchImplementation = async (url, init) => {
    const [, , mount, operation, name, subpath] = url.pathname.split("/");
    assert.equal(mount, "transit");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const record = keys.get(name);
    calls.push({ operation, name, method: init.method, body });
    if (denied) return new Response(null, { status: 403 });
    if (operation === "keys") {
      if (init.method === "GET") return record ? Response.json({ data: record }) : new Response(null, { status: 404 });
      if (init.method === "DELETE") {
        assert.equal(record.deletion_allowed, true);
        keys.delete(name);
        return new Response(null, { status: 204 });
      }
      if (subpath === "config") Object.assign(record, body);
      else { assert.equal(keys.has(name), false); keys.set(name, { ...body, encrypted: new Map() }); }
      return new Response(null, { status: 204 });
    }
    if (!record) return new Response(null, { status: 400 });
    if (operation === "encrypt") {
      const ciphertext = `vault:v1:${randomBytes(32).toString("base64")}`;
      record.encrypted.set(ciphertext, { plaintext: body.plaintext, context: body.context });
      return Response.json({ data: { ciphertext } });
    }
    if (operation === "decrypt") {
      const saved = record.encrypted.get(body.ciphertext);
      if (saved?.context !== body.context) return new Response(null, { status: 400 });
      return Response.json({ data: { plaintext: saved.plaintext } });
    }
    throw new Error("unexpected operation");
  };
  const options = { address: "https://vault.test", token: "fixture", individuallyRevocable: true, fetchImplementation };
  const provider = new VaultTransitKeyProvider(options);
  const plaintext = randomBytes(32);
  const context = { tenantId: "tenant-a", purpose: "memory:one" };
  const erased = await provider.wrapKey(plaintext, context);
  const retained = await provider.wrapKey(plaintext, { ...context, purpose: "memory:two" });
  assert.notEqual(erased.keyId, retained.keyId);
  assert.deepEqual(await provider.unwrapKey(erased), plaintext);
  assert.equal(await provider.isKeyRevoked(erased), false);
  await provider.revokeKey(erased);
  await provider.revokeKey(erased);
  assert.equal(await provider.isKeyRevoked(erased), true);
  const restarted = new VaultTransitKeyProvider(options);
  await assert.rejects(restarted.unwrapKey(structuredClone(erased)), /HTTP 400/);
  assert.deepEqual(await restarted.unwrapKey(retained), plaintext);
  assert.equal(keys.size, 1);
  assert.ok([...keys.values()].every(key => key.derived && !key.exportable && !key.allow_plaintext_backup));
  const beforeInvalid = calls.length;
  await assert.rejects(provider.revokeKey({ ...retained, keyId: "vault-transit://muniu/v2/transit/unrelated" }));
  assert.equal(calls.length, beforeInvalid, "a forged key ID must be rejected before network IO");
  denied = true;
  await assert.rejects(provider.isKeyRevoked(retained), /403/);
});
