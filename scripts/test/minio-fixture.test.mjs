// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse, parseAllDocuments } from "yaml";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const fixtureImage = "mn-minio-fixture:2025-04";

// Removed upstream binaries must not silently become a different S3 implementation.
test("Compose builds its MinIO server and client from the same local source fixture", () => {
  const { services } = parse(read("docker-compose.enterprise.yml"));
  for (const service of [services.minio, services["minio-init"]]) {
    assert.equal(service.image, fixtureImage);
    assert.deepEqual(service.build, { context: "./deploy/fixtures", dockerfile: "minio.Dockerfile" });
    assert.equal(service.pull_policy, "build");
  }
  assert.deepEqual(services.minio.entrypoint, ["minio"]);
  assert.deepEqual(services["minio-init"].entrypoint, ["/bin/sh", "-ec"]);
  assert.deepEqual(services.minio.healthcheck.test,
    ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9000/minio/health/live"]);
});

test("Kind builds and imports the same MinIO fixture without registry fallback", () => {
  const documents = parseAllDocuments(read("deploy/kind/enterprise-fixture.yaml")).map(document => document.toJSON());
  const minio = documents.filter(document => ["muniu-kind-minio", "muniu-kind-minio-init"].includes(document?.metadata?.name))
    .flatMap(document => document?.spec?.template?.spec?.containers ?? []);
  assert.equal(minio.length, 2);
  for (const container of minio) {
    assert.equal(container.image, fixtureImage);
    assert.equal(container.imagePullPolicy, "Never");
  }
  assert.deepEqual(minio.find(container => container.name === "minio").command, ["minio"]);
  const script = read("scripts/verify-kind-sandbox.sh");
  assert.ok(script.includes(`minio_image="${fixtureImage}"`));
  assert.match(script, /docker build --file deploy\/fixtures\/minio\.Dockerfile --tag "\$\{minio_image\}" deploy\/fixtures/u);
  assert.match(script, /kind load docker-image[^\n]+"\$\{minio_image\}"/u);
  assert.doesNotMatch(script.match(/dependency_images=\(([\s\S]*?)\n\)/u)?.[1] ?? "", /minio/u);
});

test("MinIO fixture sources and base images are pinned and verified before compilation", () => {
  const dockerfile = read("deploy/fixtures/minio.Dockerfile");
  const sources = [
    ["minio", "0d7408fc9969caf07de6a8c3a84f9fbb10a6739e"],
    ["mc", "b00526b153a31b36767991a4f5ce2cced435ee8e"],
  ];
  for (const [repository, commit] of sources) {
    assert.match(dockerfile, new RegExp(`ADD --checksum=sha256:[a-f0-9]{64} https://codeload\\.github\\.com/minio/${repository}/tar\\.gz/${commit} /tmp/${repository}\\.tar\\.gz`, "u"));
    assert.match(dockerfile, new RegExp(`COPY --from=${repository}-build /src/LICENSE /usr/share/licenses/${repository}/LICENSE`, "u"));
  }
  const fromLines = dockerfile.split("\n").filter(line => line.startsWith("FROM "));
  assert.equal(fromLines.length, 3);
  for (const line of fromLines) assert.match(line, /@sha256:[a-f0-9]{64}(?: AS [a-z-]+)?$/u);
  assert.match(dockerfile, /CGO_ENABLED=0/u);
  assert.match(dockerfile, /GOTOOLCHAIN=local/u);
  assert.match(dockerfile, /go build -mod=readonly -trimpath/u);
  assert.doesNotMatch(dockerfile, /(?:quay\.io\/)?minio\/(?:minio|mc):|@latest|\/master/u);
});
