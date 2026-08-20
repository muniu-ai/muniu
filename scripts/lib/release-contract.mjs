// SPDX-License-Identifier: Apache-2.0

const CANONICAL_REPOSITORY = "https://github.com/muniu-ai/muniu";
const NODE_VERSION = "22.19.0";
const NPM_VERSION = "11.10.1";

function readCargoPackageField(cargoManifest, field) {
  const packageStart = cargoManifest.search(/^\[package\]\s*$/mu);
  if (packageStart < 0) return undefined;
  const packageBodyStart = cargoManifest.indexOf("\n", packageStart) + 1;
  const nextSection = cargoManifest.slice(packageBodyStart).search(/^\[/mu);
  const packageSection = nextSection < 0
    ? cargoManifest.slice(packageBodyStart)
    : cargoManifest.slice(packageBodyStart, packageBodyStart + nextSection);
  return packageSection.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"\\s*$`, "mu"))?.[1];
}

function requireText(failures, text, expected, label) {
  if (!text.includes(expected)) {
    failures.push(`${label} is missing ${JSON.stringify(expected)}`);
  }
}

function requireRepository(failures, actual, label) {
  if (actual !== CANONICAL_REPOSITORY) {
    failures.push(`${label} repository must be ${CANONICAL_REPOSITORY}, received ${String(actual)}`);
  }
}

export function validateReleaseContract(input, options = {}) {
  const failures = [];
  const version = input.rootPackage?.version;

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? "")) {
    failures.push(`root package version must be semantic, received ${String(version)}`);
  }
  requireRepository(failures, input.rootPackage?.repository, "root package");
  if (input.rootPackage?.packageManager !== `npm@${NPM_VERSION}`) {
    failures.push(`root packageManager must be npm@${NPM_VERSION}`);
  }
  if (input.rootPackage?.engines?.node !== `>=${NODE_VERSION} <22.20.0`) {
    failures.push(`root Node engine must pin the 22.19.x release line`);
  }
  if (input.rootPackage?.engines?.npm !== NPM_VERSION) {
    failures.push(`root npm engine must be ${NPM_VERSION}`);
  }

  for (const workspace of input.workspacePackages ?? []) {
    if (workspace.manifest?.version !== version) {
      failures.push(`${workspace.path} version ${String(workspace.manifest?.version)} does not match ${version}`);
    }
    if (workspace.manifest?.private !== true) {
      failures.push(`${workspace.path} must remain private for v${version}`);
    }
  }

  const cargoVersion = readCargoPackageField(input.cargoManifest ?? "", "version");
  if (cargoVersion !== version) {
    failures.push(`Tauri Cargo version ${String(cargoVersion)} does not match ${version}`);
  }
  requireRepository(
    failures,
    readCargoPackageField(input.cargoManifest ?? "", "repository"),
    "Tauri Cargo package"
  );
  if (input.tauriConfig?.version !== version) {
    failures.push(`Tauri config version ${String(input.tauriConfig?.version)} does not match ${version}`);
  }
  if (input.tauriConfig?.bundle?.createUpdaterArtifacts !== false) {
    failures.push("Tauri updater artifacts must remain disabled for v0.1.0");
  }

  if (input.chart?.version !== version || input.chart?.appVersion !== version) {
    failures.push(
      `Helm chart version/appVersion must both match ${version}, received ${String(input.chart?.version)}/${String(input.chart?.appVersion)}`
    );
  }
  requireRepository(failures, input.chart?.home, "Helm chart home");
  if (!input.chart?.sources?.includes(CANONICAL_REPOSITORY)) {
    failures.push(`Helm chart sources must include ${CANONICAL_REPOSITORY}`);
  }

  if (options.tag !== undefined && options.tag !== `v${version}`) {
    failures.push(`release tag ${options.tag} does not match package version v${version}`);
  }

  const ciWorkflow = input.ciWorkflow ?? "";
  requireText(failures, ciWorkflow, "npm run verify:release", "ordinary CI release contract gate");

  const workflow = input.releaseWorkflow ?? "";
  if (!/tags:\s*\[\s*["']v\*["']\s*\]/u.test(workflow)) {
    failures.push("release workflow must run only for version tags");
  }
  const workflowRequirements = [
    ["workflow_dispatch:", "manual recovery entrypoint"],
    ['RELEASE_TAG: ${{ inputs.tag || github.ref_name }}', "release tag binding"],
    ['ref: refs/tags/${{ inputs.tag || github.ref_name }}', "immutable tag checkout"],
    [`NODE_VERSION: ${NODE_VERSION}`, "pinned Node version"],
    [`NPM_VERSION: ${NPM_VERSION}`, "pinned npm version"],
    ["IMAGE: ghcr.io/muniu-ai/muniu", "canonical GHCR image"],
    ["npm run build:daemon-sidecar", "macOS Desktop daemon build"],
    ["postgres:", "PostgreSQL service"],
    ["MN_TEST_POSTGRES_URL:", "PostgreSQL integration environment"],
    ["apps/api/dist-test/test/*Postgres.test.js", "PostgreSQL integration suites"],
    ['npm run verify:release -- --tag "${RELEASE_TAG}"', "tag/version contract gate"],
    ["git archive --format=tar.gz", "source archive"],
    ["npm sbom --sbom-format spdx --omit=dev", "production dependency SBOM"],
    ["THIRD_PARTY_NPM_LICENSES.json", "npm license inventory"],
    ["THIRD_PARTY_CARGO_LICENSES.json", "Cargo license inventory"],
    ["THIRD_PARTY_NOTICES.md", "third-party notices"],
    ["vendor/SOURCE_MANIFEST.sha256", "vendored source manifest"],
    ["sha256sum release/* > release/SHA256SUMS", "artifact checksums"],
    ["--platform linux/amd64,linux/arm64", "dual-architecture image"],
    ["--provenance=mode=max", "image provenance"],
    ["--sbom=true", "image SBOM"],
    ["uses: actions/attest@", "release file attestation"],
    ["gh release create", "GitHub Release publication"],
    ["--verify-tag", "immutable tag verification"]
  ];
  for (const [expected, label] of workflowRequirements) {
    requireText(failures, workflow, expected, `release workflow ${label}`);
  }

  const technicalDesign = input.technicalDesign ?? "";
  for (const expected of [
    `muniu-v${version}.tar.gz`,
    `muniu-v${version}.spdx.json`,
    `ghcr.io/muniu-ai/muniu:v${version}`,
    "macOS Desktop 只完成构建验证",
    "v0.1.0 不发布或启用桌面运行时 updater"
  ]) {
    requireText(failures, technicalDesign, expected, "technical design release boundary");
  }
  if (/node22-macos-(?:arm64|x64)\.tar\.gz/u.test(technicalDesign)) {
    failures.push("technical design must not claim macOS portable archives are public v0.1.0 artifacts");
  }

  return failures;
}
