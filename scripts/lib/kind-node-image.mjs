// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// https://github.com/kubernetes-sigs/kind/releases/tag/v0.30.0
export const approvedNodeImage = "kindest/node:v1.34.0@sha256:7416a61b42b1662ca6ca89f02028ac133a309a2a30ba309614e8ec94d976dc5a";
// Config digests from the two platform manifests in the approved index.
const configDigests = {
  arm64: "sha256:b1b6ffc307b4d2ac9bd8902aa24a720ff533ffa5b34193c66d7c0f21f2d77ee7",
  amd64: "sha256:4357c93ef232c51f6665d72256423eeee8f2084e92dbc6b1a05d963da67969ad",
};

export function selectCachedKindNode(configuredImage, cached) {
  if (configuredImage !== approvedNodeImage) throw new Error("Kind node image must use the approved pinned release");
  if (!cached) return configuredImage;
  if (cached.Id !== configDigests[cached.Architecture]) throw new Error("Cached Kind node config digest does not match the pinned release");
  return cached.Id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parse;
  try {
    ({ parse } = await import("yaml"));
  } catch {
    throw new Error("Kind 宿主依赖未就绪；请在仓库根目录执行 npm ci 后重试");
  }
  const configured = parse(readFileSync(new URL("../../deploy/kind/config.yaml", import.meta.url), "utf8"));
  let cached;
  try {
    cached = JSON.parse(execFileSync("docker", ["image", "inspect", "kindest/node:v1.34.0"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }))[0];
  } catch { /* A missing offline cache uses the digest-pinned registry reference. */ }
  process.stdout.write(selectCachedKindNode(configured.nodes[0].image, cached));
}
