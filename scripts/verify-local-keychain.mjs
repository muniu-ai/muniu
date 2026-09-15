// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { MacOsKeychainSecretStore } from "../apps/host/dist/secrets.js";
import { MacOsKeychainKeyProvider, runKeychainCommand } from "@mn/storage";

if (process.platform !== "darwin") throw new Error("真实 Keychain 验证要求 macOS");
const service = `com.muniu.agent-os.v2.verification.${randomUUID()}`;
const accounts = new Set();
const command = async (args, stdin) => {
  if (args[0] === "add-generic-password") accounts.add(args[args.indexOf("-a") + 1]);
  return runKeychainCommand(args, stdin);
};
try {
  const secrets = new MacOsKeychainSecretStore(command, service);
  const secret = `fixture-\"'$()\\-${randomUUID()}`;
  const ref = await secrets.save("temporary-test", secret);
  assert.ok(await secrets.read(ref) === secret, "BYOK 写入后必须完整读回");
  const hmac = await secrets.getOrCreateBytes("event-hmac");
  assert.ok((await new MacOsKeychainSecretStore(command, service).getOrCreateBytes("event-hmac")).equals(hmac));
  hmac.fill(0);
  const context = { tenantId: "fixture", purpose: "real-keychain-verification" };
  for (const individuallyRevocable of [false, true]) {
    const options = { service, command, account: individuallyRevocable ? "protected" : "backup", individuallyRevocable };
    const provider = new MacOsKeychainKeyProvider(options);
    const dataKey = randomBytes(32);
    try {
      const wrapped = await provider.wrapKey(dataKey, context);
      const restored = await new MacOsKeychainKeyProvider(options).unwrapKey(wrapped);
      assert.ok(restored.equals(dataKey), "新实例必须能够解开已保存包装密钥");
      restored.fill(0);
      if (individuallyRevocable) {
        await provider.revokeKey(wrapped);
        await assert.rejects(new MacOsKeychainKeyProvider(options).unwrapKey(wrapped));
      }
    } finally { dataKey.fill(0); }
  }
  process.stdout.write("真实 macOS Keychain：BYOK、HMAC、备份密钥、独立包装密钥与撤销读回验证通过\n");
} finally {
  for (const account of accounts) {
    await runKeychainCommand(["delete-generic-password", "-s", service, "-a", account]).catch(error => {
      if (!/item not found/u.test(String(error))) throw error;
    });
  }
  process.stdout.write("已清理本次临时 Keychain 条目，未修改现有密钥\n");
}
