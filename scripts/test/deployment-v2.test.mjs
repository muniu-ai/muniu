// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EnvelopeCipher } from "@mn/storage";

import { VaultTransitKeyProvider } from "../lib/enterprise-secrets.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");
const legacyControlPlane = /apps\/api|mn-api|["'`]\/v1(?:\/|["'`])/u;

test("enterprise compose runs two v2 Hosts and two 30-second-lease Workers", () => {
  const compose = read("docker-compose.enterprise.yml");
  for (const service of ["host-a:", "host-b:", "worker-a:", "worker-b:"]) {
    assert.match(compose, new RegExp(`\\n  ${service.replace(":", "")}:`));
  }
  assert.match(compose, /MN_POSTGRES_SCHEMA:\s*mn_v2/);
  assert.match(compose, /MN_S3_PREFIX:\s*v2\//);
  assert.match(compose, /MN_JOB_LEASE_MS:\s*["']?30000/);
  assert.match(compose, /MN_ENGINE_LOCK_DIGEST:/);
  assert.match(compose, /MN_PLUGIN_LOCK_DIGEST:/);
  assert.doesNotMatch(compose, legacyControlPlane);
});

test("企业 Host 可通过 Vault Transit 端口包装和解包受保护数据的 DEK", async () => {
  const calls = [];
  let encodedDataKey;
  const provider = new VaultTransitKeyProvider({
    address: "https://vault.example.test",
    token: "fixture-token",
    mount: "transit-v2",
    keyName: "protected-assets",
    fetchImplementation: async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push({ url: String(url), init, request });
      if (String(url).includes("/encrypt/")) {
        encodedDataKey = request.plaintext;
        return Response.json({ data: { ciphertext: "vault:v1:wrapped-dek" } });
      }
      return Response.json({ data: { plaintext: encodedDataKey } });
    },
  });
  const cipher = new EnvelopeCipher(provider);
  const plaintext = Buffer.from("enterprise protected asset");
  const envelope = await cipher.encrypt(plaintext, {
    tenantId: "tenant-a",
    purpose: "asset:asset-1",
  });
  assert.deepEqual(await cipher.decrypt(envelope), plaintext);
  assert.match(calls[0].url, /\/v1\/transit-v2\/encrypt\/protected-assets$/u);
  assert.match(calls[1].url, /\/v1\/transit-v2\/decrypt\/protected-assets$/u);
  assert.equal(calls[0].init.headers["x-vault-token"], "fixture-token");
  assert.equal(calls[0].request.context, calls[1].request.context);
  assert.doesNotMatch(calls.map((call) => call.url).join("\n"), /fixture-token|enterprise protected asset/u);
  const host = read("scripts/enterprise-host.mjs");
  assert.match(host, /protectedPayloadKeyProvider/u);
  assert.match(host, /VaultTransitKeyProvider/u);
  assert.match(host, /createEnterpriseFilePluginRepository/u);
  assert.match(host, /MN_PLUGIN_REPOSITORY_DIGEST/u);
});

test("Helm chart deploys matching Host and Worker replicas with fail-closed readiness", () => {
  const values = read("deploy/helm/muniu/values.yaml");
  const host = read("deploy/helm/muniu/templates/deployment-host.yaml");
  const worker = read("deploy/helm/muniu/templates/deployment-worker.yaml");
  const config = read("deploy/helm/muniu/templates/configmap.yaml");
  assert.match(values, /host:\n\s+replicas:\s+2/);
  assert.match(values, /worker:\n\s+enabled:\s+true\n\s+replicas:\s+2/);
  assert.match(values, /leaseMs:\s+30000/);
  assert.match(values, /prefix:\s+v2\//);
  assert.match(host, /scripts\/enterprise-host\.mjs/);
  assert.match(host, /path:\s+\/v2\/readiness/);
  assert.match(worker, /scripts\/enterprise-worker\.mjs/);
  assert.match(config, /MN_POSTGRES_SCHEMA:\s+mn_v2/);
  assert.match(config, /MN_TELEMETRY_ENABLED:\s+"false"/);
  assert.match(config, /MN_VAULT_TRANSIT_MOUNT/);
  assert.match(config, /MN_VAULT_TRANSIT_KEY/);
  assert.match(config, /MN_EXPECTED_ENGINE_LOCK_DIGEST/);
  assert.match(config, /MN_EXPECTED_PLUGIN_LOCK_DIGEST/);
  assert.match(config, /MN_WORKER_ENABLED/);
  assert.match(config, /MN_WORKER_SUPPORTED_KINDS/);
  assert.match(config, /production worker requires vault\.address/u);
  assert.match(worker, /MN_VAULT_TOKEN/u);
  assert.match(values, /supportedKinds:\n\s+- system\.noop\n\s+- agent\.execution\.run/u);
  assert.match(values, /pluginRepository:\n\s+enabled:\s+false/u);
  assert.match(config, /MN_PLUGIN_REPOSITORY_INDEX/u);
  assert.match(config, /MN_PLUGIN_TRUSTED_ROOTS/u);
  assert.match(config, /MN_PLUGIN_REPOSITORY_DIGEST/u);
  assert.doesNotMatch(`${values}\n${host}\n${worker}\n${config}`, legacyControlPlane);
});

test("container and sidecar entrypoints are v2-only", () => {
  const dockerfile = read("Dockerfile");
  const sidecar = read("scripts/build-host-sidecar.mjs");
  assert.match(dockerfile, /scripts\/enterprise-host\.mjs/);
  assert.match(sidecar, /apps\/host\/src\/main\.ts/);
  assert.match(sidecar, /mn-host-aarch64-apple-darwin/);
  assert.match(sidecar, /mn-host-x86_64-apple-darwin/);
  assert.match(sidecar, /relocatePkgPayloads/u);
  assert.match(read(".github/workflows/ci.yml"), /build:host-sidecar -- --smoke/u);
  assert.match(read(".github/workflows/release.yml"), /build:host-sidecar -- --smoke/u);
  assert.doesNotMatch(`${dockerfile}\n${sidecar}`, /apps\/api|mn-api|descriptor-lock|["'`]\/v1(?:\/|["'`])/u);
  assert.equal(existsSync(join(root, "scripts/build-descriptor-lock-helper.mjs")), false);
});

test("macOS CI and release jobs exercise the external Coding Runner chain", () => {
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const source = read(workflow);
    const desktopJob = source.match(
      /^  desktop:\n[\s\S]*?(?=^  [a-z][a-z-]+:\n|(?![\s\S]))/mu,
    )?.[0] ?? "";
    assert.match(desktopJob, /runs-on: macos-14/u);
    assert.match(desktopJob, /npm run build:vendor/u);
    assert.match(desktopJob, /npm run build:core/u);
    assert.match(desktopJob, /npm run build -w @mn\/plugin-coding/u);
    assert.match(desktopJob, /npm run build -w @mn\/runner-claude-cli/u);
    assert.match(desktopJob, /npm run build -w @mn\/runner-codex-cli/u);
    assert.match(desktopJob, /npm test -w @mn\/runner-claude-cli/u);
    assert.match(desktopJob, /npm test -w @mn\/runner-codex-cli/u);
    assert.match(desktopJob, /npm test -w @mn\/worker/u);
    assert.match(desktopJob, /npm run verify:onboarding-ui/u);
    assert.match(desktopJob, /npm run verify:opc-ui/u);
    assert.match(desktopJob, /npm run verify:coding-ui/u);
    const installIndex = desktopJob.indexOf("npm ci");
    assert.ok(installIndex >= 0);
    for (const command of ["build:vendor", "build:core", "npm test -w @mn/worker"]) {
      assert.ok(desktopJob.indexOf(command) > installIndex);
    }
  }
});

test("enterprise verification targets committed-event recovery and stale fencing", () => {
  const fixture = read("scripts/enterprise-e2e.mjs");
  const kind = read("scripts/kind-enterprise-failover.mjs");
  for (const source of [fixture, kind]) {
    assert.match(source, /mn_v2/);
    assert.match(source, /30000/);
    assert.match(source, /fencing/i);
    assert.match(source, /RPO\s*0/i);
    assert.doesNotMatch(source, legacyControlPlane);
  }
});

test("Kind keeps candidate evidence separate from the authoritative Coding Gate", () => {
  const probe = read("scripts/kind-sandbox-probe.mjs");
  const gate = read("scripts/kind-authoritative-gate.mjs");
  const verifier = read("scripts/verify-kind-sandbox.sh");
  assert.match(probe, /issuer:\s*"candidate-runtime"/u);
  assert.doesNotMatch(probe, /authoritativeGate|coding-control-plane/u);
  assert.match(gate, /CodingExecutionEngine/u);
  assert.match(gate, /authoritative:\s*true/u);
  assert.match(gate, /issuer:\s*"coding-control-plane"/u);
  assert.match(verifier, /--read-only --network none/u);
  assert.match(verifier, /kind-authoritative-gate\.mjs/u);
});

test("PostgreSQL Host transaction commits Job and outbox with the event", () => {
  const adapter = read("scripts/lib/postgres-kernel-store.mjs");
  assert.match(adapter, /putJob:\s*\(job\)/u);
  assert.match(adapter, /putOutbox:\s*\(message\)/u);
  assert.match(adapter, /insert into mn_v2\.jobs/u);
  assert.match(adapter, /insert into mn_v2\.outbox/u);
  assert.match(adapter, /begin isolation level serializable/u);
  assert.match(adapter, /commit/u);
});

test("PostgreSQL Worker fences Agent Execution lifecycle transitions in the Job transaction", () => {
  const adapter = read("scripts/lib/postgres-worker-store.mjs");
  assert.match(adapter, /agent\.execution\.run/u);
  assert.match(adapter, /job\.lease_renewed/u);
  assert.match(adapter, /type: `job\.\$\{status\}`/u);
  assert.match(adapter, /type: `execution\.\$\{status\}`/u);
  assert.match(adapter, /status = 'leased'.*lease_owner.*fencing_token/su);
  assert.match(adapter, /insert into mn_v2\.events/u);
  assert.match(adapter, /insert into mn_v2\.outbox/u);
  assert.match(adapter, /update mn_v2\.projections set stream_version/u);
  assert.match(adapter, /await client\.query\("commit"\)/u);
});

test("unknown external effects become a durable event, inbox item, and non-replayable Job", () => {
  const adapter = read("scripts/lib/postgres-worker-store.mjs");
  assert.match(adapter, /execution\.needs_reconciliation/u);
  assert.match(adapter, /UNKNOWN_EXTERNAL_SIDE_EFFECT/u);
  assert.match(adapter, /insert into mn_v2\.events/u);
  assert.match(adapter, /insert into mn_v2\.reconciliations/u);
  assert.match(adapter, /insert into mn_v2\.outbox/u);
  assert.match(adapter, /'inbox'/u);
  assert.match(adapter, /status = 'failed'/u);
});

test("enterprise Worker ships a production Agent execution bootstrap", async () => {
  const worker = read("scripts/enterprise-worker.mjs");
  const builtin = read("scripts/enterprise-worker-handlers.mjs");
  const host = read("scripts/enterprise-host.mjs");
  const module = await import("../enterprise-worker-handlers.mjs");
  const store = {
    async transact() { throw new Error("test does not execute the handler"); },
    async readEvents() { return { events: [], nextPosition: 0, retentionFloor: 1 }; },
    async claimJob() { return undefined; },
  };
  const handlers = await module.createHandlers({
    store,
    secretStore: { async read() { return "fixture-key"; } },
    modelInvoker: async () => ({ content: "fixture", finishReason: "stop", usage: {} }),
    opcPublicWebReader: { async read() { return { status: 200 }; } },
    fixtureMode: false,
  });
  assert.match(worker, /createHandlers/u);
  assert.match(worker, /AGENT_EXECUTION_BOOTSTRAP_MISSING/u);
  assert.match(worker, /handlers\["agent\.execution\.run"\]/u);
  assert.match(worker, /MN_WORKER_SUPPORTED_KINDS/u);
  assert.match(worker, /workerHandlerReadiness/u);
  assert.match(worker, /kinds:\s*supportedKinds/u);
  assert.match(builtin, /export const supportedKinds/u);
  assert.match(host, /trustedWorkerSupportedKinds/u);
  assert.match(host, /MN_WORKER_ENABLED/u);
  assert.match(host, /MN_WORKER_SUPPORTED_KINDS/u);
  assert.equal(typeof handlers["agent.execution.run"], "function");
  assert.deepEqual(module.supportedKinds, ["system.noop", "agent.execution.run"]);
  assert.match(builtin, /VaultModelSecretStore/u);
  assert.match(builtin, /createKernelAgentTurnHandler/u);
  assert.match(builtin, /configured:\s*true/u);
  assert.match(builtin, /function fixtureHandlers\(\)[\s\S]*"agent\.execution\.run"\s*:/u);
  assert.match(builtin, /fixture 不提供 LLM/u);
});
