import { chmod, cp, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { V1Pod } from "@kubernetes/client-node";
import { sha256Canonical } from "@mn/governance";
import {
  DefaultKubernetesPodControl,
  captureContractBaseline,
  kubernetesSandboxCpuRequest,
  projectAtSnapshot,
  runGovernedGatePlan,
  type GateCommandExecutionRequest,
  type GateCommandExecutor,
  type GateResolvedToolIdentity,
  type KubernetesPodControl,
  type KubernetesSandboxConfiguration
} from "@mn/worker";
import type {
  AuthoritativeGateAuthority,
  AuthoritativeGateExecutionInput
} from "./authoritativeGateVerification.js";
import { measureAuthoritativeLoopWorkspaceDiff } from "./loopDiffMeasurement.js";

export interface KubernetesAuthoritativeGateAuthorityOptions
  extends KubernetesSandboxConfiguration {
  readonly control?: KubernetesPodControl;
}

/** Replays the Gate plan in a second API-created Pod. Its project and
 * candidate mounts are immutable copies on the shared PVC; the worker Pod is
 * never trusted as the authority executor. */
export class KubernetesAuthoritativeGateAuthority implements AuthoritativeGateAuthority {
  readonly #configuration: KubernetesSandboxConfiguration;
  readonly #control: KubernetesPodControl;

  constructor(options: KubernetesAuthoritativeGateAuthorityOptions) {
    this.#configuration = Object.freeze({
      namespace: options.namespace,
      sharedVolumeClaimName: options.sharedVolumeClaimName,
      sharedWorkspaceRoot: resolve(options.sharedWorkspaceRoot),
      serviceAccountName: options.serviceAccountName,
      runtimeClassName: options.runtimeClassName,
      imagePullPolicy: options.imagePullPolicy ?? "IfNotPresent",
      podStartTimeoutSeconds: options.podStartTimeoutSeconds ?? 120
    });
    this.#control = options.control ?? new DefaultKubernetesPodControl();
  }

  async execute(input: AuthoritativeGateExecutionInput) {
    assertRuntimeBinding(input);
    const authorityId = sha256Canonical({
      runId: input.runId,
      candidateId: input.candidateId,
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      runtimeProofDigest: input.sandboxExecution.runtimeProof.digest
    }).slice(0, 40);
    const directoryName = `authority-${authorityId}`;
    const authorityRoot = safeChild(this.#configuration.sharedWorkspaceRoot, directoryName);
    const projectRoot = join(authorityRoot, "project");
    const candidateRoot = join(authorityRoot, "candidate");
    const podName = `mn-gate-${authorityId.slice(0, 32)}`;
    let authorityRootCreated = false;
    let podCreated = false;
    try {
      // The authority Pod uses uid 65534 and needs to traverse this private,
      // deterministic directory. It contains no credentials and both mounted
      // snapshots are made immutable before the Pod is created.
      await mkdir(authorityRoot, { recursive: false, mode: 0o755 });
      authorityRootCreated = true;
      await chmod(authorityRoot, 0o755);
      await cp(await realpath(input.runtime.projectRoot), projectRoot, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true
      });
      await cp(await realpath(input.candidateRoot), candidateRoot, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true
      });
      await assertSnapshotBinding(input, projectRoot, candidateRoot);
      await makeTreeReadOnly(projectRoot);
      await makeTreeReadOnly(candidateRoot);
      const manifest = buildKubernetesAuthoritativeGatePod({
        input,
        configuration: this.#configuration,
        directoryName,
        podName
      });
      await this.#control.create(this.#configuration.namespace, manifest);
      podCreated = true;
      const pod = await waitForAuthorityPod(
        this.#control,
        this.#configuration.namespace,
        podName,
        this.#configuration.podStartTimeoutSeconds ?? 120
      );
      verifyKubernetesAuthoritativeGatePod(pod, manifest, input);
      const authorityProject = projectAtSnapshot(input.project, projectRoot);
      const result = await runGovernedGatePlan({
        project: authorityProject,
        task: input.task,
        manifest: input.manifest,
        candidateRoot,
        evidenceRoot: input.candidateRoot,
        runId: input.runId,
        candidateId: input.candidateId,
        changedPaths: [...input.changedPaths],
        ...(input.spec ? { spec: input.spec } : {}),
        contractBaseline: await captureContractBaseline(authorityProject),
        commandExecutor: authorityCommandExecutor({
          control: this.#control,
          namespace: this.#configuration.namespace,
          podName,
          candidateRoot,
          candidateTarget: "/workspace/candidate",
          input
        })
      });
      await assertSnapshotBinding(input, projectRoot, candidateRoot);
      return result;
    } finally {
      if (podCreated) {
        await this.#control.delete(this.#configuration.namespace, podName).catch(() => undefined);
      }
      if (authorityRootCreated) {
        await makeTreeWritable(authorityRoot).catch(() => undefined);
        await rm(authorityRoot, { recursive: true, force: true });
      }
    }
  }
}

export function buildKubernetesAuthoritativeGatePod(value: {
  readonly input: AuthoritativeGateExecutionInput;
  readonly configuration: KubernetesSandboxConfiguration;
  readonly directoryName: string;
  readonly podName: string;
}): V1Pod {
  const image = value.input.attestation.policy.runtimeImage;
  if (!image) throw new Error("authoritative Gate has no approved runtime image");
  const resources = value.input.attestation.policy.resources;
  const duration = Math.max(60, resources.timeoutSeconds + 60);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: value.podName,
      namespace: value.configuration.namespace,
      labels: {
        "muniu.ai/component": "candidate-sandbox",
        "muniu.ai/managed-by": "muniu-api-gate-authority"
      },
      annotations: {
        "muniu.ai/attestation-digest": value.input.attestation.digest,
        "muniu.ai/runtime-proof-digest": value.input.sandboxExecution.runtimeProof.digest,
        "muniu.ai/candidate-snapshot-digest": value.input.candidateSnapshotDigest,
        "muniu.ai/network-policy": "default-deny"
      }
    },
    spec: {
      serviceAccountName: value.configuration.serviceAccountName,
      automountServiceAccountToken: false,
      runtimeClassName: value.configuration.runtimeClassName,
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
        name: "authority",
        image: `${image.reference.replace(/@sha256:[a-f0-9]{64}$/u, "")}@sha256:${image.digest}`,
        imagePullPolicy: value.configuration.imagePullPolicy ?? "IfNotPresent",
        command: ["sleep", String(duration)],
        workingDir: "/workspace/candidate",
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
            cpu: kubernetesSandboxCpuRequest(resources.cpu),
            memory: `${resources.memoryMb}Mi`
          },
          limits: { cpu: String(resources.cpu), memory: `${resources.memoryMb}Mi` }
        },
        volumeMounts: [
          { name: "workspace", mountPath: "/workspace/project", subPath: `${value.directoryName}/project`, readOnly: true },
          { name: "workspace", mountPath: "/workspace/candidate", subPath: `${value.directoryName}/candidate`, readOnly: true },
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
            claimName: value.configuration.sharedVolumeClaimName,
            readOnly: false
          }
        },
        { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } }
      ]
    }
  };
}

function authorityCommandExecutor(value: {
  readonly control: KubernetesPodControl;
  readonly namespace: string;
  readonly podName: string;
  readonly candidateRoot: string;
  readonly candidateTarget: string;
  readonly input: AuthoritativeGateExecutionInput;
}): GateCommandExecutor {
  const resolved = new Map<string, string>();
  const containerCwd = async (cwd: string): Promise<string> => {
    const canonical = await realpath(resolve(cwd));
    const child = relative(value.candidateRoot, canonical);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error("authoritative Gate cwd escaped its candidate snapshot");
    }
    return child ? `${value.candidateTarget}/${child.split(sep).join("/")}` : value.candidateTarget;
  };
  const resolveToolIdentity = async (
    executable: string
  ): Promise<GateResolvedToolIdentity> => {
    if (!value.input.attestation.policy.allowedTools.includes(executable)) {
      throw new Error(`tool ${executable} is not allowed by sandbox lease`);
    }
    const script = [
      "set -eu",
      "tool=$1",
      "resolved=$(command -v \"$tool\")",
      "canonical=$(readlink -f \"$resolved\")",
      "case \"$canonical\" in /bin/*|/sbin/*|/usr/*|/opt/*) ;; *) exit 65 ;; esac",
      "digest=$(sha256sum \"$canonical\")",
      "digest=${digest%% *}",
      "printf '%s\\n%s\\n' \"$canonical\" \"$digest\""
    ].join("\n");
    const result = await value.control.exec(
      value.namespace,
      value.podName,
      "authority",
      ["/bin/sh", "-ceu", script, "mn-gate-tool", executable],
      { timeoutSeconds: 30 }
    );
    const lines = result.stdout.trim().split(/\r?\n/u);
    if (result.exitCode !== 0 || lines.length !== 2 || !/^[a-f0-9]{64}$/u.test(lines[1]!)) {
      throw new Error(`authoritative Gate could not resolve tool ${executable}`);
    }
    resolved.set(lines[0]!, executable);
    return Object.freeze({
      schemaVersion: 1,
      requestedExecutable: executable,
      resolvedExecutable: lines[0]!,
      contentDigest: lines[1]!,
      imageDigest: value.input.sandboxExecution.imageDigest!
    });
  };
  return Object.freeze({
    id: "kubernetes/authority-pod-exec",
    version: "1",
    sandboxExecution: value.input.sandboxExecution,
    resolveToolIdentity,
    execute: async (request: GateCommandExecutionRequest) => {
      const requestedTool = isAbsolute(request.executable)
        ? resolved.get(request.executable)
        : request.executable;
      const executable = isAbsolute(request.executable)
        ? requestedTool ? request.executable : undefined
        : request.executable;
      if (!executable) throw new Error("authoritative Gate executable was not resolved");
      if (!requestedTool || !value.input.attestation.policy.allowedTools.includes(requestedTool)) {
        throw new Error(`tool ${request.executable} is not allowed by sandbox lease`);
      }
      const result = await value.control.exec(
        value.namespace,
        value.podName,
        "authority",
        [
          "/bin/sh", "-ceu", "cd \"$1\"; shift; exec \"$@\"",
          "mn-gate-exec", await containerCwd(request.cwd), executable, ...request.args
        ],
        {
          timeoutSeconds: request.timeoutSeconds,
          ...(request.signal ? { signal: request.signal } : {})
        }
      );
      const timestamp = new Date().toISOString();
      if (result.stdout) request.onEvent?.({ runId: request.runId, candidateId: request.candidateId, type: "stdout", message: result.stdout, timestamp });
      if (result.stderr) request.onEvent?.({ runId: request.runId, candidateId: request.candidateId, type: "stderr", message: result.stderr, timestamp });
      return result;
    },
    probeVersion: async (executable: string, args: readonly string[], cwd: string) => {
      const requestedTool = isAbsolute(executable) ? resolved.get(executable) : executable;
      if (!requestedTool || !value.input.attestation.policy.allowedTools.includes(requestedTool)) {
        throw new Error(`tool ${executable} is not allowed by sandbox lease`);
      }
      const result = await value.control.exec(
        value.namespace,
        value.podName,
        "authority",
        [
          "/bin/sh", "-ceu", "cd \"$1\"; shift; exec \"$@\"",
          "mn-gate-version", await containerCwd(cwd), executable, ...args
        ],
        { timeoutSeconds: 10 }
      );
      return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0] || "unknown";
    }
  });
}

async function assertSnapshotBinding(
  input: AuthoritativeGateExecutionInput,
  projectRoot: string,
  candidateRoot: string
): Promise<void> {
  const measured = await measureAuthoritativeLoopWorkspaceDiff({ projectRoot, candidateRoot });
  if (
    measured.projectSnapshotDigest !== input.projectSnapshotDigest ||
    measured.candidateSnapshotDigest !== input.candidateSnapshotDigest ||
    !measured.content.equals(Buffer.from(input.diffArtifact))
  ) throw new Error("Kubernetes authority snapshot does not match the implementation proof");
}

export function verifyKubernetesAuthoritativeGatePod(
  pod: V1Pod,
  manifest: V1Pod,
  input: AuthoritativeGateExecutionInput
): void {
  if (
    pod.metadata?.name !== manifest.metadata?.name ||
    pod.metadata?.namespace !== manifest.metadata?.namespace ||
    pod.metadata?.annotations?.["muniu.ai/attestation-digest"] !== input.attestation.digest ||
    pod.spec?.automountServiceAccountToken !== false ||
    pod.spec?.containers.length !== 1 ||
    (pod.spec?.initContainers?.length ?? 0) !== 0 ||
    (pod.spec?.ephemeralContainers?.length ?? 0) !== 0 ||
    pod.spec?.volumes?.some((volume) => volume.hostPath !== undefined) ||
    pod.status?.phase !== "Running" ||
    !pod.status.containerStatuses?.find((status) => status.name === "authority")?.ready
  ) throw new Error("Kubernetes authoritative Gate Pod failed security inspection");
  const status = pod.status.containerStatuses.find((entry) => entry.name === "authority")!;
  const approvedImageDigest = input.attestation.policy.runtimeImage?.digest;
  if (!approvedImageDigest || !imageIdMatches(status.imageID, approvedImageDigest)) {
    throw new Error("Kubernetes authoritative Gate Pod did not run the approved image");
  }
  if (
    sha256Canonical(authoritySecurityProjection(pod.spec)) !==
    sha256Canonical(authoritySecurityProjection(manifest.spec))
  ) {
    throw new Error("Kubernetes authoritative Gate Pod specification drifted");
  }
}

function authoritySecurityProjection(spec: V1Pod["spec"]): unknown {
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

function imageIdMatches(imageId: string | undefined, digest: string): boolean {
  return typeof imageId === "string" && (
    imageId.endsWith(`@sha256:${digest}`) ||
    imageId.endsWith(`://sha256:${digest}`)
  );
}

async function waitForAuthorityPod(
  control: KubernetesPodControl,
  namespace: string,
  podName: string,
  timeoutSeconds: number
): Promise<V1Pod> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const pod = await control.read(namespace, podName);
    if (pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded") {
      throw new Error(`Kubernetes authoritative Gate Pod entered ${pod.status.phase}`);
    }
    if (pod.status?.phase === "Running" && pod.status.containerStatuses?.find((status) => status.name === "authority")?.ready) return pod;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Kubernetes authoritative Gate Pod did not become ready");
}

function assertRuntimeBinding(input: AuthoritativeGateExecutionInput): void {
  if (
    input.runtime.runtimeId !== input.sandboxExecution.runtimeId ||
    input.runtime.runtimeDigest !== input.sandboxExecution.runtimeDigest ||
    input.attestation.digest !== input.sandboxExecution.attestationDigest ||
    input.runtime.imageDigest !== input.sandboxExecution.imageDigest
  ) throw new Error("Kubernetes authoritative Gate runtime binding mismatch");
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    await Promise.all((await readdir(root)).map((entry) => makeTreeReadOnly(join(root, entry))));
    await chmod(root, 0o555);
  } else if (stats.isFile()) await chmod(root, stats.mode & 0o111 ? 0o555 : 0o444);
}

async function makeTreeWritable(root: string): Promise<void> {
  const stats = await lstat(root).catch(() => undefined);
  if (!stats || stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    await chmod(root, 0o700);
    await Promise.all((await readdir(root)).map((entry) => makeTreeWritable(join(root, entry))));
  } else if (stats.isFile()) await chmod(root, 0o600);
}

function safeChild(rootInput: string, child: string): string {
  const root = resolve(rootInput);
  const result = resolve(root, child);
  const suffix = relative(root, result);
  if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new Error("Kubernetes authority workspace escaped its shared root");
  }
  return result;
}
