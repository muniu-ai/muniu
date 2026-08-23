// SPDX-License-Identifier: Apache-2.0

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ThreadHandle } from "@mn/sdk";

import { cliAppServerClient } from "./app-server-client.js";
import { option, printJson } from "./command-client.js";

async function createThread(args: readonly string[]): Promise<ThreadHandle> {
  const providerId = option(args, "--provider");
  const modelId = option(args, "--model");
  if (!providerId || !modelId) {
    throw new TypeError("agent run/chat requires --provider <id> and --model <id>");
  }
  return (await cliAppServerClient()).startThread({
    modelProvider: providerId,
    model: modelId,
    cwd: option(args, "--cwd") ?? process.cwd(),
    threadSource: "cli"
  });
}

async function sendMessage(thread: ThreadHandle, prompt: string) {
  if (!prompt.trim()) throw new TypeError("agent prompt must not be empty");
  return thread.run({ input: [{ type: "text", text: prompt }] });
}

export async function agentCommand(
  subcommand: string | undefined,
  args: readonly string[]
): Promise<void> {
  if (subcommand === "sessions") {
    const limit = Number(option(args, "--limit") ?? "100");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("--limit must be a positive integer");
    printJson(await (await cliAppServerClient()).listThreads({ limit }));
    return;
  }

  if (subcommand === "resume") {
    const sessionId = args.find((value) => !value.startsWith("--"));
    const prompt = option(args, "--prompt");
    if (!sessionId || !prompt) {
      throw new TypeError("agent resume requires <session-id> --prompt <text>");
    }
    const thread = await (await cliAppServerClient()).resumeThread({ threadId: sessionId });
    printJson(await sendMessage(thread, prompt));
    return;
  }

  if (subcommand !== "run" && subcommand !== "chat") {
    throw new TypeError("agent command must be run, chat, resume, or sessions");
  }

  const thread = await createThread(args);
  const initialPrompt = option(args, "--prompt");
  if (subcommand === "run") {
    if (!initialPrompt) throw new TypeError("agent run requires --prompt <text>");
    printJson({ thread: await thread.read(), turn: await sendMessage(thread, initialPrompt) });
    return;
  }

  printJson({ event: "thread.started", thread: await thread.read() });
  if (initialPrompt) printJson(await sendMessage(thread, initialPrompt));
  if (!stdin.isTTY) return;
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const prompt = await terminal.question("muniu> ");
      if (prompt.trim() === "/exit") break;
      if (prompt.trim()) printJson(await sendMessage(thread, prompt));
    }
  } finally {
    terminal.close();
  }
}
