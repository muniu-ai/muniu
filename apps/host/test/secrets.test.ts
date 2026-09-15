import assert from "node:assert/strict";
import test from "node:test";

import { MacOsKeychainSecretStore, type KeychainCommand } from "../src/secrets.js";

test("v2 Keychain 创建的字节密钥可由新实例重新读取", async () => {
  const entries = new Map<string, string>();
  const calls: string[][] = [];
  const command: KeychainCommand = async (arguments_: readonly string[], stdin?: string) => {
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
    assert.equal(passwordIndex, argumentsCopy.length - 1, "密码不得出现在进程参数中");
    const password = stdin?.trim();
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

test("BYOK 密钥通过标准输入写入 Keychain，拒绝换行密钥", async () => {
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  const secret = "fixture-key-not-a-real-credential";
  const store = new MacOsKeychainSecretStore(async (args: readonly string[], stdin?: string) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    return "";
  });
  assert.equal(await store.save("connection", secret), "keychain://muniu.v2/model-connection");
  assert.equal(JSON.stringify(calls[0]!.args).includes(secret), false);
  assert.equal(calls[0]!.stdin, `${secret}\n`);
  await assert.rejects(store.save("connection", "first\nsecond"));
  assert.equal(calls.length, 1);
});
