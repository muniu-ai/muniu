// SPDX-License-Identifier: Apache-2.0

import { Pool } from "pg";

import {
  S3CompatibleArtifactStore,
  s3CredentialsFromEnvironment,
  s3RegionFromEnvironment
} from "./artifactRemoteStore.js";
import {
  EnterpriseAgentV3MigrationJob,
  PostgresS3AgentV3MigrationBackend
} from "./enterpriseAgentV3Migration.js";

type MigrationMode = "dry-run" | "apply" | "rollback";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the app-server V3 migration`);
  return value;
}

function migrationMode(): MigrationMode {
  const value = process.env.MN_APP_SERVER_V3_MIGRATION_MODE?.trim() || "dry-run";
  if (value !== "dry-run" && value !== "apply" && value !== "rollback") {
    throw new Error("MN_APP_SERVER_V3_MIGRATION_MODE must be dry-run, apply or rollback");
  }
  return value;
}

function requestTimeout(): number | undefined {
  const raw = process.env.MN_ARTIFACT_S3_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("MN_ARTIFACT_S3_REQUEST_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

const pool = new Pool({
  connectionString: requiredEnvironment("MN_POSTGRES_URL"),
  application_name: "mn-app-server-v3-migrate",
  max: 1
});

try {
  const objectStore = new S3CompatibleArtifactStore({
    endpointUrl: requiredEnvironment("MN_ARTIFACT_REMOTE_STORE_ENDPOINT_URL"),
    bucket: requiredEnvironment("MN_ARTIFACT_REMOTE_STORE_BUCKET"),
    region: s3RegionFromEnvironment(),
    credentials: s3CredentialsFromEnvironment(),
    requestTimeoutMs: requestTimeout()
  });
  const job = new EnterpriseAgentV3MigrationJob(new PostgresS3AgentV3MigrationBackend({
    pool,
    objectStore,
    objectPrefix: process.env.MN_ARTIFACT_REMOTE_STORE_PREFIX,
    kmsKeyId: process.env.MN_AGENT_SESSION_KMS_KEY_ID
  }));
  const mode = migrationMode();
  const result = mode === "apply"
    ? await job.apply()
    : mode === "rollback" ? await job.rollback() : await job.inspect();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
