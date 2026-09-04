// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  AttachmentValidationError,
  EnvelopeCipher,
  FileCas,
  InMemoryKeyProvider,
  MacOsKeychainKeyProvider,
  S3Cas,
  validateAttachments
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "mn-cas-"));
  temporaryDirectories.push(root);
  return root;
}

test("file CAS is create-only, verifies content, and garbage-collects old orphans", async () => {
  const root = temporaryDirectory();
  const cas = new FileCas({ rootDir: root });
  const first = await cas.put(Buffer.from("first"));
  assert.equal(first.created, true);
  assert.ok(first.path);
  assert.equal((await cas.put(Buffer.from("first"))).created, false);
  assert.equal((await cas.get(first.digest)).toString(), "first");

  writeFileSync(first.path, "corrupt");
  await assert.rejects(cas.put(Buffer.from("first")), /digest mismatch/i);

  const orphan = await cas.put(Buffer.from("orphan"));
  assert.ok(orphan.path);
  const old = new Date("2026-09-01T00:00:00.000Z");
  utimesSync(orphan.path, old, old);
  const removed = await cas.gcOrphans(new Set(), new Date("2026-09-02T00:00:00.000Z"));
  assert.deepEqual(removed, [orphan.digest]);
});

test("AES-256-GCM envelope encrypts data and rejects tampering", async () => {
  const keys = new InMemoryKeyProvider(randomBytes(32));
  const cipher = new EnvelopeCipher(keys);
  const envelope = await cipher.encrypt(Buffer.from("sensitive"), {
    tenantId: "tenant-a",
    purpose: "event-payload"
  });

  assert.equal(envelope.algorithm, "AES-256-GCM");
  assert.notEqual(Buffer.from(envelope.ciphertext, "base64").toString(), "sensitive");
  assert.equal((await cipher.decrypt(envelope)).toString(), "sensitive");

  const tampered = { ...envelope, ciphertext: Buffer.from("tampered").toString("base64") };
  await assert.rejects(cipher.decrypt(tampered));
});

test("macOS Keychain provider uses the isolated v2 service and never passes a secret in argv", async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  let stored: string | undefined;
  const provider = new MacOsKeychainKeyProvider({
    account: "tenant-a",
    command: async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[0] === "find-generic-password") {
        if (!stored) throw new Error("not found");
        return stored;
      }
      stored = stdin;
      return "";
    }
  });
  const wrapped = await provider.wrapKey(randomBytes(32), { tenantId: "tenant-a", purpose: "test" });
  assert.equal((await provider.unwrapKey(wrapped)).byteLength, 32);
  assert.ok(calls.every((call) => call.args.includes("com.muniu.agent-os.v2")));
  assert.ok(calls.every((call) => !call.args.includes(stored ?? "impossible")));
});

test("macOS Keychain provider does not replace a key when lookup is denied", async () => {
  let calls = 0;
  const provider = new MacOsKeychainKeyProvider({
    account: "tenant-a",
    command: async () => {
      calls += 1;
      throw new Error("User interaction is not allowed");
    }
  });
  await assert.rejects(
    provider.wrapKey(randomBytes(32), { tenantId: "tenant-a", purpose: "test" }),
    /interaction is not allowed/
  );
  assert.equal(calls, 1);
});

test("attachment validation enforces count, size, safe names, UTF-8, and magic bytes", () => {
  const valid = validateAttachments([
    { fileName: "notes.md", mediaType: "text/markdown", bytes: Buffer.from("访谈记录") },
    { fileName: "evidence.pdf", mediaType: "application/pdf", bytes: Buffer.from("%PDF-1.7\n") },
    {
      fileName: "pixel.png",
      mediaType: "image/png",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }
  ]);
  assert.equal(valid.totalBytes, Buffer.byteLength("访谈记录") + 9 + 8);

  assert.throws(
    () => validateAttachments([{ fileName: "../secret.txt", mediaType: "text/plain", bytes: Buffer.from("x") }]),
    AttachmentValidationError
  );
  assert.throws(
    () => validateAttachments([{ fileName: "fake.png", mediaType: "image/png", bytes: Buffer.from("not png") }]),
    /does not match/i
  );
  assert.throws(
    () => validateAttachments([{ fileName: "bad.txt", mediaType: "text/plain", bytes: Buffer.from([0xff]) }]),
    /UTF-8/i
  );
  assert.throws(
    () => validateAttachments(Array.from({ length: 21 }, (_, index) => ({
      fileName: `${index}.txt`,
      mediaType: "text/plain",
      bytes: Buffer.from("x")
    }))),
    /20/
  );
  assert.throws(
    () => validateAttachments(
      [{ fileName: "large.txt", mediaType: "text/plain", bytes: Buffer.from("xx") }],
      { maxFileBytes: 1 }
    ),
    /exceeds 1 byte/
  );
  assert.throws(
    () => validateAttachments([
      { fileName: "one.txt", mediaType: "text/plain", bytes: Buffer.from("xx") },
      { fileName: "two.txt", mediaType: "text/plain", bytes: Buffer.from("xx") }
    ], { maxBatchBytes: 3 }),
    /batch exceeds 3 byte/
  );
});

test("S3 CAS writes under v2/ with If-None-Match create-only semantics", async () => {
  const objects = new Map<string, Buffer>();
  const calls: Array<{ key: string; ifNoneMatch?: string }> = [];
  const cas = new S3Cas({
    bucket: "agent-os",
    client: {
      async headObject({ key }) {
        const value = objects.get(key);
        return value ? { contentLength: value.byteLength } : undefined;
      },
      async putObject({ key, body, ifNoneMatch }) {
        calls.push({ key, ifNoneMatch });
        if (ifNoneMatch === "*" && objects.has(key)) return false;
        objects.set(key, Buffer.from(body));
        return true;
      },
      async getObject({ key }) {
        const value = objects.get(key);
        if (!value) throw new Error("missing");
        return value;
      },
      async listObjects() { return []; },
      async deleteObjects() {}
    }
  });

  const result = await cas.put(Buffer.from("asset"));
  assert.equal(result.created, true);
  assert.match(calls[0]!.key, /^v2\/sha256\//);
  assert.equal(calls[0]!.ifNoneMatch, "*");
});
