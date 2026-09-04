#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CodingExecutionEngine, createCodingTask } from "@mn/plugin-coding";

const encoded = process.argv[2];
if (!encoded) throw new Error("缺少 candidate runtime proof");
const report = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const { kindSandboxProbe, digest, ...proof } = report;
assert.equal(kindSandboxProbe, "passed");
assert.match(digest, /^[a-f0-9]{64}$/u);
assert.equal(createHash("sha256").update(JSON.stringify(proof)).digest("hex"), digest);
assert.equal(proof.issuer, "candidate-runtime");
assert.equal(proof.tokenMounted, false);
assert.equal(proof.readOnlyRootFilesystem, true);
assert.equal(proof.kubernetesApiReachable, false);
assert.ok(Number.isSafeInteger(proof.pidsLimit) && proof.pidsLimit <= 256);

const sha = (value) => createHash("sha256").update(value).digest("hex");
const runner = {
  id: "builtin",
  external: false,
  async start() { return { sessionId: "kind-authoritative-gate" }; },
  async *events() {
    yield {
      type: "candidate",
      candidate: {
        id: "kind-runtime-candidate",
        sequence: 1,
        baseRevision: "fixture",
        diffDigest: sha("no-code-change"),
        summary: "Kubernetes runtime boundary proof",
        sandbox: { enforced: true, fallbackUsed: false, evidenceDigest: digest },
      },
    };
  },
  async cancel() {},
  async resume() {},
};
const engine = new CodingExecutionEngine({ runners: [runner] });
const result = await engine.execute({
  task: createCodingTask({
    id: "kind-runtime-task",
    workspaceId: "kind-runtime-workspace",
    repositoryId: "kind-runtime-fixture",
    title: "验证 Kubernetes runtime",
    request: "把候选 Pod 的原始证据作为权威 Gate 输入",
    createdAt: new Date(0).toISOString(),
  }),
  controlPlane: {
    protocol: "coding-v2",
    specDigest: sha("kind-spec"),
    governanceDigest: sha("kind-governance"),
    harnessDigest: sha("kind-harness"),
    sandboxDigest: digest,
    repositoryIndexDigest: sha("kind-repository-index"),
  },
  limits: { maxRepairAttempts: 0, maxDurationMs: 60_000 },
  gateVerifier: {
    async verify() {
      return {
        status: "passed",
        authoritative: true,
        evidenceDigest: digest,
        checks: [
          { id: "service-account-token", status: "passed", summary: "未挂载 ServiceAccount token" },
          { id: "read-only-root", status: "passed", summary: "根文件系统只读" },
          { id: "pids-limit", status: "passed", summary: `pids.max=${proof.pidsLimit}` },
          { id: "kubernetes-api", status: "passed", summary: "候选 Pod 无法连接 Kubernetes API" },
        ],
      };
    },
  },
  approval: async () => "approved_once",
});
assert.equal(result.status, "completed");
assert.equal(result.gates[0]?.status, "passed");
assert.equal(result.gates[0]?.authoritative, true);
assert.equal(result.evidence?.gateEvidenceDigest, digest);
process.stdout.write(`${JSON.stringify({
  kindAuthoritativeGate: "passed",
  issuer: "coding-control-plane",
  evidenceDigest: digest,
  checks: result.gates[0].checks.map((check) => check.id),
})}\n`);
