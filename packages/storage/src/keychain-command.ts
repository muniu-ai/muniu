// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

export interface KeychainInvocation {
  readonly args: readonly string[];
  readonly stdin?: string;
}

export function keychainInvocation(args: readonly string[], stdin?: string): KeychainInvocation {
  if (!args.length || args.length > 24 || args.some(arg => /[\x00-\x1f\x7f]/u.test(arg))) {
    throw new Error("Invalid Keychain command");
  }
  if (stdin === undefined) {
    if (!["find-generic-password", "delete-generic-password"].includes(args[0]!)) throw new Error("Keychain writes require private stdin");
    return { args };
  }
  if (args[0] !== "add-generic-password" || args.at(-1) !== "-w" || args.slice(0, -1).includes("-w")) {
    throw new Error("Invalid Keychain write command");
  }
  const password = stdin.replace(/\n$/u, "");
  if (!password || /[\x00-\x1f\x7f]/u.test(password)) throw new Error("Invalid Keychain password");
  const quote = (value: string) => `"${value.replace(/[\\"]/gu, "\\$&")}"`;
  // Interactive command input is distinct from the password prompt, which reads a terminal.
  const command = [...args.slice(0, -1), "-X", Buffer.from(password, "utf8").toString("hex")].map(quote).join(" ") + "\n";
  if (Buffer.byteLength(command, "utf8") >= 4096) throw new Error("Keychain input exceeds the command length limit");
  return { args: ["-i", "-q"], stdin: command };
}

export type KeychainProcess = (invocation: KeychainInvocation) => Promise<string>;

function runProcess(invocation: KeychainInvocation): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", invocation.args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
      if (error) reject(error); else resolve(value ?? "");
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Keychain command timed out")); }, 10_000);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      size += chunk.byteLength;
      if (settled) { chunk.fill(0); return; }
      if (size > 64 * 1024) { chunk.fill(0); child.kill("SIGKILL"); finish(new Error("Keychain output limit exceeded")); return; }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => finish(new Error("Keychain process could not start")));
    child.stdin.once("error", () => { child.kill("SIGKILL"); finish(new Error("Keychain input failed")); });
    child.once("close", code => {
      if (code === 0) finish(undefined, Buffer.concat(stdout).toString("utf8").replace(/\r?\n$/u, ""));
      else {
        const diagnostic = Buffer.concat(stderr).toString("utf8");
        const message = /could not be found|errSecItemNotFound|-25300/iu.test(diagnostic) ? "Keychain item not found (-25300)"
          : /already exists|errSecDuplicateItem|-25299/iu.test(diagnostic) ? "Keychain item already exists (-25299)"
            : "Keychain operation failed; check access and unlock status";
        finish(new Error(message));
      }
    });
    child.stdin.end(invocation.stdin);
  });
}

export function createKeychainCommand(process: KeychainProcess = runProcess) {
  return async (args: readonly string[], stdin?: string): Promise<string> => {
    const result = await process(keychainInvocation(args, stdin));
    if (stdin !== undefined) {
      const service = args[args.indexOf("-s") + 1];
      const account = args[args.indexOf("-a") + 1];
      if (!args.includes("-s") || !args.includes("-a") || !service || !account) throw new Error("Keychain write lacks an exact item identity");
      const restored = await process(keychainInvocation(["find-generic-password", "-s", service, "-a", account, "-w"]));
      if (restored !== stdin.replace(/\n$/u, "")) throw new Error("Keychain write could not be verified");
    }
    return result;
  };
}

export const runKeychainCommand = createKeychainCommand();
