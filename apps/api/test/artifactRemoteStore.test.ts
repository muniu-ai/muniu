import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server
} from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  S3ArtifactStoreError,
  S3CompatibleArtifactStore,
  s3CredentialsFromEnvironment,
  s3RegionFromEnvironment
} from "../src/artifactRemoteStore.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

test("S3 artifact store performs signed MinIO-compatible object operations", async (t) => {
  const requests: CapturedRequest[] = [];
  const objects = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    const captured = await captureRequest(request);
    requests.push(captured);
    const requestUrl = new URL(captured.url, "http://localhost");
    const key = decodeObjectKey(requestUrl.pathname, "/proxy/mn-artifacts/");

    if (captured.method === "PUT") {
      objects.set(key, captured.body);
      response.setHeader("etag", '"artifact-etag"');
      response.setHeader("x-amz-version-id", "version-1");
      response.statusCode = 200;
      response.end();
      return;
    }
    if (captured.method === "HEAD") {
      const content = objects.get(key);
      if (!content) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-length", String(content.byteLength));
      response.setHeader("content-type", "application/json");
      response.setHeader("etag", '"artifact-etag"');
      response.setHeader("last-modified", "Sat, 11 Jul 2026 10:00:00 GMT");
      response.setHeader("x-amz-meta-trace-id", "trace-1");
      response.setHeader("x-amz-version-id", "version-1");
      response.statusCode = 200;
      response.end();
      return;
    }
    if (captured.method === "GET") {
      const content = objects.get(key);
      if (!content) {
        response.statusCode = 404;
        response.end("missing");
        return;
      }
      response.statusCode = 200;
      response.end(content);
      return;
    }
    if (captured.method === "DELETE") {
      objects.delete(key);
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  const endpoint = await listen(server);
  t.after(() => close(server));

  const credentials = {
    accessKeyId: "minio-user",
    secretAccessKey: "minio-secret",
    sessionToken: "session-token"
  };
  const store = new S3CompatibleArtifactStore({
    endpointUrl: `${endpoint}/proxy/`,
    bucket: "mn-artifacts",
    region: "us-east-1",
    credentials
  });
  const body = Buffer.from('{"ok":true}\n', "utf8");
  const key = "team space/run+1/artifact.json";

  const stored = await store.putObject(key, body, {
    contentType: "application/json",
    metadata: { "trace-id": "trace-1" },
    ifNoneMatch: "*"
  });
  assert.deepEqual(stored, {
    key,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    etag: '"artifact-etag"',
    versionId: "version-1"
  });
  assert.deepEqual(await store.getObject(key), body);
  assert.deepEqual(await store.headObject(key), {
    key,
    bytes: body.byteLength,
    metadata: { "trace-id": "trace-1" },
    etag: '"artifact-etag"',
    lastModified: "Sat, 11 Jul 2026 10:00:00 GMT",
    contentType: "application/json",
    versionId: "version-1"
  });
  await store.deleteObject(key);
  assert.equal(await store.getObject(key), undefined);

  assert.equal(requests[0]?.url, "/proxy/mn-artifacts/team%20space/run%2B1/artifact.json");
  assert.equal(requests[0]?.headers["x-amz-security-token"], credentials.sessionToken);
  assert.equal(requests[0]?.headers["x-amz-meta-trace-id"], "trace-1");
  assert.equal(requests[0]?.headers["if-none-match"], "*");
  for (const request of requests) verifySignatureV4(request, credentials.secretAccessKey);
});

test("S3 artifact store lists paginated objects and deletes only a non-empty prefix", async (t) => {
  const requests: CapturedRequest[] = [];
  const deleted: string[] = [];
  const server = createServer(async (request, response) => {
    const captured = await captureRequest(request);
    requests.push(captured);
    const requestUrl = new URL(captured.url, "http://localhost");

    if (captured.method === "GET" && requestUrl.searchParams.get("list-type") === "2") {
      response.setHeader("content-type", "application/xml");
      if (!requestUrl.searchParams.has("continuation-token")) {
        response.end(`<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <IsTruncated>true</IsTruncated>
            <NextContinuationToken>next&amp;token</NextContinuationToken>
            <Contents>
              <Key>team%2Fone%20file.txt</Key><Size>3</Size>
              <ETag>&quot;e1&quot;</ETag><LastModified>2026-07-11T10:00:00.000Z</LastModified>
            </Contents>
            <Contents><Key>team%2Fsecond%26file.txt</Key><Size>4</Size></Contents>
          </ListBucketResult>`);
        return;
      }
      assert.equal(requestUrl.searchParams.get("continuation-token"), "next&token");
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <Contents><Key>team%2Fthird.txt</Key><Size>5</Size></Contents>
        </ListBucketResult>`);
      return;
    }

    if (captured.method === "DELETE") {
      deleted.push(decodeObjectKey(requestUrl.pathname, "/mn-artifacts/"));
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  const endpoint = await listen(server);
  t.after(() => close(server));
  const store = new S3CompatibleArtifactStore({
    endpointUrl: endpoint,
    bucket: "mn-artifacts"
  });

  assert.deepEqual(await store.listObjects("team"), [
    {
      key: "team/one file.txt",
      bytes: 3,
      etag: '"e1"',
      lastModified: "2026-07-11T10:00:00.000Z"
    },
    { key: "team/second&file.txt", bytes: 4 },
    { key: "team/third.txt", bytes: 5 }
  ]);
  assert.equal(await store.deletePrefix("team/"), 3);
  assert.deepEqual(deleted, [
    "team/one file.txt",
    "team/second&file.txt",
    "team/third.txt"
  ]);
  await assert.rejects(store.deletePrefix(""), /Refusing to delete an empty/u);

  const anonymousRequest = requests.at(0);
  assert.ok(anonymousRequest);
  assert.equal(anonymousRequest.headers.authorization, undefined);
  assert.match(String(anonymousRequest.headers["x-amz-content-sha256"]), /^[a-f0-9]{64}$/u);
  assert.match(anonymousRequest.url, /encoding-type=url&list-type=2&prefix=team/u);
});

test("S3 artifact store fails closed on unsafe configuration, keys and remote errors", async (t) => {
  assert.throws(
    () => new S3CompatibleArtifactStore({ endpointUrl: "ftp://minio", bucket: "artifacts" }),
    /must use http or https/u
  );
  assert.throws(
    () => new S3CompatibleArtifactStore({
      endpointUrl: "https://user:password@minio.example",
      bucket: "artifacts"
    }),
    /cannot contain credentials/u
  );
  assert.throws(
    () => new S3CompatibleArtifactStore({
      endpointUrl: "https://minio.example",
      bucket: "artifacts",
      credentials: { accessKeyId: "only-key", secretAccessKey: "" }
    }),
    /both access key ID and secret access key/u
  );
  assert.throws(
    () => new S3CompatibleArtifactStore({ endpointUrl: "https://minio.example", bucket: "Bad_Bucket" }),
    /DNS-compatible bucket/u
  );

  const server = createServer(async (request, response) => {
    await captureRequest(request);
    response.statusCode = 403;
    response.setHeader("x-amz-request-id", "request-1");
    response.end(
      "<Error><Code>AccessDenied</Code><Message>do-not-leak-this-detail</Message></Error>"
    );
  });
  const endpoint = await listen(server);
  t.after(() => close(server));
  const store = new S3CompatibleArtifactStore({ endpointUrl: endpoint, bucket: "artifacts" });

  await assert.rejects(
    store.getObject("team/denied.txt"),
    (error: unknown) => {
      assert.ok(error instanceof S3ArtifactStoreError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.s3Code, "AccessDenied");
      assert.equal(error.requestId, "request-1");
      assert.doesNotMatch(error.message, /do-not-leak/u);
      return true;
    }
  );
  await assert.rejects(store.getObject("../escape"), /unsafe path segment/u);
  await assert.rejects(store.putObject("/absolute", "x"), /object key is invalid/u);
});

test("S3 artifact environment helpers prefer mn-specific credentials and reject partial secrets", () => {
  assert.deepEqual(
    s3CredentialsFromEnvironment({
      MN_ARTIFACT_S3_ACCESS_KEY_ID: "mn-key",
      MN_ARTIFACT_S3_SECRET_ACCESS_KEY: "mn-secret",
      MN_ARTIFACT_S3_SESSION_TOKEN: "mn-token",
      AWS_ACCESS_KEY_ID: "aws-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret"
    }),
    { accessKeyId: "mn-key", secretAccessKey: "mn-secret", sessionToken: "mn-token" }
  );
  assert.equal(s3CredentialsFromEnvironment({}), undefined);
  assert.throws(
    () => s3CredentialsFromEnvironment({ MN_ARTIFACT_S3_ACCESS_KEY_ID: "partial" }),
    /both access key ID and secret access key/u
  );
  assert.equal(s3RegionFromEnvironment({ MN_ARTIFACT_S3_REGION: "cn-north-1" }), "cn-north-1");
  assert.equal(s3RegionFromEnvironment({}), "us-east-1");
});

test("API keeps its compatibility mirror while persisting, recovering and cleaning real S3 objects", async (t) => {
  const objects = new Map<string, Buffer>();
  const s3Server = createServer(async (request, response) => {
    const captured = await captureRequest(request);
    const requestUrl = new URL(captured.url, "http://localhost");
    if (captured.method === "GET" && requestUrl.searchParams.get("list-type") === "2") {
      const prefix = requestUrl.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, content]) =>
          `<Contents><Key>${encodeURIComponent(key)}</Key><Size>${content.byteLength}</Size></Contents>`
        )
        .join("");
      response.setHeader("content-type", "application/xml");
      response.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      return;
    }
    const key = decodeObjectKey(requestUrl.pathname, "/mn-artifacts/");
    if (captured.method === "PUT") {
      objects.set(key, captured.body);
      response.statusCode = 200;
      response.end();
      return;
    }
    if (captured.method === "GET") {
      const content = objects.get(key);
      response.statusCode = content ? 200 : 404;
      response.end(content);
      return;
    }
    if (captured.method === "DELETE") {
      objects.delete(key);
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  const endpoint = await listen(s3Server);
  const mniuRoot = await mkdtemp(join(tmpdir(), "mn-api-real-s3-local-"));
  const mirrorRoot = await mkdtemp(join(tmpdir(), "mn-api-real-s3-mirror-"));
  const store = new MemoryStore();
  const runId = "run-real-s3";
  store.runs.set(runId, {
    id: runId,
    taskId: "task-real-s3",
    projectId: "project-real-s3",
    status: "completed",
    candidates: [
      {
        id: "codex-1",
        runId,
        provider: "codex",
        worktreePath: "/tmp/worktree",
        status: "completed",
        result: {
          provider: "codex",
          candidateId: "codex-1",
          status: "completed",
          exitCode: 0,
          stdout: "real S3 payload",
          stderr: "",
          summary: "done",
          artifacts: [],
          startedAt: "2026-07-11T10:00:00.000Z",
          finishedAt: "2026-07-11T10:00:01.000Z"
        },
        gates: []
      }
    ],
    gates: [],
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:01.000Z"
  });
  const app = buildServer({
    store,
    mniuRoot,
    useMockExecutors: true,
    artifactRemoteStore: {
      type: "s3",
      rootDir: mirrorRoot,
      bucket: "mn-artifacts",
      prefix: "team/dev",
      endpointUrl: endpoint,
      credentials: { accessKeyId: "minio-user", secretAccessKey: "minio-secret" }
    }
  });
  t.after(async () => {
    await app.close();
    await close(s3Server);
    await rm(mniuRoot, { recursive: true, force: true });
    await rm(mirrorRoot, { recursive: true, force: true });
  });

  const artifactsResponse = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/artifacts`
  });
  assert.equal(artifactsResponse.statusCode, 200);
  const stdout = artifactsResponse.json().artifacts.find(
    (artifact: { id: string }) => artifact.id === "codex-1:stdout"
  ) as { remote: { key: string } };
  assert.ok(stdout.remote.key);
  assert.equal(objects.get(stdout.remote.key)?.toString("utf8"), "real S3 payload");
  assert.equal(objects.has(`team/dev/runs/${runId}/index.json`), true);

  const index = JSON.parse(
    await readFile(join(mniuRoot, "artifacts", "runs", runId, "index.json"), "utf8")
  ) as { artifacts: Array<{ artifactId: string; fileName: string; remote: { key: string } }> };
  const stdoutEntry = index.artifacts.find((entry) => entry.artifactId === "codex-1:stdout");
  assert.ok(stdoutEntry);
  await rm(
    join(mniuRoot, "artifacts", "runs", runId, "files", stdoutEntry.fileName),
    { force: true }
  );
  await rm(join(mirrorRoot, "mn-artifacts", stdoutEntry.remote.key), { force: true });
  const persistedRun = store.runs.get(runId);
  assert.ok(persistedRun);
  store.runs.set(runId, {
    ...persistedRun,
    candidates: persistedRun.candidates.map((candidate) =>
      candidate.id === "codex-1" && candidate.result
        ? { ...candidate, result: { ...candidate.result, stdout: "" } }
        : candidate
    )
  });

  const recovered = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/artifacts/${encodeURIComponent("codex-1:stdout")}`
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body, "real S3 payload");

  const cleanup = await app.inject({
    method: "POST",
    url: "/v1/artifacts/store/cleanup",
    payload: { dryRun: false, keepLatestRuns: 0, scope: "remote" }
  });
  assert.equal(cleanup.statusCode, 200);
  assert.equal(cleanup.json().deleted.length, 1);
  assert.equal(objects.size, 0);
  await assert.rejects(
    readFile(join(mirrorRoot, "mn-artifacts", "team", "dev", "runs", runId, "index.json"))
  );
});

async function captureRequest(request: IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    method: request.method ?? "",
    url: request.url ?? "",
    headers: request.headers,
    body: Buffer.concat(chunks)
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function decodeObjectKey(pathname: string, prefix: string): string {
  assert.equal(pathname.startsWith(prefix), true, `${pathname} should start with ${prefix}`);
  return pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
}

function verifySignatureV4(request: CapturedRequest, secretAccessKey: string): void {
  const authorization = String(request.headers.authorization ?? "");
  const match = authorization.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u
  );
  assert.ok(match, `invalid authorization header: ${authorization}`);
  const [, , dateStamp, region, signedHeaderString, actualSignature] = match;
  assert.ok(dateStamp && region && signedHeaderString && actualSignature);
  const signedHeaders = signedHeaderString.split(";");
  const canonicalHeaders = `${signedHeaders.map((name) => {
    const value = request.headers[name];
    assert.notEqual(value, undefined, `missing signed header ${name}`);
    return `${name}:${String(value).trim().replace(/\s+/gu, " ")}`;
  }).join("\n")}\n`;
  const url = new URL(request.url, `http://${request.headers.host}`);
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const payloadHash = String(request.headers["x-amz-content-sha256"]);
  assert.equal(payloadHash, createHash("sha256").update(request.body).digest("hex"));
  const canonicalRequest = [
    request.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderString,
    payloadHash
  ].join("\n");
  const amzDate = String(request.headers["x-amz-date"]);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  assert.equal(hmac(signingKey, stringToSign).toString("hex"), actualSignature);
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}
