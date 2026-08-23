// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { LocalMockAgentSessionService } from "@mn/api/agent-session-service";
import {
  startLocalAppServerRuntime,
  startStdioAppServerRuntime,
  startUnixAppServerRuntime,
  type EmbeddedAppServerRuntimeOptions
} from "@mn/api/app-server-runtime";
import { buildServer, resolveLocalAgentSessionService } from "@mn/api/server";

import { option } from "./command-client.js";

function waitForSignal(includeStdin: boolean): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      if (includeStdin) process.stdin.off("end", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    if (includeStdin) {
      if (process.stdin.readableEnded) done();
      else process.stdin.once("end", done);
    }
  });
}

export async function appServerCommand(args: readonly string[]): Promise<void> {
  const transport = option(args, "--transport") ?? "stdio";
  if (!(["stdio", "unix", "ws"] as const).includes(transport as never)) {
    throw new TypeError("--transport must be stdio, unix, or ws");
  }
  const mniuRoot = path.resolve(
    option(args, "--root")
      ?? process.env.MN_MNIU_ROOT
      ?? path.join(homedir(), ".muniu")
  );
  await mkdir(mniuRoot, { recursive: true, mode: 0o700 });
  const mockService = args.includes("--mock")
    ? new LocalMockAgentSessionService(path.join(mniuRoot, "agent-service"))
    : undefined;
  const app = buildServer({
    logger: false,
    mniuRoot,
    localAppServer: false,
    ...(mockService === undefined ? {} : { agentSessionService: mockService, useMockExecutors: true })
  });
  let runtime: { close(): Promise<void> } | undefined;
  try {
    await app.ready();
    const service = await resolveLocalAgentSessionService(app);
    const common: EmbeddedAppServerRuntimeOptions = {
      app,
      rootDir: path.join(mniuRoot, "app-server"),
      execute: async (input) => {
        const result = await service.executeInteractiveThread({
          threadId: input.threadId,
          cwd: input.cwd,
          prompt: input.prompt,
          input: input.input as Parameters<typeof service.executeInteractiveThread>[0]["input"],
          ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
          providerId: input.providerId,
          modelId: input.modelId,
          signal: input.signal
        });
        return {
          status: result.reason === "completed"
            ? "completed"
            : result.reason === "error" ? "failed" : "interrupted",
          summary: result.summary,
          ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
          ...(result.attachments === undefined ? {} : { attachments: result.attachments })
        };
      },
      onInternalError: (error, method) => {
        const message = error instanceof Error ? error.message : "unknown error";
        process.stderr.write(`app-server ${method} failed: ${message}\n`);
      }
    };
    if (transport === "stdio") {
      runtime = startStdioAppServerRuntime(common);
      await waitForSignal(true);
      return;
    }
    if (transport === "unix") {
      const socketPath = path.resolve(option(args, "--socket") ?? path.join(mniuRoot, "app-server.sock"));
      runtime = await startUnixAppServerRuntime({ ...common, socketPath });
      process.stderr.write(`app-server listening on unix://${socketPath}\n`);
      await waitForSignal(false);
      return;
    }
    const rawPort = option(args, "--port") ?? process.env.MN_APP_SERVER_PORT ?? "0";
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new TypeError("--port must be an integer from 0 to 65535");
    }
    const connectionFile = path.resolve(
      option(args, "--connection-file")
        ?? process.env.MN_APP_SERVER_CONNECTION_FILE
        ?? path.join(mniuRoot, "app-server.json")
    );
    const listener = await startLocalAppServerRuntime({
      ...common,
      host: "127.0.0.1",
      port,
      connectionFile,
      ...(process.env.MN_APP_SERVER_TOKEN === undefined ? {} : { token: process.env.MN_APP_SERVER_TOKEN })
    });
    runtime = listener;
    process.stderr.write(`app-server listening on ${listener.url}\n`);
    await waitForSignal(false);
  } finally {
    await runtime?.close();
    await app.close();
  }
}
