// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { option, printJson, requestJson } from "./command-client.js";

interface AgentSessionView {
  schemaVersion: 1;
  kind: "agent-session-view";
  sessionId: string;
  state: string;
}

function requestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function createSession(args: readonly string[]): Promise<AgentSessionView> {
  const providerId = option(args, "--provider");
  const modelId = option(args, "--model");
  if (!providerId || !modelId) {
    throw new TypeError("agent run/chat requires --provider <id> and --model <id>");
  }
  return requestJson<AgentSessionView>("/v1/agent-sessions", {
    method: "POST",
    body: {
      schemaVersion: 1,
      kind: "agent-session-create-request",
      clientRequestId: requestId("agent-create"),
      modelBinding: {
        schemaVersion: 1,
        kind: "agent-model-binding",
        providerId,
        modelId
      },
      cwd: option(args, "--cwd") ?? process.cwd(),
      labels: { source: "mn-agent" }
    }
  });
}

async function sendMessage(sessionId: string, prompt: string): Promise<AgentSessionView> {
  if (!prompt.trim()) throw new TypeError("agent prompt must not be empty");
  return requestJson<AgentSessionView>(
    `/v1/agent-sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: {
        schemaVersion: 1,
        kind: "agent-message-request",
        clientRequestId: requestId("agent-message"),
        prompt
      }
    }
  );
}

export async function agentCommand(
  subcommand: string | undefined,
  args: readonly string[]
): Promise<void> {
  if (subcommand === "sessions") {
    const limit = option(args, "--limit") ?? "100";
    printJson(await requestJson(`/v1/agent-sessions?limit=${encodeURIComponent(limit)}`));
    return;
  }

  if (subcommand === "resume") {
    const sessionId = args.find((value) => !value.startsWith("--"));
    const prompt = option(args, "--prompt");
    if (!sessionId || !prompt) {
      throw new TypeError("agent resume requires <session-id> --prompt <text>");
    }
    printJson(await sendMessage(sessionId, prompt));
    return;
  }

  if (subcommand !== "run" && subcommand !== "chat") {
    throw new TypeError("agent command must be run, chat, resume, or sessions");
  }

  const session = await createSession(args);
  const initialPrompt = option(args, "--prompt");
  if (subcommand === "run") {
    if (!initialPrompt) throw new TypeError("agent run requires --prompt <text>");
    printJson({ session, result: await sendMessage(session.sessionId, initialPrompt) });
    return;
  }

  printJson({ event: "session.created", session });
  if (initialPrompt) printJson(await sendMessage(session.sessionId, initialPrompt));
  if (!stdin.isTTY) return;
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const prompt = await terminal.question("muniu> ");
      if (prompt.trim() === "/exit") break;
      if (prompt.trim()) printJson(await sendMessage(session.sessionId, prompt));
    }
  } finally {
    terminal.close();
  }
}
