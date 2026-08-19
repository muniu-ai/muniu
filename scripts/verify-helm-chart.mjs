// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

const chart = "deploy/helm/muniu";
const values = `${chart}/values-ci.yaml`;

function helm(args, expectSuccess = true) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (expectSuccess && result.status !== 0) {
    throw new Error(`helm ${args.join(" ")} failed:\n${output}`);
  }
  if (!expectSuccess && result.status === 0) {
    throw new Error(`helm ${args.join(" ")} unexpectedly succeeded`);
  }
  return output;
}

helm(["lint", chart, "--values", values]);
const rendered = helm(["template", "muniu", chart, "--values", values]);
if (!rendered.includes("name: muniu-api")) {
  throw new Error("default chart does not render the API deployment");
}
if (rendered.includes("app.kubernetes.io/component: worker")) {
  throw new Error("default chart unexpectedly renders Worker resources");
}
if (!rendered.includes("name: muniu-api-external-egress")) {
  throw new Error("CI chart values do not render the explicit API egress policy");
}

const production = helm([
  "template",
  "muniu",
  chart,
  "--values",
  values,
  "--set",
  "worker.enabled=true"
]);
if (!production.includes("name: muniu-worker\n") || !production.includes("- --sandbox-driver\n            - kubernetes")) {
  throw new Error("production chart does not render the Kubernetes Worker");
}
if (production.includes("            - --mock\n")) {
  throw new Error("production Worker unexpectedly uses the fixture executor");
}
for (const required of [
  "name: muniu-candidate",
  "name: muniu-worker-sandbox-controller",
  "name: muniu-api-sandbox-authority",
  'resources: ["pods/exec"]',
  "name: muniu-sandbox-workspaces",
  "name: MN_KUBERNETES_RUNTIME_CLASS",
  "name: muniu-sandbox-default-deny",
  "name: muniu-kubernetes-api-egress",
  "name: muniu-worker-api-egress"
]) {
  if (!production.includes(required)) {
    throw new Error(`production chart is missing Kubernetes boundary: ${required}`);
  }
}
if (!/name: muniu-candidate[\s\S]*?automountServiceAccountToken: false/u.test(production)) {
  throw new Error("candidate ServiceAccount must not mount a Kubernetes token");
}
if (/\bhostPath\s*:/u.test(production)) {
  throw new Error("production chart must not render hostPath volumes");
}

const invalidDriver = helm([
  "template",
  "muniu",
  chart,
  "--values",
  values,
  "--set",
  "sandbox.driver=docker"
], false);
if (!invalidDriver.includes("requires sandbox.driver=kubernetes")) {
  throw new Error("unsupported in-cluster Docker driver did not fail closed");
}

const fixture = helm([
  "template",
  "muniu",
  chart,
  "--values",
  values,
  "--set",
  "worker.enabled=true",
  "--set",
  "worker.fixtureMode=true"
]);
if (!fixture.includes("            - --mock\n")) {
  throw new Error("fixture Worker does not explicitly use the mock executor");
}

console.log("Helm chart verification passed");
