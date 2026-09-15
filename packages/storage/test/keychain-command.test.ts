// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createKeychainCommand, keychainInvocation, type KeychainInvocation } from "../src/keychain-command.js";

const args = ["add-generic-password", "-s", "com.muniu.agent-os.v2.test", "-a", "fixture", "-w"];
test("Keychain 写入通过有界的命令标准输入，不使用终端密码提示", () => {
  const secret = "fixture-\"'$()`\\key";
  const invocation = keychainInvocation(args, `${secret}\n`);
  assert.deepEqual(invocation.args, ["-i", "-q"]);
  assert.equal(invocation.stdin?.split("\n").length, 2);
  assert.ok(invocation.stdin?.includes(`"-X" "${Buffer.from(secret).toString("hex")}"`));
  assert.equal(invocation.stdin?.includes(secret), false);
  for (const value of ["", "first\nsecond", "x".repeat(4096), "\0unsafe"]) {
    assert.throws(() => keychainInvocation(args, `${value}\n`));
  }
  assert.throws(() => keychainInvocation([...args, secret]));
  assert.throws(() => keychainInvocation(["-v"], `${secret}\n`));
});

test("Keychain 写入必须用独立查询读回，空值或不一致均失败", async () => {
  for (const restored of ["", "different", "fixture"]) {
    const calls: KeychainInvocation[] = [];
    const command = createKeychainCommand(async invocation => {
      calls.push(invocation);
      return invocation.args[0] === "find-generic-password" ? restored : "";
    });
    if (restored === "fixture") await command(args, "fixture\n");
    else await assert.rejects(command(args, "fixture\n"), /could not be verified/u);
    assert.deepEqual(calls[1]?.args, ["find-generic-password", "-s", "com.muniu.agent-os.v2.test", "-a", "fixture", "-w"]);
  }
});
