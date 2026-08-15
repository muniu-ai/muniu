import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(workspaceRoot, "examples/microservice-repo");
const composeFile = join(workspaceRoot, "docker-compose.enterprise.yml");
const args = new Set(process.argv.slice(2));
const withCompose = args.has("--with-compose");
const keepCompose = args.has("--keep-compose");
const runApiFlow = args.has("--api-flow");
const rebuild = args.has("--rebuild") || process.env.MN_ENTERPRISE_E2E_REBUILD === "1";
const knownArgs = new Set(["--with-compose", "--keep-compose", "--api-flow", "--rebuild"]);

for (const argument of args) {
  if (!knownArgs.has(argument)) throw new Error(`Unknown argument: ${argument}`);
}
if (keepCompose && !withCompose) throw new Error("--keep-compose requires --with-compose");
if (runApiFlow && !withCompose) throw new Error("--api-flow requires --with-compose");

function step(message) {
  console.log(`\n[enterprise-e2e] ${message}`);
}

async function command(executable, commandArgs, options = {}) {
  const capture = options.capture === true;
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, commandArgs, {
      cwd: options.cwd ?? workspaceRoot,
      env: { ...process.env, ...options.env },
      shell: options.shell === true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      rejectCommand(
        new Error(
          `${executable} ${commandArgs.join(" ")} failed (${signal ?? code})${
            detail ? `: ${detail}` : ""
          }`
        )
      );
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function ensureMnRuntime() {
  const required = [
    "packages/specs/dist/index.js",
    "packages/governance/dist/index.js",
    "packages/loop/dist/index.js",
    "packages/evidence/dist/index.js",
    "packages/connectors/dist/index.js",
    "apps/worker/dist/index.js",
    "apps/api/dist/index.js"
  ].map((path) => join(workspaceRoot, path));
  if (rebuild || !(await Promise.all(required.map(exists))).every(Boolean)) {
    step("building mn runtime packages");
    await command("npm", ["run", "build"]);
  }
}

function moduleUrl(relativePath) {
  return `${pathToFileURL(join(workspaceRoot, relativePath)).href}?e2e=${Date.now()}`;
}

async function runFixtureTests() {
  step("running the two service suites and the cross-service acceptance test");
  await command("npm", ["test", "--prefix", fixtureRoot]);
}

async function verifyGovernedAssets(runtime) {
  step("verifying approved Spec, signed StandardPack, lock, architecture and positive Gates");
  const specPath = join(fixtureRoot, "specs/order-reservation/spec.yaml");
  const spec = runtime.specs.parseNativeSpecYaml(await readFile(specPath, "utf8"));
  assert.equal(spec.status, "approved");
  assert.equal(spec.targetServices.length, 2);
  assert.match(spec.digest, /^[a-f0-9]{64}$/u);

  const pack = await readJson(
    join(fixtureRoot, "standards/enterprise-standard-pack.json")
  );
  const trust = await readJson(join(fixtureRoot, "standards/trust-profile.json"));
  const lock = await readJson(join(fixtureRoot, ".mn/standards.lock"));
  const packValidation = runtime.governance.validateStandardPack(pack);
  assert.equal(packValidation.valid, true, JSON.stringify(packValidation.issues));
  const packDigest = runtime.governance.hashStandardPackManifest(pack);
  assert.equal(lock.packs[0].digest, packDigest);
  assert.deepEqual(runtime.governance.validatePackLock(lock), []);
  const syncPlan = runtime.governance.planStandardPackSync(
    [],
    {
      schemaVersion: 1,
      entries: [
        {
          manifest: pack,
          digest: packDigest,
          scope: "organization",
          scopeId: "commerce",
          source: "fixture://enterprise-microservices@1.0.0"
        }
      ],
      publicKeys: trust.trustedPublicKeys
    },
    trust,
    true
  );
  assert.equal(syncPlan.valid, true, JSON.stringify(syncPlan.issues));
  assert.equal(syncPlan.entries[0].signatureVerified, true);

  const architecture = await runtime.connectors.indexArchitectureRepository(fixtureRoot);
  assert.deepEqual(
    architecture.services.map((service) => service.id),
    ["inventory", "orders"]
  );
  assert.equal(architecture.issues.length, 0, JSON.stringify(architecture.issues));
  const impact = runtime.connectors.analyzeSpecImpact(architecture, spec);
  assert.deepEqual(impact.impactedServices, ["inventory", "orders"]);
  assert.equal(impact.overallLevel, "L4");
  assert.ok(impact.requiredGates.includes("contract"));
  assert.ok(impact.requiredGates.includes("migration_safety"));
  assert.ok(impact.requiredApprovals.includes("cross_service_owner"));
  assert.deepEqual(
    impact.trace.acceptanceCaseIds,
    spec.acceptanceCases.map((acceptance) => acceptance.id).sort()
  );

  const contractDocuments = await Promise.all([
    ["openapi", "services/orders/openapi.yaml"],
    ["asyncapi", "services/orders/events.asyncapi.yaml"],
    ["openapi", "services/inventory/openapi.yaml"]
  ].map(async ([type, path]) => ({
    type,
    path,
    content: await readFile(join(fixtureRoot, path), "utf8")
  })));
  const acceptanceIds = spec.acceptanceCases.map((acceptance) => acceptance.id);
  const positivePlans = [
    { id: "spec_schema", facts: { spec } },
    { id: "spec_approval", facts: { spec } },
    {
      id: "acceptance_coverage",
      specClauseIds: acceptanceIds,
      facts: { spec, coveredSpecClauseIds: acceptanceIds }
    },
    { id: "contract", facts: { spec, contractDocuments } },
    {
      id: "migration_safety",
      facts: {
        changedPaths: [
          "services/orders/migrations/001_create_orders.up.sql",
          "services/inventory/migrations/001_create_inventory.up.sql"
        ],
        rollbackPaths: [
          "services/orders/migrations/001_create_orders.down.sql",
          "services/inventory/migrations/001_create_inventory.down.sql"
        ]
      }
    },
    {
      id: "protected_path",
      facts: {
        changedPaths: [
          "services/orders/src/server.mjs",
          "services/inventory/src/server.mjs"
        ],
        protectedPaths: pack.rules.protectedPaths
      }
    },
    {
      id: "diff_scope",
      facts: {
        changedPaths: [
          "services/orders/src/server.mjs",
          "services/inventory/src/server.mjs"
        ],
        allowedPaths: ["services/orders/**", "services/inventory/**"]
      }
    }
  ].map((plan) => ({
    required: true,
    language: "javascript",
    ...plan
  }));
  const gateResults = await runtime.worker.runGateEngineV2({
    cwd: fixtureRoot,
    gates: positivePlans,
    registry: runtime.worker.createDefaultGateRegistry(),
    runId: "enterprise-fixture-positive",
    candidateId: "approved-increment",
    failClosed: true
  });
  assert.ok(
    gateResults.every((result) => result.status === "pass"),
    JSON.stringify(gateResults.map(({ gateId, status, summary }) => ({ gateId, status, summary })))
  );
  return { spec, pack, packDigest, architecture, impact, gateResults };
}

async function runGate(runtime, cwd, gateId, facts) {
  const [result] = await runtime.worker.runGateEngineV2({
    cwd,
    gates: [{ id: gateId, required: true, language: "javascript", facts }],
    registry: runtime.worker.createDefaultGateRegistry(),
    runId: `enterprise-negative-${gateId}`,
    candidateId: "must-fail",
    failClosed: true
  });
  assert.ok(result);
  return result;
}

async function verifyNegativeFixtures(runtime, positive) {
  step("verifying contract, ownership, rollback and protected-path negatives fail closed");
  const negativeRoot = join(fixtureRoot, "negative");

  const contractRoot = join(negativeRoot, "contract-breaking");
  const contractCase = await readJson(join(contractRoot, "case.json"));
  const contract = await runGate(runtime, contractRoot, contractCase.gate, {
    spec: positive.spec,
    contractDocuments: [
      {
        type: contractCase.type,
        path: contractCase.current,
        content: await readFile(join(contractRoot, contractCase.current), "utf8"),
        previousContent: await readFile(join(contractRoot, contractCase.previous), "utf8")
      }
    ]
  });
  assert.equal(contract.status, contractCase.expectedStatus);

  const sharedRoot = join(negativeRoot, "shared-data-ownership");
  const shared = await runtime.connectors.indexArchitectureRepository(sharedRoot);
  assert.ok(
    shared.issues.some(
      (issue) => issue.code === "SHARED_DATABASE" && issue.level === "L4"
    )
  );

  const rollbackRoot = join(negativeRoot, "no-rollback");
  const noRollbackArchitecture = await runtime.connectors.indexArchitectureRepository(
    rollbackRoot
  );
  assert.ok(
    noRollbackArchitecture.issues.some(
      (issue) => issue.code === "MISSING_ROLLBACK" && issue.level === "L4"
    )
  );
  const migration = await runGate(runtime, rollbackRoot, "migration_safety", {
    changedPaths: ["services/catalog/migrations/001_add_price.up.sql"],
    rollbackPaths: []
  });
  assert.equal(migration.status, "fail");

  const protectedRoot = join(negativeRoot, "protected-path");
  const protectedCase = await readJson(join(protectedRoot, "case.json"));
  const protectedResult = await runGate(
    runtime,
    protectedRoot,
    protectedCase.gate,
    protectedCase
  );
  assert.equal(protectedResult.status, protectedCase.expectedStatus);

  return {
    contract: contract.status,
    sharedDataOwnership: "SHARED_DATABASE",
    noRollback: migration.status,
    protectedPath: protectedResult.status
  };
}

const composeArgs = [
  "compose",
  "-f",
  composeFile,
  "--project-name",
  "mn-enterprise-e2e"
];

async function verifyComposeDependencies() {
  step("starting PostgreSQL, MinIO and the local JWKS stub");
  await command("docker", [
    ...composeArgs,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "120",
    "postgres",
    "minio",
    "jwks"
  ]);
  await command("docker", [...composeArgs, "run", "--rm", "minio-init"]);
  await command("docker", [
    ...composeArgs,
    "exec",
    "-T",
    "postgres",
    "pg_isready",
    "-U",
    "mn",
    "-d",
    "mn_enterprise"
  ]);
  const minio = await fetch("http://127.0.0.1:59000/minio/health/ready");
  assert.equal(minio.ok, true, `MinIO readiness returned ${minio.status}`);
  const discovery = await fetch(
    "http://127.0.0.1:59080/.well-known/openid-configuration"
  ).then((response) => response.json());
  assert.equal(discovery.issuer, "http://jwks:8080");
  const issued = await fetch(
    "http://127.0.0.1:59080/token?role=project_owner&tenant=tenant-e2e",
    { method: "POST" }
  ).then((response) => response.json());
  assert.match(issued.access_token, /^[^.]+\.[^.]+\.[^.]+$/u);
  return { postgres: "healthy", minio: "healthy", jwks: "healthy" };
}

async function cleanupCompose() {
  step("cleaning enterprise dependency containers and volumes");
  await command("docker", [...composeArgs, "down", "-v", "--remove-orphans"]);
}

async function executeApiFlowHook() {
  const hook = process.env.MN_ENTERPRISE_API_E2E_COMMAND;
  const env = {
      MN_RUNTIME_PROFILE: "enterprise",
      MN_API_HOST: "0.0.0.0",
      MN_API_PORT: "17318",
      MN_ENTERPRISE_PROXY_HOST: "127.0.0.1",
      MN_ENTERPRISE_PROXY_PORT: "17319",
      MN_ENTERPRISE_PROXY_PUBLIC_BASE_URL: "http://127.0.0.1:17319",
      MN_USE_MOCK_EXECUTORS: "1",
      MN_POSTGRES_URL:
        "postgresql://mn:mn-e2e-only@127.0.0.1:55432/mn_enterprise",
      MN_TEST_POSTGRES_URL:
        "postgresql://mn:mn-e2e-only@127.0.0.1:55432/mn_enterprise",
      MN_OIDC_ISSUER: "http://jwks:8080",
      MN_OIDC_AUDIENCE: "mn-enterprise",
      MN_OIDC_JWKS_URL: "http://127.0.0.1:59080/jwks.json",
      MN_CORS_ALLOWLIST: "http://127.0.0.1:4173",
      MN_ENTERPRISE_PROJECT_ROOTS: fixtureRoot,
      MN_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:59080/otlp",
      MN_OTEL_SERVICE_NAME: "mn-api-enterprise-e2e",
      MN_STANDARD_PACK_TRUST_FILE: join(
        fixtureRoot,
        "standards/trust-profile.json"
      ),
      MN_SANDBOX_ATTESTATION_KEY:
        "mn-enterprise-e2e-sandbox-attestation-key-v1-only",
      MN_ARTIFACT_REMOTE_STORE_TYPE: "s3",
      MN_ARTIFACT_REMOTE_STORE_BUCKET: "mn-artifacts",
      MN_ARTIFACT_REMOTE_STORE_PREFIX: "enterprise-e2e",
      MN_ARTIFACT_REMOTE_STORE_ENDPOINT_URL: "http://127.0.0.1:59000",
      MN_ARTIFACT_S3_ACCESS_KEY_ID: "mn-e2e",
      MN_ARTIFACT_S3_SECRET_ACCESS_KEY: "mn-e2e-secret-only",
      MN_ARTIFACT_S3_REGION: "us-east-1",
      MN_ARTIFACT_S3_REQUEST_TIMEOUT_MS: "10000",
      MN_ENTERPRISE_POSTGRES_URL:
        "postgresql://mn:mn-e2e-only@127.0.0.1:55432/mn_enterprise",
      MN_ENTERPRISE_S3_ENDPOINT: "http://127.0.0.1:59000",
      MN_ENTERPRISE_S3_BUCKET: "mn-artifacts",
      MN_ENTERPRISE_JWKS_URL: "http://127.0.0.1:59080/jwks.json",
      MN_ENTERPRISE_TOKEN_URL: "http://127.0.0.1:59080/token",
      MN_ENTERPRISE_CORS_ORIGIN: "http://127.0.0.1:4173"
  };
  if (hook) {
    step("running the configured API enterprise-flow override");
    await command(hook, [], { shell: true, env });
    return;
  }
  step("running the built-in API enterprise flow");
  await command(process.execPath, [join(workspaceRoot, "scripts/enterprise-api-flow.mjs")], {
    env
  });
}

let composeAttempted = false;
try {
  await ensureMnRuntime();
  const runtime = {
    specs: await import(moduleUrl("packages/specs/dist/index.js")),
    governance: await import(moduleUrl("packages/governance/dist/index.js")),
    connectors: await import(moduleUrl("packages/connectors/dist/index.js")),
    worker: await import(moduleUrl("apps/worker/dist/index.js"))
  };
  await runFixtureTests();
  const positive = await verifyGovernedAssets(runtime);
  const negative = await verifyNegativeFixtures(runtime, positive);
  let dependencies = { postgres: "not-requested", minio: "not-requested", jwks: "not-requested" };
  if (withCompose) {
    await command("docker", ["compose", "version"], { capture: true });
    await command("docker", ["info"], { capture: true });
    composeAttempted = true;
    dependencies = await verifyComposeDependencies();
  }
  if (runApiFlow) await executeApiFlowHook();
  const verificationStatus = runApiFlow
    ? "locally_verified"
    : withCompose
      ? "enterprise_dependencies_verified"
      : "fixture_verified";
  step(verificationStatus);
  console.log(
    JSON.stringify(
      {
        status: verificationStatus,
        services: positive.architecture.services.map((service) => service.id),
        specDigest: positive.spec.digest,
        governanceDigest: positive.packDigest,
        governanceKeyId: positive.pack.signature.keyId,
        positiveGates: positive.gateResults.map((result) => result.gateId),
        negative,
        dependencies,
        apiFlow: runApiFlow
          ? process.env.MN_ENTERPRISE_API_E2E_COMMAND
            ? "verified-by-override"
            : "verified-by-default-flow"
          : "default-flow-ready"
      },
      null,
      2
    )
  );
} finally {
  if (composeAttempted && !keepCompose) {
    await cleanupCompose().catch((error) => {
      console.warn(`[enterprise-e2e] cleanup warning: ${error.message}`);
    });
  }
}
