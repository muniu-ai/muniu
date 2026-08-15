import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { StandardPackManifest, TrustProfile } from "@mn/governance";
import { buildServer } from "../src/server.js";

const fixtureRoot = new URL(
  "../../../../examples/microservice-repo/standards/",
  import.meta.url
);

test("Standard Pack API verifies trusted Ed25519 content and rejects tamper/revocation", async (t) => {
  const manifest = JSON.parse(
    await readFile(new URL("enterprise-standard-pack.json", fixtureRoot), "utf8")
  ) as StandardPackManifest;
  const trust = JSON.parse(
    await readFile(new URL("trust-profile.json", fixtureRoot), "utf8")
  ) as TrustProfile;
  const app = buildServer({ standardPackTrustProfile: trust });
  t.after(() => app.close());

  const imported = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: { manifest, importedBy: "governance@example.com" }
  });
  assert.equal(imported.statusCode, 201, imported.body);
  assert.equal(imported.json().trust, "verified");

  const tampered = JSON.parse(JSON.stringify(manifest)) as {
    rules: { requiredGates: string[] };
    [key: string]: unknown;
  };
  tampered.rules.requiredGates = [...tampered.rules.requiredGates, "tampered_gate"];
  const rejected = await app.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: { manifest: tampered, importedBy: "attacker@example.com" }
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().error, /trust verification failed/u);

  const revokedApp = buildServer({
    standardPackTrustProfile: {
      ...trust,
      revokedPublicKeyIds: [manifest.signature!.keyId]
    }
  });
  t.after(() => revokedApp.close());
  const revoked = await revokedApp.inject({
    method: "POST",
    url: "/v1/standard-packs/import",
    payload: { manifest, importedBy: "governance@example.com" }
  });
  assert.equal(revoked.statusCode, 400, revoked.body);
  assert.match(JSON.stringify(revoked.json()), /KEY_REVOKED/u);
});
