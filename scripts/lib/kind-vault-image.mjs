// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { verifyImportedSandboxManifest } from "./kind-sandbox-image.mjs";

export const VAULT_FIXTURE_IMAGE = "hashicorp/vault:1.21.4@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569";

export function vaultImportReference(built) {
  if (!built.RepoDigests?.includes(VAULT_FIXTURE_IMAGE.replace(":1.21.4", ""))) {
    throw new Error("Vault image does not match the approved upstream digest");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(built.Id)) throw new Error("Vault configuration digest is invalid");
  return `muniu-kind-vault:${built.Id.slice(7)}`;
}

export function prepareImportedVaultFixture({ fixture, built, manifestDigest, manifestBytes }) {
  vaultImportReference(built);
  const digest = verifyImportedSandboxManifest(manifestDigest, manifestBytes, built.Id);
  const reference = `docker.io/hashicorp/vault@sha256:${digest}`;
  let replacements = 0;
  const items = parseAllDocuments(fixture).map(document => {
    if (document.errors.length) throw new Error("Kind dependency fixture is invalid YAML");
    const item = document.toJSON();
    for (const container of item?.spec?.template?.spec?.containers ?? []) {
      if (container.image !== VAULT_FIXTURE_IMAGE) continue;
      container.image = reference;
      container.imagePullPolicy = "Never";
      replacements++;
    }
    return item;
  });
  if (replacements !== 2) throw new Error("Kind must declare the pinned Vault server and initialization images");
  return { reference, items };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cluster = process.argv[2];
  if (!/^muniu-[a-z0-9-]+$/u.test(cluster ?? "")) throw new Error("Expected a dedicated Muniu Kind cluster");
  const node = `${cluster}-control-plane`;
  const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  const inspect = JSON.parse(docker(["inspect", node]))[0];
  if (inspect.Config.Labels["io.x-k8s.kind.cluster"] !== cluster) throw new Error("Kind cluster identity mismatch");
  const built = JSON.parse(docker(["image", "inspect", VAULT_FIXTURE_IMAGE]))[0];
  const importReference = vaultImportReference(built);
  if (process.argv[3] === "--import-reference") {
    docker(["image", "tag", built.Id, importReference]);
    process.stdout.write(importReference);
    process.exit(0);
  }
  if (process.argv[3]) throw new Error("Unknown Vault fixture command");
  const rows = docker(["exec", node, "ctr", "-n", "k8s.io", "images", "ls"]).split("\n")
    .map(line => line.trim().split(/\s+/u));
  // Named archive entries survive a multi-image Docker save/import.
  const row = rows.find(fields => fields[0] === `docker.io/library/${importReference}`);
  if (!row) throw new Error("Pinned Vault configuration is missing from the Kind node");
  const manifestBytes = Buffer.from(docker(["exec", node, "ctr", "-n", "k8s.io", "content", "get", row[2]]));
  const result = prepareImportedVaultFixture({ built, manifestDigest: row[2], manifestBytes,
    fixture: readFileSync(new URL("../../deploy/kind/enterprise-fixture.yaml", import.meta.url), "utf8") });
  const existing = rows.find(fields => fields[0] === result.reference);
  if (existing && existing[2] !== row[2]) throw new Error("Imported Vault reference has an unexpected manifest");
  if (!existing) docker(["exec", node, "ctr", "-n", "k8s.io", "images", "tag", row[0], result.reference]);
  process.stdout.write(JSON.stringify({ apiVersion: "v1", kind: "List", items: result.items }));
}
