// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transformer } from "@napi-rs/image";

import { S3ArtifactStoreError } from "../src/artifactRemoteStore.js";
import {
  AgentAttachmentIntegrityError,
  EnterpriseAgentObjectStore,
  LocalAgentAttachmentStore,
  type AgentAttachmentDescriptorV1
} from "../src/agentAttachmentStore.js";

async function png(width = 2, height = 2): Promise<Buffer> {
  return image("png", width, height);
}

async function image(format: "jpeg" | "png" | "webp", width = 2, height = 2): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    pixels[offset] = 10;
    pixels[offset + 1] = 20;
    pixels[offset + 2] = 30;
    pixels[offset + 3] = 255;
  }
  const transformer = Transformer.fromRgbaPixels(pixels, width, height);
  if (format === "jpeg") return transformer.jpeg();
  if (format === "webp") return transformer.webpLossless();
  return transformer.png();
}

test("local attachment store validates and reads immutable content-addressed images", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalAgentAttachmentStore({ rootDir: root });
  const bytes = await png();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptor = await store.put({
    sessionId: "safe-session",
    contentType: "image/png",
    bytes,
    claimedSha256: sha256,
    claimedByteLength: bytes.byteLength
  });

  assert.equal(descriptor.contentType, "image/png");
  assert.equal(descriptor.sha256, sha256);
  assert.equal(descriptor.byteLength, bytes.byteLength);
  assert.equal(descriptor.width, 2);
  assert.equal(descriptor.height, 2);
  assert.match(descriptor.attachmentId, /^attachment-[wxyz]{64}$/u);
  assert.equal(JSON.stringify(descriptor).includes(bytes.toString("base64")), false);
  assert.deepEqual(await store.get({ sessionId: "safe-session", descriptor }), bytes);

  const objectPath = store.objectPathForTest(sha256);
  assert.equal((await lstat(objectPath)).mode & 0o777, 0o600);
  assert.equal(objectPath.includes("safe-session"), false);
  assert.deepEqual(await readFile(objectPath), bytes);

  const duplicate = await store.put({
    sessionId: "another-session",
    contentType: "image/png",
    bytes
  });
  assert.equal(duplicate.sha256, descriptor.sha256);
  assert.notEqual(duplicate.attachmentId, descriptor.attachmentId);

  for (const [contentType, format] of [
    ["image/jpeg", "jpeg"],
    ["image/webp", "webp"]
  ] as const) {
    const encoded = await image(format);
    const stored = await store.put({ sessionId: "safe-session", contentType, bytes: encoded });
    assert.equal(stored.contentType, contentType);
    assert.equal(stored.width, 2);
    assert.equal(stored.height, 2);
  }
});

test("local attachment store fails closed on MIME, digest, decode, size, and object mismatches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-attachment-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalAgentAttachmentStore({ rootDir: root });
  const bytes = await png();

  await assert.rejects(store.put({
    sessionId: "reject-session",
    contentType: "image/jpeg",
    bytes
  }), /content type|format/i);
  await assert.rejects(store.put({
    sessionId: "reject-session",
    contentType: "image/png",
    bytes,
    claimedSha256: "0".repeat(64)
  }), /digest/i);
  await assert.rejects(store.put({
    sessionId: "reject-session",
    contentType: "image/png",
    bytes,
    claimedByteLength: bytes.byteLength + 1
  }), /length/i);
  await assert.rejects(store.put({
    sessionId: "reject-session",
    contentType: "image/png",
    bytes: bytes.subarray(0, 20)
  }), /decode|image/i);
  await assert.rejects(store.put({
    sessionId: "reject-session",
    contentType: "image/webp",
    bytes: Buffer.from("524946460e00000057454250414e494d00000000", "hex")
  }), /animated/i);
  await assert.rejects(store.put({
    sessionId: "reject-session",
    contentType: "image/png",
    bytes: await png(2001, 1)
  }), /dimension/i);
  await assert.rejects(new LocalAgentAttachmentStore({
    rootDir: root,
    limits: { maxImageBytes: bytes.byteLength - 1 }
  }).put({
    sessionId: "reject-session",
    contentType: "image/png",
    bytes
  }), /size/i);

  const descriptor = await store.put({
    sessionId: "reject-session",
    contentType: "image/png",
    bytes
  });
  await assert.rejects(store.get({ sessionId: "other-session", descriptor }), /session/i);
  await writeFile(store.objectPathForTest(descriptor.sha256), Buffer.from("tampered"));
  await assert.rejects(
    store.get({ sessionId: "reject-session", descriptor }),
    AgentAttachmentIntegrityError
  );
});

test("local attachment store rejects a symlinked content-address shard", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-attachment-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "mn-agent-attachment-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  const bytes = await png();
  const digest = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(root, "objects", "v1"), { recursive: true });
  await symlink(outside, join(root, "objects", "v1", digest.slice(0, 2)));
  const store = new LocalAgentAttachmentStore({ rootDir: root });
  await assert.rejects(store.put({
    sessionId: "symlink-session",
    contentType: "image/png",
    bytes
  }), /symlink|directory|symbolic/iu);
  assert.deepEqual(await readdir(outside), []);
});

interface PutCall {
  key: string;
  bytes: Buffer;
  options: { contentType?: string; metadata?: Readonly<Record<string, string>>; ifNoneMatch?: "*" };
}

class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  readonly puts: PutCall[] = [];
  conflict = false;
  omitAfterPut = false;
  corruptGet = false;

  async putObject(key: string, bytes: Buffer, options: PutCall["options"]) {
    this.puts.push({ key, bytes: Buffer.from(bytes), options });
    if (this.conflict) {
      throw new S3ArtifactStoreError("conflict", { operation: "putObject", statusCode: 412 });
    }
    if (!this.omitAfterPut) this.objects.set(key, Buffer.from(bytes));
    return { key, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async headObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return undefined;
    const put = this.puts.find((entry) => entry.key === key);
    return {
      key,
      bytes: bytes.byteLength,
      metadata: { ...(put?.options.metadata ?? {}) },
      contentType: put?.options.contentType
    };
  }

  async getObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return undefined;
    return this.corruptGet ? Buffer.from("corrupt") : Buffer.from(bytes);
  }
}

test("enterprise attachment store uses scoped HMAC keys, create-only writes, and verified reads", async () => {
  const remote = new FakeS3();
  const store = new EnterpriseAgentObjectStore({
    store: remote as never,
    keySecret: Buffer.from("enterprise-attachment-test-key"),
    prefix: "agent-objects"
  });
  const bytes = await png();
  const descriptor = await store.put({
    tenantId: "tenant-with-phone-13800138000",
    sessionId: "session-with-secret-name",
    contentType: "image/png",
    bytes
  });

  assert.equal(remote.puts.length, 1);
  assert.equal(remote.puts[0]?.options.ifNoneMatch, "*");
  assert.equal(remote.puts[0]?.key.includes("tenant-with-phone"), false);
  assert.equal(remote.puts[0]?.key.includes("session-with-secret"), false);
  assert.equal(remote.puts[0]?.options.metadata?.["mn-sha256"], descriptor.sha256);
  assert.equal(remote.puts[0]?.options.metadata?.["mn-byte-length"], String(bytes.byteLength));
  assert.deepEqual(await store.get({
    tenantId: "tenant-with-phone-13800138000",
    sessionId: "session-with-secret-name",
    descriptor
  }), bytes);
  await assert.rejects(store.get({
    tenantId: "another-tenant",
    sessionId: "session-with-secret-name",
    descriptor
  }), /tenant|object|missing/i);
});

test("enterprise attachment store never retries ambiguous writes and fails on missing or corrupt objects", async () => {
  const bytes = await png();
  for (const mode of ["conflict", "missing"] as const) {
    const remote = new FakeS3();
    remote.conflict = mode === "conflict";
    remote.omitAfterPut = mode === "missing";
    const store = new EnterpriseAgentObjectStore({
      store: remote as never,
      keySecret: Buffer.from("enterprise-attachment-test-key")
    });
    await assert.rejects(store.put({
      tenantId: "tenant-a",
      sessionId: "session-a",
      contentType: "image/png",
      bytes
    }), /conflict|missing|verification/i);
    assert.equal(remote.puts.length, 1);
  }

  const remote = new FakeS3();
  const store = new EnterpriseAgentObjectStore({
    store: remote as never,
    keySecret: Buffer.from("enterprise-attachment-test-key")
  });
  const descriptor: AgentAttachmentDescriptorV1 = await store.put({
    tenantId: "tenant-a",
    sessionId: "session-a",
    contentType: "image/png",
    bytes
  });
  remote.corruptGet = true;
  await assert.rejects(store.get({
    tenantId: "tenant-a",
    sessionId: "session-a",
    descriptor
  }), AgentAttachmentIntegrityError);
});
