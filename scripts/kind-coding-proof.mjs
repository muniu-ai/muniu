// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const namespace = "muniu-kind";
function kubectl(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", ["--namespace", namespace, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
    child.stdin.end(input);
  });
}

const deployment = JSON.parse(await kubectl(["get", "deployment/muniu-worker", "-o", "json"]));
const template = structuredClone(deployment.spec.template);
const container = template.spec.containers[0];
container.args = ["scripts/kind-production-coding.mjs"];
delete container.readinessProbe;
delete container.livenessProbe;
container.env = container.env.filter((value) => value.name !== "MN_WORKER_FIXTURE_MODE");
container.env.push({ name: "MN_WORKER_FIXTURE_MODE", value: "false" });
template.spec.restartPolicy = "Never";
const job = { apiVersion: "batch/v1", kind: "Job", metadata: { name: "muniu-production-coding", namespace },
  spec: { backoffLimit: 0, activeDeadlineSeconds: 300, template } };
try {
  await kubectl(["scale", "deployment/muniu-worker", "--replicas=0"]);
  await kubectl(["wait", "--for=delete", "pod", "--selector",
    "app.kubernetes.io/instance=muniu,app.kubernetes.io/component=worker", "--timeout=60s"]);
  await kubectl(["create", "-f", "-"], JSON.stringify(job));
  try {
    await kubectl(["wait", "--for=jsonpath={.status.conditions}", "job/muniu-production-coding", "--timeout=300s"]);
    const observed = JSON.parse(await kubectl(["get", "job/muniu-production-coding", "-o", "json"]));
    assert.equal(observed.status.conditions.some((condition) => condition.status === "True"
      && ["Failed", "FailureTarget"].includes(condition.type)), false, "生产 Coding 验证 Job 失败");
    await kubectl(["wait", "--for=condition=Complete", "job/muniu-production-coding", "--timeout=300s"]);
  } catch (error) {
    const logs = await kubectl(["logs", "job/muniu-production-coding"]).catch(() => "");
    throw new Error(`${error.message}\n${logs}`);
  }
  const logs = await kubectl(["logs", "job/muniu-production-coding"]);
  assert.match(logs, /"kindProductionCoding":"passed"/u);
  process.stdout.write(logs);
} finally {
  await kubectl(["scale", "deployment/muniu-worker", `--replicas=${deployment.spec.replicas}`]);
  await kubectl(["rollout", "status", "deployment/muniu-worker", "--timeout=120s"]);
}
