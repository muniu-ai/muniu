// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sandboxSpecPath = "/etc/containerd/muniu-sandbox-base.json";

export function sandboxRuntimeConfiguration(config, originalSpec) {
  const section = /(\[plugins\."io\.containerd\.grpc\.v1\.cri"\.containerd\.runtimes\.test-handler\]\s*\n)([^[]*)/gu;
  let matched = 0;
  const next = config.replace(section, (_all, header, body) => {
    if (!/base_runtime_spec\s*=\s*"\/etc\/containerd\/(?:cri-base|muniu-sandbox-base)\.json"/u.test(body)) {
      throw new Error("Unrecognized Kind sandbox base runtime specification");
    }
    matched++;
    return header + body.replace(/base_runtime_spec\s*=\s*"[^"]+"/u, `base_runtime_spec = "${sandboxSpecPath}"`);
  });
  if (matched !== 1) throw new Error("Kind must provide exactly one test-handler runtime");
  const spec = structuredClone(originalSpec);
  if (!spec.linux?.resources) throw new Error("Kind base runtime lacks Linux resources");
  spec.linux.resources.pids = { limit: 256 };
  return { config: next, spec };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cluster = process.argv[2];
  if (!/^muniu-[a-z0-9-]+$/u.test(cluster ?? "")) throw new Error("Expected a dedicated Muniu Kind fixture cluster");
  const node = `${cluster}-control-plane`;
  const docker = (args, input) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, ...(input ? { input } : {}) });
  const inspect = JSON.parse(docker(["inspect", node]))[0];
  if (inspect.Config.Labels["io.x-k8s.kind.cluster"] !== cluster
    || inspect.Config.Labels["io.x-k8s.kind.role"] !== "control-plane") throw new Error("Kind fixture node identity mismatch");
  const { config, spec } = sandboxRuntimeConfiguration(
    docker(["exec", node, "cat", "/etc/containerd/config.toml"]),
    JSON.parse(docker(["exec", node, "cat", "/etc/containerd/cri-base.json"])),
  );
  docker(["exec", "-i", node, "tee", sandboxSpecPath], JSON.stringify(spec));
  docker(["exec", "-i", node, "tee", "/etc/containerd/config.toml"], config);
  docker(["exec", node, "systemctl", "restart", "containerd"]);
}
