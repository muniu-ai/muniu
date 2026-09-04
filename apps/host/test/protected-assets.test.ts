// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryKernelStore } from "@mn/kernel";
import {
  InMemoryKeyProvider,
  MacOsKeychainKeyProvider,
  SqliteStorage,
  type ContentAddressedStorage,
  type KeyProvider,
} from "@mn/storage";

import {
  createAgentOsHost,
  startLocalAgentOsHost,
  type AgentOsHost,
  type LocalAgentOsSecretStore,
  type ModelSecretStore,
} from "../src/index.js";

const secrets: ModelSecretStore = {
  async save(connectionId) { return `keychain://muniu.v2/${connectionId}`; },
  async read() { return "test-key"; },
};

function request(
  path: string,
  body?: unknown,
  options: { readonly key?: string; readonly method?: string; readonly principal?: string } = {},
): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (options.key) headers.set("Idempotency-Key", options.key);
  if (options.principal) headers.set("X-Principal", options.principal);
  return new Request(`http://host.test${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function memoryCas() {
  const objects = new Map<string, Buffer>();
  const writes: Buffer[] = [];
  let reads = 0;
  const cas: ContentAddressedStorage = {
    async put(bytes) {
      const copy = Buffer.from(bytes);
      writes.push(copy);
      const digest = createHash("sha256").update(copy).digest("hex");
      const created = !objects.has(digest);
      objects.set(digest, copy);
      return { digest, byteLength: copy.byteLength, created };
    },
    async get(digest) {
      reads += 1;
      const value = objects.get(digest);
      if (!value) throw new Error("CAS object missing");
      return Buffer.from(value);
    },
    async has(digest) { return objects.has(digest); },
    async gcOrphans() { return []; },
  };
  return { cas, objects, writes, reads: () => reads };
}

class LocalSecrets implements LocalAgentOsSecretStore {
  async save(connectionId: string): Promise<string> {
    return `keychain://muniu.v2/${connectionId}`;
  }

  async read(): Promise<string> {
    return "test-key";
  }

  async getOrCreateBytes(): Promise<Buffer> {
    return Buffer.alloc(32, 0x17);
  }
}

test("受保护附件先写密文 CAS，再提交独立 wrapped DEK，并在授权读取时解密", async () => {
  const store = new InMemoryKernelStore();
  const { cas, objects, writes, reads } = memoryCas();
  const vaultKeys = new InMemoryKeyProvider(randomBytes(32), {
    provider: "vault-kms",
    keyId: "vault://muniu/v2/transit/assets",
  });
  let unwraps = 0;
  const keyProvider: KeyProvider = {
    wrapKey: (dataKey, context) => vaultKeys.wrapKey(dataKey, context),
    unwrapKey: (wrapped) => {
      unwraps += 1;
      return vaultKeys.unwrapKey(wrapped);
    },
  };
  let id = 0;
  const host = await createAgentOsHost({
    profile: "enterprise",
    store,
    cas,
    secretStore: secrets,
    protectedPayloadKeyProvider: keyProvider,
    identityResolver: (incoming: Request) => ({
      tenantId: "tenant-a",
      principalId: incoming.headers.get("X-Principal") ?? "owner-a",
      organizationRoles: ["organization_admin"],
    }),
    now: () => "2026-09-04T09:00:00.000Z",
    id: (kind: string) => `${kind}-${++id}`,
  });

  const workspaceResponse = await host.dispatch(request("/v2/workspaces", {
    name: "敏感访谈",
    viewMode: "business",
    pluginIds: ["opc"],
  }, { key: "protected-workspace", principal: "owner-a" }));
  assert.equal(workspaceResponse.status, 201, JSON.stringify(await workspaceResponse.clone().json()));
  const workspace = (await json(workspaceResponse)).data;
  const plaintext = Buffer.from("客户明确要求不得公开的原始访谈。", "utf8");
  const upload = {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    attachments: [{
      fileName: "原始访谈.txt",
      mediaType: "text/plain",
      contentBase64: plaintext.toString("base64"),
      protected: true,
    }],
  };

  const response = await host.dispatch(request("/v2/assets", upload, {
    key: "protected-create",
    principal: "owner-a",
  }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const [asset] = (await json(response)).data;
  assert.equal(asset.protected, true);
  assert.equal(typeof asset.protectedPayloadRef, "string");
  assert.equal(writes.length, 1);
  assert.notDeepEqual(writes[0], plaintext);
  assert.equal(writes[0]!.includes(plaintext), false);
  assert.equal(asset.digest, createHash("sha256").update(writes[0]!).digest("hex"));

  const replay = await host.dispatch(request("/v2/assets", upload, {
    key: "protected-create",
    principal: "owner-a",
  }));
  assert.equal(replay.status, 201);
  assert.deepEqual((await json(replay)).data, [asset]);
  assert.equal(writes.length, 1);

  const keyRecord = await store.transact("tenant-a", (transaction) =>
    transaction.getProjection<any>("protectedPayloadKey", asset.protectedPayloadRef));
  assert.equal(keyRecord.assetId, asset.id);
  assert.equal(keyRecord.wrappedKey.provider, "vault-kms");
  assert.equal(Object.hasOwn(keyRecord, "digest"), false);
  assert.doesNotMatch(JSON.stringify(keyRecord), /客户明确要求不得公开/u);

  const event = (await store.readEvents("tenant-a", 0, 100)).events
    .find((entry) => entry.type === "asset.created");
  assert.equal(event?.protectedPayloadRef, asset.protectedPayloadRef);
  assert.doesNotMatch(JSON.stringify(event?.publicPayload), /客户明确要求不得公开|wrappedKey|nonce|tag/u);

  const denied = await host.dispatch(request(`/v2/assets/${asset.id}?content=1`, undefined, {
    principal: "viewer-without-membership",
  }));
  assert.equal(denied.status, 403);
  assert.equal(reads(), 0);
  assert.equal(unwraps, 0);

  const content = await host.dispatch(request(`/v2/assets/${asset.id}?content=1`, undefined, {
    principal: "owner-a",
  }));
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), plaintext);
  assert.equal(reads(), 1);
  assert.equal(unwraps, 1);

  const deletion = await host.dispatch(request(`/v2/assets/${asset.id}`, {
    expectedStreamVersion: 1,
    reason: "客户要求删除",
  }, { key: "protected-delete", method: "DELETE", principal: "owner-a" }));
  assert.equal(deletion.status, 200, JSON.stringify(await deletion.clone().json()));
  const tombstone = (await json(deletion)).data;
  assert.equal(tombstone.id, asset.id);
  assert.equal(tombstone.streamVersion, 2);
  assert.equal(tombstone.protected, true);
  assert.equal(typeof tombstone.objectDigest, "string");
  assert.equal(typeof tombstone.reasonDigest, "string");
  assert.equal(Object.hasOwn(tombstone, "digest"), false);
  assert.equal(objects.has(asset.digest), true);

  const state = await store.transact("tenant-a", (transaction) => ({
    asset: transaction.getProjection("asset", asset.id),
    key: transaction.getProjection("protectedPayloadKey", asset.protectedPayloadRef),
    tombstone: transaction.getProjection<any>("assetTombstone", asset.id),
  }));
  assert.equal(state.asset, undefined);
  assert.equal(state.key, undefined);
  assert.deepEqual(state.tombstone, tombstone);
  assert.doesNotMatch(JSON.stringify(state.tombstone), /客户要求删除|原始访谈|vault|wrapped|ciphertext/u);

  const afterDelete = await host.dispatch(request(`/v2/assets/${asset.id}?content=1`, undefined, {
    principal: "owner-a",
  }));
  assert.equal(afterDelete.status, 404);
  const replayedDeletion = await host.dispatch(request(`/v2/assets/${asset.id}`, {
    expectedStreamVersion: 1,
    reason: "客户要求删除",
  }, { key: "protected-delete", method: "DELETE", principal: "owner-a" }));
  assert.equal(replayedDeletion.status, 200);
  assert.deepEqual((await json(replayedDeletion)).data, tombstone);

  const deletedEvent = (await store.readEvents("tenant-a", 0, 100)).events
    .find((entry) => entry.type === "asset.deleted");
  assert.equal(deletedEvent?.protectedPayloadRef, undefined);
  assert.doesNotMatch(JSON.stringify(deletedEvent), /客户要求删除|原始访谈|vault|wrapped|ciphertext/u);
  await host.close();
});

test("包装密钥或 CAS 写入失败时不提交 Asset 事实，客户端不能伪造保护引用", async () => {
  const plaintext = Buffer.from("敏感内容", "utf8");
  const upload = (extra: Record<string, unknown> = {}) => ({
    expectedStreamVersion: 0,
    attachments: [{
      fileName: "secret.txt",
      mediaType: "text/plain",
      contentBase64: plaintext.toString("base64"),
      protected: true,
      ...extra,
    }],
  });

  async function fixture(provider: KeyProvider, rejectCas = false) {
    const store = new InMemoryKernelStore();
    let casWrites = 0;
    const cas: ContentAddressedStorage = {
      async put(bytes) {
        casWrites += 1;
        if (rejectCas) throw new Error("S3 unavailable");
        return {
          digest: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
          created: true,
        };
      },
      async get() { throw new Error("not used"); },
      async has() { return false; },
      async gcOrphans() { return []; },
    };
    const host = await createAgentOsHost({
      store,
      cas,
      protectedPayloadKeyProvider: provider,
      secretStore: secrets,
    });
    const workspace = (await json(await host.dispatch(request("/v2/workspaces", {
      name: "保护失败",
      viewMode: "business",
      pluginIds: [],
    }, { key: `failure-workspace-${rejectCas}` })))).data;
    return { store, host, workspace, casWrites: () => casWrites };
  }

  const failingProvider: KeyProvider = {
    async wrapKey() { throw new Error("KMS unavailable"); },
    async unwrapKey() { throw new Error("not used"); },
  };
  const kmsFailure = await fixture(failingProvider);
  const failedKmsResponse = await kmsFailure.host.dispatch(request("/v2/assets", {
    workspaceId: kmsFailure.workspace.id,
    ...upload(),
  }, { key: "kms-failure" }));
  assert.equal(failedKmsResponse.status, 500);
  assert.equal(kmsFailure.casWrites(), 0);
  assert.equal((await kmsFailure.store.readEvents("local", 0, 100)).events
    .filter((event) => event.type.startsWith("asset.")).length, 0);
  assert.deepEqual(await kmsFailure.store.transact("local", (transaction) => ({
    assets: transaction.listProjections("asset"),
    keys: transaction.listProjections("protectedPayloadKey"),
  })), { assets: [], keys: [] });
  await kmsFailure.host.close();

  const casFailure = await fixture(new InMemoryKeyProvider(randomBytes(32)), true);
  const failedCasResponse = await casFailure.host.dispatch(request("/v2/assets", {
    workspaceId: casFailure.workspace.id,
    ...upload(),
  }, { key: "cas-failure" }));
  assert.equal(failedCasResponse.status, 500);
  assert.equal(casFailure.casWrites(), 1);
  assert.equal((await casFailure.store.readEvents("local", 0, 100)).events
    .filter((event) => event.type.startsWith("asset.")).length, 0);
  assert.deepEqual(await casFailure.store.transact("local", (transaction) => ({
    assets: transaction.listProjections("asset"),
    keys: transaction.listProjections("protectedPayloadKey"),
  })), { assets: [], keys: [] });
  await casFailure.host.close();

  const accepted = await fixture(new InMemoryKeyProvider(randomBytes(32)));
  const forgedAsset = await accepted.host.dispatch(request("/v2/assets", {
    workspaceId: accepted.workspace.id,
    ...upload({ protectedPayloadRef: "vault://attacker/chosen-key" }),
  }, { key: "forged-asset-ref" }));
  assert.equal(forgedAsset.status, 422);
  assert.equal(accepted.casWrites(), 0);

  const forgedMemory = await accepted.host.dispatch(request("/v2/memories", {
    workspaceId: accepted.workspace.id,
    scopeType: "workspace",
    namespace: "opc",
    resourceId: "opportunity-1",
    sourceEventId: "event-1",
    protectedPayloadRef: "vault://attacker/chosen-key",
  }, { key: "forged-memory-ref" }));
  assert.equal(forgedMemory.status, 422);
  assert.equal((await json(forgedMemory)).code, "PROTECTED_PAYLOAD_REF_FORBIDDEN");
  assert.equal((await accepted.store.readEvents("local", 0, 100)).events
    .filter((event) => event.type === "memory.proposed").length, 0);
  await accepted.host.close();
});

test("本地组合根可注入 v2 Keychain provider，并在 SQLite 与文件 CAS 重启后解密", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "muniu-protected-assets-"));
  let keychainValue: string | undefined;
  const keychainCommand = async (args: readonly string[], stdin?: string): Promise<string> => {
    if (args[0] === "find-generic-password") {
      if (!keychainValue) throw new Error("not found");
      return keychainValue;
    }
    keychainValue = stdin?.trim();
    return "";
  };
  const provider = () => new MacOsKeychainKeyProvider({
    account: "protected-payload-wrapping-key",
    command: keychainCommand,
  });
  const localSecrets = new LocalSecrets();
  let first: AgentOsHost | undefined;
  let second: AgentOsHost | undefined;
  try {
    first = await startLocalAgentOsHost({
      stateRoot,
      port: 0,
      secretStore: localSecrets,
      protectedPayloadKeyProvider: provider(),
      workerIdleDelayMs: 1,
    });
    const workspace = (await json(await first.dispatch(request("/v2/workspaces", {
      name: "本地敏感附件",
      viewMode: "business",
      pluginIds: [],
    }, { key: "local-protected-workspace" })))).data;
    const createdResponse = await first.dispatch(request("/v2/assets", {
      workspaceId: workspace.id,
      expectedStreamVersion: 0,
      attachments: [{
        fileName: "private.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("restart-safe protected content").toString("base64"),
        protected: true,
      }],
    }, { key: "local-protected-create" }));
    assert.equal(createdResponse.status, 201);
    const [asset] = (await json(createdResponse)).data;
    await first.close();
    first = undefined;

    second = await startLocalAgentOsHost({
      stateRoot,
      port: 0,
      secretStore: localSecrets,
      protectedPayloadKeyProvider: provider(),
      workerIdleDelayMs: 1,
    });
    const content = await second.dispatch(request(`/v2/assets/${asset.id}?content=1`));
    assert.equal(content.status, 200);
    assert.equal(await content.text(), "restart-safe protected content");
    const deletion = await second.dispatch(request(`/v2/assets/${asset.id}`, {
      expectedStreamVersion: 1,
      reason: "本地删除验证",
    }, { key: "local-protected-delete", method: "DELETE" }));
    assert.equal(deletion.status, 200);
    await second.close();
    second = undefined;

    const persisted = new SqliteStorage({
      databaseFile: join(stateRoot, "state.sqlite3"),
      hmacKey: Buffer.alloc(32, 0x17),
    });
    try {
      const deletedState = await persisted.transact("local", (transaction) => ({
        asset: transaction.getProjection("asset", asset.id),
        key: transaction.getProjection("protectedPayloadKey", asset.protectedPayloadRef),
        tombstone: transaction.getProjection<any>("assetTombstone", asset.id),
      }));
      assert.equal(deletedState.asset, undefined);
      assert.equal(deletedState.key, undefined);
      assert.equal(deletedState.tombstone.streamVersion, 2);
      assert.equal(deletedState.tombstone.protected, true);
    } finally {
      await persisted.close();
    }
  } finally {
    await first?.close();
    await second?.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
