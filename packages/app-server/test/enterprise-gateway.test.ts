// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { CLIENT_METHODS, type JsonRpcMessage } from "@mn/app-server-protocol";

import {
  EnterpriseAppServerGateway,
  InMemoryConnectionLeaseStore,
  InMemoryNotificationLog,
  type AppServerHandlers
} from "../src/index.js";

function handlers(): AppServerHandlers {
  return Object.fromEntries(CLIENT_METHODS.filter((method) => method !== "initialize").map((method) => [
    method,
    async () => ({})
  ])) as unknown as AppServerHandlers;
}

test("enterprise gateway authenticates before admission and fixes identity for the lease", async () => {
  const leases = new InMemoryConnectionLeaseStore();
  const output: JsonRpcMessage[] = [];
  const gateway = new EnterpriseAppServerGateway({
    origins: ["https://desktop.example"],
    authenticate: async (authorization) => {
      assert.equal(authorization, "Bearer signed-token");
      return {
        tenantId: "tenant-a",
        subject: "user-a",
        roles: ["developer"],
        permissionProfile: "workspace-write",
        sandbox: { mode: "workspace-write", network: false }
      };
    },
    authorize: (_identity, method) => method !== "thread/delete",
    leases,
    createConnectionOptions: () => ({
      serverInfo: { name: "muniu", version: "0.2.0" },
      instructionSources: [],
      handlers: handlers(),
      notificationLog: new InMemoryNotificationLog()
    })
  });
  const connection = await gateway.accept({
    authorization: "Bearer signed-token",
    origin: "https://desktop.example",
    secure: true,
    remoteAddress: "203.0.113.8"
  }, {
    send: async (message) => { output.push(message as JsonRpcMessage); },
    close: () => undefined
  });
  await connection.receiveText(JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "desktop", version: "0.2.0" } }
  }));
  await connection.receiveText(JSON.stringify({ method: "initialized" }));
  await connection.receiveText(JSON.stringify({ id: 2, method: "thread/delete", params: { threadId: "thread-1" } }));
  await connection.idle();
  assert.equal(leases.size, 1);
  assert.deepEqual(output.at(-1), { id: 2, error: { code: -32003, message: "Request is not authorized" } });
  await connection.close();
  assert.equal(leases.size, 0);
});

test("enterprise gateway rejects plaintext, origins, lease overflow and request floods", async () => {
  const leases = new InMemoryConnectionLeaseStore({ maxConnectionsPerSubject: 1 });
  const gateway = new EnterpriseAppServerGateway({
    origins: ["https://desktop.example"],
    maxRequestsPerMinute: 1,
    authenticate: async () => ({
      tenantId: "tenant-a",
      subject: "user-a",
      roles: ["developer"],
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write" }
    }),
    authorize: () => true,
    leases,
    createConnectionOptions: () => ({
      serverInfo: { name: "muniu", version: "0.2.0" },
      instructionSources: [],
      handlers: handlers(),
      notificationLog: new InMemoryNotificationLog()
    })
  });
  const peer = { send: async () => undefined, close: () => undefined };
  await assert.rejects(() => gateway.accept({ authorization: "x", secure: false }, peer), /TLS/iu);
  await assert.rejects(() => gateway.accept({ authorization: "x", secure: true, origin: "https://evil.example" }, peer), /origin/iu);
  const first = await gateway.accept({ authorization: "x", secure: true, origin: "https://desktop.example" }, peer);
  await assert.rejects(() => gateway.accept({ authorization: "x", secure: true, origin: "https://desktop.example" }, peer), /lease/iu);
  await first.receiveText(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } }));
  await first.receiveText(JSON.stringify({ method: "initialized" }));
  await assert.rejects(
    () => first.receiveText(JSON.stringify({ id: 2, method: "thread/read", params: { threadId: "thread-1" } })),
    /rate limit/iu
  );
  await first.close();
});

test("enterprise gateway waits for durable lease release before close resolves", async () => {
  let finishRelease: (() => void) | undefined;
  let peerClosed = false;
  const gateway = new EnterpriseAppServerGateway({
    origins: ["https://desktop.example"],
    authenticate: async () => ({
      tenantId: "tenant-a",
      subject: "user-a",
      roles: ["developer"],
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write" }
    }),
    authorize: () => true,
    leases: {
      acquire: async () => true,
      renew: async () => true,
      release: () => new Promise<void>((resolve) => { finishRelease = resolve; })
    },
    createConnectionOptions: () => ({
      serverInfo: { name: "muniu", version: "0.2.0" },
      instructionSources: [],
      handlers: handlers(),
      notificationLog: new InMemoryNotificationLog()
    })
  });
  const connection = await gateway.accept({ secure: true }, {
    send: async () => undefined,
    close: () => { peerClosed = true; }
  });
  let closeResolved = false;
  const close = connection.close().then(() => { closeResolved = true; });
  await Promise.resolve();
  assert.equal(closeResolved, false);
  assert.equal(peerClosed, false);
  finishRelease?.();
  await close;
  assert.equal(peerClosed, true);
});

test("enterprise gateway releases an acquired lease when connection setup fails", async () => {
  const leases = new InMemoryConnectionLeaseStore();
  const gateway = new EnterpriseAppServerGateway({
    origins: ["https://desktop.example"],
    authenticate: async () => ({
      tenantId: "tenant-a",
      subject: "user-a",
      roles: ["developer"],
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write" }
    }),
    authorize: () => true,
    leases,
    createConnectionOptions: () => { throw new Error("runtime unavailable"); }
  });
  await assert.rejects(
    () => gateway.accept({ secure: true }, { send: async () => undefined, close: () => undefined }),
    /runtime unavailable/iu
  );
  assert.equal(leases.size, 0);
});
