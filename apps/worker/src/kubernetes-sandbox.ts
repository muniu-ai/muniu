// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface KubernetesApi {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown,
    signal?: AbortSignal): Promise<{ readonly status: number; readonly value: any }>;
}

export interface SandboxCommand {
  readonly writableRoot: string;
  readonly readOnlyPaths?: readonly string[];
  readonly cwd: string;
  readonly arguments: readonly string[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface CodingCommandExecutor {
  readonly commitment: Readonly<Record<string, string>>;
  run(input: SandboxCommand): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export interface KubernetesCodingOptions {
  readonly api: KubernetesApi;
  readonly namespace: string;
  readonly sharedRoot: string;
  readonly volumeClaim: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly runtimeClass: string;
  readonly serviceAccount: string;
  readonly pollIntervalMs?: number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function includesExpected(actual: any, expected: any): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => includesExpected(actual[index], value));
  if (expected !== null && typeof expected === "object") return actual !== null && typeof actual === "object"
    && Object.entries(expected).every(([key, value]) =>
      (actual[key] === undefined && value === false
        && ["hostNetwork", "hostPID", "hostIPC", "privileged", "readOnly"].includes(key))
      || includesExpected(actual[key], value));
  return actual === expected;
}

function subPath(root: string, path: string): string {
  const result = relative(root, path);
  if (!isAbsolute(path) || !result || result.startsWith("..") || isAbsolute(result)) {
    throw new Error("候选挂载必须是共享卷中的独立子目录");
  }
  return result;
}

export class KubernetesCodingExecutor implements CodingCommandExecutor {
  readonly commitment: Readonly<Record<string, string>>;
  constructor(readonly options: KubernetesCodingOptions) {
    for (const value of [options.namespace, options.volumeClaim, options.runtimeClass, options.serviceAccount]) {
      if (!/^[a-z0-9][a-z0-9.-]*$/u.test(value)) throw new Error("Kubernetes sandbox 配置无效");
    }
    if (!isAbsolute(options.sharedRoot) || !/^[a-f0-9]{64}$/u.test(options.imageDigest)
      || !options.image || options.image.includes("@")) throw new Error("必须固定 sandbox 镜像与共享目录");
    this.commitment = Object.freeze({ driver: "kubernetes", imageDigest: options.imageDigest,
      runtimeClass: options.runtimeClass, volumeClaim: options.volumeClaim,
      namespace: options.namespace, network: "denied", fallback: "forbidden" });
  }

  async run(input: SandboxCommand) {
    input.signal.throwIfAborted();
    const root = await realpath(this.options.sharedRoot);
    if (root !== resolve(this.options.sharedRoot)) throw new Error("共享卷真实路径已变化");
    const mounts = await Promise.all([input.writableRoot, ...(input.readOnlyPaths ?? [])].map(async (path, index) => {
      const actual = await realpath(path);
      if (actual !== path) throw new Error("候选挂载真实路径已变化");
      return { name: "workspace", mountPath: path, subPath: subPath(root, path), readOnly: index !== 0 };
    }));
    if (input.cwd !== input.writableRoot && !input.cwd.startsWith(`${input.writableRoot}/`)) {
      throw new Error("命令工作目录超出候选范围");
    }
    const resultPath = join(input.writableRoot, `.mn-command-${randomUUID()}.json`);
    const command = { arguments: input.arguments, cwd: input.cwd, resultPath };
    const commandDigest = digest(command);
    const name = `mn-code-${randomUUID()}`;
    const path = `/api/v1/namespaces/${this.options.namespace}/pods`;
    const podPath = `${path}/${name}`;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);
    const manifest = {
      apiVersion: "v1", kind: "Pod",
      metadata: { name, namespace: this.options.namespace,
        labels: { "muniu.ai/component": "candidate-sandbox" },
        annotations: { "muniu.ai/command-digest": commandDigest } },
      spec: {
        hostNetwork: false, hostPID: false, hostIPC: false,
        restartPolicy: "Never", automountServiceAccountToken: false,
        serviceAccountName: this.options.serviceAccount, runtimeClassName: this.options.runtimeClass,
        activeDeadlineSeconds: Math.max(1, Math.ceil(input.timeoutMs / 1000)), terminationGracePeriodSeconds: 1,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001,
          seccompProfile: { type: "RuntimeDefault" } },
        containers: [{ name: "command", image: `${this.options.image}@sha256:${this.options.imageDigest}`,
          imagePullPolicy: "IfNotPresent", command: ["node", "/opt/muniu/scripts/coding-sandbox-command.mjs"],
          env: [{ name: "MN_SANDBOX_COMMAND", value: Buffer.from(JSON.stringify(command)).toString("base64") }],
          workingDir: input.cwd,
          securityContext: { privileged: false, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] } },
          resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "1", memory: "512Mi" } },
          volumeMounts: [...mounts, { name: "tmp", mountPath: "/tmp" }],
        }],
        volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: this.options.volumeClaim } },
          { name: "tmp", emptyDir: { sizeLimit: "64Mi" } }],
      },
    };
    let uid: string | undefined;
    try {
      const created = await this.options.api.request("POST", path, manifest, signal);
      if (created.status !== 201 || typeof created.value.metadata?.uid !== "string") {
        throw new Error("无法创建 Kubernetes 候选 Pod");
      }
      uid = created.value.metadata.uid;
      for (;;) {
        signal.throwIfAborted();
        const observed = await this.options.api.request("GET", podPath, undefined, signal);
        if (observed.status !== 200 || observed.value.metadata?.uid !== uid) throw new Error("候选 Pod 身份已变化");
        const pod = observed.value;
        if (!includesExpected(pod.spec, manifest.spec) || pod.spec.initContainers?.length
          || pod.spec.ephemeralContainers?.length || pod.spec.containers[0].lifecycle) {
          throw new Error("Kubernetes 候选运行配置已变化");
        }
        if (pod.status?.phase === "Failed") throw new Error("Kubernetes 候选命令失败");
        if (pod.status?.phase === "Succeeded") {
          const imageId: unknown = pod.status.containerStatuses?.[0]?.imageID;
          if (typeof imageId !== "string" || !imageId.endsWith(`sha256:${this.options.imageDigest}`)) {
            throw new Error("候选实际镜像摘要不一致");
          }
          const logs = await this.options.api.request("GET", `${podPath}/log`, undefined, signal);
          if (logs.status !== 200 || typeof logs.value !== "string") throw new Error("无法读取候选运行证明");
          const receipt = JSON.parse(logs.value);
          const proof = receipt.proof;
          if (receipt.version !== 1 || !/^[a-f0-9]{64}$/u.test(receipt.resultDigest)
            || proof?.tokenMounted !== false || proof?.readOnlyRootFilesystem !== true
            || proof?.kubernetesApiReachable !== false || proof?.commandDigest !== commandDigest
            || !Number.isSafeInteger(proof?.pidsLimit) || proof.pidsLimit < 1 || proof.pidsLimit > 256) {
            throw new Error("候选运行证明无效");
          }
          const file = await open(resultPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("候选结果文件无效");
            bytes = await file.readFile();
          } finally { await file.close(); }
          if (createHash("sha256").update(bytes).digest("hex") !== receipt.resultDigest) throw new Error("候选结果摘要不一致");
          const result = JSON.parse(bytes.toString("utf8"));
          if (!Number.isSafeInteger(result.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error("候选结果格式无效");
          return { exitCode: result.exitCode as number, stdout: result.stdout as string, stderr: result.stderr as string };
        }
        await delay(this.options.pollIntervalMs ?? 250, undefined, { signal });
      }
    } finally {
      const cleanupSignal = AbortSignal.timeout(15_000);
      if (!uid) {
        const orphan = await this.options.api.request("GET", podPath, undefined, cleanupSignal);
        if (orphan.status === 200) uid = orphan.value.metadata?.uid;
      }
      if (uid) {
        const removed = await this.options.api.request("DELETE", podPath,
          { preconditions: { uid }, propagationPolicy: "Foreground" }, cleanupSignal);
        if (![200, 202, 404].includes(removed.status)) throw new Error("候选 Pod 清理结果需要核对");
        for (;;) {
          const status = await this.options.api.request("GET", podPath, undefined, cleanupSignal);
          if (status.status === 404) break;
          if (status.status !== 200 || status.value.metadata?.uid !== uid) throw new Error("候选 Pod 清理身份不一致");
          await delay(this.options.pollIntervalMs ?? 250, undefined, { signal: cleanupSignal });
        }
      }
      await unlink(resultPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

export function createInClusterKubernetesApi(options: {
  readonly endpoint?: string;
  readonly credentialDirectory?: string;
} = {}): KubernetesApi {
  const endpoint = options.endpoint ?? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443"}`;
  if (new URL(endpoint).protocol !== "https:") throw new Error("Kubernetes API 必须使用 HTTPS");
  const directory = options.credentialDirectory ?? "/var/run/secrets/kubernetes.io/serviceaccount";
  return { async request(method, path, body, signal) {
    const [token, ca] = await Promise.all([readFile(`${directory}/token`, "utf8"), readFile(`${directory}/ca.crt`)]);
    const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolveRequest, reject) => {
      const request = httpsRequest(new URL(path, endpoint), { method, ca, signal,
        headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json",
          ...(encodedBody ? { "content-length": encodedBody.byteLength } : {}) } }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 4 * 1024 * 1024) { response.destroy(new Error("Kubernetes 响应超过大小上限")); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolveRequest({ status: response.statusCode ?? 500,
              value: path.endsWith("/log") ? text : text ? JSON.parse(text) : {} });
          } catch { reject(new Error(`Kubernetes ${method} 响应不是有效 JSON（HTTP ${response.statusCode ?? 0}）`)); }
        });
      });
      request.on("error", () => reject(new Error("无法连接 Kubernetes API")));
      request.setTimeout(10_000, () => request.destroy());
      request.end(encodedBody);
    });
  } };
}
