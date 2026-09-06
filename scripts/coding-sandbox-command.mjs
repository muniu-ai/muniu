// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";

const input = JSON.parse(Buffer.from(process.env.MN_SANDBOX_COMMAND ?? "", "base64").toString("utf8"));
if (!Array.isArray(input.arguments) || input.arguments.some((value) => typeof value !== "string" || value.includes("\0"))
  || typeof input.cwd !== "string" || !input.cwd.startsWith("/")
  || typeof input.resultPath !== "string"
  || (dirname(input.resultPath) !== input.cwd && !input.cwd.startsWith(`${dirname(input.resultPath)}/`))
  || !/\/\.mn-command-[a-f0-9-]+\.json$/u.test(input.resultPath)) throw new Error("候选命令无效");
const tokenMounted = existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token");
let readOnlyRootFilesystem = false;
try { writeFileSync("/mn-runtime-proof", "invalid", { flag: "wx" }); }
catch (error) { readOnlyRootFilesystem = error.code === "EROFS"; }
const pidsLimit = Number(readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim());
if (!process.env.KUBERNETES_SERVICE_HOST) throw new Error("缺少 Kubernetes 运行环境");
const kubernetesApiReachable = await new Promise((resolve) => {
  const socket = net.createConnection({ host: process.env.KUBERNETES_SERVICE_HOST,
    port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443") });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});
if (tokenMounted || !readOnlyRootFilesystem || kubernetesApiReachable
  || !Number.isSafeInteger(pidsLimit) || pidsLimit < 1 || pidsLimit > 256) throw new Error("候选运行隔离检查失败");
const proof = { tokenMounted, readOnlyRootFilesystem, pidsLimit, kubernetesApiReachable,
  commandDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
const result = await new Promise((resolve, reject) => {
  const child = spawn("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "diff.external=", "-c", "core.pager=cat", ...input.arguments], {
    cwd: input.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", TMPDIR: "/tmp", LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  });
  let bytes = 0;
  let stdout = "";
  let stderr = "";
  const append = (stream) => (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("候选输出超过大小上限")); return; }
    if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", append("stdout"));
  child.stderr.on("data", append("stderr"));
  child.once("error", reject);
  child.once("exit", (code) => resolve({ exitCode: code ?? 255, stdout, stderr }));
});
const resultBytes = Buffer.from(JSON.stringify(result));
writeFileSync(input.resultPath, resultBytes, { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ version: 1, resultDigest: createHash("sha256").update(resultBytes).digest("hex"), proof }));
