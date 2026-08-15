import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { S3CompatibleArtifactStore } from "../src/artifactRemoteStore.js";
import {
  RunScopedCas,
  RunScopedCasIntegrityError
} from "../src/runScopedCas.js";

test("enforced Run-scoped CAS reads S3 bytes and fails closed on missing or tamper", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-run-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    const key = objectKey(request);
    if (request.method === "PUT") {
      objects.set(key, await requestBody(request));
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method === "GET") {
      const content = objects.get(key);
      if (!content) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.end(content);
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  const endpoint = await listen(server);
  t.after(() => close(server));
  const remoteStore = new S3CompatibleArtifactStore({
    endpointUrl: endpoint,
    bucket: "mn-artifacts"
  });
  const cas = new RunScopedCas({
    localRoot: root,
    remoteStore,
    remotePrefix: "enterprise/evidence",
    requireRemote: true
  });
  const content = Buffer.from("server-verified-gate-bytes", "utf8");
  const ref = await cas.put({
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    contentType: "text/plain",
    content
  });
  assert.match(ref.objectKey, /cas\/v1/u);
  assert.deepEqual(await cas.readVerified(ref), content);

  objects.delete(ref.objectKey);
  assert.equal(await cas.readVerified(ref), undefined);

  await cas.put({
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    contentType: "text/plain",
    content
  });
  objects.set(ref.objectKey, Buffer.alloc(content.byteLength, 0x78));
  await assert.rejects(
    cas.readVerified(ref),
    (error: unknown) => error instanceof RunScopedCasIntegrityError && /digest mismatch/u.test(error.message)
  );
});

function objectKey(request: IncomingMessage): string {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const prefix = "/mn-artifacts/";
  assert.ok(pathname.startsWith(prefix));
  return pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}
