// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function verifyImportedSandboxManifest(manifestDigest, bytes, configurationDigest) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(configurationDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(manifestDigest)
    || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== manifestDigest) {
    throw new Error("Imported sandbox manifest digest does not match its content");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 2 || manifest.config?.digest !== configurationDigest) {
    throw new Error("Imported sandbox manifest does not reference the built image configuration");
  }
  return manifestDigest.slice(7);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cluster = process.argv[2];
  if (!/^muniu-[a-z0-9-]+$/u.test(cluster ?? "")) throw new Error("Expected a dedicated Muniu Kind cluster");
  const node = `${cluster}-control-plane`;
  const inspect = JSON.parse(execFileSync("docker", ["inspect", node], { encoding: "utf8" }))[0];
  if (inspect.Config.Labels["io.x-k8s.kind.cluster"] !== cluster) throw new Error("Kind cluster identity mismatch");
  const image = "docker.io/library/muniu-kind:ci";
  const docker = args => execFileSync("docker", ["exec", node, ...args], { encoding: "utf8" });
  const row = docker(["ctr", "-n", "k8s.io", "images", "ls"]).split("\n")
    .map(line => line.trim().split(/\s+/u)).find(fields => fields[0] === image);
  if (!row) throw new Error("Built sandbox image is missing from the Kind node");
  const built = JSON.parse(execFileSync("docker", ["image", "inspect", "muniu-kind:ci"], { encoding: "utf8" }))[0];
  const bytes = Buffer.from(docker(["ctr", "-n", "k8s.io", "content", "get", row[2]]));
  const digest = verifyImportedSandboxManifest(row[2], bytes, built.Id);
  const reference = `docker.io/library/muniu-kind@sha256:${digest}`;
  docker(["ctr", "-n", "k8s.io", "images", "tag", image, reference]);
  process.stdout.write(digest);
}
