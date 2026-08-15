import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const port = Number(process.env.MN_API_PORT ?? 7318);
  const host = process.env.MN_API_HOST ?? "127.0.0.1";
  const useMockExecutors = process.env.MN_USE_MOCK_EXECUTORS === "1";
  const workspaceRoot = process.env.MN_WORKSPACE_ROOT;
  const app = buildServer({ useMockExecutors, workspaceRoot });
  await app.listen({ port, host });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  const desktopParentPid = Number(process.env.MN_DESKTOP_PARENT_PID);
  if (Number.isSafeInteger(desktopParentPid) && desktopParentPid > 1) {
    const parentMonitor = setInterval(() => {
      try {
        process.kill(desktopParentPid, 0);
      } catch {
        clearInterval(parentMonitor);
        void close();
      }
    }, 500);
    parentMonitor.unref();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
