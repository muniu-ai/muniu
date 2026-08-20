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
const sandboxDriver = process.env.MN_SANDBOX_RUNTIME_DRIVER ?? "docker";
if (sandboxDriver !== "docker" && sandboxDriver !== "kubernetes") {
  throw new Error("MN_SANDBOX_RUNTIME_DRIVER must be docker or kubernetes");
}
const kubernetesSandbox = sandboxDriver === "kubernetes"
  ? {
      namespace: requiredEnvironment("MN_KUBERNETES_NAMESPACE"),
      sharedVolumeClaimName: requiredEnvironment("MN_KUBERNETES_SHARED_VOLUME_CLAIM"),
      sharedWorkspaceRoot: requiredEnvironment("MN_KUBERNETES_SHARED_ROOT"),
      serviceAccountName: requiredEnvironment("MN_KUBERNETES_CANDIDATE_SERVICE_ACCOUNT"),
      runtimeClassName: requiredEnvironment("MN_KUBERNETES_RUNTIME_CLASS")
    }
  : undefined;
const enterpriseProxyPort = Number(process.env.MN_ENTERPRISE_PROXY_PORT ?? 7319);
const enterpriseProxyHost = process.env.MN_ENTERPRISE_PROXY_HOST ?? "0.0.0.0";
const enterpriseProxyPublicBaseUrl = process.env.MN_ENTERPRISE_PROXY_PUBLIC_BASE_URL;
const enterpriseBuiltinInstanceId = process.env.MN_API_INSTANCE_ID;

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
  ...(runtimeProfile === "enterprise" && enterpriseBuiltinInstanceId
    ? { enterpriseBuiltinInstanceId }
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
  ...(runtimeProfile === "enterprise" && kubernetesSandbox
    ? { kubernetesSandbox }
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

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (error) => {
        console.error(error);
        process.exit(1);
      }
    );
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value?.trim() || value !== value.trim() || /[\0\r\n]/u.test(value)) {
    throw new Error(`${name} is required for the Kubernetes sandbox runtime`);
  }
  return value;
}
