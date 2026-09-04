#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";

const imageDigest = process.env.MN_KIND_IMAGE_DIGEST?.replace(/^sha256:/u, "");
assert.match(imageDigest ?? "", /^[a-f0-9]{64}$/u);
assert.equal(existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token"), false);
writeFileSync("/workspace/probe.txt", "sandbox-ok\n", { mode: 0o600 });
assert.equal(readFileSync("/workspace/probe.txt", "utf8"), "sandbox-ok\n");

let rootReadOnly = false;
try {
  writeFileSync("/mn-root-write-probe", "must fail");
} catch (error) {
  rootReadOnly = error?.code === "EROFS" || error?.code === "EACCES";
}
assert.equal(rootReadOnly, true, "candidate root filesystem 必须只读");

const pidsRaw = readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim();
const pidsLimit = Number(pidsRaw);
assert.ok(Number.isSafeInteger(pidsLimit) && pidsLimit > 0 && pidsLimit <= 256, `pids.max 无效：${pidsRaw}`);

const kubernetesHost = process.env.KUBERNETES_SERVICE_HOST;
assert.ok(kubernetesHost);
const kubernetesPort = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443");
const kubernetesApiReachable = await new Promise((resolve) => {
  const socket = net.createConnection({ host: kubernetesHost, port: kubernetesPort });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
});
assert.equal(kubernetesApiReachable, false, "candidate Pod 不得访问 Kubernetes API");

const proof = {
  schemaVersion: 1,
  issuer: "candidate-runtime",
  runtimeClass: process.env.MN_KIND_RUNTIME_CLASS ?? "muniu-sandbox",
  imageDigest,
  tokenMounted: false,
  readOnlyRootFilesystem: true,
  pidsLimit,
  kubernetesApiReachable,
};
const digest = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
process.stdout.write(`${JSON.stringify({ kindSandboxProbe: "passed", ...proof, digest })}\n`);
