// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvelopeCipher, MacOsKeychainKeyProvider, FileCas, SqliteStorage, InMemoryKeyProvider, type KeychainCommand, type WrappedDataKey } from "../src/index.js";
import { drainKeyRevocations, requestKeyRevocationRetry, type KeyRevocation } from "../src/index.js";

test("individual Keychain wrapping keys keep deleted payloads unreadable after restoring an old envelope", async () => {
  const externalKeychain = new Map<string, string>();
  const calls: readonly string[][] = [];
  const command: KeychainCommand = async (args, stdin) => {
    (calls as string[][]).push([...args]);
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "find-generic-password") {
      const value = externalKeychain.get(account);
      if (!value) throw new Error("errSecItemNotFound");
      return value;
    }
    if (args[0] === "add-generic-password") {
      if (externalKeychain.has(account)) throw new Error("errSecDuplicateItem");
      assert.ok(stdin);
      externalKeychain.set(account, stdin.trim());
      return "";
    }
    if (args[0] === "delete-generic-password") {
      if (!externalKeychain.delete(account)) throw new Error("errSecItemNotFound");
      return "";
    }
    throw new Error("unexpected Keychain command");
  };
  const options = { account: "payload", command, individuallyRevocable: true };
  const provider = new MacOsKeychainKeyProvider(options);
  const cipher = new EnvelopeCipher(provider);
  const deleted = await cipher.encrypt(Buffer.from("deleted business record"), { tenantId: "a", purpose: "memory:a" });
  const retained = await cipher.encrypt(randomBytes(32), { tenantId: "a", purpose: "memory:b" });
  assert.notEqual(deleted.wrappedKey.keyId, retained.wrappedKey.keyId, "payload deletion requires an independent wrapping key");
  const backup = structuredClone(deleted);
  const revocable = provider as MacOsKeychainKeyProvider & { revokeKey(key: WrappedDataKey): Promise<void> };
  await revocable.revokeKey(deleted.wrappedKey);
  await revocable.revokeKey(deleted.wrappedKey);
  await assert.rejects(cipher.decrypt(backup), /not found|revoked|errSecItemNotFound/i);
  const restarted = new EnvelopeCipher(new MacOsKeychainKeyProvider(options));
  await assert.rejects(restarted.decrypt(backup), /not found|revoked|errSecItemNotFound/i);
  assert.equal((await restarted.decrypt(retained)).byteLength, 32);
  assert.equal(externalKeychain.size, 1);
  assert.ok(calls.every(args => args.includes("com.muniu.agent-os.v2")));
});

test("removing a payload key atomically persists a recoverable revocation request", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-key-revocation-"));
  const provider = new InMemoryKeyProvider(Buffer.alloc(32, 19));
  const wrappedKey = await provider.wrapKey(randomBytes(32), { tenantId: "tenant-a", purpose: "memory:one" });
  const store = new SqliteStorage({ databaseFile: join(root, "kernel.sqlite"), hmacKey: Buffer.alloc(32, 18),
    projectionJournal: { cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: provider, namespaces: [] } });
  try {
    await store.transact("tenant-a", tx => tx.putProjection("protectedPayloadKey", "payload-one", {
      id: "payload-one", workspaceId: "workspace-a", wrappedKey,
    }));
    await store.transact("tenant-a", tx => {
      tx.deleteProjection("protectedPayloadKey", "payload-one");
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "memory", aggregateId: "one", expectedStreamVersion: 0,
        type: "memory.deleted", actorId: "owner-a", generation: 0, correlationId: "delete", publicPayload: { workspaceId: "workspace-a" } });
    });
    const requests = await store.transact("tenant-a", tx => tx.listProjections<{ id: string; status: string; wrappedKey: WrappedDataKey }>("kernel.key-revocation"));
    assert.equal(requests.length, 1, "the wrapping key revocation must survive a crash after the database commit");
    assert.equal(requests[0]!.id, "payload-one");
    assert.equal(requests[0]!.status, "pending");
    assert.deepEqual(requests[0]!.wrappedKey, wrappedKey);
    assert.equal(JSON.stringify((await store.readEvents("tenant-a", 0, 100)).events).includes(wrappedKey.ciphertext), false);
    const drain = drainKeyRevocations;
    let attempts = 0;
    let revoked = false;
    const revoker = { async revokeKey() { if (++attempts === 1) throw new Error("fixture unknown outcome"); revoked = true; },
      async isKeyRevoked() { return revoked; } };
    assert.equal(await drain!({ store, keyProvider: revoker, tenantId: "tenant-a", requestId: "user-delete" }), 1);
    assert.equal(attempts, 1);
    assert.equal(await drain!({ store, keyProvider: revoker, tenantId: "tenant-a" }), 1);
    assert.equal(attempts, 1, "recovery must never automatically repeat an unknown deletion");
    const unknown = await store.transact("tenant-a", tx => tx.getProjection<KeyRevocation>("kernel.key-revocation", "payload-one"));
    await requestKeyRevocationRetry({ store, tenantId: "tenant-a", actorId: "owner-a", revocationId: "payload-one",
      expectedStreamVersion: unknown!.streamVersion, requestId: "new-user-deletion" });
    assert.equal(await drain!({ store, keyProvider: revoker, tenantId: "tenant-a" }), 0);
    assert.equal(attempts, 2);
    assert.equal((await store.transact("tenant-a", tx => tx.getProjection<{ status: string }>("kernel.key-revocation", "payload-one")))?.status, "completed");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
