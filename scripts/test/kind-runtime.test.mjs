// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sandboxRuntimeConfiguration } from "../lib/kind-runtime.mjs";

test("Kind sandbox runtime bounds container PIDs without changing the default runtime", () => {
  const config = '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]\nbase_runtime_spec = "/etc/containerd/cri-base.json"\n'
    + '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.test-handler]\nbase_runtime_spec = "/etc/containerd/cri-base.json"\n'
    + '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.test-handler.options]\nSystemdCgroup = true\n';
  const base = { linux: { resources: { devices: [{ allow: false }] } }, hooks: { createContainer: [{ path: "/kind/helper" }] } };
  const result = sandboxRuntimeConfiguration(config, base);
  assert.equal(result.spec.linux.resources.pids.limit, 256);
  assert.deepEqual(result.spec.hooks, base.hooks);
  assert.deepEqual(result.spec.linux.resources.devices, base.linux.resources.devices);
  assert.equal(base.linux.resources.pids, undefined);
  assert.match(result.config, /runtimes.runc\]\nbase_runtime_spec = "\/etc\/containerd\/cri-base.json"/);
  assert.match(result.config, /runtimes.test-handler\]\nbase_runtime_spec = "\/etc\/containerd\/muniu-sandbox-base.json"/);
  assert.throws(() => sandboxRuntimeConfiguration(config.replace("runtimes.test-handler]", "runtimes.unknown]"), base));
  const probe = readFileSync(new URL("../../deploy/kind/sandbox-probe.yaml", import.meta.url), "utf8");
  assert.match(probe, /^handler: test-handler$/mu);
});
