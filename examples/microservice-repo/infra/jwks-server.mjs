import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const port = Number.parseInt(process.env.JWKS_PORT ?? "8080", 10);
const issuer = process.env.JWKS_ISSUER ?? `http://127.0.0.1:${port}`;
const audience = process.env.JWKS_AUDIENCE ?? "mn-enterprise";
const keyId = "mn-local-e2e-rs256";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048
});
const jwk = publicKey.export({ format: "jwk" });
const publicJwk = {
  ...jwk,
  alg: "RS256",
  kid: keyId,
  use: "sig"
};

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", kid: keyId, typ: "JWT" });
  const payload = base64url({
    iss: issuer,
    aud: audience,
    sub: claims.sub,
    tenant_id: claims.tenantId,
    project_ids: [claims.projectId],
    principal_type: claims.principalType ?? "human",
    roles: claims.principalType === "worker" ? [] : [claims.role],
    scopes: claims.scopes ?? [],
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    jti: randomUUID()
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
    "base64url"
  );
  return `${signingInput}.${signature}`;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJsonBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createJwksServer() {
  let acceptedTraceSpans = 0;
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      json(response, 200, {
        issuer,
        jwks_uri: `${issuer}/jwks.json`,
        id_token_signing_alg_values_supported: ["RS256"]
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jwks.json") {
      json(response, 200, { keys: [publicJwk] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/otlp/status") {
      json(response, 200, { acceptedTraceSpans });
      return;
    }
    if (request.method === "POST" && url.pathname === "/otlp/v1/traces") {
      try {
        const body = await readJsonBody(request);
        const spans = (body.resourceSpans ?? []).flatMap((resource) =>
          (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? [])
        );
        if (spans.length === 0 || spans.some((span) =>
          !/^[a-f0-9]{32}$/u.test(span.traceId ?? "") ||
          !/^[a-f0-9]{16}$/u.test(span.spanId ?? "")
        )) {
          json(response, 400, { error: "invalid OTLP trace payload" });
          return;
        }
        acceptedTraceSpans += spans.length;
        json(response, 200, { partialSuccess: {} });
      } catch (error) {
        json(response, 400, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const sub = url.searchParams.get("sub") ?? "developer@example.com";
      const tenantId = url.searchParams.get("tenant") ?? "tenant-e2e";
      const projectId = url.searchParams.get("project") ?? "commerce-reservation";
      const role = url.searchParams.get("role") ?? "developer";
      const principalType = url.searchParams.get("principal_type") ?? "human";
      const scopes = (url.searchParams.get("scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      json(response, 200, {
        access_token: token({ sub, tenantId, projectId, role, principalType, scopes }),
        token_type: "Bearer",
        expires_in: 300
      });
      return;
    }
    json(response, 404, { code: "NOT_FOUND" });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createJwksServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`JWKS stub listening on ${port} with issuer ${issuer}`);
  });
}
