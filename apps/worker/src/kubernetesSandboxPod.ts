import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CoreV1Api,
  Exec,
  KubeConfig,
  type V1Pod,
  type V1Status
} from "@kubernetes/client-node";
import type {
  SandboxExecutionEvidence,
  SandboxLeaseAttestation,
  SandboxPreparation,
  SandboxPreparationRequest,
  SandboxRuntimeProof
} from "@mn/harness";
import { sha256Canonical } from "@mn/governance";
import type { ReleasableSandboxBackend } from "./sandboxBackends.js";
import type {
  DockerSandboxCommandResult,
  DockerSandboxExecuteRequest,
  DockerSandboxExpectedBinding,
  DockerRuntimeProofAuthority
} from "./dockerSandboxBackend.js";
import type {
  GateCommandExecutionRequest,
  GateCommandExecutor,
  GateResolvedToolIdentity
} from "./gateEngine.js";
import {
  materializeWorkspaceSnapshot,
  parseWorkspaceSnapshot
} from "./workspaceSnapshot.js";

export interface KubernetesSandboxConfiguration {
  readonly namespace: string;
  readonly sharedVolumeClaimName: string;
  readonly sharedWorkspaceRoot: string;
  readonly serviceAccountName: string;
  readonly runtimeClassName: string;
  readonly imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  readonly podStartTimeoutSeconds?: number;
}

export interface KubernetesSandboxSourceSnapshot {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly content: Buffer | Uint8Array;
}

export interface KubernetesSandboxPodOptions extends KubernetesSandboxConfiguration {
  readonly image: string;
  readonly attestation: SandboxLeaseAttestation;
  readonly expected: DockerSandboxExpectedBinding;
  readonly sourceSnapshot: KubernetesSandboxSourceSnapshot;
  readonly runtimeProofAuthority?: DockerRuntimeProofAuthority;
  readonly control?: KubernetesPodControl;
}

export interface KubernetesPodControl {
  create(namespace: string, pod: V1Pod): Promise<V1Pod>;
  read(namespace: string, name: string): Promise<V1Pod>;
  delete(namespace: string, name: string): Promise<void>;
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: readonly string[],
    request: Pick<DockerSandboxExecuteRequest, "stdin" | "timeoutSeconds" | "signal">
  ): Promise<DockerSandboxCommandResult>;
}

interface ActiveKubernetesLease {
  readonly podName: string;
  readonly projectRoot: string;
  readonly scratchRoot: string;
  readonly projectTarget: string;
  readonly scratchTarget: string;
  readonly evidence: SandboxExecutionEvidence;
  readonly resolvedTools: Map<string, string>;
}

const TOOL_IDENTITY_SCRIPT = [
  "set -eu",
  "tool=$1",
  "resolved=$(command -v \"$tool\")",
  "canonical=$(readlink -f \"$resolved\")",
  "case \"$canonical\" in /bin/*|/sbin/*|/usr/*|/opt/*) ;; *) exit 65 ;; esac",
  "digest=$(sha256sum \"$canonical\")",
  "digest=${digest%% *}",
  "printf '%s\\n%s\\n' \"$canonical\" \"$digest\""
].join("\n");

export class KubernetesSandboxPodBackend implements ReleasableSandboxBackend {
  readonly id: string;
  readonly version: string;
  readonly enforcement = "enforced" as const;
  readonly capabilities = Object.freeze([
    "mount-policy",
    "network-policy",
    "resource-limits",
    "secret-injection",
    "tool-allowlist",
    "read-only-root-filesystem",
    "runtime-inspection",
    "kubernetes-pod",
    "content-addressed-source"
  ]);
  readonly #configuration: Required<Omit<KubernetesSandboxConfiguration, "imagePullPolicy" | "podStartTimeoutSeconds">> & {
    readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";
    readonly podStartTimeoutSeconds: number;
  };
  readonly #image: string;
  readonly #attestation: SandboxLeaseAttestation;
  readonly #snapshot: KubernetesSandboxSourceSnapshot;
  readonly #runtimeProofAuthority: DockerRuntimeProofAuthority;
  readonly #control: KubernetesPodControl;
  readonly #leases = new Map<string, ActiveKubernetesLease>();

  constructor(options: KubernetesSandboxPodOptions) {
    this.#attestation = validateAttestation(options.attestation, options.expected);
    if (typeof options.runtimeProofAuthority !== "function") {
      throw new TypeError("enterprise Kubernetes sandbox requires a trusted runtime proof authority");
    }
    this.#runtimeProofAuthority = options.runtimeProofAuthority;
    this.#configuration = normalizeConfiguration(options);
    this.#control = options.control ?? new DefaultKubernetesPodControl();
    const approvedImage = this.#attestation.policy.runtimeImage;
    if (!approvedImage || !/^[a-f0-9]{64}$/u.test(approvedImage.digest)) {
      throw new TypeError("enterprise Kubernetes sandbox requires an API-approved image");
    }
    if (options.image !== approvedImage.reference) {
      throw new TypeError("worker sandbox image cannot override the API-approved image");
    }
    if (this.#attestation.policy.network.mode !== "deny") {
      throw new TypeError("Kubernetes sandbox Pods require a deny-all network lease");
    }
    const snapshotContent = Buffer.from(options.sourceSnapshot.content);
    if (
      options.sourceSnapshot.schemaVersion !== 1 ||
      options.sourceSnapshot.byteLength !== snapshotContent.byteLength ||
      sha256(snapshotContent) !== options.sourceSnapshot.digest
    ) {
      throw new TypeError("content-addressed source snapshot binding is invalid");
    }
    parseWorkspaceSnapshot(snapshotContent);
    this.#snapshot = Object.freeze({ ...options.sourceSnapshot, content: snapshotContent });
    this.#image = approvedImage.reference;
    this.id = this.#attestation.backend.id;
    this.version = this.#attestation.backend.version;
  }

  async prepare(request: SandboxPreparationRequest): Promise<SandboxPreparation> {
    requireIdentity(request.taskId, "taskId");
    requireSubset(
      (request.commandAllowlist ?? []).map((value) => requireExecutable(value, "command")),
      this.#attestation.policy.allowedTools,
      "requested command allowlist"
    );
    if ((request.networkAllowlist?.length ?? 0) > 0) {
      throw new Error("Kubernetes sandbox lease denies all network access");
    }
    const leaseDirectory = kubernetesLeaseDirectoryName(this.#attestation);
    const leaseRoot = safeChild(this.#configuration.sharedWorkspaceRoot, leaseDirectory);
    const projectRoot = join(leaseRoot, "project");
    const scratchRoot = join(leaseRoot, "scratch");
    let leaseRootCreated = false;
    let podCreated = false;
    const podName = kubernetesSandboxPodName(this.#attestation);
    try {
      // Candidate Pods run as an unrelated uid. The lease directory contains
      // only content-addressed source and scratch data, so it must be
      // traversable while the project tree itself remains read-only.
      await mkdir(leaseRoot, { recursive: false, mode: 0o755 });
      leaseRootCreated = true;
      await chmod(leaseRoot, 0o755);
      await materializeWorkspaceSnapshot(
        this.#snapshot.content,
        projectRoot,
        this.#snapshot.digest
      );
      await makeTreeReadOnly(projectRoot);
      await mkdir(scratchRoot, { mode: 0o777 });
      await chmod(scratchRoot, 0o777);
      const manifest = buildKubernetesSandboxPod({
        attestation: this.#attestation,
        configuration: this.#configuration,
        sourceSnapshotDigest: this.#snapshot.digest
      });
      await this.#control.create(this.#configuration.namespace, manifest);
      podCreated = true;
      const running = await waitForRunningPod(
        this.#control,
        this.#configuration.namespace,
        podName,
        this.#configuration.podStartTimeoutSeconds
      );
      verifyKubernetesSandboxPod(running, {
        attestation: this.#attestation,
        configuration: this.#configuration,
        sourceSnapshotDigest: this.#snapshot.digest
      });
      const runtimeId = kubernetesSandboxRuntimeId(
        this.#configuration.namespace,
        podName
      );
      const runtimeProof = validateAuthorityProofEnvelope(
        await this.#runtimeProofAuthority({ attestation: this.#attestation, runtimeId }),
        this.#attestation,
        runtimeId
      );
      const evidence = deepFreeze({
        backendId: this.id,
        backendVersion: this.version,
        leaseId: this.#attestation.leaseId,
        attestationDigest: this.#attestation.digest,
        runtimeId,
        runtimeDigest: runtimeProof.runtimeDigest,
        imageDigest: runtimeProof.imageDigest!,
        runtimeProof
      });
      this.#leases.set(this.#attestation.leaseId, {
        podName,
        projectRoot,
        scratchRoot,
        projectTarget: requiredMount(this.#attestation, "project").target,
        scratchTarget: requiredMount(this.#attestation, "scratch").target,
        evidence,
        resolvedTools: new Map()
      });
      return Object.freeze({
        backendId: this.id,
        workspacePath: requiredMount(this.#attestation, "project").target,
        leaseId: this.#attestation.leaseId
      });
    } catch (error) {
      if (podCreated) {
        await this.#control.delete(this.#configuration.namespace, podName).catch(() => undefined);
      }
      if (leaseRootCreated) await removeLeaseRoot(leaseRoot);
      throw error;
    }
  }

  executionEvidence(leaseId: string): SandboxExecutionEvidence {
    return this.#requireLease(leaseId).evidence;
  }

  sourceRoot(leaseId: string): string {
    return this.#requireLease(leaseId).projectRoot;
  }

  workspaceRoot(leaseId: string): string {
    return this.#requireLease(leaseId).scratchRoot;
  }

  containerPath(leaseId: string, hostPath: string): string {
    const lease = this.#requireLease(leaseId);
    return containerPathForLease(lease, requireAbsolutePath(hostPath, "hostPath"));
  }

  gateCommandExecutor(leaseId: string): GateCommandExecutor {
    const evidence = this.executionEvidence(leaseId);
    return Object.freeze({
      id: "kubernetes/pod-exec",
      version: "1",
      sandboxExecution: evidence,
      resolveToolIdentity: (executable: string, cwd: string) =>
        this.#resolveToolIdentity(leaseId, executable, cwd),
      execute: async (request: GateCommandExecutionRequest) => {
        const result = await this.execute(leaseId, request);
        const timestamp = new Date().toISOString();
        if (result.stdout) request.onEvent?.({
          runId: request.runId,
          candidateId: request.candidateId,
          type: "stdout",
          message: result.stdout,
          timestamp
        });
        if (result.stderr) request.onEvent?.({
          runId: request.runId,
          candidateId: request.candidateId,
          type: "stderr",
          message: result.stderr,
          timestamp
        });
        return result;
      },
      probeVersion: async (
        executable: string,
        versionArgs: readonly string[],
        cwd: string
      ) => {
        const result = await this.execute(leaseId, {
          executable,
          args: versionArgs,
          cwd,
          timeoutSeconds: 10
        });
        return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0] || "unknown";
      }
    });
  }

  async execute(
    leaseId: string,
    request: DockerSandboxExecuteRequest
  ): Promise<DockerSandboxCommandResult> {
    const lease = this.#requireLease(leaseId);
    const executable = requireRuntimeExecutable(request.executable, "executable");
    const tool = isAbsolute(executable) ? lease.resolvedTools.get(executable) : executable;
    if (!tool) throw new Error("absolute executable was not resolved by the runtime authority");
    if (!this.#attestation.policy.allowedTools.includes(tool)) {
      throw new Error(`tool ${tool} is not allowed by sandbox lease`);
    }
    const cwd = this.containerPath(leaseId, await realpath(requireAbsolutePath(request.cwd, "cwd")));
    if ((request.secretNames?.length ?? 0) > 0) {
      throw new Error("Kubernetes candidate Pods do not accept secret injection");
    }
    const environment = Object.entries(request.env ?? {}).map(([name, value]) => {
      if (!SAFE_EXECUTION_ENVIRONMENT.has(name) || /[\0\r\n]/u.test(value)) {
        throw new Error(`Kubernetes candidate environment ${name} is not allowed`);
      }
      return `${name}=${value}`;
    });
    const timeoutSeconds = Math.min(
      positiveInteger(request.timeoutSeconds, "timeoutSeconds"),
      this.#attestation.policy.resources.timeoutSeconds
    );
    const command = [
      "/bin/sh",
      "-ceu",
      "cd \"$1\"; shift; exec \"$@\"",
      "mn-pod-exec",
      cwd,
      ...(environment.length > 0 ? ["/usr/bin/env", ...environment] : []),
      executable,
      ...request.args.map(requireArgument)
    ];
    return this.#control.exec(
      this.#configuration.namespace,
      lease.podName,
      "candidate",
      command,
      {
        timeoutSeconds,
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request.signal ? { signal: request.signal } : {})
      }
    );
  }

  async release(leaseId: string): Promise<void> {
    const lease = this.#requireLease(leaseId);
    this.#leases.delete(leaseId);
    await this.#control.delete(this.#configuration.namespace, lease.podName);
    await removeLeaseRoot(resolve(lease.projectRoot, ".."));
  }

  async #resolveToolIdentity(
    leaseId: string,
    executable: string,
    cwd: string
  ): Promise<GateResolvedToolIdentity> {
    const lease = this.#requireLease(leaseId);
    const requestedExecutable = requireExecutable(executable, "executable");
    if (!this.#attestation.policy.allowedTools.includes(requestedExecutable)) {
      throw new Error(`tool ${requestedExecutable} is not allowed by sandbox lease`);
    }
    const containerCwd = this.containerPath(
      leaseId,
      await realpath(requireAbsolutePath(cwd, "cwd"))
    );
    const result = await this.#control.exec(
      this.#configuration.namespace,
      lease.podName,
      "candidate",
      ["/bin/sh", "-ceu", TOOL_IDENTITY_SCRIPT, "mn-tool-resolver", requestedExecutable],
      { timeoutSeconds: 30 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`trusted runtime could not resolve ${requestedExecutable}: ${result.stderr || result.stdout}`);
    }
    const lines = result.stdout.trim().split(/\r?\n/u);
    if (
      lines.length !== 2 ||
      !/^\/(?:bin|sbin|usr|opt)\//u.test(lines[0]!) ||
      !/^[a-f0-9]{64}$/u.test(lines[1]!) ||
      !lease.evidence.imageDigest
    ) {
      throw new Error("trusted runtime returned an invalid executable identity");
    }
    lease.resolvedTools.set(lines[0]!, requestedExecutable);
    return Object.freeze({
      schemaVersion: 1,
      requestedExecutable,
      resolvedExecutable: lines[0]!,
      contentDigest: lines[1]!,
      imageDigest: lease.evidence.imageDigest
    });
  }

  #requireLease(leaseId: string): ActiveKubernetesLease {
    const lease = this.#leases.get(requireIdentity(leaseId, "leaseId"));
    if (!lease) throw new Error(`Unknown or inactive Kubernetes sandbox lease ${leaseId}`);
    return lease;
  }
}

export function buildKubernetesSandboxPod(input: {
  readonly attestation: SandboxLeaseAttestation;
  readonly configuration: KubernetesSandboxConfiguration;
  readonly sourceSnapshotDigest: string;
}): V1Pod {
  const configuration = normalizeConfiguration(input.configuration);
  const attestation = input.attestation;
  const runtimeImage = attestation.policy.runtimeImage;
  if (!runtimeImage) throw new TypeError("sandbox attestation has no runtime image");
  requireDigest(input.sourceSnapshotDigest, "sourceSnapshotDigest");
  const projectMount = requiredMount(attestation, "project");
  const scratchMount = requiredMount(attestation, "scratch");
  const leaseDirectory = kubernetesLeaseDirectoryName(attestation);
  const duration = Math.max(60, attestation.policy.resources.timeoutSeconds + 60);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: kubernetesSandboxPodName(attestation),
      namespace: configuration.namespace,
      labels: {
        "muniu.ai/component": "candidate-sandbox",
        "muniu.ai/managed-by": "muniu-worker",
        "muniu.ai/runtime-id": kubernetesSandboxRuntimeId(
          configuration.namespace,
          kubernetesSandboxPodName(attestation)
        ).slice(0, 63)
      },
      annotations: {
        "muniu.ai/lease-id": attestation.leaseId,
        "muniu.ai/attestation-digest": attestation.digest,
        "muniu.ai/claim-digest": attestation.claimDigest,
        "muniu.ai/run-id": attestation.runId,
        "muniu.ai/tenant-id": attestation.tenantId,
        "muniu.ai/worker-id": attestation.workerId,
        "muniu.ai/source-snapshot-digest": input.sourceSnapshotDigest,
        "muniu.ai/network-policy": "default-deny",
        "muniu.ai/pids-limit": String(attestation.policy.resources.pids)
      }
    },
    spec: {
      serviceAccountName: configuration.serviceAccountName,
      automountServiceAccountToken: false,
      runtimeClassName: configuration.runtimeClassName,
      restartPolicy: "Never",
      activeDeadlineSeconds: duration,
      terminationGracePeriodSeconds: 5,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65534,
        runAsGroup: 65534,
        fsGroup: 65534,
        seccompProfile: { type: "RuntimeDefault" }
      },
      containers: [{
        name: "candidate",
        image: digestPinnedImage(runtimeImage.reference, runtimeImage.digest),
        imagePullPolicy: configuration.imagePullPolicy,
        command: ["sleep", String(duration)],
        workingDir: projectMount.target,
        env: [],
        envFrom: [],
        stdin: false,
        stdinOnce: false,
        tty: false,
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
          runAsUser: 65534,
          runAsGroup: 65534,
          privileged: false,
          capabilities: { drop: ["ALL"] },
          seccompProfile: { type: "RuntimeDefault" }
        },
        resources: {
          requests: {
            cpu: String(attestation.policy.resources.cpu),
            memory: `${attestation.policy.resources.memoryMb}Mi`
          },
          limits: {
            cpu: String(attestation.policy.resources.cpu),
            memory: `${attestation.policy.resources.memoryMb}Mi`
          }
        },
        volumeMounts: [
          {
            name: "workspace",
            mountPath: projectMount.target,
            subPath: `${leaseDirectory}/project`,
            readOnly: true
          },
          {
            name: "workspace",
            mountPath: scratchMount.target,
            subPath: `${leaseDirectory}/scratch`,
            readOnly: false
          },
          { name: "tmp", mountPath: "/tmp", readOnly: false }
        ],
        terminationMessagePath: "/dev/termination-log",
        terminationMessagePolicy: "File"
      }],
      initContainers: [],
      volumes: [
        {
          name: "workspace",
          persistentVolumeClaim: {
            claimName: configuration.sharedVolumeClaimName,
            readOnly: false
          }
        },
        {
          name: "tmp",
          emptyDir: { medium: "Memory", sizeLimit: "16Mi" }
        }
      ]
    }
  };
}

export interface VerifiedKubernetesSandboxPod {
  readonly runtimeId: string;
  readonly runtimeDigest: string;
  readonly imageDigest: string;
  readonly podName: string;
  readonly podUid: string;
}

export function verifyKubernetesSandboxPod(
  pod: V1Pod,
  input: {
    readonly attestation: SandboxLeaseAttestation;
    readonly configuration: KubernetesSandboxConfiguration;
    readonly sourceSnapshotDigest: string;
  }
): VerifiedKubernetesSandboxPod {
  const expected = buildKubernetesSandboxPod(input);
  const name = expected.metadata?.name;
  const namespace = expected.metadata?.namespace;
  if (!name || !namespace || pod.metadata?.name !== name || pod.metadata.namespace !== namespace) {
    throw new Error("Kubernetes sandbox Pod identity mismatch");
  }
  for (const [key, value] of Object.entries(expected.metadata?.labels ?? {})) {
    if (pod.metadata?.labels?.[key] !== value) throw new Error("Kubernetes sandbox Pod labels drifted");
  }
  for (const [key, value] of Object.entries(expected.metadata?.annotations ?? {})) {
    if (pod.metadata?.annotations?.[key] !== value) {
      throw new Error("Kubernetes sandbox Pod claim annotations drifted");
    }
  }
  if (sha256Canonical(securityProjection(pod.spec)) !== sha256Canonical(securityProjection(expected.spec))) {
    throw new Error("Kubernetes sandbox Pod security specification drifted");
  }
  const uid = pod.metadata.uid;
  const candidate = pod.status?.containerStatuses?.find((status) => status.name === "candidate");
  const approvedDigest = input.attestation.policy.runtimeImage?.digest;
  if (
    pod.status?.phase !== "Running" ||
    !uid ||
    !candidate?.ready ||
    !candidate.state?.running ||
    !approvedDigest ||
    !imageIdMatches(candidate.imageID, approvedDigest)
  ) {
    throw new Error("Kubernetes sandbox Pod is not a running approved runtime");
  }
  const runtimeId = kubernetesSandboxRuntimeId(namespace, name);
  const runtimeSemantic = {
    schemaVersion: 1,
    kind: "kubernetes-pod",
    namespace,
    name,
    uid,
    runtimeClassName: pod.spec?.runtimeClassName,
    nodeName: pod.spec?.nodeName,
    podSpecDigest: sha256Canonical(securityProjection(pod.spec)),
    attestationDigest: input.attestation.digest,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    imageDigest: approvedDigest,
    containerId: candidate.containerID
  };
  return Object.freeze({
    runtimeId,
    runtimeDigest: sha256Canonical(runtimeSemantic),
    imageDigest: approvedDigest,
    podName: name,
    podUid: uid
  });
}

export function kubernetesSandboxPodName(attestation: SandboxLeaseAttestation): string {
  return `mn-candidate-${sha256(attestation.leaseId).slice(0, 32)}`;
}

export function kubernetesLeaseDirectoryName(attestation: SandboxLeaseAttestation): string {
  return `lease-${sha256Canonical({
    leaseId: attestation.leaseId,
    attestationDigest: attestation.digest
  }).slice(0, 40)}`;
}

export function kubernetesSandboxRuntimeId(namespace: string, podName: string): string {
  return sha256(`kubernetes-pod-v1\0${requireKubernetesName(namespace, "namespace")}\0${requireKubernetesName(podName, "podName")}`);
}

export class DefaultKubernetesPodControl implements KubernetesPodControl {
  readonly #api: CoreV1Api;
  readonly #exec: Exec;

  constructor(kubeConfig?: KubeConfig) {
    const config = kubeConfig ?? new KubeConfig();
    if (!kubeConfig) config.loadFromDefault();
    this.#api = config.makeApiClient(CoreV1Api);
    this.#exec = new Exec(config);
  }

  create(namespace: string, pod: V1Pod): Promise<V1Pod> {
    return this.#api.createNamespacedPod({
      namespace,
      body: pod,
      fieldManager: "muniu-worker",
      fieldValidation: "Strict"
    });
  }

  read(namespace: string, name: string): Promise<V1Pod> {
    return this.#api.readNamespacedPod({ namespace, name });
  }

  async delete(namespace: string, name: string): Promise<void> {
    await this.#api.deleteNamespacedPod({
      namespace,
      name,
      gracePeriodSeconds: 0,
      propagationPolicy: "Background"
    });
  }

  async exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: readonly string[],
    request: Pick<DockerSandboxExecuteRequest, "stdin" | "timeoutSeconds" | "signal">
  ): Promise<DockerSandboxCommandResult> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
    let socket: Awaited<ReturnType<Exec["exec"]>> | undefined;
    let settled = false;
    return new Promise<DockerSandboxCommandResult>((resolvePromise, reject) => {
      const finish = (result: DockerSandboxCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        resolvePromise(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        socket?.close();
        reject(error);
      };
      const abort = (): void => fail(new Error("Kubernetes Pod command cancelled"));
      const timer = setTimeout(() => fail(new Error("Kubernetes Pod command timed out")), request.timeoutSeconds * 1_000);
      timer.unref?.();
      request.signal?.addEventListener("abort", abort, { once: true });
      const statusCallback = (status: V1Status): void => {
        const exitCode = status.status === "Success" ? 0 : statusExitCode(status);
        finish({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8")
        });
      };
      void this.#exec.exec(
        namespace,
        podName,
        containerName,
        [...command],
        stdout,
        stderr,
        request.stdin === undefined ? null : Readable.from([request.stdin]),
        false,
        statusCallback
      ).then((connected) => {
        socket = connected;
        connected.once("error", fail);
        connected.once("close", () => {
          if (!settled) finish({
            exitCode: null,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8")
          });
        });
      }, fail);
    });
  }
}

function normalizeConfiguration(input: KubernetesSandboxConfiguration) {
  return Object.freeze({
    namespace: requireKubernetesName(input.namespace, "namespace"),
    sharedVolumeClaimName: requireKubernetesName(
      input.sharedVolumeClaimName,
      "sharedVolumeClaimName"
    ),
    sharedWorkspaceRoot: requireAbsolutePath(
      input.sharedWorkspaceRoot,
      "sharedWorkspaceRoot"
    ),
    serviceAccountName: requireKubernetesName(input.serviceAccountName, "serviceAccountName"),
    runtimeClassName: requireKubernetesName(input.runtimeClassName, "runtimeClassName"),
    imagePullPolicy: input.imagePullPolicy ?? "IfNotPresent" as const,
    podStartTimeoutSeconds: positiveInteger(
      input.podStartTimeoutSeconds ?? 120,
      "podStartTimeoutSeconds"
    )
  });
}

function securityProjection(spec: V1Pod["spec"]): unknown {
  if (!spec) return null;
  return {
    serviceAccountName: spec.serviceAccountName,
    automountServiceAccountToken: spec.automountServiceAccountToken,
    runtimeClassName: spec.runtimeClassName,
    restartPolicy: spec.restartPolicy,
    activeDeadlineSeconds: spec.activeDeadlineSeconds,
    terminationGracePeriodSeconds: spec.terminationGracePeriodSeconds,
    enableServiceLinks: spec.enableServiceLinks,
    hostNetwork: spec.hostNetwork ?? false,
    hostPID: spec.hostPID ?? false,
    hostIPC: spec.hostIPC ?? false,
    shareProcessNamespace: spec.shareProcessNamespace ?? false,
    securityContext: spec.securityContext,
    containers: spec.containers,
    initContainers: spec.initContainers ?? [],
    ephemeralContainers: spec.ephemeralContainers ?? [],
    volumes: spec.volumes
  };
}

async function waitForRunningPod(
  control: KubernetesPodControl,
  namespace: string,
  podName: string,
  timeoutSeconds: number
): Promise<V1Pod> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let lastPod: V1Pod | undefined;
  while (Date.now() < deadline) {
    const pod = await control.read(namespace, podName);
    lastPod = pod;
    const lastPhase = pod.status?.phase ?? "unknown";
    if (lastPhase === "Failed" || lastPhase === "Succeeded") {
      throw new Error(
        `Kubernetes sandbox Pod entered terminal phase ${lastPhase}: ${podReadinessSummary(pod)}`
      );
    }
    if (
      lastPhase === "Running" &&
      pod.status?.containerStatuses?.find((status) => status.name === "candidate")?.ready
    ) {
      return pod;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `Kubernetes sandbox Pod did not become ready: ${podReadinessSummary(lastPod)}`
  );
}

function podReadinessSummary(pod: V1Pod | undefined): string {
  if (!pod) return JSON.stringify({ phase: "unknown", candidate: "not-observed" });
  const candidate = pod.status?.containerStatuses?.find((status) => status.name === "candidate");
  const waiting = candidate?.state?.waiting;
  const terminated = candidate?.state?.terminated;
  const conditions = (pod.status?.conditions ?? [])
    .filter((condition) => condition.status !== "True")
    .map((condition) => ({
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
      message: boundedStatusMessage(condition.message)
    }));
  return JSON.stringify({
    phase: pod.status?.phase ?? "unknown",
    candidate: waiting ? {
      state: "waiting",
      reason: waiting.reason,
      message: boundedStatusMessage(waiting.message)
    } : terminated ? {
      state: "terminated",
      reason: terminated.reason,
      exitCode: terminated.exitCode,
      message: boundedStatusMessage(terminated.message)
    } : candidate ? {
      state: candidate.state?.running ? "running" : "unknown",
      ready: candidate.ready
    } : "not-observed",
    conditions
  });
}

function boundedStatusMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message.replace(/[\r\n\0]/gu, " ").slice(0, 512);
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    await Promise.all(entries.map((entry) => makeTreeReadOnly(join(root, entry))));
    await chmod(root, 0o555);
  } else if (stats.isFile()) {
    await chmod(root, stats.mode & 0o111 ? 0o555 : 0o444);
  }
}

async function removeLeaseRoot(root: string): Promise<void> {
  const stats = await lstat(root).catch(() => undefined);
  if (!stats) return;
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    await chmod(root, 0o700).catch(() => undefined);
    await Promise.all(entries.map((entry) => removeLeaseRoot(join(root, entry))));
  }
  await rm(root, { recursive: true, force: true });
}

function validateAttestation(
  value: SandboxLeaseAttestation,
  expected: DockerSandboxExpectedBinding
): SandboxLeaseAttestation {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new TypeError("API-issued sandbox attestation is required");
  }
  const { digest, signature: _signature, ...semantic } = value;
  requireDigest(digest, "attestation digest");
  if (sha256Canonical(semantic) !== digest || sha256Canonical(value.policy) !== value.policyDigest) {
    throw new TypeError("sandbox attestation digest binding is invalid");
  }
  for (const [field, actual, wanted] of [
    ["run", value.runId, expected.runId],
    ["tenant", value.tenantId, expected.tenantId],
    ["worker", value.workerId, expected.workerId],
    ["Harness", value.harnessDigest, expected.harnessDigest]
  ] as const) {
    if (actual !== wanted) throw new TypeError(`sandbox attestation ${field} binding mismatch`);
  }
  if (Date.parse(value.expiresAt) <= Date.now()) throw new TypeError("sandbox attestation is expired");
  if (!value.policy.readOnlyRootFilesystem || value.policy.secretNames.length > 0) {
    throw new TypeError("Kubernetes sandbox lease has an unsupported secret or root policy");
  }
  return deepFreeze(structuredClone(value));
}

function validateAuthorityProofEnvelope(
  proof: SandboxRuntimeProof,
  attestation: SandboxLeaseAttestation,
  runtimeId: string
): SandboxRuntimeProof {
  if (
    !proof ||
    proof.schemaVersion !== 1 ||
    proof.issuer !== "mn-api" ||
    proof.runtimeId !== runtimeId ||
    proof.attestationDigest !== attestation.digest ||
    proof.claimDigest !== attestation.claimDigest ||
    proof.imageDigest !== attestation.policy.runtimeImage?.digest ||
    !/^[a-f0-9]{64}$/u.test(proof.runtimeDigest) ||
    sha256Canonical((({ digest: _digest, signature: _signature, ...semantic }) => semantic)(proof)) !== proof.digest
  ) {
    throw new Error("trusted runtime authority returned an invalid proof envelope");
  }
  return deepFreeze(structuredClone(proof));
}

function requiredMount(attestation: SandboxLeaseAttestation, source: "project" | "scratch") {
  const mounts = attestation.policy.mounts.filter((mount) => mount.source === source);
  if (mounts.length !== 1) throw new TypeError(`sandbox lease requires one ${source} mount`);
  return mounts[0]!;
}

function containerPathForLease(lease: ActiveKubernetesLease, hostPath: string): string {
  for (const [root, target] of [
    [lease.projectRoot, lease.projectTarget],
    [lease.scratchRoot, lease.scratchTarget]
  ] as const) {
    const child = relative(root, hostPath);
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) {
      return child ? `${target}/${child.split(sep).join("/")}` : target;
    }
  }
  throw new Error("command working directory is outside the leased Kubernetes workspace");
}

function safeChild(rootInput: string, child: string): string {
  const root = resolve(rootInput);
  const result = resolve(root, child);
  const suffix = relative(root, result);
  if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new TypeError("Kubernetes lease workspace escaped the shared root");
  }
  return result;
}

function digestPinnedImage(reference: string, digest: string): string {
  requireDigest(digest, "runtime image digest");
  const base = reference.replace(/@sha256:[a-f0-9]{64}$/u, "");
  if (!base || /[\s\0\r\n]/u.test(base)) throw new TypeError("runtime image reference is unsafe");
  return `${base}@sha256:${digest}`;
}

function imageIdMatches(imageId: string | undefined, digest: string): boolean {
  return typeof imageId === "string" && (
    imageId.endsWith(`@sha256:${digest}`) || imageId.endsWith(`://sha256:${digest}`)
  );
}

function statusExitCode(status: V1Status): number | null {
  const value = status.details?.causes?.find((cause) => cause.reason === "ExitCode")?.message;
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : null;
}

function requireKubernetesName(value: string, field: string): string {
  if (!/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u.test(value) || value.length > 63) {
    throw new TypeError(`${field} must be a Kubernetes DNS label`);
  }
  return value;
}

function requireAbsolutePath(value: string, field: string): string {
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return resolve(value);
}

function requireIdentity(value: string, field: string): string {
  if (!value || value !== value.trim() || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return value;
}

function requireExecutable(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)) {
    throw new TypeError(`${field} must be a bare executable name`);
  }
  return value;
}

function requireRuntimeExecutable(value: string, field: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)) return value;
  if (/^\/(?:bin|sbin|usr|opt)\/[A-Za-z0-9_./+-]+$/u.test(value) && !value.includes("..")) {
    return value;
  }
  throw new TypeError(`${field} must be a bare or authority-resolved executable`);
}

function requireSubset(requested: readonly string[], allowed: readonly string[], field: string): void {
  for (const value of requested) {
    if (!allowed.includes(value)) throw new Error(`${field} contains disallowed tool ${value}`);
  }
}

function requireArgument(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError("command argument is invalid");
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be positive`);
  return value;
}

function requireDigest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const SAFE_EXECUTION_ENVIRONMENT = new Set([
  "MN_RUN_ID",
  "MN_CANDIDATE_ID",
  "MN_PROXY_BASE_URL",
  "MN_ASSOCIATED_PROXY_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "CODEX_BASE_URL",
  "MN_CODEX_BASE_URL"
]);
