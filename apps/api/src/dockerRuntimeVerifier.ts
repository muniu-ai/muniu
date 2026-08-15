import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import type { SandboxLeaseAttestation } from "@mn/harness";
import { sha256Canonical } from "@mn/governance";

const REQUIRED_MASKED_PATHS = Object.freeze([
  "/proc/acpi",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/scsi",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/sys/firmware"
]);
const REQUIRED_READONLY_PATHS = Object.freeze([
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger"
]);

export interface SandboxRuntimeVerificationRequest {
  readonly runtimeId: string;
  readonly attestation: SandboxLeaseAttestation;
  readonly projectRoot: string;
}

export interface SandboxRuntimeVerificationResult {
  readonly runtimeId: string;
  readonly runtimeDigest: string;
  readonly imageDigest: string;
  /** Authority-resolved host roots and container targets. These values never
   * originate in a worker request; they come from the inspected bind mounts. */
  readonly projectRoot: string;
  readonly scratchRoot: string;
  readonly projectTarget: string;
  readonly scratchTarget: string;
}

/** Trust boundary used by the API. Implementations must inspect the runtime
 * through an authority channel, never trust values submitted by the worker. */
export interface SandboxRuntimeVerifier {
  verify(
    request: SandboxRuntimeVerificationRequest
  ): Promise<SandboxRuntimeVerificationResult>;
}

export interface DockerRuntimeVerifierOptions {
  readonly dockerBinary?: string;
  readonly scratchRootParent?: string;
}

export interface DockerRuntimeInspectionInput
  extends SandboxRuntimeVerificationRequest {
  readonly scratchRootParent?: string;
  /** Trusted image-inspect document fetched by the API from the same daemon. */
  readonly imageInspectionRaw?: string;
}

export class DockerRuntimeVerifier implements SandboxRuntimeVerifier {
  readonly #dockerBinary: string;
  readonly #scratchRootParent: string;

  constructor(options: DockerRuntimeVerifierOptions = {}) {
    this.#dockerBinary = executable(options.dockerBinary ?? "docker", "dockerBinary");
    this.#scratchRootParent = options.scratchRootParent ?? tmpdir();
  }

  async verify(
    request: SandboxRuntimeVerificationRequest
  ): Promise<SandboxRuntimeVerificationResult> {
    const runtimeId = sha256(request.runtimeId, "runtimeId");
    const inspected = await dockerInspect(this.#dockerBinary, runtimeId);
    const approvedImage = request.attestation.policy.runtimeImage;
    if (!approvedImage) {
      throw new Error("sandbox attestation has no approved runtime image");
    }
    const imageInspectionRaw = await dockerImageInspect(
      this.#dockerBinary,
      approvedImage.digest
    );
    return verifyDockerRuntimeInspection(inspected, {
      ...request,
      runtimeId,
      scratchRootParent: this.#scratchRootParent,
      imageInspectionRaw
    });
  }
}

export async function verifyDockerRuntimeInspection(
  raw: string,
  input: DockerRuntimeInspectionInput
): Promise<SandboxRuntimeVerificationResult> {
  const runtimeId = sha256(input.runtimeId, "runtimeId");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || !record(parsed[0])) {
    throw new Error("docker inspect returned an invalid document");
  }
  const inspection = parsed[0];
  if (inspection.Id !== runtimeId) {
    throw new Error("docker inspect runtime identity mismatch");
  }
  const state = propertyRecord(inspection, "State");
  const host = propertyRecord(inspection, "HostConfig");
  const config = propertyRecord(inspection, "Config");
  const approvedImage = input.attestation.policy.runtimeImage;
  if (!approvedImage) {
    throw new Error("sandbox attestation has no approved runtime image");
  }
  const imageInspection = parseImageInspection(
    input.imageInspectionRaw,
    approvedImage.digest
  );
  const imageConfig = propertyRecord(imageInspection, "Config");
  const actualImageId = `sha256:${approvedImage.digest}`;
  if (
    inspection.Image !== actualImageId ||
    config.Image !== approvedImage.reference ||
    imageInspection.Id !== actualImageId
  ) {
    throw new Error("docker runtime image identity is not approved by the Harness");
  }
  if (state.Running !== true) {
    throw new Error("docker runtime is not running");
  }

  const attestation = input.attestation;
  const projectMount = oneMount(attestation, "project");
  const scratchMount = oneMount(attestation, "scratch");
  const projectRoot = await realpath(absolute(input.projectRoot, "projectRoot"));
  const scratchParent = await realpath(
    absolute(input.scratchRootParent ?? tmpdir(), "scratchRootParent")
  );
  const mounts = array(inspection.Mounts, "docker inspect Mounts").map((value) => {
    if (!record(value)) throw new Error("docker inspect mount is invalid");
    return {
      type: value.Type,
      source: value.Source,
      destination: value.Destination,
      rw: value.RW,
      propagation: value.Propagation
    };
  });
  if (mounts.length !== 2) {
    throw new Error("docker runtime contains an unauthorized mount");
  }
  const project = mounts.find((mount) => mount.destination === projectMount.target);
  const scratch = mounts.find((mount) => mount.destination === scratchMount.target);
  if (
    !project ||
    project.type !== "bind" ||
    project.rw !== false ||
    typeof project.source !== "string" ||
    await realpath(project.source) !== projectRoot ||
    project.propagation !== "rprivate"
  ) {
    throw new Error("docker runtime did not enforce the authoritative project mount");
  }
  if (
    !scratch ||
    scratch.type !== "bind" ||
    scratch.rw !== true ||
    typeof scratch.source !== "string" ||
    scratch.propagation !== "rprivate"
  ) {
    throw new Error("docker runtime did not enforce the scratch mount");
  }
  const scratchRoot = await realpath(scratch.source);
  if (
    !within(scratchParent, scratchRoot) ||
    !basename(scratchRoot).startsWith("mn-docker-sandbox-")
  ) {
    throw new Error("docker runtime scratch mount is outside the authority root");
  }

  const labels = propertyRecord(config, "Labels");
  const imageLabels = optionalRecord(imageConfig.Labels, "image Config.Labels");
  const expectedLabels = claimLabels(attestation);
  if (sha256Canonical(labels) !== sha256Canonical({ ...imageLabels, ...expectedLabels })) {
    throw new Error("docker runtime claim binding labels do not match the active lease");
  }
  const limits = attestation.policy.resources;
  const capDrop = stringArray(host.CapDrop, "HostConfig.CapDrop");
  const capAdd = host.CapAdd == null ? [] : stringArray(host.CapAdd, "HostConfig.CapAdd");
  const securityOpt = stringArray(host.SecurityOpt, "HostConfig.SecurityOpt");
  const tmpfs = propertyRecord(host, "Tmpfs");
  const tmpfsOptions = typeof tmpfs["/tmp"] === "string"
    ? new Set(tmpfs["/tmp"].split(","))
    : new Set<string>();
  const env = stringArray(config.Env, "Config.Env");
  const imageEnv = stringArray(imageConfig.Env, "image Config.Env");
  const expectedCmd = [
    "sleep",
    String(Math.max(60, limits.timeoutSeconds + 60))
  ];
  const devices = nullableArray(host.Devices, "HostConfig.Devices");
  const deviceRequests = nullableArray(
    host.DeviceRequests,
    "HostConfig.DeviceRequests"
  );
  const deviceCgroupRules = nullableArray(
    host.DeviceCgroupRules,
    "HostConfig.DeviceCgroupRules"
  );
  const ulimits = nullableArray(host.Ulimits, "HostConfig.Ulimits");
  const dnsOptions = nullableStringArray(host.DnsOptions, "HostConfig.DnsOptions");
  const dnsSearch = nullableStringArray(host.DnsSearch, "HostConfig.DnsSearch");
  const groupAdd = nullableStringArray(host.GroupAdd, "HostConfig.GroupAdd");
  const maskedPaths = stringArray(host.MaskedPaths, "HostConfig.MaskedPaths");
  const readonlyPaths = stringArray(host.ReadonlyPaths, "HostConfig.ReadonlyPaths");
  const logConfig = propertyRecord(host, "LogConfig");
  const portBindings = propertyRecord(host, "PortBindings");
  const restartPolicy = propertyRecord(host, "RestartPolicy");
  const networks = propertyRecord(
    propertyRecord(inspection, "NetworkSettings"),
    "Networks"
  );
  if (
    host.ReadonlyRootfs !== true ||
    host.NetworkMode !== "none" ||
    host.PidMode !== "" ||
    host.IpcMode !== "private" ||
    host.UsernsMode !== "" ||
    host.CgroupnsMode !== "private" ||
    host.UTSMode !== "" ||
    host.Cgroup !== "" ||
    host.CgroupParent !== "" ||
    host.Runtime !== "runc" ||
    host.Isolation !== "" ||
    host.OomScoreAdj !== 0 ||
    host.NanoCpus !== Math.round(limits.cpu * 1_000_000_000) ||
    host.CpuShares !== 0 ||
    host.CpuPeriod !== 0 ||
    host.CpuQuota !== 0 ||
    host.CpuRealtimePeriod !== 0 ||
    host.CpuRealtimeRuntime !== 0 ||
    host.CpusetCpus !== "" ||
    host.CpusetMems !== "" ||
    host.CpuCount !== 0 ||
    host.CpuPercent !== 0 ||
    host.Memory !== limits.memoryMb * 1024 * 1024 ||
    host.MemoryReservation !== 0 ||
    host.MemorySwap !== limits.memoryMb * 1024 * 1024 ||
    host.MemorySwappiness !== null ||
    normalizedOomKillDisable(host.OomKillDisable) !== false ||
    host.ShmSize !== 16 * 1024 * 1024 ||
    host.PidsLimit !== limits.pids ||
    host.Privileged !== false ||
    capAdd.length !== 0 ||
    capDrop.length !== 1 ||
    capDrop[0] !== "ALL" ||
    securityOpt.length !== 1 ||
    !["no-new-privileges", "no-new-privileges:true"].includes(securityOpt[0]!) ||
    config.User !== "65534:65534" ||
    config.WorkingDir !== projectMount.target ||
    sha256Canonical(env) !== sha256Canonical(imageEnv) ||
    sha256Canonical(config.Entrypoint ?? null) !==
      sha256Canonical(imageConfig.Entrypoint ?? null) ||
    sha256Canonical(config.Cmd ?? null) !== sha256Canonical(expectedCmd) ||
    config.OpenStdin !== false ||
    config.Tty !== false ||
    devices.length !== 0 ||
    deviceRequests.length !== 0 ||
    deviceCgroupRules.length !== 0 ||
    sha256Canonical(ulimits) !== sha256Canonical([
      { Name: "nofile", Hard: 1024, Soft: 1024 }
    ]) ||
    host.ExtraHosts !== null ||
    host.Dns !== null ||
    dnsOptions.length !== 0 ||
    dnsSearch.length !== 0 ||
    groupAdd.length !== 0 ||
    host.Links !== null ||
    host.PublishAllPorts !== false ||
    host.AutoRemove !== false ||
    host.Binds !== null ||
    host.VolumesFrom !== null ||
    sha256Canonical(logConfig) !== sha256Canonical({ Type: "none", Config: {} }) ||
    sha256Canonical(portBindings) !== sha256Canonical({}) ||
    sha256Canonical(restartPolicy) !== sha256Canonical({ Name: "no", MaximumRetryCount: 0 }) ||
    !requiredSubset(REQUIRED_MASKED_PATHS, maskedPaths) ||
    !requiredSubset(REQUIRED_READONLY_PATHS, readonlyPaths) ||
    Object.keys(networks).length !== 1 ||
    !Object.hasOwn(networks, "none") ||
    Object.keys(tmpfs).length !== 1 ||
    !["rw", "noexec", "nosuid", "size=16777216", "mode=1777"].every(
      (option) => tmpfsOptions.has(option)
    ) ||
    tmpfsOptions.size !== 5
  ) {
    throw new Error("docker runtime inspection does not satisfy the issued sandbox policy");
  }

  const semantic = {
    schemaVersion: 2,
    runtimeId,
    state: "running",
    imageReference: config.Image,
    imageDigest: approvedImage.digest,
    environment: env,
    entrypoint: config.Entrypoint ?? null,
    command: config.Cmd,
    user: config.User,
    workingDir: config.WorkingDir,
    readOnlyRootFilesystem: host.ReadonlyRootfs,
    networkMode: host.NetworkMode,
    namespaces: {
      pid: host.PidMode,
      ipc: host.IpcMode,
      user: host.UsernsMode,
      cgroup: host.CgroupnsMode,
      uts: host.UTSMode,
      cgroupMode: host.Cgroup,
      cgroupParent: host.CgroupParent,
      runtime: host.Runtime,
      isolation: host.Isolation,
      oomScoreAdjustment: host.OomScoreAdj
    },
    resources: {
      nanoCpus: host.NanoCpus,
      cpuShares: host.CpuShares,
      cpuPeriod: host.CpuPeriod,
      cpuQuota: host.CpuQuota,
      cpuRealtimePeriod: host.CpuRealtimePeriod,
      cpuRealtimeRuntime: host.CpuRealtimeRuntime,
      cpusetCpus: host.CpusetCpus,
      cpusetMems: host.CpusetMems,
      cpuCount: host.CpuCount,
      cpuPercent: host.CpuPercent,
      memoryBytes: host.Memory,
      memoryReservationBytes: host.MemoryReservation,
      memorySwapBytes: host.MemorySwap,
      memorySwappiness: host.MemorySwappiness,
      oomKillDisable: normalizedOomKillDisable(host.OomKillDisable),
      sharedMemoryBytes: host.ShmSize,
      pids: host.PidsLimit,
      ulimits
    },
    privileged: host.Privileged,
    capAdd,
    capDrop: [...capDrop].sort(),
    securityOpt: [...securityOpt].sort(),
    devices,
    deviceRequests,
    deviceCgroupRules,
    hostRouting: {
      extraHosts: host.ExtraHosts,
      dns: host.Dns,
      dnsOptions,
      dnsSearch,
      groupAdd,
      links: host.Links,
      publishAllPorts: host.PublishAllPorts
    },
    lifecycle: {
      autoRemove: host.AutoRemove,
      binds: host.Binds,
      volumesFrom: host.VolumesFrom,
      logConfig,
      portBindings,
      restartPolicy
    },
    kernelPathPolicy: {
      maskedPaths: [...maskedPaths].sort(),
      readonlyPaths: [...readonlyPaths].sort()
    },
    tmpfs,
    mounts: mounts
      .map((mount) => ({
        ...mount,
        source: mount.destination === projectMount.target ? projectRoot : scratchRoot
      }))
      .sort((left, right) => String(left.destination).localeCompare(String(right.destination))),
    claimLabels: expectedLabels,
    attestationDigest: attestation.digest
  };
  return Object.freeze({
    runtimeId,
    runtimeDigest: sha256Canonical(semantic),
    imageDigest: approvedImage.digest,
    projectRoot,
    scratchRoot,
    projectTarget: projectMount.target,
    scratchTarget: scratchMount.target
  });
}

export function sandboxRuntimeClaimLabels(
  attestation: SandboxLeaseAttestation
): Readonly<Record<string, string>> {
  return Object.freeze(claimLabels(attestation));
}

function claimLabels(attestation: SandboxLeaseAttestation): Record<string, string> {
  return {
    "io.mn.sandbox.lease-id": attestation.leaseId,
    "io.mn.sandbox.attestation-digest": attestation.digest,
    "io.mn.sandbox.claim-digest": attestation.claimDigest,
    "io.mn.sandbox.run-id": attestation.runId,
    "io.mn.sandbox.tenant-id": attestation.tenantId,
    "io.mn.sandbox.worker-id": attestation.workerId
  };
}

function oneMount(
  attestation: SandboxLeaseAttestation,
  source: "project" | "scratch"
) {
  const mounts = attestation.policy.mounts.filter((mount) => mount.source === source);
  if (mounts.length !== 1) {
    throw new TypeError(`sandbox lease requires exactly one ${source} mount`);
  }
  return mounts[0]!;
}

function dockerInspect(dockerBinary: string, runtimeId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      dockerBinary,
      ["inspect", runtimeId],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`authoritative docker inspect failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function dockerImageInspect(dockerBinary: string, digest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      dockerBinary,
      ["image", "inspect", `sha256:${sha256(digest, "imageDigest")}`],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `authoritative docker image inspect failed: ${stderr || error.message}`
          ));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function parseImageInspection(raw: string | undefined, digest: string): Record<string, unknown> {
  if (typeof raw !== "string") {
    throw new Error("trusted Docker image inspection is required");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !record(parsed[0]) ||
    parsed[0].Id !== `sha256:${digest}`
  ) {
    throw new Error("docker image inspect returned an invalid content identity");
  }
  return parsed[0];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function propertyRecord(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const candidate = value[field];
  if (!record(candidate)) throw new Error(`docker inspect ${field} is invalid`);
  return candidate;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value;
}

function nullableArray(value: unknown, field: string): unknown[] {
  return value == null ? [] : array(value, field);
}

function nullableStringArray(value: unknown, field: string): string[] {
  const values = nullableArray(value, field);
  if (values.some((item) => typeof item !== "string")) {
    throw new Error(`${field} is invalid`);
  }
  return values as string[];
}

function normalizedOomKillDisable(value: unknown): boolean | "invalid" {
  return value === null || value === false ? false : value === true ? true : "invalid";
}

function requiredSubset(required: readonly string[], actual: readonly string[]): boolean {
  const values = new Set(actual);
  return required.every((item) => values.has(item));
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  return value == null ? {} : record(value)
    ? value
    : (() => { throw new Error(`${field} is invalid`); })();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} is invalid`);
  }
  return value as string[];
}

function absolute(value: string, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${field} must be an absolute safe path`);
  }
  return value;
}

function executable(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${field} must be a safe executable`);
  }
  return value;
}

function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
  return value;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
