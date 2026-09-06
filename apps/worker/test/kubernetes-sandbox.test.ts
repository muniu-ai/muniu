// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KubernetesCodingExecutor, createInClusterKubernetesApi, type KubernetesApi } from "../src/kubernetes-sandbox.js";

const digest = "a".repeat(64);

test("Kubernetes DELETE sends its complete UID precondition body over HTTPS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mn-kube-https-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "ca.crt")], { stdio: "ignore" });
  await writeFile(join(directory, "token"), "fixture-only", { mode: 0o600 });
  const server = createServer({ key: await readFile(join(directory, "key.pem")),
    cert: await readFile(join(directory, "ca.crt")) }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ received: Buffer.concat(chunks).toString("utf8") }));
    });
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = createInClusterKubernetesApi({ endpoint: `https://127.0.0.1:${address.port}`, credentialDirectory: directory });
  const body = { preconditions: { uid: "固定 UID" }, propagationPolicy: "Foreground" };
  const result = await api.request("DELETE", "/api/v1/namespaces/fixture/pods/candidate", body);
  assert.equal(result.status, 200);
  assert.equal(result.value.received, JSON.stringify(body));
  assert.equal((await api.request("GET", "/api/v1/namespaces/fixture/pods/candidate")).status, 200);
});

async function fixture(t: test.TestContext, mode: "valid" | "forged" | "pending" = "valid") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mn-k8s-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  await mkdir(candidate);
  const calls: { method: string; path: string; body?: any }[] = [];
  let deleted = false;
  let manifest: any;
  const api: KubernetesApi = { async request(method, path, body) {
    calls.push({ method, path, body });
    if (method === "POST") { manifest = body; return { status: 201, value: { ...manifest, metadata: { ...manifest.metadata, uid: "uid" } } }; }
    if (method === "DELETE") { deleted = true; return { status: 200, value: {} }; }
    if (deleted) return { status: 404, value: {} };
    if (path.endsWith("/log")) {
      const command = JSON.parse(Buffer.from(manifest.spec.containers[0].env[0].value, "base64").toString("utf8"));
      assert.ok(command.resultPath, "业务命令输出必须使用受控结果文件，不进入 Pod 日志");
      const bytes = Buffer.from(JSON.stringify({ exitCode: 0, stdout: "checked", stderr: "" }));
      await writeFile(command.resultPath, bytes, { flag: "wx", mode: 0o600 });
      return { status: 200, value: JSON.stringify({
      version: 1, resultDigest: createHash("sha256").update(bytes).digest("hex"), proof: {
        tokenMounted: false, readOnlyRootFilesystem: mode !== "forged", pidsLimit: 256,
        kubernetesApiReachable: false, commandDigest: manifest.metadata.annotations["muniu.ai/command-digest"],
      },
    }) }; }
    return { status: 200, value: { ...manifest, metadata: { ...manifest.metadata, uid: "uid" },
      status: { phase: mode === "pending" ? "Pending" : "Succeeded",
        containerStatuses: [{ name: "command", imageID: `image@sha256:${digest}` }] } } };
  } };
  const executor = new KubernetesCodingExecutor({ api, namespace: "mn-test", sharedRoot: root,
    volumeClaim: "workspaces", image: "registry.test/sandbox", imageDigest: digest,
    runtimeClass: "isolated", serviceAccount: "candidate", pollIntervalMs: 1 });
  return { executor, calls, root, candidate };
}

test("Kubernetes 命令只挂载候选子目录，验证实际镜像和运行证明，再删除指定 UID Pod", async (t) => {
  const f = await fixture(t);
  const result = await f.executor.run({ writableRoot: f.candidate, cwd: f.candidate,
    arguments: ["diff", "--check"], signal: new AbortController().signal, timeoutMs: 1000 });
  assert.equal(result.stdout, "checked");
  const pod = f.calls[0]!.body;
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.containers[0].image, `registry.test/sandbox@sha256:${digest}`);
  assert.equal(pod.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.spec.containers[0].volumeMounts[0].subPath, "candidate");
  assert.equal(pod.spec.containers[0].volumeMounts.some((mount: any) => mount.mountPath === f.root), false);
  assert.deepEqual(f.calls.find((call) => call.method === "DELETE")?.body.preconditions, { uid: "uid" });
});

test("缺失运行隔离证明时失败关闭，取消也会删除候选 Pod", async (t) => {
  const forged = await fixture(t, "forged");
  await assert.rejects(forged.executor.run({ writableRoot: forged.candidate, cwd: forged.candidate,
    arguments: ["diff"], signal: new AbortController().signal, timeoutMs: 1000 }), /运行证明/u);
  const pending = await fixture(t, "pending");
  await assert.rejects(pending.executor.run({ writableRoot: pending.candidate, cwd: pending.candidate,
    arguments: ["diff"], signal: AbortSignal.timeout(20), timeoutMs: 1000 }));
  assert.ok(pending.calls.some((call) => call.method === "DELETE"));
  await assert.rejects(pending.executor.run({ writableRoot: pending.root, cwd: pending.root,
    arguments: ["diff"], signal: new AbortController().signal, timeoutMs: 1000 }), /子目录/u);
});
