import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SandboxLeaseAttestation } from "@mn/harness";
import { verifyDockerRuntimeInspection } from "../src/dockerRuntimeVerifier.js";

const IMAGE_DIGEST = "8".repeat(64);

test("trusted Docker inspection derives runtime digest from enforced policy and claim labels", async (t) => {
  const roots = await rootsFixture(t);
  const attestation = lease();
  const runtimeId = "a".repeat(64);
  const result = await verifyDockerRuntimeInspection(
    JSON.stringify([inspection(attestation, runtimeId, roots.project, roots.scratch)]),
    {
      runtimeId,
      attestation,
      projectRoot: roots.project,
      scratchRootParent: roots.parent,
      imageInspectionRaw: imageInspection()
    }
  );

  assert.equal(result.runtimeId, runtimeId);
  assert.equal(result.imageDigest, IMAGE_DIGEST);
  assert.match(result.runtimeDigest, /^[a-f0-9]{64}$/u);
  assert.equal(result.projectRoot, await realpath(roots.project));
  assert.equal(result.scratchRoot, await realpath(roots.scratch));
  assert.equal(result.projectTarget, "/workspace/project");
  assert.equal(result.scratchTarget, "/workspace/scratch");
});

test("trusted Docker inspection rejects unauthorized mounts and forged claim labels", async (t) => {
  const roots = await rootsFixture(t);
  const attestation = lease();
  const runtimeId = "a".repeat(64);
  const extraMount = inspection(attestation, runtimeId, roots.project, roots.scratch);
  extraMount.Mounts.push({
    Type: "bind",
    Source: "/etc",
    Destination: "/host-etc",
    RW: true,
    Propagation: "rprivate"
  });
  await assert.rejects(
    verifyDockerRuntimeInspection(JSON.stringify([extraMount]), {
      runtimeId,
      attestation,
      projectRoot: roots.project,
      scratchRootParent: roots.parent,
      imageInspectionRaw: imageInspection()
    }),
    /unauthorized mount/u
  );

  const wrongClaim = inspection(attestation, runtimeId, roots.project, roots.scratch);
  wrongClaim.Config.Labels["io.mn.sandbox.claim-digest"] = "f".repeat(64);
  await assert.rejects(
    verifyDockerRuntimeInspection(JSON.stringify([wrongClaim]), {
      runtimeId,
      attestation,
      projectRoot: roots.project,
      scratchRootParent: roots.parent,
      imageInspectionRaw: imageInspection()
    }),
    /claim binding/u
  );
});

test("trusted Docker inspection rejects image, env, entrypoint and unsafe option drift", async (t) => {
  const roots = await rootsFixture(t);
  const attestation = lease();
  const runtimeId = "a".repeat(64);
  const verify = (value: ReturnType<typeof inspection>) =>
    verifyDockerRuntimeInspection(JSON.stringify([value]), {
      runtimeId,
      attestation,
      projectRoot: roots.project,
      scratchRootParent: roots.parent,
      imageInspectionRaw: imageInspection()
    });

  const wrongImage = inspection(attestation, runtimeId, roots.project, roots.scratch);
  wrongImage.Image = `sha256:${"9".repeat(64)}`;
  await assert.rejects(verify(wrongImage), /image identity/u);

  const secretEnv = inspection(attestation, runtimeId, roots.project, roots.scratch);
  secretEnv.Config.Env.push("SECRET=leaked");
  await assert.rejects(verify(secretEnv), /sandbox policy/u);

  const entrypoint = inspection(attestation, runtimeId, roots.project, roots.scratch);
  entrypoint.Config.Entrypoint = ["/bin/sh", "-c"];
  await assert.rejects(verify(entrypoint), /sandbox policy/u);

  const command = inspection(attestation, runtimeId, roots.project, roots.scratch);
  command.Config.Cmd = ["sleep", "999999"];
  await assert.rejects(verify(command), /sandbox policy/u);

  const security = inspection(attestation, runtimeId, roots.project, roots.scratch);
  security.HostConfig.SecurityOpt.push("seccomp=unconfined");
  await assert.rejects(verify(security), /sandbox policy/u);

  const device = inspection(attestation, runtimeId, roots.project, roots.scratch);
  (device.HostConfig.Devices as unknown[]).push({ PathOnHost: "/dev/null" });
  await assert.rejects(verify(device), /sandbox policy/u);

  const executableTmp = inspection(attestation, runtimeId, roots.project, roots.scratch);
  executableTmp.HostConfig.Tmpfs["/tmp"] =
    "rw,noexec,nosuid,size=16777216,mode=1777,exec";
  await assert.rejects(verify(executableTmp), /sandbox policy/u);

  const interactive = inspection(attestation, runtimeId, roots.project, roots.scratch);
  interactive.Config.Tty = true;
  await assert.rejects(verify(interactive), /sandbox policy/u);

  for (const [name, mutate] of [
    ["pid namespace", (value: ReturnType<typeof inspection>) => { value.HostConfig.PidMode = "host"; }],
    ["ipc namespace", (value: ReturnType<typeof inspection>) => { value.HostConfig.IpcMode = "host"; }],
    ["user namespace", (value: ReturnType<typeof inspection>) => { value.HostConfig.UsernsMode = "host"; }],
    ["cgroup namespace", (value: ReturnType<typeof inspection>) => { value.HostConfig.CgroupnsMode = "host"; }],
    ["device cgroup", (value: ReturnType<typeof inspection>) => { value.HostConfig.DeviceCgroupRules = ["c 1:3 rwm"]; }],
    ["memory swap", (value: ReturnType<typeof inspection>) => { value.HostConfig.MemorySwap += 1; }],
    ["oom killer", (value: ReturnType<typeof inspection>) => { value.HostConfig.OomKillDisable = true; }],
    ["ulimit", (value: ReturnType<typeof inspection>) => { value.HostConfig.Ulimits[0]!.Hard = 2048; }],
    ["cpu shares", (value: ReturnType<typeof inspection>) => { value.HostConfig.CpuShares = 2; }],
    ["cpu period", (value: ReturnType<typeof inspection>) => { value.HostConfig.CpuPeriod = 100000; }],
    ["cpu quota", (value: ReturnType<typeof inspection>) => { value.HostConfig.CpuQuota = 50000; }],
    ["cpuset", (value: ReturnType<typeof inspection>) => { value.HostConfig.CpusetCpus = "0"; }]
    , ["cgroup parent", (value: ReturnType<typeof inspection>) => { value.HostConfig.CgroupParent = "/escape"; }]
    , ["log driver", (value: ReturnType<typeof inspection>) => { value.HostConfig.LogConfig.Type = "syslog"; }]
    , ["masked path", (value: ReturnType<typeof inspection>) => {
      value.HostConfig.MaskedPaths = value.HostConfig.MaskedPaths.filter((path) => path !== "/proc/kcore");
    }]
  ] as const) {
    const drift = inspection(attestation, runtimeId, roots.project, roots.scratch);
    mutate(drift);
    await assert.rejects(verify(drift), /sandbox policy/u, name);
  }
});

async function rootsFixture(t: test.TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "mn-runtime-proof-test-"));
  const project = await mkdtemp(join(parent, "project-"));
  const scratch = await mkdtemp(join(parent, "mn-docker-sandbox-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, project, scratch };
}

function inspection(
  attestation: SandboxLeaseAttestation,
  runtimeId: string,
  projectRoot: string,
  scratchRoot: string
) {
  return {
    Id: runtimeId,
    Image: `sha256:${IMAGE_DIGEST}`,
    State: { Running: true },
    Config: {
      Image: "node:22-alpine",
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.23.1"],
      Entrypoint: ["docker-entrypoint.sh"],
      Cmd: ["sleep", "660"],
      User: "65534:65534",
      WorkingDir: "/workspace/project",
      OpenStdin: false,
      Tty: false,
      Labels: {
        "io.mn.sandbox.lease-id": attestation.leaseId,
        "io.mn.sandbox.attestation-digest": attestation.digest,
        "io.mn.sandbox.claim-digest": attestation.claimDigest,
        "io.mn.sandbox.run-id": attestation.runId,
        "io.mn.sandbox.tenant-id": attestation.tenantId,
        "io.mn.sandbox.worker-id": attestation.workerId
      }
    },
    HostConfig: {
      ReadonlyRootfs: true,
      NetworkMode: "none",
      PidMode: "",
      IpcMode: "private",
      UsernsMode: "",
      CgroupnsMode: "private",
      UTSMode: "",
      Cgroup: "",
      CgroupParent: "",
      Runtime: "runc",
      Isolation: "",
      OomScoreAdj: 0,
      NanoCpus: 1_000_000_000,
      CpuShares: 0,
      CpuPeriod: 0,
      CpuQuota: 0,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpusetCpus: "",
      CpusetMems: "",
      CpuCount: 0,
      CpuPercent: 0,
      Memory: 512 * 1024 * 1024,
      MemoryReservation: 0,
      MemorySwap: 512 * 1024 * 1024,
      MemorySwappiness: null,
      OomKillDisable: false,
      ShmSize: 16 * 1024 * 1024,
      PidsLimit: 64,
      CapDrop: ["ALL"],
      CapAdd: null,
      Privileged: false,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16777216,mode=1777" },
      Devices: [],
      DeviceRequests: null,
      DeviceCgroupRules: null as string[] | null,
      Ulimits: [{ Name: "nofile", Hard: 1024, Soft: 1024 }],
      ExtraHosts: null,
      Dns: null,
      DnsOptions: [],
      DnsSearch: [],
      GroupAdd: null,
      Links: null,
      PublishAllPorts: false,
      AutoRemove: false,
      Binds: null,
      VolumesFrom: null,
      LogConfig: { Type: "none", Config: {} },
      PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      MaskedPaths: [
        "/proc/acpi",
        "/proc/kcore",
        "/proc/keys",
        "/proc/latency_stats",
        "/proc/scsi",
        "/proc/timer_list",
        "/proc/timer_stats",
        "/sys/firmware"
      ],
      ReadonlyPaths: [
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger"
      ]
    },
    Mounts: [
      {
        Type: "bind",
        Source: projectRoot,
        Destination: "/workspace/project",
        RW: false,
        Propagation: "rprivate"
      },
      {
        Type: "bind",
        Source: scratchRoot,
        Destination: "/workspace/scratch",
        RW: true,
        Propagation: "rprivate"
      }
    ],
    NetworkSettings: { Networks: { none: {} } }
  };
}

function imageInspection(): string {
  return JSON.stringify([{
    Id: `sha256:${IMAGE_DIGEST}`,
    Config: {
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.23.1"],
      Entrypoint: ["docker-entrypoint.sh"],
      Cmd: ["node"],
      Labels: null
    }
  }]);
}

function lease(): SandboxLeaseAttestation {
  return {
    schemaVersion: 1,
    leaseId: "lease-a",
    issuer: "mn-api",
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-13T00:00:00.000Z",
    runId: "run-a",
    tenantId: "tenant-a",
    workerId: "worker-a",
    harnessDigest: "1".repeat(64),
    requirementsDigest: "2".repeat(64),
    workerCapabilityDigest: "3".repeat(64),
    claimDigest: "4".repeat(64),
    backend: { id: "enterprise-container", version: "1" },
    policy: {
      mounts: [
        { source: "project", target: "/workspace/project", readOnly: true },
        { source: "scratch", target: "/workspace/scratch", readOnly: false }
      ],
      network: { mode: "deny", allowlist: [] },
      resources: { cpu: 1, memoryMb: 512, pids: 64, timeoutSeconds: 600 },
      secretNames: [],
      allowedTools: ["node"],
      readOnlyRootFilesystem: true,
      runtimeImage: { reference: "node:22-alpine", digest: IMAGE_DIGEST }
    },
    policyDigest: "5".repeat(64),
    digest: "6".repeat(64),
    signature: "7".repeat(64)
  };
}
