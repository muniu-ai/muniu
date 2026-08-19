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

const rejected = helm([
  "template",
  "muniu",
  chart,
  "--values",
  values,
  "--set",
  "worker.enabled=true"
], false);
if (!rejected.includes("worker.enabled requires worker.fixtureMode=true")) {
  throw new Error("unsupported production Worker did not fail closed");
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
if (!fixture.includes('"--enterprise", "--mock"')) {
  throw new Error("fixture Worker does not explicitly use the mock executor");
}

console.log("Helm chart verification passed");
