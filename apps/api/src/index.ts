import { readFile } from "node:fs/promises";
import type { TrustProfile } from "@mn/governance";
import { buildServer } from "./server.js";
import type { ProviderUsageEvidenceTrustProfile } from "./providerUsageEvidenceTrust.js";
import type { ProviderUsageTerminalJournalIntegrityProfile } from "./providerUsageTerminalJournal.js";

const port = Number(process.env.MN_API_PORT ?? 7318);
const host = process.env.MN_API_HOST ?? "127.0.0.1";
const useMockExecutors = process.env.MN_USE_MOCK_EXECUTORS === "1";
const workspaceRoot = process.env.MN_WORKSPACE_ROOT;
const runtimeProfile = process.env.MN_RUNTIME_PROFILE === "enterprise"
  ? "enterprise"
  : "local";
const issuer = process.env.MN_OIDC_ISSUER;
const audience = process.env.MN_OIDC_AUDIENCE;
const jwksUrl = process.env.MN_OIDC_JWKS_URL;
const auth = issuer && audience && jwksUrl
  ? { issuer, audience, jwksUrl }
  : undefined;
const corsAllowlist = (process.env.MN_CORS_ALLOWLIST ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const enterpriseProjectRoots = (process.env.MN_ENTERPRISE_PROJECT_ROOTS ?? "")
  .split(",")
  .map((root) => root.trim())
  .filter(Boolean);
const postgresUrl = process.env.MN_POSTGRES_URL;
const otlpEndpoint = process.env.MN_OTEL_EXPORTER_OTLP_ENDPOINT;
const standardPackTrustFile = process.env.MN_STANDARD_PACK_TRUST_FILE;
const standardPackTrustProfile = standardPackTrustFile
  ? JSON.parse(await readFile(standardPackTrustFile, "utf8")) as TrustProfile
  : undefined;
const providerUsageEvidenceTrustFile =
  process.env.MN_PROVIDER_USAGE_EVIDENCE_TRUST_FILE;
const providerUsageEvidenceTrustProfile = providerUsageEvidenceTrustFile
  ? JSON.parse(
      await readFile(providerUsageEvidenceTrustFile, "utf8")
    ) as ProviderUsageEvidenceTrustProfile
  : undefined;
const providerUsageJournalIntegrityFile =
  process.env.MN_PROVIDER_USAGE_JOURNAL_INTEGRITY_FILE;
const providerUsageTerminalJournalIntegrityProfile =
  providerUsageJournalIntegrityFile
    ? JSON.parse(
        await readFile(providerUsageJournalIntegrityFile, "utf8")
      ) as ProviderUsageTerminalJournalIntegrityProfile
    : undefined;
const sandboxAttestationKey = process.env.MN_SANDBOX_ATTESTATION_KEY;
const sandboxImageReference = process.env.MN_ENTERPRISE_SANDBOX_IMAGE;
const sandboxImageDigest = process.env.MN_ENTERPRISE_SANDBOX_IMAGE_DIGEST;
const enterpriseSandboxImage = sandboxImageReference && sandboxImageDigest
  ? { reference: sandboxImageReference, digest: sandboxImageDigest }
  : undefined;
const enterpriseProxyPort = Number(process.env.MN_ENTERPRISE_PROXY_PORT ?? 7319);
const enterpriseProxyHost = process.env.MN_ENTERPRISE_PROXY_HOST ?? "0.0.0.0";
const enterpriseProxyPublicBaseUrl = process.env.MN_ENTERPRISE_PROXY_PUBLIC_BASE_URL;

const app = buildServer({
  useMockExecutors,
  workspaceRoot,
  runtimeProfile,
  bindHost: host,
  ...(auth ? { auth } : {}),
  ...(corsAllowlist.length > 0 ? { corsAllowlist } : {}),
  ...(runtimeProfile === "enterprise" && enterpriseProjectRoots.length > 0
    ? { enterpriseProjectRoots }
    : {}),
  ...(runtimeProfile === "enterprise" && postgresUrl
    ? { enterprisePostgres: { connectionString: postgresUrl } }
    : {}),
  ...(runtimeProfile === "enterprise" && otlpEndpoint
    ? {
        telemetry: {
          endpoint: otlpEndpoint,
          serviceName: process.env.MN_OTEL_SERVICE_NAME ?? "mn-api"
        }
      }
    : {}),
  ...(runtimeProfile === "enterprise" && standardPackTrustProfile
    ? { standardPackTrustProfile }
    : {}),
  ...(runtimeProfile === "enterprise" && providerUsageEvidenceTrustProfile
    ? { providerUsageEvidenceTrustProfile }
    : {}),
  ...(runtimeProfile === "enterprise" && providerUsageTerminalJournalIntegrityProfile
    ? { providerUsageTerminalJournalIntegrityProfile }
    : {}),
  ...(runtimeProfile === "enterprise" && sandboxAttestationKey
    ? { sandboxAttestationKey }
    : {}),
  ...(runtimeProfile === "enterprise" && enterpriseSandboxImage
    ? { enterpriseSandboxImage }
    : {}),
  ...(runtimeProfile === "enterprise" && enterpriseProxyPublicBaseUrl
    ? {
        enterpriseProxy: {
          host: enterpriseProxyHost,
          port: enterpriseProxyPort,
          publicBaseUrl: enterpriseProxyPublicBaseUrl
        }
      }
    : {})
});

await app.listen({ port, host });
