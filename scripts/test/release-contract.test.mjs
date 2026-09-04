// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseContract } from "../lib/release-contract.mjs";

function validInput() {
  const version = "0.2.0";
  return {
    rootPackage: {
      name: "muniu",
      version,
      repository: "https://github.com/muniu-ai/muniu",
      packageManager: "npm@11.10.1",
      engines: { node: ">=22.19.0 <22.20.0", npm: "11.10.1" },
    },
    workspacePackages: [
      { path: "apps/host/package.json", manifest: { name: "@mn/host", version, private: true } },
      { path: "packages/storage/package.json", manifest: { name: "@mn/storage", version, private: true } },
      { path: "plugins/opc/package.json", manifest: { name: "@mn/plugin-opc", version, private: true } },
    ],
    cargoManifest: [
      "[package]",
      'name = "mniu-desktop"',
      `version = "${version}"`,
      'repository = "https://github.com/muniu-ai/muniu"',
    ].join("\n"),
    tauriConfig: { version, bundle: { createUpdaterArtifacts: false } },
    chart: {
      version,
      appVersion: version,
      home: "https://github.com/muniu-ai/muniu",
      sources: ["https://github.com/muniu-ai/muniu"],
    },
    ciWorkflow: "- run: npm run verify:release",
    releaseWorkflow: [
      'tags: ["v*"]',
      "workflow_dispatch:",
      'RELEASE_TAG: ${{ inputs.tag || github.ref_name }}',
      'ref: refs/tags/${{ inputs.tag || github.ref_name }}',
      "NODE_VERSION: 22.19.0",
      "NPM_VERSION: 11.10.1",
      "IMAGE: ghcr.io/muniu-ai/muniu",
      "npm run build:host-sidecar",
      "node --test scripts/test/deployment-v2.test.mjs",
      "docker compose -f docker-compose.enterprise.yml config --quiet",
      "npm run verify:enterprise-fixture",
      "scripts/verify-kind-sandbox.sh",
      'npm run verify:release -- --tag "${RELEASE_TAG}"',
      'git archive --format=tar.gz --prefix="muniu-${RELEASE_TAG}/" -o "release/muniu-${RELEASE_TAG}.tar.gz" HEAD',
      'npm sbom --sbom-format spdx --omit=dev > "release/muniu-${RELEASE_TAG}.spdx.json"',
      "THIRD_PARTY_NPM_LICENSES.json",
      "THIRD_PARTY_CARGO_LICENSES.json",
      "THIRD_PARTY_NOTICES.md",
      "vendor/SOURCE_MANIFEST.sha256",
      "sha256sum release/* > release/SHA256SUMS",
      "--platform linux/amd64,linux/arm64",
      "--provenance=mode=max",
      "--sbom=true",
      "uses: actions/attest@commit",
      "gh release create",
      "--verify-tag",
    ].join("\n"),
    technicalDesign: "Agent OS 0.2 发布 muniu-v0.2.0.tar.gz、muniu-v0.2.0.spdx.json 和 ghcr.io/muniu-ai/muniu:v0.2.0。",
  };
}

test("0.2 release contract accepts Host/Worker enterprise gates", () => {
  assert.deepEqual(validateReleaseContract(validInput(), { tag: "v0.2.0" }), []);
});

test("release contract rejects stale versions and mismatched tags", () => {
  const input = validInput();
  input.workspacePackages[0].manifest.version = "0.1.1";
  input.tauriConfig.version = "0.1.1";
  const failures = validateReleaseContract(input, { tag: "v0.1.1" });
  assert.ok(failures.some((failure) => failure.includes("apps/host/package.json")));
  assert.ok(failures.some((failure) => failure.includes("Tauri")));
  assert.ok(failures.some((failure) => failure.includes("tag v0.1.1")));
});

test("release contract rejects missing enterprise and supply-chain gates", () => {
  const input = validInput();
  input.releaseWorkflow = input.releaseWorkflow
    .replace("npm run verify:enterprise-fixture", "")
    .replace("scripts/verify-kind-sandbox.sh", "")
    .replace("--sbom=true", "");
  const failures = validateReleaseContract(input);
  assert.ok(failures.some((failure) => failure.includes("enterprise fixture")));
  assert.ok(failures.some((failure) => failure.includes("Kind recovery fixture")));
  assert.ok(failures.some((failure) => failure.includes("image SBOM")));
});
