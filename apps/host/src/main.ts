#!/usr/bin/env node
import { startLocalAgentOsHost } from "./local.js";
import { desktopParentPid } from "./config.js";

const parentPid = desktopParentPid();

startLocalAgentOsHost().then((host) => {
  process.stdout.write("木牛 Agent OS 0.2 已启动\n");
  if (parentPid) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(timer);
        void host.close().finally(() => process.exit(0));
      }
    }, 2_000);
    timer.unref();
  }
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Host 启动失败"}\n`);
  process.exitCode = 1;
});
