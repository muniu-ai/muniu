import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  SandboxExecutionEvidence,
  SandboxLeaseAttestation,
  SandboxRuntimeProof,
  SandboxPreparation,
  SandboxPreparationRequest
} from "@mn/harness";
import type { ReleasableSandboxBackend } from "./sandboxBackends.js";
import type {
  GateCommandExecutionRequest,
  GateCommandExecutor,
  GateResolvedToolIdentity
} from "./gateEngine.js";

export interface DockerSandboxExpectedBinding {
  readonly runId: string;
  readonly tenantId: string;
  readonly workerId: string;
  readonly harnessDigest: string;
}

export interface DockerEnforcedSandboxOptions {
  readonly image: string;
  readonly attestation: SandboxLeaseAttestation;
  readonly expected: DockerSandboxExpectedBinding;
  readonly dockerBinary?: string;
  readonly runtimeProofAuthority?: DockerRuntimeProofAuthority;
}

export interface DockerRuntimeProofAuthorityRequest {
  readonly attestation: SandboxLeaseAttestation;
  readonly runtimeId: string;
}

export type DockerRuntimeProofAuthority = (
  request: DockerRuntimeProofAuthorityRequest
) => Promise<SandboxRuntimeProof>;

export interface DockerSandboxExecuteRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  /** Names in env that contain sensitive values. */
  readonly secretNames?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface DockerSandboxCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ActiveDockerLease {
  readonly containerId: string;
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

/** A concrete Docker CLI backend. Unlike EnforcedSandboxBackend's generic
 * adapter, this class creates and inspects a real container before it exposes
 * an execution handle. */
export class DockerEnforcedSandboxBackend implements ReleasableSandboxBackend {
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
    "runtime-inspection"
  ]);
  readonly #image: string;
  readonly #attestation: SandboxLeaseAttestation;
  readonly #docker: string;
  readonly #runtimeProofAuthority: DockerRuntimeProofAuthority;
  readonly #leases = new Map<string, ActiveDockerLease>();

  constructor(options: DockerEnforcedSandboxOptions) {
    this.#docker = requireExecutable(options.dockerBinary ?? "docker", "dockerBinary");
    if (typeof options.runtimeProofAuthority !== "function") {
      throw new TypeError(
        "enterprise Docker sandbox requires a trusted runtime proof authority"
      );
    }
    this.#runtimeProofAuthority = options.runtimeProofAuthority;
    this.#attestation = validateAttestation(options.attestation, options.expected);
    const approvedImage = this.#attestation.policy.runtimeImage;
    if (!approvedImage || !/^[a-f0-9]{64}$/u.test(approvedImage.digest)) {
      throw new TypeError(
        "enterprise Docker sandbox requires an API-approved content-addressed image"
      );
    }
    const requestedImage = requireImage(options.image);
    if (requestedImage !== approvedImage.reference) {
      throw new TypeError("worker sandbox image cannot override the API-approved image");
    }
    this.#image = approvedImage.reference;
    this.id = this.#attestation.backend.id;
    this.version = this.#attestation.backend.version;
    if (this.#attestation.policy.network.mode !== "deny") {
      throw new TypeError(
        "Docker CLI backend only supports fail-closed network deny; use a policy-aware remote backend for hostname allowlists"
      );
    }
  }

  async prepare(request: SandboxPreparationRequest): Promise<SandboxPreparation> {
    if (!request || typeof request !== "object") {
      throw new TypeError("sandbox preparation request is required");
    }
    const projectRoot = await realpath(requireAbsolutePath(request.projectRoot, "projectRoot"));
    requireIdentity(request.taskId, "taskId");
    requireSubset(
      (request.commandAllowlist ?? []).map((value) =>
        requireExecutable(value, "requested command allowlist entry")
      ),
      this.#attestation.policy.allowedTools,
      "requested command allowlist"
    );
    if ((request.networkAllowlist?.length ?? 0) > 0) {
      throw new Error("sandbox lease denies all network access");
    }
    if (projectRoot.includes(",") || projectRoot.includes("\n")) {
      throw new TypeError("projectRoot cannot be represented safely as a Docker bind mount");
    }
    const projectMount = requiredMount(this.#attestation, "project");
    const scratchMount = requiredMount(this.#attestation, "scratch");
    if (projectMount.readOnly !== true || scratchMount.readOnly !== false) {
      throw new TypeError("sandbox lease has unsafe project or scratch mount access");
    }
    const scratchRoot = await realpath(
      await mkdtemp(join(tmpdir(), "mn-docker-sandbox-"))
    );
    await chmod(scratchRoot, 0o777);
    let containerId: string | undefined;
    try {
      const limits = this.#attestation.policy.resources;
      const claimLabels = runtimeClaimLabels(this.#attestation);
      const created = await dockerCommand(this.#docker, [
        "create",
        "--read-only",
        "--network",
        "none",
        "--ipc",
        "private",
        "--cgroupns",
        "private",
        "--runtime",
        "runc",
        "--log-driver",
        "none",
        "--cpus",
        String(limits.cpu),
        "--memory",
        `${limits.memoryMb}m`,
        "--memory-swap",
        `${limits.memoryMb}m`,
        "--pids-limit",
        String(limits.pids),
        "--shm-size",
        "16m",
        "--ulimit",
        "nofile=1024:1024",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "65534:65534",
        ...Object.entries(claimLabels).flatMap(([name, value]) => [
          "--label",
          `${name}=${value}`
        ]),
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16777216,mode=1777",
        "--mount",
        `type=bind,source=${projectRoot},target=${projectMount.target},readonly`,
        "--mount",
        `type=bind,source=${scratchRoot},target=${scratchMount.target}`,
        "--workdir",
        projectMount.target,
        this.#image,
        "sleep",
        String(Math.max(60, limits.timeoutSeconds + 60))
      ], 60);
      if (created.exitCode !== 0) {
        throw new Error(`docker create failed: ${created.stderr || created.stdout}`);
      }
      containerId = created.stdout.trim();
      if (!/^[a-f0-9]{64}$/u.test(containerId)) {
        throw new Error("docker create returned an invalid container id");
      }
      const started = await dockerCommand(this.#docker, ["start", containerId], 60);
      if (started.exitCode !== 0) {
        throw new Error(`docker start failed: ${started.stderr || started.stdout}`);
      }
      const inspected = await dockerCommand(this.#docker, ["inspect", containerId], 30);
      if (inspected.exitCode !== 0) {
        throw new Error(`docker inspect failed: ${inspected.stderr || inspected.stdout}`);
      }
      validateDockerInspection(
        inspected.stdout,
        containerId,
        projectRoot,
        scratchRoot,
        this.#attestation
      );
      const runtimeProof = validateAuthorityProofEnvelope(
        await this.#runtimeProofAuthority({
          attestation: this.#attestation,
          runtimeId: containerId
        }),
        this.#attestation,
        containerId
      );
      const evidence = deepFreeze({
        backendId: this.id,
        backendVersion: this.version,
        leaseId: this.#attestation.leaseId,
        attestationDigest: this.#attestation.digest,
        runtimeId: containerId,
        runtimeDigest: runtimeProof.runtimeDigest,
        imageDigest: runtimeProof.imageDigest!,
        runtimeProof
      });
      if (this.#leases.has(this.#attestation.leaseId)) {
        throw new Error(`sandbox lease ${this.#attestation.leaseId} is already active`);
      }
      this.#leases.set(this.#attestation.leaseId, {
        containerId,
        projectRoot,
        scratchRoot,
        projectTarget: projectMount.target,
        scratchTarget: scratchMount.target,
        evidence,
        resolvedTools: new Map()
      });
      return Object.freeze({
        backendId: this.id,
        workspacePath: projectMount.target,
        leaseId: this.#attestation.leaseId
      });
    } catch (error) {
      if (containerId) {
        await dockerCommand(this.#docker, ["rm", "-f", containerId], 30).catch(() => undefined);
      }
      await rm(scratchRoot, { recursive: true, force: true });
      throw error;
    }
  }

  executionEvidence(leaseId: string): SandboxExecutionEvidence {
    return this.#requireLease(leaseId).evidence;
  }

  /** Host-side root of the lease's writable scratch mount. Workspace
   * materialization may write here, while every executable still runs through
   * docker exec in the inspected runtime. */
  workspaceRoot(leaseId: string): string {
    return this.#requireLease(leaseId).scratchRoot;
  }

  /** Maps a host path in either immutable project source or writable scratch
   * to its container path without exposing an ungoverned command surface. */
  containerPath(leaseId: string, hostPath: string): string {
    const lease = this.#requireLease(leaseId);
    return containerPathForLease(lease, requireAbsolutePath(hostPath, "hostPath"));
  }

  gateCommandExecutor(leaseId: string): GateCommandExecutor {
    const evidence = this.executionEvidence(leaseId);
    return Object.freeze({
      id: "docker/exec",
      version: "1",
      sandboxExecution: evidence,
      resolveToolIdentity: (executable: string, cwd: string) =>
        this.#resolveToolIdentity(leaseId, executable, cwd),
      execute: async (request: GateCommandExecutionRequest) => {
        const result = await this.execute(leaseId, {
          executable: request.executable,
          args: request.args,
          cwd: request.cwd,
          timeoutSeconds: request.timeoutSeconds,
          ...(request.signal ? { signal: request.signal } : {})
        });
        if (result.stdout) {
          request.onEvent?.({
            runId: request.runId,
            candidateId: request.candidateId,
            type: "stdout",
            message: result.stdout,
            timestamp: new Date().toISOString()
          });
        }
        if (result.stderr) {
          request.onEvent?.({
            runId: request.runId,
            candidateId: request.candidateId,
            type: "stderr",
            message: result.stderr,
            timestamp: new Date().toISOString()
          });
        }
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
        const firstLine = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0];
        return firstLine || "unknown";
      }
    });
  }

  async execute(
    leaseId: string,
    request: DockerSandboxExecuteRequest
  ): Promise<DockerSandboxCommandResult> {
    const lease = this.#requireLease(leaseId);
    const executable = requireRuntimeExecutable(request.executable, "executable");
    const tool = isAbsolute(executable)
      ? lease.resolvedTools.get(executable)
      : executable;
    if (!tool) {
      throw new Error("absolute executable was not resolved by the trusted runtime authority");
    }
    if (!this.#attestation.policy.allowedTools.includes(tool)) {
      throw new Error(`tool ${tool} is not allowed by sandbox lease`);
    }
    const hostCwd = await realpath(requireAbsolutePath(request.cwd, "cwd"));
    const containerCwd = containerPathForLease(lease, hostCwd);
    const env = request.env ?? {};
    for (const [name, value] of Object.entries(env)) {
      requireEnvironmentName(name);
      if (typeof value !== "string" || /\0/u.test(value)) {
        throw new TypeError(`environment value ${name} is invalid`);
      }
    }
    for (const secretName of request.secretNames ?? []) {
      requireEnvironmentName(secretName);
      if (!this.#attestation.policy.secretNames.includes(secretName)) {
        throw new Error(`secret ${secretName} is not allowed by sandbox lease`);
      }
      if (!Object.hasOwn(env, secretName)) {
        throw new Error(`allowed secret ${secretName} has no resolved value`);
      }
    }
    const timeoutSeconds = Math.max(
      1,
      Math.min(
        requirePositiveInteger(request.timeoutSeconds, "timeoutSeconds"),
        this.#attestation.policy.resources.timeoutSeconds
      )
    );
    const args = [
      "exec",
      ...(request.stdin === undefined ? [] : ["-i"]),
      "--workdir",
      containerCwd,
      ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      lease.containerId,
      executable,
      ...request.args.map((argument) => requireArgument(argument))
    ];
    return dockerCommand(
      this.#docker,
      args,
      timeoutSeconds,
      request.signal,
      request.stdin
    );
  }

  async release(leaseId: string): Promise<void> {
    const lease = this.#requireLease(leaseId);
    this.#leases.delete(leaseId);
    const removed = await dockerCommand(this.#docker, ["rm", "-f", lease.containerId], 30);
    await rm(lease.scratchRoot, { recursive: true, force: true });
    if (removed.exitCode !== 0) {
      throw new Error(`docker sandbox cleanup failed: ${removed.stderr || removed.stdout}`);
    }
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
    const hostCwd = await realpath(requireAbsolutePath(cwd, "cwd"));
    const containerCwd = containerPathForLease(lease, hostCwd);
    const result = await dockerCommand(this.#docker, [
      "exec",
      "--workdir",
      containerCwd,
      lease.containerId,
      "/bin/sh",
      "-ceu",
      TOOL_IDENTITY_SCRIPT,
      "mn-tool-resolver",
      requestedExecutable
    ], 30);
    if (result.exitCode !== 0) {
      throw new Error(
        `trusted runtime could not resolve ${requestedExecutable}: ${result.stderr || result.stdout}`
      );
    }
    const lines = result.stdout.trim().split(/\r?\n/u);
    if (
      lines.length !== 2 ||
      !trustedRuntimeExecutable(lines[0]!) ||
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

  #requireLease(leaseId: string): ActiveDockerLease {
    requireIdentity(leaseId, "leaseId");
    const lease = this.#leases.get(leaseId);
    if (!lease) throw new Error(`Unknown or inactive Docker sandbox lease ${leaseId}`);
    return lease;
  }
}

function containerPathForLease(
  lease: ActiveDockerLease,
  hostPath: string
): string {
  for (const [root, target] of [
    [lease.projectRoot, lease.projectTarget],
    [lease.scratchRoot, lease.scratchTarget]
  ] as const) {
    const child = relative(root, hostPath);
    if (
      child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    ) {
      return child === ""
        ? target
        : `${target}/${child.split(sep).join("/")}`;
    }
  }
  throw new Error("command working directory is outside the leased project mount or scratch mount");
}

function validateAttestation(
  value: SandboxLeaseAttestation,
  expected: DockerSandboxExpectedBinding
): SandboxLeaseAttestation {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new TypeError("API-issued sandbox attestation is required");
  }
  const { digest, signature, ...semantic } = value;
  requireDigest(digest, "attestation digest");
  requireDigest(signature, "attestation signature");
  if (sha256Canonical(semantic) !== digest) {
    throw new TypeError("sandbox attestation digest does not match its immutable content");
  }
  if (sha256Canonical(value.policy) !== value.policyDigest) {
    throw new TypeError("sandbox policy digest does not match its immutable content");
  }
  const bindings = [
    ["run", value.runId, expected.runId],
    ["tenant", value.tenantId, expected.tenantId],
    ["worker", value.workerId, expected.workerId],
    ["Harness", value.harnessDigest, expected.harnessDigest]
  ] as const;
  for (const [field, actual, wanted] of bindings) {
    if (actual !== wanted) throw new TypeError(`sandbox attestation ${field} binding mismatch`);
  }
  if (Date.parse(value.expiresAt) <= Date.now()) {
    throw new TypeError("sandbox attestation is expired");
  }
  if (value.policy.readOnlyRootFilesystem !== true) {
    throw new TypeError("sandbox attestation must require a read-only root filesystem");
  }
  if (!value.policy.allowedTools.length) {
    throw new TypeError("sandbox attestation must contain an allowed tool set");
  }
  return deepFreeze(structuredClone(value));
}

function validateDockerInspection(
  raw: string,
  containerId: string,
  projectRoot: string,
  scratchRoot: string,
  attestation: SandboxLeaseAttestation
): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error("docker inspect returned an invalid document");
  }
  const inspection = parsed[0];
  const host = recordProperty(inspection, "HostConfig");
  const config = recordProperty(inspection, "Config");
  const labels = recordProperty(config, "Labels");
  const runtimeImage = attestation.policy.runtimeImage;
  if (
    !runtimeImage ||
    inspection.Image !== `sha256:${runtimeImage.digest}` ||
    config.Image !== runtimeImage.reference
  ) {
    throw new Error("docker runtime image does not match the API-approved content digest");
  }
  const mounts = arrayProperty(inspection, "Mounts").map((mount) => {
    if (!isRecord(mount)) throw new Error("docker inspect mount is invalid");
    return {
      type: mount.Type,
      source: mount.Source,
      destination: mount.Destination,
      rw: mount.RW,
      propagation: mount.Propagation
    };
  });
  const projectMount = requiredMount(attestation, "project");
  const scratchMount = requiredMount(attestation, "scratch");
  const expectedMounts = [
    {
      type: "bind",
      source: projectRoot,
      destination: projectMount.target,
      rw: false,
      propagation: "rprivate"
    },
    {
      type: "bind",
      source: scratchRoot,
      destination: scratchMount.target,
      rw: true,
      propagation: "rprivate"
    }
  ];
  for (const expected of expectedMounts) {
    if (!mounts.some((mount) => sha256Canonical(mount) === sha256Canonical(expected))) {
      throw new Error(`docker runtime did not enforce mount ${expected.destination}`);
    }
  }
  if (mounts.length !== expectedMounts.length) {
    throw new Error("docker runtime contains an unauthorized mount");
  }
  const limits = attestation.policy.resources;
  const securityOpt = nullableStringArray(host.SecurityOpt, "HostConfig.SecurityOpt");
  const capDrop = nullableStringArray(host.CapDrop, "HostConfig.CapDrop");
  const capAdd = nullableStringArray(host.CapAdd, "HostConfig.CapAdd");
  const devices = nullableArray(host.Devices, "HostConfig.Devices");
  const deviceRequests = nullableArray(host.DeviceRequests, "HostConfig.DeviceRequests");
  const deviceCgroupRules = nullableArray(
    host.DeviceCgroupRules,
    "HostConfig.DeviceCgroupRules"
  );
  const ulimits = nullableArray(host.Ulimits, "HostConfig.Ulimits");
  const dnsOptions = nullableStringArray(host.DnsOptions, "HostConfig.DnsOptions");
  const dnsSearch = nullableStringArray(host.DnsSearch, "HostConfig.DnsSearch");
  const groupAdd = nullableStringArray(host.GroupAdd, "HostConfig.GroupAdd");
  const maskedPaths = nullableStringArray(host.MaskedPaths, "HostConfig.MaskedPaths");
  const readonlyPaths = nullableStringArray(host.ReadonlyPaths, "HostConfig.ReadonlyPaths");
  const logConfig = recordProperty(host, "LogConfig");
  const portBindings = recordProperty(host, "PortBindings");
  const restartPolicy = recordProperty(host, "RestartPolicy");
  const tmpfs = recordProperty(host, "Tmpfs");
  const tmpfsOptions = typeof tmpfs["/tmp"] === "string"
    ? new Set(tmpfs["/tmp"].split(","))
    : new Set<string>();
  const expectedLabels = runtimeClaimLabels(attestation);
  if (
    Object.entries(expectedLabels).some(([name, value]) => labels[name] !== value)
  ) {
    throw new Error("docker runtime claim binding labels do not match the active lease");
  }
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
    config.User !== "65534:65534" ||
    config.OpenStdin !== false ||
    config.Tty !== false ||
    Object.keys(tmpfs).length !== 1 ||
    !["rw", "noexec", "nosuid", "size=16777216", "mode=1777"].every(
      (option) => tmpfsOptions.has(option)
    ) ||
    tmpfsOptions.size !== 5
  ) {
    throw new Error("docker runtime inspection does not satisfy the issued sandbox policy");
  }
  return {
    schemaVersion: 2,
    runtimeId: containerId,
    image: config.Image,
    imageDigest: runtimeImage.digest,
    user: config.User,
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
    mounts: mounts.sort((left, right) => String(left.destination).localeCompare(String(right.destination))),
    claimLabels: expectedLabels,
    attestationDigest: attestation.digest
  };
}

function validateAuthorityProofEnvelope(
  value: SandboxRuntimeProof,
  attestation: SandboxLeaseAttestation,
  runtimeId: string
): SandboxRuntimeProof {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new TypeError("runtime proof authority returned an invalid proof");
  }
  const { digest, signature, ...semantic } = value;
  requireDigest(digest, "runtime proof digest");
  requireDigest(signature, "runtime proof signature");
  if (sha256Canonical(semantic) !== digest) {
    throw new TypeError("runtime proof digest does not match its immutable content");
  }
  for (const [field, actual, expected] of [
    ["issuer", value.issuer, "mn-api"],
    ["tenant", value.tenantId, attestation.tenantId],
    ["run", value.runId, attestation.runId],
    ["worker", value.workerId, attestation.workerId],
    ["claim", value.claimDigest, attestation.claimDigest],
    ["attestation", value.attestationDigest, attestation.digest],
    ["runtime", value.runtimeId, runtimeId]
  ] as const) {
    if (actual !== expected) {
      throw new TypeError(`runtime proof ${field} binding mismatch`);
    }
  }
  requireDigest(value.runtimeDigest, "runtime proof runtimeDigest");
  if (typeof value.imageDigest !== "string") {
    throw new TypeError("runtime proof imageDigest is required");
  }
  requireDigest(value.imageDigest, "runtime proof imageDigest");
  if (value.imageDigest !== attestation.policy.runtimeImage?.digest) {
    throw new TypeError("runtime proof image digest is not approved by the sandbox lease");
  }
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  const now = Date.now();
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 30_000 ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 3_600_000 ||
    expiresAt > Date.parse(attestation.expiresAt)
  ) {
    throw new TypeError("runtime proof freshness bounds are invalid");
  }
  return deepFreeze(structuredClone(value));
}

function runtimeClaimLabels(
  attestation: SandboxLeaseAttestation
): Readonly<Record<string, string>> {
  return {
    "io.mn.sandbox.lease-id": attestation.leaseId,
    "io.mn.sandbox.attestation-digest": attestation.digest,
    "io.mn.sandbox.claim-digest": attestation.claimDigest,
    "io.mn.sandbox.run-id": attestation.runId,
    "io.mn.sandbox.tenant-id": attestation.tenantId,
    "io.mn.sandbox.worker-id": attestation.workerId
  };
}

function requiredMount(
  attestation: SandboxLeaseAttestation,
  source: "project" | "scratch"
) {
  const mounts = attestation.policy.mounts.filter((mount) => mount.source === source);
  if (mounts.length !== 1) throw new TypeError(`sandbox lease requires exactly one ${source} mount`);
  const mount = mounts[0]!;
  requireContainerPath(mount.target, `${source} mount target`);
  return mount;
}

function dockerCommand(
  executable: string,
  args: readonly string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
  stdin?: string
): Promise<DockerSandboxCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      [...args],
      {
        timeout: Math.max(1, timeoutSeconds) * 1_000,
        maxBuffer: 16 * 1024 * 1024,
        ...(signal ? { signal } : {})
      },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number"
          ? error.code
          : error ? null : 0;
        resolve({ exitCode: code, stdout, stderr });
      }
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

function requireSubset(requested: readonly string[], allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const denied = requested.filter((value) => !allowedSet.has(value));
  if (denied.length > 0) throw new Error(`${field} exceeds sandbox lease: ${denied.join(", ")}`);
}

function requireImage(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n\s]/u.test(value) ||
    value.startsWith("-")
  ) {
    throw new TypeError("sandbox image must be a pinned Docker image reference");
  }
  return value;
}

function requireExecutable(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bare executable name`);
  }
  return value;
}

function requireRuntimeExecutable(value: string, field: string): string {
  if (isAbsolute(value) && trustedRuntimeExecutable(value)) return value;
  return requireExecutable(value, field);
}

function trustedRuntimeExecutable(value: string): boolean {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    !/[\0\r\n]/u.test(value) &&
    !value.includes("/../") &&
    !value.endsWith("/..") &&
    ["/bin/", "/sbin/", "/usr/", "/opt/"].some((root) => value.startsWith(root))
  );
}

function requireArgument(value: string): string {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) {
    throw new TypeError("command argument contains control characters");
  }
  return value;
}

function requireEnvironmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) {
    throw new TypeError(`invalid environment name ${value}`);
  }
  return value;
}

function requireIdentity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a non-empty safe identifier`);
  }
  return value;
}

function requireDigest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${field} must be SHA-256`);
  return value;
}

function requireAbsolutePath(value: string, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return resolve(value);
}

function requireContainerPath(value: string, field: string): string {
  const normalized = requireAbsolutePath(value, field);
  if (!normalized.startsWith("/workspace/") || normalized.includes(",")) {
    throw new TypeError(`${field} must be contained by /workspace`);
  }
  return normalized;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function recordProperty(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const property = value[key];
  if (!isRecord(property)) throw new Error(`docker inspect ${key} is invalid`);
  return property;
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
  const property = value[key];
  if (!Array.isArray(property)) throw new Error(`docker inspect ${key} is invalid`);
  return property;
}

function nullableArray(value: unknown, field: string): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value;
}

function nullableStringArray(value: unknown, field: string): string[] {
  const values = nullableArray(value, field);
  if (values.some((item) => typeof item !== "string")) {
    throw new Error(`${field} is invalid`);
  }
  return values as string[];
}

/** Docker Desktop reports the unset false pointer as null after start, while
 * Linux daemons commonly report false. Both have identical fail-safe meaning. */
function normalizedOomKillDisable(value: unknown): boolean | "invalid" {
  return value === null || value === false ? false : value === true ? true : "invalid";
}

function requiredSubset(required: readonly string[], actual: readonly string[]): boolean {
  const values = new Set(actual);
  return required.every((item) => values.has(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("sandbox evidence must be canonical JSON");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
