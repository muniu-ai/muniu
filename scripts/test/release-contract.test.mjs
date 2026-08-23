// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseContract } from "../lib/release-contract.mjs";

function validInput() {
  return {
    rootPackage: {
      name: "muniu",
      version: "0.2.0",
      repository: "https://github.com/muniu-ai/muniu",
      packageManager: "npm@11.10.1",
      engines: {
        node: ">=22.19.0 <22.20.0",
        npm: "11.10.1"
      }
    },
    workspacePackages: [
      { path: "apps/api/package.json", manifest: { name: "@mn/api", version: "0.2.0", private: true } },
      { path: "packages/runtime/package.json", manifest: { name: "@mn/runtime", version: "0.2.0", private: true } }
    ],
    cargoManifest: [
      "[package]",
      'name = "mniu-desktop"',
      'version = "0.2.0"',
      'repository = "https://github.com/muniu-ai/muniu"'
    ].join("\n"),
    tauriConfig: {
      version: "0.2.0",
      bundle: { createUpdaterArtifacts: false }
    },
    chart: {
      version: "0.2.0",
      appVersion: "0.2.0",
      home: "https://github.com/muniu-ai/muniu",
      sources: ["https://github.com/muniu-ai/muniu"]
    },
    ciWorkflow: [
      "- run: npm run verify:release",
      "- run: npm run verify:rpc-coverage",
      "- run: npm run verify:sdk-e2e",
      "- run: npm run verify:gateway-e2e",
      "- run: npm run verify:desktop-e2e"
    ].join("\n"),
    releaseWorkflow: [
      'tags: ["v*"]',
      "workflow_dispatch:",
      'RELEASE_TAG: ${{ inputs.tag || github.ref_name }}',
      'ref: refs/tags/${{ inputs.tag || github.ref_name }}',
      "NODE_VERSION: 22.19.0",
      "NPM_VERSION: 11.10.1",
      "IMAGE: ghcr.io/muniu-ai/muniu",
      "npm run build:daemon-sidecar",
      "postgres:",
      "MN_TEST_POSTGRES_URL:",
      "apps/api/dist-test/test/*Postgres.test.js",
      'npm run verify:release -- --tag "${RELEASE_TAG}"',
      "npm run verify:rpc-coverage",
      "npm run verify:sdk-e2e",
      "npm run verify:gateway-e2e",
      "npm run verify:desktop-e2e",
      'git archive --format=tar.gz --prefix="muniu-${RELEASE_TAG}/" -o "release/muniu-${RELEASE_TAG}.tar.gz" HEAD',
      'npm sbom --sbom-format spdx --omit=dev > "release/muniu-${RELEASE_TAG}.spdx.json"',
      'cp THIRD_PARTY_NPM_LICENSES.json "release/muniu-${RELEASE_TAG}.npm-licenses.json"',
      'cp THIRD_PARTY_CARGO_LICENSES.json "release/muniu-${RELEASE_TAG}.cargo-licenses.json"',
      'cp THIRD_PARTY_NOTICES.md "release/muniu-${RELEASE_TAG}.third-party-notices.md"',
      'cp vendor/SOURCE_MANIFEST.sha256 "release/muniu-${RELEASE_TAG}.vendor-sources.sha256"',
      "sha256sum release/* > release/SHA256SUMS",
      "--platform linux/amd64,linux/arm64",
      "--provenance=mode=max",
      "--sbom=true",
      "uses: actions/attest@59d89421af93a897026c735860bf21b6eb4f7b26",
      'gh release create "${RELEASE_TAG}" release/* --verify-tag --generate-notes'
    ].join("\n"),
    technicalDesign: [
      "v0.2.0 开源发布制品包括 `muniu-v0.2.0.tar.gz`、`muniu-v0.2.0.spdx.json`、许可证与来源清单、校验和与构建证明，以及 `ghcr.io/muniu-ai/muniu:v0.2.0` 双架构镜像。",
      "macOS Desktop 只完成构建验证，不作为 v0.2.0 公开制品发布。",
      "v0.2.0 不发布或启用桌面运行时 updater。"
    ].join("\n"),
    compatibilityMatrix: [
      "99660ab3c7b861c916e467581fa9b8723504d66b",
      "app-server-v2",
      "core-stable-subset",
      "不宣称完整 Codex app-server 兼容"
    ].join("\n"),
    migrationGuide: [
      "mn migrate app-server-v3 --dry-run",
      "mn migrate app-server-v3 --apply",
      "首次 V3 写入",
      "恢复整套备份"
    ].join("\n")
  };
}

test("release contract accepts the complete v0.2.0 boundary", () => {
  assert.deepEqual(validateReleaseContract(validInput(), { tag: "v0.2.0" }), []);
});

test("release contract rejects mismatched versions and tags", () => {
  const input = validInput();
  input.workspacePackages[0].manifest.version = "0.1.0";
  input.tauriConfig.version = "0.1.0";

  const failures = validateReleaseContract(input, { tag: "v0.1.0" });
  assert.equal(failures.some((failure) => failure.includes("apps/api/package.json")), true);
  assert.equal(failures.some((failure) => failure.includes("Tauri")), true);
  assert.equal(failures.some((failure) => failure.includes("tag v0.1.0")), true);
});

test("release contract rejects incomplete gates and supply-chain artifacts", () => {
  const input = validInput();
  input.ciWorkflow = "- run: npm test";
  input.releaseWorkflow = input.releaseWorkflow
    .replace("npm run build:daemon-sidecar", "")
    .replace("MN_TEST_POSTGRES_URL:", "")
    .replace("--sbom=true", "");

  const failures = validateReleaseContract(input);
  assert.equal(failures.some((failure) => failure.includes("ordinary CI")), true);
  assert.equal(failures.some((failure) => failure.includes("Desktop daemon")), true);
  assert.equal(failures.some((failure) => failure.includes("PostgreSQL")), true);
  assert.equal(failures.some((failure) => failure.includes("image SBOM")), true);
});

test("release contract rejects public macOS portable claims for v0.2.0", () => {
  const input = validInput();
  input.technicalDesign += "\n`muniu-v0.2.0-node22-macos-arm64.tar.gz`";

  const failures = validateReleaseContract(input);
  assert.equal(failures.some((failure) => failure.includes("portable")), true);
});

test("release contract requires platform compatibility and migration boundaries", () => {
  const input = validInput();
  input.compatibilityMatrix = input.compatibilityMatrix.replace("core-stable-subset", "");
  input.migrationGuide = input.migrationGuide.replace("恢复整套备份", "");

  const failures = validateReleaseContract(input);
  assert.equal(failures.some((failure) => failure.includes("compatibility matrix")), true);
  assert.equal(failures.some((failure) => failure.includes("migration guide")), true);
});

test("release contract requires all platform E2E gates in CI and release", () => {
  const input = validInput();
  input.ciWorkflow = input.ciWorkflow.replace("npm run verify:desktop-e2e", "");
  input.releaseWorkflow = input.releaseWorkflow.replace("npm run verify:gateway-e2e", "");

  const failures = validateReleaseContract(input);
  assert.equal(failures.some((failure) => failure.includes("ordinary CI Desktop E2E")), true);
  assert.equal(failures.some((failure) => failure.includes("release workflow gateway E2E")), true);
});

test("release contract requires a production-only SBOM and immutable-tag recovery", () => {
  const input = validInput();
  input.releaseWorkflow = input.releaseWorkflow
    .replace("workflow_dispatch:", "")
    .replace('ref: refs/tags/${{ inputs.tag || github.ref_name }}', "")
    .replace(" --omit=dev", "");

  const failures = validateReleaseContract(input);
  assert.equal(failures.some((failure) => failure.includes("manual recovery")), true);
  assert.equal(failures.some((failure) => failure.includes("immutable tag checkout")), true);
  assert.equal(failures.some((failure) => failure.includes("production dependency SBOM")), true);
});
