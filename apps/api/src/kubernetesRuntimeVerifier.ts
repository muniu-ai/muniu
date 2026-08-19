import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CoreV1Api,
  KubeConfig,
  type V1Pod
} from "@kubernetes/client-node";
import {
  kubernetesLeaseDirectoryName,
  kubernetesSandboxPodName,
  createWorkspaceSnapshot,
  verifyKubernetesSandboxPod,
  type KubernetesSandboxConfiguration
} from "@mn/worker";
import type {
  SandboxRuntimeVerificationRequest,
  SandboxRuntimeVerificationResult,
  SandboxRuntimeVerifier
} from "./dockerRuntimeVerifier.js";

export interface KubernetesPodReader {
  read(namespace: string, name: string): Promise<V1Pod>;
}

export interface KubernetesRuntimeVerifierOptions extends KubernetesSandboxConfiguration {
  readonly reader?: KubernetesPodReader;
}

/** API-side authority for candidate Pods. The worker supplies only the opaque
 * runtime digest identifier; this verifier resolves and checks the Pod through
 * its own Kubernetes credentials and resolves the shared PVC paths itself. */
export class KubernetesRuntimeVerifier implements SandboxRuntimeVerifier {
  readonly #configuration: KubernetesSandboxConfiguration;
  readonly #reader: KubernetesPodReader;

  constructor(options: KubernetesRuntimeVerifierOptions) {
    this.#configuration = Object.freeze({
      namespace: options.namespace,
      sharedVolumeClaimName: options.sharedVolumeClaimName,
      sharedWorkspaceRoot: resolve(options.sharedWorkspaceRoot),
      serviceAccountName: options.serviceAccountName,
      runtimeClassName: options.runtimeClassName,
      ...(options.imagePullPolicy ? { imagePullPolicy: options.imagePullPolicy } : {}),
      ...(options.podStartTimeoutSeconds
        ? { podStartTimeoutSeconds: options.podStartTimeoutSeconds }
        : {})
    });
    if (!isAbsolute(this.#configuration.sharedWorkspaceRoot)) {
      throw new TypeError("Kubernetes shared workspace root must be absolute");
    }
    this.#reader = options.reader ?? new DefaultKubernetesPodReader();
  }

  async verify(
    request: SandboxRuntimeVerificationRequest
  ): Promise<SandboxRuntimeVerificationResult> {
    const podName = kubernetesSandboxPodName(request.attestation);
    const pod = await this.#reader.read(this.#configuration.namespace, podName);
    const annotationDigest = pod.metadata?.annotations?.["muniu.ai/source-snapshot-digest"];
    const sourceSnapshotDigest = request.sourceSnapshotDigest ?? annotationDigest;
    if (!sourceSnapshotDigest || !/^[a-f0-9]{64}$/u.test(sourceSnapshotDigest)) {
      throw new Error("Kubernetes sandbox Pod has no valid source snapshot binding");
    }
    if (request.sourceSnapshotDigest && annotationDigest !== request.sourceSnapshotDigest) {
      throw new Error("Kubernetes sandbox source snapshot does not match the queue binding");
    }
    const verified = verifyKubernetesSandboxPod(pod, {
      attestation: request.attestation,
      configuration: this.#configuration,
      sourceSnapshotDigest
    });
    if (verified.runtimeId !== request.runtimeId) {
      throw new Error("Kubernetes sandbox runtime identity mismatch");
    }
    const sharedRoot = await realpath(this.#configuration.sharedWorkspaceRoot);
    const leaseRoot = contained(
      sharedRoot,
      join(sharedRoot, kubernetesLeaseDirectoryName(request.attestation))
    );
    const projectRoot = await realpath(contained(leaseRoot, join(leaseRoot, "project")));
    const scratchRoot = await realpath(contained(leaseRoot, join(leaseRoot, "scratch")));
    if (
      (await readFile(join(projectRoot, ".mn-source-digest"), "utf8")) !==
      `${sourceSnapshotDigest}\n`
    ) {
      throw new Error("Kubernetes sandbox materialized source digest marker is invalid");
    }
    const measuredSource = await createWorkspaceSnapshot(projectRoot);
    if (measuredSource.digest !== sourceSnapshotDigest) {
      throw new Error("Kubernetes sandbox materialized source bytes do not match the queue binding");
    }
    const projectMount = oneMount(request, "project");
    const scratchMount = oneMount(request, "scratch");
    return Object.freeze({
      runtimeId: verified.runtimeId,
      runtimeDigest: verified.runtimeDigest,
      imageDigest: verified.imageDigest,
      projectRoot,
      scratchRoot,
      projectTarget: projectMount.target,
      scratchTarget: scratchMount.target
    });
  }
}

class DefaultKubernetesPodReader implements KubernetesPodReader {
  readonly #api: CoreV1Api;

  constructor() {
    const config = new KubeConfig();
    config.loadFromDefault();
    this.#api = config.makeApiClient(CoreV1Api);
  }

  read(namespace: string, name: string): Promise<V1Pod> {
    return this.#api.readNamespacedPod({ namespace, name });
  }
}

function oneMount(
  request: SandboxRuntimeVerificationRequest,
  source: "project" | "scratch"
) {
  const mounts = request.attestation.policy.mounts.filter((mount) => mount.source === source);
  if (mounts.length !== 1) throw new Error(`sandbox attestation requires one ${source} mount`);
  return mounts[0]!;
}

function contained(root: string, candidate: string): string {
  const absolute = resolve(candidate);
  const child = relative(root, absolute);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Kubernetes sandbox workspace escaped the authority root");
  }
  return absolute;
}
