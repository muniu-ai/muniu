// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

export function createKindPortForward(namespace, resource, mapping, children, launch = spawn) {
  let child;
  let diagnostics = "";
  const reconnect = () => {
    if (child && child.exitCode === null && child.signalCode === null) return;
    diagnostics = "";
    child = launch("kubectl", ["--namespace", namespace, "port-forward", resource, mapping], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
    child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
    children.push(child);
  };
  reconnect();
  return { get child() { return child; }, reconnect, diagnostics: () => diagnostics };
}
