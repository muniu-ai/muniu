// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyImportedSandboxManifest } from "../lib/kind-sandbox-image.mjs";

test("Kind pins the imported manifest, not the Docker configuration digest", () => {
  const configuration = `sha256:${"a".repeat(64)}`;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: configuration } }));
  const manifest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(verifyImportedSandboxManifest(manifest, bytes, configuration), manifest.slice(7));
  assert.throws(() => verifyImportedSandboxManifest(configuration, bytes, configuration));
  assert.throws(() => verifyImportedSandboxManifest(manifest, bytes, `sha256:${"b".repeat(64)}`));
});
