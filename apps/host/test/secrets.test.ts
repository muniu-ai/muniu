import assert from "node:assert/strict";
import test from "node:test";

import { MacOsKeychainSecretStore, type KeychainCommand } from "../src/secrets.js";

test("v2 Keychain 创建的字节密钥可由新实例重新读取", async () => {
  const entries = new Map<string, string>();
  const calls: string[][] = [];
  const command: KeychainCommand = async (arguments_) => {
    const argumentsCopy = [...arguments_];
    calls.push(argumentsCopy);
    const account = argumentsCopy[argumentsCopy.indexOf("-a") + 1];
    if (!account) throw new Error("测试命令缺少 Keychain account");
    if (argumentsCopy[0] === "find-generic-password") {
      const value = entries.get(account);
      if (value === undefined) throw new Error("The specified item could not be found in the keychain.");
      return value;
    }
    assert.equal(argumentsCopy[0], "add-generic-password");
    const passwordIndex = argumentsCopy.indexOf("-w");
    assert.notEqual(passwordIndex, -1);
    const password = argumentsCopy[passwordIndex + 1];
    assert.equal(typeof password, "string");
    if (!password) throw new Error("测试命令未传递 Keychain 密码");
    entries.set(account, password);
    return "";
  };

  const created = await new MacOsKeychainSecretStore(command).getOrCreateBytes("event-hmac", 32);
  const restored = await new MacOsKeychainSecretStore(command).getOrCreateBytes("event-hmac", 32);

  assert.deepEqual(restored, created);
  assert.equal(calls.filter(([operation]) => operation === "add-generic-password").length, 1);
});
