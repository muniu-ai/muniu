// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyImportedSandboxManifest } from "../lib/kind-sandbox-image.mjs";
import { prepareImportedVaultFixture, vaultImportReference, VAULT_FIXTURE_IMAGE } from "../lib/kind-vault-image.mjs";

test("Kind imports pinned Vault through a named, configuration-addressed local reference", () => {
  const built = { Id: `sha256:${"a".repeat(64)}`,
    RepoDigests: [VAULT_FIXTURE_IMAGE.replace(":1.21.4", "")] };
  assert.equal(vaultImportReference(built), `muniu-kind-vault:${"a".repeat(64)}`);
  assert.throws(() => vaultImportReference({ ...built, RepoDigests: [] }));
  assert.throws(() => vaultImportReference({ ...built, Id: "untrusted:latest" }));
});

test("Kind pins the imported manifest, not the Docker configuration digest", () => {
  const configuration = `sha256:${"a".repeat(64)}`;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: configuration } }));
  const manifest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(verifyImportedSandboxManifest(manifest, bytes, configuration), manifest.slice(7));
  assert.throws(() => verifyImportedSandboxManifest(configuration, bytes, configuration));
  assert.throws(() => verifyImportedSandboxManifest(manifest, bytes, `sha256:${"b".repeat(64)}`));
  const missing = Buffer.from(JSON.stringify({ schemaVersion: 2, config: {} }));
  assert.throws(() => verifyImportedSandboxManifest(`sha256:${createHash("sha256").update(missing).digest("hex")}`, missing, undefined));
});

test("Kind Vault fixture binds the imported manifest to the pinned upstream configuration", () => {
  const configuration = `sha256:${"a".repeat(64)}`;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: configuration } }));
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const fixture = ["Deployment", "Job"].map(kind => JSON.stringify({ apiVersion: "apps/v1", kind,
    spec: { template: { spec: { containers: [{ name: "vault", image: VAULT_FIXTURE_IMAGE }] } } } })).join("\n---\n");
  const input = { fixture, built: { Id: configuration, RepoDigests: [VAULT_FIXTURE_IMAGE.replace(":1.21.4", "")] },
    manifestDigest: digest, manifestBytes: bytes };
  const result = prepareImportedVaultFixture(input);
  assert.equal(result.reference, `docker.io/hashicorp/vault@${digest}`);
  for (const item of result.items) {
    assert.equal(item.spec.template.spec.containers[0].image, result.reference);
    assert.equal(item.spec.template.spec.containers[0].imagePullPolicy, "Never");
  }
  assert.throws(() => prepareImportedVaultFixture({ ...input, built: { ...input.built, RepoDigests: [] } }));
  assert.throws(() => prepareImportedVaultFixture({ ...input, built: { ...input.built, Id: `sha256:${"b".repeat(64)}` } }));
  assert.throws(() => prepareImportedVaultFixture({ ...input, manifestBytes: Buffer.from("tampered") }));
  assert.throws(() => prepareImportedVaultFixture({ ...input, fixture: fixture.replaceAll(VAULT_FIXTURE_IMAGE, "hashicorp/vault:latest") }));
});
